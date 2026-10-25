import crypto from "node:crypto";
import { TRPCError } from "@trpc/server";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { supabaseAdmin } from "./supabase-admin";
import { measureSlowStage, withAbortSignalIfSupported, withTimeout } from "./performance-telemetry";
import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
import { calculateCompanyAccountBalance } from "./company-account-utils";
import { calculateInvoiceAmounts, generateInvoiceShareToken, hashInvoiceShareToken, nextInvoiceNo } from "./powerhub-utils";
import { buildFinancialOverview } from "./financial-overview-utils";
import { buildDashboardPeriodMetrics } from "./dashboard-period-metrics";
import { invoiceDeliveryPolicyFromSetting, isInvoiceDeliveryChannelEnabled, resolveInvoiceNotificationChannels } from "./notification-channels";
import { defaultInvoiceMessageTemplates, renderInvoiceMessageTemplate } from "./invoice-message-template";
import { decimalAmountToMinorUnits, formatPolicyAwareMessageAmount, minorUnitsToAmountString } from "./decimal-money";
import { probeMessagingConnection } from "./messaging-connection";
import { defaultPaymentReceiptSmsTemplate, renderPaymentReceiptMessage, renderPaymentReceiptTemplate, paymentReceiptTemplateParameters } from "./payment-receipt-message";
import { normalizeInternationalPhone, phoneSearchVariants } from "../shared/phone";
import { countUnconfirmedNeedsReviewPersistence, processNotificationById, processNotificationQueueForTenant } from "./notification-worker";
import { storageGet, storageGetSignedUrl, storagePut, storageRemove } from "./storage";
import { encryptTenantCredential, hashWebhookVerifyToken } from "./tenant-crypto";
import { isActivePlatformAdmin } from "./platform-admin";
import { approveAndIssueMobileReadingRuntime, executeApproveAndIssueMobileReading } from "./powerhub-mobile-approve-runtime";
import { rolesWith, type PowerCapability, type PowerRole } from "../shared/powerhub-rbac";
import { COOKIE_NAME } from "../shared/const";
import { powerhubUnifiedMessagingRouter } from "./powerhub-unified-messaging";
import { powerhubInventoryRouter } from "./powerhub-inventory-router";
import { powerhubMaintenanceRouter } from "./powerhub-maintenance-router";
import { powerhubOfflineNumberingRouter } from "./powerhub-offline-numbering";
import { getSupabaseDashboardSummary, getSupabaseFinancialOverview, readSupabaseReportPages, listSupabaseReportInvoices, listSupabaseReportPayments, listSupabaseReportExpenses, listSupabaseReportSubscribers, getSupabaseOwnerSubscriberQuota, getSupabaseSite, listSupabaseAccessibleSites, getSupabaseSubscriberAccountStatement, listSupabaseSubscriberDirectoryPage, listSupabaseCompanyAccounts, requireSupabaseAccessibleSiteIds, listSupabaseExpensePage, listSupabaseExpenses, listSupabaseGenerators, listSupabaseInvoicePage, listSupabaseInvoices, listSupabasePaymentPage, listSupabasePayments, listSupabaseReadingPage, listSupabaseReadings, listSupabaseSubscribers, listSupabaseTariffs, listSupabaseTariffPriceHistory, recordSupabaseQuotaAlert, recordSupabaseSubscriberQuotaAlert, requireSupabaseAllBranchesRole, requireSupabaseSiteCapabilities, requireSupabaseSiteRole, resolveSupabaseSiteAccess, writeSupabaseAudit } from "./powerhub-supabase";

const createRoles = rolesWith("issueInvoices");
type SupabaseRpcFailure = { code?: string; message?: string } | null | undefined;

function isDefinitivePostgresRpcFailure(error: SupabaseRpcFailure): boolean {
  const code = typeof error?.code === "string" ? error.code : "";
  const ambiguousSqlStateClasses = new Set(["08", "40", "57", "58", "XX"]);
  return /^[0-9A-Z]{5}$/.test(code) &&
    !ambiguousSqlStateClasses.has(code.slice(0, 2)) &&
    code !== "40003";
}

async function cleanupReceiptAfterDefinitiveRpcFailure(
  receiptImageKey: string | undefined,
  error: SupabaseRpcFailure,
  operation: string,
): Promise<void> {
  if (!receiptImageKey) return;
  if (!isDefinitivePostgresRpcFailure(error)) {
    console.warn(`[PowerHub] ${operation} outcome is indeterminate; retaining uploaded receipt for safe replay/reconciliation`, {
      errorCode: error?.code ?? "unknown",
    });
    return;
  }
  try {
    await storageRemove(receiptImageKey);
  } catch (cleanupError) {
    console.error(`[PowerHub] ${operation} receipt cleanup failed after definitive SQL rejection`, cleanupError);
  }
}

async function requirePaymentDocumentationFeature(tenantId: number) {
  const { data, error } = await supabaseAdmin().rpc("powerhub_payment_documentation_access", { p_tenant_id: tenantId });
  if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر التحقق من إتاحة توثيق الدفع الإلكتروني." });
  if (!data?.[0]?.allowed) throw new TRPCError({ code: "FORBIDDEN", message: "ميزة توثيق الدفع الإلكتروني غير مفعلة لهذا الاشتراك." });
  return data[0] as { allowed: boolean; policy: string; package_code: string | null; entitlement_enabled: boolean };
}

const hasAtMostTwoDecimalPlaces = (value: number) => Number.isFinite(value) && Math.abs(value * 100 - Math.round(value * 100)) < 1e-7;

const paymentDocumentationDateKeySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "التاريخ يجب أن يكون بصيغة سنة-شهر-يوم.")
  .refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }, "التاريخ المحدد غير صالح.");

function paymentDocumentationGazaDateKey(value = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Gaza", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(value);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function paymentDocumentationGazaDateBoundary(dateKey: string): Date {
  const [year, month, day] = dateKey.split("-").map(Number);
  const wallClock = Date.UTC(year, month - 1, day);
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Gaza", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  let candidate = wallClock;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = formatter.formatToParts(new Date(candidate));
    const get = (kind: string) => Number(parts.find((part) => part.type === kind)?.value ?? 0);
    const represented = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
    const delta = represented - candidate;
    if (delta === 0) break;
    candidate = wallClock - delta;
  }
  return new Date(candidate);
}

function paymentDocumentationNextDateKey(dateKey: string): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`;
}

export function isPendingInvoiceSmsDue(scheduledAt: string | Date | null, now = new Date()) {
  if (scheduledAt === null) return true;
  const timestamp = scheduledAt instanceof Date ? scheduledAt.getTime() : Date.parse(scheduledAt);
  return Number.isFinite(timestamp) && timestamp <= now.getTime();
}

export const bulkInvoiceSendAuditActions = ["send_deferred_invoice_notifications", "send_invoice_sms_batch"] as const;
export const quickActionCapabilityById = {
  add_subscriber: "manageSubscribers",
  record_reading: "recordReadings",
  create_invoice: "issueInvoices",
  collect_payment: "collectPayments",
  record_expense: "manageExpenses",
  send_notification: "manageMessaging",
} as const satisfies Record<string, PowerCapability>;
export const quickActionIds = Object.keys(quickActionCapabilityById) as Array<keyof typeof quickActionCapabilityById>;
const quickActionIdSchema = z.enum(["add_subscriber", "record_reading", "create_invoice", "collect_payment", "record_expense", "send_notification"]);
function sessionCookie(req: { headers?: { cookie?: string } }) { return (req.headers?.cookie ?? "").split(";").map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE_NAME}=`))?.slice(COOKIE_NAME.length + 1) ?? ""; }
const recordRoles = rolesWith("collectPayments");
const readingRoles = rolesWith("recordReadings");
export const ownerSubaccountRoles = ["manager", "accountant", "collector", "technician", "viewer"] as const;
export type OwnerSubaccountRole = typeof ownerSubaccountRoles[number];
export type SubscriptionPlan = "basic" | "advanced" | "professional" | "business" | "vip";
export const defaultOwnerSubaccountLimits: Record<SubscriptionPlan, number> = { basic: 2, advanced: 2, professional: 3, business: 3, vip: 4 };
export const defaultOwnerSubscriberLimits: Record<SubscriptionPlan, number> = { basic: 150, advanced: 300, professional: 500, business: 750, vip: 900 };
export const defaultBranchLimits: Record<SubscriptionPlan, number> = { basic: 1, advanced: 1, professional: 1, business: 1, vip: 2 };

export function allowedOwnerSubaccountRoles(setting?: { isEnabled: boolean; value: unknown } | null): OwnerSubaccountRole[] {
  if (!setting) return [...ownerSubaccountRoles];
  if (!setting.isEnabled) return [];
  const values = setting.value && typeof setting.value === "object" && !Array.isArray(setting.value)
    ? (setting.value as Record<string, unknown>).allowedRoles
    : undefined;
  if (!Array.isArray(values)) return [...ownerSubaccountRoles];
  return ownerSubaccountRoles.filter((role) => values.includes(role));
}

export function ownerSubaccountLimitForPlan(plan: SubscriptionPlan, setting?: { value: unknown } | null): number {
  const rawLimits = setting?.value && typeof setting.value === "object" && !Array.isArray(setting.value)
    ? (setting.value as Record<string, unknown>).limits
    : undefined;
  const candidate = rawLimits && typeof rawLimits === "object" && !Array.isArray(rawLimits)
    ? (rawLimits as Record<string, unknown>)[plan]
    : undefined;
  const parsed = typeof candidate === "number" ? candidate : typeof candidate === "string" ? Number(candidate) : NaN;
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 999 ? parsed : defaultOwnerSubaccountLimits[plan];
}

export function ownerSubscriberLimitForPlan(plan: SubscriptionPlan, setting?: { value: unknown } | null): number {
  const rawLimits = setting?.value && typeof setting.value === "object" && !Array.isArray(setting.value)
    ? (setting.value as Record<string, unknown>).limits
    : undefined;
  const candidate = rawLimits && typeof rawLimits === "object" && !Array.isArray(rawLimits)
    ? (rawLimits as Record<string, unknown>)[plan]
    : undefined;
  const parsed = typeof candidate === "number" ? candidate : typeof candidate === "string" ? Number(candidate) : NaN;
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 100000 ? parsed : defaultOwnerSubscriberLimits[plan];
}

export function branchLimitForPlan(plan: SubscriptionPlan, setting?: { value: unknown } | null): number {
  const rawLimits = setting?.value && typeof setting.value === "object" && !Array.isArray(setting.value)
    ? (setting.value as Record<string, unknown>).defaultLimit
    : undefined;
  const candidate = rawLimits && typeof rawLimits === "object" && !Array.isArray(rawLimits)
    ? (rawLimits as Record<string, unknown>)[plan]
    : undefined;
  const parsed = typeof candidate === "number" ? candidate : typeof candidate === "string" ? Number(candidate) : NaN;
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 1000 ? parsed : defaultBranchLimits[plan];
}

export function resolveBranchPolicy(input: {
  plan: SubscriptionPlan;
  platformSetting?: { isEnabled: boolean; value: unknown } | null;
  tenantSetting?: { isEnabledOverride: boolean | null; maxBranchesOverride: number | null; disabledBehavior: "read_only" | "suspended" } | null;
  currentCount?: number;
}) {
  const planLimit = branchLimitForPlan(input.plan, input.platformSetting);
  const overrideLimit = input.tenantSetting?.maxBranchesOverride;
  const maxBranches = Number.isInteger(overrideLimit) && (overrideLimit ?? 0) >= 1 ? overrideLimit! : planLimit;
  const platformEnabled = input.platformSetting?.isEnabled ?? false;
  const isEnabled = input.tenantSetting?.isEnabledOverride ?? (platformEnabled && planLimit > 1);
  const currentCount = input.currentCount ?? 0;
  return {
    isEnabled,
    maxBranches,
    planLimit,
    currentCount,
    remaining: Math.max(0, maxBranches - currentCount),
    disabledBehavior: input.tenantSetting?.disabledBehavior ?? "read_only" as const,
  };
}

export function reportDateRange(startDate: string, endDate: string) {
  const start = new Date(`${startDate}T00:00:00.000Z`);
  const endExclusive = new Date(`${endDate}T00:00:00.000Z`);
  endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);
  return { start, endExclusive };
}

type InvoiceIssueResult = { id: number; invoiceNo: string; totalAmount: number; notificationIds: number[]; alreadyIssued: boolean };

export function isStaffSuspended(now: Date, startsAt: Date | null, endsAt: Date | null) {
  return Boolean(startsAt && endsAt && now >= startsAt && now < endsAt);
}

const siteInput = z.object({
  name: z.string().min(2).max(160),
  code: z.string().min(2).max(50).transform((value) => value.toUpperCase()),
  city: z.string().max(100).optional(),
  address: z.string().max(1000).optional(),
});

const siteScoped = z.object({ siteId: z.number().int().positive() });
export const mobileSyncSummaryInput = siteScoped.extend({
  userId: z.number().int().positive().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});
export const mobileSyncReadingsInput = siteScoped.extend({ userId: z.number().int().positive().optional(), from: z.string().datetime().optional(), to: z.string().datetime().optional(), page: z.number().int().min(1).default(1), pageSize: z.number().int().min(10).max(100).default(25) });
export const mobileSyncReadingDetailInput = siteScoped.extend({ readingId: z.number().int().positive() });
export const mobileSyncApproveInput = z.object({ siteId: z.number().int().positive(), readingId: z.number().int().positive(), baseVersion: z.number().int().positive(), sendNow: z.boolean().default(true) });
export const mobileSyncBulkApprovalInput = siteScoped.extend({ userId: z.number().int().positive().optional(), from: z.string().datetime().optional(), to: z.string().datetime().optional(), limit: z.number().int().min(1).max(100).default(100), excludeReadingIds: z.array(z.number().int().positive()).max(500).optional(), sendNow: z.boolean().default(true) });
export const sendDeferredInvoiceNotificationsInput = z.object({ siteId: z.number().int().positive(), limit: z.number().int().min(1).max(200).default(200), invoiceIds: z.array(z.number().int().positive()).min(1).max(200).optional() });
export const retryFailedInvoiceNotificationInput = siteScoped.extend({ notificationId: z.number().int().positive() });
export const retryFailedInvoiceNotificationsInput = siteScoped.extend({ notificationIds: z.array(z.number().int().positive()).min(1).max(200) });
const bulkInvoiceSendDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "صيغة التاريخ يجب أن تكون YYYY-MM-DD.");
export const bulkInvoiceSendLogInput = siteScoped.extend({ from: bulkInvoiceSendDate.optional(), to: bulkInvoiceSendDate.optional() }).refine((input) => !input.from || !input.to || input.from <= input.to, { message: "تاريخ البداية يجب أن يسبق أو يساوي تاريخ النهاية.", path: ["to"] });
export const bulkInvoiceSendDetailsInput = siteScoped.extend({ auditLogId: z.number().int().positive() });

const portalCodeInput = z.string().trim().min(2).max(50).transform((value) => value.toLowerCase());
const subscriberPortalLookupInput = z.object({
  portalCode: portalCodeInput,
  subscriberNo: z.string().trim().min(1).max(50),
  phone: z.string().trim().min(6).max(30),
});

export function generateSubscriberReference(siteCode: string) {
  const compactSiteCode = siteCode.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 14) || "SITE";
  return `PH-${compactSiteCode}-${randomBytes(3).toString("hex").toUpperCase()}`;
}

export function renderSubscriberReferenceMessage(input: { subscriberName: string; subscriberNo: string; portalCode: string }) {
  return `مرحباً ${input.subscriberName}، تم إنشاء اشتراكك بنجاح. رقمك المرجعي: ${input.subscriberNo}. للاستعلام عن الفواتير والاستهلاك، افتح بوابة المشتركين وأدخل الرقم المرجعي مع رقم هاتفك المسجل: /portal?g=${input.portalCode}`;
}

export function subscriberReferenceTemplateParameters(input: { subscriberName: string; subscriberNo: string; portalCode: string }) {
  return [input.subscriberName, input.subscriberNo, `/portal?g=${input.portalCode}`];
}

function isDuplicateKeyError(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ER_DUP_ENTRY";
}

async function getEnabledPortal(portalCode: string) {
  const { data, error } = await supabaseAdmin().rpc("powerhub_subscriber_portal_theme", { p_portal_code: portalCode });
  if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل إعدادات بوابة المشتركين من Supabase." });
  const portal = (data as Array<{ portal_code: string; display_name: string | null; primary_color: string; accent_color: string; site_name: string; city: string | null; logo_key: string | null }> | null)?.[0];
  if (!portal) throw new TRPCError({ code: "NOT_FOUND", message: "رابط بوابة المشتركين غير متاح." });
  return {
    portalCode: portal.portal_code,
    displayName: portal.display_name,
    primaryColor: portal.primary_color,
    accentColor: portal.accent_color,
    siteName: portal.site_name,
    city: portal.city,
    logoUrl: portal.logo_key ? (await storageGetSignedUrl(portal.logo_key)) : null,
  };
}

async function getVerifiedPortalSubscriber(input: z.infer<typeof subscriberPortalLookupInput>) {
  const { data, error } = await supabaseAdmin().rpc("powerhub_subscriber_portal_lookup", {
    p_portal_code: input.portalCode,
    p_subscriber_no: input.subscriberNo,
    p_phone: input.phone,
  });
  if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر التحقق من بيانات بوابة المشترك في Supabase." });
  const result = data as {
    portal?: { portalCode: string; displayName: string; primaryColor: string; accentColor: string; city: string | null; logoKey?: string | null };
    subscriber?: { subscriberNo: string; fullName: string; phone: string; address: string | null; subscriptionType: string; serviceStatus: string; joinedAt: string };
    invoices?: Array<{ invoiceNo: string; billingPeriod: string; issueDate: string; dueDate: string; consumptionKwh: number | string; totalAmount: number | string; paidAmount: number | string; balanceDue: number | string; status: string }>;
    payments?: Array<{ id: number; paymentNo: string; amount: number | string; paymentMethod: string; status: string; paidAt: string; invoiceNo: string | null }>;
  } | null;
  const portal = result?.portal;
  const subscriber = result?.subscriber;
  if (!portal || !subscriber) {
    throw new TRPCError({ code: "NOT_FOUND", message: "تعذر التحقق من بيانات المشترك. راجع الرقم المرجعي ورقم الهاتف." });
  }
  return {
    portal,
    subscriber,
    invoices: result.invoices ?? [],
    payments: result.payments ?? [],
  };
}

async function getVerifiedPortalInvoice(input: z.infer<typeof subscriberPortalLookupInput> & { invoiceNo: string }) {
  const { data, error } = await supabaseAdmin().rpc("powerhub_subscriber_portal_invoice", {
    p_portal_code: input.portalCode,
    p_subscriber_no: input.subscriberNo,
    p_phone: input.phone,
    p_invoice_no: input.invoiceNo,
  });
  if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل الفاتورة من Supabase." });
  const result = data as {
    portal?: { displayName: string; primaryColor: string; accentColor: string };
    subscriber?: { fullName: string; subscriberNo: string; phone: string; address: string | null };
    invoice?: { invoiceNo: string; billingPeriod: string; issueDate: string; dueDate: string; previousReading: number | string | null; currentReading: number | string | null; consumptionKwh: number | string; pricePerKwh: number | string; fixedFee: number | string; taxAmount: number | string; discountAmount: number | string; totalAmount: number | string; paidAmount: number | string; balanceDue: number | string; status: string };
    lines?: Array<{ description: string; quantity: number | string; unitPrice: number | string; amount: number | string }>;
  } | null;
  const portal = result?.portal;
  const subscriber = result?.subscriber;
  const invoice = result?.invoice;
  if (!portal || !subscriber || !invoice) {
    throw new TRPCError({ code: "NOT_FOUND", message: "الفاتورة غير متاحة للعرض." });
  }
  return { portal, subscriber, invoice, lines: result.lines ?? [] };
}

async function requireCompanyAccountSiteScope(
  access: { role: PowerRole; tenantId: number },
  siteId: number,
  accountIds: number[],
) {
  if (access.role === "owner") return;
  const ids = Array.from(new Set(accountIds));
  if (!ids.length) return;
  const { data, error } = await supabaseAdmin().from("company_account_sites")
    .select("account_id, site_id")
    .eq("tenant_id", access.tenantId)
    .in("account_id", ids);
  if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر التحقق من نطاق حساب الشركة." });
  const linksByAccount = new Map<number, number[]>();
  for (const row of data ?? []) {
    const accountId = Number(row.account_id);
    linksByAccount.set(accountId, [...(linksByAccount.get(accountId) ?? []), Number(row.site_id)]);
  }
  for (const accountId of ids) {
    const links = linksByAccount.get(accountId) ?? [];
    if (!links.includes(siteId)) {
      throw new TRPCError({ code: "FORBIDDEN", message: "حساب الشركة غير متاح ضمن الفرع المحدد." });
    }
  }
}

async function sendPendingInvoiceSmsRuntime(
  actorUserId: number,
  input: { siteId: number; invoiceIds?: number[]; includeFailed: boolean; dueOnly?: boolean; queueMissing?: boolean },
) {
  const scope = await requireSupabaseSiteRole(actorUserId, input.siteId, ["owner", "manager", "accountant"], "manageMessaging");
  const admin = supabaseAdmin();
  const selectedInvoiceIds = input.invoiceIds?.length ? Array.from(new Set(input.invoiceIds)) : undefined;

  // Database RPCs remain capped at 50 rows. This is an internal safe batch size,
  // not a user-facing limit. Existing failed/review/scheduled messages are not reset here.
  const queueInvoiceIds = async (invoiceIds: number[]) => {
    for (let offset = 0; offset < invoiceIds.length; offset += 50) {
      const chunk = invoiceIds.slice(offset, offset + 50);
      const { error: queueError } = await admin.rpc("powerhub_queue_selected_invoice_sms", {
        p_user_id: actorUserId,
        p_tenant_id: scope.tenantId,
        p_site_id: input.siteId,
        p_invoice_ids: chunk,
      });
      if (queueError) {
        const errorText = `${queueError.code ?? ""} ${queueError.message ?? ""}`;
        if (errorText.includes("INVOICE_OUT_OF_SCOPE")) throw new TRPCError({ code: "NOT_FOUND", message: "إحدى الفواتير لا تتبع للفرع المحدد." });
        if (errorText.includes("INVOICE_NOT_SENDABLE")) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "لا يمكن إرسال فاتورة مسودة أو ملغاة." });
        if (errorText.includes("SMS_CHANNEL_DISABLED")) throw new TRPCError({ code: "FORBIDDEN", message: "إرسال SMS معطّل من إعدادات المنصة." });
        if (errorText.includes("INVALID_INVOICE_SELECTION")) throw new TRPCError({ code: "BAD_REQUEST", message: "تعذر تقسيم مجموعة الفواتير إلى دفعات داخلية صالحة." });
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تجهيز إشعارات SMS للفواتير المحددة." });
      }
    }
  };

  if (selectedInvoiceIds?.length) {
    await queueInvoiceIds(selectedInvoiceIds);
  } else if (input.queueMissing) {
    // Discover candidates from the database, not the current UI page; queue them in bounded pages.
    let invoiceOffset = 0;
    for (;;) {
      const { data: invoiceRows, error: invoiceError } = await admin.from("invoices")
        .select("id, status")
        .eq("tenant_id", scope.tenantId)
        .eq("site_id", input.siteId)
        .order("id", { ascending: true })
        .range(invoiceOffset, invoiceOffset + 199);
      if (invoiceError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر اكتشاف فواتير الفرع المؤهلة للإشعار." });
      const invoiceIds = (invoiceRows ?? [])
        .filter((row) => !["draft", "cancelled"].includes(String(row.status)))
        .map((row) => Number(row.id))
        .filter(Number.isInteger);
      await queueInvoiceIds(invoiceIds);
      if ((invoiceRows ?? []).length < 200) break;
      invoiceOffset += 200;
    }
  }

  // Snapshot eligible notification IDs before processing. Offset paging is used
  // only for discovery; processing happens afterward, so status changes cannot
  // shift later pages and cause skipped or duplicated work.
  const notificationIds: number[] = [];
  let pageOffset = 0;
  for (;;) {
    let pendingQuery = admin.from("notification_messages")
      .select("id, invoice_id, subscriber_id, subscribers!inner(site_id)")
      .eq("tenant_id", scope.tenantId)
      .eq("subscribers.site_id", input.siteId)
      .eq("channel", "sms")
      .eq("event_type", "invoice_issued")
      .in("status", input.includeFailed ? ["pending", "failed"] : ["pending"])
      .order("id", { ascending: true })
      .range(pageOffset, pageOffset + 199);

    if (selectedInvoiceIds?.length) pendingQuery = pendingQuery.in("invoice_id", selectedInvoiceIds);
    if (input.dueOnly) pendingQuery = pendingQuery.or("scheduled_at.is.null,scheduled_at.lte." + new Date().toISOString());

    const { data: candidateRows, error: candidatesError } = await pendingQuery;
    if (candidatesError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل رسائل SMS المؤهلة من Supabase." });
    if (!candidateRows?.length) break;

    notificationIds.push(...candidateRows.map((row) => Number(row.id)).filter(Number.isInteger));
    if (candidateRows.length < 200) break;
    pageOffset += 200;
  }

  if (!notificationIds.length) {
    await writeSupabaseAudit({
      userId: actorUserId,
      tenantId: scope.tenantId,
      siteId: input.siteId,
      entityType: "notification_batch",
      entityId: "none",
      action: "send_invoice_sms_batch",
      metadata: { notificationIds: [], requested: 0, submitted: 0, failed: 0, skipped: 0, internalBatchSize: 50, includeFailed: input.includeFailed, dueOnly: Boolean(input.dueOnly) },
    });
    return { requested: 0, submitted: 0, failed: 0, skipped: 0, needsReview: 0, results: [] as Array<{ notificationId: number; status: "submitted" | "failed" | "skipped" | "needs_review"; error?: string }> };
  }

  const { data: notificationRows, error: notificationLookupError } = await admin
    .from("notification_messages")
    .select("id, subscriber_id")
    .eq("tenant_id", scope.tenantId)
    .in("id", notificationIds);
  if (notificationLookupError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر ربط رسائل SMS بالمشتركين." });

  const subscriberIds = Array.from(new Set(
    (notificationRows ?? []).map((row) => Number(row.subscriber_id)).filter(Number.isInteger)
  ));
  const { data: subscriberRows, error: subscribersError } = subscriberIds.length
    ? await admin.from("subscribers").select("id, phone").eq("tenant_id", scope.tenantId).eq("site_id", input.siteId).in("id", subscriberIds)
    : { data: [], error: null };
  if (subscribersError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر التحقق من نطاق وأرقام رسائل SMS." });

  const subscriberById = new Map((subscriberRows ?? []).map((row) => [Number(row.id), row]));
  const subscriberIdByNotificationId = new Map((notificationRows ?? []).map((row) => [Number(row.id), Number(row.subscriber_id)]));
  const eligibleIds: number[] = [];
  const skippedIds: number[] = [];
  for (const notificationId of notificationIds) {
    const subscriber = subscriberById.get(subscriberIdByNotificationId.get(notificationId) ?? -1);
    if (!subscriber) { skippedIds.push(notificationId); continue; }
    try {
      normalizeInternationalPhone(String(subscriber.phone ?? ""));
      eligibleIds.push(notificationId);
    } catch {
      skippedIds.push(notificationId);
    }
  }

  const results = [];
  for (let offset = 0; offset < eligibleIds.length; offset += 50) {
    results.push(await processNotificationQueueForTenant(scope.tenantId, actorUserId, eligibleIds.slice(offset, offset + 50)));
  }
  const result = {
    requested: notificationIds.length,
    submitted: results.reduce((sum, item) => sum + item.submitted, 0),
    failed: results.reduce((sum, item) => sum + item.failed, 0),
    skipped: results.reduce((sum, item) => sum + item.skipped, 0) + skippedIds.length,
    needsReview: results.reduce((sum, item) => sum + (item.needsReview ?? 0), 0),
    results: results.flatMap((item) => item.results ?? []).concat(skippedIds.map((notificationId) => ({ notificationId, status: "skipped" as const, error: "رقم الهاتف غير صالح أو المشترك خارج نطاق الفرع." }))),
  };

  await writeSupabaseAudit({
    userId: actorUserId,
    tenantId: scope.tenantId,
    siteId: input.siteId,
    entityType: "notification_batch",
    entityId: notificationIds.join(",") || "none",
    action: "send_invoice_sms_batch",
    metadata: {
      notificationIds,
      requested: result.requested,
      submitted: result.submitted,
      failed: result.failed,
      skipped: result.skipped,
      needsReview: result.needsReview,
      internalBatchSize: 50,
      includeFailed: input.includeFailed,
      dueOnly: Boolean(input.dueOnly),
    },
  });
  return result;
}

export const powerhubRouter = router({
  deltaSync: router({
    pull: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(),
      entityType: z.enum(["sites", "subscribers", "generators", "readings", "tariffs"]),
      afterCursor: z.string().regex(/^(0|[1-9][0-9]*)$/).nullable(),
      throughCursor: z.string().regex(/^(0|[1-9][0-9]*)$/).nullable().optional(),
      pageSize: z.number().int().min(1).max(500).default(200),
    })).query(async ({ ctx, input }) => {
      // Delta pull is a read path: mirror the matching list endpoint's roles.
      // Do not require write/manage capabilities to refresh an already authorized list.
      const readRolesByEntity = {
        sites: ["owner", "manager", "accountant", "collector", "technician", "viewer"],
        subscribers: ["owner", "manager", "accountant", "collector", "viewer"],
        generators: ["owner", "manager", "technician", "viewer"],
        readings: ["owner", "manager", "accountant", "collector", "technician", "viewer"],
        tariffs: ["owner", "manager", "accountant", "viewer"],
      } as const;
      const access = await requireSupabaseSiteRole(
        ctx.user.id,
        input.siteId,
        [...readRolesByEntity[input.entityType]],
      );
      const afterCursor = input.afterCursor === null ? null : BigInt(input.afterCursor).toString();
      const throughCursor = input.throughCursor == null ? null : BigInt(input.throughCursor).toString();
      const { data, error } = await supabaseAdmin().rpc("powerhub_pull_sync_delta", {
        p_tenant_id: access.tenantId,
        p_site_id: input.siteId,
        p_entity_type: input.entityType,
        p_after_cursor: afterCursor,
        p_through_cursor: throughCursor,
        p_page_size: input.pageSize,
      });
      if (error) {
        if (error.message.includes("POWERHUB_SYNC_CURSOR_INVALID") || error.message.includes("POWERHUB_SYNC_TARGET_CURSOR_INVALID")) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "مؤشر المزامنة غير صالح؛ أعد تحميل لقطة البيانات." });
        }
        if (error.message.includes("SITE_OUT_OF_SCOPE")) {
          throw new TRPCError({ code: "FORBIDDEN", message: "لا تملك صلاحية الوصول إلى هذا الفرع." });
        }
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل تغييرات المزامنة التفاضلية." });
      }
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "استجابة المزامنة التفاضلية غير صالحة." });
      }
      return data as {
        status: "ok" | "reset_required";
        entity_type: string;
        current_cursor: string;
        retained_from_cursor: string;
        snapshot_cursor: string | null;
        through_cursor: string;
        next_cursor: string | null;
        has_more: boolean;
        changes: Array<{ cursor: string; entity_type: string; entity_id: string; operation: "upsert" | "delete"; row_data: Record<string, unknown> | null; changed_at: string }>;
      };
    }),
    snapshot: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(),
      entityType: z.enum(["sites", "subscribers", "generators", "readings", "tariffs"]),
    })).query(async ({ ctx, input }) => {
      const readRolesByEntity = {
        sites: ["owner", "manager", "accountant", "collector", "technician", "viewer"],
        subscribers: ["owner", "manager", "accountant", "collector", "viewer"],
        generators: ["owner", "manager", "technician", "viewer"],
        readings: ["owner", "manager", "accountant", "collector", "technician", "viewer"],
        tariffs: ["owner", "manager", "accountant", "viewer"],
      } as const;
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...readRolesByEntity[input.entityType]]);
      const { data, error } = await supabaseAdmin().rpc("powerhub_get_sync_snapshot", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_entity_type: input.entityType,
      });
      if (error) {
        if (error.message.includes("SITE_OUT_OF_SCOPE")) {
          throw new TRPCError({ code: "FORBIDDEN", message: "لا تملك صلاحية الوصول إلى هذا الفرع." });
        }
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر إنشاء لقطة المزامنة." });
      }
      if (!data || typeof data !== "object" || Array.isArray(data) ||
          !Array.isArray((data as { rows?: unknown }).rows) ||
          typeof (data as { snapshot_cursor?: unknown }).snapshot_cursor !== "string") {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "استجابة لقطة المزامنة غير صالحة." });
      }
      return data as { status: "ok"; entity_type: string; snapshot_cursor: string; retained_from_cursor: string; rows: Array<Record<string, unknown>> };
    }),
  }),
  offlineNumbering: powerhubOfflineNumberingRouter,
  unifiedMessaging: powerhubUnifiedMessagingRouter,
  // Declared on the canonical router so the public AppRouter retains inventory types.
  inventory: powerhubInventoryRouter,
  // Canonical declaration keeps maintenance procedures in the exported AppRouter type.
  maintenance: powerhubMaintenanceRouter,
  siteBillingPolicy: router({
    get: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      // Read-only policy fields are needed to keep message previews consistent for messaging managers;
      // mutation of billing policy remains owner-only below.
      const scope = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "viewer"]);
      const { data, error } = await supabaseAdmin().rpc("powerhub_get_site_billing_policy", { p_tenant_id: scope.tenantId, p_site_id: input.siteId });
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل سياسة الحد الأدنى والتسويات." });
      const row = Array.isArray(data) ? data[0] : data;
      return {
        minimumMode: row?.minimum_mode ?? "disabled",
        minimumConsumptionKwh: row?.minimum_consumption_kwh == null ? "" : String(row.minimum_consumption_kwh),
        minimumInvoiceAmount: row?.minimum_invoice_amount == null ? "" : String(row.minimum_invoice_amount),
        automaticFractionDiscountEnabled: Boolean(row?.automatic_fraction_discount_enabled),
        automaticFractionDiscountMinTenth: Number(row?.automatic_fraction_discount_min_tenth ?? 1),
        automaticFractionDiscountMaxTenth: Number(row?.automatic_fraction_discount_max_tenth ?? 5),
        fractionCarryEnabled: Boolean(row?.fraction_carry_enabled),
        fractionCarryMinTenth: Number(row?.fraction_carry_min_tenth ?? 6),
        fractionCarryMaxTenth: Number(row?.fraction_carry_max_tenth ?? 9),
      };
    }),
    discountSummary: protectedProcedure.input(siteScoped.extend({
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    })).query(async ({ ctx, input }) => {
      const scope = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner"]);
      if (input.startDate && input.endDate && input.startDate > input.endDate) throw new TRPCError({ code: "BAD_REQUEST", message: "تاريخ البداية يجب ألا يتجاوز تاريخ النهاية." });
      const start = input.startDate ? new Date(input.startDate + "T00:00:00.000Z").toISOString() : null;
      const end = input.endDate ? new Date(new Date(input.endDate + "T00:00:00.000Z").getTime() + 86400000 - 1).toISOString() : null;
      const { data, error } = await supabaseAdmin().rpc("powerhub_billing_discount_summary", {
        p_tenant_id: scope.tenantId, p_site_id: input.siteId, p_from: start, p_to: end,
      });
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل إحصاءات الخصومات." });
      const row = Array.isArray(data) ? data[0] : data;
      return {
        automaticDiscountTotal: Number(row?.automatic_discount_total ?? 0),
        manualDiscountTotal: Number(row?.manual_discount_total ?? 0),
        totalDiscount: Number(row?.total_discount ?? 0),
        automaticDiscountCount: Number(row?.automatic_discount_count ?? 0),
        manualDiscountCount: Number(row?.manual_discount_count ?? 0),
      };
    }),
    save: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(),
      minimumMode: z.enum(["disabled", "kwh", "amount"]),
      minimumConsumptionKwh: z.number().positive().max(1000000).optional(),
      minimumInvoiceAmount: z.number().positive().max(100000000).optional(),
      automaticFractionDiscountEnabled: z.boolean(),
      automaticFractionDiscountMinTenth: z.number().int().min(0).max(9),
      automaticFractionDiscountMaxTenth: z.number().int().min(0).max(9),
      fractionCarryEnabled: z.boolean(),
      fractionCarryMinTenth: z.number().int().min(0).max(9),
      fractionCarryMaxTenth: z.number().int().min(0).max(9),
    })).mutation(async ({ ctx, input }) => {
      const scope = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner"]);
      const { error } = await supabaseAdmin().rpc("powerhub_save_site_billing_policy", {
        p_user_id: ctx.user.id, p_tenant_id: scope.tenantId, p_site_id: input.siteId,
        p_minimum_mode: input.minimumMode,
        p_minimum_consumption_kwh: input.minimumMode === "kwh" ? input.minimumConsumptionKwh ?? null : null,
        p_minimum_invoice_amount: input.minimumMode === "amount" ? input.minimumInvoiceAmount ?? null : null,
        p_automatic_fraction_discount_enabled: input.automaticFractionDiscountEnabled,
        p_automatic_fraction_discount_min_tenth: input.automaticFractionDiscountMinTenth,
        p_automatic_fraction_discount_max_tenth: input.automaticFractionDiscountMaxTenth,
        p_fraction_carry_enabled: input.fractionCarryEnabled,
        p_fraction_carry_min_tenth: input.fractionCarryMinTenth,
        p_fraction_carry_max_tenth: input.fractionCarryMaxTenth,
      });
      if (error) {
        const message = error.message ?? "";
        if (message.includes("FRACTION_RANGES_OVERLAP")) throw new TRPCError({ code: "BAD_REQUEST", message: "نطاق الخصم ونطاق الترحيل متداخلان؛ اختر نطاقين منفصلين." });
        if (message.includes("BILLING_POLICY_PERMISSION_REQUIRED")) throw new TRPCError({ code: "FORBIDDEN", message: "لا تملك صلاحية تعديل سياسة الفوترة." });
        throw new TRPCError({ code: "BAD_REQUEST", message: "تعذر حفظ سياسة الحد الأدنى والتسويات. تحقق من القيم المدخلة." });
      }
      return { ok: true };
    }),
  }),
  readingCycle: router({
    get: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      const scope = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "collector", "technician", "viewer"]);
      const { data, error } = await supabaseAdmin().rpc("powerhub_get_reading_cycle", {
        p_tenant_id: scope.tenantId,
        p_site_id: input.siteId,
      });
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل دورة القراءات." });
      const row = Array.isArray(data) ? data[0] : data;
      return { cycleType: row?.cycle_type ?? "MONTHLY", weeklyStartDay: Number(row?.weekly_start_day ?? 7), monthlyStartDay: Number(row?.monthly_start_day ?? 1), timezone: row?.timezone ?? "Asia/Gaza" };
    }),
    currentBounds: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      const scope = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "collector", "viewer"]);
      const { data, error } = await supabaseAdmin().rpc("powerhub_cycle_for_reading", {
        p_tenant_id: scope.tenantId,
        p_site_id: input.siteId,
        p_reading_at: new Date().toISOString(),
      });
      const row = Array.isArray(data) ? data[0] : data;
      if (error || !row?.cycle_start_at || !row?.cycle_end_at) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "تعذر تحديد حدود دورة الفوترة الحالية لهذا الفرع." });
      }
      return {
        cycleKey: String(row.cycle_key ?? ""),
        cycleLabel: String(row.cycle_label ?? row.billing_period ?? ""),
        billingPeriod: String(row.billing_period ?? row.cycle_key ?? ""),
        startAt: String(row.cycle_start_at),
        endAt: String(row.cycle_end_at),
      };
    }),

    boundsAt: protectedProcedure.input(siteScoped.extend({
      referenceAt: z.string().datetime({ offset: true }),
    })).query(async ({ ctx, input }) => {
      const scope = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "collector", "viewer"]);
      const { data, error } = await supabaseAdmin().rpc("powerhub_cycle_for_reading", {
        p_tenant_id: scope.tenantId,
        p_site_id: input.siteId,
        p_reading_at: input.referenceAt,
      });
      const row = Array.isArray(data) ? data[0] : data;
      if (error || !row?.cycle_start_at || !row?.cycle_end_at) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "تعذر تحديد حدود الدورة السابقة لهذا الفرع." });
      }
      return {
        cycleKey: String(row.cycle_key ?? ""),
        cycleLabel: String(row.cycle_label ?? row.billing_period ?? ""),
        billingPeriod: String(row.billing_period ?? row.cycle_key ?? ""),
        startAt: String(row.cycle_start_at),
        endAt: String(row.cycle_end_at),
      };
    }),
    save: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(),
      cycleType: z.enum(["WEEKLY", "EVERY_10_DAYS", "EVERY_15_DAYS", "MONTHLY"]),
      weeklyStartDay: z.number().int().min(1).max(7).default(7),
      monthlyStartDay: z.union([z.literal(1), z.literal(30)]).default(1),
    })).mutation(async ({ ctx, input }) => {
      const scope = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner"], "manageMessaging");
      const { data, error } = await supabaseAdmin().rpc("powerhub_upsert_reading_cycle", {
        p_user_id: ctx.user.id, p_tenant_id: scope.tenantId, p_site_id: input.siteId,
        p_cycle_type: input.cycleType, p_weekly_start_day: input.weeklyStartDay, p_monthly_start_day: input.monthlyStartDay,
      });
      if (error) {
        if ((error.message ?? "").includes("READING_CYCLE_PERMISSION_REQUIRED")) throw new TRPCError({ code: "FORBIDDEN", message: "لا تملك صلاحية تعديل دورة القراءات." });
        throw new TRPCError({ code: "BAD_REQUEST", message: "تعذر حفظ دورة القراءات." });
      }
      const row = Array.isArray(data) ? data[0] : data;
      return { cycleType: row?.cycle_type ?? input.cycleType, weeklyStartDay: Number(row?.weekly_start_day ?? input.weeklyStartDay), monthlyStartDay: Number(row?.monthly_start_day ?? input.monthlyStartDay), timezone: row?.timezone ?? "Asia/Gaza" };
    }),
  }),
  publicPackageCatalog: publicProcedure.query(async () => {
    const fallback = {
      currency: "ILS",
      version: 1,
      showPlans: true,
      packages: [
        { code: "basic", name: "الناشئة", price: 123, includedSubscribers: 150, subscribersLimitMode: "maximum", platformUsers: 2, fieldUsers: 1, branches: 1, active: true },
        { code: "advanced", name: "النمو", price: 234, includedSubscribers: 300, subscribersLimitMode: "maximum", platformUsers: 2, fieldUsers: 2, branches: 1, active: true },
        { code: "professional", name: "الاحتراف", price: 345, includedSubscribers: 500, subscribersLimitMode: "maximum", platformUsers: 3, fieldUsers: 3, branches: 1, active: true },
        { code: "business", name: "الأعمال", price: 456, includedSubscribers: 750, subscribersLimitMode: "maximum", platformUsers: 3, fieldUsers: 4, branches: 1, active: true },
        { code: "vip", name: "الذهبية / VIP", price: 567, includedSubscribers: 900, subscribersLimitMode: "minimum", platformUsers: 4, fieldUsers: 4, branches: 2, active: true },
      ],
      addons: {},
    };
    const admin = supabaseAdmin();
    const [catalogResult, visibilityResult] = await Promise.all([
      admin.from("platform_settings").select("is_enabled,value,message").eq("setting_key", "subscription_package_catalog").maybeSingle(),
      admin.from("platform_settings").select("is_enabled,value").eq("setting_key", "public_plan_visibility").maybeSingle(),
    ]);
    const visibilityValue = visibilityResult.data?.value && typeof visibilityResult.data.value === "object" && !Array.isArray(visibilityResult.data.value)
      ? visibilityResult.data.value as Record<string, unknown>
      : {};
    const showPlans = visibilityResult.data?.is_enabled === false ? true : visibilityValue.showPlans !== false;
    const catalog = catalogResult.data;
    if (catalogResult.error || !catalog?.is_enabled || !catalog.value || typeof catalog.value !== "object" || Array.isArray(catalog.value)) {
      return { ...fallback, showPlans };
    }
    const value = catalog.value as Record<string, unknown>;
    const packageSource: Array<Record<string, unknown>> = Array.isArray(value.packages)
      ? value.packages.filter((item): item is Record<string, unknown> => Boolean(
          item && typeof item === "object" && !Array.isArray(item)
          && typeof item.code === "string" && typeof item.name === "string"
          && typeof item.price === "number" && Number.isFinite(item.price)
          && item.active !== false
        ))
      : fallback.packages;
    const packageNumber = (item: Record<string, unknown>, key: string): number => {
      const value = item[key];
      return typeof value === "number" && Number.isFinite(value) ? value : 0;
    };
    // This is a public procedure: explicitly allow-list display fields rather
    // than spreading the private catalog (which may contain margin/cost data).
    // A configured, intentionally empty/all-disabled catalog stays empty.
    const packages = packageSource.map((item) => ({
      code: String(item.code),
      name: String(item.name),
      price: packageNumber(item, "price"),
      includedSubscribers: packageNumber(item, "includedSubscribers"),
      subscribersLimitMode: item.subscribersLimitMode === "minimum" ? "minimum" : "maximum",
      platformUsers: packageNumber(item, "platformUsers"),
      fieldUsers: packageNumber(item, "fieldUsers"),
      branches: packageNumber(item, "branches"),
      active: item.active !== false,
      logoPolicy: ["not_included", "addon", "included"].includes(String(item.logoPolicy)) ? String(item.logoPolicy) : "not_included",
      logoAddonPrice: packageNumber(item, "logoAddonPrice"),
      paymentDocumentationPolicy: ["not_included", "addon", "included"].includes(String(item.paymentDocumentationPolicy)) ? String(item.paymentDocumentationPolicy) : "addon",
      paymentDocumentationAddonPrice: packageNumber(item, "paymentDocumentationAddonPrice"),
    }));
    return {
      currency: typeof value.currency === "string" ? value.currency : fallback.currency,
      version: Number(value.version ?? 1),
      showPlans,
      packages,
      addons: {},
    };
  }),
  messaging: router({
    smsQuota: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      const scope = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "collector"], "manageMessaging");
      const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
      const admin = supabaseAdmin();
      const [accountResult, providerMonthResult, walletResult] = await Promise.all([
        admin.from("tenant_tweetsms_accounts").select("sender_name, monthly_limit, is_active, credential_ciphertext, last_error").eq("tenant_id", scope.tenantId).maybeSingle(),
        admin.from("notification_messages").select("id, created_at, provider_request_started_at, segment_count").eq("tenant_id", scope.tenantId).eq("channel", "sms").or(`created_at.gte.${monthStart.toISOString()},provider_request_started_at.gte.${monthStart.toISOString()}`).in("status", ["processing", "submitted", "delivered", "read", "needs_review"]),
        admin.rpc("powerhub_get_sms_quota", { p_tenant_id: scope.tenantId }),
      ]);
      if (accountResult.error || providerMonthResult.error || walletResult.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل رصيد الرسائل من Supabase." });
      const account = accountResult.data;
      const wallet = (Array.isArray(walletResult.data) ? walletResult.data[0] : walletResult.data) as Record<string, unknown> | null;
      const total = Number(wallet?.total_messages ?? 0);
      const used = Number(wallet?.used_segments ?? 0);
      const providerMonthlyUsed = (providerMonthResult.data ?? []).reduce((sum, message) => { const effectiveAt = message.provider_request_started_at ?? message.created_at; return new Date(effectiveAt) >= monthStart ? sum + Math.max(1, Number(message.segment_count ?? 1)) : sum; }, 0);
      return {
        plan: "sms-wallet", planName: "رصيد SMS الدائم", senderName: account?.sender_name ?? null,
        isActive: account?.is_active ?? false, configured: Boolean(account?.credential_ciphertext),
        lastError: account?.last_error ?? null, included: 0, additional: total, total, used,
        remaining: Number(wallet?.remaining_messages ?? Math.max(0, total - used)),
        providerMonthlyLimit: Number(account?.monthly_limit ?? 0), providerMonthlyUsed,
        providerMonthlyRemaining: Math.max(0, Number(account?.monthly_limit ?? 0) - providerMonthlyUsed),
      };
    }),
    smsDailyUsage: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      const scope = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "collector"], "manageMessaging");
      const fourteenDaysAgo = new Date(); fourteenDaysAgo.setUTCDate(fourteenDaysAgo.getUTCDate() - 13); fourteenDaysAgo.setUTCHours(0, 0, 0, 0);
      const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
      const admin = supabaseAdmin();
      const [accountResult, messagesResult, providerMonthResult, walletResult] = await Promise.all([
        admin.from("tenant_tweetsms_accounts").select("monthly_limit").eq("tenant_id", scope.tenantId).maybeSingle(),
        admin.from("notification_messages").select("created_at, provider_request_started_at, status, segment_count").eq("tenant_id", scope.tenantId).eq("channel", "sms").or(`created_at.gte.${fourteenDaysAgo.toISOString()},provider_request_started_at.gte.${fourteenDaysAgo.toISOString()}`),
        admin.from("notification_messages").select("id, created_at, provider_request_started_at, segment_count").eq("tenant_id", scope.tenantId).eq("channel", "sms").or(`created_at.gte.${monthStart.toISOString()},provider_request_started_at.gte.${monthStart.toISOString()}`).in("status", ["processing", "submitted", "delivered", "read", "needs_review"]),
        admin.rpc("powerhub_get_sms_quota", { p_tenant_id: scope.tenantId }),
      ]);
      if (accountResult.error || messagesResult.error || providerMonthResult.error || walletResult.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل استخدام الرسائل من Supabase." });
      const messages = messagesResult.data ?? [];
      const eligibleStatuses = ["processing", "submitted", "delivered", "read", "needs_review"];
      const daily = new Map<string, number>();
      for (const message of messages) {
        if (!eligibleStatuses.includes(message.status)) continue;
        const effectiveAt = message.provider_request_started_at ?? message.created_at;
        if (new Date(effectiveAt) < fourteenDaysAgo) continue;
        const key = new Date(effectiveAt).toISOString().slice(0, 10);
        daily.set(key, (daily.get(key) ?? 0) + Math.max(1, Number(message.segment_count ?? 1)));
      }
      const today = new Date();
      const points = Array.from({ length: 14 }, (_, index) => {
        const date = new Date(today); date.setDate(today.getDate() - (13 - index));
        const key = date.toISOString().slice(0, 10);
        return { date: key, count: daily.get(key) ?? 0 };
      });
      const wallet = (Array.isArray(walletResult.data) ? walletResult.data[0] : walletResult.data) as Record<string, unknown> | null;
      const total = Number(wallet?.total_messages ?? 0);
      const used = Number(wallet?.used_segments ?? 0);
      const providerMonthlyUsed = (providerMonthResult.data ?? []).reduce((sum, message) => { const effectiveAt = message.provider_request_started_at ?? message.created_at; return new Date(effectiveAt) >= monthStart ? sum + Math.max(1, Number(message.segment_count ?? 1)) : sum; }, 0);
      const providerMonthlyLimit = Number(accountResult.data?.monthly_limit ?? 0);
      return { points, included: 0, additional: total, total, used, remaining: Number(wallet?.remaining_messages ?? Math.max(0, total - used)), providerMonthlyLimit, providerMonthlyUsed, providerMonthlyRemaining: Math.max(0, providerMonthlyLimit - providerMonthlyUsed) };
    }),
    smsCreditPackages: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      const scope = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner"], "manageMessaging");
      const { data, error } = await supabaseAdmin().from("platform_sms_plans")
        .select("id, code, name, description, included_messages, price_amount, currency, is_active")
        .eq("is_active", true).gt("included_messages", 0).order("included_messages", { ascending: true });
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل باقات رصيد SMS." });
      return (data ?? []).map((plan) => ({ id: Number(plan.id), code: plan.code, name: plan.name, description: plan.description, messages: Number(plan.included_messages), price: Number(plan.price_amount ?? 0), currency: plan.currency ?? "ILS" }));
    }),
    currentSmsPackageRequest: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      const scope = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner"], "manageMessaging");
      const { data, error } = await supabaseAdmin().from("sms_package_requests")
        .select("id, sms_plan_id, status, requested_messages, requested_price, currency, approved_messages, note, created_at, reviewed_at")
        .eq("tenant_id", scope.tenantId).order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل طلب حزمة الرسائل من Supabase." });
      if (!data) return null;
      const [{ data: plan }, { data: ledger }] = await Promise.all([
        data.sms_plan_id ? supabaseAdmin().from("platform_sms_plans").select("name").eq("id", data.sms_plan_id).maybeSingle() : Promise.resolve({ data: null }),
        supabaseAdmin().from("tenant_sms_recharge_ledger").select("status, credited_messages, confirmed_at").eq("request_id", data.id).maybeSingle(),
      ]);
      return {
        id: Number(data.id), packageId: data.sms_plan_id ? Number(data.sms_plan_id) : null, packageName: plan?.name ?? null,
        status: data.status, ledgerStatus: ledger?.status ?? null, requestedMessages: Number(data.requested_messages),
        approvedMessages: Number(data.approved_messages ?? ledger?.credited_messages ?? 0), requestedPrice: Number(data.requested_price ?? 0),
        currency: data.currency ?? "ILS", note: data.note, createdAt: new Date(data.created_at), reviewedAt: data.reviewed_at ? new Date(data.reviewed_at) : null,
      };
    }),
    requestSmsPackage: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), packageId: z.number().int().positive(), note: z.string().max(1000).optional() })).mutation(async ({ ctx, input }) => {
      const scope = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner"], "manageMessaging");
      const { data, error } = await supabaseAdmin().rpc("powerhub_request_sms_package_plan", {
        p_tenant_id: scope.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id, p_sms_plan_id: input.packageId, p_note: input.note ?? null,
      });
      if (error) {
        if (error.message.includes("SMS_PACKAGE_REQUEST_PENDING")) throw new TRPCError({ code: "CONFLICT", message: "لديك طلب شحن قيد المراجعة بالفعل." });
        if (error.message.includes("SMS_SUBSCRIPTION_REQUIRED")) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "يلزم وجود اشتراك نشط قبل طلب رصيد رسائل." });
        if (error.message.includes("SMS_PLAN_NOT_AVAILABLE")) throw new TRPCError({ code: "NOT_FOUND", message: "باقة الرصيد غير متاحة حاليًا." });
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر إنشاء طلب رصيد SMS في Supabase." });
      }
      const request = data?.[0];
      if (!request) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "لم تُعد دالة طلب رصيد الرسائل نتيجة صالحة." });
      return { id: Number(request.request_id), status: "pending" as const };
    }),
    listConfigurations: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      const scope = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner"], "manageMessaging");
      const { data, error } = await supabaseAdmin().from("tenant_messaging_configurations")
        .select("id, channel, provider, sender_id, phone_number_id, template_name, receipt_template_name, subscriber_reference_template_name, is_active, auto_send_after_approval, invoice_sms_schedule_mode, invoice_sms_schedule_anchor_at, updated_at")
        .eq("tenant_id", scope.tenantId).order("channel", { ascending: true });
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل إعدادات الرسائل من Supabase." });
      return (data ?? []).map((config) => ({ id: Number(config.id), channel: config.channel, provider: config.provider, senderId: config.sender_id, phoneNumberId: config.phone_number_id, templateName: config.template_name, receiptTemplateName: config.receipt_template_name, subscriberReferenceTemplateName: config.subscriber_reference_template_name, isActive: config.is_active, autoSendAfterApproval: config.auto_send_after_approval, scheduleMode: config.invoice_sms_schedule_mode ?? "immediate", scheduleAnchorAt: config.invoice_sms_schedule_anchor_at ? new Date(config.invoice_sms_schedule_anchor_at) : null, autoSendCron: null, scheduleCronTaskUid: null, updatedAt: new Date(config.updated_at) }));
    }),
    listScheduleRuns: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), limit: z.number().int().min(1).max(50).default(20) })).query(async ({ ctx, input }) => {
      const scope = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "manageMessaging");
      const admin = supabaseAdmin();
      const { data: config, error: configError } = await admin.from("tenant_messaging_configurations").select("id")
        .eq("tenant_id", scope.tenantId).eq("channel", "sms").maybeSingle();
      if (configError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل إعداد SMS الآلي من Supabase." });
      if (!config) return [];
      const { data, error } = await admin.from("messaging_schedule_runs")
        .select("id, status, scanned, submitted, failed, skipped, error, task_uid, started_at, finished_at")
        .eq("tenant_id", scope.tenantId).eq("configuration_id", config.id).order("started_at", { ascending: false }).limit(input.limit);
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل سجل معالجة SMS الآلي من Supabase." });
      return (data ?? []).map((run) => ({ id: Number(run.id), status: run.status, scanned: run.scanned, submitted: run.submitted, failed: run.failed, skipped: run.skipped, error: run.error, taskUid: run.task_uid, startedAt: new Date(run.started_at), finishedAt: run.finished_at ? new Date(run.finished_at) : null }));
    }),
    deliveryPolicy: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner"], "manageMessaging");
      const { data, error } = await supabaseAdmin().from("platform_settings").select("is_enabled, value, message")
        .eq("setting_key", "invoice_delivery_channels").maybeSingle();
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل سياسة قنوات الفواتير من Supabase." });
      const setting = data ? { isEnabled: data.is_enabled, value: data.value, message: data.message } : null;
      return { ...invoiceDeliveryPolicyFromSetting(setting), configured: Boolean(setting), message: setting?.message ?? null };
    }),
    listInvoiceTemplates: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      const scope = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner"], "manageMessaging");
      const { data, error } = await supabaseAdmin().from("tenant_invoice_message_templates")
        .select("id, tenant_id, channel, event_type, body, is_active, created_at, updated_at")
        .eq("tenant_id", scope.tenantId).eq("event_type", "invoice_issued").order("channel", { ascending: true });
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل قوالب رسائل الفواتير من Supabase." });
      return (data ?? []).map((template) => ({ id: Number(template.id), tenantId: Number(template.tenant_id), channel: template.channel, eventType: template.event_type, body: template.body, isActive: template.is_active, createdAt: new Date(template.created_at), updatedAt: new Date(template.updated_at) }));
    }),
    listPaymentReceiptTemplates: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      const scope = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner"], "manageMessaging");
      const { data, error } = await supabaseAdmin().from("tenant_payment_receipt_message_templates")
        .select("id, tenant_id, channel, body, is_active, created_at, updated_at")
        .eq("tenant_id", scope.tenantId).order("channel", { ascending: true });
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل قوالب إيصالات الرسائل من Supabase." });
      return (data ?? []).map((template) => ({ id: Number(template.id), tenantId: Number(template.tenant_id), channel: template.channel, body: template.body, isActive: template.is_active, createdAt: new Date(template.created_at), updatedAt: new Date(template.updated_at) }));
    }),
    saveConfiguration: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(), channel: z.enum(["whatsapp", "sms"]), provider: z.string().min(2).max(80),
      senderId: z.string().max(120).optional(), phoneNumberId: z.string().max(120).optional(), templateName: z.string().max(120).optional(), receiptTemplateName: z.string().max(120).optional(), subscriberReferenceTemplateName: z.string().max(120).optional(),
      credential: z.string().min(8).max(4096), webhookVerifyToken: z.string().min(16).max(256).optional(), webhookAppSecret: z.string().min(16).max(512).optional(), isActive: z.boolean().default(true),
    })).mutation(async ({ ctx, input }) => {
      const scope = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner"], "manageMessaging");
      if (input.channel === "whatsapp" && input.provider !== "meta_whatsapp_cloud") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "مزود WhatsApp المدعوم حاليًا هو Meta WhatsApp Cloud." });
      }
      if (input.channel === "sms" && !["tweetsms", "twilio"].includes(input.provider)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "مزود SMS غير مدعوم في إعدادات القناة الحالية." });
      }
      const credentialPayload = input.channel === "whatsapp"
        ? JSON.stringify({ accessToken: input.credential.trim(), ...(input.webhookAppSecret?.trim() ? { appSecret: input.webhookAppSecret.trim() } : {}) })
        : JSON.stringify({ apiKey: input.credential.trim() });
      const encrypted = encryptTenantCredential(credentialPayload);
      const webhookHash = input.webhookVerifyToken?.trim() ? hashWebhookVerifyToken(input.webhookVerifyToken.trim()) : null;
      const admin = supabaseAdmin();
      const { data, error } = await admin.from("tenant_messaging_configurations").upsert({
        tenant_id: scope.tenantId, channel: input.channel, provider: input.provider.trim(),
        sender_id: input.senderId?.trim() || null, phone_number_id: input.phoneNumberId?.trim() || null,
        template_name: input.templateName?.trim() || null, receipt_template_name: input.receiptTemplateName?.trim() || null,
        subscriber_reference_template_name: input.subscriberReferenceTemplateName?.trim() || null,
        credential_ciphertext: encrypted.ciphertext, credential_iv: encrypted.iv, credential_key_version: 1,
        webhook_verify_token_hash: webhookHash, is_active: input.isActive, updated_at: new Date().toISOString(),
      }, { onConflict: "tenant_id,channel" }).select("id, channel, provider, is_active").single();
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر حفظ إعداد مزود الرسائل في Supabase." });
      await writeSupabaseAudit({ userId: ctx.user.id, tenantId: scope.tenantId, siteId: input.siteId, entityType: "tenant_messaging_configuration", entityId: String(data.id), action: "upsert", afterData: { channel: data.channel, provider: data.provider, isActive: data.is_active, credentialUpdated: true } });
      return { success: true, id: Number(data.id), channel: data.channel, provider: data.provider, isActive: data.is_active };
    }),
    testConnection: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(), channel: z.enum(["whatsapp", "sms"]), provider: z.string().min(2).max(80),
      phoneNumberId: z.string().max(120).optional(), credential: z.string().min(8).max(4096),
    })).mutation(async ({ ctx, input }) => {
      await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner"], "manageMessaging");
      return probeMessagingConnection({ channel: input.channel, provider: input.provider.trim(), credential: input.credential.trim(), phoneNumberId: input.phoneNumberId?.trim() || undefined });
    }),
    configureInvoiceAutoSend: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(),
      enabled: z.boolean().default(true),
      scheduleMode: z.enum(["immediate", "weekly", "every_10_days", "every_15_days", "monthly"]).default("immediate"),
      scheduleAnchorAt: z.string().datetime().optional(),
    })).mutation(async ({ ctx, input }) => {
      const scope = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner"], "manageMessaging");
      const admin = supabaseAdmin();
      const { data: config, error: configError } = await admin.from("tenant_messaging_configurations")
        .select("id, is_active")
        .eq("tenant_id", scope.tenantId).eq("channel", "sms").maybeSingle();
      if (configError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل إعداد SMS." });
      if (!config) throw new TRPCError({ code: "NOT_FOUND", message: "يجب إعداد قناة SMS أولاً." });

      const scheduleMode = input.enabled ? input.scheduleMode : "immediate";
      if (input.enabled && scheduleMode !== "immediate" && (!input.scheduleAnchorAt || Number.isNaN(new Date(input.scheduleAnchorAt).getTime()))) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "يجب تحديد تاريخ ووقت صحيحين لبداية دورة الإرسال." });
      }
      const anchor = input.enabled && scheduleMode !== "immediate" ? new Date(input.scheduleAnchorAt as string).toISOString() : null;

      const { data, error } = await admin.from("tenant_messaging_configurations")
        .update({
          auto_send_after_approval: input.enabled,
          auto_send_cron: null,
          invoice_sms_schedule_mode: scheduleMode,
          invoice_sms_schedule_anchor_at: anchor,
          updated_at: new Date().toISOString(),
        })
        .eq("tenant_id", scope.tenantId).eq("id", config.id)
        .select("auto_send_after_approval, invoice_sms_schedule_mode, invoice_sms_schedule_anchor_at").single();
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر حفظ إعداد دورة إرسال الفواتير." });

      const { error: rescheduleError } = await admin.rpc("powerhub_reschedule_pending_invoice_sms", {
        p_tenant_id: scope.tenantId,
        p_mode: scheduleMode,
        p_anchor_at: anchor,
      });
      if (rescheduleError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تم حفظ الإعداد لكن تعذر تحديث طابور الرسائل المعلّقة." });

      await writeSupabaseAudit({
        userId: ctx.user.id, tenantId: scope.tenantId, siteId: input.siteId,
        entityType: "tenant_messaging_configuration", entityId: String(config.id),
        action: input.enabled ? "configure_invoice_sms_batch_schedule" : "disable_invoice_auto_send",
        metadata: { automation: "invoice_issued_only", scheduleMode: data.invoice_sms_schedule_mode, scheduleAnchorAt: data.invoice_sms_schedule_anchor_at },
      });
      return { enabled: data.auto_send_after_approval, scheduleMode: data.invoice_sms_schedule_mode, scheduleAnchorAt: data.invoice_sms_schedule_anchor_at, cron: null };
    }),
    saveInvoiceTemplate: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), channel: z.enum(["whatsapp", "sms"]), body: z.string().min(12).max(1600), isActive: z.boolean().default(true) })).mutation(async ({ ctx, input }) => {
      const scope = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner"], "manageMessaging");
      const admin = supabaseAdmin();
      const { data: setting, error: settingError } = await admin.from("platform_settings").select("is_enabled, value")
        .eq("setting_key", "invoice_delivery_channels").maybeSingle();
      if (settingError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر التحقق من سياسة قنوات الفواتير في Supabase." });
      if (!setting || !isInvoiceDeliveryChannelEnabled(input.channel, invoiceDeliveryPolicyFromSetting({ isEnabled: setting.is_enabled, value: setting.value }))) throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكن حفظ قالب لقناة معطلة من آدمن المنصة." });
      if (input.channel === "sms") {
        const { data: config, error: configError } = await admin.from("tenant_messaging_configurations")
          .select("invoice_message_style").eq("tenant_id", scope.tenantId).eq("channel", "sms").maybeSingle();
        if (configError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل طريقة رسالة الفاتورة." });
        const { error } = await admin.rpc("powerhub_sync_invoice_sms_template", {
          p_tenant_id: scope.tenantId, p_body: input.body, p_is_active: input.isActive,
          p_actor_user_id: ctx.user.id, p_invoice_style: config?.invoice_message_style ?? "details",
        });
        if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر حفظ قالب الفاتورة الموحد بشكل ذري." });
      } else {
        const { error } = await admin.from("tenant_invoice_message_templates").upsert({ tenant_id: scope.tenantId, channel: input.channel, event_type: "invoice_issued", body: input.body, is_active: input.isActive }, { onConflict: "tenant_id,channel,event_type" });
        if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر حفظ قالب رسالة الفاتورة في Supabase." });
      }

      await writeSupabaseAudit({ userId: ctx.user.id, tenantId: scope.tenantId, siteId: input.siteId, entityType: "tenant_invoice_message_template", entityId: `${scope.tenantId}:${input.channel}`, action: "upsert", afterData: { channel: input.channel, isActive: input.isActive }, metadata: { bodyLength: input.body.length } });
      return { success: true };
    }),
    savePaymentReceiptTemplate: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), body: z.string().min(12).max(1600), isActive: z.boolean().default(true) })).mutation(async ({ ctx, input }) => {
      const scope = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner"], "manageMessaging");
      const admin = supabaseAdmin();
      const { data: setting, error: settingError } = await admin.from("platform_settings").select("is_enabled, value")
        .eq("setting_key", "invoice_delivery_channels").maybeSingle();
      if (settingError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر التحقق من سياسة قنوات الفواتير في Supabase." });
      if (!setting || !isInvoiceDeliveryChannelEnabled("sms", invoiceDeliveryPolicyFromSetting({ isEnabled: setting.is_enabled, value: setting.value }))) throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكن حفظ قالب إيصال SMS لقناة معطلة من آدمن المنصة." });
      const { error } = await admin.from("tenant_payment_receipt_message_templates").upsert({ tenant_id: scope.tenantId, channel: "sms", body: input.body, is_active: input.isActive }, { onConflict: "tenant_id,channel" });
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر حفظ قالب إيصال SMS في Supabase." });
      await writeSupabaseAudit({ userId: ctx.user.id, tenantId: scope.tenantId, siteId: input.siteId, entityType: "tenant_payment_receipt_message_template", entityId: `${scope.tenantId}:sms`, action: "upsert", afterData: { channel: "sms", isActive: input.isActive }, metadata: { bodyLength: input.body.length } });
      return { success: true };
    }),
  }),
  quickActions: router({
    preferences: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      await resolveSupabaseSiteAccess(ctx.user.id, input.siteId);
      const { data: preference, error } = await supabaseAdmin().from("user_quick_action_preferences")
        .select("action_ids, updated_at").eq("user_id", ctx.user.id).eq("site_id", input.siteId).maybeSingle();
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل تفضيلات الإجراءات السريعة من Supabase." });
      const actionIds = Array.isArray(preference?.action_ids) ? preference.action_ids.filter((actionId): actionId is keyof typeof quickActionCapabilityById => typeof actionId === "string" && actionId in quickActionCapabilityById) : [];
      return { actionIds, updatedAt: preference?.updated_at ? new Date(preference.updated_at) : null };
    }),
    savePreferences: protectedProcedure.input(siteScoped.extend({ actionIds: z.array(quickActionIdSchema).min(1).max(6).refine((actionIds) => new Set(actionIds).size === actionIds.length, "لا يمكن تكرار الإجراء المختار.") })).mutation(async ({ ctx, input }) => {
      const access = await resolveSupabaseSiteAccess(ctx.user.id, input.siteId);
      const unavailable = input.actionIds.find((actionId) => access.role !== "owner" && !access.permissions.includes(quickActionCapabilityById[actionId]));
      if (unavailable) throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكنك حفظ إجراء لا تملك صلاحيته في هذا الفرع." });
      const { error } = await supabaseAdmin().from("user_quick_action_preferences").upsert({ user_id: ctx.user.id, site_id: input.siteId, action_ids: input.actionIds }, { onConflict: "user_id,site_id" });
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر حفظ تفضيلات الإجراءات السريعة في Supabase." });
      await writeSupabaseAudit({ userId: ctx.user.id, tenantId: access.tenantId, siteId: input.siteId, entityType: "user_quick_action_preferences", entityId: `${ctx.user.id}:${input.siteId}`, action: "upsert", afterData: { actionIds: input.actionIds } });
      return { success: true, actionIds: input.actionIds };
    }),
  }),
  staff: router({
    myAccess: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => resolveSupabaseSiteAccess(ctx.user.id, input.siteId)),
    allBranchAccess: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      const access = await resolveSupabaseSiteAccess(ctx.user.id, input.siteId);
      if (access.role === "owner") return { isGlobal: true };
      const { data: globalProfile, error } = await supabaseAdmin().from("staff_profiles").select("id")
        .eq("tenant_id", access.tenantId).eq("user_id", ctx.user.id).is("site_id", null).eq("is_active", true).maybeSingle();
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر التحقق من امتداد صلاحية المستخدم لكل الفروع في Supabase." });
      return { isGlobal: Boolean(globalProfile) };
    }),
    permissionChanges: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), userId: z.number().int().positive().optional() })).query(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner"], "viewAudit");
      let query = supabaseAdmin().from("audit_logs").select("id, user_id, action, created_at, after_data, metadata")
        .eq("tenant_id", access.tenantId).eq("site_id", input.siteId).eq("entity_type", "staff_profile").eq("action", "update_permissions")
        .order("created_at", { ascending: false }).limit(100);
      if (input.userId) query = query.eq("after_data->>targetUserId", String(input.userId));
      const { data, error } = await query;
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل سجل تغييرات الصلاحيات من Supabase." });
      return (data ?? []).map((row) => ({ id: Number(row.id), userId: row.user_id === null ? null : Number(row.user_id), action: row.action, createdAt: new Date(row.created_at), afterData: row.after_data, metadata: row.metadata }));
    }),
    list: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager"], "manageTeam");
      const { data: profiles, error: profilesError } = await supabaseAdmin().from("staff_profiles")
        .select("id, user_id, tenant_id, site_id, role, custom_role_id, permissions, suspension_started_at, suspension_ends_at, is_active, archived_at, created_at, updated_at")
        .eq("tenant_id", access.tenantId).is("archived_at", null).or(`site_id.eq.${input.siteId},site_id.is.null`);
      if (profilesError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل الحسابات الفرعية من Supabase." });
      const userIds = Array.from(new Set((profiles ?? []).map((profile) => Number(profile.user_id))));
      const { data: userRows, error: usersError } = userIds.length
        ? await supabaseAdmin().from("users").select("id, auth_user_id, name, email, login_method, role, platform_role, account_status, must_change_password, temporary_password_issued_at, created_at, updated_at, last_signed_in").in("id", userIds)
        : { data: [], error: null };
      if (usersError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل بيانات الحسابات الفرعية من Supabase." });
      const usersById = new Map((userRows ?? []).map((user) => [Number(user.id), {
        id: Number(user.id), openId: user.auth_user_id, name: user.name, email: user.email, loginMethod: user.login_method, role: user.role,
        platformRole: user.platform_role, accountStatus: user.account_status, mustChangePassword: user.must_change_password,
        temporaryPasswordIssuedAt: user.temporary_password_issued_at ? new Date(user.temporary_password_issued_at) : null,
        createdAt: new Date(user.created_at), updatedAt: new Date(user.updated_at), lastSignedIn: new Date(user.last_signed_in),
      }]));
      return (profiles ?? []).flatMap((profile) => {
        const user = usersById.get(Number(profile.user_id));
        if (!user) return [];
        return [{ profile: {
          id: Number(profile.id), userId: Number(profile.user_id), tenantId: profile.tenant_id === null ? null : Number(profile.tenant_id), siteId: profile.site_id === null ? null : Number(profile.site_id),
          role: profile.role, customRoleId: profile.custom_role_id === null ? null : Number(profile.custom_role_id), permissions: profile.permissions,
          suspensionStartedAt: profile.suspension_started_at ? new Date(profile.suspension_started_at) : null, suspensionEndsAt: profile.suspension_ends_at ? new Date(profile.suspension_ends_at) : null,
          isActive: profile.is_active, archivedAt: profile.archived_at ? new Date(profile.archived_at) : null, createdAt: new Date(profile.created_at), updatedAt: new Date(profile.updated_at),
        }, user }];
      });
    }),
    archived: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner"], "manageTeam");
      const { data: profiles, error: profilesError } = await supabaseAdmin().from("staff_profiles")
        .select("id, user_id, tenant_id, site_id, role, custom_role_id, permissions, suspension_started_at, suspension_ends_at, is_active, archived_at, created_at, updated_at")
        .eq("tenant_id", access.tenantId).not("archived_at", "is", null).or(`site_id.eq.${input.siteId},site_id.is.null`);
      if (profilesError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل الحسابات الفرعية المؤرشفة من Supabase." });
      const userIds = Array.from(new Set((profiles ?? []).map((profile) => Number(profile.user_id))));
      const { data: userRows, error: usersError } = userIds.length
        ? await supabaseAdmin().from("users").select("id, auth_user_id, name, email, login_method, role, platform_role, account_status, must_change_password, temporary_password_issued_at, created_at, updated_at, last_signed_in").in("id", userIds)
        : { data: [], error: null };
      if (usersError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل بيانات الحسابات المؤرشفة من Supabase." });
      const usersById = new Map((userRows ?? []).map((user) => [Number(user.id), {
        id: Number(user.id), openId: user.auth_user_id, name: user.name, email: user.email, loginMethod: user.login_method, role: user.role,
        platformRole: user.platform_role, accountStatus: user.account_status, mustChangePassword: user.must_change_password,
        temporaryPasswordIssuedAt: user.temporary_password_issued_at ? new Date(user.temporary_password_issued_at) : null,
        createdAt: new Date(user.created_at), updatedAt: new Date(user.updated_at), lastSignedIn: new Date(user.last_signed_in),
      }]));
      return (profiles ?? []).flatMap((profile) => {
        const user = usersById.get(Number(profile.user_id));
        if (!user) return [];
        return [{
          profile: {
            id: Number(profile.id), userId: Number(profile.user_id), tenantId: profile.tenant_id === null ? null : Number(profile.tenant_id), siteId: profile.site_id === null ? null : Number(profile.site_id),
            role: profile.role, customRoleId: profile.custom_role_id === null ? null : Number(profile.custom_role_id), permissions: profile.permissions,
            suspensionStartedAt: profile.suspension_started_at ? new Date(profile.suspension_started_at) : null, suspensionEndsAt: profile.suspension_ends_at ? new Date(profile.suspension_ends_at) : null,
            isActive: profile.is_active, archivedAt: profile.archived_at ? new Date(profile.archived_at) : null,
            createdAt: new Date(profile.created_at), updatedAt: new Date(profile.updated_at),
          }, user,
        }];
      });
    }),
    directory: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner"], "manageTeam");
      const { data: members, error: membersError } = await supabaseAdmin().from("tenant_members").select("user_id")
        .eq("tenant_id", access.tenantId).eq("is_active", true).eq("membership_status", "active");
      if (membersError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل أعضاء مساحة صاحب المولد من Supabase." });
      const userIds = Array.from(new Set((members ?? []).map((member) => Number(member.user_id))));
      if (!userIds.length) return [];
      const { data: userRows, error: usersError } = await supabaseAdmin().from("users").select("id, name, email, role").in("id", userIds).order("last_signed_in", { ascending: false });
      if (usersError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل دليل الحسابات للمساحة من Supabase." });
      return (userRows ?? []).map((user) => ({ id: Number(user.id), name: user.name, email: user.email, role: user.role }));
    }),
    allowedSubaccountRoles: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner"], "manageTeam");
      const admin = supabaseAdmin();
      const [subscriptionResult, rolesPolicyResult, limitsPolicyResult, overridesResult, membersResult, activeStaffResult, platformQuotaResult, fieldQuotaResult] = await Promise.all([
        admin.from("tenant_subscriptions").select("package_code").eq("tenant_id", access.tenantId).maybeSingle(),
        admin.from("platform_settings").select("is_enabled, value").eq("setting_key", "owner_subaccount_roles").maybeSingle(),
        admin.from("platform_settings").select("value").eq("setting_key", "owner_subaccount_limits").maybeSingle(),
        admin.from("platform_settings").select("value").eq("setting_key", "owner_limit_overrides").maybeSingle(),
        admin.from("tenant_members").select("user_id").eq("tenant_id", access.tenantId).eq("role", "member").eq("is_active", true).eq("membership_status", "active"),
        admin.from("staff_profiles").select("user_id, role").eq("tenant_id", access.tenantId).eq("is_active", true).is("archived_at", null),
        admin.rpc("powerhub_effective_tenant_quota", { p_tenant_id: access.tenantId, p_resource: "platformUser" }),
        admin.rpc("powerhub_effective_tenant_quota", { p_tenant_id: access.tenantId, p_resource: "fieldUser" }),
      ]);
      if (subscriptionResult.error || rolesPolicyResult.error || limitsPolicyResult.error || overridesResult.error || membersResult.error || activeStaffResult.error || platformQuotaResult.error || fieldQuotaResult.error) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل سياسة الحسابات الفرعية من Supabase." });
      }
      const plan = subscriptionResult.data?.package_code;
      if (!plan || !["basic","advanced","professional","business","vip"].includes(plan)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "لا توجد باقة صالحة لمساحة صاحب المولد." });
      const policyOverrides = overridesResult.data?.value && typeof overridesResult.data.value === "object" && !Array.isArray(overridesResult.data.value)
        ? (overridesResult.data.value as Record<string, unknown>).overrides : undefined;
      const override = policyOverrides && typeof policyOverrides === "object" && !Array.isArray(policyOverrides)
        ? (policyOverrides as Record<string, unknown>)[String(access.tenantId)] : undefined;
      const overrideRecord = override && typeof override === "object" && !Array.isArray(override) ? override as Record<string, unknown> : {};
      const globalRoles = allowedOwnerSubaccountRoles(rolesPolicyResult.data ? { isEnabled: rolesPolicyResult.data.is_enabled, value: rolesPolicyResult.data.value } : null);
      const overrideRoles = Array.isArray(overrideRecord.allowedRoles) ? overrideRecord.allowedRoles.filter((role): role is string => typeof role === "string") : undefined;
      const roles = overrideRoles ? globalRoles.filter((role) => overrideRoles.includes(role)) : globalRoles;
      const overrideLimit = typeof overrideRecord.subaccountLimit === "number" && Number.isInteger(overrideRecord.subaccountLimit) && overrideRecord.subaccountLimit >= 0 ? overrideRecord.subaccountLimit : undefined;
      const limit = overrideLimit ?? ownerSubaccountLimitForPlan(plan, limitsPolicyResult.data ? { value: limitsPolicyResult.data.value } : null);
      const activeMemberIds = new Set((membersResult.data ?? []).map((member) => Number(member.user_id)));
      const activeStaffRows = activeStaffResult.data ?? [];
      const currentCount = new Set(activeStaffRows.filter((row) => ["manager", "accountant", "collector", "viewer"].includes(String(row.role)) && activeMemberIds.has(Number(row.user_id))).map((row) => Number(row.user_id))).size;
      const fieldUserCount = new Set(activeStaffRows.filter((row) => row.role === "technician" && activeMemberIds.has(Number(row.user_id))).map((row) => Number(row.user_id))).size;
      const platformUserLimit = Math.max(0, Number(Array.isArray(platformQuotaResult.data) ? platformQuotaResult.data[0] : platformQuotaResult.data) || limit);
      const fieldUserLimit = Math.max(0, Number(Array.isArray(fieldQuotaResult.data) ? fieldQuotaResult.data[0] : fieldQuotaResult.data) || 0);
      return {
        roles,
        limit: platformUserLimit,
        currentCount,
        remaining: Math.max(0, platformUserLimit - currentCount),
        fieldUserLimit,
        fieldUserCount,
        fieldUserRemaining: Math.max(0, fieldUserLimit - fieldUserCount),
      };
    }),
    permissionCatalog: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner"], "manageTeam");
      const capabilities: PowerCapability[] = ["manageSubscribers", "manageGenerators", "recordReadings", "accessFieldApp", "approveReadings", "manageTariffs", "issueInvoices", "collectPayments", "approvePaymentDocumentation", "manageExpenses", "managePayroll", "manageTeam", "manageMessaging", "viewAudit"];
      return capabilities;
    }),
    customRoles: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner"], "manageTeam");
      const { data, error } = await supabaseAdmin().from("custom_permission_roles").select("id, name, description, permissions, is_active")
        .eq("tenant_id", access.tenantId).eq("is_active", true).order("name", { ascending: true });
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل الأدوار المخصصة من Supabase." });
      return (data ?? []).map((role) => ({ id: Number(role.id), name: role.name, description: role.description, permissions: role.permissions, isActive: role.is_active }));
    }),
    saveCustomRole: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), id: z.number().int().positive().optional(), name: z.string().trim().min(2).max(120), description: z.string().trim().max(255).optional(), permissions: z.array(z.enum(["manageSubscribers", "manageGenerators", "recordReadings", "accessFieldApp", "approveReadings", "manageTariffs", "issueInvoices", "collectPayments", "approvePaymentDocumentation", "manageExpenses", "managePayroll", "manageTeam", "manageMessaging", "viewAudit"])).min(1) })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner"], "manageTeam");
      const { data, error } = await supabaseAdmin().rpc("powerhub_save_custom_permission_role", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id, p_role_id: input.id ?? null,
        p_name: input.name, p_description: input.description ?? null, p_permissions: input.permissions,
      });
      if (error) {
        if (error.message.includes("CUSTOM_ROLE_NOT_FOUND")) throw new TRPCError({ code: "NOT_FOUND", message: "الدور المخصص غير موجود ضمن مساحة المستأجر." });
        if (error.message.includes("ROLE_MANAGEMENT_FORBIDDEN")) throw new TRPCError({ code: "FORBIDDEN", message: "لا تملك صلاحية إدارة الأدوار المخصصة." });
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر حفظ الدور المخصص في Supabase." });
      }
      return { success: true, id: Number(data?.[0]?.role_id ?? input.id ?? 0) };
    }),
    deleteCustomRole: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), roleId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner"], "manageTeam");
      const { error } = await supabaseAdmin().rpc("powerhub_delete_custom_permission_role", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id, p_role_id: input.roleId,
      });
      if (error) {
        if (error.message.includes("CUSTOM_ROLE_LINKED")) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "لا يمكن حذف دور مرتبط بحساب فعال. أعد تعيين الحساب أولاً." });
        if (error.message.includes("CUSTOM_ROLE_NOT_FOUND")) throw new TRPCError({ code: "NOT_FOUND", message: "الدور المخصص غير موجود ضمن مساحة المستأجر." });
        if (error.message.includes("ROLE_MANAGEMENT_FORBIDDEN")) throw new TRPCError({ code: "FORBIDDEN", message: "لا تملك صلاحية إدارة الأدوار المخصصة." });
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر حذف الدور المخصص في Supabase." });
      }
      return { success: true };
    }),
    updatePermissions: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), profileId: z.number().int().positive(), customRoleId: z.number().int().positive().nullable().optional(), permissions: z.array(z.enum(["manageSubscribers", "manageGenerators", "recordReadings", "accessFieldApp", "approveReadings", "manageTariffs", "issueInvoices", "collectPayments", "approvePaymentDocumentation", "manageExpenses", "managePayroll", "manageTeam", "manageMessaging", "viewAudit"])).min(0) })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner"], "manageTeam");
      const { error } = await supabaseAdmin().rpc("powerhub_update_staff_profile_permissions", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_actor_user_id: ctx.user.id, p_profile_id: input.profileId,
        p_custom_role_id: input.customRoleId ?? null, p_permissions: input.permissions,
      });
      if (error) {
        if (error.message.includes("CUSTOM_ROLE_NOT_FOUND")) throw new TRPCError({ code: "NOT_FOUND", message: "الدور المخصص غير موجود ضمن مساحة المستأجر." });
        if (error.message.includes("STAFF_PROFILE_OUT_OF_SCOPE")) throw new TRPCError({ code: "NOT_FOUND", message: "الحساب الفرعي غير موجود ضمن نطاقك." });
        if (error.message.includes("STAFF_PERMISSION_MANAGEMENT_FORBIDDEN")) throw new TRPCError({ code: "FORBIDDEN", message: "لا تملك صلاحية تعديل صلاحيات الحسابات الفرعية." });
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تعديل صلاحيات الحساب الفرعي في Supabase." });
      }
      return { success: true };
    }),
    assign: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), userId: z.number().int().positive(), role: z.enum(["owner", "manager", "accountant", "collector", "technician", "viewer"]), allBranches: z.boolean().default(false) }))
      .mutation(async ({ ctx, input }) => {
        const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner"], "manageTeam");
        const { error } = await supabaseAdmin().rpc("powerhub_assign_existing_staff", {
          p_tenant_id: access.tenantId, p_site_id: input.siteId, p_actor_user_id: ctx.user.id, p_target_user_id: input.userId,
          p_role: input.role, p_all_branches: input.allBranches,
        });
        if (error) {
          if (error.message.includes("TARGET_USER_NOT_FOUND")) throw new TRPCError({ code: "NOT_FOUND", message: "الحساب المطلوب غير موجود في Supabase." });
          if (error.message.includes("SUBACCOUNT_ROLE_NOT_ALLOWED")) throw new TRPCError({ code: "FORBIDDEN", message: "هذا الدور غير مسموح للحسابات الفرعية وفق سياسة آدمن المنصة." });
          if (error.message.includes("SUBACCOUNT_LIMIT_REACHED")) { try { await recordSupabaseQuotaAlert({ tenantId: access.tenantId, siteId: input.siteId, userId: ctx.user.id, resource: "platformUser", alertType: "blocked_attempt" }); } catch (alertError) { console.error("[PowerHub] platform user quota alert failed", alertError); } throw new TRPCError({ code: "PRECONDITION_FAILED", message: "وصلت إلى الحد الأقصى للحسابات الفرعية في اشتراكك." }); }
          if (error.message.includes("FIELD_USER_LIMIT_REACHED")) { try { await recordSupabaseQuotaAlert({ tenantId: access.tenantId, siteId: input.siteId, userId: ctx.user.id, resource: "fieldUser", alertType: "blocked_attempt" }); } catch (alertError) { console.error("[PowerHub] field user quota alert failed", alertError); } throw new TRPCError({ code: "PRECONDITION_FAILED", message: "وصلت إلى الحد الأقصى لمستخدمي تطبيق إدخال قراءة العداد في باقتك." }); }
          if (error.message.includes("STAFF_ASSIGNMENT_FORBIDDEN")) throw new TRPCError({ code: "FORBIDDEN", message: "لا تملك صلاحية تعيين الحسابات الفرعية." });
          if (error.message.includes("TENANT_PLAN_NOT_FOUND")) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "لا توجد باقة صالحة لمساحة صاحب المولد." });
          if (error.message.includes("SITE_OUT_OF_SCOPE")) throw new TRPCError({ code: "NOT_FOUND", message: "الفرع غير موجود ضمن مساحة صاحب المولد." });
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تعيين الحساب الفرعي في Supabase." });
        }
        return { success: true };
      }),
    create: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), email: z.string().email(), name: z.string().trim().min(2).max(160), temporaryPassword: z.string().min(8).max(128), role: z.enum(["manager", "accountant", "collector", "technician", "viewer"]), allBranches: z.boolean().default(false) })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner"], "manageTeam");
      const admin = supabaseAdmin();
      const email = input.email.trim().toLowerCase();
      const { data: existingUser } = await admin.from("users").select("id, auth_user_id, email").eq("email", email).maybeSingle();
      if (existingUser) throw new TRPCError({ code: "CONFLICT", message: "البريد الإلكتروني مستخدم بالفعل. استخدم حسابًا موجودًا للتعيين بدل إنشاء حساب جديد." });

      const { data: authData, error: authError } = await admin.auth.admin.createUser({
        email,
        password: input.temporaryPassword,
        email_confirm: true,
        user_metadata: { name: input.name.trim(), must_change_password: true },
      });
      if (authError || !authData.user) {
        throw new TRPCError({ code: authError?.status === 422 ? "CONFLICT" : "BAD_REQUEST", message: authError?.message || "تعذر إنشاء حساب Supabase Auth." });
      }

      try {
        const { data: profileUser, error: profileError } = await admin.from("users")
          .select("id")
          .eq("auth_user_id", authData.user.id)
          .maybeSingle();
        if (profileError || !profileUser) throw new Error("تعذر إنشاء ملف المستخدم في Supabase بعد إنشاء Auth.");
        const { error: passwordPolicyError } = await admin.from("users")
          .update({ must_change_password: true, temporary_password_issued_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq("id", Number(profileUser.id))
          .eq("auth_user_id", authData.user.id);
        if (passwordPolicyError) throw new Error("تعذر تثبيت سياسة كلمة المرور المؤقتة للحساب الفرعي.");
        const { data, error } = await admin.rpc("powerhub_assign_existing_staff", {
          p_tenant_id: access.tenantId,
          p_site_id: input.siteId,
          p_actor_user_id: ctx.user.id,
          p_target_user_id: Number(profileUser.id),
          p_role: input.role,
          p_all_branches: input.allBranches,
        });
        if (error || !data?.[0]) {
          const errorText = `${error?.code ?? ""} ${error?.message ?? ""}`;
          if (errorText.includes("SUBACCOUNT_ROLE_NOT_ALLOWED")) throw new TRPCError({ code: "FORBIDDEN", message: "هذا الدور غير مسموح للحسابات الفرعية وفق سياسة آدمن المنصة." });
          if (errorText.includes("SUBACCOUNT_LIMIT_REACHED")) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "وصلت إلى الحد الأقصى للحسابات الفرعية في اشتراكك." });
          if (errorText.includes("FIELD_USER_LIMIT_REACHED")) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "وصلت إلى الحد الأقصى لمستخدمي تطبيق إدخال قراءة العداد في باقتك." });
          if (errorText.includes("SITE_OUT_OF_SCOPE")) throw new TRPCError({ code: "NOT_FOUND", message: "الفرع غير موجود ضمن مساحة صاحب المولد." });
          throw new Error(error?.message || "تعذر تعيين الحساب الفرعي في Supabase.");
        }
        return { success: true, userId: Number(profileUser.id), profileId: Number(data[0].profile_id) };
      } catch (error) {
        await admin.auth.admin.deleteUser(authData.user.id).catch((deleteError) => {
          console.error("[PowerHub] failed to compensate orphaned staff Auth user", deleteError);
        });
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error instanceof Error ? error.message : "تعذر إكمال إنشاء الحساب الفرعي." });
      }
    }),
    activity: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), userId: z.number().int().positive() })).query(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner"], "manageTeam");
      const { data, error } = await supabaseAdmin().from("audit_logs").select("id, action, entity_type, created_at, metadata, after_data")
        .eq("tenant_id", access.tenantId).eq("site_id", input.siteId).eq("user_id", input.userId).order("created_at", { ascending: false }).limit(15);
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل سجل نشاط الحساب الفرعي من Supabase." });
      return (data ?? []).map((entry) => ({ id: Number(entry.id), action: entry.action, entityType: entry.entity_type, createdAt: new Date(entry.created_at), metadata: entry.metadata, afterData: entry.after_data }));
    }),
    resetPassword: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), profileId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner"], "manageTeam");
      const admin = supabaseAdmin();
      const { data: intent, error: beginError } = await admin.rpc("powerhub_staff_reset_password_begin", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_actor_user_id: ctx.user.id, p_profile_id: input.profileId,
      });
      if (beginError || !intent?.[0]) {
        const text = `${beginError?.code ?? ""} ${beginError?.message ?? ""}`;
        if (text.includes("RESET_ALREADY_PENDING")) throw new TRPCError({ code: "CONFLICT", message: "يوجد طلب إعادة تعيين جارٍ لهذا الحساب." });
        if (text.includes("STAFF_PROFILE_OUT_OF_SCOPE")) throw new TRPCError({ code: "NOT_FOUND", message: "الحساب الفرعي غير موجود ضمن نطاقك." });
        if (text.includes("STAFF_PASSWORD_RESET_FORBIDDEN")) throw new TRPCError({ code: "FORBIDDEN", message: "لا تملك صلاحية إعادة تعيين كلمة مرور هذا الحساب." });
        if (text.includes("STAFF_AUTH_USER_MISSING")) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "هذا الحساب غير مرتبط بـSupabase Auth." });
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر إنشاء طلب إعادة تعيين كلمة المرور." });
      }

      const row = intent[0] as { intent_id: number; auth_user_id: string; target_user_id: number; expires_at: string };
      const temporaryPassword = `Ph!${crypto.randomBytes(10).toString("base64url")}`;
      let authSucceeded = false;
      try {
        const { error: authError } = await admin.auth.admin.updateUserById(row.auth_user_id, { password: temporaryPassword, user_metadata: { must_change_password: true } });
        if (authError) throw authError;
        authSucceeded = true;
        const { data: completed, error: completeError } = await admin.rpc("powerhub_staff_reset_password_complete", {
          p_tenant_id: access.tenantId, p_site_id: input.siteId, p_actor_user_id: ctx.user.id, p_intent_id: row.intent_id, p_success: true,
        });
        if (completeError || !completed?.[0] || completed[0].status !== "completed") {
          throw new Error(completeError?.message || "تعذر إتمام إعادة تعيين كلمة المرور.");
        }
        return { success: true, temporaryPassword, expiresAt: row.expires_at, userId: Number(row.target_user_id) };
      } catch (error) {
        try {
          await admin.rpc("powerhub_staff_reset_password_complete", {
            p_tenant_id: access.tenantId, p_site_id: input.siteId, p_actor_user_id: ctx.user.id, p_intent_id: row.intent_id, p_success: false,
          });
        } catch {
          // Preserve the original Auth result while keeping the intent best-effort reconciled.
        }
        if (!authSucceeded) {
          throw new TRPCError({ code: "BAD_REQUEST", message: error instanceof Error ? error.message : "تعذر تحديث كلمة مرور Supabase Auth." });
        }
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تم تحديث Auth لكن تعذر إتمام سجل العملية؛ راجع سجل التدقيق قبل إعادة المحاولة." });
      }
    }),
    suspend: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), profileId: z.number().int().positive(), startsAt: z.string().datetime(), endsAt: z.string().datetime() })).mutation(async ({ ctx, input }) => {
      const startsAt = new Date(input.startsAt); const endsAt = new Date(input.endsAt);
      if (endsAt <= startsAt) throw new TRPCError({ code: "BAD_REQUEST", message: "يجب أن يكون تاريخ نهاية التوقيف بعد تاريخ البداية." });
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner"], "manageTeam");
      const { data, error } = await supabaseAdmin().rpc("powerhub_update_staff_profile_status", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_actor_user_id: ctx.user.id, p_profile_id: input.profileId,
        p_operation: "suspend", p_suspension_started_at: startsAt.toISOString(), p_suspension_ends_at: endsAt.toISOString(), p_is_active: null,
      });
      if (error) {
        if (error.message.includes("STAFF_PROFILE_OUT_OF_SCOPE")) throw new TRPCError({ code: "NOT_FOUND", message: "الحساب الفرعي غير موجود ضمن نطاقك." });
        if (error.message.includes("INVALID_SUSPENSION_WINDOW")) throw new TRPCError({ code: "BAD_REQUEST", message: "يجب أن يكون تاريخ نهاية التوقيف بعد تاريخ البداية." });
        if (error.message.includes("STAFF_STATUS_MANAGEMENT_FORBIDDEN")) throw new TRPCError({ code: "FORBIDDEN", message: "لا تملك صلاحية توقيف الحسابات الفرعية." });
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر توقيف الحساب الفرعي في Supabase." });
      }
      return { success: true, suspensionEndsAt: data?.[0]?.suspension_ends_at ? new Date(data[0].suspension_ends_at) : endsAt };
    }),
    clearSuspension: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), profileId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner"], "manageTeam");
      const { error } = await supabaseAdmin().rpc("powerhub_update_staff_profile_status", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_actor_user_id: ctx.user.id, p_profile_id: input.profileId,
        p_operation: "clear_suspension", p_suspension_started_at: null, p_suspension_ends_at: null, p_is_active: null,
      });
      if (error) {
        if (error.message.includes("STAFF_PROFILE_OUT_OF_SCOPE")) throw new TRPCError({ code: "NOT_FOUND", message: "الحساب الفرعي غير موجود ضمن نطاقك." });
        if (error.message.includes("STAFF_STATUS_MANAGEMENT_FORBIDDEN")) throw new TRPCError({ code: "FORBIDDEN", message: "لا تملك صلاحية إدارة توقيف الحسابات الفرعية." });
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر رفع توقيف الحساب الفرعي في Supabase." });
      }
      return { success: true };
    }),
    archive: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), profileId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner"], "manageTeam");
      const { data, error } = await supabaseAdmin().rpc("powerhub_update_staff_profile_status", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_actor_user_id: ctx.user.id, p_profile_id: input.profileId,
        p_operation: "archive", p_suspension_started_at: null, p_suspension_ends_at: null, p_is_active: false,
      });
      if (error) {
        const text = error.message ?? "";
        if (text.includes("STAFF_PROFILE_OUT_OF_SCOPE")) throw new TRPCError({ code: "NOT_FOUND", message: "الحساب الفرعي غير موجود ضمن نطاقك." });
        if (text.includes("OWNER_PROFILE_PROTECTED")) throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكن أرشفة حساب المالك." });
        if (text.includes("STAFF_STATUS_MANAGEMENT_FORBIDDEN")) throw new TRPCError({ code: "FORBIDDEN", message: "لا تملك صلاحية أرشفة الحسابات الفرعية." });
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر أرشفة الحساب الفرعي في Supabase." });
      }
      return { success: true, archivedAt: data?.[0]?.archived_at ? new Date(data[0].archived_at) : new Date() };
    }),
    restore: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), profileId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner"], "manageTeam");
      const { data, error } = await supabaseAdmin().rpc("powerhub_update_staff_profile_status", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_actor_user_id: ctx.user.id, p_profile_id: input.profileId,
        p_operation: "restore", p_suspension_started_at: null, p_suspension_ends_at: null, p_is_active: true,
      });
      if (error) {
        const text = error.message ?? "";
        if (text.includes("STAFF_PROFILE_OUT_OF_SCOPE")) throw new TRPCError({ code: "NOT_FOUND", message: "الحساب المؤرشف غير موجود ضمن نطاقك." });
        if (text.includes("FIELD_USER_LIMIT_REACHED") || text.includes("SUBACCOUNT_LIMIT_REACHED")) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "لا يمكن استعادة الحساب لأن الحصة المسموح بها لنوع الحساب ممتلئة. حرّر حصة أولاً ثم أعد المحاولة." });
        if (text.includes("FIELD_USERS_FEATURE_DISABLED") || text.includes("PLATFORM_USERS_FEATURE_DISABLED")) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "ميزة نوع الحساب غير مفعلة حالياً من إدارة PowerHub." });
        if (text.includes("STAFF_STATUS_MANAGEMENT_FORBIDDEN")) throw new TRPCError({ code: "FORBIDDEN", message: "لا تملك صلاحية استعادة الحسابات الفرعية." });
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر استعادة الحساب الفرعي من Supabase." });
      }
      return { success: true, isActive: Boolean(data?.[0]?.is_active), archivedAt: data?.[0]?.archived_at ? new Date(data[0].archived_at) : null };
    }),
    setActive: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), profileId: z.number().int().positive(), isActive: z.boolean() })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner"], "manageTeam");
      const { error } = await supabaseAdmin().rpc("powerhub_update_staff_profile_status", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_actor_user_id: ctx.user.id, p_profile_id: input.profileId,
        p_operation: "set_active", p_suspension_started_at: null, p_suspension_ends_at: null, p_is_active: input.isActive,
      });
      if (error) {
        if (error.message.includes("STAFF_PROFILE_OUT_OF_SCOPE")) throw new TRPCError({ code: "NOT_FOUND", message: "الحساب الفرعي غير موجود ضمن نطاقك." });
        if (error.message.includes("STAFF_STATUS_MANAGEMENT_FORBIDDEN")) throw new TRPCError({ code: "FORBIDDEN", message: "لا تملك صلاحية تفعيل أو تعطيل الحسابات الفرعية." });
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحديث حالة الحساب الفرعي في Supabase." });
      }
      return { success: true, isActive: input.isActive };
    }),
  }),
  subscription: router({
    ownerRenewalStatus: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      const admin = supabaseAdmin();
      // Resolve the requested site and owner membership directly so this read-only
      // status remains visible even when an expired subscription gates normal workspace APIs.
      const { data: site, error: siteError } = await admin.from("sites")
        .select("id, tenant_id").eq("id", input.siteId).maybeSingle();
      if (siteError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحديد مساحة الاشتراك." });
      if (!site) throw new TRPCError({ code: "NOT_FOUND", message: "الفرع غير موجود." });
      const { data: membership, error: membershipError } = await admin.from("tenant_members")
        .select("role").eq("tenant_id", Number(site.tenant_id)).eq("user_id", ctx.user.id)
        .eq("is_active", true).eq("membership_status", "active").maybeSingle();
      if (membershipError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر التحقق من عضوية مساحة الاشتراك." });
      if (membership?.role !== "owner") return { isOwner: false as const, subscription: null };
      const { data: row, error } = await admin.from("tenant_subscriptions")
        .select("package_code, status, billing_cycle, started_at, ends_at, auto_renew, read_only_until, renewal_count")
        .eq("tenant_id", Number(site.tenant_id))
        .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(1).maybeSingle();
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل تاريخ انتهاء الاشتراك." });
      if (!row) return { isOwner: true as const, subscription: null };
      return {
        isOwner: true as const,
        subscription: {
          packageCode: String(row.package_code ?? ""),
          status: String(row.status ?? "unknown"),
          billingCycle: row.billing_cycle ? String(row.billing_cycle) : null,
          startedAt: row.started_at ? new Date(row.started_at) : null,
          endsAt: row.ends_at ? new Date(row.ends_at) : null,
          autoRenew: Boolean(row.auto_renew),
          readOnlyUntil: row.read_only_until ? new Date(row.read_only_until) : null,
          renewalCount: Number(row.renewal_count ?? 0),
        },
      };
    }),
    currentUpgradeRequest: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "viewer"]);
      const { data, error } = await supabaseAdmin().from("subscription_upgrade_requests")
        .select("id, current_package_code, requested_package_code, status, note, created_at, reviewed_at")
        .eq("tenant_id", access.tenantId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل طلب ترقية الباقة من Supabase." });
      if (!data) return null;
      return {
        id: Number(data.id),
        currentPackageCode: data.current_package_code,
        requestedPackageCode: data.requested_package_code,
        status: data.status,
        note: data.note,
        createdAt: new Date(data.created_at),
        reviewedAt: data.reviewed_at ? new Date(data.reviewed_at) : null,
      };
    }),
    currentAddonRequests: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "viewer"]);
      const { data, error } = await supabaseAdmin().from("tenant_addon_requests")
        .select("id, addon_code, quantity, status, duration_days, starts_at, ends_at, created_at, reviewed_at")
        .eq("tenant_id", access.tenantId)
        .in("status", ["pending", "reviewing", "approved"])
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل طلبات الإضافات من Supabase." });
      return (data ?? []).map((row:any) => ({
        id: Number(row.id),
        addonCode: row.addon_code,
        quantity: Number(row.quantity),
        status: row.status,
        durationDays: Number(row.duration_days ?? 30),
        startsAt: row.starts_at ? new Date(row.starts_at) : null,
        endsAt: row.ends_at ? new Date(row.ends_at) : null,
        createdAt: new Date(row.created_at),
        reviewedAt: row.reviewed_at ? new Date(row.reviewed_at) : null,
      }));
    }),
    requestUpgrade: protectedProcedure.input(siteScoped.extend({ requestedPackageCode: z.string().trim().min(2).max(80).regex(/^[a-z0-9][a-z0-9_-]*$/) })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner"], "manageSubscribers");
      const { data, error } = await supabaseAdmin().rpc("powerhub_request_subscription_upgrade", { p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id, p_requested_package_code: input.requestedPackageCode });
      const result = (data as Array<{ request_id: number | string; requested_package_code: string; already_requested: boolean }> | null)?.[0];
      if (!error && result?.request_id) return { id: Number(result.request_id), requestedPackageCode: result.requested_package_code, alreadyRequested: result.already_requested };
      const errorText = `${error?.code ?? ""} ${error?.message ?? ""}`;
      if (errorText.includes("NO_QUOTA_LIMIT_REACHED")) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "لم يصل أي مورد إلى حد الباقة بعد." });
      if (errorText.includes("REQUESTED_PACKAGE_NOT_HIGHER")) throw new TRPCError({ code: "BAD_REQUEST", message: "اختر باقة أعلى من باقتك الحالية." });
      if (errorText.includes("TENANT_PACKAGE_NOT_FOUND")) throw new TRPCError({ code: "NOT_FOUND", message: "تعذر تحديد باقة مساحة صاحب المولد." });
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر إنشاء طلب ترقية الباقة في Supabase." });
    }),
    requestAddon: protectedProcedure.input(siteScoped.extend({
      addonCode: z.enum(["fieldUser", "platformUser", "subscribers50", "branch", "sms"]),
      quantity: z.number().int().positive().max(10000000).default(1),
      note: z.string().trim().max(500).optional(),
    })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner"], "manageSubscribers");
      const { data, error } = await supabaseAdmin().rpc("powerhub_request_tenant_addon", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id,
        p_addon_code: input.addonCode, p_quantity: input.quantity, p_note: input.note ?? null,
      });
      if (!error && data?.[0]?.request_id) return { id: Number(data[0].request_id), addonCode: data[0].addon_code, quantity: Number(data[0].quantity), alreadyRequested: Boolean(data[0].already_requested) };
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر إرسال طلب الإضافة إلى إدارة المنصة." });
    }),
  }),
  subscriberPortal: router({
    list: publicProcedure.query(async () => {
      const { data, error } = await supabaseAdmin().rpc("powerhub_subscriber_portal_list");
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل بوابات المشتركين من Supabase." });
      return Promise.all(((data ?? []) as Array<{ portal_code: string; display_name: string | null; primary_color: string; accent_color: string; site_name: string; city: string | null; logo_key: string | null }>).map(async (portal) => ({
        portalCode: portal.portal_code,
        displayName: portal.display_name,
        primaryColor: portal.primary_color,
        accentColor: portal.accent_color,
        siteName: portal.site_name,
        city: portal.city,
        logoUrl: portal.logo_key ? await storageGetSignedUrl(portal.logo_key) : null,
      })));
    }),
    theme: publicProcedure.input(z.object({ portalCode: portalCodeInput })).query(async ({ input }) => {
      const portal = await getEnabledPortal(input.portalCode);
      return {
        portalCode: portal.portalCode,
        displayName: portal.displayName || portal.siteName,
        primaryColor: portal.primaryColor,
        accentColor: portal.accentColor,
        city: portal.city,
        logoUrl: portal.logoUrl,
      };
    }),
    lookup: publicProcedure.input(subscriberPortalLookupInput).query(async ({ input }) => {
      const { portal, subscriber, invoices: subscriberInvoices, payments: completedPayments } = await getVerifiedPortalSubscriber(input);
      const portalTenant = await supabaseAdmin().from("site_portal_settings").select("tenant_id").eq("portal_code", input.portalCode).eq("is_enabled", true).maybeSingle();
      if (portalTenant.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر التحقق من إعدادات بوابة الاستعلام." });
      let paymentDocumentationAvailable = false;
      if (portalTenant.data?.tenant_id) {
        const feature = await supabaseAdmin().rpc("powerhub_payment_documentation_access", { p_tenant_id: Number(portalTenant.data.tenant_id) });
        if (feature.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر التحقق من إتاحة توثيق الدفع." });
        paymentDocumentationAvailable = Boolean(feature.data?.[0]?.allowed);
      }
      const currentPeriod = new Date().toISOString().slice(0, 7);
      const currentInvoice = subscriberInvoices.find((invoice) => invoice.billingPeriod === currentPeriod);
      const outstandingBalance = subscriberInvoices.reduce((total, invoice) => total + Number(invoice.balanceDue || 0), 0);
      return {
        portal: {
          portalCode: portal.portalCode,
          displayName: portal.displayName,
          primaryColor: portal.primaryColor,
          accentColor: portal.accentColor,
          city: portal.city,
          logoUrl: portal.logoKey ? await storageGetSignedUrl(portal.logoKey) : null,
        },
        subscriber: {
          subscriberNo: subscriber.subscriberNo,
          fullName: subscriber.fullName,
          phone: subscriber.phone,
          address: subscriber.address,
          subscriptionType: subscriber.subscriptionType,
          serviceStatus: subscriber.serviceStatus,
          joinedAt: subscriber.joinedAt,
        },
        summary: {
          outstandingBalance,
          currentConsumptionKwh: Number(currentInvoice?.consumptionKwh || 0),
          currentInvoiceStatus: currentInvoice?.status || null,
          lastPayment: completedPayments[0] || null,
        },
        invoices: subscriberInvoices.map((invoice) => ({
          invoiceNo: invoice.invoiceNo,
          billingPeriod: invoice.billingPeriod,
          issueDate: invoice.issueDate,
          dueDate: invoice.dueDate,
          consumptionKwh: Number(invoice.consumptionKwh),
          totalAmount: Number(invoice.totalAmount),
          paidAmount: Number(invoice.paidAmount),
          balanceDue: Number(invoice.balanceDue),
          status: invoice.status,
        })),
        consumptionHistory: subscriberInvoices.slice(0, 6).reverse().map((invoice) => ({ period: invoice.billingPeriod, consumptionKwh: Number(invoice.consumptionKwh) })),
        payments: completedPayments.map((payment) => ({ ...payment, amount: Number(payment.amount) })),
        paymentDocumentationAvailable,
      };
    }),
    shareInvoice: publicProcedure.input(subscriberPortalLookupInput.extend({ invoiceNo: z.string().trim().min(1).max(60) })).mutation(async ({ input }) => {
      // The service-only database function revalidates the portal, normalized
      // subscriber phone, invoice scope, effective feature entitlement and
      // current outstanding balance before creating a public payment link.
      const token = generateInvoiceShareToken();
      const { data, error } = await supabaseAdmin().rpc("powerhub_create_portal_invoice_share_link", {
        p_portal_code: input.portalCode,
        p_subscriber_no: input.subscriberNo,
        p_phone: input.phone,
        p_invoice_no: input.invoiceNo,
        p_token_hash: hashInvoiceShareToken(token),
        p_token_preview: token.slice(0, 8),
      });
      if (!error && data?.[0]?.share_link_id) return { path: `/invoice/${token}` };
      const text = `${error?.code ?? ""} ${error?.message ?? ""}`;
      if (text.includes("PAYMENT_DOCUMENTATION_NOT_AVAILABLE")) {
        throw new TRPCError({ code: "FORBIDDEN", message: "ميزة توثيق الدفع الإلكتروني غير مفعلة لهذا الاشتراك." });
      }
      if (text.includes("INVOICE_ALREADY_PAID")) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "هذه الفاتورة مسددة بالكامل." });
      }
      if (text.includes("PORTAL_INVOICE_NOT_FOUND") || text.includes("PORTAL_NOT_AVAILABLE")) {
        throw new TRPCError({ code: "NOT_FOUND", message: "تعذر التحقق من الفاتورة أو بيانات المشترك." });
      }
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تجهيز رابط آمن لتوثيق الدفع." });
    }),
    invoice: publicProcedure.input(subscriberPortalLookupInput.extend({ invoiceNo: z.string().trim().min(1).max(60) })).query(async ({ input }) => {
      const { portal, subscriber, invoice, lines } = await getVerifiedPortalInvoice(input);
      return {
        portal,
        subscriber,
        invoice: {
          invoiceNo: invoice.invoiceNo,
          billingPeriod: invoice.billingPeriod,
          issueDate: invoice.issueDate,
          dueDate: invoice.dueDate,
          previousReading: Number(invoice.previousReading || 0),
          currentReading: Number(invoice.currentReading || 0),
          consumptionKwh: Number(invoice.consumptionKwh),
          pricePerKwh: Number(invoice.pricePerKwh),
          fixedFee: Number(invoice.fixedFee),
          taxAmount: Number(invoice.taxAmount),
          discountAmount: Number(invoice.discountAmount),
          totalAmount: Number(invoice.totalAmount),
          paidAmount: Number(invoice.paidAmount),
          balanceDue: Number(invoice.balanceDue),
          status: invoice.status,
        },
        lines: lines.map((line) => ({ ...line, quantity: Number(line.quantity), unitPrice: Number(line.unitPrice), amount: Number(line.amount) })),
      };
    }),
    settings: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner"]);
      const admin = supabaseAdmin();
      const [site, settingResult, logoAccessResult] = await Promise.all([
        getSupabaseSite(input.siteId),
        admin.from("site_portal_settings").select("site_id, tenant_id, portal_code, display_name, primary_color, accent_color, is_enabled, logo_key").eq("site_id", input.siteId).eq("tenant_id", access.tenantId).maybeSingle(),
        admin.rpc("powerhub_subscriber_portal_logo_access", { p_tenant_id: access.tenantId }),
      ]);
      if (settingResult.error || logoAccessResult.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل إعدادات بوابة المشتركين من Supabase." });
      const logoAccess = (logoAccessResult.data as Array<{ allowed: boolean; policy: string; package_code: string | null; entitlement_enabled: boolean }> | null)?.[0];
      const setting = settingResult.data;
      const logoUrl = setting?.logo_key && logoAccess?.allowed ? await storageGetSignedUrl(setting.logo_key) : null;
      return setting ? {
        siteId: Number(setting.site_id), tenantId: Number(setting.tenant_id), portalCode: setting.portal_code,
        displayName: setting.display_name, primaryColor: setting.primary_color, accentColor: setting.accent_color, isEnabled: setting.is_enabled,
        logoUrl, logoConfigured: Boolean(setting.logo_key), logoFeatureAllowed: Boolean(logoAccess?.allowed), logoPolicy: logoAccess?.policy ?? "not_included",
        packageCode: logoAccess?.package_code ?? null, logoEntitlementEnabled: Boolean(logoAccess?.entitlement_enabled),
      } : {
        siteId: site.id, tenantId: site.tenantId, portalCode: site.code.toLowerCase(), displayName: site.name,
        primaryColor: "#0D1117", accentColor: "#F5B800", isEnabled: true,
        logoUrl: null, logoConfigured: false, logoFeatureAllowed: Boolean(logoAccess?.allowed), logoPolicy: logoAccess?.policy ?? "not_included",
        packageCode: logoAccess?.package_code ?? null, logoEntitlementEnabled: Boolean(logoAccess?.entitlement_enabled),
      };
    }),
    uploadLogo: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(),
      logoData: z.string().min(100).max(4_500_000),
      logoMime: z.enum(["image/png", "image/jpeg", "image/webp"]),
    })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner"]);
      const admin = supabaseAdmin();
      const { data: featureData, error: featureError } = await admin.rpc("powerhub_subscriber_portal_logo_access", { p_tenant_id: access.tenantId });
      if (featureError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر التحقق من إتاحة ميزة شعار بوابة الاستعلام." });
      const feature = (featureData as Array<{ allowed: boolean; policy: string }> | null)?.[0];
      if (!feature?.allowed) throw new TRPCError({ code: "FORBIDDEN", message: feature?.policy === "addon" ? "ميزة الشعار إضافة غير مفعلة لهذا الاشتراك من إدارة المنصة." : "ميزة شعار بوابة الاستعلام غير متاحة ضمن اشتراكك الحالي." });
      const bytes = Buffer.from(input.logoData, "base64");
      if (!bytes.length || bytes.length > 3 * 1024 * 1024) throw new TRPCError({ code: "BAD_REQUEST", message: "يجب ألا يتجاوز حجم الشعار 3 ميغابايت." });
      const extension = input.logoMime === "image/png" ? "png" : input.logoMime === "image/jpeg" ? "jpg" : "webp";
      const uploaded = await storagePut(`tenant-portal-branding/${access.tenantId}/logo-${Date.now()}.${extension}`, bytes, input.logoMime);
      try {
        const { data, error } = await admin.rpc("powerhub_update_site_portal_logo", { p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id, p_logo_key: uploaded.key });
        if (error) throw error;
        const row = (data as Array<{ logo_key: string | null; previous_logo_key: string | null }> | null)?.[0];
        if (!row) throw new Error("EMPTY_LOGO_RESULT");
        if (row.previous_logo_key && row.previous_logo_key !== uploaded.key) await storageRemove(row.previous_logo_key).catch(() => undefined);
        return { success: true, logoUrl: await storageGetSignedUrl(uploaded.key) };
      } catch (error) {
        await storageRemove(uploaded.key).catch(() => undefined);
        const message = error instanceof Error ? error.message : "";
        if (message.includes("PORTAL_LOGO_FEATURE_NOT_ALLOWED")) throw new TRPCError({ code: "FORBIDDEN", message: "ميزة شعار بوابة الاستعلام غير متاحة ضمن اشتراكك الحالي." });
        if (message.includes("OWNER_ACCESS_REQUIRED")) throw new TRPCError({ code: "FORBIDDEN", message: "هذه العملية متاحة لمالك مساحة المولد فقط." });
        if (message.includes("SITE_OUT_OF_SCOPE")) throw new TRPCError({ code: "NOT_FOUND", message: "المحطة غير موجودة ضمن نطاقك." });
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر حفظ شعار بوابة الاستعلام." });
      }
    }),
    removeLogo: protectedProcedure.input(siteScoped).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner"]);
      const admin = supabaseAdmin();
      const { data, error } = await admin.rpc("powerhub_update_site_portal_logo", { p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id, p_logo_key: null });
      if (error) {
        if (error.message.includes("OWNER_ACCESS_REQUIRED")) throw new TRPCError({ code: "FORBIDDEN", message: "هذه العملية متاحة لمالك مساحة المولد فقط." });
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر إزالة شعار بوابة الاستعلام." });
      }
      const row = (data as Array<{ previous_logo_key: string | null }> | null)?.[0];
      if (row?.previous_logo_key) await storageRemove(row.previous_logo_key).catch(() => undefined);
      return { success: true };
    }),
    saveSettings: protectedProcedure.input(siteScoped.extend({
      portalCode: z.string().trim().min(2).max(50).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
      displayName: z.string().trim().min(2).max(160),
      primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      isEnabled: z.boolean(),
    })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner"]);
      const { data, error } = await supabaseAdmin().rpc("powerhub_save_site_portal_settings", {
        p_tenant_id: access.tenantId,
        p_site_id: input.siteId,
        p_user_id: ctx.user.id,
        p_portal_code: input.portalCode,
        p_display_name: input.displayName,
        p_primary_color: input.primaryColor,
        p_accent_color: input.accentColor,
        p_is_enabled: input.isEnabled,
      });
      if (error) {
        if (error.message.includes("PORTAL_CODE_CONFLICT")) throw new TRPCError({ code: "CONFLICT", message: "رمز الرابط مستخدم لمولد آخر. اختر رمزاً مختلفاً." });
        if (error.message.includes("SITE_OUT_OF_SCOPE")) throw new TRPCError({ code: "NOT_FOUND", message: "المحطة غير موجودة ضمن نطاقك." });
        if (error.message.includes("INVALID_PORTAL_SETTINGS")) throw new TRPCError({ code: "BAD_REQUEST", message: "إعدادات بوابة المشتركين غير صالحة." });
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر حفظ إعدادات بوابة المشتركين في Supabase." });
      }
      const portalCode = (data as Array<{ portal_code: string }> | null)?.[0]?.portal_code;
      if (!portalCode) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "لم تُعد دالة البوابة رمز الرابط المحفوظ." });
      return { success: true, portalCode };
    }),
  }),
  sites: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      return listSupabaseAccessibleSites(ctx.user.id, isActivePlatformAdmin(ctx.user));
    }),
    branchPolicy: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      const access=await requireSupabaseSiteRole(ctx.user.id,input.siteId,["owner"]);
      const admin=supabaseAdmin();
      const [subscription,platformSetting,tenantSetting,branchRows]=await Promise.all([
        admin.from("tenant_subscriptions").select("package_code").eq("tenant_id",access.tenantId).maybeSingle(),
        admin.from("platform_settings").select("is_enabled, value").eq("setting_key","branch_feature").maybeSingle(),
        admin.from("tenant_branch_settings").select("is_enabled_override, max_branches_override, disabled_behavior").eq("tenant_id",access.tenantId).maybeSingle(),
        admin.from("sites").select("id").eq("tenant_id",access.tenantId).neq("status","archived"),
      ]);
      if(subscription.error||platformSetting.error||tenantSetting.error||branchRows.error) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"تعذر تحميل سياسة الفروع من Supabase."});
      return resolveBranchPolicy({plan:(subscription.data?.package_code??"basic") as SubscriptionPlan,platformSetting:platformSetting.data?{isEnabled:platformSetting.data.is_enabled,value:platformSetting.data.value}:null,tenantSetting:tenantSetting.data?{isEnabledOverride:tenantSetting.data.is_enabled_override,maxBranchesOverride:tenantSetting.data.max_branches_override,disabledBehavior:tenantSetting.data.disabled_behavior as "read_only"|"suspended"}:null,currentCount:(branchRows.data??[]).length});
    }),
    create: protectedProcedure.input(siteInput).mutation(async ({ ctx, input }) => {
      const admin=supabaseAdmin();
      const {data:membership,error:membershipError}=await admin.from("tenant_members").select("tenant_id, role").eq("user_id",ctx.user.id).eq("is_active",true).eq("membership_status","active").eq("role","owner").maybeSingle();
      if(membershipError) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"تعذر التحقق من عضوية مالك المولد في Supabase."});
      if(!membership) throw new TRPCError({code:"FORBIDDEN",message:"إنشاء فرع جديد متاح لصاحب مولد لديه مساحة نشطة فقط."});
      const {data,error}=await admin.rpc("powerhub_create_site",{p_tenant_id:Number(membership.tenant_id),p_user_id:ctx.user.id,p_name:input.name,p_code:input.code,p_city:input.city??null,p_address:input.address??null});
      if(error) throw new TRPCError({code:error.message.includes("FEATURE_DISABLED")?"FORBIDDEN":error.message.includes("LIMIT_REACHED")?"PRECONDITION_FAILED":"BAD_REQUEST",message:error.message.includes("FEATURE_DISABLED")?"ميزة تعدد الأفرع غير مفعّلة لحسابك من إدارة المنصة.":error.message.includes("LIMIT_REACHED")?"وصلت إلى الحد الأقصى للأفرع في اشتراكك.":"تعذر إنشاء الفرع في Supabase."});
      const id=Number((data as Array<{site_id:number}>|null)?.[0]?.site_id); if(!id) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"لم تُعد دالة الفروع استجابة صالحة."}); return {id};
    }),
    anomalyAlert: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "collector", "viewer"]);
      const { data, error } = await supabaseAdmin().from("sites")
        .select("anomaly_alert_percent")
        .eq("id", input.siteId)
        .eq("tenant_id", access.tenantId)
        .maybeSingle();
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل إعداد تنبيه الاستهلاك الشاذ من Supabase." });
      if (!data) throw new TRPCError({ code: "NOT_FOUND", message: "الفرع غير موجود." });
      return { anomalyAlertPercent: Number(data.anomaly_alert_percent) };
    }),
    updateAnomalyAlert: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), anomalyAlertPercent: z.number().int().min(10).max(500) })).mutation(async ({ ctx, input }) => {
      const access=await requireSupabaseSiteRole(ctx.user.id,input.siteId,["owner"]);
      const {data,error}=await supabaseAdmin().rpc("powerhub_update_site_anomaly",{p_tenant_id:access.tenantId,p_site_id:input.siteId,p_user_id:ctx.user.id,p_anomaly_alert_percent:input.anomalyAlertPercent});
      if(error || !Number((data as Array<{site_id:number}>|null)?.[0]?.site_id)) throw new TRPCError({code:error?.message.includes("OUT_OF_SCOPE")?"NOT_FOUND":"BAD_REQUEST",message:"تعذر تحديث نسبة تنبيه الاستهلاك الشاذ."});
      return { success: true, anomalyAlertPercent: input.anomalyAlertPercent };
    }),
    invoiceDuePolicy: router({
      get: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
        const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner"]);
        const { data, error } = await supabaseAdmin().from("sites")
          .select("invoice_due_hours, invoice_due_days")
          .eq("tenant_id", access.tenantId).eq("id", input.siteId).maybeSingle();
        if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل مدة استحقاق الفاتورة." });
        if (!data) throw new TRPCError({ code: "NOT_FOUND", message: "الفرع غير موجود ضمن مساحة الحساب." });
        const dueHours = Number(data.invoice_due_hours ?? Math.max(1, Math.min(2160, Number(data.invoice_due_days ?? 14) * 24)));
        return { invoiceDueHours: dueHours, invoiceDueDays: Number(data.invoice_due_days ?? Math.ceil(dueHours / 24)) };
      }),
      save: protectedProcedure.input(siteScoped.extend({ invoiceDueHours: z.number().int().min(1).max(2160) })).mutation(async ({ ctx, input }) => {
        const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner"]);
        const { data, error } = await supabaseAdmin().rpc("powerhub_save_site_invoice_due_hours", {
          p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id, p_invoice_due_hours: input.invoiceDueHours,
        });
        const row = Array.isArray(data) ? data[0] : data;
        if (error || !Number(row?.invoice_due_hours)) {
          const message = String(error?.message ?? "");
          if (message.includes("SITE_OUT_OF_SCOPE")) throw new TRPCError({ code: "NOT_FOUND", message: "الفرع غير موجود ضمن مساحة الحساب." });
          if (message.includes("INVALID_INVOICE_DUE_HOURS")) throw new TRPCError({ code: "BAD_REQUEST", message: "مدة الاستحقاق يجب أن تكون بين ساعة و90 يومًا." });
          if (message.includes("INVOICE_DUE_POLICY_PERMISSION_REQUIRED")) throw new TRPCError({ code: "FORBIDDEN", message: "لا تملك صلاحية تعديل مدة استحقاق الفاتورة." });
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر حفظ مدة استحقاق الفاتورة." });
        }
        const savedHours = Number(row.invoice_due_hours);
        return { success: true, invoiceDueHours: savedHours, invoiceDueDays: Math.ceil(savedHours / 24) };
      }),
    }),
    updateBranch: protectedProcedure.input(siteInput.pick({ name: true, city: true, address: true }).extend({ siteId: z.number().int().positive(), status: z.enum(["active", "inactive", "archived"]), invoiceDueDays: z.number().int().min(1).max(90).optional() })).mutation(async ({ ctx, input }) => {
      const access=await requireSupabaseSiteRole(ctx.user.id,input.siteId,["owner"]);
      let invoiceDueDays = input.invoiceDueDays;
      if (invoiceDueDays == null) {
        const { data: current, error: currentError } = await supabaseAdmin().from("sites").select("invoice_due_days").eq("tenant_id", access.tenantId).eq("id", input.siteId).maybeSingle();
        if (currentError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل إعدادات الفرع قبل التحديث." });
        if (!current) throw new TRPCError({ code: "NOT_FOUND", message: "الفرع غير موجود ضمن مساحة الحساب." });
        invoiceDueDays = Number(current.invoice_due_days ?? 14);
      }
      const {data,error}=await supabaseAdmin().rpc("powerhub_update_site",{p_tenant_id:access.tenantId,p_site_id:input.siteId,p_user_id:ctx.user.id,p_name:input.name,p_city:input.city??"",p_address:input.address??"",p_status:input.status,p_invoice_due_days:invoiceDueDays});
      if(error || !Number((data as Array<{site_id:number}>|null)?.[0]?.site_id)) throw new TRPCError({code:error?.message.includes("OUT_OF_SCOPE")?"NOT_FOUND":"BAD_REQUEST",message:"تعذر تحديث بيانات الفرع."});
      return { success: true };
    }),
  }),

  subscribers: router({
    list: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "collector", "viewer"]);
      return listSupabaseSubscribers(input.siteId);
    }),
    directoryPage: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(),
      page: z.number().int().min(1).default(1),
      pageSize: z.number().int().min(1).max(25).default(20),
      search: z.string().trim().max(160).optional(),
      subscriptionType: z.enum(["residential", "commercial", "institution", "mosque"]).optional(),
    })).query(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "collector", "viewer"]);
      return listSupabaseSubscriberDirectoryPage({ ...input, tenantId: access.tenantId });
    }),
    archived: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "collector", "viewer"]);
      const { data, error } = await supabaseAdmin().from("subscribers")
        .select("id, tenant_id, site_id, subscriber_no, full_name, phone, whatsapp_number, address, subscription_type, service_status, archived_at, purge_after_at, created_at, updated_at")
        .eq("tenant_id", access.tenantId).eq("site_id", input.siteId).not("archived_at", "is", null)
        .order("archived_at", { ascending: false });
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل المشتركين المؤرشفين." });
      return (data ?? []).map((row) => ({
        id: Number(row.id), tenantId: Number(row.tenant_id), siteId: Number(row.site_id), subscriberNo: row.subscriber_no,
        fullName: row.full_name, phone: row.phone, whatsappNumber: row.whatsapp_number, address: row.address,
        subscriptionType: row.subscription_type, serviceStatus: row.service_status, archivedAt: new Date(row.archived_at as string),
        purgeAfterAt: row.purge_after_at ? new Date(row.purge_after_at) : null, createdAt: new Date(row.created_at), updatedAt: new Date(row.updated_at),
      }));
    }),
    lifecycle: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(),
      subscriberId: z.number().int().positive(),
      action: z.enum(["suspend","activate","archive","restore"]),
      clientOperationId: z.string().uuid().optional(),
    })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner","manager","accountant"], "manageSubscribers");
      const { data, error } = await supabaseAdmin().rpc("powerhub_change_subscriber_lifecycle", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id,
        p_subscriber_id: input.subscriberId, p_action: input.action, p_client_operation_id: input.clientOperationId ?? null,
      });
      if (!error && data?.[0]) return {
        subscriberId: Number(data[0].subscriber_id), action: data[0].action, serviceStatus: data[0].service_status,
        archivedAt: data[0].archived_at ? new Date(data[0].archived_at) : null,
        purgeAfterAt: data[0].purge_after_at ? new Date(data[0].purge_after_at) : null,
        replayed: Boolean(data[0].replayed),
      };
      const message = String(error?.message ?? "");
      if (message.includes("SUBSCRIBER_QUOTA_REACHED")) throw new TRPCError({ code:"PRECONDITION_FAILED", message:"لا توجد سعة متاحة في الحصة لاستعادة المشترك." });
      if (message.includes("SUBSCRIBER_ALREADY_ARCHIVED")) throw new TRPCError({ code:"CONFLICT", message:"المشترك مؤرشف بالفعل." });
      if (message.includes("SUBSCRIBER_NOT_ARCHIVED")) throw new TRPCError({ code:"CONFLICT", message:"المشترك ليس مؤرشفة." });
      if (message.includes("SUBSCRIBER_ARCHIVED")) throw new TRPCError({ code:"PRECONDITION_FAILED", message:"المشترك مؤرشف ولا يقبل هذه العملية." });
      if (message.includes("SUBSCRIBER_PURGE_IN_PROGRESS")) throw new TRPCError({ code:"CONFLICT", message:"بدأت عملية الحذف النهائي لهذا المشترك؛ لا يمكن تغيير حالته الآن." });
      if (message.includes("SUBSCRIBER_OUT_OF_SCOPE")) throw new TRPCError({ code:"NOT_FOUND", message:"المشترك غير موجود ضمن الفرع المحدد." });
      throw new TRPCError({ code:"INTERNAL_SERVER_ERROR", message:"تعذر تغيير دورة حياة المشترك." });
    }),
    accountStatement: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(),
      subscriberId: z.number().int().positive(),
    })).query(async ({ ctx, input }) => {
      await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "collector", "viewer"]);
      return getSupabaseSubscriberAccountStatement(input.siteId, input.subscriberId);
    }),
    quota: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "collector", "viewer"]);
      // Use one quota-summary RPC rather than three serial-independent PostgREST queries.
      // The helper retains a narrow compatibility fallback if the new RPC migration
      // is not yet installed; the create RPC remains the atomic enforcement point.
      return getSupabaseOwnerSubscriberQuota(access.tenantId);
    }),
    create: protectedProcedure.input(siteInput.pick({ code: true }).extend({
      siteId: z.number().int().positive(),
      fullName: z.string().min(2).max(180),
      phone: z.string().min(5).max(30),
      whatsappNumber: z.string().min(5).max(30).optional(),
      address: z.string().max(1000).optional(),
      subscriptionType: z.enum(["residential", "commercial", "institution", "mosque"]).default("residential"),
      clientOperationId: z.string().uuid().optional(),
      offlineNumberClaim: z.object({
        grantId: z.string().uuid(),
        deviceId: z.string().uuid(),
        numberValue: z.string().regex(/^[1-9][0-9]{0,5}$/),
        partitionKey: z.literal("global"),
        formattedNumber: z.string().regex(/^SUB-\d{6}$/),
      }).optional(),
      openingReading: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
      openingReadingAt: z.string().trim().optional().refine((value) => !value || !Number.isNaN(Date.parse(value)), "تاريخ القراءة الافتتاحية غير صالح."),
      openingReadingApproved: z.boolean().default(false),
      openingReadingImageData: z.string().optional(),
      openingReadingImageMime: z.enum(["image/jpeg", "image/png", "image/webp"]).optional(),
    }).omit({ code: true })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, createRoles, "manageSubscribers");
      const admin = supabaseAdmin();
      // Opening readings establish a baseline and are approved immediately; they do not issue consumption invoices.
      if (input.clientOperationId && !input.offlineNumberClaim) {
        const { data: applied, error: appliedError } = await admin.from("offline_sync_operations")
          .select("tenant_id, site_id, entity_type, operation_type, response")
          .eq("user_id", ctx.user.id).eq("client_operation_id", input.clientOperationId).maybeSingle();
        if (appliedError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر التحقق من مفتاح المزامنة في Supabase." });
        if (applied) {
          if (Number(applied.tenant_id) !== access.tenantId ||
              Number(applied.site_id) !== input.siteId ||
              applied.entity_type !== "subscriber") {
            throw new TRPCError({ code: "CONFLICT", message: "معرّف عملية المزامنة مستخدم ضمن مستأجر أو فرع مختلف." });
          }
          if (applied.operation_type !== "subscriber_create") throw new TRPCError({ code: "CONFLICT", message: "مفتاح عملية المزامنة مستخدم لنوع عملية مختلف." });
          const previous = applied.response as { id: number; subscriberNo: string; referenceNotifications: Array<{ notificationId: number; status: string; error?: string }> };
          return { ...previous, replayed: true };
        }
      }
      const quota = await getSupabaseOwnerSubscriberQuota(access.tenantId);
      if (!input.offlineNumberClaim && quota.currentCount >= quota.limit) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `وصلت إلى الحد الأقصى للمشتركين في باقتك (${quota.limit}). تواصل مع إدارة المنصة لترقية الاشتراك.` });
      const phone = normalizeInternationalPhone(input.phone);
      const whatsappNumber = input.whatsappNumber ? normalizeInternationalPhone(input.whatsappNumber) : undefined;
      if (input.openingReadingImageData && !input.openingReadingImageMime) throw new TRPCError({ code: "BAD_REQUEST", message: "تعذر تحديد نوع صورة القراءة الافتتاحية." });
      if (!input.openingReading && (input.openingReadingImageData || input.openingReadingApproved || input.openingReadingAt)) throw new TRPCError({ code: "BAD_REQUEST", message: "أدخل قيمة القراءة الافتتاحية قبل إضافة صورتها أو اعتمادها." });
      if (input.offlineNumberClaim) {
        const claim = input.offlineNumberClaim;
        if (!input.clientOperationId || input.openingReading || input.openingReadingAt || input.openingReadingApproved || input.openingReadingImageData || input.openingReadingImageMime) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن الجمع بين رقم محجوز دون اتصال وقراءة افتتاحية أو صورة؛ أنشئ المشترك متصلاً لتسجيل القراءة." });
        }
        const rawDeviceId = ctx.req?.headers?.["x-powerhub-device-id"];
        const headerDeviceId = Array.isArray(rawDeviceId) ? rawDeviceId[0] : rawDeviceId;
        if (typeof headerDeviceId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(headerDeviceId) || headerDeviceId.toLowerCase() !== claim.deviceId.toLowerCase()) {
          throw new TRPCError({ code: "FORBIDDEN", message: "مطالبة الرقم المحجوز لا تخص جهاز PowerHub الحالي." });
        }
        const expectedNumber = `SUB-${claim.numberValue.padStart(6, "0")}`;
        if (claim.formattedNumber !== expectedNumber) throw new TRPCError({ code: "BAD_REQUEST", message: "صيغة الرقم المحلي المحجوز غير مطابقة." });
        const { data, error } = await admin.rpc("powerhub_create_subscriber_with_offline_number", {
          p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id,
          p_device_id: headerDeviceId, p_grant_id: claim.grantId, p_number_value: claim.numberValue,
          p_full_name: input.fullName.trim(), p_phone: phone, p_whatsapp_number: whatsappNumber ?? "",
          p_address: input.address?.trim() ?? "", p_subscription_type: input.subscriptionType,
          p_client_operation_id: input.clientOperationId,
        });
        if (!error && data?.[0]) {
          const row = data[0] as { subscriber_id: number | string; subscriber_no: string; replayed: boolean };
          const response = { id: Number(row.subscriber_id), subscriberNo: row.subscriber_no, referenceNotifications: [] as Array<{ notificationId: number; status: string; error?: string }>, replayed: Boolean(row.replayed) };
          if (!row.replayed) {
            try { await recordSupabaseSubscriberQuotaAlert({ tenantId: access.tenantId, siteId: input.siteId, userId: ctx.user.id, quota: { ...quota, currentCount: quota.currentCount + 1, remaining: Math.max(0, quota.remaining - 1) } }); }
            catch (alertError) { console.error("[PowerHub] subscriber quota alert failed after offline creation", alertError); }
          }
          return response;
        }
        const errorText = `${error?.code ?? ""} ${error?.message ?? ""}`;
        if (errorText.includes("SUBSCRIBER_QUOTA_REACHED")) {
          try { await recordSupabaseSubscriberQuotaAlert({ tenantId: access.tenantId, siteId: input.siteId, userId: ctx.user.id, quota, blockedAttempt: true }); }
          catch (alertError) { console.error("[PowerHub] offline quota blocked-attempt alert failed", alertError); }
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: `وصلت إلى الحد الأقصى للمشتركين في باقتك (${quota.limit}). لا يمكن اعتماد المسودة قبل إضافة سعة أو ترقية الباقة.` });
        }
        if (errorText.includes("SITE_OUT_OF_SCOPE")) throw new TRPCError({ code: "FORBIDDEN", message: "المحطة لا تتبع لمساحة صاحب المولد الحالية." });
        if (errorText.includes("OFFLINE_NUMBER_IDEMPOTENCY_MISMATCH") || errorText.includes("OFFLINE_NUMBER_ALREADY_CLAIMED") || errorText.includes("OFFLINE_NUMBER_CLAIM_MISSING")) {
          throw new TRPCError({ code: "CONFLICT", message: "تعارض الرقم المحجوز مع عملية أخرى؛ أوقفنا المزامنة لمنع تكرار الرقم أو أثره." });
        }
        if (errorText.includes("OFFLINE_NUMBER_") || errorText.includes("OFFLINE_SUBSCRIBER_INPUT_INVALID")) {
          throw new TRPCError({ code: "CONFLICT", message: "لم تعد مطالبة الرقم المحلي صالحة. احتفظنا بالمسودة للمراجعة ولم نعتمدها." });
        }
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر اعتماد مسودة المشترك ذات الرقم المحجوز في Supabase." });
      }
      let openingImageKey: string | undefined;
      let openingImageHash: string | undefined;
      if (input.openingReadingImageData && input.openingReadingImageMime) {
        const imageBytes = Buffer.from(input.openingReadingImageData, "base64");
        if (!imageBytes.length || imageBytes.byteLength > 7 * 1024 * 1024) throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: "يجب ألا تتجاوز صورة القراءة الافتتاحية 7 ميغابايت." });
        openingImageHash = createHash("sha256").update(imageBytes).digest("hex");
        const extension = input.openingReadingImageMime === "image/png" ? "png" : input.openingReadingImageMime === "image/webp" ? "webp" : "jpg";
        openingImageKey = (await storagePut(`subscriber-readings/${access.tenantId}/${input.siteId}/${ctx.user.id}/${randomUUID()}.${extension}`, imageBytes, input.openingReadingImageMime)).key;
      }
      const hasOpeningReading = Boolean(input.openingReading || openingImageKey);
      const rpcName = hasOpeningReading ? "powerhub_create_subscriber_with_opening_reading" : "powerhub_create_subscriber";
      const rpcArgs = hasOpeningReading ? {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id,
        p_full_name: input.fullName.trim(), p_phone: phone, p_whatsapp_number: whatsappNumber ?? "", p_address: input.address?.trim() ?? "",
        p_subscription_type: input.subscriptionType, p_client_operation_id: input.clientOperationId ?? null, p_quota_limit: quota.limit,
        p_opening_reading: input.openingReading ? Number(input.openingReading) : null, p_opening_reading_at: input.openingReadingAt ? new Date(input.openingReadingAt).toISOString() : null,
        p_opening_image_key: openingImageKey ?? null, p_opening_image_hash: openingImageHash ?? null, p_opening_reading_approved: Boolean(input.openingReading),
      } : {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id,
        p_full_name: input.fullName.trim(), p_phone: phone, p_whatsapp_number: whatsappNumber ?? "", p_address: input.address?.trim() ?? "",
        p_subscription_type: input.subscriptionType, p_client_operation_id: input.clientOperationId ?? null, p_quota_limit: quota.limit,
      };
      const { data, error } = await admin.rpc(rpcName, rpcArgs);
      if (error && openingImageKey) await storageRemove(openingImageKey).catch(() => undefined);
      if (!error && data?.[0]) {
        const row = data[0] as { subscriber_id: number | string; subscriber_no: string; opening_reading_id?: number | string | null; opening_reading_status?: string | null; replayed: boolean };
        let openingReadingId = row.opening_reading_id ? Number(row.opening_reading_id) : undefined;
        let openingReadingStatus = row.opening_reading_status ?? undefined;
        if (row.replayed && !openingReadingId) {
          const { data: replayReading } = await admin
            .from("meter_readings")
            .select("id,status")
            .eq("tenant_id", access.tenantId)
            .eq("subscriber_id", Number(row.subscriber_id))
            .eq("is_opening_baseline", true)
            .order("reading_at", { ascending: true })
            .limit(1)
            .maybeSingle();
          openingReadingId = replayReading?.id ? Number(replayReading.id) : undefined;
          openingReadingStatus = replayReading?.status ?? openingReadingStatus;
        }
        const response = { id: Number(row.subscriber_id), subscriberNo: row.subscriber_no, referenceNotifications: [] as Array<{ notificationId: number; status: string; error?: string }>, replayed: Boolean(row.replayed) };
        if (!row.replayed) {
          try { await recordSupabaseSubscriberQuotaAlert({ tenantId: access.tenantId, siteId: input.siteId, userId: ctx.user.id, quota: { ...quota, currentCount: quota.currentCount + 1, remaining: Math.max(0, quota.remaining - 1) } }); } catch (alertError) { console.error("[PowerHub] subscriber quota alert failed after successful creation", alertError); }
        }
        return openingReadingId ? { ...response, openingReadingId, openingReadingStatus } : response;
      }
      const errorText = `${error?.code ?? ""} ${error?.message ?? ""}`;
      if (errorText.includes("SUBSCRIBER_QUOTA_REACHED")) {
        try {
          await recordSupabaseSubscriberQuotaAlert({ tenantId: access.tenantId, siteId: input.siteId, userId: ctx.user.id, quota, blockedAttempt: true });
        } catch (alertError) {
          console.error("[PowerHub] subscriber quota blocked-attempt alert failed", alertError);
        }
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: `وصلت إلى الحد الأقصى للمشتركين في باقتك (${quota.limit}). لا يمكن إضافة مشترك جديد قبل إضافة سعة أو ترقية الباقة.` });
      }
      if (errorText.includes("SITE_OUT_OF_SCOPE")) throw new TRPCError({ code: "FORBIDDEN", message: "المحطة لا تتبع لمساحة صاحب المولد الحالية." });
      if (errorText.includes("INVALID_SUBSCRIBER_PHONE")) throw new TRPCError({ code: "BAD_REQUEST", message: "رقم الهاتف مطلوب وصالح." });
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر إنشاء المشترك في Supabase." });
    }),
    bulkImport: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(),
      clientOperationId: z.string().uuid().optional(),
      updateExisting: z.boolean().default(false),
      rows: z.array(z.object({
        sourceRow: z.number().int().min(2),
        subscriberNo: z.string().trim().max(80).optional(),
        fullName: z.string().trim().max(300),
        phone: z.string().trim().max(60),
        whatsappNumber: z.string().trim().max(60).optional(),
        address: z.string().trim().max(1500).optional(),
        subscriptionType: z.enum(["residential", "commercial", "institution", "mosque"]),
        openingReading: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
        openingReadingAt: z.string().datetime().optional(),
      })).min(1).max(300),
      approveOpeningReadings: z.boolean().default(false),
    })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, createRoles, "manageSubscribers");
      const quota = await getSupabaseOwnerSubscriberQuota(access.tenantId);
      // Opening readings are baseline values, so approve them for every authorized subscriber import.
      const failureRows: Array<{ sourceRow: number; fullName: string; reason: string }> = [];
      const seenPhones = new Set<string>();
      const seenReferences = new Set<string>();
      const accepted: Array<{ sourceRow: number; subscriberNo?: string; fullName: string; phone: string; whatsappNumber?: string; address?: string; subscriptionType: "residential" | "commercial" | "institution" | "mosque"; openingReading?: string; openingReadingAt?: string; openingReadingApproved?: boolean }> = [];
      for (const row of input.rows) {
        if (!row.openingReading && row.openingReadingAt) { failureRows.push({ sourceRow: row.sourceRow, fullName: row.fullName, reason: "أدخل قيمة القراءة الافتتاحية قبل تحديد تاريخها." }); continue; }
        if (row.fullName.trim().length < 2) { failureRows.push({ sourceRow: row.sourceRow, fullName: row.fullName, reason: "الاسم الكامل قصير جداً." }); continue; }
        let phone: string;
        try { phone = normalizeInternationalPhone(row.phone); } catch { failureRows.push({ sourceRow: row.sourceRow, fullName: row.fullName, reason: "رقم الجوال غير صالح؛ استخدم رمز الدولة مثل +970." }); continue; }
        let whatsappNumber: string | undefined;
        try { whatsappNumber = row.whatsappNumber ? normalizeInternationalPhone(row.whatsappNumber) : undefined; } catch { failureRows.push({ sourceRow: row.sourceRow, fullName: row.fullName, reason: "رقم واتساب غير صالح؛ اتركه فارغاً أو استخدم رمز الدولة مثل +970." }); continue; }
        if (seenPhones.has(phone)) { failureRows.push({ sourceRow: row.sourceRow, fullName: row.fullName, reason: "رقم الجوال مكرر داخل ملف الاستيراد." }); continue; }
        seenPhones.add(phone);
        const subscriberNo = input.updateExisting ? row.subscriberNo?.replace(/\s+/g, "").toUpperCase() : undefined;
        if (subscriberNo) {
          if (!/^[A-Z0-9][A-Z0-9_-]{1,79}$/.test(subscriberNo)) { failureRows.push({ sourceRow: row.sourceRow, fullName: row.fullName, reason: "الرقم المرجعي غير صالح." }); continue; }
          if (seenReferences.has(subscriberNo)) { failureRows.push({ sourceRow: row.sourceRow, fullName: row.fullName, reason: "الرقم المرجعي مكرر داخل ملف الاستيراد." }); continue; }
          seenReferences.add(subscriberNo);
        }
        accepted.push({ sourceRow: row.sourceRow, subscriberNo, fullName: row.fullName.trim(), phone, whatsappNumber, address: row.address?.trim() || undefined, subscriptionType: row.subscriptionType, openingReading: row.openingReading, openingReadingAt: row.openingReadingAt, openingReadingApproved: Boolean(row.openingReading) });
      }
      if (!accepted.length) return { created: [], updated: [], failed: failureRows.sort((a, b) => a.sourceRow - b.sourceRow), notificationsQueued: 0, message: "لا توجد صفوف صالحة للحفظ." };
      const clientOperationId = input.clientOperationId ?? randomUUID();
      const requestFingerprint = createHash("sha256").update(JSON.stringify({ siteId: input.siteId, updateExisting: input.updateExisting, openingReadingsAutoApproved: true, rows: input.rows })).digest("hex");
      const { data, error } = await supabaseAdmin().rpc("powerhub_bulk_upsert_subscribers", {
        p_tenant_id: access.tenantId,
        p_site_id: input.siteId,
        p_user_id: ctx.user.id,
        p_rows: accepted,
        p_update_existing: input.updateExisting,
        p_quota_limit: quota.limit,
        p_client_operation_id: clientOperationId,
        p_request_fingerprint: requestFingerprint,
      });
      if (error) {
        const errorText = String(error?.code ?? "") + " " + String(error?.message ?? "");
        if (errorText.includes("SITE_OUT_OF_SCOPE")) throw new TRPCError({ code: "FORBIDDEN", message: "المحطة لا تتبع لمساحة صاحب المولد الحالية." });
        if (errorText.includes("INVALID_BULK_ROWS") || errorText.includes("INVALID_OPERATION_ID") || errorText.includes("INVALID_REQUEST_FINGERPRINT")) throw new TRPCError({ code: "BAD_REQUEST", message: "بيانات عملية الاستيراد الجماعي غير صالحة؛ أعد المحاولة." });
        if (errorText.includes("OPERATION_CONFLICT")) throw new TRPCError({ code: "CONFLICT", message: "مفتاح عملية الاستيراد مستخدم لطلب مختلف." });
        if (error?.code === "23505") throw new TRPCError({ code: "CONFLICT", message: "يوجد رقم مرجعي مكرر في الملف أو قاعدة البيانات. عدّل الملف وأعد المحاولة." });
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر حفظ الاستيراد الجماعي في Supabase." });
      }
      const row = (data as Array<{ created?: unknown; updated?: unknown; failed?: unknown; replayed?: boolean }> | null)?.[0];
      const created = Array.isArray(row?.created) ? row.created : [];
      const updated = Array.isArray(row?.updated) ? row.updated : [];
      const failed = [...failureRows, ...(Array.isArray(row?.failed) ? row.failed : [])].sort((a, b) => Number(a.sourceRow) - Number(b.sourceRow));
      if (created.length && !row?.replayed) {
        try { await recordSupabaseSubscriberQuotaAlert({ tenantId: access.tenantId, siteId: input.siteId, userId: ctx.user.id, quota: { ...quota, currentCount: quota.currentCount + created.length, remaining: Math.max(0, quota.remaining - created.length) } }); } catch (alertError) { console.error("[PowerHub] subscriber bulk quota alert failed after successful import", alertError); }
      }
      return { created, updated, failed, notificationsQueued: 0, message: row?.replayed ? "تمت إعادة نتيجة استيراد جماعي سابقة بأمان دون إعادة إنشاء المشتركين." : "تم حفظ الاستيراد الجماعي ذرياً في Supabase دون إرسال رسائل تلقائية." };
    }),
    update: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(), id: z.number().int().positive(), fullName: z.string().min(2).max(180), phone: z.string().min(5).max(30),
      address: z.string().max(1000).optional(), subscriptionType: z.enum(["residential", "commercial", "institution", "mosque"]), serviceStatus: z.enum(["active", "suspended", "disconnected"]),
      clientOperationId: z.string().uuid().optional(), expectedUpdatedAt: z.date().optional(),
    })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "manageSubscribers");
      const admin = supabaseAdmin();
      if (input.clientOperationId) {
        const { data: applied, error: appliedError } = await admin.from("offline_sync_operations")
          .select("tenant_id, site_id, entity_type, operation_type, response")
          .eq("user_id", ctx.user.id).eq("client_operation_id", input.clientOperationId).maybeSingle();
        if (appliedError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر التحقق من مفتاح المزامنة في Supabase." });
        if (applied) {
          if (Number(applied.tenant_id) !== access.tenantId ||
              Number(applied.site_id) !== input.siteId ||
              applied.entity_type !== "subscriber") {
            throw new TRPCError({ code: "CONFLICT", message: "معرّف عملية المزامنة مستخدم ضمن مستأجر أو فرع مختلف." });
          }
          if (applied.operation_type !== "subscriber_update") throw new TRPCError({ code: "CONFLICT", message: "مفتاح عملية المزامنة مستخدم لنوع عملية مختلف." });
          const response = applied.response as { success: true; updatedAt: string | Date };
          return { success: true as const, updatedAt: new Date(response.updatedAt), replayed: true };
        }
      }
      const phone = normalizeInternationalPhone(input.phone);
      const { data, error } = await admin.rpc("powerhub_update_subscriber", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id, p_subscriber_id: input.id,
        p_full_name: input.fullName.trim(), p_phone: phone, p_address: input.address?.trim() ?? "", p_subscription_type: input.subscriptionType,
        p_service_status: input.serviceStatus, p_expected_updated_at: input.expectedUpdatedAt?.toISOString() ?? null,
        p_client_operation_id: input.clientOperationId ?? null,
      });
      if (!error && data?.[0]) {
        const row = data[0] as { updated_at: string; replayed: boolean };
        return { success: true as const, updatedAt: new Date(row.updated_at), replayed: Boolean(row.replayed) };
      }
      const errorText = `${error?.code ?? ""} ${error?.message ?? ""}`;
      if (errorText.includes("SUBSCRIBER_OUT_OF_SCOPE")) throw new TRPCError({ code: "NOT_FOUND", message: "المشترك غير موجود ضمن المحطة المحددة." });
      if (errorText.includes("SUBSCRIBER_VERSION_CONFLICT")) throw new TRPCError({ code: "CONFLICT", message: "تغيرت بيانات المشترك على الخادم منذ حفظ هذه المسودة. راجع التعارض ثم أعد المحاولة." });
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحديث المشترك في Supabase." });
    }),
    phoneReview: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner"], "manageSubscribers");
      const { data, error } = await supabaseAdmin().from("subscribers").select("id, subscriber_no, full_name, phone").eq("tenant_id", access.tenantId).eq("site_id", input.siteId).is("archived_at", null).order("full_name");
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر مراجعة أرقام المشتركين من Supabase." });
      return (data ?? []).map((row) => {
        const mapped = { id: Number(row.id), subscriberNo: row.subscriber_no, fullName: row.full_name, phone: row.phone };
        try {
          const normalizedPhone = normalizeInternationalPhone(mapped.phone);
          return normalizedPhone === mapped.phone ? null : { ...mapped, status: "ready" as const, normalizedPhone, reason: "يمكن توحيد الصيغة تلقائياً." };
        } catch {
          return { ...mapped, status: "manual" as const, normalizedPhone: null, reason: "يتطلب رمز دولة صريحاً؛ عدّل الرقم يدوياً من إدارة المشتركين." };
        }
      }).filter(Boolean);
    }),
    applyPhoneNormalization: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), subscriberIds: z.array(z.number().int().positive()).min(1).max(500) })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner"], "manageSubscribers");
      const { data, error } = await supabaseAdmin().rpc("powerhub_normalize_subscriber_phones", { p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id, p_subscriber_ids: input.subscriberIds });
      const result = (data as Array<{ updated_count: number; skipped_count: number }> | null)?.[0];
      if (!error && result) return { updated: Number(result.updated_count), skipped: Number(result.skipped_count) };
      const errorText = `${error?.code ?? ""} ${error?.message ?? ""}`;
      if (errorText.includes("SITE_OUT_OF_SCOPE")) throw new TRPCError({ code: "FORBIDDEN", message: "الفرع غير تابع لمساحة الشركة." });
      if (errorText.includes("INVALID_SUBSCRIBER_SELECTION")) throw new TRPCError({ code: "BAD_REQUEST", message: "اختر من 1 إلى 500 مشترك لتوحيد الأرقام." });
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر توحيد أرقام المشتركين في Supabase." });
    }),
  }),

  tariffs: router({
    list: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "viewer"]);
      return listSupabaseTariffs(input.siteId);
    }),
    history: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      limit: z.number().int().min(1).max(100).default(50),
      offset: z.number().int().min(0).max(50000).default(0),
    }).refine((value) => !value.from || !value.to || value.from <= value.to, {
      message: "تاريخ بداية الفترة يجب ألا يأتي بعد تاريخ نهايتها.",
    })).query(async ({ ctx, input }) => {
      await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "viewer"]);
      return listSupabaseTariffPriceHistory(input.siteId, input);
    }),
    create: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(),
      pricePerKwh: z.number().min(0),
      fixedFee: z.number().min(0).default(0),
      taxRate: z.number().min(0).max(100).default(0),
      clientOperationId: z.string().uuid(),
    })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, createRoles, "manageTariffs");
      const internalCode = "KWH-" + input.clientOperationId.replace(/-/g, "").slice(0, 12).toUpperCase();
      const { data, error } = await supabaseAdmin().rpc("powerhub_create_tariff_idempotent", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id,
        p_name: "سعر الكيلوواط", p_code: internalCode,
        p_price_per_kwh: input.pricePerKwh, p_fixed_fee: input.fixedFee, p_tax_rate: input.taxRate,
        p_client_operation_id: input.clientOperationId,
      });
      const row = Array.isArray(data) ? data[0] : data;
      if (error || !row?.tariff_id) {
        const message = String(error?.message ?? "");
        if (message.includes("TARIFF_CODE_EXISTS")) throw new TRPCError({ code: "CONFLICT", message: "تعارض في تسجيل سعر الكيلوواط؛ أعد تحميل الصفحة ثم حاول مجددًا." });
        if (message.includes("TARIFF_OPERATION_CONFLICT")) throw new TRPCError({ code: "CONFLICT", message: "بيانات محاولة الحفظ السابقة مختلفة؛ أعد تحميل الصفحة ثم أعد المحاولة." });
        if (message.includes("TARIFF_MANAGEMENT_FORBIDDEN")) throw new TRPCError({ code: "FORBIDDEN", message: "لا تملك صلاحية إدارة سعر الكيلوواط." });
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر حفظ سعر الكيلوواط في قاعدة البيانات." });
      }
      return { id: Number(row.tariff_id), replayed: Boolean(row.replayed) };
    }),
    update: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(), tariffId: z.number().int().positive(),
      pricePerKwh: z.number().min(0),
      fixedFee: z.number().min(0).default(0), taxRate: z.number().min(0).max(100).default(0),
    })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, createRoles, "manageTariffs");
      const { data, error } = await supabaseAdmin().rpc("powerhub_update_tariff_price", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id,
        p_tariff_id: input.tariffId, p_price_per_kwh: input.pricePerKwh,
        p_fixed_fee: input.fixedFee, p_tax_rate: input.taxRate,
      });
      const row = Array.isArray(data) ? data[0] : data;
      if (error || !row?.tariff_id) {
        const message = String(error?.message ?? "");
        if (message.includes("TARIFF_OUT_OF_SCOPE")) throw new TRPCError({ code: "NOT_FOUND", message: "سعر الكيلوواط غير موجود ضمن الفرع المحدد." });
        if (message.includes("TARIFF_MANAGEMENT_FORBIDDEN")) throw new TRPCError({ code: "FORBIDDEN", message: "لا تملك صلاحية تعديل سعر الكيلوواط." });
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحديث سعر الكيلوواط في قاعدة البيانات." });
      }
      return { id: Number(row.tariff_id), changed: Boolean(row.changed) };
    }),
  }),

  generators: router({
    list: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "technician", "viewer"]);
      return listSupabaseGenerators(input.siteId);
    }),
    create: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(), code: z.string().min(2).max(50), name: z.string().min(2).max(160),
      serialNumber: z.string().max(100).optional(), ratedCapacityKw: z.string().trim().regex(/^\d+(\.\d{1,3})?$/).optional(),
      fuelType: z.enum(["diesel", "gasoline", "gas", "other"]).default("diesel"),
    })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "technician"], "manageGenerators");
      const { data, error } = await supabaseAdmin().from("generators").insert({
        tenant_id: access.tenantId, site_id: input.siteId, code: input.code.trim().toUpperCase(), name: input.name.trim(),
        serial_number: input.serialNumber?.trim() || null, rated_capacity_kw: input.ratedCapacityKw?.trim() || null, fuel_type: input.fuelType,
      }).select("id").single();
      if (error || !data) throw new TRPCError({ code: error?.code === "23505" ? "CONFLICT" : "INTERNAL_SERVER_ERROR", message: error?.code === "23505" ? "رمز أو اسم المولد مستخدم بالفعل." : "تعذر إنشاء المولد في Supabase." });
      const id = Number(data.id);
      await writeSupabaseAudit({ userId: ctx.user.id, tenantId: access.tenantId, siteId: input.siteId, entityType: "generator", entityId: String(id), action: "create", afterData: input });
      return { id };
    }),
    update: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(), id: z.number().int().positive(), name: z.string().min(2).max(160), ratedCapacityKw: z.string().trim().regex(/^\d+(\.\d{1,3})?$/).optional(),
      fuelLevelLiters: z.string().regex(/^\d+(\.\d{1,2})?$/), operatingHours: z.string().regex(/^\d+(\.\d{1,2})?$/), status: z.enum(["active", "maintenance", "stopped", "offline"]),
    })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "technician"], "manageGenerators");
      const admin = supabaseAdmin();
      const { data: existing, error: existingError } = await admin.from("generators")
        .select("id, tenant_id, site_id, name, rated_capacity_kw, fuel_level_liters, operating_hours, status")
        .eq("id", input.id).eq("site_id", input.siteId).maybeSingle();
      if (existingError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل المولد من Supabase." });
      if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "المولد غير موجود ضمن المحطة المحددة." });
      const { error: updateError } = await admin.from("generators").update({
        name: input.name.trim(), rated_capacity_kw: input.ratedCapacityKw?.trim() || null, fuel_level_liters: input.fuelLevelLiters,
        operating_hours: input.operatingHours, status: input.status,
      }).eq("id", input.id).eq("site_id", input.siteId);
      if (updateError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحديث المولد في Supabase." });
      await writeSupabaseAudit({ userId: ctx.user.id, tenantId: access.tenantId, siteId: input.siteId, entityType: "generator", entityId: String(input.id), action: "update", beforeData: existing, afterData: input });
      return { success: true };
    }),
  }),

  readings: router({
    list: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "collector", "technician", "viewer"]);
      return listSupabaseReadings(input.siteId);
    }),
    getImage: protectedProcedure.input(siteScoped.extend({ readingId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      const scope = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "collector", "technician", "viewer"]);
      const admin = supabaseAdmin();
      const { data: reading, error: readingError } = await admin.from("meter_readings")
        .select("id, subscriber_id, image_key")
        .eq("tenant_id", scope.tenantId).eq("id", input.readingId).maybeSingle();
      if (readingError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل بيانات صورة القراءة." });
      if (!reading?.image_key) throw new TRPCError({ code: "NOT_FOUND", message: "لا توجد صورة مرفقة بهذه القراءة." });
      const { data: subscriber, error: subscriberError } = await admin.from("subscribers")
        .select("id").eq("tenant_id", scope.tenantId).eq("site_id", input.siteId).eq("id", reading.subscriber_id).maybeSingle();
      if (subscriberError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر التحقق من نطاق صورة القراءة." });
      if (!subscriber) throw new TRPCError({ code: "NOT_FOUND", message: "القراءة لا تتبع للفرع المحدد." });
      try {
        return { url: (await storageGet(reading.image_key)).url };
      } catch {
        throw new TRPCError({ code: "NOT_FOUND", message: "تعذر إنشاء رابط آمن لصورة القراءة." });
      }
    }),
    page: protectedProcedure.input(siteScoped.extend({ limit: z.number().int().min(1).max(200).default(50), cursor: z.string().max(500).optional() })).query(async ({ ctx, input }) => {
      await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "collector", "technician", "viewer"]);
      return listSupabaseReadingPage(input.siteId, input);
    }),
    create: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(), subscriberId: z.number().int().positive(), readingValue: z.string().regex(/^\d+(\.\d{1,2})?$/), readingAt: z.date().optional(),
      captureMethod: z.enum(["manual", "photo", "smart_meter"]).default("manual"), clientOperationId: z.string().uuid().optional(),
      offlineInvoiceNumberClaim: z.object({ grantId: z.string().uuid(), deviceId: z.string().uuid(), numberValue: z.string().regex(/^[1-9][0-9]{0,7}$/), partitionKey: z.string().regex(/^\d{4}$/), formattedNumber: z.string().regex(/^INV-\d{4}-\d{8}$/) }).optional(),
      imageData: z.string().max(9_500_000).optional(), imageMime: z.enum(["image/jpeg", "image/png", "image/webp"]).optional(), notes: z.string().max(1000).optional(), isReadingReset: z.boolean().default(false), overrideSameDay: z.boolean().default(false), fieldVerified: z.boolean().default(false),
    })).mutation(async ({ ctx, input }) => {
      // Resolve membership once for all three capabilities; this is a common hot path.
      const access = await requireSupabaseSiteCapabilities(ctx.user.id, input.siteId, ["recordReadings", "approveReadings", "issueInvoices"]);
      const readingAt = input.readingAt ?? new Date();
      const { data: activeTariff, error: tariffLookupError } = await supabaseAdmin().from("tariffs")
        .select("id")
        .eq("tenant_id", access.tenantId)
        .eq("site_id", input.siteId)
        .eq("is_active", true)
        .order("effective_from", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (tariffLookupError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر التحقق من التعرفة الفعالة قبل تسجيل القراءة." });
      if (!activeTariff) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "لا توجد تعرفة فعالة لهذا الفرع؛ أضف التعرفة قبل تسجيل القراءة حتى لا تُحفظ قراءة دون فاتورة." });
      const dueHours = Math.max(1, Math.min(2160, Number(access.invoiceDueHours ?? ((access.invoiceDueDays ?? 14) * 24))));
      const dueDate = new Date(readingAt.getTime() + dueHours * 60 * 60 * 1000);
      const billingPeriod = readingAt.toISOString().slice(0, 7);
      let imageKey: string | undefined;
      let imageHash: string | undefined;
      const offlineInvoiceClaim = input.offlineInvoiceNumberClaim;
      let offlineDeviceId: string | undefined;
      if (offlineInvoiceClaim) {
        const rawDeviceId = ctx.req?.headers?.["x-powerhub-device-id"];
        const headerDeviceId = Array.isArray(rawDeviceId) ? rawDeviceId[0] : rawDeviceId;
        const expectedInvoiceNo = `INV-${offlineInvoiceClaim.partitionKey}-${offlineInvoiceClaim.numberValue.padStart(8, "0")}`;
        if (!input.clientOperationId || typeof headerDeviceId !== "string" ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(headerDeviceId) ||
            headerDeviceId.toLowerCase() !== offlineInvoiceClaim.deviceId.toLowerCase()) {
          throw new TRPCError({ code: "FORBIDDEN", message: "مطالبة رقم الفاتورة لا تخص جهاز PowerHub الحالي." });
        }
        if (offlineInvoiceClaim.partitionKey !== billingPeriod.slice(0,4) || offlineInvoiceClaim.formattedNumber !== expectedInvoiceNo) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "رقم الفاتورة المحجوز لا يطابق سنة القراءة أو الصيغة الرسمية." });
        }
        offlineDeviceId = headerDeviceId;
      }
      if (input.imageData) {
        if (!input.imageMime) throw new TRPCError({ code: "BAD_REQUEST", message: "نوع صورة القراءة غير مدعوم." });
        const imageBytes = Buffer.from(input.imageData, "base64");
        if (imageBytes.byteLength === 0 || imageBytes.byteLength > 7 * 1024 * 1024) throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: "يجب ألا يتجاوز حجم صورة القراءة 7 ميغابايت." });
        imageHash = createHash("sha256").update(imageBytes).digest("hex");
        const extension = input.imageMime === "image/png" ? "png" : input.imageMime === "image/webp" ? "webp" : "jpg";
        const stored = await storagePut(`subscriber-readings/${ctx.user.id}/${input.subscriberId}-${Date.now()}.${extension}`, imageBytes, input.imageMime);
        imageKey = stored.key;
      }
      const readingRpcArgs = {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id, p_subscriber_id: input.subscriberId,
        p_client_operation_id: input.clientOperationId ?? null, p_reading_at: readingAt.toISOString(), p_reading_value: input.readingValue,
        p_capture_method: input.captureMethod, p_image_key: imageKey ?? "", p_image_hash: imageHash ?? "", p_notes: input.notes?.trim() ?? "",
        p_is_reading_reset: input.isReadingReset, p_field_verified: input.fieldVerified,
        p_can_override_same_day: input.overrideSameDay && ["owner", "manager", "accountant"].includes(access.role),
        p_due_date: dueDate.toISOString(), p_billing_period: billingPeriod,
      };
      const { data, error } = offlineInvoiceClaim
        ? await supabaseAdmin().rpc("powerhub_create_reading_and_issue_invoice_with_offline_number", {
            ...readingRpcArgs, p_offline_grant_id: offlineInvoiceClaim.grantId,
            p_offline_device_id: offlineDeviceId, p_offline_number_value: offlineInvoiceClaim.numberValue,
            p_offline_partition_key: offlineInvoiceClaim.partitionKey,
          })
        : await supabaseAdmin().rpc("powerhub_create_reading_and_issue_invoice", readingRpcArgs);
      if (!error && data?.[0]) {
        const row = data[0] as {
          reading_id: number | string; consumption_kwh: number | string; reading_status: "approved";
          replayed: boolean; invoice_id: number | string; invoice_no: string; total_amount: number | string;
          notification_ids: Array<number | string> | null; already_processed: boolean;
        };
        const notificationIds = (row.notification_ids ?? []).map(Number);
        // An idempotent replay reuses the existing reading, so a newly uploaded retry image is not attached.
        if (row.replayed && imageKey) {
          try { await storageRemove(imageKey); }
          catch (cleanupError) { console.error("[PowerHub] orphaned reading retry image cleanup failed", cleanupError); }
        }
        // The database commits reading + approval + invoice in one transaction. Notify only after commit.
        const deliveries = await Promise.all(notificationIds.map(async (notificationId) => {
          try {
            return { notificationId, ...await processNotificationById(notificationId, ctx.user.id) };
          } catch (deliveryError) {
            return { notificationId, status: "failed" as const, error: deliveryError instanceof Error ? deliveryError.message : "تعذر إرسال إشعار الفاتورة." };
          }
        }));
        return {
          id: Number(row.reading_id), consumptionKwh: Number(row.consumption_kwh), status: row.reading_status,
          replayed: Boolean(row.replayed), invoiceId: Number(row.invoice_id), invoiceNo: row.invoice_no,
          totalAmount: Number(row.total_amount), alreadyProcessed: Boolean(row.already_processed), deliveries,
        };
      }
      if (imageKey) {
        try { await storageRemove(imageKey); }
        catch (cleanupError) { console.error("[PowerHub] orphaned reading image cleanup failed after transaction rollback", cleanupError); }
      }
      const errorText = `${error?.code ?? ""} ${error?.message ?? ""}`;
      if (errorText.includes("SUBSCRIBER_OUT_OF_SCOPE_OR_INACTIVE")) throw new TRPCError({ code: "NOT_FOUND", message: "المشترك لا يتبع للمحطة المحددة أو أن خدمته غير نشطة." });
      if (errorText.includes("SAME_DAY_READING_EXISTS")) throw new TRPCError({ code: "CONFLICT", message: "توجد قراءة مسجلة لهذا المشترك في اليوم نفسه. يقتصر تجاوز ذلك على المالك أو المدير أو المحاسب مع تأكيد صريح." });
      if (errorText.includes("READING_BELOW_PREVIOUS")) throw new TRPCError({ code: "CONFLICT", message: "القراءة الحالية أقل من القراءة المعتمدة السابقة. فعّل خيار إعادة ضبط سجل القراءة وسجل ملاحظة للتأكيد." });
      if (errorText.includes("READING_RESET_NOTES_REQUIRED")) throw new TRPCError({ code: "BAD_REQUEST", message: "أدخل ملاحظة توضح سبب إعادة ضبط سجل القراءة قبل حفظها." });
      if (errorText.includes("TARIFF_NOT_FOUND")) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "لا توجد تعرفة فعالة في هذا الفرع؛ أضف التعرفة قبل تسجيل قراءة قابلة للفوترة." });
      if (errorText.includes("FINANCIAL_PERIOD_LOCKED")) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "الفترة المالية مقفلة ولا يمكن إصدار فاتورة داخلها؛ لم يتم حفظ القراءة." });
      if (errorText.includes("OPENING_BASELINE_NOT_BILLABLE")) throw new TRPCError({ code: "BAD_REQUEST", message: "القراءة الافتتاحية خط أساس ولا تصدر عنها فاتورة استهلاك." });
      if (errorText.includes("OFFLINE_NUMBER_IDEMPOTENCY_MISMATCH") || errorText.includes("OFFLINE_NUMBER_ALREADY_CLAIMED") || errorText.includes("OFFLINE_NUMBER_CLAIM_MISSING")) throw new TRPCError({ code: "CONFLICT", message: "تعارض رقم الفاتورة المحجوز؛ أوقفنا المزامنة لمنع تكرار الرقم." });
      if (errorText.includes("OFFLINE_NUMBER_") || errorText.includes("OFFLINE_INVOICE_CLAIM_INPUT_INVALID")) throw new TRPCError({ code: "CONFLICT", message: "انتهت صلاحية مطالبة رقم الفاتورة أو لم تعد صالحة. احتفظنا بالقراءة للمراجعة ولم نعتمد فاتورة جديدة." });
      if (errorText.includes("READING_NOT_PENDING") || errorText.includes("READING_VERSION_CONFLICT")) throw new TRPCError({ code: "CONFLICT", message: "تعذر اعتماد القراءة بسبب تغير حالتها؛ حدّث البيانات ثم أعد المحاولة." });
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر حفظ القراءة واعتمادها وإصدار فاتورتها؛ لم يتم تثبيت معاملة جزئية." });
    }),
    updatePending: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), readingId: z.number().int().positive(), baseVersion: z.number().int().positive(), readingValue: z.string().regex(/^\d+(\.\d{1,2})?$/), readingAt: z.date(), notes: z.string().max(1000).optional() })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "approveReadings");
      const { data, error } = await supabaseAdmin().rpc("powerhub_update_pending_reading", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id, p_reading_id: input.readingId,
        p_base_version: input.baseVersion, p_reading_value: input.readingValue, p_reading_at: input.readingAt.toISOString(), p_notes: input.notes?.trim() ?? "",
      });
      if (!error && data?.[0]) return { success: true, consumptionKwh: Number((data[0] as { consumption_kwh: number | string }).consumption_kwh) };
      const errorText = `${error?.code ?? ""} ${error?.message ?? ""}`;
      if (errorText.includes("READING_OUT_OF_SCOPE")) throw new TRPCError({ code: "NOT_FOUND", message: "القراءة لا تتبع للفرع المحدد." });
      if (errorText.includes("READING_NOT_PENDING")) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "لا يمكن تعديل قراءة معتمدة أو مرفوضة من هذه الواجهة." });
      if (errorText.includes("READING_VERSION_CONFLICT")) throw new TRPCError({ code: "CONFLICT", message: "تم تعديل القراءة من جهة أخرى؛ حدّث الصفحة ثم أعد المحاولة." });
      if (errorText.includes("READING_BELOW_PREVIOUS")) throw new TRPCError({ code: "CONFLICT", message: "القراءة المعدلة أقل من القراءة السابقة المعتمدة." });
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تعديل القراءة في Supabase." });
    }),
    deletePending: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), readingId: z.number().int().positive(), baseVersion: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "recordReadings");
      const { error } = await supabaseAdmin().rpc("powerhub_delete_pending_reading", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id, p_reading_id: input.readingId, p_base_version: input.baseVersion,
      });
      if (!error) return { success: true };
      const errorText = `${error.code ?? ""} ${error.message ?? ""}`;
      if (errorText.includes("READING_OUT_OF_SCOPE")) throw new TRPCError({ code: "NOT_FOUND", message: "القراءة لا تتبع للفرع المحدد." });
      if (errorText.includes("READING_NOT_PENDING")) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "يمكن حذف القراءات بانتظار المراجعة فقط." });
      if (errorText.includes("READING_VERSION_CONFLICT")) throw new TRPCError({ code: "CONFLICT", message: "تم تحديث القراءة من جهة أخرى؛ حدّث البيانات ثم أعد المحاولة." });
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر حذف القراءة في Supabase." });
    }),
    approve: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), readingId: z.number().int().positive(), baseVersion: z.number().int().positive(), sendNow: z.boolean().default(true) }))
      .mutation(async ({ ctx, input }) => {
        const access = await measureSlowStage("readings.approve", "site_authorization", async () =>
          requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "approveReadings"));
        const { data, error } = await measureSlowStage("readings.approve", "atomic_approval_rpc", async () =>
          supabaseAdmin().rpc("powerhub_approve_reading", {
            p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id, p_reading_id: input.readingId, p_base_version: input.baseVersion,
          }));
        if (!error && data?.[0]) return { success: true };
        const errorText = `${error?.code ?? ""} ${error?.message ?? ""}`;
        if (errorText.includes("READING_OUT_OF_SCOPE")) throw new TRPCError({ code: "NOT_FOUND", message: "القراءة لا تتبع للمحطة المحددة." });
        if (errorText.includes("READING_NOT_PENDING")) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "يمكن اعتماد القراءات بانتظار المراجعة فقط." });
        if (errorText.includes("READING_VERSION_CONFLICT")) throw new TRPCError({ code: "CONFLICT", message: "تم تعديل القراءة من جهة أخرى؛ حدّث البيانات ثم أعد المحاولة." });
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر اعتماد القراءة في Supabase." });
      }),
  }),

  invoices: router({
    list: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "collector", "viewer"]);
      return listSupabaseInvoices(input.siteId);
    }),
    page: protectedProcedure.input(siteScoped.extend({ limit: z.number().int().min(1).max(200).default(50), cursor: z.string().max(500).optional() })).query(async ({ ctx, input }) => {
      await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "collector", "viewer"]);
      return listSupabaseInvoicePage(input.siteId, input);
    }),
    createFromReading: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(), readingId: z.number().int().positive(), tariffId: z.number().int().positive(),
      billingPeriod: z.string().regex(/^\d{4}-\d{2}$/), dueDate: z.date(), discountAmount: z.number().min(0).default(0), clientOperationId: z.string().uuid().optional(),
    })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, createRoles, "issueInvoices");
      // The branch Settings policy is authoritative for every new invoice. Do not trust
      // a client-supplied due date (including an offline draft) to override it.
      const { data: reading, error: readingError } = await supabaseAdmin().from("meter_readings")
        .select("id, reading_at")
        .eq("tenant_id", access.tenantId).eq("site_id", input.siteId).eq("id", input.readingId)
        .maybeSingle();
      if (readingError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل تاريخ القراءة لتحديد استحقاق الفاتورة." });
      if (!reading) throw new TRPCError({ code: "NOT_FOUND", message: "القراءة غير موجودة ضمن الفرع المحدد." });
      // The invoice RPC remains responsible for validating approval/version and transactional consistency.
      const dueHours = Math.max(1, Math.min(2160, Number(access.invoiceDueHours ?? ((access.invoiceDueDays ?? 14) * 24))));
      const dueDate = new Date(new Date(reading.reading_at).getTime() + dueHours * 60 * 60 * 1000);
      if (!Number.isFinite(dueDate.getTime())) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تاريخ القراءة غير صالح لتحديد استحقاق الفاتورة." });
      const { data, error } = await supabaseAdmin().rpc("powerhub_issue_invoice_from_reading", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id, p_reading_id: input.readingId, p_tariff_id: input.tariffId,
        p_billing_period: input.billingPeriod, p_due_date: dueDate.toISOString(), p_discount_amount: input.discountAmount, p_client_operation_id: input.clientOperationId ?? null,
      });
      if (!error && data?.[0]) {
        const row = data[0] as { invoice_id: number | string; invoice_no: string; total_amount: number | string; replayed: boolean };
        return { id: Number(row.invoice_id), invoiceNo: row.invoice_no, totalAmount: Number(row.total_amount), replayed: Boolean(row.replayed) };
      }
      const errorText = `${error?.code ?? ""} ${error?.message ?? ""}`;
      if (errorText.includes("READING_OUT_OF_SCOPE")) throw new TRPCError({ code: "NOT_FOUND", message: "القراءة لا تتبع للمحطة المحددة." });
      if (errorText.includes("READING_NOT_APPROVED")) throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن فوترة قراءة غير معتمدة أو لا تتبع للمحطة المحددة." });
      if (errorText.includes("TARIFF_NOT_FOUND")) throw new TRPCError({ code: "NOT_FOUND", message: "لا توجد تعرفة فعالة يمكن استخدامها لإصدار الفاتورة." });
      if (errorText.includes("FINANCIAL_PERIOD_LOCKED")) throw new TRPCError({ code: "FORBIDDEN", message: "الفترة المالية مقفلة؛ لا يمكن تعديل أو إضافة بيانات مالية داخلها." });
      if (errorText.includes("INVALID_BILLING_PERIOD") || errorText.includes("INVALID_DISCOUNT")) throw new TRPCError({ code: "BAD_REQUEST", message: "بيانات فترة الفوترة أو الخصم غير صالحة." });
      if (error?.code === "23505") throw new TRPCError({ code: "CONFLICT", message: "تعذر إنشاء رقم فاتورة فريد؛ أعد المحاولة." });
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر إصدار الفاتورة في Supabase." });
    }),
    createShareLink: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), invoiceId: z.number().int().positive(), expiresAt: z.date().optional() }))
      .mutation(async ({ ctx, input }) => {
        const access = await measureSlowStage("invoices.createShareLink", "site_authorization", () =>
          withTimeout("invoices.createShareLink", "site_authorization", async () =>
            requireSupabaseSiteRole(ctx.user.id, input.siteId, createRoles, "issueInvoices"), 5_000));
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const token = generateInvoiceShareToken();
          const { data, error } = await measureSlowStage("invoices.createShareLink", `create_link_rpc_attempt_${attempt + 1}`, () =>
            withTimeout("invoices.createShareLink", `create_link_rpc_attempt_${attempt + 1}`, async (signal) =>
              await withAbortSignalIfSupported(supabaseAdmin().rpc("powerhub_create_invoice_share_link", {
                p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id, p_invoice_id: input.invoiceId,
                p_token_hash: hashInvoiceShareToken(token), p_token_preview: token.slice(0, 8), p_expires_at: input.expiresAt?.toISOString() ?? null,
              }), signal), 8_000));
          if (!error && Number((data as Array<{ share_link_id: number | string }> | null)?.[0]?.share_link_id)) return { token, path: `/invoice/${token}` };
          const errorText = `${error?.code ?? ""} ${error?.message ?? ""}`;
          if (error?.code === "23505" && attempt < 2) continue;
          if (errorText.includes("INVOICE_NOT_SHAREABLE")) throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن مشاركة فاتورة غير صادرة أو ملغاة." });
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر إنشاء رابط مشاركة الفاتورة في Supabase." });
        }
        throw new TRPCError({ code: "CONFLICT", message: "تعذر إنشاء رابط مشاركة فريد للفاتورة؛ أعد المحاولة." });
      }),
    publicByToken: publicProcedure.input(z.object({ token: z.string().min(16).max(200) })).query(async ({ input }) => {
      const { data, error } = await measureSlowStage("invoices.publicByToken", "shared_invoice_lookup_rpc", () =>
        withTimeout("invoices.publicByToken", "shared_invoice_lookup_rpc", async (signal) =>
          await withAbortSignalIfSupported(supabaseAdmin().rpc("powerhub_get_shared_invoice_by_token_hash", {
            p_token_hash: hashInvoiceShareToken(input.token),
          }), signal), 8_000));
      if (!error && data && typeof data === "object" && !Array.isArray(data)) {
        const payload = data as {
          siteId?: number;
          tenantId?: number;
          invoice: { id: number; subscriberId: number; invoiceNo: string; billingPeriod: string; issueDate: string; dueDate: string; previousReading: number | null; currentReading: number | null; consumptionKwh: number; pricePerKwh: number; fixedFee: number; taxAmount: number; discountAmount: number; totalAmount: number; paidAmount: number; balanceDue: number; status: string };
          subscriber: { fullName: string; subscriberNo: string } | null;
          lines: Array<{ id: number; lineType?: string; description: string; amount: number; quantity: number; unitPrice: number; displayOrder: number }>;
        };
        let paymentDocumentationAvailable = false;
        let companyName: string | null = null;
        let companyLogoUrl: string | null = null;
        if (payload.tenantId) {
          try {
            const [feature, branding, site, portalLogoAccess, portalSetting] = await measureSlowStage("invoices.publicByToken", "parallel_branding_entitlement_queries", () =>
              withTimeout("invoices.publicByToken", "parallel_branding_entitlement_queries", (signal) => Promise.all([
                withAbortSignalIfSupported(supabaseAdmin().rpc("powerhub_payment_documentation_access", { p_tenant_id: Number(payload.tenantId) }), signal),
                supabaseAdmin().from("tenant_owner_profiles").select("company_name").eq("tenant_id", Number(payload.tenantId)).maybeSingle(),
                payload.siteId
                  ? supabaseAdmin().from("sites").select("name").eq("tenant_id", Number(payload.tenantId)).eq("id", Number(payload.siteId)).maybeSingle()
                  : Promise.resolve({ data: null, error: null }),
                withAbortSignalIfSupported(supabaseAdmin().rpc("powerhub_subscriber_portal_logo_access", { p_tenant_id: Number(payload.tenantId) }), signal),
                payload.siteId
                  ? supabaseAdmin().from("site_portal_settings").select("logo_key").eq("tenant_id", Number(payload.tenantId)).eq("site_id", Number(payload.siteId)).eq("is_enabled", true).maybeSingle()
                  : Promise.resolve({ data: null, error: null }),
              ]), 2_500));
            paymentDocumentationAvailable = !feature.error && Boolean(feature.data?.[0]?.allowed);
            companyName = (!branding.error && branding.data?.company_name?.trim()) || (!site.error && site.data?.name?.trim()) || null;
            const canUsePortalLogo = !portalLogoAccess.error && Boolean(portalLogoAccess.data?.[0]?.allowed);
            const portalLogoKey = portalSetting.data?.logo_key;
            if (canUsePortalLogo && !portalSetting.error && portalLogoKey) {
              try {
                companyLogoUrl = await measureSlowStage("invoices.publicByToken", "sign_company_logo_url", () =>
                  withTimeout("invoices.publicByToken", "sign_company_logo_url", () => storageGetSignedUrl(portalLogoKey), 2_000));
              } catch {
                companyLogoUrl = null;
              }
            }
          } catch {
            // Branding and optional payment-documentation availability must never
            // prevent the invoice itself from rendering when an ancillary service stalls.
            paymentDocumentationAvailable = false;
            companyName = null;
            companyLogoUrl = null;
            console.warn("[PowerHub stage timeout]", {
              operation: "invoices.publicByToken",
              stage: "optional_invoice_enrichment",
              timeoutMs: 2_500,
              vercelRegion: process.env.VERCEL_REGION ?? "local",
            });
          }
        }
        return { ...payload, siteId: payload.siteId ? Number(payload.siteId) : null, companyName, companyLogoUrl, paymentDocumentationAvailable };
      };
      if (`${error?.code ?? ""} ${error?.message ?? ""}`.includes("SHARE_LINK_NOT_FOUND")) throw new TRPCError({ code: "NOT_FOUND", message: "رابط الفاتورة غير صالح أو منتهي." });
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل الفاتورة المشتركة من Supabase." });
    }),
  }),

  payments: router({
    list: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "collector", "viewer"]);
      return listSupabasePayments(input.siteId);
    }),
    page: protectedProcedure.input(siteScoped.extend({ limit: z.number().int().min(1).max(200).default(50), cursor: z.string().max(500).optional() })).query(async ({ ctx, input }) => {
      await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "collector", "viewer"]);
      return listSupabasePaymentPage(input.siteId, input);
    }),
    create: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(), subscriberId: z.number().int().positive(), invoiceId: z.number().int().positive().optional(),
      paymentNo: z.string().min(3).max(60), amount: z.number().positive().refine(hasAtMostTwoDecimalPlaces, "مبلغ التحصيل يجب ألا يتجاوز منزلتين عشريتين."), paymentMethod: z.enum(["cash", "jawwal_pay", "palpay", "bank_of_palestine", "wallet", "bank_transfer", "card"]).default("cash"), companyAccountId: z.number().int().positive(), transferFromAccount: z.string().trim().regex(/^\+?[0-9]{7,20}$/, "رقم الحساب المحوِّل يجب أن يكون رقم جوال صحيحاً.").optional(), transferFromType: z.enum(["jawwal_pay", "palpay", "bank_of_palestine"]).optional(), referenceNo: z.string().max(120).optional(), receiptImageData: z.string().max(9_500_000).optional(), receiptImageMime: z.enum(["image/jpeg", "image/png", "image/webp"]).optional(), clientOperationId: z.string().uuid().optional(), manualDiscountAmount: z.number().min(0).max(100000000).refine(hasAtMostTwoDecimalPlaces, "مبلغ الخصم يجب ألا يتجاوز منزلتين عشريتين.").default(0), manualDiscountReason: z.string().trim().max(300).optional(),
    }).superRefine((input, ctx) => {
      const hasTransferSource = Boolean(input.transferFromAccount);
      if ((hasTransferSource && !input.transferFromType) || (!hasTransferSource && input.transferFromType)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["transferFromAccount"], message: "حدد نوع الحساب المحوِّل فقط عند إدخال رقمه." });
    })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, recordRoles, "collectPayments");
      if (input.manualDiscountAmount > 0 && !["owner", "manager", "accountant"].includes(access.role)) throw new TRPCError({ code: "FORBIDDEN", message: "الخصم اليدوي متاح للمالك والمدير والمحاسب فقط." });
      if (input.manualDiscountAmount > 0 && (!input.invoiceId || !input.manualDiscountReason || input.manualDiscountReason.length < 3)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "يتطلب الخصم اليدوي اختيار فاتورة واحدة وكتابة سبب واضح لا يقل عن 3 أحرف." });
      }
      let receiptImageKey: string | undefined;
      let receiptImageHash: string | undefined;
      let collectorSessionId: number | undefined;
      if (access.role === "collector") {
        const { data: openSession, error: sessionError } = await supabaseAdmin().from("collector_sessions").select("id")
          .eq("tenant_id", access.tenantId).eq("site_id", input.siteId).eq("collector_user_id", ctx.user.id).eq("status", "open").maybeSingle();
        if (sessionError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر التحقق من جلسة التحصيل في Supabase." });
        if (!openSession) throw new TRPCError({ code: "BAD_REQUEST", message: "افتح جلسة تحصيل قبل تسجيل دفعاتك الميدانية." });
        collectorSessionId = Number(openSession.id);
      }

      // All authorization and collector-session preconditions must pass before
      // creating a receipt object in storage.
      if (input.receiptImageData) {
        if (!input.receiptImageMime) throw new TRPCError({ code: "BAD_REQUEST", message: "تعذر تحديد نوع صورة الإيصال." });
        const imageBytes = Buffer.from(input.receiptImageData, "base64");
        if (imageBytes.byteLength === 0 || imageBytes.byteLength > 7 * 1024 * 1024) throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: "يجب ألا تتجاوز صورة الإيصال 7 ميغابايت." });
        receiptImageHash = crypto.createHash("sha256").update(imageBytes).digest("hex");
        const extension = input.receiptImageMime === "image/png" ? "png" : input.receiptImageMime === "image/webp" ? "webp" : "jpg";
        const stored = await storagePut(`payment-receipts/${ctx.user.id}/${input.paymentNo}-${Date.now()}.${extension}`, imageBytes, input.receiptImageMime);
        receiptImageKey = stored.key;
      }

      const rpcArgs = {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id, p_subscriber_id: input.subscriberId, p_invoice_id: input.invoiceId ?? null,
        p_payment_no: input.paymentNo, p_amount: input.amount, p_payment_method: input.paymentMethod, p_company_account_id: input.companyAccountId,
        p_transfer_from_account: input.transferFromAccount ?? null, p_transfer_from_type: input.transferFromType ?? null, p_reference_no: input.referenceNo ?? null,
        p_receipt_image_key: receiptImageKey ?? null, p_receipt_image_hash: receiptImageHash ?? null, p_collector_session_id: collectorSessionId ?? null,
        p_client_operation_id: input.clientOperationId ?? null,
      };
      let data: unknown[] | null = null;
      let error: { code?: string; message?: string } | null = null;
      try {
        const rpcResult = input.manualDiscountAmount > 0
          ? await supabaseAdmin().rpc("powerhub_create_payment_with_discount", { ...rpcArgs, p_manual_discount_amount: input.manualDiscountAmount, p_manual_discount_reason: input.manualDiscountReason })
          : await supabaseAdmin().rpc("powerhub_create_payment", rpcArgs);
        data = rpcResult.data as unknown[] | null;
        error = rpcResult.error;
      } catch (rpcFailure) {
        // A transport exception does not prove that PostgreSQL rolled back: the
        // payment may have committed before the response was lost. Retain the
        // receipt rather than deleting an object a committed payment may reference.
        if (receiptImageKey) {
          console.warn("[PowerHub] payment RPC outcome is indeterminate; retaining uploaded receipt for safe replay/reconciliation", {
            errorName: rpcFailure instanceof Error ? rpcFailure.name : "unknown",
          });
        }
        throw rpcFailure;
      }
      if (!error && data?.[0]) {
        const row = data[0] as { payment_id: number | string; replayed: boolean };
        if (row.replayed && receiptImageKey) {
          // The existing payment owns its original receipt; discard the new upload
          // attached to this transport retry to prevent orphaned duplicate images.
          try { await storageRemove(receiptImageKey); }
          catch (cleanupError) { console.error("[PowerHub] orphaned payment retry image cleanup failed", cleanupError); }
        }
        return { id: Number(row.payment_id), replayed: Boolean(row.replayed) };
      }
      const errorText = `${error?.code ?? ""} ${error?.message ?? ""}`;
      if (receiptImageKey) {
        // A five-character SQLSTATE is an explicit PostgreSQL statement failure,
        // so the RPC transaction rolled back. PGRST/network/unknown errors may
        // represent an indeterminate commit and must not trigger destructive cleanup.
        await cleanupReceiptAfterDefinitiveRpcFailure(receiptImageKey, error, "payment RPC");
      }
      if (errorText.includes("MANUAL_DISCOUNT_EXCEEDS_BALANCE")) throw new TRPCError({ code: "BAD_REQUEST", message: "قيمة الخصم أكبر من الرصيد المستحق." });
      if (errorText.includes("PAYMENT_AND_DISCOUNT_EXCEED_BALANCE")) throw new TRPCError({ code: "BAD_REQUEST", message: "مبلغ التحصيل والخصم معًا يتجاوزان الرصيد المستحق." });
      if (errorText.includes("MANUAL_DISCOUNT_REASON_REQUIRED")) throw new TRPCError({ code: "BAD_REQUEST", message: "أدخل سبب الخصم اليدوي." });
      if (errorText.includes("PAYMENT_OPERATION_SCOPE_CONFLICT")) throw new TRPCError({ code: "CONFLICT", message: "معرّف العملية مستخدم في نطاق آخر." });
      if (errorText.includes("DUPLICATE_PAYMENT_NO")) throw new TRPCError({ code: "CONFLICT", message: "رقم الإيصال مستخدم مسبقاً؛ أدخل رقماً مرجعياً مختلفاً." });
      if (errorText.includes("SUBSCRIBER_OUT_OF_SCOPE")) throw new TRPCError({ code: "NOT_FOUND", message: "المشترك لا يتبع للمحطة المحددة." });
      if (errorText.includes("COMPANY_ACCOUNT_NOT_FOUND") || errorText.includes("COMPANY_ACCOUNT_OUT_OF_SCOPE")) throw new TRPCError({ code: "NOT_FOUND", message: "الحساب المستقبِل غير متاح ضمن حسابات الشركة." });
      if (errorText.includes("COMPANY_ACCOUNT_TYPE_MISMATCH")) throw new TRPCError({ code: "BAD_REQUEST", message: "الدفع النقدي يتطلب حساباً نقدياً، أما التحويل الإلكتروني فيتطلب حساباً إلكترونياً؛ ولا يشترط تطابق مزوّد المصدر مع مزوّد الحساب المستقبِل." });
      if (errorText.includes("INVOICE_OUT_OF_SCOPE")) throw new TRPCError({ code: "NOT_FOUND", message: "الفاتورة لا تتبع للمشترك والمحطة المحددين." });
      if (errorText.includes("INVOICE_NOT_COLLECTIBLE")) throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن تسجيل دفعة على فاتورة ملغاة أو مسودة." });
      if (errorText.includes("INVOICE_BALANCE_CONFLICT")) throw new TRPCError({ code: "CONFLICT", message: "تغير رصيد الفاتورة أثناء المزامنة؛ راجع المسودة ثم أعد المحاولة." });
      if (errorText.includes("FINANCIAL_PERIOD_LOCKED")) throw new TRPCError({ code: "FORBIDDEN", message: "الفترة المالية مقفلة؛ لا يمكن تعديل أو إضافة بيانات مالية داخلها." });
      if (errorText.includes("COLLECTOR_SESSION_NOT_OPEN")) throw new TRPCError({ code: "BAD_REQUEST", message: "افتح جلسة تحصيل قبل تسجيل دفعاتك الميدانية." });
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تسجيل التحصيل في Supabase." });
    }),
  }),

  paymentDocumentation: router({
    publicStatus: publicProcedure.input(z.object({ token: z.string().min(16).max(200) })).query(async ({ input }) => {
      // This purpose-built RPC validates the token and reads pending status only.
      // It deliberately avoids loading invoice accounts/details on a status refresh.
      const { data, error } = await supabaseAdmin().rpc("powerhub_get_public_payment_documentation_status", {
        p_token_hash: hashInvoiceShareToken(input.token),
      });
      if (error || !data || typeof data !== "object" || Array.isArray(data)) {
        const errorText = `${error?.code ?? ""} ${error?.message ?? ""}`;
        if (errorText.includes("SHARE_LINK_NOT_FOUND") || errorText.includes("INVOICE_NOT_FOUND")) {
          throw new TRPCError({ code: "NOT_FOUND", message: "رابط الفاتورة غير صالح أو منتهي." });
        }
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر التحقق من حالة توثيق الدفع." });
      }
      const status = data as { hasPendingSubmission?: boolean; submittedAt?: string | null };
      return {
        hasPendingSubmission: Boolean(status.hasPendingSubmission),
        submittedAt: status.submittedAt ?? null,
      };
    }),
    publicContext: publicProcedure.input(z.object({ token: z.string().min(16).max(200) })).query(async ({ input }) => {
      const { data, error } = await supabaseAdmin().rpc("powerhub_get_public_payment_documentation_context", { p_token_hash: hashInvoiceShareToken(input.token) });
      if (!error && data && typeof data === "object" && !Array.isArray(data)) return data;
      const text = `${error?.code ?? ""} ${error?.message ?? ""}`;
      if (text.includes("SHARE_LINK_NOT_FOUND")) throw new TRPCError({ code: "NOT_FOUND", message: "رابط الفاتورة غير صالح أو منتهي." });
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تجهيز نموذج توثيق الدفع." });
    }),
    publicSubmit: publicProcedure.input(z.object({
      token: z.string().min(16).max(200),
      destinationAccountId: z.number().int().positive(),
      paymentAmount: z.number().positive(),
      paymentMethod: z.enum(["cash","jawwal_pay","palpay","bank_of_palestine","wallet","bank_transfer","card"]),
      senderPhone: z.string().trim().regex(/^\+?[0-9]{7,20}$/, "رقم الجوال المحوِّل يجب أن يكون صحيحاً.").optional(),
      referenceNo: z.string().trim().max(120).optional(),
      receiptImageData: z.string().max(9_500_000).optional(),
      receiptImageMime: z.enum(["image/jpeg","image/png","image/webp"]).optional(),
      clientOperationId: z.string().uuid(),
    })).mutation(async ({ input }) => {
      const access = await supabaseAdmin().rpc("powerhub_get_public_payment_documentation_target", { p_token_hash: hashInvoiceShareToken(input.token) });
      if (access.error || !access.data || typeof access.data !== "object" || Array.isArray(access.data)) throw new TRPCError({ code: "NOT_FOUND", message: "رابط الفاتورة غير صالح أو منتهي." });
      const context = access.data as { paymentDocumentationAvailable?: boolean; siteId?: number; invoice?: { id: number; balanceDue: number; status: string } };
      if (!context.paymentDocumentationAvailable) throw new TRPCError({ code: "FORBIDDEN", message: "ميزة توثيق الدفع الإلكتروني غير متاحة لهذه الفاتورة." });
      if (!context.siteId || !context.invoice?.id) throw new TRPCError({ code: "NOT_FOUND", message: "تعذر التحقق من سياق الفاتورة." });

      let receiptImageKey: string | undefined;
      let receiptImageHash: string | undefined;
      if (input.receiptImageData) {
        if (!input.receiptImageMime) throw new TRPCError({ code: "BAD_REQUEST", message: "تعذر تحديد نوع صورة التحويل." });
        const bytes = Buffer.from(input.receiptImageData, "base64");
        if (bytes.byteLength === 0 || bytes.byteLength > 7 * 1024 * 1024) throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: "يجب ألا تتجاوز صورة التحويل 7 ميغابايت." });
        receiptImageHash = crypto.createHash("sha256").update(bytes).digest("hex");
        const extension = input.receiptImageMime === "image/png" ? "png" : input.receiptImageMime === "image/webp" ? "webp" : "jpg";
        const stored = await storagePut(`payment-documentation/public/${context.siteId}/${crypto.randomUUID()}.${extension}`, bytes, input.receiptImageMime);
        receiptImageKey = stored.key;
      }

      const { data, error } = await supabaseAdmin().rpc("powerhub_submit_public_payment_documentation", {
        p_token_hash: hashInvoiceShareToken(input.token),
        p_destination_account_id: input.destinationAccountId,
        p_payment_amount: input.paymentAmount,
        p_payment_method: input.paymentMethod,
        p_sender_phone: input.senderPhone ?? null,
        p_reference_no: input.referenceNo ?? null,
        p_receipt_image_key: receiptImageKey ?? null,
        p_receipt_image_hash: receiptImageHash ?? null,
        p_client_operation_id: input.clientOperationId,
      });
      if (!error && data?.[0]) {
        const replayed = Boolean((data[0] as { replayed?: boolean }).replayed);
        if (replayed && receiptImageKey) await storageRemove(receiptImageKey).catch(() => undefined);
        return { id: Number((data[0] as { request_id: number | string }).request_id), replayed };
      }
      await cleanupReceiptAfterDefinitiveRpcFailure(receiptImageKey, error, "public payment documentation RPC");
      const text = `${error?.code ?? ""} ${error?.message ?? ""}`;
      if (text.includes("SHARE_LINK_NOT_FOUND")) throw new TRPCError({ code: "NOT_FOUND", message: "رابط الفاتورة غير صالح أو منتهي." });
      if (text.includes("PAYMENT_DOCUMENTATION_DISABLED")) throw new TRPCError({ code: "FORBIDDEN", message: "ميزة توثيق الدفع الإلكتروني غير مفعلة." });
      if (text.includes("INVOICE_ALREADY_PAID")) throw new TRPCError({ code: "CONFLICT", message: "الفاتورة مسددة بالكامل." });
      if (text.includes("PAYMENT_AMOUNT_EXCEEDS_BALANCE")) throw new TRPCError({ code: "CONFLICT", message: "مبلغ الدفع يتجاوز الرصيد الحالي للفاتورة." });
      if (text.includes("COMPANY_ACCOUNT_NOT_ENABLED")) throw new TRPCError({ code: "BAD_REQUEST", message: "الحساب المستقبِل غير مفعّل لتوثيق الدفع." });
      if (text.includes("COMPANY_ACCOUNT_TYPE_MISMATCH")) throw new TRPCError({ code: "BAD_REQUEST", message: "الدفع النقدي يتطلب حساباً نقدياً، أما التحويل الإلكتروني فيتطلب حساباً إلكترونياً؛ ولا يشترط تطابق مزوّد المصدر مع مزوّد الحساب المستقبِل." });
      if (text.includes("COMPANY_ACCOUNT_OUT_OF_SCOPE")) throw new TRPCError({ code: "FORBIDDEN", message: "الحساب المستقبِل غير متاح لهذا الفرع." });
      if (text.includes("PAYMENT_DOCUMENTATION_ALREADY_PENDING")) throw new TRPCError({ code: "CONFLICT", message: "يوجد طلب توثيق قيد التحقق لهذه الفاتورة بالفعل." });
      if (text.includes("TRANSFER_SOURCE_PHONE_REQUIRED") || text.includes("RECEIPT_IMAGE_REQUIRED")) throw new TRPCError({ code: "BAD_REQUEST", message: "أكمل بيانات التحويل وإرفاق صورة التحويل." });
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر إرسال طلب توثيق الدفع." });
    }),
    access: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, []);
      const [featureResult, adminControlResult] = await Promise.all([
        supabaseAdmin().rpc("powerhub_payment_documentation_access", { p_tenant_id: access.tenantId }),
        supabaseAdmin().from("tenant_feature_controls").select("status").eq("tenant_id", access.tenantId).eq("feature_key", "payment_documentation").maybeSingle(),
      ]);
      if (featureResult.error || !featureResult.data?.[0] || adminControlResult.error) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر التحقق من إتاحة توثيق الدفع الإلكتروني." });
      }
      const adminStatus = String(adminControlResult.data?.status ?? "inherit");
      return {
        allowed: Boolean(featureResult.data[0].allowed),
        policy: String(featureResult.data[0].policy ?? "not_included"),
        packageCode: featureResult.data[0].package_code ? String(featureResult.data[0].package_code) : null,
        entitlementEnabled: Boolean(featureResult.data[0].entitlement_enabled),
        adminStatus,
        disabledByAdmin: adminStatus === "disabled",
      };
    }),
    searchSubscriber: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), query: z.string().trim().min(1).max(120) })).query(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "collector", "viewer"], "collectPayments");
      await requirePaymentDocumentationFeature(access.tenantId);
      const q = input.query.trim();
      const safeQuery = q.replace(/[%_]/g, "");
      const phoneVariants = phoneSearchVariants(q);
      const phoneClauses = Array.from(new Set([
        `phone.ilike.%${safeQuery}%`,
        ...phoneVariants.flatMap((value) => [`phone.ilike.%${value.replace(/[%_]/g, "")}%`]),
      ])).join(",");
      const searchClauses = [`full_name.ilike.%${safeQuery}%`, `subscriber_no.ilike.%${safeQuery}%`, phoneClauses].filter(Boolean).join(",");
      const admin = supabaseAdmin();
      const { data: subscribers, error: subscriberError } = await admin.from("subscribers")
        .select("id, full_name, subscriber_no, phone, whatsapp_number, service_status")
        .eq("tenant_id", access.tenantId).eq("site_id", input.siteId).is("archived_at", null)
        .or(searchClauses)
        .limit(20);
      if (subscriberError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر البحث عن المشترك." });
      if (!subscribers?.length) return [];
      const ids = subscribers.map((row) => Number(row.id));
      const { data: invoices, error: invoiceError } = await admin.from("invoices")
        .select("id, subscriber_id, invoice_no, billing_period, issue_date, due_date, previous_reading, current_reading, consumption_kwh, price_per_kwh, fixed_fee, tax_amount, discount_amount, total_amount, paid_amount, balance_due, status")
        .eq("tenant_id", access.tenantId).eq("site_id", input.siteId).in("subscriber_id", ids)
        .order("issue_date", { ascending: false }).limit(200);
      if (invoiceError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل فواتير المشترك." });
      const invoiceIds = Array.from(new Set((invoices ?? []).map((invoice) => Number(invoice.id))));
      const invoiceLinesById = new Map<number, Array<{ id: number; lineType: string; description: string; amount: number; quantity: number; unitPrice: number; displayOrder: number }>>();
      if (invoiceIds.length) {
        const { data: invoiceLines, error: invoiceLinesError } = await admin.from("invoice_lines")
          .select("id, invoice_id, line_type, description, amount, quantity, unit_price, display_order")
          .eq("tenant_id", access.tenantId)
          .in("invoice_id", invoiceIds)
          .order("display_order", { ascending: true })
          .order("id", { ascending: true });
        if (invoiceLinesError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل تفاصيل الفواتير وتسوياتها." });
        for (const line of invoiceLines ?? []) {
          const invoiceId = Number(line.invoice_id);
          const items = invoiceLinesById.get(invoiceId) ?? [];
          items.push({
            id: Number(line.id),
            lineType: String(line.line_type),
            description: String(line.description),
            amount: Number(line.amount),
            quantity: Number(line.quantity),
            unitPrice: Number(line.unit_price),
            displayOrder: Number(line.display_order),
          });
          invoiceLinesById.set(invoiceId, items);
        }
      }
      return subscribers.map((subscriber) => ({
        ...subscriber,
        invoices: (invoices ?? [])
          .filter((invoice) => Number(invoice.subscriber_id) === Number(subscriber.id))
          .map((invoice) => ({ ...invoice, lines: invoiceLinesById.get(Number(invoice.id)) ?? [] })),
      }));
    }),
    list: protectedProcedure.input(siteScoped.extend({
      status: z.enum(["pending","approved","rejected","all"]).default("pending"),
      period: z.enum(["current_cycle","today","specific_day","date_range","all_time"]).default("current_cycle"),
      specificDate: paymentDocumentationDateKeySchema.optional(),
      fromDate: paymentDocumentationDateKeySchema.optional(),
      toDate: paymentDocumentationDateKeySchema.optional(),
    }).superRefine((input, issueContext) => {
      if (input.period === "specific_day" && !input.specificDate) {
        issueContext.addIssue({ code: z.ZodIssueCode.custom, path: ["specificDate"], message: "اختر اليوم المطلوب." });
      }
      if (input.period === "date_range" && (!input.fromDate || !input.toDate)) {
        issueContext.addIssue({ code: z.ZodIssueCode.custom, path: ["fromDate"], message: "حدد تاريخ البداية والنهاية." });
      }
      if (input.period === "date_range" && input.fromDate && input.toDate && input.fromDate > input.toDate) {
        issueContext.addIssue({ code: z.ZodIssueCode.custom, path: ["toDate"], message: "تاريخ النهاية يجب أن يساوي تاريخ البداية أو يأتي بعده." });
      }
    })).query(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [], "approvePaymentDocumentation");
      const admin = supabaseAdmin();
      // Entitlement and current-cycle bounds are independent reads; overlap them so
      // opening the review tab doesn't pay two sequential database round trips.
      const cyclePromise = input.period === "current_cycle"
        ? measureSlowStage("paymentDocumentation.list", "cycle_bounds", async () =>
            admin.rpc("powerhub_cycle_for_reading", {
              p_tenant_id: access.tenantId,
              p_site_id: input.siteId,
              p_reading_at: new Date().toISOString(),
            }))
        : Promise.resolve(null);
      const [, cycle] = await Promise.all([
        measureSlowStage("paymentDocumentation.list", "feature_entitlement", async () =>
          requirePaymentDocumentationFeature(access.tenantId)),
        cyclePromise,
      ]);
      let query = admin.from("payment_documentation_requests")
        .select("id, tenant_id, site_id, subscriber_id, invoice_id, destination_account_id, invoice_no_snapshot, subscriber_name_snapshot, subscriber_no_snapshot, billing_period_snapshot, previous_reading_snapshot, current_reading_snapshot, consumption_kwh_snapshot, price_per_kwh_snapshot, consumption_value_snapshot, invoice_total_snapshot, invoice_balance_snapshot, payment_amount, payment_method, sender_phone, reference_no, receipt_image_key, receipt_image_hash, status, rejection_reason, submitted_by_user_id, reviewed_by_user_id, reviewed_at, payment_id, submitted_at, created_at, updated_at")
        .eq("tenant_id", access.tenantId).eq("site_id", input.siteId).order("submitted_at", { ascending: false }).limit(200);
      if (input.status !== "all") query = query.eq("status", input.status);

      if (input.period === "current_cycle") {
        const cycleRow = Array.isArray(cycle?.data) ? cycle.data[0] : null;
        if (cycle?.error || !cycleRow?.cycle_start_at || !cycleRow?.cycle_end_at) {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: "تعذر تحديد دورة القراءة الحالية لهذا الفرع." });
        }
        query = query.gte("submitted_at", String(cycleRow.cycle_start_at)).lte("submitted_at", String(cycleRow.cycle_end_at));
      } else if (input.period === "today" || input.period === "specific_day") {
        const dateKey = input.period === "today" ? paymentDocumentationGazaDateKey() : input.specificDate!;
        const from = paymentDocumentationGazaDateBoundary(dateKey);
        const to = paymentDocumentationGazaDateBoundary(paymentDocumentationNextDateKey(dateKey));
        query = query.gte("submitted_at", from.toISOString()).lt("submitted_at", to.toISOString());
      } else if (input.period === "date_range") {
        const from = paymentDocumentationGazaDateBoundary(input.fromDate!);
        const to = paymentDocumentationGazaDateBoundary(paymentDocumentationNextDateKey(input.toDate!));
        query = query.gte("submitted_at", from.toISOString()).lt("submitted_at", to.toISOString());
      }

      const { data, error } = await query;
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل طلبات توثيق الدفع." });
      const rows = data ?? [];
      if (!rows.length) return rows;
      const accountIds = Array.from(new Set(rows.map((row) => Number(row.destination_account_id)).filter((id) => Number.isInteger(id) && id > 0)));
      if (!accountIds.length) return rows;
      const [accountsResult, linksResult] = await Promise.all([
        measureSlowStage("paymentDocumentation.list", "destination_accounts", async () =>
          admin.from("company_accounts")
            .select("id, name, account_type, phone_number")
            .eq("tenant_id", access.tenantId)
            .in("id", accountIds)),
        measureSlowStage("paymentDocumentation.list", "destination_account_site_scope", async () =>
          admin.from("company_account_sites")
            .select("account_id, site_id")
            .eq("tenant_id", access.tenantId)
            .in("account_id", accountIds)),
      ]);
      const { data: accounts, error: accountError } = accountsResult;
      if (accountError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل بيانات الحسابات المستقبلة لطلبات التوثيق." });
      const { data: accountLinks, error: linksError } = linksResult;
      if (linksError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر التحقق من نطاق حسابات الاستقبال." });
      const linksByAccount = new Map<number, number[]>();
      for (const link of accountLinks ?? []) {
        const accountId = Number(link.account_id);
        linksByAccount.set(accountId, [...(linksByAccount.get(accountId) ?? []), Number(link.site_id)]);
      }
      const accountById = new Map((accounts ?? []).map((account) => [Number(account.id), account]));
      return rows.map((row) => {
        const accountId = Number(row.destination_account_id);
        const account = accountById.get(accountId);
        const scopedSites = linksByAccount.get(accountId) ?? [];
        const visibleAccount = account && (scopedSites.length === 0 || scopedSites.includes(input.siteId)) ? account : null;
        return {
          ...row,
          destination_account_name: visibleAccount?.name ?? null,
          destination_account_type: visibleAccount?.account_type ?? null,
          destination_account_phone_number: visibleAccount?.phone_number ?? null,
        };
      });
    }),
    availableAccounts: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "collector", "viewer"], "collectPayments");
      await requirePaymentDocumentationFeature(access.tenantId);
      const { data, error } = await supabaseAdmin().from("company_accounts")
        .select("id, name, account_type, phone_number")
        .eq("tenant_id", access.tenantId)
        .eq("is_active", true)
        .eq("allow_payment_documentation", true)
        .order("id", { ascending: true });
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل حسابات الدفع المفعلة." });
      const ids = (data ?? []).map((row) => Number(row.id));
      if (!ids.length) return [];
      const { data: links, error: linkError } = await supabaseAdmin().from("company_account_sites")
        .select("account_id, site_id")
        .eq("tenant_id", access.tenantId).in("account_id", ids);
      if (linkError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر التحقق من ربط حسابات الدفع بالمحطة." });
      const linksByAccount = new Map<number, number[]>();
      for (const row of links ?? []) {
        const accountId = Number(row.account_id);
        linksByAccount.set(accountId, [...(linksByAccount.get(accountId) ?? []), Number(row.site_id)]);
      }
      return (data ?? []).filter((row) => {
        const accountLinks = linksByAccount.get(Number(row.id)) ?? [];
        // No site links means a tenant-wide company account; an account with
        // explicit links is available only on those branches.
        return accountLinks.length === 0 || accountLinks.includes(input.siteId);
      }).map((row) => ({
        id: Number(row.id), name: row.name, accountType: row.account_type, phoneNumber: row.phone_number,
      }));
    }),
    ownerFeature: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), isEnabled: z.boolean() })).mutation(async ({ ctx, input }) => {
      const { data, error } = await supabaseAdmin().rpc("powerhub_owner_set_payment_documentation", { p_user_id: ctx.user.id, p_site_id: input.siteId, p_is_enabled: input.isEnabled });
      if (error) {
        if (error.message.includes("FEATURE_DISABLED_BY_ADMIN")) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "ميزة توثيق الدفع متوقفة من إدارة المنصة، ولا يمكن تفعيلها من حسابك حالياً." });
        if (error.message.includes("FEATURE_GLOBALLY_DISABLED")) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "توثيق الدفع متوقف حالياً من إدارة PowerHub." });
        if (error.message.includes("FEATURE_NOT_AVAILABLE")) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "توثيق الدفع غير متاح ضمن باقتك الحالية." });
        throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكن تعديل إتاحة توثيق الدفع لهذا الحساب." });
      }
      const row = data?.[0];
      return { success: true, allowed: Boolean(row?.is_enabled), policy: String(row?.policy ?? "not_included") };
    }),
    submit: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(), subscriberId: z.number().int().positive(), invoiceId: z.number().int().positive(),
      destinationAccountId: z.number().int().positive(), paymentAmount: z.number().positive(),
      paymentMethod: z.enum(["cash", "jawwal_pay", "palpay", "bank_of_palestine", "wallet", "bank_transfer", "card"]),
      senderPhone: z.string().trim().regex(/^\\+?[0-9]{7,20}$/, "رقم الجوال المحوِّل يجب أن يكون صحيحاً.").optional(),
      referenceNo: z.string().trim().max(120).optional(), receiptImageData: z.string().max(9_500_000).optional(),
      receiptImageMime: z.enum(["image/jpeg", "image/png", "image/webp"]).optional(), clientOperationId: z.string().uuid().optional(),
    })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, recordRoles, "collectPayments");
      // requirePaymentDocumentationFeature already calls the entitlement RPC and rejects
      // unavailable plans. The submission RPC independently validates invoice/account scope.
      // Do not issue the same entitlement RPC twice on this latency-sensitive path.
      await requirePaymentDocumentationFeature(access.tenantId);
      let receiptImageKey: string | undefined;
      let receiptImageHash: string | undefined;
      if (input.receiptImageData) {
        if (!input.receiptImageMime) throw new TRPCError({ code: "BAD_REQUEST", message: "تعذر تحديد نوع صورة التحويل." });
        const imageBytes = Buffer.from(input.receiptImageData, "base64");
        if (imageBytes.byteLength === 0 || imageBytes.byteLength > 7 * 1024 * 1024) throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: "يجب ألا تتجاوز صورة التحويل 7 ميغابايت." });
        receiptImageHash = crypto.createHash("sha256").update(imageBytes).digest("hex");
        const extension = input.receiptImageMime === "image/webp" ? "webp" : "jpg";
        const stored = await storagePut(`payment-documentation/${access.tenantId}/${input.siteId}/${ctx.user.id}/${crypto.randomUUID()}.${extension}`, imageBytes, input.receiptImageMime);
        receiptImageKey = stored.key;
      }
      const { data, error } = await supabaseAdmin().rpc("powerhub_submit_payment_documentation", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id, p_subscriber_id: input.subscriberId,
        p_invoice_id: input.invoiceId, p_destination_account_id: input.destinationAccountId, p_payment_amount: input.paymentAmount,
        p_payment_method: input.paymentMethod, p_sender_phone: input.senderPhone ?? null, p_reference_no: input.referenceNo ?? null,
        p_receipt_image_key: receiptImageKey ?? null, p_receipt_image_hash: receiptImageHash ?? null, p_client_operation_id: input.clientOperationId ?? null,
      });
      if (!error && data?.[0]) {
        const replayed = Boolean((data[0] as { replayed?: boolean }).replayed);
        if (replayed && receiptImageKey) await storageRemove(receiptImageKey).catch(() => undefined);
        return { id: Number((data[0] as { request_id: number | string }).request_id), replayed };
      }
      await cleanupReceiptAfterDefinitiveRpcFailure(receiptImageKey, error, "payment documentation RPC");
      const text = `${error?.code ?? ""} ${error?.message ?? ""}`;
      if (text.includes("INVOICE_OUT_OF_SCOPE") || text.includes("SUBSCRIBER_OUT_OF_SCOPE")) throw new TRPCError({ code: "NOT_FOUND", message: "الفاتورة أو المشترك لا يتبعان للمحطة المحددة." });
      if (text.includes("INVOICE_ALREADY_PAID")) throw new TRPCError({ code: "CONFLICT", message: "الفاتورة مسددة بالكامل." });
      if (text.includes("PAYMENT_AMOUNT_EXCEEDS_BALANCE")) throw new TRPCError({ code: "CONFLICT", message: "مبلغ الدفع يتجاوز الرصيد الحالي للفاتورة." });
      if (text.includes("COMPANY_ACCOUNT_NOT_ENABLED")) throw new TRPCError({ code: "BAD_REQUEST", message: "الحساب المستقبِل غير مفعّل لتوثيق الدفع الإلكتروني." });
      if (text.includes("COMPANY_ACCOUNT_TYPE_MISMATCH")) throw new TRPCError({ code: "BAD_REQUEST", message: "الدفع النقدي يتطلب حساباً نقدياً، أما التحويل الإلكتروني فيتطلب حساباً إلكترونياً؛ ولا يشترط تطابق مزوّد المصدر مع مزوّد الحساب المستقبِل." });
      if (text.includes("COMPANY_ACCOUNT_OUT_OF_SCOPE")) throw new TRPCError({ code: "FORBIDDEN", message: "الحساب المستقبِل غير متاح في هذه المحطة." });
      if (text.includes("PAYMENT_DOCUMENTATION_ALREADY_PENDING")) throw new TRPCError({ code: "CONFLICT", message: "يوجد طلب توثيق قيد التحقق لهذه الفاتورة بالفعل." });
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر إرسال طلب توثيق الدفع." });
    }),
    approve: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), requestId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      const access = await measureSlowStage("paymentDocumentation.approve", "site_authorization", async () =>
        requireSupabaseSiteRole(ctx.user.id, input.siteId, [], "approvePaymentDocumentation"));
      await measureSlowStage("paymentDocumentation.approve", "feature_entitlement", async () =>
        requirePaymentDocumentationFeature(access.tenantId));
      const { data, error } = await measureSlowStage("paymentDocumentation.approve", "atomic_approval_rpc", async () =>
        supabaseAdmin().rpc("powerhub_approve_payment_documentation", { p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id, p_request_id: input.requestId }));
      if (error || !data?.[0]) {
        const text = `${error?.code ?? ""} ${error?.message ?? ""}`;
        if (text.includes("NOT_FOUND")) throw new TRPCError({ code: "NOT_FOUND", message: "طلب توثيق الدفع غير موجود." });
        if (text.includes("REJECTED")) throw new TRPCError({ code: "CONFLICT", message: "لا يمكن اعتماد طلب مرفوض." });
        if (text.includes("FINANCIAL_PERIOD_LOCKED")) throw new TRPCError({ code: "FORBIDDEN", message: "الفترة المالية مقفلة؛ لا يمكن اعتماد الدفع." });
        if (text.includes("INVOICE_BALANCE_CONFLICT")) throw new TRPCError({ code: "CONFLICT", message: "تغير رصيد الفاتورة؛ راجع الطلب قبل الاعتماد." });
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر اعتماد طلب توثيق الدفع." });
      }
      const approval = data[0] as { payment_id: number | string; replayed: boolean };
      const paymentId = Number(approval.payment_id);
      const replayed = Boolean(approval.replayed);
      // Approval is the financial source of truth. Receipt preparation and SMS queuing
      // are secondary, best-effort work and must never turn a successful approval into a
      // misleading failed button state. Read receipt context and display policy in parallel.
      try {
        const [contextResult, billingPolicyResult] = await Promise.all([
          measureSlowStage("paymentDocumentation.approve", "receipt_context_rpc", async () =>
            supabaseAdmin().rpc("powerhub_payment_receipt_context", {
              p_tenant_id: access.tenantId, p_site_id: input.siteId, p_payment_id: paymentId,
            })),
          measureSlowStage("paymentDocumentation.approve", "receipt_billing_policy", async () =>
            supabaseAdmin().from("site_billing_policies")
              .select("automatic_fraction_discount_enabled,fraction_carry_enabled")
              .eq("tenant_id", access.tenantId).eq("site_id", input.siteId).maybeSingle()),
        ]);
        const { data: contextRows, error: contextError } = contextResult;
        const receiptContext = Array.isArray(contextRows) ? contextRows[0] as {
          invoice_id?: number | string | null;
          payment_no?: string | null;
          payment_amount?: number | string | null;
          invoice_no?: string | null;
          balance_due?: number | string | null;
          subscriber_name?: string | null;
          subscriber_phone?: string | null;
          template_body?: string | null;
        } | undefined : undefined;
        if (contextError) {
          console.warn("[PowerHub payment receipt] context lookup failed after approval", { code: contextError.code ?? "unknown" });
        } else if (receiptContext?.invoice_id && receiptContext.subscriber_phone) {
          const { data: billingPolicy, error: billingPolicyError } = billingPolicyResult;
          if (billingPolicyError) {
            console.warn("[PowerHub payment receipt] billing policy lookup failed after approval", { code: billingPolicyError.code ?? "unknown" });
          } else {
            const receipt = {
              subscriberName: String(receiptContext.subscriber_name ?? ""),
              paymentNo: String(receiptContext.payment_no ?? ""),
              paymentAmount: Number(receiptContext.payment_amount ?? 0),
              invoiceNo: String(receiptContext.invoice_no ?? ""),
              balanceDue: Number(receiptContext.balance_due ?? 0),
            };
            const settlementDisplayEnabled = Boolean(billingPolicy?.automatic_fraction_discount_enabled || billingPolicy?.fraction_carry_enabled);
            const renderedText = renderPaymentReceiptTemplate(receiptContext.template_body ?? defaultPaymentReceiptSmsTemplate, receipt, settlementDisplayEnabled) || renderPaymentReceiptMessage(receipt, settlementDisplayEnabled);
            const { error: queueError } = await measureSlowStage("paymentDocumentation.approve", "queue_receipt_notification", async () =>
              supabaseAdmin().rpc("powerhub_queue_payment_sms", {
                p_user_id: ctx.user.id, p_tenant_id: access.tenantId, p_site_id: input.siteId,
                p_event_type: "payment_received", p_invoice_id: Number(receiptContext.invoice_id),
                p_payment_id: paymentId, p_operation_key: `payment_receipt:${paymentId}`, p_rendered_text: renderedText,
              }));
            if (queueError) console.warn("[PowerHub payment receipt] queue failed after approval", { code: queueError.code ?? "unknown" });
          }
        }
      } catch (secondaryError) {
        console.warn("[PowerHub payment receipt] secondary notification processing failed after approval", {
          errorName: secondaryError instanceof Error ? secondaryError.name : "unknown",
        });
      }
      return { paymentId, replayed };
    }),
    receiptUrl: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), requestId: z.number().int().positive() })).query(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [], "approvePaymentDocumentation");
      await requirePaymentDocumentationFeature(access.tenantId);
      const { data, error } = await supabaseAdmin().from("payment_documentation_requests")
        .select("receipt_image_key")
        .eq("id", input.requestId).eq("tenant_id", access.tenantId).eq("site_id", input.siteId).maybeSingle();
      if (error || !data?.receipt_image_key) throw new TRPCError({ code: "NOT_FOUND", message: "صورة التحويل غير متاحة." });
      try { return { url: await storageGetSignedUrl(data.receipt_image_key) }; }
      catch { throw new TRPCError({ code: "NOT_FOUND", message: "تعذر فتح صورة التحويل." }); }
    }),
    reject: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), requestId: z.number().int().positive(), rejectionReason: z.string().trim().min(2).max(1000) })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [], "approvePaymentDocumentation");
      await requirePaymentDocumentationFeature(access.tenantId);
      const request = await supabaseAdmin().from("payment_documentation_requests")
        .select("receipt_image_key, status")
        .eq("id", input.requestId).eq("tenant_id", access.tenantId).eq("site_id", input.siteId).maybeSingle();
      if (request.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل طلب توثيق الدفع." });
      const { data, error } = await supabaseAdmin().rpc("powerhub_reject_payment_documentation", { p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id, p_request_id: input.requestId, p_rejection_reason: input.rejectionReason });
      if (error || !data?.[0]) {
        const text = `${error?.code ?? ""} ${error?.message ?? ""}`;
        if (text.includes("ALREADY_APPROVED")) throw new TRPCError({ code: "CONFLICT", message: "تم اعتماد الطلب مسبقاً ولا يمكن رفضه." });
        if (text.includes("NOT_FOUND")) throw new TRPCError({ code: "NOT_FOUND", message: "طلب توثيق الدفع غير موجود." });
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر رفض طلب توثيق الدفع." });
      }
      if (request.data?.receipt_image_key) {
        try {
          await storageRemove(request.data.receipt_image_key);
          const deletedAt = new Date().toISOString();
          const cleanup = await supabaseAdmin().from("payment_documentation_requests")
            .update({ receipt_image_key: null, receipt_image_deleted_at: deletedAt, updated_at: deletedAt })
            .eq("id", input.requestId).eq("tenant_id", access.tenantId).eq("site_id", input.siteId).eq("status", "rejected");
          if (cleanup.error) throw cleanup.error;
        } catch {
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تم رفض الطلب لكن تعذر حذف صورة التوثيق فوراً؛ ستتم إعادة المحاولة تلقائياً." });
        }
      }
      return { requestId: Number((data[0] as { request_id: number | string }).request_id) };
    }),  }),

  collectorSessions: router({
    list: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, recordRoles, "collectPayments");
      await requirePaymentDocumentationFeature(access.tenantId);
      let query = supabaseAdmin().from("collector_sessions").select("id, tenant_id, site_id, collector_user_id, status, opening_cash, expected_cash, declared_cash, variance_amount, opened_at, closed_at, notes, closed_by_user_id, created_at, updated_at").eq("site_id", input.siteId).order("opened_at", { ascending: false }).limit(100);
      if (access.role === "collector") query = query.eq("collector_user_id", ctx.user.id);
      const { data, error } = await query;
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل جلسات التحصيل من Supabase." });
      const userIds = Array.from(new Set((data ?? []).map((row) => Number(row.collector_user_id))));
      const { data: userRows, error: usersError } = userIds.length ? await supabaseAdmin().from("users").select("id, name, email, phone_number, platform_role, created_at, updated_at").in("id", userIds) : { data: [], error: null };
      if (usersError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل المحصلين من Supabase." });
      const usersById = new Map((userRows ?? []).map((row) => [Number(row.id), { id: Number(row.id), name: row.name, email: row.email, phoneNumber: row.phone_number, platformRole: row.platform_role, createdAt: new Date(row.created_at), updatedAt: new Date(row.updated_at) }]));
      return (data ?? []).map((row) => ({ session: { id: Number(row.id), tenantId: Number(row.tenant_id), siteId: Number(row.site_id), collectorUserId: Number(row.collector_user_id), status: row.status, openingCash: String(row.opening_cash), expectedCash: String(row.expected_cash), declaredCash: row.declared_cash === null ? null : String(row.declared_cash), varianceAmount: row.variance_amount === null ? null : String(row.variance_amount), openedAt: new Date(row.opened_at), closedAt: row.closed_at ? new Date(row.closed_at) : null, notes: row.notes, closedByUserId: row.closed_by_user_id === null ? null : Number(row.closed_by_user_id), createdAt: new Date(row.created_at), updatedAt: new Date(row.updated_at) }, collector: usersById.get(Number(row.collector_user_id)) ?? { id: Number(row.collector_user_id), name: null, email: null, phoneNumber: null, platformRole: null, createdAt: new Date(row.created_at), updatedAt: new Date(row.updated_at) } }));
    }),
    current: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, recordRoles, "collectPayments");
      await requirePaymentDocumentationFeature(access.tenantId);
      const { data, error } = await supabaseAdmin().from("collector_sessions").select("id, tenant_id, site_id, collector_user_id, status, opening_cash, expected_cash, declared_cash, variance_amount, opened_at, closed_at, notes, closed_by_user_id, created_at, updated_at").eq("tenant_id", access.tenantId).eq("site_id", input.siteId).eq("collector_user_id", ctx.user.id).eq("status", "open").maybeSingle();
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل جلسة التحصيل من Supabase." });
      return data ? { id: Number(data.id), tenantId: Number(data.tenant_id), siteId: Number(data.site_id), collectorUserId: Number(data.collector_user_id), status: data.status, openingCash: String(data.opening_cash), expectedCash: String(data.expected_cash), declaredCash: data.declared_cash === null ? null : String(data.declared_cash), varianceAmount: data.variance_amount === null ? null : String(data.variance_amount), openedAt: new Date(data.opened_at), closedAt: data.closed_at ? new Date(data.closed_at) : null, notes: data.notes, closedByUserId: data.closed_by_user_id === null ? null : Number(data.closed_by_user_id), createdAt: new Date(data.created_at), updatedAt: new Date(data.updated_at) } : null;
    }),
    open: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), openingCash: z.number().min(0).default(0), notes: z.string().max(1000).optional() })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, recordRoles, "collectPayments");
      await requirePaymentDocumentationFeature(access.tenantId);
      if (access.role !== "collector") throw new TRPCError({ code: "FORBIDDEN", message: "جلسة التحصيل الميدانية مخصصة لدور المحصل." });
      const { data, error } = await supabaseAdmin().rpc("powerhub_open_collector_session", { p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id, p_opening_cash: input.openingCash, p_notes: input.notes ?? null });
      if (!error && data?.[0]) return { id: Number((data[0] as { session_id: number | string }).session_id) };
      if (`${error?.message ?? ""}`.includes("COLLECTOR_SESSION_EXISTS")) throw new TRPCError({ code: "CONFLICT", message: "لديك جلسة تحصيل مفتوحة بالفعل لهذه المحطة." });
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر فتح جلسة التحصيل في Supabase." });
    }),
    close: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), sessionId: z.number().int().positive(), declaredCash: z.number().min(0), notes: z.string().max(1000).optional() })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, recordRoles, "collectPayments");
      await requirePaymentDocumentationFeature(access.tenantId);
      const { data, error } = await supabaseAdmin().rpc("powerhub_close_collector_session", { p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id, p_session_id: input.sessionId, p_declared_cash: input.declaredCash, p_notes: input.notes ?? null, p_allow_foreign_close: access.role !== "collector" });
      if (!error && data?.[0]) return { expectedCash: Number((data[0] as { expected_cash: number | string }).expected_cash), varianceAmount: Number((data[0] as { variance_amount: number | string }).variance_amount) };
      const errorText = `${error?.message ?? ""}`;
      if (errorText.includes("COLLECTOR_SESSION_NOT_FOUND")) throw new TRPCError({ code: "NOT_FOUND", message: "جلسة التحصيل غير موجودة ضمن المحطة المحددة." });
      if (errorText.includes("COLLECTOR_SESSION_CLOSED")) throw new TRPCError({ code: "CONFLICT", message: "تم إغلاق جلسة التحصيل مسبقاً." });
      if (errorText.includes("COLLECTOR_SESSION_FORBIDDEN")) throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكن للمحصل إغلاق جلسة محصل آخر." });
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر إغلاق جلسة التحصيل في Supabase." });
    }),
  }),

  expenses: router({
    filterAccounts: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "viewer"]);
      const { data: links, error: linksError } = await supabaseAdmin()
        .from("company_account_sites")
        .select("account_id")
        .eq("tenant_id", access.tenantId)
        .eq("site_id", input.siteId)
        .limit(1000);
      if (linksError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل حسابات فلتر المصروفات." });
      const accountIds = Array.from(new Set((links ?? []).map((row) => Number(row.account_id)).filter((id) => Number.isInteger(id) && id > 0)));
      if (!accountIds.length) return [];
      const { data: accounts, error: accountsError } = await supabaseAdmin()
        .from("company_accounts")
        .select("id, name, account_type")
        .eq("tenant_id", access.tenantId)
        .eq("is_active", true)
        .in("id", accountIds)
        .order("id", { ascending: true });
      if (accountsError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل أسماء حسابات فلتر المصروفات." });
      return (accounts ?? []).map((account) => ({ id: Number(account.id), name: account.name, accountType: account.account_type }));
    }),
    list: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "viewer"]);
      return listSupabaseExpenses(input.siteId);
    }),
    page: protectedProcedure.input(siteScoped.extend({ limit: z.number().int().min(1).max(200).default(50), cursor: z.string().max(500).optional(), startDate: paymentDocumentationDateKeySchema.optional(), endDate: paymentDocumentationDateKeySchema.optional(), companyAccountId: z.number().int().positive().optional() }).refine((value) => !value.startDate || !value.endDate || value.startDate <= value.endDate, { message: "تاريخ بداية الفترة يجب ألا يتجاوز نهايتها." })).query(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "viewer"]);
      return listSupabaseExpensePage(input.siteId, input, access.tenantId);
    }),
    create: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(),
      generatorId: z.number().int().positive().optional(),
      companyAccountId: z.number().int().positive(),
      category: z.enum(["fuel", "maintenance", "payroll", "parts", "transport", "other"]),
      description: z.string().min(2).max(255),
      amount: z.number().positive(),
      referenceNo: z.string().max(120).optional(),
    })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, createRoles, "manageExpenses");
      const { data, error } = await supabaseAdmin().rpc("powerhub_create_expense_with_account", {
        p_tenant_id: access.tenantId,
        p_site_id: input.siteId,
        p_user_id: ctx.user.id,
        p_generator_id: input.generatorId ?? null,
        p_company_account_id: input.companyAccountId,
        p_category: input.category,
        p_description: input.description,
        p_amount: input.amount,
        p_reference_no: input.referenceNo ?? null,
      });
      if (!error && data?.[0]) {
        return {
          id: Number((data[0] as { expense_id: number | string }).expense_id),
          transactionId: Number((data[0] as { transaction_id: number | string }).transaction_id),
        };
      }
      const errorText = `${error?.code ?? ""} ${error?.message ?? ""}`;
      if (error?.code === "PGRST202" || /powerhub_create_expense_with_account.*schema cache|schema cache.*powerhub_create_expense_with_account/i.test(errorText)) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "دالة تسجيل المصروفات غير متاحة في مخطط Supabase. تم تحديث إعدادات قاعدة البيانات؛ حدّث الصفحة وأعد المحاولة." });
      if (errorText.includes("SITE_OUT_OF_SCOPE")) throw new TRPCError({ code: "FORBIDDEN", message: "المحطة غير متاحة ضمن مساحة العمل الحالية." });
      if (errorText.includes("GENERATOR_OUT_OF_SCOPE")) throw new TRPCError({ code: "NOT_FOUND", message: "المولد لا يتبع للمحطة المحددة." });
      if (errorText.includes("COMPANY_ACCOUNT_NOT_FOUND")) throw new TRPCError({ code: "NOT_FOUND", message: "حساب الصرف غير موجود أو غير نشط." });
      if (errorText.includes("COMPANY_ACCOUNT_OUT_OF_SCOPE")) throw new TRPCError({ code: "FORBIDDEN", message: "حساب الصرف غير مرتبط بالفرع المحدد." });
      if (errorText.includes("INSUFFICIENT_ACCOUNT_BALANCE")) throw new TRPCError({ code: "BAD_REQUEST", message: "رصيد حساب الصرف لا يكفي لتسجيل هذا المصروف." });
      if (errorText.includes("FINANCIAL_PERIOD_LOCKED")) throw new TRPCError({ code: "FORBIDDEN", message: "الفترة المالية مقفلة؛ لا يمكن تعديل أو إضافة بيانات مالية داخلها." });
      if (errorText.includes("INVALID_EXPENSE_AMOUNT") || errorText.includes("INVALID_EXPENSE_CATEGORY")) throw new TRPCError({ code: "BAD_REQUEST", message: "بيانات المصروف غير صالحة." });
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تسجيل المصروف في Supabase." });
    }),
  }),

  dashboard: router({
    summary: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "collector", "technician", "viewer"]);
      return getSupabaseDashboardSummary(input.siteId, access.tenantId);
    }),
    allBranchesSummary: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      const access = await requireSupabaseAllBranchesRole(ctx.user.id, input.siteId, ["manager", "accountant", "viewer"]);
      const admin = supabaseAdmin();
      const { data: branchRows, error: branchesError } = await admin.from("sites").select("id").eq("tenant_id", access.tenantId).neq("status", "archived");
      if (branchesError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل فروع المستأجر من Supabase." });
      const branchIds = (branchRows ?? []).map((branch) => Number(branch.id));
      if (!branchIds.length) return { branchCount: 0, subscribers: 0, generators: { active: 0, maintenance: 0 }, financial: { invoiced: 0, collected: 0, outstanding: 0, expenses: 0, operatingProfit: 0 }, energyKwh: 0, failedNotifications: 0 };
      const [subscriberRows, generatorRows, invoiceRows, expenseRows] = await Promise.all([
        readSupabaseReportPages((from, to) => admin.from("subscribers").select("id, service_status").eq("tenant_id", access.tenantId).in("site_id", branchIds).is("archived_at", null).order("id", { ascending: true }).range(from, to), "تعذر تحميل المشتركين لملخص جميع الأفرع من Supabase."),
        readSupabaseReportPages((from, to) => admin.from("generators").select("status").eq("tenant_id", access.tenantId).in("site_id", branchIds).order("id", { ascending: true }).range(from, to), "تعذر تحميل المولدات لملخص جميع الأفرع من Supabase."),
        readSupabaseReportPages((from, to) => admin.from("invoices").select("status, total_amount, paid_amount, balance_due, consumption_kwh").eq("tenant_id", access.tenantId).in("site_id", branchIds).neq("status", "cancelled").neq("status", "draft").order("id", { ascending: true }).range(from, to), "تعذر تحميل الفواتير لملخص جميع الأفرع من Supabase."),
        readSupabaseReportPages((from, to) => admin.from("expenses").select("amount").eq("tenant_id", access.tenantId).in("site_id", branchIds).order("id", { ascending: true }).range(from, to), "تعذر تحميل المصروفات لملخص جميع الأفرع من Supabase."),
      ]);
      const subscriberIds = subscriberRows.map((row) => Number(row.id)).filter(Number.isInteger);
      const notificationRows: Array<{ status: string }> = [];
      // Bound concurrency to four batches; large tenants should not fan out hundreds of requests at once.
      for (let offset = 0; offset < subscriberIds.length; offset += 800) {
        const notificationPageRequests: Array<Promise<Array<{ status: string }>>> = [];
        const batchEnd = Math.min(offset + 800, subscriberIds.length);
        for (let batchOffset = offset; batchOffset < batchEnd; batchOffset += 200) {
          const subscriberIdBatch = subscriberIds.slice(batchOffset, batchOffset + 200);
          notificationPageRequests.push(readSupabaseReportPages(
            (from, to) => admin.from("notification_messages").select("status").eq("tenant_id", access.tenantId).in("subscriber_id", subscriberIdBatch).order("id", { ascending: true }).range(from, to),
            "تعذر تحميل حالات الإشعارات لجميع الأفرع من Supabase.",
          ));
        }
        notificationRows.push(...(await Promise.all(notificationPageRequests)).flat());
      }
      const invoiceTotals = invoiceRows.reduce((totals, row) => ({
        invoiced: totals.invoiced + Number(row.total_amount ?? 0),
        paid: totals.paid + Number(row.paid_amount ?? 0),
        outstanding: totals.outstanding + Number(row.balance_due ?? 0),
        energy: totals.energy + Number(row.consumption_kwh ?? 0),
      }), { invoiced: 0, paid: 0, outstanding: 0, energy: 0 });
      const expensesTotal = expenseRows.reduce((total, row) => total + Number(row.amount ?? 0), 0);
      return {
        branchCount: branchIds.length,
        subscribers: subscriberRows.filter((row) => row.service_status === "active").length,
        generators: { active: generatorRows.filter((row) => row.status === "active").length, maintenance: generatorRows.filter((row) => row.status === "maintenance").length },
        financial: { invoiced: invoiceTotals.invoiced, collected: invoiceTotals.paid, outstanding: invoiceTotals.outstanding, expenses: expensesTotal, operatingProfit: invoiceTotals.paid - expensesTotal },
        energyKwh: invoiceTotals.energy,
        failedNotifications: notificationRows.filter((row) => row.status === "failed").length,
      };
    }),
    financialOverview: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(),
      scope: z.enum(["branch", "all"]).default("branch"),
    })).query(async ({ ctx, input }) => {
      await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "viewer"]);
      if (input.scope === "branch") {
        const site = await getSupabaseSite(input.siteId);
        return getSupabaseFinancialOverview(site);
      }
      const access = await requireSupabaseAllBranchesRole(ctx.user.id, input.siteId, ["manager", "accountant", "viewer"]);
      const admin = supabaseAdmin();
      const { data: branchRows, error: branchesError } = await admin.from("sites").select("id, name").eq("tenant_id", access.tenantId).neq("status", "archived").order("created_at", { ascending: false });
      if (branchesError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل فروع التقرير المالي من Supabase." });
      const branchIds = (branchRows ?? []).map((branch) => Number(branch.id));
      if (!branchIds.length) return buildFinancialOverview({ branches: [], invoices: [], payments: [], expenses: [] });
      const [invoiceRows, paymentRows, expenseRows, subscriberRows] = await Promise.all([
        readSupabaseReportPages((from, to) => admin.from("invoices").select("id, site_id, subscriber_id, invoice_no, issue_date, due_date, total_amount, paid_amount, balance_due, status").eq("tenant_id", access.tenantId).in("site_id", branchIds).not("status", "in", "(cancelled,draft)").order("id", { ascending: true }).range(from, to), "تعذر تحميل فواتير ملخص جميع الأفرع من Supabase."),
        readSupabaseReportPages((from, to) => admin.from("payments").select("site_id, subscriber_id, amount, status, paid_at").eq("tenant_id", access.tenantId).in("site_id", branchIds).order("id", { ascending: true }).range(from, to), "تعذر تحميل تحصيلات ملخص جميع الأفرع من Supabase."),
        readSupabaseReportPages((from, to) => admin.from("expenses").select("site_id, amount, occurred_at").eq("tenant_id", access.tenantId).in("site_id", branchIds).order("id", { ascending: true }).range(from, to), "تعذر تحميل مصروفات ملخص جميع الأفرع من Supabase."),
        readSupabaseReportPages((from, to) => admin.from("subscribers").select("id, site_id, full_name, subscriber_no, service_status").eq("tenant_id", access.tenantId).in("site_id", branchIds).order("id", { ascending: true }).range(from, to), "تعذر تحميل المشتركين لملخص جميع الأفرع من Supabase."),
      ]);
      const subscribersById = new Map(subscriberRows.map((subscriber) => [Number(subscriber.id), subscriber]));
      const subscriberCountBySite = new Map<number, number>();
      for (const subscriber of subscriberRows) { if (subscriber.service_status === "active") { const siteId = Number(subscriber.site_id); subscriberCountBySite.set(siteId, (subscriberCountBySite.get(siteId) ?? 0) + 1); } }
      return buildFinancialOverview({
        branches: (branchRows ?? []).map((branch) => ({ id: Number(branch.id), name: branch.name, activeSubscribers: subscriberCountBySite.get(Number(branch.id)) ?? 0 })),
        invoices: invoiceRows.flatMap((invoice) => {
          const subscriber = subscribersById.get(Number(invoice.subscriber_id));
          return subscriber ? [{ id: Number(invoice.id), siteId: Number(invoice.site_id), subscriberId: Number(invoice.subscriber_id), subscriberName: subscriber.full_name, subscriberNo: subscriber.subscriber_no, invoiceNo: invoice.invoice_no, issueDate: new Date(invoice.issue_date), dueDate: new Date(invoice.due_date), totalAmount: Number(invoice.total_amount), paidAmount: Number(invoice.paid_amount), balanceDue: Number(invoice.balance_due), status: invoice.status }] : [];
        }),
        payments: paymentRows.map((payment) => ({ siteId: Number(payment.site_id), subscriberId: Number(payment.subscriber_id), amount: Number(payment.amount), status: payment.status, paidAt: new Date(payment.paid_at) })),
        expenses: expenseRows.map((expense) => ({ siteId: Number(expense.site_id), amount: Number(expense.amount), occurredAt: new Date(expense.occurred_at) })),
      });
    }),

    periodMetrics: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(),
      scope: z.enum(["branch", "all"]).default("branch"),
      startDate: paymentDocumentationDateKeySchema,
      endDate: paymentDocumentationDateKeySchema,
      includeDetails: z.boolean().default(true),
    }).refine((input) => input.startDate <= input.endDate, {
      message: "يجب أن يكون تاريخ بداية الفترة قبل تاريخ نهايتها أو مساوياً لها.",
    })).query(async ({ ctx, input }) => {
      let tenantId: number;
      let siteRows: Array<{ id: number; name: string }>;
      if (input.scope === "branch") {
        const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "viewer"]);
        tenantId = access.tenantId;
        const { data, error } = await supabaseAdmin().from("sites")
          .select("id, name")
          .eq("tenant_id", tenantId)
          .eq("id", input.siteId)
          .neq("status", "archived")
          .limit(1);
        if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل بيانات الفرع لمؤشرات الفترة." });
        siteRows = (data ?? []).map((row) => ({ id: Number(row.id), name: String(row.name ?? "فرع غير محدد") }));
      } else {
        const access = await requireSupabaseAllBranchesRole(ctx.user.id, input.siteId, ["manager", "accountant", "viewer"]);
        tenantId = access.tenantId;
        const { data, error } = await supabaseAdmin().from("sites")
          .select("id, name")
          .eq("tenant_id", tenantId)
          .neq("status", "archived")
          .order("created_at", { ascending: true });
        if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل الأفرع لمؤشرات الفترة." });
        siteRows = (data ?? []).map((row) => ({ id: Number(row.id), name: String(row.name ?? "فرع غير محدد") }));
      }

      const siteIds = siteRows.map((site) => site.id);
      // Date filters are entered and displayed in the Gaza billing timezone; use its exact local day boundaries.
      const start = paymentDocumentationGazaDateBoundary(input.startDate);
      const endExclusive = paymentDocumentationGazaDateBoundary(paymentDocumentationNextDateKey(input.endDate));
      if (!siteIds.length) {
        return buildDashboardPeriodMetrics({
          scope: input.scope,
          startDate: input.startDate,
          endDate: input.endDate,
          invoices: [],
          payments: [],
        });
      }

      const [invoiceRows, paymentRows] = await Promise.all([
        listSupabaseReportInvoices({ tenantId, siteIds, start, endExclusive, summaryOnly: !input.includeDetails }),
        listSupabaseReportPayments({ tenantId, siteIds, start, endExclusive, summaryOnly: !input.includeDetails }),
      ]);
      const eligibleInvoices = invoiceRows.filter((invoice) => invoice.status !== "cancelled" && invoice.status !== "draft");
      // The dashboard needs only four aggregate KPIs. Avoid a second large subscriber lookup
      // and invoice-detail serialization until the user opens the arrears workspace.
      const subscriberRows = input.includeDetails
        ? await listSupabaseReportSubscribers({
            tenantId,
            siteIds,
            subscriberIds: eligibleInvoices.map((invoice) => invoice.subscriberId),
          })
        : [];
      const subscribersById = new Map(subscriberRows.map((subscriber) => [subscriber.id, subscriber]));
      const branchNameById = new Map(siteRows.map((site) => [site.id, site.name]));
      const invoices = eligibleInvoices.map((invoice) => {
        const subscriber = subscribersById.get(invoice.subscriberId);
        return {
          id: invoice.id,
          siteId: invoice.siteId,
          siteName: branchNameById.get(invoice.siteId) ?? "فرع غير محدد",
          subscriberId: invoice.subscriberId,
          subscriberName: subscriber?.fullName ?? "مشترك غير محدد",
          subscriberNo: subscriber?.subscriberNo ?? "—",
          invoiceNo: invoice.invoiceNo,
          issueDate: invoice.issueDate,
          dueDate: invoice.dueDate,
          totalAmount: invoice.totalAmount,
          paidAmount: invoice.paidAmount,
          balanceDue: invoice.balanceDue,
          status: invoice.status,
        };
      });

      return buildDashboardPeriodMetrics({
        scope: input.scope,
        startDate: input.startDate,
        endDate: input.endDate,
        invoices,
        payments: paymentRows.map(({ payment }) => ({ status: payment.status, amount: payment.amount })),
        includeDetails: input.includeDetails,
      });
    }),
  }),

  settlements: router({
    list: protectedProcedure.input(siteScoped.extend({ branchId: z.number().int().positive().optional(), allBranches: z.boolean().optional() })).query(async ({ ctx, input }) => { const targetSiteId=input.branchId??input.siteId; const access=input.allBranches?await requireSupabaseAllBranchesRole(ctx.user.id,input.siteId,["manager","accountant","viewer"]):await requireSupabaseSiteRole(ctx.user.id,targetSiteId,["owner","manager","accountant","viewer"]); const {data,error}=await supabaseAdmin().from("financial_settlements").select("id, tenant_id, site_id, period_start, period_end, total_collected, total_expenses, book_profit, actual_cash, difference, notes, status, created_by_user_id, approved_by_user_id, locked_at, created_at, updated_at").eq("tenant_id",access.tenantId).in("site_id",input.allBranches?(await supabaseAdmin().from("sites").select("id").eq("tenant_id",access.tenantId).neq("status","archived")).data?.map((site)=>Number(site.id))??[]:[targetSiteId]).order("period_start",{ascending:false}).limit(300); if(error) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"تعذر تحميل التسويات المالية من Supabase."}); return (data??[]).map((row)=>({id:Number(row.id),tenantId:Number(row.tenant_id),siteId:Number(row.site_id),periodStart:new Date(row.period_start),periodEnd:new Date(row.period_end),totalCollected:String(row.total_collected),totalExpenses:String(row.total_expenses),bookProfit:String(row.book_profit),actualCash:row.actual_cash===null?null:String(row.actual_cash),difference:row.difference===null?null:String(row.difference),notes:row.notes,status:row.status,createdByUserId:Number(row.created_by_user_id),approvedByUserId:row.approved_by_user_id===null?null:Number(row.approved_by_user_id),lockedAt:row.locked_at?new Date(row.locked_at):null,createdAt:new Date(row.created_at),updatedAt:new Date(row.updated_at)})); }),
    create: protectedProcedure.input(z.object({ siteId:z.number().int().positive(), periodStart:z.string().datetime(), periodEnd:z.string().datetime(), totalCollected:z.number().nonnegative(), totalExpenses:z.number().nonnegative(), actualCash:z.number().nonnegative().optional(), notes:z.string().max(2000).optional() })).mutation(async ({ctx,input})=>{ const access=await requireSupabaseSiteRole(ctx.user.id,input.siteId,["owner","manager","accountant"],"manageExpenses"); const {data,error}=await supabaseAdmin().rpc("powerhub_create_financial_settlement",{p_tenant_id:access.tenantId,p_site_id:input.siteId,p_user_id:ctx.user.id,p_period_start:input.periodStart,p_period_end:input.periodEnd,p_total_collected:input.totalCollected,p_total_expenses:input.totalExpenses,p_actual_cash:input.actualCash??null,p_notes:input.notes??null}); if(error) throw new TRPCError({code:"BAD_REQUEST",message:error.message.includes("INVALID_SETTLEMENT_PERIOD")?"بداية الفترة يجب أن تسبق نهايتها.":error.message.includes("SETTLEMENT_PERIOD_OVERLAPS_LOCKED")?"تتداخل الفترة مع تسوية مقفلة.":"تعذر إنشاء التسوية المالية."}); const id=Number((data as Array<{settlement_id:number}>|null)?.[0]?.settlement_id); if(!id) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"لم تُعد دالة التسوية معرفاً صالحاً."}); return {id}; }),
    exceptionalEdit: protectedProcedure.input(z.object({ siteId:z.number().int().positive(), entityType:z.enum(["invoice","payment","expense"]), entityId:z.number().int().positive(), reason:z.string().trim().min(10,"سبب التصحيح يجب ألا يقل عن 10 أحرف.").max(1000), changes:z.object({ description:z.string().trim().min(2).max(255).optional(), referenceNo:z.string().trim().max(120).optional(), dueDate:z.date().optional(), category:z.enum(["fuel","maintenance","payroll","parts","transport","other"]).optional() }).refine((value)=>Object.keys(value).length>0,{message:"أدخل حقلاً واحداً على الأقل للتعديل."}) })).mutation(async({ctx,input})=>{ const access=await requireSupabaseSiteRole(ctx.user.id,input.siteId,["manager"],"manageExpenses"); const {data,error}=await supabaseAdmin().rpc("powerhub_exceptional_locked_edit",{p_tenant_id:access.tenantId,p_site_id:input.siteId,p_user_id:ctx.user.id,p_entity_type:input.entityType,p_entity_id:input.entityId,p_reason:input.reason,p_description:input.changes.description??null,p_reference_no:input.changes.referenceNo??null,p_due_date:input.changes.dueDate?.toISOString()??null,p_category:input.changes.category??null}); if(error) throw new TRPCError({code:error.message.includes("OUT_OF_SCOPE")?"NOT_FOUND":"BAD_REQUEST",message:error.message.includes("NOT_LOCKED")?"هذه العملية ليست ضمن فترة مقفلة.":error.message.includes("INVALID_EXCEPTIONAL_FIELDS")?"الحقول المسموح تعديلها لهذا النوع غير موجودة.":"تعذر تنفيذ التصحيح الاستثنائي."}); const result=(data as Array<{before_data:unknown;after_data:unknown}>|null)?.[0]; if(!result) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"لم تُعد دالة التصحيح استجابة صالحة."}); return {success:true,before:result.before_data,after:result.after_data}; }),
    setStatus: protectedProcedure.input(z.object({ siteId:z.number().int().positive(), settlementId:z.number().int().positive(), status:z.enum(["submitted","approved","locked"]) })).mutation(async({ctx,input})=>{ const access=await requireSupabaseSiteRole(ctx.user.id,input.siteId,["owner","manager","accountant"],"manageExpenses"); const {data,error}=await supabaseAdmin().rpc("powerhub_set_financial_settlement_status",{p_tenant_id:access.tenantId,p_site_id:input.siteId,p_user_id:ctx.user.id,p_settlement_id:input.settlementId,p_status:input.status}); if(error) throw new TRPCError({code:error.message.includes("OUT_OF_SCOPE")?"NOT_FOUND":"BAD_REQUEST",message:error.message.includes("ALREADY_LOCKED")?"التسوية مقفلة ولا يمكن تعديلها.":error.message.includes("MUST_BE_APPROVED")?"يجب اعتماد التسوية قبل قفلها.":"تعذر تحديث حالة التسوية."}); if(!Number((data as Array<{settlement_id:number}>|null)?.[0]?.settlement_id)) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"لم تُعد دالة التسوية استجابة صالحة."}); return {success:true}; }),
  }),
  reports: router({
    range: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(),
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      paymentMethod: z.string().optional(),
    }).refine((input) => input.startDate <= input.endDate, { message: "يجب أن يكون تاريخ البداية قبل تاريخ النهاية." })).query(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "viewer"]);
      const { start, endExclusive } = reportDateRange(input.startDate, input.endDate);
      const [allInvoices, paymentRows, expenseRows] = await Promise.all([
        listSupabaseReportInvoices({ tenantId: access.tenantId, siteIds: [input.siteId], start, endExclusive }),
        listSupabaseReportPayments({ tenantId: access.tenantId, siteIds: [input.siteId], start, endExclusive }),
        listSupabaseReportExpenses({ tenantId: access.tenantId, siteIds: [input.siteId], start, endExclusive }),
      ]);
      const invoiceRows = allInvoices.filter((invoice) => invoice.status !== "cancelled" && invoice.issueDate >= start && invoice.issueDate < endExclusive);
      const completedPayments = paymentRows.filter(({ payment }) => payment.status === "completed" && payment.paidAt >= start && payment.paidAt < endExclusive && (!input.paymentMethod || input.paymentMethod === "all" || payment.paymentMethod === input.paymentMethod));
      const collectorsIds = Array.from(new Set(completedPayments.flatMap(({ payment }) => payment.collectedByUserId === null ? [] : [payment.collectedByUserId])));
      const [collectorRows, subscriberRows] = await Promise.all([
        collectorsIds.length ? supabaseAdmin().from("users").select("id, name, email").in("id", collectorsIds) : Promise.resolve({ data: [], error: null }),
        listSupabaseReportSubscribers({ tenantId: access.tenantId, siteIds: [input.siteId], subscriberIds: invoiceRows.map((invoice) => invoice.subscriberId) }),
      ]);
      if (collectorRows.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل أسماء المحصلين من Supabase." });
      const collectorsById = new Map((collectorRows.data ?? []).map((collector) => [Number(collector.id), collector.name || collector.email || "محصل غير محدد"]));
      const subscribersById = new Map(subscriberRows.map((subscriber) => [subscriber.id, subscriber]));
      const invoiced = invoiceRows.reduce((sum, invoice) => sum + invoice.totalAmount, 0);
      const outstanding = invoiceRows.reduce((sum, invoice) => sum + invoice.balanceDue, 0);
      const energyKwh = invoiceRows.reduce((sum, invoice) => sum + invoice.consumptionKwh, 0);
      const collected = completedPayments.reduce((sum, row) => sum + Number(row.payment.amount), 0);
      const expenseTotal = expenseRows.filter((expense) => expense.occurredAt >= start && expense.occurredAt < endExclusive).reduce((sum, expense) => sum + expense.amount, 0);
      const collectors = Object.values(completedPayments.reduce<Record<string, { name: string; count: number; amount: number }>>((acc, row) => {
        const key = String(row.payment.collectedByUserId ?? 0);
        const entry = acc[key] ?? { name: collectorsById.get(row.payment.collectedByUserId ?? 0) ?? "محصل غير محدد", count: 0, amount: 0 };
        entry.count += 1;
        entry.amount += Number(row.payment.amount);
        acc[key] = entry;
        return acc;
      }, {})).sort((a, b) => b.amount - a.amount);
      const topDebtors = invoiceRows.filter((invoice) => invoice.balanceDue > 0).sort((a, b) => b.balanceDue - a.balanceDue).slice(0, 10).map((invoice) => ({
        subscriber: subscribersById.get(invoice.subscriberId)?.fullName ?? "مشترك",
        subscriberNo: subscribersById.get(invoice.subscriberId)?.subscriberNo ?? "—",
        invoiceNo: invoice.invoiceNo,
        balanceDue: invoice.balanceDue,
        dueDate: invoice.dueDate,
      }));
      const paymentDetails = completedPayments.map(({ payment }) => ({
        paymentNo: payment.paymentNo, amount: Number(payment.amount), paymentMethod: payment.paymentMethod,
        paidAt: payment.paidAt, transferFromAccount: payment.transferFromAccount, transferFromType: payment.transferFromType,
        transferToAccount: payment.transferToAccount, transferToType: payment.transferToType,
      }));
      return { range: { startDate: input.startDate, endDate: input.endDate }, summary: { invoiced, collected, outstanding, energyKwh, expenseTotal, operatingProfit: collected - expenseTotal }, collectors, topDebtors, paymentDetails };
    }),
    allBranchesRange: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(),
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }).refine((input) => input.startDate <= input.endDate, { message: "يجب أن يكون تاريخ البداية قبل تاريخ النهاية." })).query(async ({ ctx, input }) => {
      const { tenantId } = await requireSupabaseAllBranchesRole(ctx.user.id, input.siteId, ["manager", "accountant", "viewer"]);
      const { start, endExclusive } = reportDateRange(input.startDate, input.endDate);
      const { data: siteRows, error: sitesError } = await supabaseAdmin().from("sites").select("id, name").eq("tenant_id", tenantId).neq("status", "archived");
      if (sitesError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل أفرع المستأجر من Supabase." });
      const branchRows = (siteRows ?? []).map((site) => ({ id: Number(site.id), name: site.name }));
      const branchIds = branchRows.map((branch) => branch.id);
      if (!branchIds.length) return { range: { startDate: input.startDate, endDate: input.endDate }, scope: { branchCount: 0 }, summary: { invoiced: 0, collected: 0, outstanding: 0, energyKwh: 0, expenseTotal: 0, operatingProfit: 0 }, collectors: [], topDebtors: [], branchSummaries: [] };
      const [allInvoices, paymentRows, expenseRows] = await Promise.all([
        listSupabaseReportInvoices({ tenantId, siteIds: branchIds, start, endExclusive }),
        listSupabaseReportPayments({ tenantId, siteIds: branchIds, start, endExclusive }),
        listSupabaseReportExpenses({ tenantId, siteIds: branchIds, start, endExclusive }),
      ]);
      const invoiceRows = allInvoices.filter((invoice) => invoice.status !== "cancelled" && invoice.issueDate >= start && invoice.issueDate < endExclusive);
      const completedPayments = paymentRows.filter(({ payment }) => payment.status === "completed" && payment.paidAt >= start && payment.paidAt < endExclusive);
      const subscribers = await listSupabaseReportSubscribers({ tenantId, siteIds: branchIds, subscriberIds: invoiceRows.map((invoice) => invoice.subscriberId) });
      const subscribersById = new Map(subscribers.map((subscriber) => [subscriber.id, subscriber]));
      const branchNameById = new Map(branchRows.map((branch) => [branch.id, branch.name]));
      const branchSummaryById = new Map(branchRows.map((branch) => [branch.id, { siteId: branch.id, branchName: branch.name, invoiced: 0, collected: 0, outstanding: 0, energyKwh: 0, expenseTotal: 0, operatingProfit: 0 }]));
      invoiceRows.forEach((invoice) => {
        const summary = branchSummaryById.get(invoice.siteId);
        if (!summary) return;
        summary.invoiced += invoice.totalAmount;
        summary.outstanding += invoice.balanceDue;
        summary.energyKwh += invoice.consumptionKwh;
      });
      completedPayments.forEach(({ payment }) => {
        const summary = branchSummaryById.get(payment.siteId);
        if (summary) summary.collected += Number(payment.amount);
      });
      expenseRows.filter((expense) => expense.occurredAt >= start && expense.occurredAt < endExclusive).forEach((expense) => {
        const summary = branchSummaryById.get(expense.siteId);
        if (summary) summary.expenseTotal += expense.amount;
      });
      const branchSummaries = Array.from(branchSummaryById.values()).map((summary) => ({ ...summary, operatingProfit: summary.collected - summary.expenseTotal }));
      const summary = branchSummaries.reduce((total, branch) => ({
        invoiced: total.invoiced + branch.invoiced, collected: total.collected + branch.collected,
        outstanding: total.outstanding + branch.outstanding, energyKwh: total.energyKwh + branch.energyKwh,
        expenseTotal: total.expenseTotal + branch.expenseTotal, operatingProfit: total.operatingProfit + branch.operatingProfit,
      }), { invoiced: 0, collected: 0, outstanding: 0, energyKwh: 0, expenseTotal: 0, operatingProfit: 0 });
      const collectors = Object.values(completedPayments.reduce<Record<string, { name: string; count: number; amount: number }>>((acc, row) => {
        const key = String(row.payment.collectedByUserId ?? 0);
        const entry = acc[key] ?? { name: "محصل غير محدد", count: 0, amount: 0 };
        entry.count += 1;
        entry.amount += Number(row.payment.amount);
        acc[key] = entry;
        return acc;
      }, {})).sort((a, b) => b.amount - a.amount);
      const topDebtors = invoiceRows.filter((invoice) => invoice.balanceDue > 0).sort((a, b) => b.balanceDue - a.balanceDue).slice(0, 10).map((invoice) => ({
        branchName: branchNameById.get(invoice.siteId) ?? "فرع غير محدد",
        subscriber: subscribersById.get(invoice.subscriberId)?.fullName ?? "مشترك",
        subscriberNo: subscribersById.get(invoice.subscriberId)?.subscriberNo ?? "—",
        invoiceNo: invoice.invoiceNo, balanceDue: invoice.balanceDue, dueDate: invoice.dueDate,
      }));
      const paymentDetails = completedPayments.map(({ payment }) => ({
        siteId: payment.siteId, paymentNo: payment.paymentNo, amount: Number(payment.amount),
        paymentMethod: payment.paymentMethod, paidAt: payment.paidAt,
        transferFromAccount: payment.transferFromAccount, transferFromType: payment.transferFromType,
        transferToAccount: payment.transferToAccount, transferToType: payment.transferToType,
      }));
      return { range: { startDate: input.startDate, endDate: input.endDate }, scope: { branchCount: branchIds.length }, summary, collectors, topDebtors, branchSummaries, paymentDetails };
    }),
    monthly: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), billingPeriod: z.string().regex(/^\d{4}-\d{2}$/) })).query(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "viewer"]);
      const start = new Date(`${input.billingPeriod}-01T00:00:00.000Z`);
      if (Number.isNaN(start.getTime()) || start.toISOString().slice(0, 7) !== input.billingPeriod) throw new TRPCError({ code: "BAD_REQUEST", message: "فترة التقرير الشهري غير صالحة." });
      const endExclusive = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
      const [allInvoices, periodPayments, periodExpenses] = await Promise.all([
        listSupabaseReportInvoices({ tenantId: access.tenantId, siteIds: [input.siteId], billingPeriod: input.billingPeriod }),
        listSupabaseReportPayments({ tenantId: access.tenantId, siteIds: [input.siteId], start, endExclusive }),
        listSupabaseReportExpenses({ tenantId: access.tenantId, siteIds: [input.siteId], start, endExclusive }),
      ]);
      const invoiceRows = allInvoices.filter((invoice) => invoice.billingPeriod === input.billingPeriod && invoice.status !== "cancelled");
      const collectorIds = Array.from(new Set(periodPayments.flatMap(({ payment }) => payment.collectedByUserId === null ? [] : [payment.collectedByUserId])));
      const [collectorRows, subscriberRows] = await Promise.all([
        collectorIds.length ? supabaseAdmin().from("users").select("id, name, email").in("id", collectorIds) : Promise.resolve({ data: [], error: null }),
        listSupabaseReportSubscribers({ tenantId: access.tenantId, siteIds: [input.siteId], subscriberIds: invoiceRows.map((invoice) => invoice.subscriberId) }),
      ]);
      if (collectorRows.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل أسماء المحصلين من Supabase." });
      const collectorsById = new Map((collectorRows.data ?? []).map((collector) => [Number(collector.id), collector.name || collector.email || "محصل غير محدد"]));
      const subscribersById = new Map(subscriberRows.map((subscriber) => [subscriber.id, subscriber]));
      const invoiced = invoiceRows.reduce((sum, invoice) => sum + invoice.totalAmount, 0);
      const outstanding = invoiceRows.reduce((sum, invoice) => sum + invoice.balanceDue, 0);
      const energyKwh = invoiceRows.reduce((sum, invoice) => sum + invoice.consumptionKwh, 0);
      const collected = periodPayments.filter((row) => row.payment.status === "completed").reduce((sum, row) => sum + Number(row.payment.amount), 0);
      const expenseTotal = periodExpenses.reduce((sum, row) => sum + row.amount, 0);
      const collectors = Object.values(periodPayments.reduce<Record<string, { name: string; count: number; amount: number }>>((acc, row) => {
        const key = String(row.payment.collectedByUserId ?? 0);
        const entry = acc[key] ?? { name: collectorsById.get(row.payment.collectedByUserId ?? 0) ?? "محصل غير محدد", count: 0, amount: 0 };
        entry.count += 1;
        entry.amount += Number(row.payment.amount);
        acc[key] = entry;
        return acc;
      }, {})).sort((a, b) => b.amount - a.amount);
      const topDebtors = invoiceRows.filter((invoice) => invoice.balanceDue > 0).sort((a, b) => b.balanceDue - a.balanceDue).slice(0, 10).map((invoice) => ({
        subscriber: subscribersById.get(invoice.subscriberId)?.fullName ?? "مشترك",
        subscriberNo: subscribersById.get(invoice.subscriberId)?.subscriberNo ?? "—",
        invoiceNo: invoice.invoiceNo, balanceDue: invoice.balanceDue, dueDate: invoice.dueDate,
      }));
      return { summary: { invoiced, collected, outstanding, energyKwh, expenseTotal, operatingProfit: collected - expenseTotal }, collectors, topDebtors };
    }),
  }),

  reportBranding: router({
    get: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      const access = await resolveSupabaseSiteAccess(ctx.user.id, input.siteId);
      const { data: profile, error } = await supabaseAdmin().from("tenant_owner_profiles")
        .select("company_name, report_logo_key")
        .eq("tenant_id", access.tenantId)
        .maybeSingle();
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل هوية التقارير من Supabase." });
      const logoUrl = profile?.report_logo_key ? (await storageGet(profile.report_logo_key)).url : null;
      return { companyName: profile?.company_name ?? null, reportLogoKey: profile?.report_logo_key ?? null, logoUrl };
    }),
    update: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(),
      companyName: z.string().trim().min(2).max(180).optional(),
      logoData: z.string().min(20).max(4_500_000).optional(),
      logoMime: z.enum(["image/png", "image/jpeg", "image/webp"]).optional(),
    }).refine((input) => Boolean(input.companyName || (input.logoData && input.logoMime)), { message: "أدخل اسم الشركة أو اختر شعاراً صالحاً للتحديث." }).refine((input) => !input.logoData || Boolean(input.logoMime), { message: "تعذر التعرف إلى نوع ملف الشعار." })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner"], "manageTeam");
      let reportLogoKey: string | undefined;
      if (input.logoData && input.logoMime) {
        const bytes = Buffer.from(input.logoData, "base64");
        if (!bytes.length || bytes.length > 3 * 1024 * 1024) throw new TRPCError({ code: "BAD_REQUEST", message: "يجب ألا يتجاوز حجم شعار التقرير 3 ميغابايت." });
        const extension = input.logoMime === "image/png" ? "png" : input.logoMime === "image/jpeg" ? "jpg" : "webp";
        const uploaded = await storagePut(`tenant-report-branding/${access.tenantId}/logo-${Date.now()}.${extension}`, bytes, input.logoMime);
        reportLogoKey = uploaded.key;
      }
      const { data, error } = await supabaseAdmin().rpc("powerhub_update_report_branding", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id, p_company_name: input.companyName ?? null, p_report_logo_key: reportLogoKey ?? null,
      });
      const profile = (data as Array<{ company_name: string | null; report_logo_key: string | null }> | null)?.[0];
      if (!error && profile) {
        const logoUrl = profile.report_logo_key ? (await storageGet(profile.report_logo_key)).url : null;
        return { companyName: profile.company_name, reportLogoKey: profile.report_logo_key, logoUrl };
      }
      if (reportLogoKey) await storageRemove(reportLogoKey).catch(() => undefined);
      const errorText = `${error?.code ?? ""} ${error?.message ?? ""}`;
      if (errorText.includes("SITE_OUT_OF_SCOPE")) throw new TRPCError({ code: "FORBIDDEN", message: "الفرع غير تابع لمساحة الشركة." });
      if (errorText.includes("OWNER_PROFILE_NOT_FOUND")) throw new TRPCError({ code: "NOT_FOUND", message: "ملف مالك المولد غير موجود." });
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر حفظ هوية التقارير في Supabase." });
    }),
  }),

  notifications: router({
    list: protectedProcedure.input(siteScoped.extend({ eventType: z.enum(["invoice_issued", "payment_reminder", "payment_received", "service_alert", "subscriber_reference"]).optional(), channel: z.enum(["sms", "whatsapp"]).optional(), statuses: z.array(z.enum(["pending", "processing", "submitted", "delivered", "read", "failed", "needs_review"])).max(7).optional(), invoiceIds: z.array(z.number().int().positive()).max(200).optional() })).query(async ({ ctx, input }) => {
      const scope = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "viewer"]);
      if (input.invoiceIds && input.invoiceIds.length === 0) return [];
      let notificationQuery = supabaseAdmin().from("notification_messages").select("id, tenant_id, invoice_id, subscriber_id, channel, event_type, recipient, status, provider_message_id, payload, attempts, last_error, scheduled_at, created_at, updated_at")
        .eq("tenant_id", scope.tenantId).order("created_at", { ascending: false }).limit(500);
      if (input.eventType) notificationQuery = notificationQuery.eq("event_type", input.eventType);
      if (input.invoiceIds) notificationQuery = notificationQuery.in("invoice_id", input.invoiceIds);
      if (input.channel) notificationQuery = notificationQuery.eq("channel", input.channel);
      if (input.statuses?.length) notificationQuery = notificationQuery.in("status", input.statuses);
      const { data: notificationRows, error: notificationsError } = await notificationQuery;
      if (notificationsError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل سجل الإشعارات من Supabase." });
      const subscriberIds = Array.from(new Set((notificationRows ?? []).map((row) => Number(row.subscriber_id)).filter(Number.isInteger)));
      const { data: subscriberRows, error: subscribersError } = subscriberIds.length
        ? await supabaseAdmin().from("subscribers").select("id, tenant_id, site_id, full_name, subscriber_no, phone").eq("tenant_id", scope.tenantId).eq("site_id", input.siteId).in("id", subscriberIds)
        : { data: [], error: null };
      if (subscribersError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل مشتركين سجل الإشعارات من Supabase." });
      const subscribersById = new Map((subscriberRows ?? []).map((row) => [Number(row.id), { id: Number(row.id), tenantId: Number(row.tenant_id), siteId: Number(row.site_id), fullName: row.full_name, subscriberNo: row.subscriber_no, phone: row.phone }]));
      const invoiceIds = Array.from(new Set((notificationRows ?? []).flatMap((row) => row.invoice_id === null ? [] : [Number(row.invoice_id)]).filter(Number.isInteger)));
      const { data: invoiceRows, error: invoicesError } = invoiceIds.length
        ? await supabaseAdmin().from("invoices").select("id, invoice_no, site_id").eq("site_id", input.siteId).in("id", invoiceIds)
        : { data: [], error: null };
      if (invoicesError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل فواتير سجل الإشعارات من Supabase." });
      const invoiceNoById = new Map((invoiceRows ?? []).map((row) => [Number(row.id), row.invoice_no]));
      return (notificationRows ?? []).flatMap((row) => {
        const subscriber = subscribersById.get(Number(row.subscriber_id));
        if (!subscriber) return [];
        return [{ notification: { id: Number(row.id), tenantId: Number(row.tenant_id), invoiceId: row.invoice_id === null ? null : Number(row.invoice_id), subscriberId: Number(row.subscriber_id), channel: row.channel, eventType: row.event_type, recipient: row.recipient, status: row.status, providerMessageId: row.provider_message_id, payload: row.payload, attempts: row.attempts, lastError: row.last_error, scheduledAt: row.scheduled_at ? new Date(row.scheduled_at) : null, createdAt: new Date(row.created_at), updatedAt: new Date(row.updated_at) }, subscriber, invoiceNo: row.invoice_id === null ? null : invoiceNoById.get(Number(row.invoice_id)) ?? null }];
      });
    }),
    countDueInvoiceNotifications: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      const scope = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "manageMessaging");
      const now = new Date().toISOString();
      const { count, error } = await supabaseAdmin().from("notification_messages")
        .select("id, subscribers!inner(site_id)", { count: "exact", head: true })
        .eq("tenant_id", scope.tenantId)
        .eq("subscribers.site_id", input.siteId)
        .eq("channel", "sms")
        .eq("event_type", "invoice_issued")
        .eq("status", "pending")
        .or(`scheduled_at.is.null,scheduled_at.lte.${now}`);
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر حساب رسائل الفواتير المستحقة للإرسال." });
      return { count: count ?? 0 };
    }),
    listFailedSms: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      const scope = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "manageMessaging");
      let query = supabaseAdmin().from("notification_messages")
        .select("id, tenant_id, invoice_id, subscriber_id, channel, event_type, recipient, status, provider_message_id, payload, attempts, last_error, created_at, updated_at, subscribers!inner(site_id)")
        .eq("tenant_id", scope.tenantId)
        .eq("subscribers.site_id", input.siteId)
        .eq("channel", "sms")
        .in("status", ["failed", "needs_review"])
        .order("created_at", { ascending: false })
        .limit(500);
      const { data, error } = await query;
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل رسائل SMS الفاشلة من Supabase." });
      const subscriberIds = Array.from(new Set((data ?? []).map((row) => Number(row.subscriber_id)).filter(Number.isInteger)));
      const invoiceIds = Array.from(new Set((data ?? []).map((row) => row.invoice_id === null ? null : Number(row.invoice_id)).filter((id): id is number => Number.isInteger(id))));
      const [subscribersResult, invoicesResult] = await Promise.all([
        subscriberIds.length ? supabaseAdmin().from("subscribers").select("id, full_name, subscriber_no, phone").eq("tenant_id", scope.tenantId).eq("site_id", input.siteId).in("id", subscriberIds) : Promise.resolve({ data: [], error: null }),
        invoiceIds.length ? supabaseAdmin().from("invoices").select("id, invoice_no").eq("tenant_id", scope.tenantId).eq("site_id", input.siteId).in("id", invoiceIds) : Promise.resolve({ data: [], error: null }),
      ]);
      if (subscribersResult.error || invoicesResult.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل تفاصيل الرسائل الفاشلة." });
      const subscriberById = new Map((subscribersResult.data ?? []).map((row) => [Number(row.id), row]));
      const invoiceById = new Map((invoicesResult.data ?? []).map((row) => [Number(row.id), row]));
      return (data ?? []).flatMap((row) => {
        const subscriber = subscriberById.get(Number(row.subscriber_id));
        if (!subscriber) return [];
        const invoice = row.invoice_id === null ? null : invoiceById.get(Number(row.invoice_id));
        const payload = row.payload && typeof row.payload === "object" && !Array.isArray(row.payload) ? row.payload as Record<string, unknown> : {};
        const queuedBy = typeof payload.queuedBy === "string" ? payload.queuedBy : null;
        const source = queuedBy === "invoice_issue" ? "automatic" : "manual";
        return [{
          notification: {
            id: Number(row.id), eventType: row.event_type, status: row.status, recipient: row.recipient,
            attempts: Number(row.attempts), lastError: row.last_error, providerMessageId: row.provider_message_id,
            createdAt: new Date(row.created_at), updatedAt: new Date(row.updated_at),
          },
          source, subscriber: { id: Number(subscriber.id), name: subscriber.full_name, subscriberNo: subscriber.subscriber_no, phone: subscriber.phone },
          invoice: invoice ? { id: Number(invoice.id), invoiceNo: invoice.invoice_no } : null,
        }];
      });
    }),
    retryFailedSmsBatch: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), notificationIds: z.array(z.number().int().positive()).min(1).max(100) })).mutation(async ({ ctx, input }) => {
      const scope = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "manageMessaging");
      const ids = Array.from(new Set(input.notificationIds));
      const { data: rows, error } = await supabaseAdmin().from("notification_messages")
        .select("id, subscriber_id, status, channel").eq("tenant_id", scope.tenantId).in("id", ids);
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل الرسائل المحددة لإعادة الإرسال." });
      const eligible = new Map((rows ?? []).filter((row) => row.channel === "sms" && row.status === "failed").map((row) => [Number(row.id), Number(row.subscriber_id)]));
      const subscriberIds = Array.from(new Set(Array.from(eligible.values())));
      const { data: subscribers, error: subscribersError } = subscriberIds.length
        ? await supabaseAdmin().from("subscribers").select("id").eq("tenant_id", scope.tenantId).eq("site_id", input.siteId).in("id", subscriberIds)
        : { data: [], error: null };
      if (subscribersError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر التحقق من نطاق الرسائل المحددة." });
      const scopedSubscribers = new Set((subscribers ?? []).map((row) => Number(row.id)));
      const results: Array<{ notificationId: number; status: "submitted" | "failed" | "skipped" | "needs_review"; error?: string; reviewPersistenceState?: "persisted" | "not_persisted" | "unknown" }> = [];
      for (const id of ids) {
        const subscriberId = eligible.get(id);
        if (!subscriberId || !scopedSubscribers.has(subscriberId)) {
          results.push({ notificationId: id, status: "skipped", error: "الرسالة ليست فاشلة أو خارج نطاق الفرع." });
          continue;
        }
        try {
          const result = await processNotificationById(id, ctx.user.id);
          results.push({ notificationId: id, status: result.status, error: result.error, reviewPersistenceState: result.reviewPersistenceState });
        } catch (error) {
          results.push({ notificationId: id, status: "failed", error: error instanceof Error ? error.message : "تعذر إعادة الإرسال." });
        }
      }
      await writeSupabaseAudit({
        userId: ctx.user.id, tenantId: scope.tenantId, siteId: input.siteId,
        entityType: "notification_batch", entityId: ids.join(","),
        action: "retry_failed_sms_batch",
        metadata: { requested: ids.length, eligible: eligible.size, submitted: results.filter((r) => r.status === "submitted").length, failed: results.filter((r) => r.status === "failed").length, skipped: results.filter((r) => r.status === "skipped").length, needsReview: results.filter((r) => r.status === "needs_review").length, reviewPersistenceFailed: countUnconfirmedNeedsReviewPersistence(results) },
      });
      return { requested: ids.length, submitted: results.filter((r) => r.status === "submitted").length, failed: results.filter((r) => r.status === "failed").length, skipped: results.filter((r) => r.status === "skipped").length, needsReview: results.filter((r) => r.status === "needs_review").length, reviewPersistenceFailed: countUnconfirmedNeedsReviewPersistence(results), results };
    }),
    resolveSmsNeedsReview: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), notificationId: z.number().int().positive(), resolution: z.enum(["submitted","failed"]), reason: z.string().max(2000).optional() })).mutation(async ({ ctx, input }) => {
      const scope = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "manageMessaging");
      const { data: rows, error } = await supabaseAdmin().from("notification_messages")
        .select("id, subscriber_id, status, channel")
        .eq("tenant_id", scope.tenantId).eq("id", input.notificationId).limit(1);
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل الرسالة للمراجعة." });
      const row = rows?.[0];
      if (!row || row.channel !== "sms" || row.status !== "needs_review") {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "الرسالة ليست بانتظار المراجعة." });
      }
      const { data: subscribers, error: subscriberError } = await supabaseAdmin().from("subscribers")
        .select("id").eq("tenant_id", scope.tenantId).eq("site_id", input.siteId).eq("id", Number(row.subscriber_id)).limit(1);
      if (subscriberError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر التحقق من نطاق الرسالة." });
      if (!subscribers?.length) throw new TRPCError({ code: "NOT_FOUND", message: "الرسالة خارج نطاق الفرع." });
      const { data, error: rpcError } = await supabaseAdmin().rpc("powerhub_resolve_sms_needs_review", {
        p_user_id: ctx.user.id,
        p_notification_id: input.notificationId,
        p_resolution: input.resolution,
        p_reason: input.reason ?? null,
      });
      if (rpcError) throw new TRPCError({ code: "PRECONDITION_FAILED", message: rpcError.message.includes("MESSAGING_PERMISSION_REQUIRED") ? "لا تملك صلاحية مراجعة رسائل SMS." : "تعذر تثبيت نتيجة مراجعة الرسالة." });
      return data?.[0] ?? { notification_id: input.notificationId, status: input.resolution };
    }),
    listBulkInvoiceSends: protectedProcedure.input(bulkInvoiceSendLogInput).query(async ({ ctx, input }) => {
      const scope = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "manageMessaging");
      const start = input.from ? new Date(`${input.from}T00:00:00.000Z`) : undefined;
      const endExclusive = input.to ? new Date(`${input.to}T00:00:00.000Z`) : undefined;
      if (endExclusive) endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);
      let auditQuery = supabaseAdmin().from("audit_logs").select("id, action, metadata, user_id, created_at")
        .eq("tenant_id", scope.tenantId).eq("site_id", input.siteId).eq("entity_type", "notification_batch")
        .in("action", [...bulkInvoiceSendAuditActions]).order("created_at", { ascending: false }).limit(20);
      if (start) auditQuery = auditQuery.gte("created_at", start.toISOString());
      if (endExclusive) auditQuery = auditQuery.lt("created_at", endExclusive.toISOString());
      const { data: auditRows, error: auditError } = await auditQuery;
      if (auditError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل سجل الإرسال الجماعي من Supabase." });
      const executorIds = Array.from(new Set((auditRows ?? []).flatMap((row) => row.user_id === null ? [] : [Number(row.user_id)])));
      const { data: usersRows, error: usersError } = executorIds.length
        ? await supabaseAdmin().from("users").select("id, name, email").in("id", executorIds)
        : { data: [], error: null };
      if (usersError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل منفذي عمليات الإرسال من Supabase." });
      const usersById = new Map((usersRows ?? []).map((row) => [Number(row.id), row]));
      return (auditRows ?? []).map((row) => {
        const executor = row.user_id === null ? null : usersById.get(Number(row.user_id));
        return { id: Number(row.id), action: row.action, createdAt: new Date(row.created_at), metadata: row.metadata, executorId: row.user_id === null ? null : Number(row.user_id), executorName: executor?.name ?? null, executorEmail: executor?.email ?? null };
      });
    }),
    bulkInvoiceSendDetails: protectedProcedure.input(bulkInvoiceSendDetailsInput).query(async ({ ctx, input }) => {
      const scope = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "manageMessaging");
      const admin = supabaseAdmin();
      const { data: operationRow, error: operationError } = await admin.from("audit_logs").select("id, action, entity_id, metadata, created_at")
        .eq("id", input.auditLogId).eq("tenant_id", scope.tenantId).eq("site_id", input.siteId).eq("entity_type", "notification_batch")
        .in("action", [...bulkInvoiceSendAuditActions]).maybeSingle();
      if (operationError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل عملية الإرسال الجماعي من Supabase." });
      const operation = operationRow ? { id: Number(operationRow.id), action: operationRow.action, entityId: operationRow.entity_id, metadata: operationRow.metadata, createdAt: new Date(operationRow.created_at) } : null;
      if (!operation) throw new TRPCError({ code: "NOT_FOUND", message: "عملية الإرسال الجماعي لا تتبع للفرع المحدد." });
      const metadata = operation.metadata && typeof operation.metadata === "object" && !Array.isArray(operation.metadata) ? operation.metadata as Record<string, unknown> : {};
      const notificationIds = Array.isArray(metadata.notificationIds) ? metadata.notificationIds.filter((value): value is number => typeof value === "number" && Number.isInteger(value) && value > 0) : operation.action === "send_deferred_invoice_notifications" ? operation.entityId.split(",").map(Number).filter((value: number) => Number.isInteger(value) && value > 0) : [];
      const invoiceIds = notificationIds.length ? [] : operation.entityId.split(",").map(Number).filter((value: number) => Number.isInteger(value) && value > 0);
      if (!notificationIds.length && !invoiceIds.length) return { operation, items: [] as Array<never> };
      let notificationQuery = admin.from("notification_messages").select("id, tenant_id, invoice_id, subscriber_id, channel, status, last_error, recipient")
        .eq("tenant_id", scope.tenantId);
      notificationQuery = notificationIds.length ? notificationQuery.in("id", notificationIds) : notificationQuery.in("invoice_id", invoiceIds);
      const { data: notificationRows, error: notificationsError } = await notificationQuery;
      if (notificationsError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل إشعارات عملية الإرسال من Supabase." });
      const detailInvoiceIds = Array.from(new Set((notificationRows ?? []).flatMap((row) => row.invoice_id === null ? [] : [Number(row.invoice_id)])));
      const { data: invoiceRows, error: invoicesError } = detailInvoiceIds.length
        ? await admin.from("invoices").select("id, site_id, invoice_no, total_amount").eq("site_id", input.siteId).in("id", detailInvoiceIds)
        : { data: [], error: null };
      if (invoicesError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل فواتير عملية الإرسال من Supabase." });
      const invoicesById = new Map((invoiceRows ?? []).map((row) => [Number(row.id), row]));
      const subscriberIds = Array.from(new Set((notificationRows ?? []).map((row) => Number(row.subscriber_id)).filter(Number.isInteger)));
      const { data: subscriberRows, error: subscribersError } = subscriberIds.length
        ? await admin.from("subscribers").select("id, tenant_id, site_id, full_name").eq("tenant_id", scope.tenantId).eq("site_id", input.siteId).in("id", subscriberIds)
        : { data: [], error: null };
      if (subscribersError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل مشتركي عملية الإرسال من Supabase." });
      const subscribersById = new Map((subscriberRows ?? []).map((row) => [Number(row.id), row]));
      const items = (notificationRows ?? []).flatMap((row) => {
        const invoice = row.invoice_id === null ? null : invoicesById.get(Number(row.invoice_id));
        const subscriber = subscribersById.get(Number(row.subscriber_id));
        if (!invoice || !subscriber) return [];
        return [{ notificationId: Number(row.id), status: row.status, channel: row.channel, lastError: row.last_error, recipient: row.recipient, invoiceId: Number(invoice.id), invoiceNo: invoice.invoice_no, totalAmount: String(invoice.total_amount), subscriberName: subscriber.full_name }];
      });
      return { operation, items };
    }),
    sendPendingSms: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), invoiceIds: z.array(z.number().int().positive()).min(1).max(50).optional(), includeFailed: z.boolean().default(false) })).mutation(({ ctx, input }) =>
      sendPendingInvoiceSmsRuntime(ctx.user.id, input)
    ),
    retry: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), notificationId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      const scope = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "manageMessaging");
      const row = await supabaseAdmin().from("notification_messages").select("id, status, subscriber_id").eq("id", input.notificationId).eq("tenant_id", scope.tenantId).maybeSingle();
      if (row.error || !row.data) throw new TRPCError({ code: "NOT_FOUND", message: "الرسالة لا تتبع للفرع المحدد." });
      const subscriber = await supabaseAdmin().from("subscribers").select("id").eq("id", Number(row.data.subscriber_id)).eq("tenant_id", scope.tenantId).eq("site_id", input.siteId).maybeSingle();
      if (subscriber.error || !subscriber.data) throw new TRPCError({ code: "NOT_FOUND", message: "الرسالة لا تتبع للفرع المحدد." });
      if (row.data.status !== "failed") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "لا يمكن إعادة إرسال رسالة لم تفشل." });
      return processNotificationById(Number(row.data.id), ctx.user.id);
    }),
    retryFailedInvoiceNotification: protectedProcedure.input(retryFailedInvoiceNotificationInput).mutation(async ({ ctx, input }) => {
      const scope = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "manageMessaging");
      const row = await supabaseAdmin().from("notification_messages").select("id, status, event_type, subscriber_id").eq("id", input.notificationId).eq("tenant_id", scope.tenantId).maybeSingle();
      if (row.error || !row.data) throw new TRPCError({ code: "NOT_FOUND", message: "رسالة الفاتورة غير موجودة ضمن الفرع المحدد." });
      if (row.data.event_type !== "invoice_issued") throw new TRPCError({ code: "BAD_REQUEST", message: "هذه ليست رسالة فاتورة." });
      const subscriber = await supabaseAdmin().from("subscribers").select("id").eq("id", Number(row.data.subscriber_id)).eq("tenant_id", scope.tenantId).eq("site_id", input.siteId).maybeSingle();
      if (subscriber.error || !subscriber.data) throw new TRPCError({ code: "NOT_FOUND", message: "رسالة الفاتورة لا تتبع للفرع المحدد." });
      if (row.data.status !== "failed") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "لا يمكن إعادة إرسال رسالة فاتورة لم تفشل." });
      return processNotificationById(Number(row.data.id), ctx.user.id);
    }),
    retryFailedInvoiceNotifications: protectedProcedure.input(retryFailedInvoiceNotificationsInput).mutation(async ({ ctx, input }) => {
      const scope = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "manageMessaging");
      const ids = Array.from(new Set(input.notificationIds));
      const { data: rows, error } = await supabaseAdmin().from("notification_messages").select("id, status, event_type, subscriber_id").eq("tenant_id", scope.tenantId).in("id", ids);
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل الرسائل لإعادة الإرسال." });
      const validIds = new Set((rows ?? []).filter((row) => row.event_type === "invoice_issued" && row.status === "failed").map((row) => Number(row.id)));
      const subscriberIds = Array.from(new Set((rows ?? []).map((row) => Number(row.subscriber_id)).filter(Number.isInteger)));
      const { data: subscribers } = subscriberIds.length ? await supabaseAdmin().from("subscribers").select("id").eq("tenant_id", scope.tenantId).eq("site_id", input.siteId).in("id", subscriberIds) : { data: [] };
      const scopedSubscribers = new Set((subscribers ?? []).map((row) => Number(row.id)));
      const eligibleIds = ids.filter((id) => validIds.has(id) && scopedSubscribers.has(Number((rows ?? []).find((row) => Number(row.id) === id)?.subscriber_id)));
      const results = [];
      for (const id of eligibleIds) {
        try { results.push({ notificationId: id, status: "submitted", result: await processNotificationById(id, ctx.user.id) }); }
        catch (error) { results.push({ notificationId: id, status: "failed", error: error instanceof Error ? error.message : "تعذر إعادة الإرسال." }); }
      }
      return { requested: ids.length, eligible: eligibleIds.length, submitted: results.filter((row) => row.status === "submitted").length, failed: results.filter((row) => row.status === "failed").length, results };
    }),
    retryPaymentReceipt: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), notificationId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      const scope = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "manageMessaging");
      const { data: row, error } = await supabaseAdmin().from("notification_messages").select("id, status, event_type, subscriber_id").eq("id", input.notificationId).eq("tenant_id", scope.tenantId).maybeSingle();
      if (error || !row) throw new TRPCError({ code: "NOT_FOUND", message: "إشعار إيصال الدفع غير موجود." });
      if (row.event_type !== "payment_received") throw new TRPCError({ code: "BAD_REQUEST", message: "الإشعار المحدد ليس إيصال دفع." });
      const { data: subscriber } = await supabaseAdmin().from("subscribers").select("id").eq("id", Number(row.subscriber_id)).eq("tenant_id", scope.tenantId).eq("site_id", input.siteId).maybeSingle();
      if (!subscriber) throw new TRPCError({ code: "NOT_FOUND", message: "إشعار إيصال الدفع لا يتبع للفرع المحدد." });
      if (row.status !== "failed") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "لا يمكن إعادة إرسال إيصال لم يفشل." });
      return processNotificationById(Number(row.id), ctx.user.id);
    }),
    sendDeferredInvoices: protectedProcedure.input(sendDeferredInvoiceNotificationsInput).mutation(({ ctx, input }) =>
      sendPendingInvoiceSmsRuntime(ctx.user.id, { siteId: input.siteId, invoiceIds: input.invoiceIds, includeFailed: false, dueOnly: true })
    ),
    sendBulkInvoiceSms: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), invoiceIds: z.array(z.number().int().positive()).min(1).max(5000) })).mutation(({ ctx, input }) =>
      sendPendingInvoiceSmsRuntime(ctx.user.id, { siteId: input.siteId, invoiceIds: input.invoiceIds, includeFailed: false, dueOnly: true })
    ),
    sendAllEligibleInvoiceSms: protectedProcedure.input(siteScoped).mutation(({ ctx, input }) =>
      sendPendingInvoiceSmsRuntime(ctx.user.id, { siteId: input.siteId, includeFailed: false, dueOnly: true, queueMissing: true })
    ),
    sendPaymentReminderSms: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), invoiceId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      const scope = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "manageMessaging");
      const admin = supabaseAdmin();
      const { data: invoice, error: invoiceError } = await admin.from("invoices")
        .select("id, subscriber_id, invoice_no, billing_period, total_amount, balance_due, due_date, status, previous_reading, current_reading, consumption_kwh")
        .eq("id", input.invoiceId).eq("tenant_id", scope.tenantId).eq("site_id", input.siteId).maybeSingle();
      if (invoiceError || !invoice) throw new TRPCError({ code: "NOT_FOUND", message: "الفاتورة لا تتبع للفرع المحدد." });
      if (["draft", "cancelled", "paid"].includes(String(invoice.status)) || Number(invoice.balance_due ?? 0) <= 0) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "لا يمكن تذكير المشترك بهذه الفاتورة؛ لا يوجد مبلغ مستحق غير مدفوع." });
      }
      const { data: subscriber, error: subscriberError } = await admin.from("subscribers")
        .select("id, full_name, subscriber_no, phone").eq("id", Number(invoice.subscriber_id))
        .eq("tenant_id", scope.tenantId).eq("site_id", input.siteId).maybeSingle();
      if (subscriberError || !subscriber?.phone) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "لا يوجد رقم هاتف صالح للمشترك ضمن الفرع المحدد." });
      let recipient: string;
      try { recipient = normalizeInternationalPhone(subscriber.phone); }
      catch (error) { throw new TRPCError({ code: "PRECONDITION_FAILED", message: error instanceof Error ? `عدّل رقم هاتف المشترك قبل الإرسال. ${error.message}` : "عدّل رقم هاتف المشترك إلى صيغة دولية قبل الإرسال." }); }

      const { data: template, error: templateError } = await admin.from("powerhub_message_templates")
        .select("id,body").eq("tenant_id", scope.tenantId).eq("channel", "sms")
        .eq("event_type", "invoice_overdue").eq("is_active", true)
        .order("updated_at", { ascending: false }).limit(1).maybeSingle();
      if (templateError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل قالب التذكير بالسداد من مركز الرسائل." });
      if (!template?.body?.trim()) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "لا يتوفر قالب للتذكير بالسداد أعده في مركز الرسائل." });

      const { data: policy, error: policyError } = await admin.from("site_billing_policies")
        .select("automatic_fraction_discount_enabled,fraction_carry_enabled")
        .eq("tenant_id", scope.tenantId).eq("site_id", input.siteId).maybeSingle();
      if (policyError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل سياسة تسوية الكسور لتنسيق مبلغ التذكير." });
      const settlementDisplayEnabled = Boolean(policy?.automatic_fraction_discount_enabled || policy?.fraction_carry_enabled);

      const { data: outstandingInvoices, error: outstandingError } = await admin.from("invoices")
        .select("balance_due").eq("tenant_id", scope.tenantId).eq("site_id", input.siteId)
        .eq("subscriber_id", Number(subscriber.id)).in("status", ["issued", "partially_paid", "overdue"]).gt("balance_due", 0);
      if (outstandingError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر حساب الرصيد الإجمالي للمشترك." });
      const totalBalanceMinor = (outstandingInvoices ?? []).reduce((sum: bigint, row: any) => sum + decimalAmountToMinorUnits(String(row.balance_due ?? "0")), 0n);
      const totalBalance = formatPolicyAwareMessageAmount(minorUnitsToAmountString(totalBalanceMinor), settlementDisplayEnabled);
      const values = {
        subscriber_name: subscriber.full_name ?? "",
        subscriber_no: String(subscriber.subscriber_no ?? ""),
        invoice_no: String(invoice.invoice_no),
        billing_period: String(invoice.billing_period),
        total_amount: formatPolicyAwareMessageAmount(String(invoice.total_amount ?? "0"), settlementDisplayEnabled),
        balance_due: formatPolicyAwareMessageAmount(String(invoice.balance_due ?? "0"), settlementDisplayEnabled),
        previous_reading: invoice.previous_reading == null ? "" : String(invoice.previous_reading),
        current_reading: invoice.current_reading == null ? "" : String(invoice.current_reading),
        consumption_kwh: invoice.consumption_kwh == null ? "" : String(invoice.consumption_kwh),
        total_balance: totalBalance,
        due_date: String(invoice.due_date ?? ""),
        invoice_link: template.body.includes("{{invoice_link}}") ? "{{invoice_link}}" : "",
        portal_link: template.body.includes("{{portal_link}}") ? "{{portal_link}}" : "",
      };
      const renderedText = renderInvoiceMessageTemplate(template.body, values, settlementDisplayEnabled);
      const localDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Gaza", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
      const { data: queueRows, error: queueError } = await admin.rpc("powerhub_queue_payment_sms", {
        p_user_id: ctx.user.id, p_tenant_id: scope.tenantId, p_site_id: input.siteId,
        p_event_type: "payment_reminder", p_invoice_id: Number(invoice.id), p_payment_id: null,
        p_operation_key: `payment_reminder:${invoice.id}:${localDate}`, p_rendered_text: renderedText,
      });
      if (queueError || !(queueRows as Array<{ notification_id: number }> | null)?.[0]) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "تعذر تجهيز تذكير SMS للفواتير المستحقة." });
      const notificationId = Number((queueRows as Array<{ notification_id: number }>)[0].notification_id);
      const dispatch = await processNotificationById(notificationId, ctx.user.id);
      return { notificationIds: [notificationId], channels: ["sms"], recipient, ...dispatch };
    }),
    sendPaymentReceiptSms: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), paymentId: z.number().int().positive(), channel: z.enum(["sms", "whatsapp"]).optional() })).mutation(async ({ ctx, input }) => {
      if (input.channel && input.channel !== "sms") throw new TRPCError({ code: "FORBIDDEN", message: "قناة WhatsApp غير مفعلة في هذا الإصدار؛ استخدم SMS فقط." });
      const scope = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "manageMessaging");
      const admin = supabaseAdmin();
      const { data: payment, error: paymentError } = await admin.from("payments").select("id, invoice_id, subscriber_id, payment_no, amount").eq("id", input.paymentId).eq("tenant_id", scope.tenantId).eq("site_id", input.siteId).eq("status", "completed").maybeSingle();
      if (paymentError || !payment?.invoice_id || !payment.subscriber_id) throw new TRPCError({ code: "NOT_FOUND", message: "لا تتوفر دفعة مكتملة ضمن الفرع المحدد." });
      const [{ data: invoice, error: invoiceError }, { data: subscriber, error: subscriberError }, { data: template }] = await Promise.all([
        admin.from("invoices").select("id, invoice_no, balance_due").eq("id", Number(payment.invoice_id)).eq("tenant_id", scope.tenantId).eq("site_id", input.siteId).maybeSingle(),
        admin.from("subscribers").select("id, full_name, phone").eq("id", Number(payment.subscriber_id)).eq("tenant_id", scope.tenantId).eq("site_id", input.siteId).maybeSingle(),
        admin.from("tenant_payment_receipt_message_templates").select("body").eq("tenant_id", scope.tenantId).eq("channel", "sms").eq("is_active", true).order("updated_at", { ascending: false }).limit(1).maybeSingle(),
      ]);
      if (invoiceError || !invoice || subscriberError || !subscriber?.phone) throw new TRPCError({ code: "NOT_FOUND", message: "لا تتوفر فاتورة ومشترك برقم هاتف ضمن الفرع المحدد." });
      let recipient: string;
      try { recipient = normalizeInternationalPhone(subscriber.phone); } catch (error) { throw new TRPCError({ code: "PRECONDITION_FAILED", message: error instanceof Error ? `عدّل رقم هاتف المشترك قبل الإرسال. ${error.message}` : "عدّل رقم هاتف المشترك إلى صيغة دولية قبل الإرسال." }); }
      const { data: billingPolicy, error: billingPolicyError } = await admin.from("site_billing_policies")
        .select("automatic_fraction_discount_enabled,fraction_carry_enabled")
        .eq("tenant_id", scope.tenantId).eq("site_id", input.siteId).maybeSingle();
      if (billingPolicyError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل سياسة تسوية الكسور لتنسيق مبلغ الإيصال." });
      const settlementDisplayEnabled = Boolean(billingPolicy?.automatic_fraction_discount_enabled || billingPolicy?.fraction_carry_enabled);
      const receipt = { subscriberName: subscriber.full_name, paymentNo: String(payment.payment_no), paymentAmount: Number(payment.amount), invoiceNo: String(invoice.invoice_no), balanceDue: Number(invoice.balance_due) };
      const renderedText = renderPaymentReceiptTemplate(template?.body ?? defaultPaymentReceiptSmsTemplate, receipt, settlementDisplayEnabled) || renderPaymentReceiptMessage(receipt, settlementDisplayEnabled);
      const { data: queueRows, error: queueError } = await admin.rpc("powerhub_queue_payment_sms", { p_user_id: ctx.user.id, p_tenant_id: scope.tenantId, p_site_id: input.siteId, p_event_type: "payment_received", p_invoice_id: Number(invoice.id), p_payment_id: Number(payment.id), p_operation_key: `payment_receipt:${payment.id}`, p_rendered_text: renderedText });
      if (queueError || !(queueRows as Array<{ notification_id: number }> | null)?.[0]) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "تعذر تجهيز إيصال التحصيل عبر SMS." });
      const notificationId = Number((queueRows as Array<{ notification_id: number }>)[0].notification_id);
      const dispatch = await processNotificationById(notificationId, ctx.user.id);
      return { notificationId, recipient, channel: "sms" as const, ...dispatch };
    }),
  }),

  companyAccounts: router({
    list: protectedProcedure.input(siteScoped.extend({ branchId: z.number().int().positive().optional(), fromDate: z.string().optional(), toDate: z.string().optional() })).query(async ({ ctx, input }) => {
      const from = input.fromDate ? new Date(input.fromDate) : null; const to = input.toDate ? new Date(input.toDate) : null;
      if (from && Number.isNaN(from.getTime())) throw new TRPCError({ code: "BAD_REQUEST", message: "تاريخ البداية غير صحيح." });
      if (to && Number.isNaN(to.getTime())) throw new TRPCError({ code: "BAD_REQUEST", message: "تاريخ النهاية غير صحيح." });
      if (from && to && from > to) throw new TRPCError({ code: "BAD_REQUEST", message: "تاريخ البداية يجب أن يسبق تاريخ النهاية." });
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "manageExpenses");
      let effectiveBranchId = input.branchId;
      if (effectiveBranchId !== undefined) {
        const branchAccess = await requireSupabaseSiteRole(ctx.user.id, effectiveBranchId, ["owner", "manager", "accountant"], "manageExpenses");
        if (branchAccess.tenantId !== access.tenantId) {
          throw new TRPCError({ code: "FORBIDDEN", message: "الفرع المحدد لا يتبع مساحة الشركة الحالية." });
        }
      } else if (access.role !== "owner") {
        let allBranches = false;
        try {
          await requireSupabaseAllBranchesRole(ctx.user.id, input.siteId, ["manager", "accountant"]);
          allBranches = true;
        } catch (error) {
          if (!(error instanceof TRPCError) || error.code !== "FORBIDDEN") throw error;
        }
        if (!allBranches) effectiveBranchId = input.siteId;
      }
      return listSupabaseCompanyAccounts({ tenantId: access.tenantId, branchId: effectiveBranchId, from, to });
    }),
    create: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), name: z.string().trim().min(2).max(120), accountType: z.enum(["cash", "jawwal_pay", "palpay", "bank_of_palestine", "other"]), phoneNumber: z.string().trim().regex(/^\+?[0-9]{7,20}$/, "أدخل رقم جوال صحيحاً."), openingBalance: z.number().nonnegative().default(0), color: z.string().trim().max(20).optional(), siteIds: z.array(z.number().int().positive()).min(1) })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseAccessibleSiteIds(ctx.user.id, input.siteId, input.siteIds, ["owner", "manager"], "manageExpenses");
      const { data, error } = await supabaseAdmin().rpc("powerhub_create_company_account", { p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id, p_name: input.name, p_account_type: input.accountType, p_phone_number: input.phoneNumber, p_opening_balance: input.openingBalance, p_color: input.color ?? "#64748b", p_site_ids: input.siteIds });
      if (!error && data?.[0]) return { id: Number((data[0] as { account_id: number | string }).account_id) };
      const errorText = `${error?.code ?? ""} ${error?.message ?? ""}`;
      if (errorText.includes("ACCOUNT_SITE_OUT_OF_SCOPE")) throw new TRPCError({ code: "FORBIDDEN", message: "أحد الفروع المحددة لا يتبع مساحة الشركة." });
      if (error?.code === "23505") throw new TRPCError({ code: "CONFLICT", message: "يوجد حساب من النوع والرقم نفسيهما ضمن مساحة الشركة." });
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر إنشاء حساب الشركة في Supabase." });
    }),
    updatePaymentDocumentationVisibility: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), accountId: z.number().int().positive(), allow: z.boolean() })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager"], "manageExpenses");
      await requireCompanyAccountSiteScope(access, input.siteId, [input.accountId]);
      const { data, error } = await supabaseAdmin().rpc("powerhub_update_company_account_payment_visibility", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id, p_account_id: input.accountId, p_allow: input.allow,
      });
      if (error) {
        const message = error.message ?? "";
        if (message.includes("ACCOUNT_SITE_OUT_OF_SCOPE")) throw new TRPCError({ code: "FORBIDDEN", message: "الحساب غير مرتبط بالفرع المحدد." });
        if (message.includes("ACCOUNT_NOT_FOUND")) throw new TRPCError({ code: "NOT_FOUND", message: "حساب الدفع غير موجود ضمن مساحة الشركة." });
        if (message.includes("ACCOUNT_INACTIVE")) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "لا يمكن إظهار حساب دفع غير نشط في توثيق الدفع." });
        if (message.includes("PAYMENT_DOCUMENTATION_TENANT_DISABLED")) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "فعّل توثيق الدفع الإلكتروني من الإعدادات أولاً، ثم أظهر حساب الاستلام المطلوب." });
        if (message.includes("COMPANY_ACCOUNT_PAYMENT_VISIBILITY_FORBIDDEN")) throw new TRPCError({ code: "FORBIDDEN", message: "لا تملك صلاحية تعديل ظهور حساب الدفع في توثيق الدفع." });
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحديث إعداد ظهور الحساب في توثيق الدفع." });
      }
      const row = (data as Array<{ account_id: number | string; allow_payment_documentation: boolean }> | null)?.[0];
      if (!row) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "لم تُعد دالة إعداد الحساب استجابة صالحة." });
      return { accountId: Number(row.account_id), allowPaymentDocumentation: Boolean(row.allow_payment_documentation) };
    }),
    updatePhone: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), accountId: z.number().int().positive(), phoneNumber: z.string().trim().regex(/^\+?[0-9]{7,20}$/, "أدخل رقم جوال صحيحاً بصيغة دولية أو محلية.") })).mutation(async ({ ctx, input }) => { const access=await requireSupabaseSiteRole(ctx.user.id,input.siteId,["owner","manager","accountant"],"manageExpenses"); await requireCompanyAccountSiteScope(access,input.siteId,[input.accountId]); const {data,error}=await supabaseAdmin().rpc("powerhub_update_company_account_phone",{p_tenant_id:access.tenantId,p_site_id:input.siteId,p_user_id:ctx.user.id,p_account_id:input.accountId,p_phone_number:input.phoneNumber}); if(error) throw new TRPCError({code:error.message.includes("NOT_FOUND")?"NOT_FOUND":error.message.includes("OUT_OF_SCOPE")?"FORBIDDEN":error.message.includes("CONFLICT")?"CONFLICT":"BAD_REQUEST",message:error.message.includes("CONFLICT")?"يوجد حساب من النوع والرقم نفسيهما ضمن مساحة الشركة.":"تعذر تحديث رقم الحساب."}); if(!Number((data as Array<{account_id:number}>|null)?.[0]?.account_id)) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"لم تُعد دالة الحساب استجابة صالحة."}); return {success:true}; }),
    updateOpeningBalance: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), accountId: z.number().int().positive(), openingBalance: z.number().nonnegative() })).mutation(async ({ ctx, input }) => {
      const access=await requireSupabaseSiteRole(ctx.user.id,input.siteId,["owner","manager"],"manageExpenses"); await requireCompanyAccountSiteScope(access,input.siteId,[input.accountId]); const {data,error}=await supabaseAdmin().rpc("powerhub_update_company_account_opening_balance",{p_tenant_id:access.tenantId,p_site_id:input.siteId,p_user_id:ctx.user.id,p_account_id:input.accountId,p_opening_balance:input.openingBalance}); if(error) throw new TRPCError({code:error.message.includes("NOT_FOUND")?"NOT_FOUND":error.message.includes("MOVEMENTS")?"CONFLICT":"BAD_REQUEST",message:error.message.includes("MOVEMENTS")?"لا يمكن تعديل الرصيد الافتتاحي بعد تسجيل حركات على الحساب.":"تعذر تحديث الرصيد الافتتاحي."}); if(!Number((data as Array<{account_id:number}>|null)?.[0]?.account_id)) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"لم تُعد دالة الحساب استجابة صالحة."}); return {success:true};
    }),
    updateSites: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), accountId: z.number().int().positive(), siteIds: z.array(z.number().int().positive()).min(1) })).mutation(async ({ ctx, input }) => {
      const access=await requireSupabaseSiteRole(ctx.user.id,input.siteId,["owner","manager"],"manageExpenses"); await requireCompanyAccountSiteScope(access,input.siteId,[input.accountId]); await requireSupabaseAccessibleSiteIds(ctx.user.id,input.siteId,input.siteIds,["owner","manager"],"manageExpenses"); const {data,error}=await supabaseAdmin().rpc("powerhub_update_company_account_sites",{p_tenant_id:access.tenantId,p_site_id:input.siteId,p_user_id:ctx.user.id,p_account_id:input.accountId,p_site_ids:input.siteIds}); if(error) throw new TRPCError({code:error.message.includes("OUT_OF_SCOPE")?"FORBIDDEN":error.message.includes("NOT_FOUND")?"NOT_FOUND":"BAD_REQUEST",message:error.message.includes("OUT_OF_SCOPE")?"أحد الفروع المحددة لا يتبع مساحة الشركة.":"تعذر تحديث الفروع المرتبطة بالحساب."}); if(!Number((data as Array<{account_id:number}>|null)?.[0]?.account_id)) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"لم تُعد دالة الحساب استجابة صالحة."}); return {success:true};
    }),
    addMovement: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), accountId: z.number().int().positive(), transactionType: z.enum(["deposit", "withdrawal"]), amount: z.number().positive(), description: z.string().trim().min(2).max(255), referenceNo: z.string().trim().max(120).optional() })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "manageExpenses");
      await requireCompanyAccountSiteScope(access, input.siteId, [input.accountId]);
      const { data, error } = await supabaseAdmin().rpc("powerhub_add_account_movement", { p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id, p_account_id: input.accountId, p_transaction_type: input.transactionType, p_amount: input.amount, p_description: input.description, p_reference_no: input.referenceNo ?? null });
      if (!error && data?.[0]) return { id: Number((data[0] as { transaction_id: number | string }).transaction_id) };
      const errorText = `${error?.code ?? ""} ${error?.message ?? ""}`;
      if (errorText.includes("ACCOUNT_NOT_FOUND")) throw new TRPCError({ code: "NOT_FOUND", message: "الحساب غير موجود ضمن مساحة الشركة." });
      if (errorText.includes("ACCOUNT_SITE_OUT_OF_SCOPE")) throw new TRPCError({ code: "FORBIDDEN", message: "الحساب غير مربوط بالفرع المحدد." });
      if (errorText.includes("INSUFFICIENT_ACCOUNT_BALANCE")) throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن سحب مبلغ أكبر من الرصيد المتاح في الحساب." });
      if (errorText.includes("FINANCIAL_PERIOD_LOCKED")) throw new TRPCError({ code: "FORBIDDEN", message: "الفترة المالية مقفلة؛ لا يمكن تعديل أو إضافة بيانات مالية داخلها." });
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تسجيل حركة الحساب في Supabase." });
    }),
    transfer: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), fromAccountId: z.number().int().positive(), toAccountId: z.number().int().positive(), amount: z.number().positive(), description: z.string().trim().min(2).max(255) })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "manageExpenses");
      await requireCompanyAccountSiteScope(access, input.siteId, [input.fromAccountId, input.toAccountId]);
      const { data, error } = await supabaseAdmin().rpc("powerhub_transfer_company_accounts", { p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id, p_from_account_id: input.fromAccountId, p_to_account_id: input.toAccountId, p_amount: input.amount, p_description: input.description });
      if (!error && data?.[0]) return { success: true };
      const errorText = `${error?.code ?? ""} ${error?.message ?? ""}`;
      if (errorText.includes("SAME_TRANSFER_ACCOUNT")) throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن التحويل إلى الحساب نفسه." });
      if (errorText.includes("ACCOUNT_NOT_FOUND")) throw new TRPCError({ code: "NOT_FOUND", message: "حساب التحويل غير موجود ضمن مساحة الشركة." });
      if (errorText.includes("INSUFFICIENT_ACCOUNT_BALANCE")) throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن تحويل مبلغ أكبر من الرصيد المتاح في الحساب المصدر." });
      if (errorText.includes("FINANCIAL_PERIOD_LOCKED")) throw new TRPCError({ code: "FORBIDDEN", message: "الفترة المالية مقفلة؛ لا يمكن تعديل أو إضافة بيانات مالية داخلها." });
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تنفيذ التحويل في Supabase." });
    }),
  }),
  hr: router({
    listAttendance: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), fromDate: z.string().optional(), toDate: z.string().optional(), employeeId: z.number().int().positive().optional() })).query(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "managePayroll");
      let query = supabaseAdmin().from("employee_attendance").select("id, tenant_id, employee_id, site_id, work_date, regular_hours, overtime_hours, absent_days, notes, created_by_user_id, created_at, updated_at").eq("tenant_id", access.tenantId).eq("site_id", input.siteId);
      if (input.employeeId) query = query.eq("employee_id", input.employeeId);
      if (input.fromDate) query = query.gte("work_date", input.fromDate);
      if (input.toDate) query = query.lte("work_date", input.toDate);
      const { data, error } = await query.order("work_date", { ascending: false }).limit(1000);
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل سجل الحضور من Supabase." });
      const employeeIds = Array.from(new Set((data ?? []).map((row) => Number(row.employee_id))));
      const { data: people, error: peopleError } = employeeIds.length ? await supabaseAdmin().from("employees").select("id, tenant_id, site_id, linked_user_id, full_name, identity_no, phone, job_title, employment_status, contract_type, base_wage, hire_date, notes, created_at, updated_at").eq("tenant_id", access.tenantId).in("id", employeeIds) : { data: [], error: null };
      if (peopleError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل موظفي سجل الحضور من Supabase." });
      const peopleById = new Map((people ?? []).map((employee) => [Number(employee.id), employee]));
      return (data ?? []).flatMap((attendance) => {
        const employee = peopleById.get(Number(attendance.employee_id));
        return employee ? [{
          attendance: { id: Number(attendance.id), tenantId: Number(attendance.tenant_id), employeeId: Number(attendance.employee_id), siteId: Number(attendance.site_id), workDate: new Date(attendance.work_date), regularHours: String(attendance.regular_hours), overtimeHours: String(attendance.overtime_hours), absentDays: String(attendance.absent_days), notes: attendance.notes, createdByUserId: Number(attendance.created_by_user_id), createdAt: new Date(attendance.created_at), updatedAt: new Date(attendance.updated_at) },
          employee: { id: Number(employee.id), tenantId: Number(employee.tenant_id), siteId: employee.site_id === null ? null : Number(employee.site_id), linkedUserId: employee.linked_user_id === null ? null : Number(employee.linked_user_id), fullName: employee.full_name, identityNo: employee.identity_no, phone: employee.phone, jobTitle: employee.job_title, employmentStatus: employee.employment_status, contractType: employee.contract_type, baseWage: String(employee.base_wage), hireDate: employee.hire_date ? new Date(employee.hire_date) : null, notes: employee.notes, createdAt: new Date(employee.created_at), updatedAt: new Date(employee.updated_at) },
        }] : [];
      });
    }),
    upsertAttendance: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), employeeId: z.number().int().positive(), workDate: z.string(), regularHours: z.number().min(0).max(24).default(0), overtimeHours: z.number().min(0).max(24).default(0), absentDays: z.number().min(0).max(1).default(0), notes: z.string().trim().max(500).optional() })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "accountant"], "managePayroll");
      const workDate = new Date(input.workDate);
      if (Number.isNaN(workDate.getTime())) throw new TRPCError({ code: "BAD_REQUEST", message: "تاريخ الحضور غير صحيح." });
      const { data, error } = await supabaseAdmin().rpc("powerhub_upsert_employee_attendance", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id, p_employee_id: input.employeeId,
        p_work_date: input.workDate, p_regular_hours: input.regularHours, p_overtime_hours: input.overtimeHours,
        p_absent_days: input.absentDays, p_notes: input.notes ?? null,
      });
      const result = (data as Array<{ attendance_id: number | string; mutation: string }> | null)?.[0];
      if (!error && result?.attendance_id) return { success: true };
      const errorText = `${error?.code ?? ""} ${error?.message ?? ""}`;
      if (errorText.includes("EMPLOYEE_OUT_OF_SCOPE")) throw new TRPCError({ code: "NOT_FOUND", message: "الموظف غير موجود ضمن الفرع." });
      if (errorText.includes("INVALID_ATTENDANCE_INPUT")) throw new TRPCError({ code: "BAD_REQUEST", message: "بيانات الحضور غير صحيحة." });
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر حفظ سجل الحضور في Supabase." });
    }),
    overview: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional() })).query(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "accountant"], "managePayroll");
      const [employeesResult, payrollResult] = await Promise.all([
        supabaseAdmin().from("employees").select("employment_status, base_wage").eq("tenant_id", access.tenantId).or(`site_id.eq.${input.siteId},site_id.is.null`),
        input.period
          ? supabaseAdmin().from("payroll_runs").select("total_net, total_gross, total_deductions").eq("tenant_id", access.tenantId).eq("site_id", input.siteId).eq("period", input.period)
          : supabaseAdmin().from("payroll_runs").select("total_net, total_gross, total_deductions").eq("tenant_id", access.tenantId).eq("site_id", input.siteId),
      ]);
      if (employeesResult.error || payrollResult.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل ملخص الموارد البشرية من Supabase." });
      const employeeSummary = new Map<string, { status: string; count: number; wages: number }>();
      for (const employee of employeesResult.data ?? []) {
        const row = employeeSummary.get(employee.employment_status) ?? { status: employee.employment_status, count: 0, wages: 0 };
        row.count += 1; row.wages += Number(employee.base_wage ?? 0); employeeSummary.set(employee.employment_status, row);
      }
      const payroll = (payrollResult.data ?? []).reduce((total, run) => ({ totalNet: total.totalNet + Number(run.total_net ?? 0), totalGross: total.totalGross + Number(run.total_gross ?? 0), totalDeductions: total.totalDeductions + Number(run.total_deductions ?? 0), count: total.count + 1 }), { totalNet: 0, totalGross: 0, totalDeductions: 0, count: 0 });
      return { employees: Array.from(employeeSummary.values()), payroll };
    }),
    listEmployees: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), search: z.string().trim().max(120).optional(), employmentStatus: z.enum(["active", "suspended", "ended"]).optional(), jobTitle: z.enum(["accountant", "collector", "technician", "worker", "supervisor", "other"]).optional() })).query(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "accountant"], "managePayroll");
      let query = supabaseAdmin().from("employees")
        .select("id, tenant_id, site_id, linked_user_id, full_name, identity_no, phone, job_title, employment_status, contract_type, base_wage, hire_date, notes, created_at, updated_at")
        .eq("tenant_id", access.tenantId).or(`site_id.eq.${input.siteId},site_id.is.null`);
      if (input.employmentStatus) query = query.eq("employment_status", input.employmentStatus);
      if (input.jobTitle) query = query.eq("job_title", input.jobTitle);
      const { data, error } = await query.order("created_at", { ascending: false }).limit(500);
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل الموظفين من Supabase." });
      const search = input.search?.toLocaleLowerCase("ar") ?? "";
      return (data ?? []).filter((employee) => !search || employee.full_name.toLocaleLowerCase("ar").includes(search) || employee.phone?.toLocaleLowerCase("ar").includes(search)).map((employee) => ({
        id: Number(employee.id), tenantId: Number(employee.tenant_id), siteId: employee.site_id === null ? null : Number(employee.site_id), linkedUserId: employee.linked_user_id === null ? null : Number(employee.linked_user_id),
        fullName: employee.full_name, identityNo: employee.identity_no, phone: employee.phone, jobTitle: employee.job_title, employmentStatus: employee.employment_status,
        contractType: employee.contract_type, baseWage: String(employee.base_wage), hireDate: employee.hire_date ? new Date(employee.hire_date) : null, notes: employee.notes,
        createdAt: new Date(employee.created_at), updatedAt: new Date(employee.updated_at),
      }));
    }),
    createEmployee: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), fullName: z.string().trim().min(2).max(180), identityNo: z.string().trim().max(80).optional(), phone: z.string().trim().max(40).optional(), jobTitle: z.enum(["accountant", "collector", "technician", "worker", "supervisor", "other"]), employmentStatus: z.enum(["active", "suspended", "ended"]).default("active"), contractType: z.enum(["daily", "monthly", "collection_percentage"]), baseWage: z.number().min(0).max(100000000), hireDate: z.string().optional(), notes: z.string().trim().max(2000).optional(), linkedUserId: z.number().int().positive().optional() })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner"], "manageTeam");
      const hireDate = input.hireDate ? new Date(input.hireDate) : null;
      if (input.hireDate && Number.isNaN(hireDate?.getTime())) throw new TRPCError({ code: "BAD_REQUEST", message: "تاريخ التعيين غير صحيح." });
      const { data, error } = await supabaseAdmin().rpc("powerhub_create_employee", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id, p_full_name: input.fullName,
        p_identity_no: input.identityNo ?? null, p_phone: input.phone ?? null, p_job_title: input.jobTitle,
        p_employment_status: input.employmentStatus, p_contract_type: input.contractType, p_base_wage: input.baseWage,
        p_hire_date: input.hireDate ?? null, p_notes: input.notes ?? null, p_linked_user_id: input.linkedUserId ?? null,
      });
      const result = (data as Array<{ employee_id: number | string }> | null)?.[0];
      if (!error && result?.employee_id) return { id: Number(result.employee_id) };
      const errorText = `${error?.code ?? ""} ${error?.message ?? ""}`;
      if (errorText.includes("SITE_OUT_OF_SCOPE")) throw new TRPCError({ code: "FORBIDDEN", message: "الفرع غير تابع لمساحة الشركة." });
      if (errorText.includes("LINKED_USER_OUT_OF_SCOPE")) throw new TRPCError({ code: "FORBIDDEN", message: "حساب الدخول المحدد ليس ضمن مساحة الشركة." });
      if (errorText.includes("INVALID_EMPLOYEE_INPUT")) throw new TRPCError({ code: "BAD_REQUEST", message: "بيانات الموظف غير صحيحة." });
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر إنشاء الموظف في Supabase." });
    }),
    listAdjustments: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), employeeId: z.number().int().positive().optional(), status: z.enum(["open", "settled", "cancelled"]).optional() })).query(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "manageExpenses");
      let query = supabaseAdmin().from("employee_adjustments")
        .select("id, tenant_id, employee_id, site_id, adjustment_type, amount, remaining_amount, reason, status, created_by_user_id, created_at, updated_at")
        .eq("tenant_id", access.tenantId).or(`site_id.eq.${input.siteId},site_id.is.null`);
      if (input.employeeId) query = query.eq("employee_id", input.employeeId);
      if (input.status) query = query.eq("status", input.status);
      const { data, error } = await query.order("created_at", { ascending: false }).limit(500);
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل السلف والخصومات من Supabase." });
      const employeeIds = Array.from(new Set((data ?? []).map((adjustment) => Number(adjustment.employee_id))));
      const { data: people, error: peopleError } = employeeIds.length ? await supabaseAdmin().from("employees").select("id, tenant_id, site_id, linked_user_id, full_name, identity_no, phone, job_title, employment_status, contract_type, base_wage, hire_date, notes, created_at, updated_at").eq("tenant_id", access.tenantId).in("id", employeeIds) : { data: [], error: null };
      if (peopleError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل موظفي السلف والخصومات من Supabase." });
      const peopleById = new Map((people ?? []).map((employee) => [Number(employee.id), employee]));
      return (data ?? []).flatMap((adjustment) => {
        const employee = peopleById.get(Number(adjustment.employee_id));
        return employee ? [{
          adjustment: { id: Number(adjustment.id), tenantId: Number(adjustment.tenant_id), employeeId: Number(adjustment.employee_id), siteId: adjustment.site_id === null ? null : Number(adjustment.site_id), adjustmentType: adjustment.adjustment_type, amount: String(adjustment.amount), remainingAmount: String(adjustment.remaining_amount), reason: adjustment.reason, status: adjustment.status, createdByUserId: Number(adjustment.created_by_user_id), createdAt: new Date(adjustment.created_at), updatedAt: new Date(adjustment.updated_at) },
          employee: { id: Number(employee.id), tenantId: Number(employee.tenant_id), siteId: employee.site_id === null ? null : Number(employee.site_id), linkedUserId: employee.linked_user_id === null ? null : Number(employee.linked_user_id), fullName: employee.full_name, identityNo: employee.identity_no, phone: employee.phone, jobTitle: employee.job_title, employmentStatus: employee.employment_status, contractType: employee.contract_type, baseWage: String(employee.base_wage), hireDate: employee.hire_date ? new Date(employee.hire_date) : null, notes: employee.notes, createdAt: new Date(employee.created_at), updatedAt: new Date(employee.updated_at) },
        }] : [];
      });
    }),
    createAdjustment: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), employeeId: z.number().int().positive(), adjustmentType: z.enum(["advance", "deduction"]), amount: z.number().positive().max(100000000), reason: z.string().trim().min(3).max(255) })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "accountant"], "manageExpenses");
      if (input.adjustmentType === "advance") throw new TRPCError({ code: "BAD_REQUEST", message: "لا تسجل السلفة كقيد يدوي؛ استخدم «السلف والديون» لتسجيل الصرف وربطه بحساب الشركة." });
      const { data, error } = await supabaseAdmin().rpc("powerhub_create_employee_adjustment", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id, p_employee_id: input.employeeId,
        p_adjustment_type: input.adjustmentType, p_amount: input.amount, p_reason: input.reason,
      });
      const result = (data as Array<{ adjustment_id: number | string }> | null)?.[0];
      if (!error && result?.adjustment_id) return { id: Number(result.adjustment_id) };
      const errorText = `${error?.code ?? ""} ${error?.message ?? ""}`;
      if (errorText.includes("EMPLOYEE_OUT_OF_SCOPE")) throw new TRPCError({ code: "NOT_FOUND", message: "الموظف غير موجود ضمن نطاقك." });
      if (errorText.includes("USE_EMPLOYEE_ADVANCE_RPC")) throw new TRPCError({ code: "BAD_REQUEST", message: "استخدم شاشة السلف والديون لتسجيل صرف السلفة بشكل صحيح." });
      if (errorText.includes("INVALID_EMPLOYEE_ADJUSTMENT_INPUT")) throw new TRPCError({ code: "BAD_REQUEST", message: "بيانات السلفة أو الخصم غير صحيحة." });
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر حفظ السلفة أو الخصم في Supabase." });
    }),
    listEmployeeAdvances: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(),
      status: z.enum(["open", "settled", "cancelled"]).optional(),
      advanceKind: z.enum(["salary_advance", "employee_loan"]).optional(),
      employeeId: z.number().int().positive().optional(),
    })).query(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "manageExpenses");
      let query = supabaseAdmin().from("employee_adjustments")
        .select("id,tenant_id,employee_id,site_id,adjustment_type,advance_kind,monthly_deduction,amount,remaining_amount,reason,status,disbursement_account_id,disbursement_transaction_id,disbursed_at,created_by_user_id,created_at,updated_at")
        .eq("tenant_id", access.tenantId).eq("site_id", input.siteId).eq("adjustment_type", "advance");
      if (input.status) query = query.eq("status", input.status);
      if (input.advanceKind) query = query.eq("advance_kind", input.advanceKind);
      if (input.employeeId) query = query.eq("employee_id", input.employeeId);
      const { data, error } = await query.order("created_at", { ascending: false }).limit(500);
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل سجل السلف والديون." });
      const ids = Array.from(new Set((data ?? []).map((row) => Number(row.employee_id))));
      const adjustmentIds = Array.from(new Set((data ?? []).map((row) => Number(row.id))));
      const [peopleResult, repaymentResult] = await Promise.all([
        ids.length ? supabaseAdmin().from("employees").select("id,tenant_id,site_id,linked_user_id,full_name,identity_no,phone,job_title,employment_status,contract_type,base_wage,hire_date,notes,created_at,updated_at").eq("tenant_id", access.tenantId).in("id", ids) : Promise.resolve({ data: [], error: null }),
        adjustmentIds.length ? supabaseAdmin().from("employee_adjustment_repayments").select("id,tenant_id,adjustment_id,repayment_method,amount,company_account_id,account_transaction_id,payroll_run_id,payment_date,reference_no,notes,operation_key,created_by_user_id,created_at").eq("tenant_id", access.tenantId).in("adjustment_id", adjustmentIds).order("payment_date", { ascending: false }).limit(2000) : Promise.resolve({ data: [], error: null }),
      ]);
      if (peopleResult.error || repaymentResult.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل تفاصيل الموظفين أو سداد السلف." });
      const people = new Map((peopleResult.data ?? []).map((person) => [Number(person.id), person]));
      type EmployeeAdvanceRepayment = {
        id: number; amount: string; repaymentMethod: string; companyAccountId: number | null;
        accountTransactionId: number | null; payrollRunId: number | null; paymentDate: string;
        referenceNo: string | null; notes: string | null; createdByUserId: number; createdAt: Date;
      };
      const repaymentsByAdjustment = new Map<number, EmployeeAdvanceRepayment[]>();
      for (const payment of repaymentResult.data ?? []) {
        const adjustmentId = Number(payment.adjustment_id);
        const entries = repaymentsByAdjustment.get(adjustmentId) ?? [];
        entries.push({
          id: Number(payment.id), amount: String(payment.amount), repaymentMethod: payment.repayment_method,
          companyAccountId: payment.company_account_id === null ? null : Number(payment.company_account_id),
          accountTransactionId: payment.account_transaction_id === null ? null : Number(payment.account_transaction_id),
          payrollRunId: payment.payroll_run_id === null ? null : Number(payment.payroll_run_id),
          paymentDate: payment.payment_date, referenceNo: payment.reference_no, notes: payment.notes,
          createdByUserId: Number(payment.created_by_user_id), createdAt: new Date(payment.created_at),
        });
        repaymentsByAdjustment.set(adjustmentId, entries);
      }
      return (data ?? []).flatMap((row) => {
        const employee = people.get(Number(row.employee_id));
        if (!employee) return [];
        return [{
          adjustment: {
            id: Number(row.id), tenantId: Number(row.tenant_id), employeeId: Number(row.employee_id),
            siteId: row.site_id === null ? null : Number(row.site_id), adjustmentType: row.adjustment_type,
            advanceKind: row.advance_kind, monthlyDeduction: row.monthly_deduction === null ? null : String(row.monthly_deduction),
            amount: String(row.amount), remainingAmount: String(row.remaining_amount), reason: row.reason, status: row.status,
            disbursementAccountId: row.disbursement_account_id === null ? null : Number(row.disbursement_account_id),
            disbursementTransactionId: row.disbursement_transaction_id === null ? null : Number(row.disbursement_transaction_id),
            disbursedAt: row.disbursed_at ? new Date(row.disbursed_at) : null,
            createdByUserId: Number(row.created_by_user_id), createdAt: new Date(row.created_at), updatedAt: new Date(row.updated_at),
          },
          employee: {
            id: Number(employee.id), fullName: employee.full_name, phone: employee.phone,
            jobTitle: employee.job_title, employmentStatus: employee.employment_status,
          },
          repayments: repaymentsByAdjustment.get(Number(row.id)) ?? [],
        }];
      });
    }),
    issueEmployeeAdvance: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(), employeeId: z.number().int().positive(),
      advanceKind: z.enum(["salary_advance", "employee_loan"]),
      amount: z.number().positive().max(100000000),
      monthlyDeduction: z.number().positive().max(100000000).optional(),
      accountId: z.number().int().positive(),
      paymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      reason: z.string().trim().min(3).max(255),
      operationKey: z.string().uuid(),
    })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "accountant"], "manageExpenses");
      if (input.advanceKind === "employee_loan" && (!input.monthlyDeduction || input.monthlyDeduction > input.amount)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "حدد قسطًا شهريًا موجبًا لا يتجاوز أصل الدين." });
      }
      if (input.advanceKind === "salary_advance" && input.monthlyDeduction !== undefined) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "السلفة على الراتب تُسترد تلقائيًا من أقرب كشف راتب؛ لا يلزم قسط يدوي." });
      }
      const { data, error } = await supabaseAdmin().rpc("powerhub_issue_employee_advance", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id,
        p_employee_id: input.employeeId, p_advance_kind: input.advanceKind, p_amount: input.amount,
        p_monthly_deduction: input.monthlyDeduction ?? null, p_account_id: input.accountId,
        p_payment_date: input.paymentDate, p_reason: input.reason.trim(), p_operation_key: input.operationKey,
      });
      const result = (data as Array<{ adjustment_id: number | string; account_transaction_id: number | string; remaining_amount: number | string; replayed: boolean }> | null)?.[0];
      if (!error && result?.adjustment_id) return { id: Number(result.adjustment_id), accountTransactionId: Number(result.account_transaction_id), remainingAmount: Number(result.remaining_amount), replayed: Boolean(result.replayed) };
      const errorText = `${error?.code ?? ""} ${error?.message ?? ""}`;
      if (errorText.includes("EMPLOYEE_OUT_OF_SCOPE") || errorText.includes("EMPLOYEE_INACTIVE")) throw new TRPCError({ code: "NOT_FOUND", message: "الموظف غير نشط أو غير تابع للفرع المحدد." });
      if (errorText.includes("COMPANY_ACCOUNT_NOT_FOUND") || errorText.includes("COMPANY_ACCOUNT_OUT_OF_SCOPE")) throw new TRPCError({ code: "NOT_FOUND", message: "حساب الصرف غير متاح لهذا الفرع." });
      if (errorText.includes("INSUFFICIENT_ACCOUNT_BALANCE")) throw new TRPCError({ code: "BAD_REQUEST", message: "رصيد حساب الصرف لا يكفي للمبلغ المطلوب." });
      if (errorText.includes("FINANCIAL_PERIOD_LOCKED")) throw new TRPCError({ code: "FORBIDDEN", message: "الفترة المالية مقفلة؛ لا يمكن صرف السلفة خلالها." });
      if (errorText.includes("IDEMPOTENCY_KEY_REUSED")) throw new TRPCError({ code: "CONFLICT", message: "مفتاح العملية مستخدم لبيانات مختلفة. أنشئ محاولة جديدة بعد مراجعة السجل." });
      if (errorText.includes("INVALID_EMPLOYEE_ADVANCE_INPUT")) throw new TRPCError({ code: "BAD_REQUEST", message: "بيانات السلفة أو الدين غير صحيحة." });
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تسجيل وصرف السلفة في Supabase." });
    }),
    repayEmployeeAdvance: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(), adjustmentId: z.number().int().positive(),
      accountId: z.number().int().positive(), amount: z.number().positive().max(100000000),
      paymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      referenceNo: z.string().trim().max(100).optional(), notes: z.string().trim().max(500).optional(),
      operationKey: z.string().uuid(),
    })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "accountant"], "manageExpenses");
      const { data, error } = await supabaseAdmin().rpc("powerhub_repay_employee_advance", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id,
        p_adjustment_id: input.adjustmentId, p_account_id: input.accountId, p_amount: input.amount,
        p_payment_date: input.paymentDate, p_reference_no: input.referenceNo?.trim() || null,
        p_notes: input.notes?.trim() || null, p_operation_key: input.operationKey,
      });
      const result = (data as Array<{ repayment_id: number | string; adjustment_id: number | string; remaining_amount: number | string; account_transaction_id: number | string; replayed: boolean }> | null)?.[0];
      if (!error && result?.repayment_id) return { id: Number(result.repayment_id), adjustmentId: Number(result.adjustment_id), remainingAmount: Number(result.remaining_amount), accountTransactionId: Number(result.account_transaction_id), replayed: Boolean(result.replayed) };
      const errorText = `${error?.code ?? ""} ${error?.message ?? ""}`;
      if (errorText.includes("ADVANCE_OUT_OF_SCOPE")) throw new TRPCError({ code: "NOT_FOUND", message: "السلفة أو الدين غير موجود ضمن الفرع." });
      if (errorText.includes("REPAYMENT_EXCEEDS_REMAINING")) throw new TRPCError({ code: "BAD_REQUEST", message: "مبلغ السداد أكبر من الرصيد المتبقي." });
      if (errorText.includes("ADVANCE_BALANCE_RESERVED")) throw new TRPCError({ code: "CONFLICT", message: "لا يمكن سداد هذا المبلغ الآن؛ يوجد جزء من الرصيد محجوز في كشف راتب مفتوح. راجع الكشف أو ألغِه قبل المتابعة." });
      if (errorText.includes("COMPANY_ACCOUNT_NOT_FOUND") || errorText.includes("COMPANY_ACCOUNT_OUT_OF_SCOPE")) throw new TRPCError({ code: "NOT_FOUND", message: "حساب الإيداع غير متاح لهذا الفرع." });
      if (errorText.includes("FINANCIAL_PERIOD_LOCKED")) throw new TRPCError({ code: "FORBIDDEN", message: "الفترة المالية مقفلة؛ لا يمكن تسجيل السداد خلالها." });
      if (errorText.includes("IDEMPOTENCY_KEY_REUSED")) throw new TRPCError({ code: "CONFLICT", message: "مفتاح السداد مستخدم لبيانات مختلفة. راجع السجل قبل إعادة المحاولة." });
      if (errorText.includes("INVALID_ADVANCE_REPAYMENT")) throw new TRPCError({ code: "BAD_REQUEST", message: "بيانات السداد غير صحيحة." });
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تسجيل سداد السلفة أو الدين." });
    }),
    getPayrollDetails: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), payrollRunId: z.number().int().positive() })).query(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "accountant"], "managePayroll");
      const { data: run, error: runError } = await supabaseAdmin().from("payroll_runs").select("id").eq("tenant_id", access.tenantId).eq("site_id", input.siteId).eq("id", input.payrollRunId).maybeSingle();
      if (runError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر التحقق من كشف الراتب في Supabase." });
      if (!run) return [];
      const { data: items, error: itemsError } = await supabaseAdmin().from("payroll_items").select("id, payroll_run_id, employee_id, base_amount, extra_amount, advance_deduction, other_deduction, net_amount, notes").eq("payroll_run_id", input.payrollRunId).limit(500);
      if (itemsError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل بنود كشف الراتب من Supabase." });
      const employeeIds = Array.from(new Set((items ?? []).map((item) => Number(item.employee_id))));
      const { data: people, error: peopleError } = employeeIds.length ? await supabaseAdmin().from("employees").select("id, full_name, job_title").eq("tenant_id", access.tenantId).in("id", employeeIds) : { data: [], error: null };
      if (peopleError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل موظفي كشف الراتب من Supabase." });
      const peopleById = new Map((people ?? []).map((employee) => [Number(employee.id), employee]));
      return (items ?? []).flatMap((item) => {
        const employee = peopleById.get(Number(item.employee_id));
        return employee ? [{ item: { id: Number(item.id), payrollRunId: Number(item.payroll_run_id), employeeId: Number(item.employee_id), baseAmount: String(item.base_amount), extraAmount: String(item.extra_amount), advanceDeduction: String(item.advance_deduction), otherDeduction: String(item.other_deduction), netAmount: String(item.net_amount), notes: item.notes }, employee: { id: Number(employee.id), fullName: employee.full_name, jobTitle: employee.job_title } }] : [];
      }).sort((left, right) => left.employee.fullName.localeCompare(right.employee.fullName, "ar"));
    }),
    listPayrollRuns: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional() })).query(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "accountant"], "managePayroll");
      let query = supabaseAdmin().from("payroll_runs").select("id, tenant_id, site_id, period, status, total_gross, total_deductions, total_net, paid_from_account_id, approved_by_user_id, paid_at, created_by_user_id, created_at, updated_at").eq("tenant_id", access.tenantId).or(`site_id.eq.${input.siteId},site_id.is.null`);
      if (input.period) query = query.eq("period", input.period);
      const { data, error } = await query.order("period", { ascending: false }).limit(120);
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل كشوف الرواتب من Supabase." });
      return (data ?? []).map((run) => ({
        id: Number(run.id), tenantId: Number(run.tenant_id), siteId: run.site_id === null ? null : Number(run.site_id), period: run.period, status: run.status,
        totalGross: String(run.total_gross), totalDeductions: String(run.total_deductions), totalNet: String(run.total_net), paidFromAccountId: run.paid_from_account_id === null ? null : Number(run.paid_from_account_id), approvedByUserId: run.approved_by_user_id === null ? null : Number(run.approved_by_user_id), paidAt: run.paid_at ? new Date(run.paid_at) : null, createdByUserId: Number(run.created_by_user_id), createdAt: new Date(run.created_at), updatedAt: new Date(run.updated_at),
      }));
    }),
    createPayrollDraft: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), items: z.array(z.object({ employeeId: z.number().int().positive(), extraAmount: z.number().min(0).default(0), advanceDeduction: z.number().min(0).default(0), otherDeduction: z.number().min(0).default(0), notes: z.string().trim().max(500).optional() })).min(1) })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "accountant"], "managePayroll");
      const { data, error } = await supabaseAdmin().rpc("powerhub_create_payroll_draft", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id, p_period: input.period,
        p_items: input.items.map((item) => ({ employee_id: item.employeeId, extra_amount: item.extraAmount, advance_deduction: item.advanceDeduction, other_deduction: item.otherDeduction, notes: item.notes ?? null })),
      });
      const result = (data as Array<{ payroll_run_id: number | string; total_net: number | string }> | null)?.[0];
      if (!error && result?.payroll_run_id) return { id: Number(result.payroll_run_id), totalNet: Number(result.total_net) };
      const errorText = `${error?.code ?? ""} ${error?.message ?? ""}`;
      if (errorText.includes("SITE_OUT_OF_SCOPE")) throw new TRPCError({ code: "FORBIDDEN", message: "الفرع غير تابع لمساحة الشركة." });
      if (errorText.includes("FINANCIAL_PERIOD_LOCKED")) throw new TRPCError({ code: "FORBIDDEN", message: "الفترة المالية مقفلة؛ لا يمكن إنشاء مسودة رواتب ضمنها." });
      if (errorText.includes("EMPLOYEE_OUT_OF_SCOPE_OR_INACTIVE")) throw new TRPCError({ code: "BAD_REQUEST", message: "توجد موظفة أو موظف غير نشط أو خارج الفرع المحدد." });
      if (errorText.includes("NEGATIVE_PAYROLL_NET")) throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن أن يكون صافي راتب الموظف سالباً." });
      if (errorText.includes("PAYROLL_PERIOD_ALREADY_EXISTS")) throw new TRPCError({ code: "CONFLICT", message: "يوجد كشف رواتب لهذه الفترة والفرع بالفعل." });
      if (errorText.includes("PAYROLL_OPEN_RUN_EXISTS")) throw new TRPCError({ code: "CONFLICT", message: "يوجد كشف رواتب غير مسدد لهذا الفرع. اعتمده وصرفه أو ألغِ المسودة أولاً لتحرير حجوزات السلف." });
      if (errorText.includes("DUPLICATE_PAYROLL_EMPLOYEE") || errorText.includes("INVALID_PAYROLL_DRAFT_INPUT")) throw new TRPCError({ code: "BAD_REQUEST", message: "بيانات مسودة الرواتب غير صحيحة." });
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر إنشاء مسودة الرواتب في Supabase." });
    }),
    cancelPayrollDraft: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), payrollRunId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "accountant"], "managePayroll");
      const { data, error } = await supabaseAdmin().rpc("powerhub_cancel_payroll_draft", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id, p_payroll_run_id: input.payrollRunId,
      });
      const result = (data as Array<{ payroll_run_id: number | string; cancelled: boolean }> | null)?.[0];
      if (!error && result?.payroll_run_id) return { success: true, replayed: Boolean(result.cancelled) };
      const errorText = `${error?.code ?? ""} ${error?.message ?? ""}`;
      if (errorText.includes("PAYROLL_RUN_OUT_OF_SCOPE")) throw new TRPCError({ code: "NOT_FOUND", message: "مسودة الرواتب غير موجودة ضمن الفرع." });
      if (errorText.includes("PAYROLL_RUN_NOT_DRAFT")) throw new TRPCError({ code: "BAD_REQUEST", message: "يمكن إلغاء المسودة فقط قبل الاعتماد؛ لا يمكن إلغاء كشف معتمد أو مصروف." });
      if (errorText.includes("FINANCIAL_PERIOD_LOCKED")) throw new TRPCError({ code: "FORBIDDEN", message: "الفترة المالية مقفلة؛ لا يمكن إلغاء مسودة الرواتب." });
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر إلغاء مسودة الرواتب في Supabase." });
    }),
    approvePayroll: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), payrollRunId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "accountant"], "managePayroll");
      const { data, error } = await supabaseAdmin().rpc("powerhub_approve_payroll", { p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id, p_payroll_run_id: input.payrollRunId });
      const result = (data as Array<{ payroll_run_id: number | string }> | null)?.[0];
      if (!error && result?.payroll_run_id) return { success: true };
      const errorText = `${error?.code ?? ""} ${error?.message ?? ""}`;
      if (errorText.includes("PAYROLL_RUN_OUT_OF_SCOPE")) throw new TRPCError({ code: "NOT_FOUND", message: "مسودة الراتب غير موجودة." });
      if (errorText.includes("PAYROLL_RUN_NOT_DRAFT")) throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن اعتماد مسودة ليست في حالة مسودة." });
      if (errorText.includes("FINANCIAL_PERIOD_LOCKED")) throw new TRPCError({ code: "FORBIDDEN", message: "الفترة المالية مقفلة؛ لا يمكن اعتماد كشف الرواتب ضمنها." });
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر اعتماد كشف الرواتب في Supabase." });
    }),
    payPayroll: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), payrollRunId: z.number().int().positive(), accountId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "accountant"], "managePayroll");
      const { data, error } = await supabaseAdmin().rpc("powerhub_pay_payroll", { p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id, p_payroll_run_id: input.payrollRunId, p_account_id: input.accountId });
      const result = (data as Array<{ payroll_run_id: number | string }> | null)?.[0];
      if (!error && result?.payroll_run_id) return { success: true };
      const errorText = `${error?.code ?? ""} ${error?.message ?? ""}`;
      if (errorText.includes("PAYROLL_RUN_OUT_OF_SCOPE")) throw new TRPCError({ code: "NOT_FOUND", message: "كشف الراتب غير موجود." });
      if (errorText.includes("PAYROLL_RUN_NOT_APPROVED")) throw new TRPCError({ code: "BAD_REQUEST", message: "يجب اعتماد كشف الراتب قبل صرفه." });
      if (errorText.includes("COMPANY_ACCOUNT_NOT_FOUND")) throw new TRPCError({ code: "NOT_FOUND", message: "حساب الصرف غير موجود ضمن مساحة الشركة." });
      if (errorText.includes("COMPANY_ACCOUNT_OUT_OF_SCOPE")) throw new TRPCError({ code: "FORBIDDEN", message: "حساب الصرف غير مربوط بالفرع المحدد." });
      if (errorText.includes("INSUFFICIENT_ACCOUNT_BALANCE")) throw new TRPCError({ code: "BAD_REQUEST", message: "رصيد حساب الصرف لا يكفي لصرف كشف الرواتب." });
      if (errorText.includes("FINANCIAL_PERIOD_LOCKED")) throw new TRPCError({ code: "FORBIDDEN", message: "الفترة المالية مقفلة؛ لا يمكن صرف الرواتب ضمنها." });
      if (errorText.includes("ADVANCE_ALLOCATION_CONFLICT")) throw new TRPCError({ code: "CONFLICT", message: "تعارض في حجز السلف؛ راجع كشف الرواتب قبل الصرف." });
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر صرف كشف الرواتب في Supabase." });
    }),
    updateEmployee: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), employeeId: z.number().int().positive(), fullName: z.string().trim().min(2).max(180).optional(), identityNo: z.string().trim().max(80).nullable().optional(), phone: z.string().trim().max(40).nullable().optional(), jobTitle: z.enum(["accountant", "collector", "technician", "worker", "supervisor", "other"]).optional(), employmentStatus: z.enum(["active", "suspended", "ended"]).optional(), contractType: z.enum(["daily", "monthly", "collection_percentage"]).optional(), baseWage: z.number().min(0).max(100000000).optional(), hireDate: z.string().nullable().optional(), notes: z.string().trim().max(2000).nullable().optional() })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner"], "manageTeam");
      if (input.hireDate) { const hireDate = new Date(input.hireDate); if (Number.isNaN(hireDate.getTime())) throw new TRPCError({ code: "BAD_REQUEST", message: "تاريخ التعيين غير صحيح." }); }
      const patch = Object.fromEntries(Object.entries({ fullName: input.fullName, identityNo: input.identityNo, phone: input.phone, jobTitle: input.jobTitle, employmentStatus: input.employmentStatus, contractType: input.contractType, baseWage: input.baseWage, hireDate: input.hireDate, notes: input.notes }).filter(([, value]) => value !== undefined));
      const { data, error } = await supabaseAdmin().rpc("powerhub_update_employee", { p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id, p_employee_id: input.employeeId, p_patch: patch });
      const result = (data as Array<{ employee_id: number | string }> | null)?.[0];
      if (!error && result?.employee_id) return { success: true };
      const errorText = `${error?.code ?? ""} ${error?.message ?? ""}`;
      if (errorText.includes("EMPLOYEE_OUT_OF_SCOPE")) throw new TRPCError({ code: "NOT_FOUND", message: "الموظف غير موجود ضمن نطاقك." });
      if (errorText.includes("INVALID_EMPLOYEE_PATCH") || errorText.includes("invalid input syntax for type date")) throw new TRPCError({ code: "BAD_REQUEST", message: "بيانات تعديل الموظف غير صحيحة." });
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تعديل الموظف في Supabase." });
    }),
  }),
  audit: router({
    list: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "viewer"], "viewAudit");
      const { data, error } = await supabaseAdmin().from("audit_logs")
        .select("id, tenant_id, site_id, user_id, actor_platform_role, actor_tenant_role, entity_type, entity_id, action, before_data, after_data, metadata, created_at")
        .eq("tenant_id", access.tenantId)
        .eq("site_id", input.siteId)
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل سجل التدقيق من Supabase." });
      return (data ?? []).map((entry) => ({
        id: Number(entry.id), tenantId: Number(entry.tenant_id), siteId: Number(entry.site_id),
        userId: entry.user_id === null ? null : Number(entry.user_id), actorPlatformRole: entry.actor_platform_role,
        actorTenantRole: entry.actor_tenant_role, entityType: entry.entity_type, entityId: entry.entity_id,
        action: entry.action, beforeData: entry.before_data, afterData: entry.after_data, metadata: entry.metadata,
        createdAt: new Date(entry.created_at),
      }));
    }),
  }),
  mobileSync: router({
    summary: protectedProcedure.input(mobileSyncSummaryInput).query(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "viewer"], "viewAudit");
      const from = input.from ? new Date(input.from) : new Date(Date.now() - 24 * 60 * 60 * 1000);
      const to = input.to ? new Date(input.to) : new Date();
      let query = supabaseAdmin().from("mobile_sync_events")
        .select("user_id, status, synced_count, retryable_count, needs_review_count, occurred_at")
        .eq("tenant_id", access.tenantId).eq("site_id", input.siteId)
        .gte("occurred_at", from.toISOString()).lte("occurred_at", to.toISOString());
      // Keep KPI scope identical to the selected technician filter used by the
      // events list and the reading-details table; otherwise a branch-wide count
      // can show 3 while the detail table is correctly filtered to another user.
      if (input.userId) query = query.eq("user_id", input.userId);
      const { data, error } = await query;
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل ملخص المزامنة الميدانية من Supabase." });
      const rows = data ?? [];
      const lastEventAt = rows.reduce<string | null>((latest, row) => !latest || row.occurred_at > latest ? row.occurred_at : latest, null);
      return {
        cycles: rows.length,
        syncedReadings: rows.reduce((total, row) => total + Number(row.synced_count ?? 0), 0),
        retryableReadings: rows.reduce((total, row) => total + Number(row.retryable_count ?? 0), 0),
        needsReviewReadings: rows.reduce((total, row) => total + Number(row.needs_review_count ?? 0), 0),
        failedEvents: rows.filter((row) => row.status === "failed" || row.status === "needs_review").length,
        activeTechnicians: new Set(rows.map((row) => Number(row.user_id))).size,
        lastEventAt: lastEventAt ? new Date(lastEventAt) : null,
      };
    }),
    list: protectedProcedure.input(siteScoped.extend({ status: z.enum(["success", "partial", "retryable", "needs_review", "failed"]).optional(), userId: z.number().int().positive().optional(), from: z.string().datetime().optional(), to: z.string().datetime().optional(), page: z.number().int().min(1).default(1), pageSize: z.number().int().min(10).max(100).default(25) })).query(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "viewer"], "viewAudit");
      let query = supabaseAdmin().from("mobile_sync_events")
        .select("id, user_id, event_type, status, synced_count, retryable_count, needs_review_count, error_code, error_message, app_version, device_label, occurred_at")
        .eq("tenant_id", access.tenantId).eq("site_id", input.siteId);
      if (input.status) query = query.eq("status", input.status);
      if (input.userId) query = query.eq("user_id", input.userId);
      if (input.from) query = query.gte("occurred_at", input.from);
      if (input.to) query = query.lte("occurred_at", input.to);
      const { data, error } = await query.order("occurred_at", { ascending: false }).range((input.page - 1) * input.pageSize, input.page * input.pageSize - 1);
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل أحداث المزامنة الميدانية من Supabase." });
      const userIds = Array.from(new Set((data ?? []).map((row) => Number(row.user_id))));
      const { data: usersData, error: usersError } = userIds.length ? await supabaseAdmin().from("users").select("id, name, email").in("id", userIds) : { data: [], error: null };
      if (usersError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل منفذي المزامنة من Supabase." });
      const usersById = new Map((usersData ?? []).map((user) => [Number(user.id), user]));
      return (data ?? []).map((row) => {
        const user = usersById.get(Number(row.user_id));
        return {
          id: Number(row.id), eventType: row.event_type as "sync_cycle" | "sync_error", status: row.status as "success" | "partial" | "retryable" | "needs_review" | "failed", syncedCount: Number(row.synced_count), retryableCount: Number(row.retryable_count), needsReviewCount: Number(row.needs_review_count),
          errorCode: row.error_code, errorMessage: row.error_message, appVersion: row.app_version, deviceLabel: row.device_label, occurredAt: new Date(row.occurred_at),
          userId: Number(row.user_id), userName: user?.name ?? null, userEmail: user?.email ?? null,
        };
      });
    }),
    readings: protectedProcedure.input(mobileSyncReadingsInput).query(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "viewer"], "viewAudit");
      let auditQuery = supabaseAdmin().from("audit_logs")
        .select("entity_id, user_id, created_at")
        .eq("tenant_id", access.tenantId).eq("site_id", input.siteId)
        .in("entity_type", ["meter_reading", "subscriber_reading"]).eq("action", "mobile_create");
      if (input.userId) auditQuery = auditQuery.eq("user_id", input.userId);
      if (input.from) auditQuery = auditQuery.gte("created_at", input.from);
      if (input.to) auditQuery = auditQuery.lte("created_at", input.to);
      const { data: auditRows, error: auditError } = await auditQuery.order("created_at", { ascending: false }).range((input.page - 1) * input.pageSize, input.page * input.pageSize - 1);
      if (auditError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل تدقيق القراءات الميدانية من Supabase." });
      const readingIds = (auditRows ?? []).map((row) => Number(row.entity_id)).filter(Number.isInteger);
      if (!readingIds.length) return [];
      const [readingsResult, subscribersResult] = await Promise.all([
        supabaseAdmin().from("meter_readings").select("id, version_no, subscriber_id, previous_reading_value, reading_value, reading_at, status").eq("tenant_id", access.tenantId).in("id", readingIds),
        supabaseAdmin().from("subscribers").select("id, full_name, subscriber_no").eq("tenant_id", access.tenantId).eq("site_id", input.siteId),
      ]);
      if (readingsResult.error || subscribersResult.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل تفاصيل القراءات الميدانية من Supabase." });
      const readingsById = new Map((readingsResult.data ?? []).map((reading) => [Number(reading.id), reading]));
      const subscribersById = new Map((subscribersResult.data ?? []).map((subscriber) => [Number(subscriber.id), subscriber]));
      return (auditRows ?? []).flatMap((audit) => {
        const reading = readingsById.get(Number(audit.entity_id));
        const subscriber = reading ? subscribersById.get(Number(reading.subscriber_id)) : undefined;
        return reading && subscriber ? [{
          id: Number(reading.id), versionNo: Number(reading.version_no), subscriberName: subscriber.full_name, subscriberNo: subscriber.subscriber_no,
          previousReading: Number(reading.previous_reading_value), currentReading: Number(reading.reading_value), readingAt: new Date(reading.reading_at),
          syncedAt: new Date(audit.created_at), status: reading.status, userId: audit.user_id === null ? null : Number(audit.user_id),
        }] : [];
      });
    }),
    readingDetail: protectedProcedure.input(mobileSyncReadingDetailInput).query(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "viewer"], "viewAudit");
      const { data: audit, error: auditError } = await supabaseAdmin().from("audit_logs")
        .select("user_id, created_at").eq("tenant_id", access.tenantId).eq("site_id", input.siteId)
        .in("entity_type", ["meter_reading", "subscriber_reading"]).eq("action", "mobile_create").eq("entity_id", String(input.readingId)).order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (auditError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر التحقق من مصدر القراءة الميدانية في Supabase." });
      if (!audit || audit.user_id === null) throw new TRPCError({ code: "NOT_FOUND", message: "القراءة الميدانية غير موجودة ضمن الفرع المحدد." });
      const { data: reading, error: readingError } = await supabaseAdmin().from("meter_readings")
        .select("id, version_no, subscriber_id, previous_reading_value, reading_value, consumption_kwh, reading_at, status, capture_method, notes")
        .eq("tenant_id", access.tenantId).eq("id", input.readingId).maybeSingle();
      if (readingError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل القراءة الميدانية من Supabase." });
      if (!reading) throw new TRPCError({ code: "NOT_FOUND", message: "القراءة الميدانية غير موجودة ضمن الفرع المحدد." });
      const [subscriberResult, technicianResult] = await Promise.all([
        supabaseAdmin().from("subscribers").select("id, full_name, subscriber_no").eq("tenant_id", access.tenantId).eq("site_id", input.siteId).eq("id", reading.subscriber_id).maybeSingle(),
        supabaseAdmin().from("users").select("name, email").eq("id", audit.user_id).maybeSingle(),
      ]);
      if (subscriberResult.error || technicianResult.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل تفاصيل القراءة الميدانية من Supabase." });
      if (!subscriberResult.data || !technicianResult.data) throw new TRPCError({ code: "NOT_FOUND", message: "القراءة الميدانية غير موجودة ضمن الفرع المحدد." });
      return {
        id: Number(reading.id), versionNo: Number(reading.version_no), subscriberId: Number(subscriberResult.data.id), subscriberName: subscriberResult.data.full_name, subscriberNo: subscriberResult.data.subscriber_no,
        previousReading: Number(reading.previous_reading_value), currentReading: Number(reading.reading_value), consumptionKwh: Number(reading.consumption_kwh),
        readingAt: new Date(reading.reading_at), syncedAt: new Date(audit.created_at), status: reading.status as "draft" | "pending_review" | "approved" | "rejected", captureMethod: reading.capture_method,
        notes: reading.notes, technicianName: technicianResult.data.name, technicianEmail: technicianResult.data.email,
      };
    }),
    approveAndIssue: approveAndIssueMobileReadingRuntime,
    approveAllAndIssue: protectedProcedure.input(mobileSyncBulkApprovalInput).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "approveReadings");
      await requireSupabaseSiteRole(ctx.user.id, input.siteId, createRoles, "issueInvoices");

      // Keep each server request bounded to at most 100 approvals, but scan past
      // already-reviewed events so a client can safely process a larger total in
      // sequential batches. Excluded IDs keep failed items from looping forever
      // inside a single multi-batch action.
      const excludedReadingIds = new Set<number>(input.excludeReadingIds ?? []);
      const seenReadingIds = new Set<number>(excludedReadingIds);
      const selectedAuditRows: Array<{ entity_id: string; user_id: number | null; created_at: string }> = [];
      const auditScanPageSize = 500;
      let auditOffset = 0;

      while (selectedAuditRows.length < input.limit) {
        let auditQuery = supabaseAdmin().from("audit_logs")
          .select("entity_id, user_id, created_at")
          .eq("tenant_id", access.tenantId)
          .eq("site_id", input.siteId)
          .in("entity_type", ["meter_reading", "subscriber_reading"])
          .eq("action", "mobile_create");
        if (input.userId) auditQuery = auditQuery.eq("user_id", input.userId);
        if (input.from) auditQuery = auditQuery.gte("created_at", input.from);
        if (input.to) auditQuery = auditQuery.lte("created_at", input.to);
        const { data: pageRows, error: auditError } = await auditQuery
          .order("created_at", { ascending: false })
          .range(auditOffset, auditOffset + auditScanPageSize - 1);
        if (auditError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل القراءات المؤهلة للاعتماد الجماعي." });

        const page = pageRows ?? [];
        if (!page.length) break;
        auditOffset += page.length;

        const newAuditRows: Array<{ entity_id: string; user_id: number | null; created_at: string }> = [];
        for (const audit of page) {
          const readingId = Number(audit.entity_id);
          if (!Number.isSafeInteger(readingId) || readingId <= 0 || seenReadingIds.has(readingId)) continue;
          seenReadingIds.add(readingId);
          newAuditRows.push(audit);
        }

        if (newAuditRows.length) {
          const candidateIds = newAuditRows.map((row) => Number(row.entity_id));
          const { data: candidateReadings, error: candidateError } = await supabaseAdmin().from("meter_readings")
            .select("id, status")
            .eq("tenant_id", access.tenantId)
            .in("id", candidateIds);
          if (candidateError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر التحقق من حالات القراءات قبل الاعتماد الجماعي." });

          const pendingIds = new Set((candidateReadings ?? [])
            .filter((reading) => reading.status === "pending_review")
            .map((reading) => Number(reading.id)));
          for (const audit of newAuditRows) {
            if (!pendingIds.has(Number(audit.entity_id))) continue;
            selectedAuditRows.push(audit);
            if (selectedAuditRows.length >= input.limit) break;
          }
        }

        if (page.length < auditScanPageSize) break;
      }

      const readingIds = selectedAuditRows.map((row) => Number(row.entity_id));
      if (!readingIds.length) {
        return { requested: 0, succeeded: 0, failed: 0, replayed: 0, results: [] as Array<{ readingId: number; status: "succeeded" | "failed" | "replayed"; invoiceNo?: string; error?: string }> };
      }

      const { data: readingRows, error: readingsError } = await supabaseAdmin().from("meter_readings")
        .select("id, subscriber_id, reading_at, status, version_no")
        .eq("tenant_id", access.tenantId)
        .in("id", readingIds);
      if (readingsError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل حالات القراءات للاعتماد الجماعي." });

      const pendingById = new Map((readingRows ?? []).filter((row) => row.status === "pending_review").map((row) => [Number(row.id), row]));
      const results: Array<{ readingId: number; status: "succeeded" | "failed" | "replayed"; invoiceNo?: string; error?: string }> = [];

      for (const readingId of readingIds) {
        const reading = pendingById.get(readingId);
        if (!reading) {
          results.push({ readingId, status: "failed", error: "القراءة لم تعد بانتظار المراجعة أو تمت معالجتها مسبقاً." });
          continue;
        }
        try {
          const result = await executeApproveAndIssueMobileReading({
            tenantId: access.tenantId,
            siteId: input.siteId,
            userId: ctx.user.id,
            readingId,
            baseVersion: Number(reading.version_no),
            sendNow: input.sendNow,
          });
          results.push({ readingId, status: result.alreadyProcessed ? "replayed" : "succeeded", invoiceNo: result.invoiceNo });
        } catch (error) {
          results.push({ readingId, status: "failed", error: error instanceof Error ? error.message : "تعذر اعتماد القراءة وإصدار فاتورتها." });
        }
      }

      return {
        requested: results.length,
        succeeded: results.filter((row) => row.status === "succeeded").length,
        failed: results.filter((row) => row.status === "failed").length,
        replayed: results.filter((row) => row.status === "replayed").length,
        results,
      };
    }),
    technicians: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "viewer"], "viewAudit");
      const { data: profiles, error: profilesError } = await supabaseAdmin().from("staff_profiles").select("user_id")
        .eq("tenant_id", access.tenantId).eq("is_active", true).or(`site_id.eq.${input.siteId},site_id.is.null`);
      if (profilesError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل تعيينات الفنيين من Supabase." });
      const userIds = Array.from(new Set((profiles ?? []).map((profile) => Number(profile.user_id))));
      if (!userIds.length) return [];
      const { data, error } = await supabaseAdmin().from("users").select("id, name, email").in("id", userIds);
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل قائمة الفنيين من Supabase." });
      return (data ?? []).map((user) => ({ id: Number(user.id), name: user.name, email: user.email }));
    }),
  }),
});
