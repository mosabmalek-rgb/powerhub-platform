import { TRPCError } from "@trpc/server";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { supabaseAdmin } from "./supabase-admin";
import { completePasswordResetWithRetry } from "./password-reset-runtime";
import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
import { calculateCompanyAccountBalance } from "./company-account-utils";
import { calculateInvoiceAmounts, generateInvoiceShareToken, hashInvoiceShareToken, nextInvoiceNo } from "./powerhub-utils";
import { buildFinancialOverview } from "./financial-overview-utils";
import { invoiceDeliveryPolicyFromSetting, isInvoiceDeliveryChannelEnabled, resolveInvoiceNotificationChannels } from "./notification-channels";
import { defaultInvoiceMessageTemplates, renderInvoiceMessageTemplate } from "./invoice-message-template";
import { probeMessagingConnection } from "./messaging-connection";
import { defaultPaymentReceiptSmsTemplate, renderPaymentReceiptMessage, renderPaymentReceiptTemplate, paymentReceiptTemplateParameters } from "./payment-receipt-message";
import { normalizeInternationalPhone } from "../shared/phone";
import { processNotificationById, processNotificationQueueForTenant } from "./notification-worker";
import { storageGet, storagePut, storageRemove } from "./storage";
import { encryptTenantCredential, hashWebhookVerifyToken } from "./tenant-crypto";
import { rolesWith, type PowerCapability, type PowerRole } from "../shared/powerhub-rbac";
import { COOKIE_NAME } from "../shared/const";
import { getSupabaseDashboardSummary, getSupabaseFinancialOverview, getSupabaseOwnerSubscriberQuota, getSupabaseSite, listSupabaseAccessibleSites, listSupabaseCompanyAccounts, listSupabaseExpenses, listSupabaseGenerators, listSupabaseInvoices, listSupabasePayments, listSupabaseReadings, listSupabaseSubscribers, listSupabaseTariffs, recordSupabaseSubscriberQuotaAlert, requireSupabaseAllBranchesRole, requireSupabaseSiteRole, resolveSupabaseSiteAccess, writeSupabaseAudit, writeSupabaseAuditBestEffort } from "./powerhub-supabase";

const createRoles = rolesWith("issueInvoices");
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
async function getOfflineReplayForScope(input: {
  userId: number;
  tenantId: number;
  siteId: number;
  clientOperationId?: string;
  expectedOperationType: string;
}) {
  if (!input.clientOperationId) return null;
  const { data, error } = await supabaseAdmin()
    .from("offline_sync_operations")
    .select("tenant_id, site_id, operation_type, response")
    .eq("user_id", input.userId)
    .eq("client_operation_id", input.clientOperationId)
    .maybeSingle();
  if (error) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "تعذر التحقق من مفتاح المزامنة في Supabase.",
    });
  }
  if (!data) return null;
  if (
    Number(data.tenant_id) !== input.tenantId ||
    Number(data.site_id) !== input.siteId ||
    data.operation_type !== input.expectedOperationType
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "مفتاح عملية المزامنة مرتبط بنطاق أو نوع عملية مختلف.",
    });
  }
  return data.response as Record<string, unknown>;
}

async function reconcilePaymentAfterError(input: {
  userId: number;
  tenantId: number;
  siteId: number;
  clientOperationId?: string;
}) {
  if (!input.clientOperationId) return { resolved: false as const };
  const admin = supabaseAdmin();
  const { data: op, error: opError } = await admin
    .from("offline_sync_operations")
    .select("tenant_id, site_id, operation_type, response")
    .eq("user_id", input.userId)
    .eq("client_operation_id", input.clientOperationId)
    .maybeSingle();
  if (opError) return { resolved: false as const };
  if (op) {
    if (
      Number(op.tenant_id) !== input.tenantId ||
      Number(op.site_id) !== input.siteId ||
      op.operation_type !== "payment_create"
    ) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "مفتاح عملية المزامنة مرتبط بنطاق أو نوع عملية مختلف.",
      });
    }
    const id = Number((op.response as Record<string, unknown> | null)?.id);
    if (Number.isInteger(id) && id > 0) return { resolved: true as const, id };
  }
  const { data: payment, error: paymentError } = await admin
    .from("payments")
    .select("id, tenant_id, site_id")
    .eq("tenant_id", input.tenantId)
    .eq("site_id", input.siteId)
    .eq("client_operation_id", input.clientOperationId)
    .maybeSingle();
  if (!paymentError && payment) return { resolved: true as const, id: Number(payment.id) };
  return { resolved: false as const };
}

async function reconcileReadingAfterError(input: {
  tenantId: number;
  siteId: number;
  subscriberId: number;
  clientOperationId?: string;
  issueInvoice: boolean;
}) {
  if (!input.clientOperationId) return { resolved: false as const };
  const admin = supabaseAdmin();
  const { data: subscriber, error: subscriberError } = await admin
    .from("subscribers")
    .select("id, tenant_id, site_id")
    .eq("id", input.subscriberId)
    .eq("tenant_id", input.tenantId)
    .eq("site_id", input.siteId)
    .maybeSingle();
  if (subscriberError || !subscriber) return { resolved: false as const };

  const { data: reading, error: readingError } = await admin
    .from("meter_readings")
    .select("id, consumption_kwh, status")
    .eq("tenant_id", input.tenantId)
    .eq("subscriber_id", input.subscriberId)
    .eq("client_operation_id", input.clientOperationId)
    .maybeSingle();
  if (readingError || !reading) return { resolved: false as const };

  if (!input.issueInvoice) {
    return {
      resolved: true as const,
      id: Number(reading.id),
      consumptionKwh: Number(reading.consumption_kwh ?? 0),
      status: String(reading.status),
      invoice: null,
    };
  }

  const { data: invoice, error: invoiceError } = await admin
    .from("invoices")
    .select("id, invoice_no, total_amount")
    .eq("tenant_id", input.tenantId)
    .eq("site_id", input.siteId)
    .eq("reading_id", Number(reading.id))
    .maybeSingle();
  if (invoiceError || !invoice) return { resolved: false as const };

  return {
    resolved: true as const,
    id: Number(reading.id),
    consumptionKwh: Number(reading.consumption_kwh ?? 0),
    status: String(reading.status),
    invoice: {
      id: Number(invoice.id),
      invoiceNo: String(invoice.invoice_no),
      totalAmount: Number(invoice.total_amount),
    },
  };
}

const recordRoles = rolesWith("collectPayments");
const readingRoles = rolesWith("recordReadings");
export const ownerSubaccountRoles = ["manager", "accountant", "collector", "technician", "viewer"] as const;
export type OwnerSubaccountRole = typeof ownerSubaccountRoles[number];
export type SubscriptionPlan = "starter" | "professional" | "enterprise";
export const defaultOwnerSubaccountLimits: Record<SubscriptionPlan, number> = { starter: 2, professional: 5, enterprise: 15 };
export const defaultOwnerSubscriberLimits: Record<SubscriptionPlan, number> = { starter: 100, professional: 500, enterprise: 2000 };
export const defaultBranchLimits: Record<SubscriptionPlan, number> = { starter: 1, professional: 3, enterprise: 10 };

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
export const mobileSyncReadingsInput = siteScoped.extend({ userId: z.number().int().positive().optional(), from: z.string().datetime().optional(), to: z.string().datetime().optional(), page: z.number().int().min(1).default(1), pageSize: z.number().int().min(10).max(100).default(25) });
export const mobileSyncReadingDetailInput = siteScoped.extend({ readingId: z.number().int().positive() });
export const mobileSyncApproveInput = z.object({ siteId: z.number().int().positive(), readingId: z.number().int().positive(), baseVersion: z.number().int().positive(), sendNow: z.boolean().default(true) });
export const mobileSyncBulkApprovalInput = siteScoped.extend({ userId: z.number().int().positive().optional(), from: z.string().datetime().optional(), to: z.string().datetime().optional(), limit: z.number().int().min(1).max(100).default(100), sendNow: z.boolean().default(true) });
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
  const portal = (data as Array<{ portal_code: string; display_name: string | null; primary_color: string; accent_color: string; site_name: string; city: string | null }> | null)?.[0];
  if (!portal) throw new TRPCError({ code: "NOT_FOUND", message: "رابط بوابة المشتركين غير متاح." });
  return {
    portalCode: portal.portal_code,
    displayName: portal.display_name,
    primaryColor: portal.primary_color,
    accentColor: portal.accent_color,
    siteName: portal.site_name,
    city: portal.city,
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
    portal?: { portalCode: string; displayName: string; primaryColor: string; accentColor: string; city: string | null };
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

export const powerhubRouter = router({
  messaging: router({
    smsQuota: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      const scope = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "collector"], "manageMessaging");
      const admin = supabaseAdmin();
      const [{ data: quota, error: quotaError }, { data: account, error: accountError }] = await Promise.all([
        admin.rpc("powerhub_get_sms_quota", { p_tenant_id: scope.tenantId }),
        admin.from("tenant_tweetsms_accounts").select("sender_name, is_active, credential_ciphertext, last_error").eq("tenant_id", scope.tenantId).maybeSingle(),
      ]);
      if (quotaError || accountError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل حصة الرسائل من Supabase." });
      const row = Array.isArray(quota) ? quota[0] : quota;
      return {
        plan: "tweetsms",
        planName: row?.plan_name ?? null,
        planCode: row?.plan_code ?? null,
        subscriptionId: row?.subscription_id ? Number(row.subscription_id) : null,
        smsPlanId: row?.sms_plan_id ? Number(row.sms_plan_id) : null,
        senderName: account?.sender_name ?? null,
        isActive: account?.is_active ?? false,
        configured: Boolean(account?.credential_ciphertext),
        lastError: account?.last_error ?? null,
        included: Number(row?.base_messages ?? 0),
        additional: Number(row?.additional_messages ?? 0),
        total: Number(row?.total_messages ?? 0),
        used: Number(row?.used_segments ?? 0),
        remaining: Number(row?.remaining_messages ?? 0),
      };
    }),
    smsDailyUsage: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      const scope = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "collector"], "manageMessaging");
      const fourteenDaysAgo = new Date(); fourteenDaysAgo.setUTCDate(fourteenDaysAgo.getUTCDate() - 13); fourteenDaysAgo.setUTCHours(0, 0, 0, 0);
      const admin = supabaseAdmin();
      const [{ data: messages, error: messagesError }, { data: quota, error: quotaError }] = await Promise.all([
        admin.from("notification_messages").select("created_at, status, segment_count").eq("tenant_id", scope.tenantId).eq("channel", "sms").gte("created_at", fourteenDaysAgo.toISOString()),
        admin.rpc("powerhub_get_sms_quota", { p_tenant_id: scope.tenantId }),
      ]);
      if (messagesError || quotaError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل استخدام الرسائل من Supabase." });
      const daily = new Map<string, number>();
      for (const message of messages ?? []) {
        if (!["processing", "submitted", "delivered", "read", "needs_review"].includes(message.status)) continue;
        const key = new Date(message.created_at).toISOString().slice(0, 10);
        daily.set(key, (daily.get(key) ?? 0) + Math.max(1, Number(message.segment_count ?? 1)));
      }
      const today = new Date();
      const points = Array.from({ length: 14 }, (_, index) => {
        const date = new Date(today);
        date.setDate(today.getDate() - (13 - index));
        const key = date.toISOString().slice(0, 10);
        return { date: key, count: daily.get(key) ?? 0 };
      });
      const row = Array.isArray(quota) ? quota[0] : quota;
      const included = Number(row?.base_messages ?? 0);
      const additional = Number(row?.additional_messages ?? 0);
      const total = Number(row?.total_messages ?? 0);
      const used = Number(row?.used_segments ?? 0);
      return { points, included, additional, total, used, remaining: Math.max(0, total - used) };
    }),
    currentSmsPackageRequest: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      const scope = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner"], "manageMessaging");
      const { data, error } = await supabaseAdmin().from("sms_package_requests")
        .select("id, status, requested_messages, approved_messages, note, created_at, reviewed_at")
        .eq("tenant_id", scope.tenantId).order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل طلب حزمة الرسائل من Supabase." });
      return data ? { id: Number(data.id), status: data.status, requestedMessages: data.requested_messages, approvedMessages: data.approved_messages, note: data.note, createdAt: new Date(data.created_at), reviewedAt: data.reviewed_at ? new Date(data.reviewed_at) : null } : null;
    }),
    requestSmsPackage: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), requestedMessages: z.number().int().min(1).max(100000000), note: z.string().max(1000).optional() })).mutation(async ({ ctx, input }) => {
      const scope = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner"], "manageMessaging");
      const { data, error } = await supabaseAdmin().rpc("powerhub_request_sms_package", {
        p_tenant_id: scope.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id, p_requested_messages: input.requestedMessages, p_note: input.note ?? null,
      });
      if (error) {
        if (error.message.includes("SMS_PACKAGE_REQUEST_PENDING")) throw new TRPCError({ code: "CONFLICT", message: "لديك طلب حزمة قيد المراجعة بالفعل." });
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر إنشاء طلب حزمة الرسائل في Supabase." });
      }
      const request = data?.[0];
      if (!request) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "لم تُعد دالة طلب الحزمة نتيجة صالحة." });
      return { id: Number(request.request_id), status: "pending" as const };
    }),
    listConfigurations: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      const scope = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner"], "manageMessaging");
      const { data, error } = await supabaseAdmin().from("tenant_messaging_configurations")
        .select("id, channel, provider, sender_id, phone_number_id, template_name, receipt_template_name, subscriber_reference_template_name, is_active, auto_send_after_approval, auto_send_cron, schedule_cron_task_uid, updated_at")
        .eq("tenant_id", scope.tenantId).order("channel", { ascending: true });
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل إعدادات الرسائل من Supabase." });
      return (data ?? []).map((config) => ({ id: Number(config.id), channel: config.channel, provider: config.provider, senderId: config.sender_id, phoneNumberId: config.phone_number_id, templateName: config.template_name, receiptTemplateName: config.receipt_template_name, subscriberReferenceTemplateName: config.subscriber_reference_template_name, isActive: config.is_active, autoSendAfterApproval: config.auto_send_after_approval, autoSendCron: config.auto_send_cron, scheduleCronTaskUid: config.schedule_cron_task_uid, updatedAt: new Date(config.updated_at) }));
    }),
    listScheduleRuns: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), limit: z.number().int().min(1).max(50).default(20) })).query(async ({ ctx, input }) => {
      const scope = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "manageMessaging");
      const admin = supabaseAdmin();
      const { data: config, error: configError } = await admin.from("tenant_messaging_configurations").select("id")
        .eq("tenant_id", scope.tenantId).eq("channel", "sms").maybeSingle();
      if (configError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل إعداد جدولة الرسائل من Supabase." });
      if (!config) return [];
      const { data, error } = await admin.from("messaging_schedule_runs")
        .select("id, status, scanned, submitted, failed, skipped, error, task_uid, started_at, finished_at")
        .eq("tenant_id", scope.tenantId).eq("configuration_id", config.id).order("started_at", { ascending: false }).limit(input.limit);
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل سجل جدولة الرسائل من Supabase." });
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
      void ctx; void input;
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "حفظ اعتمادات مزود الرسائل معطّل حالياً إلى أن يُعتمد تصميم تشفير وتشغيل مستقل متوافق مع Supabase/Vercel." });
    }),
    testConnection: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(), channel: z.enum(["whatsapp", "sms"]), provider: z.string().min(2).max(80),
      phoneNumberId: z.string().max(120).optional(), credential: z.string().min(8).max(4096),
    })).mutation(async ({ ctx, input }) => {
      void ctx; void input;
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "اختبار مزود الرسائل معطّل حالياً إلى أن يكتمل نقل الإشعارات إلى Supabase/Vercel." });
    }),
    configureInvoiceAutoSend: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), enabled: z.boolean(), cron: z.string().min(11).max(40).default("0 0/15 * * * *") })).mutation(async ({ ctx, input }) => {
      void ctx; void input;
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "جدولة إرسال الفواتير معطّلة حالياً؛ لا توجد مهمة مجدولة مفعلة في بيئة Supabase/Vercel." });
      return { enabled: false, cron: input.cron, nextExecutionAt: null };
    }),
    saveInvoiceTemplate: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), channel: z.enum(["whatsapp", "sms"]), body: z.string().min(12).max(1600), isActive: z.boolean().default(true) })).mutation(async ({ ctx, input }) => {
      const scope = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner"], "manageMessaging");
      const admin = supabaseAdmin();
      const { data: setting, error: settingError } = await admin.from("platform_settings").select("is_enabled, value")
        .eq("setting_key", "invoice_delivery_channels").maybeSingle();
      if (settingError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر التحقق من سياسة قنوات الفواتير في Supabase." });
      if (!setting || !isInvoiceDeliveryChannelEnabled(input.channel, invoiceDeliveryPolicyFromSetting({ isEnabled: setting.is_enabled, value: setting.value }))) throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكن حفظ قالب لقناة معطلة من آدمن المنصة." });
      const { error } = await admin.from("tenant_invoice_message_templates").upsert({ tenant_id: scope.tenantId, channel: input.channel, event_type: "invoice_issued", body: input.body, is_active: input.isActive }, { onConflict: "tenant_id,channel,event_type" });
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر حفظ قالب رسالة الفاتورة في Supabase." });
      await writeSupabaseAuditBestEffort({ userId: ctx.user.id, tenantId: scope.tenantId, siteId: input.siteId, entityType: "tenant_invoice_message_template", entityId: `${scope.tenantId}:${input.channel}`, action: "upsert", afterData: { channel: input.channel, isActive: input.isActive }, metadata: { bodyLength: input.body.length } });
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
      await writeSupabaseAuditBestEffort({ userId: ctx.user.id, tenantId: scope.tenantId, siteId: input.siteId, entityType: "tenant_payment_receipt_message_template", entityId: `${scope.tenantId}:sms`, action: "upsert", afterData: { channel: "sms", isActive: input.isActive }, metadata: { bodyLength: input.body.length } });
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
      await writeSupabaseAuditBestEffort({ userId: ctx.user.id, tenantId: access.tenantId, siteId: input.siteId, entityType: "user_quick_action_preferences", entityId: `${ctx.user.id}:${input.siteId}`, action: "upsert", afterData: { actionIds: input.actionIds } });
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
        .eq("tenant_id", access.tenantId).eq("site_id", input.siteId).in("action", ["update_permissions", "create", "update"])
        .order("created_at", { ascending: false }).limit(100);
      if (input.userId) query = query.eq("user_id", input.userId);
      const { data, error } = await query;
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل سجل تغييرات الصلاحيات من Supabase." });
      return (data ?? []).map((row) => ({ id: Number(row.id), userId: row.user_id === null ? null : Number(row.user_id), action: row.action, createdAt: new Date(row.created_at), afterData: row.after_data, metadata: row.metadata }));
    }),
    list: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager"], "manageTeam");
      const { data: profiles, error: profilesError } = await supabaseAdmin().from("staff_profiles")
        .select("id, user_id, tenant_id, site_id, role, custom_role_id, permissions, suspension_started_at, suspension_ends_at, is_active, created_at, updated_at")
        .eq("tenant_id", access.tenantId).or(`site_id.eq.${input.siteId},site_id.is.null`);
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
          isActive: profile.is_active, createdAt: new Date(profile.created_at), updatedAt: new Date(profile.updated_at),
        }, user }];
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
      const [subscriptionResult, tenantResult, rolesPolicyResult, limitsPolicyResult, overridesResult, membersResult] = await Promise.all([
        admin.from("tenant_subscriptions").select("plan").eq("tenant_id", access.tenantId).maybeSingle(),
        admin.from("tenants").select("plan").eq("id", access.tenantId).maybeSingle(),
        admin.from("platform_settings").select("is_enabled, value").eq("setting_key", "owner_subaccount_roles").maybeSingle(),
        admin.from("platform_settings").select("value").eq("setting_key", "owner_subaccount_limits").maybeSingle(),
        admin.from("platform_settings").select("value").eq("setting_key", "owner_limit_overrides").maybeSingle(),
        admin.from("tenant_members").select("user_id").eq("tenant_id", access.tenantId).eq("role", "member").eq("is_active", true).eq("membership_status", "active"),
      ]);
      if (subscriptionResult.error || tenantResult.error || rolesPolicyResult.error || limitsPolicyResult.error || overridesResult.error || membersResult.error) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل سياسة الحسابات الفرعية من Supabase." });
      }
      const plan = subscriptionResult.data?.plan ?? tenantResult.data?.plan;
      if (plan !== "starter" && plan !== "professional" && plan !== "enterprise") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "لا توجد باقة صالحة لمساحة صاحب المولد." });
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
      const currentCount = (membersResult.data ?? []).length;
      return { roles, limit, currentCount, remaining: Math.max(0, limit - currentCount) };
    }),
    permissionCatalog: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner"], "manageTeam");
      const capabilities: PowerCapability[] = ["manageSubscribers", "manageGenerators", "recordReadings", "accessFieldApp", "approveReadings", "manageTariffs", "issueInvoices", "collectPayments", "manageExpenses", "managePayroll", "manageTeam", "manageMessaging", "viewAudit"];
      return capabilities;
    }),
    customRoles: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner"], "manageTeam");
      const { data, error } = await supabaseAdmin().from("custom_permission_roles").select("id, name, description, permissions, is_active")
        .eq("tenant_id", access.tenantId).eq("is_active", true).order("name", { ascending: true });
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل الأدوار المخصصة من Supabase." });
      return (data ?? []).map((role) => ({ id: Number(role.id), name: role.name, description: role.description, permissions: role.permissions, isActive: role.is_active }));
    }),
    saveCustomRole: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), id: z.number().int().positive().optional(), name: z.string().trim().min(2).max(120), description: z.string().trim().max(255).optional(), permissions: z.array(z.enum(["manageSubscribers", "manageGenerators", "recordReadings", "accessFieldApp", "approveReadings", "manageTariffs", "issueInvoices", "collectPayments", "manageExpenses", "managePayroll", "manageTeam", "manageMessaging", "viewAudit"])).min(1) })).mutation(async ({ ctx, input }) => {
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
    updatePermissions: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), profileId: z.number().int().positive(), customRoleId: z.number().int().positive().nullable().optional(), permissions: z.array(z.enum(["manageSubscribers", "manageGenerators", "recordReadings", "accessFieldApp", "approveReadings", "manageTariffs", "issueInvoices", "collectPayments", "manageExpenses", "managePayroll", "manageTeam", "manageMessaging", "viewAudit"])).min(1) })).mutation(async ({ ctx, input }) => {
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
          if (error.message.includes("SUBACCOUNT_LIMIT_REACHED")) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "وصلت إلى الحد الأقصى للحسابات الفرعية في اشتراكك." });
          if (error.message.includes("STAFF_ASSIGNMENT_FORBIDDEN")) throw new TRPCError({ code: "FORBIDDEN", message: "لا تملك صلاحية تعيين الحسابات الفرعية." });
          if (error.message.includes("TENANT_PLAN_NOT_FOUND")) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "لا توجد باقة صالحة لمساحة صاحب المولد." });
          if (error.message.includes("SITE_OUT_OF_SCOPE")) throw new TRPCError({ code: "NOT_FOUND", message: "الفرع غير موجود ضمن مساحة صاحب المولد." });
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تعيين الحساب الفرعي في Supabase." });
        }
        return { success: true };
      }),
    create: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(),
      email: z.string().email(),
      name: z.string().trim().min(2).max(160),
      temporaryPassword: z.string().min(8).max(128),
      role: z.enum(["manager", "accountant", "collector", "technician", "viewer"]),
      allBranches: z.boolean().default(false),
    })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner"], "manageTeam");
      const admin = supabaseAdmin();
      const { data: authData, error: authError } = await admin.auth.admin.createUser({
        email: input.email.trim().toLowerCase(),
        password: input.temporaryPassword,
        email_confirm: true,
        user_metadata: { name: input.name.trim(), full_name: input.name.trim() },
      });
      if (authError || !authData.user) {
        const message = authError?.message ?? "تعذر إنشاء حساب المستخدم في Supabase Auth.";
        throw new TRPCError({ code: authError?.status === 422 ? "CONFLICT" : "BAD_REQUEST", message });
      }
      const authUserId = authData.user.id;
      try {
        const { data: profile, error: profileError } = await admin.from("users")
          .update({ name: input.name.trim(), email: input.email.trim().toLowerCase(), must_change_password: true, temporary_password_issued_at: new Date().toISOString(), account_status: "active" })
          .eq("auth_user_id", authUserId)
          .select("id")
          .maybeSingle();
        if (profileError || !profile) throw new Error("تعذر إنشاء ملف PowerHub للمستخدم الجديد.");
        const { data, error } = await admin.rpc("powerhub_assign_existing_staff", {
          p_tenant_id: access.tenantId, p_site_id: input.siteId, p_actor_user_id: ctx.user.id,
          p_target_user_id: Number(profile.id), p_role: input.role, p_all_branches: input.allBranches,
        });
        if (error || !data?.[0]?.profile_id) {
          const message = error?.message ?? "تعذر ربط المستخدم بالفرع والدور المحددين.";
          if (message.includes("SUBACCOUNT_ROLE_NOT_ALLOWED")) throw new TRPCError({ code: "FORBIDDEN", message: "هذا الدور غير مسموح للحسابات الفرعية وفق سياسة المنصة." });
          if (message.includes("SUBACCOUNT_LIMIT_REACHED")) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "وصلت إلى الحد الأقصى للحسابات الفرعية في اشتراكك." });
          if (message.includes("TENANT_PLAN_NOT_FOUND")) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "لا توجد باقة صالحة لمساحة صاحب المولد." });
          if (message.includes("SITE_OUT_OF_SCOPE")) throw new TRPCError({ code: "NOT_FOUND", message: "الفرع غير موجود ضمن مساحة صاحب المولد." });
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر ربط الحساب الجديد بمساحة صاحب المولد." });
        }
        return { success: true as const, userId: Number(profile.id), profileId: Number(data[0].profile_id) };
      } catch (error) {
        await admin.auth.admin.deleteUser(authUserId).catch(() => undefined);
        throw error;
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
      const { data: profile, error: profileError } = await admin.from("staff_profiles")
        .select("id,user_id,tenant_id,site_id,role,is_active")
        .eq("id", input.profileId)
        .eq("tenant_id", access.tenantId)
        .eq("site_id", input.siteId)
        .neq("role", "owner")
        .eq("is_active", true)
        .maybeSingle();
      if (profileError || !profile) throw new TRPCError({ code: "NOT_FOUND", message: "الحساب الفرعي غير موجود ضمن نطاقك." });
      const targetUserId = Number(profile.user_id);
      const { data: prepared, error: prepareError } = await admin.rpc("powerhub_prepare_password_reset", {
        p_actor_user_id: ctx.user.id,
        p_tenant_id: access.tenantId,
        p_target_user_id: targetUserId,
        p_site_id: input.siteId,
      });
      if (prepareError || !prepared?.[0]) {
        const message = prepareError?.message ?? "";
        if (message.includes("PASSWORD_RESET_IN_PROGRESS")) throw new TRPCError({ code: "CONFLICT", message: "توجد عملية إعادة تعيين قيد التنفيذ لهذا الحساب. حاول بعد قليل." });
        if (message.includes("PASSWORD_RESET_OWNER_TARGET_ONLY") || message.includes("PASSWORD_RESET_TARGET_OUT_OF_SCOPE") || message.includes("PASSWORD_RESET_STAFF_OUT_OF_SCOPE")) throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكن إعادة تعيين كلمة مرور هذا الحساب من نطاقك." });
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تجهيز إعادة تعيين كلمة المرور." });
      }
      const intentId = Number(prepared[0].intent_id);
      const temporaryPassword = `PH-${randomBytes(12).toString("base64url")}`;
      const { error: authError } = await admin.auth.admin.updateUserById(String(prepared[0].target_auth_user_id), { password: temporaryPassword });
      if (authError) {
        await admin.rpc("powerhub_complete_password_reset", { p_intent_id: intentId, p_actor_user_id: ctx.user.id, p_success: false, p_failure_reason: authError.message });
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحديث كلمة مرور الحساب في Supabase Auth." });
      }
      const completion = await completePasswordResetWithRetry(intentId, ctx.user.id, true);
      if (!completion.ok) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تم تحديث كلمة المرور، لكن تعذر تأكيد عملية التدقيق بعد إعادة المحاولة. لا تُجرِ إعادة تعيين أخرى لهذا الحساب حتى يتم التحقق من العملية." });
      return { success: true as const, temporaryPassword };
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
  ownerAlerts: router({
    list: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner"], "manageTeam");
      const { data, error } = await supabaseAdmin().from("tenant_owner_alerts")
        .select("id,title,message,severity,site_id,created_at,read_at,metadata")
        .eq("tenant_id", access.tenantId)
        .order("created_at", { ascending: false }).limit(50);
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل تنبيهات مساحة صاحب المولد." });
      return (data ?? []).map((row) => ({ id: Number(row.id), title: row.title, message: row.message, severity: row.severity, siteId: Number(row.site_id), createdAt: new Date(row.created_at), readAt: row.read_at ? new Date(row.read_at) : null, metadata: row.metadata }));
    }),
    markRead: protectedProcedure.input(siteScoped.extend({ alertId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner"], "manageTeam");
      const { data, error } = await supabaseAdmin().from("tenant_owner_alerts")
        .update({ read_at: new Date().toISOString() })
        .eq("id", input.alertId).eq("tenant_id", access.tenantId)
        .select("id").maybeSingle();
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحديث حالة التنبيه." });
      if (!data) throw new TRPCError({ code: "NOT_FOUND", message: "التنبيه غير موجود ضمن مساحة صاحب المولد." });
      return { success: true as const };
    }),
  }),

  subscription: router({
    currentUpgradeRequest: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "viewer"]);
      const { data, error } = await supabaseAdmin().from("subscription_upgrade_requests")
        .select("id, current_plan, requested_plan, status, note, created_at, reviewed_at")
        .eq("tenant_id", access.tenantId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل طلب ترقية الباقة من Supabase." });
      if (!data) return null;
      return {
        id: Number(data.id),
        currentPlan: data.current_plan,
        requestedPlan: data.requested_plan,
        status: data.status,
        note: data.note,
        createdAt: new Date(data.created_at),
        reviewedAt: data.reviewed_at ? new Date(data.reviewed_at) : null,
      };
    }),
    requestUpgrade: protectedProcedure.input(siteScoped.extend({ requestedPlan: z.enum(["starter", "professional", "enterprise"]) })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner"], "manageSubscribers");
      const { data, error } = await supabaseAdmin().rpc("powerhub_request_subscription_upgrade", { p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id, p_requested_plan: input.requestedPlan });
      const result = (data as Array<{ request_id: number | string; requested_plan: SubscriptionPlan; already_requested: boolean }> | null)?.[0];
      if (!error && result?.request_id) return { id: Number(result.request_id), requestedPlan: result.requested_plan, alreadyRequested: result.already_requested };
      const errorText = `${error?.code ?? ""} ${error?.message ?? ""}`;
      if (errorText.includes("SITE_OUT_OF_SCOPE")) throw new TRPCError({ code: "FORBIDDEN", message: "الفرع غير تابع لمساحة الشركة." });
      if (errorText.includes("SUBSCRIBER_LIMIT_NOT_REACHED")) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "يتاح طلب الترقية من هذا الزر عند بلوغ الحد الأقصى للمشتركين." });
      if (errorText.includes("REQUESTED_PLAN_NOT_HIGHER") || errorText.includes("INVALID_REQUESTED_PLAN")) throw new TRPCError({ code: "BAD_REQUEST", message: "اختر باقة أعلى من باقتك الحالية." });
      if (errorText.includes("TENANT_PLAN_NOT_FOUND")) throw new TRPCError({ code: "NOT_FOUND", message: "تعذر تحديد باقة مساحة صاحب المولد." });
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر إنشاء طلب ترقية الباقة في Supabase." });
    }),
  }),
  subscriberPortal: router({
    list: publicProcedure.query(async () => {
      const { data, error } = await supabaseAdmin().rpc("powerhub_subscriber_portal_list");
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل بوابات المشتركين من Supabase." });
      return ((data ?? []) as Array<{ portal_code: string; display_name: string | null; primary_color: string; accent_color: string; site_name: string; city: string | null }>).map((portal) => ({
        portalCode: portal.portal_code,
        displayName: portal.display_name,
        primaryColor: portal.primary_color,
        accentColor: portal.accent_color,
        siteName: portal.site_name,
        city: portal.city,
      }));
    }),
    theme: publicProcedure.input(z.object({ portalCode: portalCodeInput })).query(async ({ input }) => {
      const portal = await getEnabledPortal(input.portalCode);
      return {
        portalCode: portal.portalCode,
        displayName: portal.displayName || portal.siteName,
        primaryColor: portal.primaryColor,
        accentColor: portal.accentColor,
        city: portal.city,
      };
    }),
    lookup: publicProcedure.input(subscriberPortalLookupInput).query(async ({ input }) => {
      const { portal, subscriber, invoices: subscriberInvoices, payments: completedPayments } = await getVerifiedPortalSubscriber(input);
      const currentPeriod = new Date().toISOString().slice(0, 7);
      const currentInvoice = subscriberInvoices.find((invoice) => invoice.billingPeriod === currentPeriod);
      const outstandingBalance = subscriberInvoices.reduce((total, invoice) => total + Number(invoice.balanceDue || 0), 0);
      return {
        portal: { portalCode: portal.portalCode, displayName: portal.displayName, primaryColor: portal.primaryColor, accentColor: portal.accentColor, city: portal.city },
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
      };
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
      const [site, settingResult] = await Promise.all([
        getSupabaseSite(input.siteId),
        supabaseAdmin().from("site_portal_settings")
          .select("site_id, tenant_id, portal_code, display_name, primary_color, accent_color, is_enabled")
          .eq("site_id", input.siteId)
          .eq("tenant_id", access.tenantId)
          .maybeSingle(),
      ]);
      if (settingResult.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل إعدادات بوابة المشتركين من Supabase." });
      const setting = settingResult.data;
      return setting ? {
        siteId: Number(setting.site_id), tenantId: Number(setting.tenant_id), portalCode: setting.portal_code,
        displayName: setting.display_name, primaryColor: setting.primary_color, accentColor: setting.accent_color, isEnabled: setting.is_enabled,
      } : {
        siteId: site.id, tenantId: site.tenantId, portalCode: site.code.toLowerCase(), displayName: site.name,
        primaryColor: "#0D1117", accentColor: "#F5B800", isEnabled: true,
      };
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
      return listSupabaseAccessibleSites(ctx.user.id, ctx.user.role === "admin");
    }),
    branchPolicy: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      const access=await requireSupabaseSiteRole(ctx.user.id,input.siteId,["owner"]);
      const admin=supabaseAdmin();
      const [subscription,platformSetting,tenantSetting,branchRows]=await Promise.all([
        admin.from("tenant_subscriptions").select("plan").eq("tenant_id",access.tenantId).maybeSingle(),
        admin.from("platform_settings").select("is_enabled, value").eq("setting_key","branch_feature").maybeSingle(),
        admin.from("tenant_branch_settings").select("is_enabled_override, max_branches_override, disabled_behavior").eq("tenant_id",access.tenantId).maybeSingle(),
        admin.from("sites").select("id").eq("tenant_id",access.tenantId).neq("status","archived"),
      ]);
      if(subscription.error||platformSetting.error||tenantSetting.error||branchRows.error) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"تعذر تحميل سياسة الفروع من Supabase."});
      return resolveBranchPolicy({plan:(subscription.data?.plan??"starter") as SubscriptionPlan,platformSetting:platformSetting.data?{isEnabled:platformSetting.data.is_enabled,value:platformSetting.data.value}:null,tenantSetting:tenantSetting.data?{isEnabledOverride:tenantSetting.data.is_enabled_override,maxBranchesOverride:tenantSetting.data.max_branches_override,disabledBehavior:tenantSetting.data.disabled_behavior as "read_only"|"suspended"}:null,currentCount:(branchRows.data??[]).length});
    }),
    create: protectedProcedure.input(siteInput.extend({ clientOperationId: z.string().uuid() })).mutation(async ({ ctx, input }) => {
      const admin=supabaseAdmin();
      const {data:membership,error:membershipError}=await admin.from("tenant_members").select("tenant_id, role").eq("user_id",ctx.user.id).eq("is_active",true).eq("membership_status","active").eq("role","owner").maybeSingle();
      if(membershipError) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"تعذر التحقق من عضوية مالك المولد في Supabase."});
      if(!membership) throw new TRPCError({code:"FORBIDDEN",message:"إنشاء فرع جديد متاح لصاحب مولد لديه مساحة نشطة فقط."});
      const {data,error}=await admin.rpc("powerhub_create_site_online",{p_tenant_id:Number(membership.tenant_id),p_user_id:ctx.user.id,p_name:input.name,p_code:input.code,p_city:input.city??null,p_address:input.address??null,p_client_operation_id:input.clientOperationId});
      const result=(data as Array<{site_id:number|string;replayed?:boolean}>|null)?.[0];
      if(!error && result?.site_id) return {id:Number(result.site_id),replayed:Boolean(result.replayed)};
      const message=String(error?.message??"");
      if(message.includes("FEATURE_DISABLED")) throw new TRPCError({code:"FORBIDDEN",message:"ميزة تعدد الأفرع غير مفعّلة لحسابك من إدارة المنصة."});
      if(message.includes("LIMIT_REACHED")) throw new TRPCError({code:"PRECONDITION_FAILED",message:"وصلت إلى الحد الأقصى للأفرع في اشتراكك."});
      if(message.includes("SITE_OPERATION_CONFLICT")) throw new TRPCError({code:"CONFLICT",message:"معرّف العملية مستخدم لبيانات فرع مختلفة."});
      if(message.includes("SITE_CODE_EXISTS")) throw new TRPCError({code:"CONFLICT",message:"رمز الفرع مستخدم بالفعل."});
      throw new TRPCError({code:"BAD_REQUEST",message:"تعذر إنشاء الفرع في Supabase."});
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
    updateBranch: protectedProcedure.input(siteInput.pick({ name: true, city: true, address: true }).extend({ siteId: z.number().int().positive(), status: z.enum(["active", "inactive", "archived"]), invoiceDueDays: z.number().int().min(1).max(90) })).mutation(async ({ ctx, input }) => {
      const access=await requireSupabaseSiteRole(ctx.user.id,input.siteId,["owner"]);
      const {data,error}=await supabaseAdmin().rpc("powerhub_update_site",{p_tenant_id:access.tenantId,p_site_id:input.siteId,p_user_id:ctx.user.id,p_name:input.name,p_city:input.city??"",p_address:input.address??"",p_status:input.status,p_invoice_due_days:input.invoiceDueDays});
      if(error || !Number((data as Array<{site_id:number}>|null)?.[0]?.site_id)) throw new TRPCError({code:error?.message.includes("OUT_OF_SCOPE")?"NOT_FOUND":"BAD_REQUEST",message:"تعذر تحديث بيانات الفرع."});
      return { success: true };
    }),
  }),

  subscribers: router({
    list: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "collector", "viewer"]);
      return listSupabaseSubscribers(input.siteId);
    }),
    quota: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "collector", "viewer"]);
      const admin = supabaseAdmin();
      const [subscriptionResponse, tenantResponse, limitPolicyResponse, overridesPolicyResponse, countResponse] = await Promise.all([
        admin.from("tenant_subscriptions").select("plan").eq("tenant_id", access.tenantId).maybeSingle(),
        admin.from("tenants").select("plan").eq("id", access.tenantId).maybeSingle(),
        admin.from("platform_settings").select("value").eq("setting_key", "owner_subscriber_limits").maybeSingle(),
        admin.from("platform_settings").select("value").eq("setting_key", "owner_limit_overrides").maybeSingle(),
        admin.from("subscribers").select("id", { count: "exact", head: true }).eq("tenant_id", access.tenantId),
      ]);
      if (subscriptionResponse.error || tenantResponse.error || limitPolicyResponse.error || overridesPolicyResponse.error || countResponse.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل حصة المشتركين من Supabase." });
      const plan = subscriptionResponse.data?.plan ?? tenantResponse.data?.plan;
      if (plan !== "starter" && plan !== "professional" && plan !== "enterprise") throw new TRPCError({ code: "NOT_FOUND", message: "تعذر تحديد باقة مساحة صاحب المولد." });
      const policyValue = limitPolicyResponse.data?.value;
      const overridesValue = overridesPolicyResponse.data?.value;
      const overridesObject = overridesValue && typeof overridesValue === "object" && !Array.isArray(overridesValue) ? overridesValue as Record<string, unknown> : {};
      const perTenantOverrides = overridesObject.overrides;
      const override = perTenantOverrides && typeof perTenantOverrides === "object" && !Array.isArray(perTenantOverrides) ? (perTenantOverrides as Record<string, unknown>)[String(access.tenantId)] : undefined;
      const requestedOverrideLimit = override && typeof override === "object" && !Array.isArray(override) ? (override as Record<string, unknown>).subscriberLimit : undefined;
      const parsedOverrideLimit = typeof requestedOverrideLimit === "number" ? requestedOverrideLimit : typeof requestedOverrideLimit === "string" ? Number(requestedOverrideLimit) : NaN;
      const limit = Number.isInteger(parsedOverrideLimit) && parsedOverrideLimit >= 0 && parsedOverrideLimit <= 100000 ? parsedOverrideLimit : ownerSubscriberLimitForPlan(plan, { value: policyValue });
      const currentCount = countResponse.count ?? 0;
      return { limit, currentCount, remaining: Math.max(0, limit - currentCount), plan };
    }),
    create: protectedProcedure.input(siteInput.pick({ code: true }).extend({
      siteId: z.number().int().positive(),
      fullName: z.string().min(2).max(180),
      phone: z.string().min(5).max(30),
      whatsappNumber: z.string().min(5).max(30).optional(),
      address: z.string().max(1000).optional(),
      subscriptionType: z.enum(["residential", "commercial"]).default("residential"),
      clientOperationId: z.string().uuid().optional(),
    }).omit({ code: true })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, createRoles, "manageSubscribers");
      const admin = supabaseAdmin();
      const replay = await getOfflineReplayForScope({ userId: ctx.user.id, tenantId: access.tenantId, siteId: input.siteId, clientOperationId: input.clientOperationId, expectedOperationType: "subscriber_create" });
      if (replay) {
        return replay as { id: number; subscriberNo: string; referenceNotifications: Array<{ notificationId: number; status: string; error?: string }> };
      }
      const quota = await getSupabaseOwnerSubscriberQuota(access.tenantId);
      if (quota.currentCount >= quota.limit) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `وصلت إلى الحد الأقصى للمشتركين في باقتك (${quota.limit}). تواصل مع إدارة المنصة لترقية الاشتراك.` });
      const phone = normalizeInternationalPhone(input.phone);
      const whatsappNumber = input.whatsappNumber ? normalizeInternationalPhone(input.whatsappNumber) : undefined;
      const { data, error } = await admin.rpc("powerhub_create_subscriber", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id,
        p_full_name: input.fullName.trim(), p_phone: phone, p_whatsapp_number: whatsappNumber ?? "", p_address: input.address?.trim() ?? "",
        p_subscription_type: input.subscriptionType, p_client_operation_id: input.clientOperationId ?? null, p_quota_limit: quota.limit,
      });
      if (!error && data?.[0]) {
        const row = data[0] as { subscriber_id: number | string; subscriber_no: string; replayed: boolean };
        const response = { id: Number(row.subscriber_id), subscriberNo: row.subscriber_no, referenceNotifications: [] as Array<{ notificationId: number; status: string; error?: string }> };
        if (!row.replayed) {
          try {
            await recordSupabaseSubscriberQuotaAlert({ tenantId: access.tenantId, siteId: input.siteId, userId: ctx.user.id, quota: { ...quota, currentCount: quota.currentCount + 1, remaining: Math.max(0, quota.remaining - 1) } });
          } catch (alertError) {
            console.error("[subscriber-quota-alert] subscriber creation succeeded but quota alert recording failed", alertError);
          }
        }
        return response;
      }
      const errorText = `${error?.code ?? ""} ${error?.message ?? ""}`;
      if (errorText.includes("SUBSCRIBER_QUOTA_REACHED")) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `وصلت إلى الحد الأقصى للمشتركين في باقتك (${quota.limit}). تواصل مع إدارة المنصة لترقية الاشتراك.` });
      if (errorText.includes("SITE_OUT_OF_SCOPE")) throw new TRPCError({ code: "FORBIDDEN", message: "المحطة لا تتبع لمساحة صاحب المولد الحالية." });
      if (errorText.includes("INVALID_SUBSCRIBER_PHONE")) throw new TRPCError({ code: "BAD_REQUEST", message: "رقم الهاتف مطلوب وصالح." });
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر إنشاء المشترك في Supabase." });
    }),
    bulkImport: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(),
      updateExisting: z.boolean().default(false),
      rows: z.array(z.object({
        sourceRow: z.number().int().min(2),
        subscriberNo: z.string().trim().max(80).optional(),
        fullName: z.string().trim().max(300),
        phone: z.string().trim().max(60),
        whatsappNumber: z.string().trim().max(60).optional(),
        address: z.string().trim().max(1500).optional(),
        subscriptionType: z.enum(["residential", "commercial"]),
      })).min(1).max(300),
    })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, createRoles, "manageSubscribers");
      const quota = await getSupabaseOwnerSubscriberQuota(access.tenantId);
      const failureRows: Array<{ sourceRow: number; fullName: string; reason: string }> = [];
      const seenPhones = new Set<string>();
      const seenReferences = new Set<string>();
      const accepted: Array<{ sourceRow: number; subscriberNo?: string; fullName: string; phone: string; whatsappNumber?: string; address?: string; subscriptionType: "residential" | "commercial" }> = [];
      for (const row of input.rows) {
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
        accepted.push({ sourceRow: row.sourceRow, subscriberNo, fullName: row.fullName.trim(), phone, whatsappNumber, address: row.address?.trim() || undefined, subscriptionType: row.subscriptionType });
      }
      if (!accepted.length) return { created: [], updated: [], failed: failureRows.sort((a, b) => a.sourceRow - b.sourceRow), notificationsQueued: 0, message: "لا توجد صفوف صالحة للحفظ." };
      const { data, error } = await supabaseAdmin().rpc("powerhub_bulk_upsert_subscribers", {
        p_tenant_id: access.tenantId,
        p_site_id: input.siteId,
        p_user_id: ctx.user.id,
        p_rows: accepted,
        p_update_existing: input.updateExisting,
        p_quota_limit: quota.limit,
      });
      if (error) {
        const errorText = String(error?.code ?? "") + " " + String(error?.message ?? "");
        if (errorText.includes("SITE_OUT_OF_SCOPE")) throw new TRPCError({ code: "FORBIDDEN", message: "المحطة لا تتبع لمساحة صاحب المولد الحالية." });
        if (errorText.includes("INVALID_BULK_ROWS")) throw new TRPCError({ code: "BAD_REQUEST", message: "ملف الاستيراد غير صالح أو يتجاوز 300 صف." });
        if (error?.code === "23505") throw new TRPCError({ code: "CONFLICT", message: "يوجد رقم مرجعي مكرر في الملف أو قاعدة البيانات. عدّل الملف وأعد المحاولة." });
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر حفظ الاستيراد الجماعي في Supabase." });
      }
      const row = (data as Array<{ created?: unknown; updated?: unknown; failed?: unknown }> | null)?.[0];
      const created = Array.isArray(row?.created) ? row.created : [];
      const updated = Array.isArray(row?.updated) ? row.updated : [];
      const failed = [...failureRows, ...(Array.isArray(row?.failed) ? row.failed : [])].sort((a, b) => Number(a.sourceRow) - Number(b.sourceRow));
      if (created.length) {
        try {
          await recordSupabaseSubscriberQuotaAlert({ tenantId: access.tenantId, siteId: input.siteId, userId: ctx.user.id, quota: { ...quota, currentCount: quota.currentCount + created.length, remaining: Math.max(0, quota.remaining - created.length) } });
        } catch (alertError) {
          console.error("[subscriber-quota-alert] bulk subscriber import succeeded but quota alert recording failed", alertError);
        }
      }
      return { created, updated, failed, notificationsQueued: 0, message: "تم حفظ الاستيراد الجماعي ذرياً في Supabase دون إرسال رسائل تلقائية." };
    }),
    update: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(), id: z.number().int().positive(), fullName: z.string().min(2).max(180), phone: z.string().min(5).max(30),
      address: z.string().max(1000).optional(), subscriptionType: z.enum(["residential", "commercial"]), serviceStatus: z.enum(["active", "suspended", "disconnected"]),
      clientOperationId: z.string().uuid().optional(), expectedUpdatedAt: z.date().optional(),
    })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "manageSubscribers");
      const admin = supabaseAdmin();
      const replay = await getOfflineReplayForScope({ userId: ctx.user.id, tenantId: access.tenantId, siteId: input.siteId, clientOperationId: input.clientOperationId, expectedOperationType: "subscriber_update" });
      if (replay) {
        const response = replay as { success: true; updatedAt: string | Date };
        return { success: true as const, updatedAt: new Date(response.updatedAt) };
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
        return { success: true as const, updatedAt: new Date(row.updated_at) };
      }
      const errorText = `${error?.code ?? ""} ${error?.message ?? ""}`;
      if (errorText.includes("SUBSCRIBER_OUT_OF_SCOPE")) throw new TRPCError({ code: "NOT_FOUND", message: "المشترك غير موجود ضمن المحطة المحددة." });
      if (errorText.includes("SUBSCRIBER_VERSION_CONFLICT")) throw new TRPCError({ code: "CONFLICT", message: "تغيرت بيانات المشترك على الخادم منذ حفظ هذه المسودة. راجع التعارض ثم أعد المحاولة." });
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحديث المشترك في Supabase." });
    }),
    phoneReview: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner"], "manageSubscribers");
      const { data, error } = await supabaseAdmin().from("subscribers").select("id, subscriber_no, full_name, phone").eq("tenant_id", access.tenantId).eq("site_id", input.siteId).order("full_name");
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
    create: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(), name: z.string().min(2).max(160), code: z.string().min(2).max(50),
      pricePerKwh: z.number().min(0), fixedFee: z.number().min(0).default(0), taxRate: z.number().min(0).max(100).default(0),
      clientOperationId: z.string().uuid(),
    })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, createRoles, "manageTariffs");
      const { data, error } = await supabaseAdmin().rpc("powerhub_create_tariff_idempotent", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id,
        p_name: input.name, p_code: input.code, p_price_per_kwh: input.pricePerKwh,
        p_fixed_fee: input.fixedFee, p_tax_rate: input.taxRate, p_client_operation_id: input.clientOperationId,
      });
      if (!error && data?.[0]) {
        const row=data[0] as { tariff_id:number|string; replayed?:boolean };
        return { id:Number(row.tariff_id), replayed:Boolean(row.replayed) };
      }
      const message=String(error?.message??"");
      if (message.includes("TARIFF_OPERATION_CONFLICT")) throw new TRPCError({code:"CONFLICT",message:"معرّف العملية مستخدم لبيانات تعرفة مختلفة."});
      if (message.includes("TARIFF_CODE_EXISTS") || error?.code==="23505") throw new TRPCError({code:"CONFLICT",message:"رمز التعرفة مستخدم بالفعل في هذا الفرع."});
      throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"تعذر إنشاء التعرفة في Supabase."});
    }),
  }),

  generators: router({
    list: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "technician", "viewer"]);
      return listSupabaseGenerators(input.siteId);
    }),
    create: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(), code: z.string().min(2).max(50), name: z.string().min(2).max(160),
      serialNumber: z.string().max(100).optional(), ratedCapacityKw: z.string().regex(/^\d+(\.\d{1,3})?$/),
      fuelType: z.enum(["diesel", "gasoline", "gas", "other"]).default("diesel"), clientOperationId: z.string().uuid(),
    })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "technician"], "manageGenerators");
      const { data, error } = await supabaseAdmin().rpc("powerhub_create_generator_online", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id, p_code: input.code,
        p_name: input.name, p_serial_number: input.serialNumber ?? null, p_rated_capacity_kw: input.ratedCapacityKw,
        p_fuel_type: input.fuelType, p_client_operation_id: input.clientOperationId,
      });
      if (error || !data?.[0]) throw new TRPCError({ code: error?.code === "23505" ? "CONFLICT" : error?.message?.includes("GENERATOR_OPERATION_CONFLICT") ? "CONFLICT" : "INTERNAL_SERVER_ERROR", message: error?.code === "23505" ? "رمز أو اسم المولد مستخدم بالفعل." : error?.message?.includes("GENERATOR_OPERATION_CONFLICT") ? "معرّف العملية مستخدم لبيانات مولد مختلفة." : "تعذر إنشاء المولد في Supabase." });
      const id = Number((data[0] as { generator_id: number | string }).generator_id);
      await writeSupabaseAuditBestEffort({ userId: ctx.user.id, tenantId: access.tenantId, siteId: input.siteId, entityType: "generator", entityId: String(id), action: "create", afterData: input });
      return { id, replayed: Boolean((data[0] as { replayed?: boolean }).replayed) };
    }),
    update: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(), id: z.number().int().positive(), name: z.string().min(2).max(160), ratedCapacityKw: z.string().regex(/^\d+(\.\d{1,3})?$/),
      fuelLevelLiters: z.string().regex(/^\d+(\.\d{1,2})?$/), operatingHours: z.string().regex(/^\d+(\.\d{1,2})?$/), status: z.enum(["active", "maintenance", "stopped", "offline"]), clientOperationId: z.string().uuid(),
    })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "technician"], "manageGenerators");
      const admin = supabaseAdmin();
      const operationId = input.clientOperationId;
      const { data: existing, error: existingError } = await admin.from("generators")
        .select("id, tenant_id, site_id, name, rated_capacity_kw, fuel_level_liters, operating_hours, status")
        .eq("id", input.id).eq("site_id", input.siteId).maybeSingle();
      if (existingError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل المولد من Supabase." });
      if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "المولد غير موجود ضمن المحطة المحددة." });
      const { data, error } = await admin.rpc("powerhub_update_generator_online", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id, p_generator_id: input.id,
        p_name: input.name, p_rated_capacity_kw: input.ratedCapacityKw, p_fuel_level_liters: input.fuelLevelLiters,
        p_operating_hours: input.operatingHours, p_status: input.status, p_expected_updated_at: existing.updated_at,
        p_client_operation_id: operationId,
      });
      if (!error && data?.[0]) return { success: true as const, replayed: Boolean((data[0] as { replayed?: boolean }).replayed) };
      const errorText = String(error?.message ?? "");
      if (errorText.includes("GENERATOR_VERSION_CONFLICT")) throw new TRPCError({ code: "CONFLICT", message: "تغيرت بيانات المولد على الخادم؛ راجع التعديل ثم أعد المحاولة." });
      if (errorText.includes("GENERATOR_OPERATION_CONFLICT")) throw new TRPCError({ code: "CONFLICT", message: "معرّف العملية مستخدم لبيانات مختلفة؛ لم يتم تنفيذ تعديل آخر." });
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحديث المولد في Supabase." });
    }),
  }),

  readings: router({
    list: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "collector", "technician", "viewer"]);
      return listSupabaseReadings(input.siteId);
    }),
    create: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(), subscriberId: z.number().int().positive(), readingValue: z.string().regex(/^\d+(\.\d{1,3})?$/), readingAt: z.date().optional(),
      captureMethod: z.enum(["manual", "photo", "smart_meter"]).default("manual"), clientOperationId: z.string().uuid().optional(), imageData: z.string().max(9_500_000).optional(), imageMime: z.enum(["image/jpeg", "image/png", "image/webp"]).optional(), notes: z.string().max(1000).optional(), isReadingReset: z.boolean().default(false), overrideSameDay: z.boolean().default(false), fieldVerified: z.boolean().default(false),
    })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, readingRoles, "recordReadings");
      const readingAt = input.readingAt ?? new Date();
      const existingReading = await reconcileReadingAfterError({
        tenantId: access.tenantId, siteId: input.siteId, subscriberId: input.subscriberId,
        clientOperationId: input.clientOperationId, issueInvoice: true,
      });
      if (existingReading.resolved && existingReading.invoice) {
        return {
          id: existingReading.id, consumptionKwh: existingReading.consumptionKwh, status: "approved" as const,
          invoiceId: existingReading.invoice.id, invoiceNo: existingReading.invoice.invoiceNo,
          totalAmount: existingReading.invoice.totalAmount, notificationIds: [],
          replayed: true, alreadyProcessed: true,
        };
      }
      let imageKey: string | undefined;
      let imageHash: string | undefined;
      if (input.imageData) {
        if (!input.imageMime) throw new TRPCError({ code: "BAD_REQUEST", message: "نوع صورة القراءة غير مدعوم." });
        const imageBytes = Buffer.from(input.imageData, "base64");
        if (imageBytes.byteLength === 0 || imageBytes.byteLength > 7 * 1024 * 1024) throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: "يجب ألا يتجاوز حجم صورة القراءة 7 ميغابايت." });
        imageHash = createHash("sha256").update(imageBytes).digest("hex");
        const extension = input.imageMime === "image/png" ? "png" : input.imageMime === "image/webp" ? "webp" : "jpg";
        const stored = await storagePut(`subscriber-readings/${ctx.user.id}/${input.subscriberId}-${Date.now()}.${extension}`, imageBytes, input.imageMime);
        imageKey = stored.key;
      }
      const { data, error } = await supabaseAdmin().rpc("powerhub_create_reading", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id, p_subscriber_id: input.subscriberId,
        p_client_operation_id: input.clientOperationId ?? null, p_reading_at: readingAt.toISOString(), p_reading_value: input.readingValue,
        p_capture_method: input.captureMethod, p_image_key: imageKey ?? "", p_image_hash: imageHash ?? "", p_notes: input.notes?.trim() ?? "",
        p_is_reading_reset: input.isReadingReset, p_field_verified: input.fieldVerified,
        p_can_override_same_day: input.overrideSameDay && ["owner", "manager", "accountant"].includes(access.role),
      });
      if (!error && data?.[0]) {
        const row = data[0] as { reading_id: number | string; consumption_kwh: number | string; status: "pending_review"; replayed: boolean };
        return { id: Number(row.reading_id), consumptionKwh: Number(row.consumption_kwh), status: row.status, replayed: row.replayed };
      }
      const errorText = `${error?.code ?? ""} ${error?.message ?? ""}`;
      if (errorText.includes("SUBSCRIBER_OUT_OF_SCOPE_OR_INACTIVE")) throw new TRPCError({ code: "NOT_FOUND", message: "المشترك لا يتبع للمحطة المحددة أو أن خدمته غير نشطة." });
      if (errorText.includes("SAME_DAY_READING_EXISTS")) throw new TRPCError({ code: "CONFLICT", message: "توجد قراءة مسجلة لهذا المشترك في اليوم نفسه. يقتصر تجاوز ذلك على المالك أو المدير أو المحاسب مع تأكيد صريح." });
      if (errorText.includes("READING_BELOW_PREVIOUS")) throw new TRPCError({ code: "CONFLICT", message: "القراءة الحالية أقل من القراءة المعتمدة السابقة. فعّل خيار إعادة ضبط سجل القراءة وسجل ملاحظة للتأكيد." });
      if (errorText.includes("READING_RESET_NOTES_REQUIRED")) throw new TRPCError({ code: "BAD_REQUEST", message: "أدخل ملاحظة توضح سبب إعادة ضبط سجل القراءة قبل حفظها." });
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تسجيل القراءة في Supabase." });
    }),
    createAndIssue: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(), subscriberId: z.number().int().positive(), readingValue: z.string().regex(/^\d+(\.\d{1,3})?$/), readingAt: z.date().optional(),
      captureMethod: z.enum(["manual", "photo", "smart_meter"]).default("manual"), clientOperationId: z.string().uuid().optional(),
      imageData: z.string().max(9_500_000).optional(), imageMime: z.enum(["image/jpeg", "image/png", "image/webp"]).optional(),
      notes: z.string().max(1000).optional(), isReadingReset: z.boolean().default(false), overrideSameDay: z.boolean().default(false), fieldVerified: z.boolean().default(false),
    })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, createRoles, "issueInvoices");
      const readingAt = input.readingAt ?? new Date();
      let imageKey: string | undefined;
      let imageHash: string | undefined;
      try {
        if (input.imageData) {
          if (!input.imageMime) throw new TRPCError({ code: "BAD_REQUEST", message: "نوع صورة القراءة غير مدعوم." });
          const imageBytes = Buffer.from(input.imageData, "base64");
          if (imageBytes.byteLength === 0 || imageBytes.byteLength > 7 * 1024 * 1024) throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: "يجب ألا يتجاوز حجم صورة القراءة 7 ميغابايت." });
          imageHash = createHash("sha256").update(imageBytes).digest("hex");
          const extension = input.imageMime === "image/png" ? "png" : input.imageMime === "image/webp" ? "webp" : "jpg";
          const stored = await storagePut(`subscriber-readings/${ctx.user.id}/${input.subscriberId}-${Date.now()}.${extension}`, imageBytes, input.imageMime);
          imageKey = stored.key;
        }
        const dueDate = new Date(readingAt);
        dueDate.setDate(dueDate.getDate() + 14);
        const { data, error } = await supabaseAdmin().rpc("powerhub_create_and_issue_reading", {
          p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id, p_subscriber_id: input.subscriberId,
          p_client_operation_id: input.clientOperationId ?? null, p_reading_at: readingAt.toISOString(), p_reading_value: input.readingValue,
          p_capture_method: input.captureMethod, p_image_key: imageKey ?? "", p_image_hash: imageHash ?? "", p_notes: input.notes?.trim() ?? "",
          p_is_reading_reset: input.isReadingReset, p_field_verified: input.fieldVerified,
          p_can_override_same_day: input.overrideSameDay && ["owner", "manager", "accountant"].includes(access.role),
          p_due_date: dueDate.toISOString(), p_billing_period: readingAt.toISOString().slice(0, 7), p_discount_amount: 0,
        });
        const row = (data as Array<{ reading_id: number|string; consumption_kwh: number|string; invoice_id: number|string; invoice_no: string; total_amount: number|string; notification_ids?: unknown; replayed?: boolean; already_processed?: boolean }> | null)?.[0];
        if (!error && row) return {
          id: Number(row.reading_id), consumptionKwh: Number(row.consumption_kwh), status: "approved" as const,
          invoiceId: Number(row.invoice_id), invoiceNo: row.invoice_no, totalAmount: Number(row.total_amount),
          notificationIds: Array.isArray(row.notification_ids) ? row.notification_ids.map(Number).filter(Number.isInteger) : [],
          replayed: Boolean(row.replayed), alreadyProcessed: Boolean(row.already_processed),
        };
        const errorText = `${error?.code ?? ""} ${error?.message ?? ""}`;
        if (errorText.includes("TARIFF_NOT_FOUND")) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "لا توجد تعرفة فعالة لهذا الفرع؛ أضف تعرفة فعالة قبل إصدار الفاتورة." });
        if (errorText.includes("SAME_DAY_READING_EXISTS")) throw new TRPCError({ code: "CONFLICT", message: "توجد قراءة مسجلة لهذا المشترك في اليوم نفسه." });
        if (errorText.includes("READING_BELOW_PREVIOUS")) throw new TRPCError({ code: "CONFLICT", message: "القراءة الحالية أقل من القراءة السابقة المعتمدة." });
        if (errorText.includes("READING_RESET_NOTES_REQUIRED")) throw new TRPCError({ code: "BAD_REQUEST", message: "أدخل ملاحظة توضح سبب إعادة ضبط سجل القراءة." });
        if (errorText.includes("SUBSCRIBER_OUT_OF_SCOPE_OR_INACTIVE")) throw new TRPCError({ code: "NOT_FOUND", message: "المشترك لا يتبع للمحطة المحددة أو أن خدمته غير نشطة." });
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر حفظ القراءة وإصدار الفاتورة كعملية واحدة في Supabase." });
      } catch (error) {
        if (imageKey) { try { await storageRemove(imageKey); } catch {} }
        throw error;
      }
    }),
    updatePending: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), readingId: z.number().int().positive(), baseVersion: z.number().int().positive(), readingValue: z.string().regex(/^\d+(\.\d{1,3})?$/), readingAt: z.date(), notes: z.string().max(1000).optional() })).mutation(async ({ ctx, input }) => {
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
        const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "approveReadings");
        const { data, error } = await supabaseAdmin().rpc("powerhub_approve_reading", {
          p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id, p_reading_id: input.readingId, p_base_version: input.baseVersion,
        });
        if (!error && data?.[0]) return { success: true, replayed: Boolean((data[0] as { replayed?: boolean }).replayed) };
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
    createFromReading: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(), readingId: z.number().int().positive(), tariffId: z.number().int().positive(),
      billingPeriod: z.string().regex(/^\d{4}-\d{2}$/), dueDate: z.date(), discountAmount: z.number().min(0).default(0), clientOperationId: z.string().uuid().optional(),
    })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, createRoles, "issueInvoices");
      const replay = await getOfflineReplayForScope({ userId: ctx.user.id, tenantId: access.tenantId, siteId: input.siteId, clientOperationId: input.clientOperationId, expectedOperationType: "invoice_issue" });
      if (replay) {
        return { id: Number(replay.id), invoiceNo: String(replay.invoiceNo), totalAmount: Number(replay.totalAmount) };
      }
      const { data, error } = await supabaseAdmin().rpc("powerhub_issue_invoice_from_reading", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id, p_reading_id: input.readingId, p_tariff_id: input.tariffId,
        p_billing_period: input.billingPeriod, p_due_date: input.dueDate.toISOString(), p_discount_amount: input.discountAmount, p_client_operation_id: input.clientOperationId ?? null,
      });
      if (!error && data?.[0]) {
        const row = data[0] as { invoice_id: number | string; invoice_no: string; total_amount: number | string };
        return { id: Number(row.invoice_id), invoiceNo: row.invoice_no, totalAmount: Number(row.total_amount) };
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
        const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, createRoles, "issueInvoices");
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const token = generateInvoiceShareToken();
          const { data, error } = await supabaseAdmin().rpc("powerhub_create_invoice_share_link", {
            p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id, p_invoice_id: input.invoiceId,
            p_token_hash: hashInvoiceShareToken(token), p_token_preview: token.slice(0, 8), p_expires_at: input.expiresAt?.toISOString() ?? null,
          });
          if (!error && Number((data as Array<{ share_link_id: number | string }> | null)?.[0]?.share_link_id)) return { token, path: `/invoice/${token}` };
          const errorText = `${error?.code ?? ""} ${error?.message ?? ""}`;
          if (error?.code === "23505" && attempt < 2) continue;
          if (errorText.includes("INVOICE_NOT_SHAREABLE")) throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن مشاركة فاتورة غير صادرة أو ملغاة." });
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر إنشاء رابط مشاركة الفاتورة في Supabase." });
        }
        throw new TRPCError({ code: "CONFLICT", message: "تعذر إنشاء رابط مشاركة فريد للفاتورة؛ أعد المحاولة." });
      }),
    publicByToken: publicProcedure.input(z.object({ token: z.string().min(16).max(200) })).query(async ({ input }) => {
      const { data, error } = await supabaseAdmin().rpc("powerhub_get_shared_invoice_by_token_hash", { p_token_hash: hashInvoiceShareToken(input.token) });
      if (!error && data && typeof data === "object" && !Array.isArray(data)) return data as {
        invoice: { id: number; invoiceNo: string; billingPeriod: string; issueDate: string; dueDate: string; previousReading: number | null; currentReading: number | null; consumptionKwh: number; pricePerKwh: number; fixedFee: number; taxAmount: number; discountAmount: number; totalAmount: number; paidAmount: number; balanceDue: number; status: string };
        subscriber: { fullName: string; subscriberNo: string } | null;
        lines: Array<{ id: number; description: string; amount: number; quantity: number; unitPrice: number; displayOrder: number }>;
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
    create: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(), subscriberId: z.number().int().positive(), invoiceId: z.number().int().positive().optional(),
      paymentNo: z.string().min(3).max(60), amount: z.number().positive(), paymentMethod: z.enum(["cash", "jawwal_pay", "palpay", "bank_of_palestine", "wallet", "bank_transfer", "card"]).default("cash"), companyAccountId: z.number().int().positive(), transferFromAccount: z.string().trim().regex(/^\+?[0-9]{7,20}$/, "رقم الحساب المحوِّل يجب أن يكون رقم جوال صحيحاً.").optional(), transferFromType: z.enum(["jawwal_pay", "palpay", "bank_of_palestine"]).optional(), referenceNo: z.string().max(120).optional(), receiptImageData: z.string().max(9_500_000).optional(), receiptImageMime: z.enum(["image/jpeg", "image/png", "image/webp"]).optional(), clientOperationId: z.string().uuid().optional(),
    }).superRefine((input, ctx) => {
      const hasTransferSource = Boolean(input.transferFromAccount);
      if ((hasTransferSource && !input.transferFromType) || (!hasTransferSource && input.transferFromType)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["transferFromAccount"], message: "حدد نوع الحساب المحوِّل فقط عند إدخال رقمه." });
    })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, recordRoles, "collectPayments");
      const replay = await getOfflineReplayForScope({ userId: ctx.user.id, tenantId: access.tenantId, siteId: input.siteId, clientOperationId: input.clientOperationId, expectedOperationType: "payment_create" });
      if (replay) return { id: Number(replay.id), replayed: true };
      let receiptImageKey: string | undefined;
      let receiptImageHash: string | undefined;
      if (input.receiptImageData) {
        if (!input.receiptImageMime) throw new TRPCError({ code: "BAD_REQUEST", message: "تعذر تحديد نوع صورة الإيصال." });
        const imageBytes = Buffer.from(input.receiptImageData, "base64");
        if (imageBytes.byteLength === 0 || imageBytes.byteLength > 7 * 1024 * 1024) throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: "يجب ألا تتجاوز صورة الإيصال 7 ميغابايت." });
        receiptImageHash = crypto.createHash("sha256").update(imageBytes).digest("hex");
        const extension = input.receiptImageMime === "image/png" ? "png" : input.receiptImageMime === "image/webp" ? "webp" : "jpg";
        const stored = await storagePut(`payment-receipts/${ctx.user.id}/${input.paymentNo}-${Date.now()}.${extension}`, imageBytes, input.receiptImageMime);
        receiptImageKey = stored.key;
      }
      try {
      let collectorSessionId: number | undefined;
      if (access.role === "collector") {
        const { data: openSession, error: sessionError } = await supabaseAdmin().from("collector_sessions").select("id")
          .eq("tenant_id", access.tenantId).eq("site_id", input.siteId).eq("collector_user_id", ctx.user.id).eq("status", "open").maybeSingle();
        if (sessionError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر التحقق من جلسة التحصيل في Supabase." });
        if (!openSession) throw new TRPCError({ code: "BAD_REQUEST", message: "افتح جلسة تحصيل قبل تسجيل دفعاتك الميدانية." });
        collectorSessionId = Number(openSession.id);
      }
      const { data, error } = await supabaseAdmin().rpc("powerhub_create_payment", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id, p_subscriber_id: input.subscriberId, p_invoice_id: input.invoiceId ?? null,
        p_payment_no: input.paymentNo, p_amount: input.amount, p_payment_method: input.paymentMethod, p_company_account_id: input.companyAccountId,
        p_transfer_from_account: input.transferFromAccount ?? null, p_transfer_from_type: input.transferFromType ?? null, p_reference_no: input.referenceNo ?? null,
        p_receipt_image_key: receiptImageKey ?? null, p_receipt_image_hash: receiptImageHash ?? null, p_collector_session_id: collectorSessionId ?? null,
        p_client_operation_id: input.clientOperationId ?? null,
      });
      if (!error && data?.[0]) {
        const paymentResult = data[0] as { payment_id: number | string; replayed?: boolean };
        if (paymentResult.replayed && receiptImageKey) {
          try { await storageRemove(receiptImageKey); } catch {}
        }
        return { id: Number(paymentResult.payment_id), replayed: Boolean(paymentResult.replayed) };
      }
      const errorText = `${error?.code ?? ""} ${error?.message ?? ""}`;
      if (errorText.includes("DUPLICATE_PAYMENT_NO")) throw new TRPCError({ code: "CONFLICT", message: "رقم الإيصال مستخدم مسبقاً؛ أدخل رقماً مرجعياً مختلفاً." });
      if (errorText.includes("SUBSCRIBER_OUT_OF_SCOPE")) throw new TRPCError({ code: "NOT_FOUND", message: "المشترك لا يتبع للمحطة المحددة." });
      if (errorText.includes("COMPANY_ACCOUNT_NOT_FOUND") || errorText.includes("COMPANY_ACCOUNT_OUT_OF_SCOPE")) throw new TRPCError({ code: "NOT_FOUND", message: "الحساب المستقبِل غير متاح ضمن حسابات الشركة." });
      if (errorText.includes("COMPANY_ACCOUNT_TYPE_MISMATCH")) throw new TRPCError({ code: "BAD_REQUEST", message: "طريقة الدفع يجب أن تطابق نوع الحساب المستقبِل المختار." });
      if (errorText.includes("INVOICE_OUT_OF_SCOPE")) throw new TRPCError({ code: "NOT_FOUND", message: "الفاتورة لا تتبع للمشترك والمحطة المحددين." });
      if (errorText.includes("INVOICE_NOT_COLLECTIBLE")) throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن تسجيل دفعة على فاتورة ملغاة أو مسودة." });
      if (errorText.includes("INVOICE_BALANCE_CONFLICT")) throw new TRPCError({ code: "CONFLICT", message: "تغير رصيد الفاتورة أثناء المزامنة؛ راجع المسودة ثم أعد المحاولة." });
      if (errorText.includes("FINANCIAL_PERIOD_LOCKED")) throw new TRPCError({ code: "FORBIDDEN", message: "الفترة المالية مقفلة؛ لا يمكن تعديل أو إضافة بيانات مالية داخلها." });
      if (errorText.includes("COLLECTOR_SESSION_NOT_OPEN")) throw new TRPCError({ code: "BAD_REQUEST", message: "افتح جلسة تحصيل قبل تسجيل دفعاتك الميدانية." });
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تسجيل التحصيل في Supabase." });

      } catch (error) {
        if (receiptImageKey) {
          try { await storageRemove(receiptImageKey); } catch {}
        }
        throw error;
      }
    }),
  }),

  collectorSessions: router({
    list: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, recordRoles, "collectPayments");
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
      const { data, error } = await supabaseAdmin().from("collector_sessions").select("id, tenant_id, site_id, collector_user_id, status, opening_cash, expected_cash, declared_cash, variance_amount, opened_at, closed_at, notes, closed_by_user_id, created_at, updated_at").eq("tenant_id", access.tenantId).eq("site_id", input.siteId).eq("collector_user_id", ctx.user.id).eq("status", "open").maybeSingle();
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل جلسة التحصيل من Supabase." });
      return data ? { id: Number(data.id), tenantId: Number(data.tenant_id), siteId: Number(data.site_id), collectorUserId: Number(data.collector_user_id), status: data.status, openingCash: String(data.opening_cash), expectedCash: String(data.expected_cash), declaredCash: data.declared_cash === null ? null : String(data.declared_cash), varianceAmount: data.variance_amount === null ? null : String(data.variance_amount), openedAt: new Date(data.opened_at), closedAt: data.closed_at ? new Date(data.closed_at) : null, notes: data.notes, closedByUserId: data.closed_by_user_id === null ? null : Number(data.closed_by_user_id), createdAt: new Date(data.created_at), updatedAt: new Date(data.updated_at) } : null;
    }),
    open: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), openingCash: z.number().min(0).default(0), notes: z.string().max(1000).optional(), clientOperationId: z.string().uuid() })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, recordRoles, "collectPayments");
      if (access.role !== "collector") throw new TRPCError({ code: "FORBIDDEN", message: "جلسة التحصيل الميدانية مخصصة لدور المحصل." });
      const { data, error } = await supabaseAdmin().rpc("powerhub_open_collector_session", { p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id, p_opening_cash: input.openingCash, p_notes: input.notes ?? null, p_client_operation_id: input.clientOperationId });
      if (!error && data?.[0]) return { id: Number((data[0] as { session_id: number | string }).session_id), replayed: Boolean((data[0] as { replayed?: boolean }).replayed) };
      if (`${error?.message ?? ""}`.includes("COLLECTOR_SESSION_EXISTS")) throw new TRPCError({ code: "CONFLICT", message: "لديك جلسة تحصيل مفتوحة بالفعل لهذه المحطة." });
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر فتح جلسة التحصيل في Supabase." });
    }),
    close: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), sessionId: z.number().int().positive(), declaredCash: z.number().min(0), notes: z.string().max(1000).optional() })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, recordRoles, "collectPayments");
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
    list: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "viewer"]);
      return listSupabaseExpenses(input.siteId);
    }),
    create: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(), generatorId: z.number().int().positive().optional(), category: z.enum(["fuel", "maintenance", "payroll", "parts", "transport", "other"]),
      description: z.string().min(2).max(255), amount: z.number().positive(), referenceNo: z.string().max(120).optional(), clientOperationId: z.string().uuid().optional(),
    })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, createRoles, "manageExpenses");
      const { data, error } = await supabaseAdmin().rpc("powerhub_create_expense", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id, p_generator_id: input.generatorId ?? null,
        p_category: input.category, p_description: input.description, p_amount: input.amount, p_reference_no: input.referenceNo ?? null,
        p_client_operation_id: input.clientOperationId ?? null,
      });
      if (!error && data?.[0]) return { id: Number((data[0] as { expense_id: number | string }).expense_id), replayed: Boolean((data[0] as { replayed?: boolean }).replayed) };
      const errorText = `${error?.code ?? ""} ${error?.message ?? ""}`;
      if (errorText.includes("GENERATOR_OUT_OF_SCOPE")) throw new TRPCError({ code: "NOT_FOUND", message: "المولد لا يتبع للمحطة المحددة." });
      if (errorText.includes("EXPENSE_OPERATION_CONFLICT")) throw new TRPCError({ code: "CONFLICT", message: "معرّف العملية مستخدم لمصروف ببيانات مختلفة؛ لم يتم إنشاء مصروف جديد." });
      if (errorText.includes("FINANCIAL_PERIOD_LOCKED")) throw new TRPCError({ code: "FORBIDDEN", message: "الفترة المالية مقفلة؛ لا يمكن تعديل أو إضافة بيانات مالية داخلها." });
      if (errorText.includes("INVALID_EXPENSE_AMOUNT") || errorText.includes("INVALID_EXPENSE_CATEGORY")) throw new TRPCError({ code: "BAD_REQUEST", message: "بيانات المصروف غير صالحة." });
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تسجيل المصروف في Supabase." });
    }),
  }),

  dashboard: router({
    summary: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "collector", "technician", "viewer"]);
      return getSupabaseDashboardSummary(input.siteId);
    }),
    allBranchesSummary: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      const access = await requireSupabaseAllBranchesRole(ctx.user.id, input.siteId, ["manager", "accountant", "viewer"]);
      const admin = supabaseAdmin();
      const { data: branchRows, error: branchesError } = await admin.from("sites").select("id").eq("tenant_id", access.tenantId).neq("status", "archived");
      if (branchesError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل فروع المستأجر من Supabase." });
      const branchIds = (branchRows ?? []).map((branch) => Number(branch.id));
      if (!branchIds.length) return { branchCount: 0, subscribers: 0, generators: { active: 0, maintenance: 0 }, financial: { invoiced: 0, collected: 0, outstanding: 0, expenses: 0, operatingProfit: 0 }, energyKwh: 0, failedNotifications: 0 };
      const [subscriberResult, generatorResult, invoiceResult, expenseResult, notificationResult] = await Promise.all([
        admin.from("subscribers").select("service_status").eq("tenant_id", access.tenantId).in("site_id", branchIds),
        admin.from("generators").select("status").eq("tenant_id", access.tenantId).in("site_id", branchIds),
        admin.from("invoices").select("status, total_amount, paid_amount, balance_due, consumption_kwh").eq("tenant_id", access.tenantId).in("site_id", branchIds),
        admin.from("expenses").select("amount").eq("tenant_id", access.tenantId).in("site_id", branchIds),
        admin.from("notification_messages").select("status").eq("tenant_id", access.tenantId),
      ]);
      if (subscriberResult.error || generatorResult.error || invoiceResult.error || expenseResult.error || notificationResult.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل ملخص جميع الأفرع من Supabase." });
      const invoiceTotals = (invoiceResult.data ?? []).filter((row) => row.status !== "cancelled").reduce((totals, row) => ({
        invoiced: totals.invoiced + Number(row.total_amount ?? 0), paid: totals.paid + Number(row.paid_amount ?? 0),
        outstanding: totals.outstanding + Number(row.balance_due ?? 0), energy: totals.energy + Number(row.consumption_kwh ?? 0),
      }), { invoiced: 0, paid: 0, outstanding: 0, energy: 0 });
      const expensesTotal = (expenseResult.data ?? []).reduce((total, row) => total + Number(row.amount ?? 0), 0);
      return {
        branchCount: branchIds.length,
        subscribers: (subscriberResult.data ?? []).filter((row) => row.service_status === "active").length,
        generators: { active: (generatorResult.data ?? []).filter((row) => row.status === "active").length, maintenance: (generatorResult.data ?? []).filter((row) => row.status === "maintenance").length },
        financial: { invoiced: invoiceTotals.invoiced, collected: invoiceTotals.paid, outstanding: invoiceTotals.outstanding, expenses: expensesTotal, operatingProfit: invoiceTotals.paid - expensesTotal },
        energyKwh: invoiceTotals.energy,
        failedNotifications: (notificationResult.data ?? []).filter((row) => row.status === "failed").length,
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
      const [invoiceResult, paymentResult, expenseResult, subscriberResult] = await Promise.all([
        admin.from("invoices").select("id, site_id, subscriber_id, invoice_no, issue_date, due_date, total_amount, paid_amount, balance_due, status").eq("tenant_id", access.tenantId).in("site_id", branchIds).not("status", "in", "(cancelled,draft)"),
        admin.from("payments").select("site_id, subscriber_id, amount, status, paid_at").eq("tenant_id", access.tenantId).in("site_id", branchIds),
        admin.from("expenses").select("site_id, amount, occurred_at").eq("tenant_id", access.tenantId).in("site_id", branchIds),
        admin.from("subscribers").select("id, site_id, full_name, subscriber_no, service_status").eq("tenant_id", access.tenantId).in("site_id", branchIds),
      ]);
      if (invoiceResult.error || paymentResult.error || expenseResult.error || subscriberResult.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل بيانات التقرير المالي من Supabase." });
      const subscribersById = new Map((subscriberResult.data ?? []).map((subscriber) => [Number(subscriber.id), subscriber]));
      const subscriberCountBySite = new Map<number, number>();
      for (const subscriber of subscriberResult.data ?? []) if (subscriber.service_status === "active") subscriberCountBySite.set(Number(subscriber.site_id), (subscriberCountBySite.get(Number(subscriber.site_id)) ?? 0) + 1);
      return buildFinancialOverview({
        branches: (branchRows ?? []).map((branch) => ({ id: Number(branch.id), name: branch.name, activeSubscribers: subscriberCountBySite.get(Number(branch.id)) ?? 0 })),
        invoices: (invoiceResult.data ?? []).flatMap((invoice) => {
          const subscriber = subscribersById.get(Number(invoice.subscriber_id));
          return subscriber ? [{ id: Number(invoice.id), siteId: Number(invoice.site_id), subscriberId: Number(invoice.subscriber_id), subscriberName: subscriber.full_name, subscriberNo: subscriber.subscriber_no, invoiceNo: invoice.invoice_no, issueDate: new Date(invoice.issue_date), dueDate: new Date(invoice.due_date), totalAmount: Number(invoice.total_amount), paidAmount: Number(invoice.paid_amount), balanceDue: Number(invoice.balance_due), status: invoice.status }] : [];
        }),
        payments: (paymentResult.data ?? []).map((payment) => ({ siteId: Number(payment.site_id), subscriberId: Number(payment.subscriber_id), amount: Number(payment.amount), status: payment.status, paidAt: new Date(payment.paid_at) })),
        expenses: (expenseResult.data ?? []).map((expense) => ({ siteId: Number(expense.site_id), amount: Number(expense.amount), occurredAt: new Date(expense.occurred_at) })),
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
    }).refine((input) => input.startDate <= input.endDate, { message: "يجب أن يكون تاريخ البداية قبل تاريخ النهاية." })).query(async ({ ctx, input }) => {
      await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "viewer"]);
      const { start, endExclusive } = reportDateRange(input.startDate, input.endDate);
      const inRange = (value: Date) => value >= start && value < endExclusive;
      const [allInvoices, paymentRows, allExpenses, subscriberRows] = await Promise.all([listSupabaseInvoices(input.siteId), listSupabasePayments(input.siteId), listSupabaseExpenses(input.siteId), listSupabaseSubscribers(input.siteId)]);
      const invoiceRows = allInvoices.filter((invoice) => invoice.status !== "cancelled" && inRange(invoice.issueDate));
      const completedPayments = paymentRows.filter(({ payment }) => payment.status === "completed" && inRange(payment.paidAt));
      const expenseRows = allExpenses.filter((expense) => inRange(expense.occurredAt));
      const collectorIds = Array.from(new Set(completedPayments.flatMap(({ payment }) => payment.collectedByUserId === null ? [] : [payment.collectedByUserId])));
      const { data: collectorRows, error: collectorsError } = collectorIds.length ? await supabaseAdmin().from("users").select("id, name, email").in("id", collectorIds) : { data: [], error: null };
      if (collectorsError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل أسماء المحصلين من Supabase." });
      const collectorsById = new Map((collectorRows ?? []).map((collector) => [Number(collector.id), collector.name || collector.email || "محصل غير محدد"]));
      const subscribersById = new Map(subscriberRows.map((subscriber) => [subscriber.id, subscriber]));
      const invoiced = invoiceRows.reduce((sum, invoice) => sum + Number(invoice.totalAmount), 0);
      const outstanding = invoiceRows.reduce((sum, invoice) => sum + Number(invoice.balanceDue), 0);
      const energyKwh = invoiceRows.reduce((sum, invoice) => sum + Number(invoice.consumptionKwh), 0);
      const collected = completedPayments.reduce((sum, row) => sum + Number(row.payment.amount), 0);
      const expenseTotal = expenseRows.reduce((sum, expense) => sum + Number(expense.amount), 0);
      const collectors = Object.values(completedPayments.reduce<Record<string, { name: string; count: number; amount: number }>>((acc, row) => {
        const key = String(row.payment.collectedByUserId ?? 0);
        const entry = acc[key] ?? { name: collectorsById.get(row.payment.collectedByUserId ?? 0) ?? "محصل غير محدد", count: 0, amount: 0 };
        entry.count += 1;
        entry.amount += Number(row.payment.amount);
        acc[key] = entry;
        return acc;
      }, {})).sort((a, b) => b.amount - a.amount);
      const topDebtors = invoiceRows.filter((invoice) => Number(invoice.balanceDue) > 0).sort((a, b) => Number(b.balanceDue) - Number(a.balanceDue)).slice(0, 10).map((invoice) => ({ subscriber: subscribersById.get(invoice.subscriberId)?.fullName ?? "مشترك", subscriberNo: subscribersById.get(invoice.subscriberId)?.subscriberNo ?? "—", invoiceNo: invoice.invoiceNo, balanceDue: Number(invoice.balanceDue), dueDate: invoice.dueDate }));
      const paymentDetails = completedPayments.map(({ payment }) => ({ paymentNo: payment.paymentNo, amount: Number(payment.amount), paymentMethod: payment.paymentMethod, paidAt: payment.paidAt, transferFromAccount: payment.transferFromAccount, transferFromType: payment.transferFromType, transferToAccount: payment.transferToAccount, transferToType: payment.transferToType }));
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
      const branchData = await Promise.all(branchIds.map(async (siteId) => {
        const [invoicesForSite, paymentsForSite, expensesForSite, subscribersForSite] = await Promise.all([listSupabaseInvoices(siteId), listSupabasePayments(siteId), listSupabaseExpenses(siteId), listSupabaseSubscribers(siteId)]);
        return { invoices: invoicesForSite.filter((invoice) => invoice.status !== "cancelled" && invoice.issueDate >= start && invoice.issueDate < endExclusive).map((invoice) => ({ invoice, subscriber: subscribersForSite.find((subscriber) => subscriber.id === invoice.subscriberId) })), payments: paymentsForSite.filter(({ payment }) => payment.paidAt >= start && payment.paidAt < endExclusive), expenses: expensesForSite.filter((expense) => expense.occurredAt >= start && expense.occurredAt < endExclusive) };
      }));
      const invoiceRows = branchData.flatMap((data) => data.invoices);
      const paymentRows = branchData.flatMap((data) => data.payments).map(({ payment }) => ({ payment, collector: null }));
      const expenseRows = branchData.flatMap((data) => data.expenses);
      const branchNameById = new Map(branchRows.map((branch) => [branch.id, branch.name]));
      const branchSummaryById = new Map(branchRows.map((branch) => [branch.id, { siteId: branch.id, branchName: branch.name, invoiced: 0, collected: 0, outstanding: 0, energyKwh: 0, expenseTotal: 0, operatingProfit: 0 }]));
      invoiceRows.forEach((row) => {
        const summary = branchSummaryById.get(row.invoice.siteId);
        if (!summary) return;
        summary.invoiced += Number(row.invoice.totalAmount);
        summary.outstanding += Number(row.invoice.balanceDue);
        summary.energyKwh += Number(row.invoice.consumptionKwh);
      });
      const completedPayments = paymentRows.filter((row) => row.payment.status === "completed");
      completedPayments.forEach((row) => { const summary = branchSummaryById.get(row.payment.siteId); if (summary) summary.collected += Number(row.payment.amount); });
      expenseRows.forEach((row) => { const summary = branchSummaryById.get(row.siteId); if (summary) summary.expenseTotal += Number(row.amount); });
      const branchSummaries = Array.from(branchSummaryById.values()).map((summary) => ({ ...summary, operatingProfit: summary.collected - summary.expenseTotal }));
      const summary = branchSummaries.reduce((total, branch) => ({ invoiced: total.invoiced + branch.invoiced, collected: total.collected + branch.collected, outstanding: total.outstanding + branch.outstanding, energyKwh: total.energyKwh + branch.energyKwh, expenseTotal: total.expenseTotal + branch.expenseTotal, operatingProfit: total.operatingProfit + branch.operatingProfit }), { invoiced: 0, collected: 0, outstanding: 0, energyKwh: 0, expenseTotal: 0, operatingProfit: 0 });
      const collectors = Object.values(completedPayments.reduce<Record<string, { name: string; count: number; amount: number }>>((acc, row) => {
        const key = String(row.payment.collectedByUserId ?? 0);
        const entry = acc[key] ?? { name: "محصل غير محدد", count: 0, amount: 0 };
        entry.count += 1;
        entry.amount += Number(row.payment.amount);
        return acc;
      }, {})).sort((a, b) => b.amount - a.amount);
      const topDebtors = invoiceRows.filter((row) => Number(row.invoice.balanceDue) > 0).sort((a, b) => Number(b.invoice.balanceDue) - Number(a.invoice.balanceDue)).slice(0, 10).map((row) => ({ branchName: branchNameById.get(row.invoice.siteId) ?? "فرع غير محدد", subscriber: row.subscriber?.fullName ?? "مشترك", subscriberNo: row.subscriber?.subscriberNo ?? "—", invoiceNo: row.invoice.invoiceNo, balanceDue: Number(row.invoice.balanceDue), dueDate: row.invoice.dueDate }));
      const paymentDetails = completedPayments.map((row) => ({ siteId: row.payment.siteId, paymentNo: row.payment.paymentNo, amount: Number(row.payment.amount), paymentMethod: row.payment.paymentMethod, paidAt: row.payment.paidAt, transferFromAccount: row.payment.transferFromAccount, transferFromType: row.payment.transferFromType, transferToAccount: row.payment.transferToAccount, transferToType: row.payment.transferToType }));
      return { range: { startDate: input.startDate, endDate: input.endDate }, scope: { branchCount: branchIds.length }, summary, collectors, topDebtors, branchSummaries, paymentDetails };
    }),
    monthly: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), billingPeriod: z.string().regex(/^\d{4}-\d{2}$/) })).query(async ({ ctx, input }) => {
      await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "viewer"]);
      const [invoicesForSite, paymentRows, expenseRows, subscriberRows] = await Promise.all([listSupabaseInvoices(input.siteId), listSupabasePayments(input.siteId), listSupabaseExpenses(input.siteId), listSupabaseSubscribers(input.siteId)]);
      const invoiceRows = invoicesForSite.filter((invoice) => invoice.billingPeriod === input.billingPeriod && invoice.status !== "cancelled");
      const matchPeriod = (date: Date | null) => date ? date.toISOString().slice(0, 7) === input.billingPeriod : false;
      const periodPayments = paymentRows.filter(({ payment }) => matchPeriod(payment.paidAt));
      const periodExpenses = expenseRows.filter((row) => matchPeriod(row.occurredAt));
      const collectorIds = Array.from(new Set(periodPayments.flatMap(({ payment }) => payment.collectedByUserId === null ? [] : [payment.collectedByUserId])));
      const { data: collectorRows, error: collectorsError } = collectorIds.length ? await supabaseAdmin().from("users").select("id, name, email").in("id", collectorIds) : { data: [], error: null };
      if (collectorsError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل أسماء المحصلين من Supabase." });
      const collectorsById = new Map((collectorRows ?? []).map((collector) => [Number(collector.id), collector.name || collector.email || "محصل غير محدد"]));
      const subscribersById = new Map(subscriberRows.map((subscriber) => [subscriber.id, subscriber]));
      const invoiced = invoiceRows.reduce((sum, invoice) => sum + Number(invoice.totalAmount), 0);
      const outstanding = invoiceRows.reduce((sum, invoice) => sum + Number(invoice.balanceDue), 0);
      const energyKwh = invoiceRows.reduce((sum, invoice) => sum + Number(invoice.consumptionKwh), 0);
      const collected = periodPayments.filter((row) => row.payment.status === "completed").reduce((sum, row) => sum + Number(row.payment.amount), 0);
      const expenseTotal = periodExpenses.reduce((sum, row) => sum + Number(row.amount), 0);
      const collectors = Object.values(periodPayments.reduce<Record<string, { name: string; count: number; amount: number }>>((acc, row) => {
        const key = String(row.payment.collectedByUserId ?? 0);
        const entry = acc[key] ?? { name: collectorsById.get(row.payment.collectedByUserId ?? 0) ?? "محصل غير محدد", count: 0, amount: 0 };
        entry.count += 1;
        entry.amount += Number(row.payment.amount);
        acc[key] = entry;
        return acc;
      }, {})).sort((a, b) => b.amount - a.amount);
      const topDebtors = invoiceRows.filter((invoice) => Number(invoice.balanceDue) > 0).sort((a, b) => Number(b.balanceDue) - Number(a.balanceDue)).slice(0, 10).map((invoice) => ({ subscriber: subscribersById.get(invoice.subscriberId)?.fullName ?? "مشترك", subscriberNo: subscribersById.get(invoice.subscriberId)?.subscriberNo ?? "—", invoiceNo: invoice.invoiceNo, balanceDue: Number(invoice.balanceDue), dueDate: invoice.dueDate }));
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
        let logoUrl: string | null = null;
        if (profile.report_logo_key) {
          try {
            logoUrl = (await storageGet(profile.report_logo_key)).url;
          } catch (logoError) {
            console.error("[report-branding] branding saved but logo URL retrieval failed", logoError);
          }
        }
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
    list: protectedProcedure.input(siteScoped.extend({ eventType: z.enum(["invoice_issued", "payment_reminder", "payment_received", "service_alert", "subscriber_reference"]).optional() })).query(async ({ ctx, input }) => {
      const scope = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "viewer"]);
      let notificationQuery = supabaseAdmin().from("notification_messages").select("id, tenant_id, invoice_id, subscriber_id, channel, event_type, recipient, status, provider_message_id, payload, attempts, last_error, created_at, updated_at")
        .eq("tenant_id", scope.tenantId).order("created_at", { ascending: false }).limit(500);
      if (input.eventType) notificationQuery = notificationQuery.eq("event_type", input.eventType);
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
        return [{ notification: { id: Number(row.id), tenantId: Number(row.tenant_id), invoiceId: row.invoice_id === null ? null : Number(row.invoice_id), subscriberId: Number(row.subscriber_id), channel: row.channel, eventType: row.event_type, recipient: row.recipient, status: row.status, providerMessageId: row.provider_message_id, payload: row.payload, attempts: row.attempts, lastError: row.last_error, createdAt: new Date(row.created_at), updatedAt: new Date(row.updated_at) }, subscriber, invoiceNo: row.invoice_id === null ? null : invoiceNoById.get(Number(row.invoice_id)) ?? null }];
      });
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
    sendPendingSms: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(),
      invoiceIds: z.array(z.number().int().positive()).min(1).optional(),
      sendAll: z.boolean().default(false),
      includeFailed: z.boolean().default(false),
      retryFailedOnly: z.boolean().default(false),
    })).mutation(async ({ ctx, input }) => {
      const scope = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "manageMessaging");
      const admin = supabaseAdmin();
      const invoiceIds = Array.from(new Set(input.invoiceIds ?? []));
      if (input.sendAll && invoiceIds.length) throw new TRPCError({ code: "BAD_REQUEST", message: "استخدم تحديد الفواتير أو الإرسال للجميع، وليس الاثنين معاً." });

      if (!input.retryFailedOnly && (invoiceIds.length || input.sendAll)) {
        let ids = invoiceIds;
        if (input.sendAll) {
          const { data: invoices, error: invoiceError } = await admin.from("invoices")
            .select("id")
            .eq("tenant_id", scope.tenantId)
            .eq("site_id", input.siteId)
            .not("status", "in", "(draft,cancelled)")
            .order("id", { ascending: true });
          if (invoiceError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل جميع الفواتير المؤهلة من Supabase." });
          ids = (invoices ?? []).map((row) => Number(row.id)).filter(Number.isInteger);
        }
        for (let offset = 0; offset < ids.length; offset += 200) {
          const chunk = ids.slice(offset, offset + 200);
          const { error: queueError } = await admin.rpc("powerhub_queue_selected_invoice_sms", {
            p_user_id: ctx.user.id, p_tenant_id: scope.tenantId, p_site_id: input.siteId, p_invoice_ids: chunk,
          });
          if (queueError) {
            const errorText = `${queueError.code ?? ""} ${queueError.message ?? ""}`;
            if (errorText.includes("INVOICE_OUT_OF_SCOPE")) throw new TRPCError({ code: "NOT_FOUND", message: "إحدى الفواتير لا تتبع للفرع المحدد." });
            if (errorText.includes("INVOICE_NOT_SENDABLE")) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "لا يمكن إرسال فاتورة مسودة أو ملغاة." });
            if (errorText.includes("SMS_CHANNEL_DISABLED")) throw new TRPCError({ code: "FORBIDDEN", message: "إرسال SMS معطّل من إعدادات المنصة." });
            throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تجهيز إشعارات SMS للفواتير المحددة." });
          }
        }
      }

      const statuses = input.retryFailedOnly ? ["failed"] : input.includeFailed ? ["pending", "failed"] : ["pending"];
      const notificationIds: number[] = [];
      for (let offset = 0;; offset += 200) {
        let query = admin.from("notification_messages").select("id, invoice_id, subscriber_id")
          .eq("tenant_id", scope.tenantId).eq("channel", "sms").in("status", statuses).order("created_at", { ascending: true }).range(offset, offset + 199);
        if (invoiceIds.length) query = query.in("invoice_id", invoiceIds);
        const { data: candidateRows, error: candidatesError } = await query;
        if (candidatesError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل رسائل SMS المؤجلة من Supabase." });
        const subscriberIds = Array.from(new Set((candidateRows ?? []).map((row) => Number(row.subscriber_id)).filter(Number.isInteger)));
        const { data: subscriberRows, error: subscribersError } = subscriberIds.length
          ? await admin.from("subscribers").select("id").eq("tenant_id", scope.tenantId).eq("site_id", input.siteId).in("id", subscriberIds)
          : { data: [], error: null };
        if (subscribersError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر التحقق من نطاق رسائل SMS المؤجلة." });
        const scopedSubscribers = new Set((subscriberRows ?? []).map((row) => Number(row.id)));
        notificationIds.push(...(candidateRows ?? []).flatMap((row) => scopedSubscribers.has(Number(row.subscriber_id)) ? [Number(row.id)] : []));
        if ((candidateRows ?? []).length < 200) break;
      }

      const result = await processNotificationQueueForTenant(scope.tenantId, ctx.user.id, notificationIds);
      await writeSupabaseAuditBestEffort({
        userId: ctx.user.id, tenantId: scope.tenantId, siteId: input.siteId, entityType: "notification_batch",
        entityId: notificationIds.join(",") || "none", action: "send_deferred_invoice_notifications",
        metadata: { notificationIds, requested: result.requested, submitted: result.submitted, failed: result.failed, skipped: result.skipped, includeFailed: input.includeFailed, retryFailedOnly: input.retryFailedOnly, sendAll: input.sendAll },
      });
      return result;
    }),
    retry: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), notificationId: z.number().int().positive() })).mutation(async ({ ctx, input }) => { throw new TRPCError({ code: "PRECONDITION_FAILED", message: "هذا المسار الموروث متوقف مؤقتاً إلى أن تكتمل خدمة Supabase/Vercel المستقلة." }); }),
    retryFailedInvoiceNotification: protectedProcedure.input(retryFailedInvoiceNotificationInput).mutation(async ({ ctx, input }) => { throw new TRPCError({ code: "PRECONDITION_FAILED", message: "هذا المسار الموروث متوقف مؤقتاً إلى أن تكتمل خدمة Supabase/Vercel المستقلة." }); }),
    retryFailedInvoiceNotifications: protectedProcedure.input(retryFailedInvoiceNotificationsInput).mutation(async ({ ctx, input }) => { throw new TRPCError({ code: "PRECONDITION_FAILED", message: "هذا المسار الموروث متوقف مؤقتاً إلى أن تكتمل خدمة Supabase/Vercel المستقلة." }); }),
    retryPaymentReceipt: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), notificationId: z.number().int().positive() })).mutation(async ({ ctx, input }) => { throw new TRPCError({ code: "PRECONDITION_FAILED", message: "هذا المسار الموروث متوقف مؤقتاً إلى أن تكتمل خدمة Supabase/Vercel المستقلة." }); }),
    sendDeferredInvoices: protectedProcedure.input(sendDeferredInvoiceNotificationsInput).mutation(async ({ ctx, input }) => { throw new TRPCError({ code: "PRECONDITION_FAILED", message: "هذا المسار الموروث متوقف مؤقتاً إلى أن تكتمل خدمة Supabase/Vercel المستقلة." }); }),
    sendBulkInvoiceSms: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), invoiceIds: z.array(z.number().int().positive()).min(1).max(200) })).mutation(async ({ ctx, input }) => { throw new TRPCError({ code: "PRECONDITION_FAILED", message: "هذا المسار الموروث متوقف مؤقتاً إلى أن تكتمل خدمة Supabase/Vercel المستقلة." }); }),
    sendPaymentReminderSms: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), invoiceId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      const scope = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "manageMessaging");
      const admin = supabaseAdmin();
      const { data: invoice, error: invoiceError } = await admin.from("invoices").select("id, subscriber_id, invoice_no, billing_period, balance_due, due_date, status").eq("id", input.invoiceId).eq("tenant_id", scope.tenantId).eq("site_id", input.siteId).maybeSingle();
      if (invoiceError || !invoice) throw new TRPCError({ code: "NOT_FOUND", message: "الفاتورة لا تتبع للفرع المحدد." });
      const { data: subscriber, error: subscriberError } = await admin.from("subscribers").select("id, full_name, phone").eq("id", Number(invoice.subscriber_id)).eq("tenant_id", scope.tenantId).eq("site_id", input.siteId).maybeSingle();
      if (subscriberError || !subscriber?.phone) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "لا يوجد رقم هاتف صالح للمشترك ضمن الفرع المحدد." });
      let recipient: string;
      try { recipient = normalizeInternationalPhone(subscriber.phone); } catch (error) { throw new TRPCError({ code: "PRECONDITION_FAILED", message: error instanceof Error ? `عدّل رقم هاتف المشترك قبل الإرسال. ${error.message}` : "عدّل رقم هاتف المشترك إلى صيغة دولية قبل الإرسال." }); }
      const { data: template } = await admin.from("tenant_invoice_message_templates").select("body").eq("tenant_id", scope.tenantId).eq("channel", "sms").eq("event_type", "invoice_issued").eq("is_active", true).order("updated_at", { ascending: false }).limit(1).maybeSingle();
      const values = { subscriber_name: subscriber.full_name, invoice_no: String(invoice.invoice_no), billing_period: String(invoice.billing_period), total_amount: String(invoice.balance_due), due_date: String(invoice.due_date ?? "") };
      const renderedText = `تذكير بالسداد: ${renderInvoiceMessageTemplate(template?.body ?? defaultInvoiceMessageTemplates.sms, values)}`;
      const { data: queueRows, error: queueError } = await admin.rpc("powerhub_queue_payment_sms", { p_user_id: ctx.user.id, p_tenant_id: scope.tenantId, p_site_id: input.siteId, p_event_type: "payment_reminder", p_invoice_id: Number(invoice.id), p_payment_id: null, p_operation_key: `payment_reminder:${invoice.id}:${new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Gaza", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date())}`, p_rendered_text: renderedText });
      if (queueError || !(queueRows as Array<{ notification_id: number }> | null)?.[0]) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "تعذر تجهيز تذكير SMS للفواتير المستحقة." });
      const notificationId = Number((queueRows as Array<{ notification_id: number }>)[0].notification_id);
      const dispatch = await processNotificationById(notificationId, ctx.user.id);
      return { notificationIds: [notificationId], channels: ["sms"], recipient, ...dispatch };
    }),
    sendPaymentReminder: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), invoiceId: z.number().int().positive() })).mutation(async ({ ctx, input }) => { throw new TRPCError({ code: "PRECONDITION_FAILED", message: "هذا المسار الموروث متوقف مؤقتاً إلى أن تكتمل خدمة Supabase/Vercel المستقلة." }); }),
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
      const receipt = { subscriberName: subscriber.full_name, paymentNo: String(payment.payment_no), paymentAmount: Number(payment.amount), invoiceNo: String(invoice.invoice_no), balanceDue: Number(invoice.balance_due) };
      const renderedText = renderPaymentReceiptTemplate(template?.body ?? defaultPaymentReceiptSmsTemplate, receipt) || renderPaymentReceiptMessage(receipt);
      const { data: queueRows, error: queueError } = await admin.rpc("powerhub_queue_payment_sms", { p_user_id: ctx.user.id, p_tenant_id: scope.tenantId, p_site_id: input.siteId, p_event_type: "payment_received", p_invoice_id: Number(invoice.id), p_payment_id: Number(payment.id), p_operation_key: `payment_receipt:${payment.id}`, p_rendered_text: renderedText });
      if (queueError || !(queueRows as Array<{ notification_id: number }> | null)?.[0]) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "تعذر تجهيز إيصال التحصيل عبر SMS." });
      const notificationId = Number((queueRows as Array<{ notification_id: number }>)[0].notification_id);
      const dispatch = await processNotificationById(notificationId, ctx.user.id);
      return { notificationId, recipient, channel: "sms" as const, ...dispatch };
    }),
    sendPaymentReceipt: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), paymentId: z.number().int().positive(), channel: z.enum(["whatsapp", "sms"]) })).mutation(async ({ ctx, input }) => { throw new TRPCError({ code: "PRECONDITION_FAILED", message: "هذا المسار الموروث متوقف مؤقتاً إلى أن تكتمل خدمة Supabase/Vercel المستقلة." }); }),
  }),

  companyAccounts: router({
    list: protectedProcedure.input(siteScoped.extend({ branchId: z.number().int().positive().optional(), fromDate: z.string().optional(), toDate: z.string().optional() })).query(async ({ ctx, input }) => {
      const from = input.fromDate ? new Date(input.fromDate) : null; const to = input.toDate ? new Date(input.toDate) : null;
      if (from && Number.isNaN(from.getTime())) throw new TRPCError({ code: "BAD_REQUEST", message: "تاريخ البداية غير صحيح." });
      if (to && Number.isNaN(to.getTime())) throw new TRPCError({ code: "BAD_REQUEST", message: "تاريخ النهاية غير صحيح." });
      if (from && to && from > to) throw new TRPCError({ code: "BAD_REQUEST", message: "تاريخ البداية يجب أن يسبق تاريخ النهاية." });
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "manageExpenses");
      return listSupabaseCompanyAccounts({ tenantId: access.tenantId, branchId: input.branchId, from, to });
    }),
    create: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), name: z.string().trim().min(2).max(120), accountType: z.enum(["cash", "jawwal_pay", "palpay", "bank_of_palestine", "other"]), phoneNumber: z.string().trim().regex(/^\+?[0-9]{7,20}$/, "أدخل رقم جوال صحيحاً."), openingBalance: z.number().nonnegative().default(0), color: z.string().trim().max(20).optional(), siteIds: z.array(z.number().int().positive()).min(1), clientOperationId: z.string().uuid().optional() })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager"], "manageExpenses");
      const operationId = input.clientOperationId ?? crypto.randomUUID();
      const { data, error } = await supabaseAdmin().rpc("powerhub_create_company_account_online", { p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id, p_name: input.name, p_account_type: input.accountType, p_phone_number: input.phoneNumber, p_opening_balance: input.openingBalance, p_color: input.color ?? "#64748b", p_site_ids: input.siteIds, p_client_operation_id: operationId });
      if (!error && data?.[0]) return { id: Number((data[0] as { account_id: number | string }).account_id), replayed: Boolean((data[0] as { replayed?: boolean }).replayed) };
      const errorText = `${error?.code ?? ""} ${error?.message ?? ""}`;
      if (errorText.includes("ACCOUNT_SITE_OUT_OF_SCOPE")) throw new TRPCError({ code: "FORBIDDEN", message: "أحد الفروع المحددة لا يتبع مساحة الشركة." });
      if (errorText.includes("COMPANY_ACCOUNT_OPERATION_CONFLICT")) throw new TRPCError({ code: "CONFLICT", message: "مفتاح العملية مرتبط بإنشاء حساب مختلف؛ أعد تحميل الصفحة ثم حاول بعملية جديدة." });
      if (error?.code === "23505") throw new TRPCError({ code: "CONFLICT", message: "يوجد حساب من النوع والرقم نفسيهما ضمن مساحة الشركة." });
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر إنشاء حساب الشركة في Supabase." });
    }),
    updatePhone: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), accountId: z.number().int().positive(), phoneNumber: z.string().trim().regex(/^\+?[0-9]{7,20}$/, "أدخل رقم جوال صحيحاً بصيغة دولية أو محلية.") })).mutation(async ({ ctx, input }) => { const access=await requireSupabaseSiteRole(ctx.user.id,input.siteId,["owner","manager","accountant"],"manageExpenses"); const {data,error}=await supabaseAdmin().rpc("powerhub_update_company_account_phone",{p_tenant_id:access.tenantId,p_site_id:input.siteId,p_user_id:ctx.user.id,p_account_id:input.accountId,p_phone_number:input.phoneNumber}); if(error) throw new TRPCError({code:error.message.includes("NOT_FOUND")?"NOT_FOUND":error.message.includes("OUT_OF_SCOPE")?"FORBIDDEN":error.message.includes("CONFLICT")?"CONFLICT":"BAD_REQUEST",message:error.message.includes("CONFLICT")?"يوجد حساب من النوع والرقم نفسيهما ضمن مساحة الشركة.":"تعذر تحديث رقم الحساب."}); if(!Number((data as Array<{account_id:number}>|null)?.[0]?.account_id)) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"لم تُعد دالة الحساب استجابة صالحة."}); return {success:true}; }),
    updateOpeningBalance: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), accountId: z.number().int().positive(), openingBalance: z.number().nonnegative() })).mutation(async ({ ctx, input }) => {
      const access=await requireSupabaseSiteRole(ctx.user.id,input.siteId,["owner","manager"],"manageExpenses"); const {data,error}=await supabaseAdmin().rpc("powerhub_update_company_account_opening_balance",{p_tenant_id:access.tenantId,p_site_id:input.siteId,p_user_id:ctx.user.id,p_account_id:input.accountId,p_opening_balance:input.openingBalance}); if(error) throw new TRPCError({code:error.message.includes("NOT_FOUND")?"NOT_FOUND":error.message.includes("MOVEMENTS")?"CONFLICT":"BAD_REQUEST",message:error.message.includes("MOVEMENTS")?"لا يمكن تعديل الرصيد الافتتاحي بعد تسجيل حركات على الحساب.":"تعذر تحديث الرصيد الافتتاحي."}); if(!Number((data as Array<{account_id:number}>|null)?.[0]?.account_id)) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"لم تُعد دالة الحساب استجابة صالحة."}); return {success:true};
    }),
    updateSites: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), accountId: z.number().int().positive(), siteIds: z.array(z.number().int().positive()).min(1) })).mutation(async ({ ctx, input }) => {
      const access=await requireSupabaseSiteRole(ctx.user.id,input.siteId,["owner","manager"],"manageExpenses"); const {data,error}=await supabaseAdmin().rpc("powerhub_update_company_account_sites",{p_tenant_id:access.tenantId,p_site_id:input.siteId,p_user_id:ctx.user.id,p_account_id:input.accountId,p_site_ids:input.siteIds}); if(error) throw new TRPCError({code:error.message.includes("OUT_OF_SCOPE")?"FORBIDDEN":error.message.includes("NOT_FOUND")?"NOT_FOUND":"BAD_REQUEST",message:error.message.includes("OUT_OF_SCOPE")?"أحد الفروع المحددة لا يتبع مساحة الشركة.":"تعذر تحديث الفروع المرتبطة بالحساب."}); if(!Number((data as Array<{account_id:number}>|null)?.[0]?.account_id)) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"لم تُعد دالة الحساب استجابة صالحة."}); return {success:true};
    }),
    addMovement: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), accountId: z.number().int().positive(), transactionType: z.enum(["deposit", "withdrawal"]), amount: z.number().positive(), description: z.string().trim().min(2).max(255), referenceNo: z.string().trim().max(120).optional(), clientOperationId: z.string().uuid().optional() })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "manageExpenses");
      const { data, error } = await supabaseAdmin().rpc("powerhub_add_account_movement", { p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id, p_account_id: input.accountId, p_transaction_type: input.transactionType, p_amount: input.amount, p_description: input.description, p_reference_no: input.referenceNo ?? null, p_client_operation_id: input.clientOperationId ?? null });
      if (!error && data?.[0]) return { id: Number((data[0] as { transaction_id: number | string }).transaction_id), replayed: Boolean((data[0] as { replayed?: boolean }).replayed) };
      const errorText = `${error?.code ?? ""} ${error?.message ?? ""}`;
      if (errorText.includes("ACCOUNT_NOT_FOUND")) throw new TRPCError({ code: "NOT_FOUND", message: "الحساب غير موجود ضمن مساحة الشركة." });
      if (errorText.includes("ACCOUNT_SITE_OUT_OF_SCOPE")) throw new TRPCError({ code: "FORBIDDEN", message: "الحساب غير مربوط بالفرع المحدد." });
      if (errorText.includes("INSUFFICIENT_ACCOUNT_BALANCE")) throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن سحب مبلغ أكبر من الرصيد المتاح في الحساب." });
      if (errorText.includes("FINANCIAL_PERIOD_LOCKED")) throw new TRPCError({ code: "FORBIDDEN", message: "الفترة المالية مقفلة؛ لا يمكن تعديل أو إضافة بيانات مالية داخلها." });
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تسجيل حركة الحساب في Supabase." });
    }),
    transfer: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), fromAccountId: z.number().int().positive(), toAccountId: z.number().int().positive(), amount: z.number().positive(), description: z.string().trim().min(2).max(255), clientOperationId: z.string().uuid().optional() })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "manageExpenses");
      const { data, error } = await supabaseAdmin().rpc("powerhub_transfer_company_accounts", { p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id, p_from_account_id: input.fromAccountId, p_to_account_id: input.toAccountId, p_amount: input.amount, p_description: input.description, p_client_operation_id: input.clientOperationId ?? null });
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
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "viewAudit");
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
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager"], "manageTeam");
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
    createEmployee: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), fullName: z.string().trim().min(2).max(180), identityNo: z.string().trim().max(80).optional(), phone: z.string().trim().max(40).optional(), jobTitle: z.enum(["accountant", "collector", "technician", "worker", "supervisor", "other"]), employmentStatus: z.enum(["active", "suspended", "ended"]).default("active"), contractType: z.enum(["daily", "monthly", "collection_percentage"]), baseWage: z.number().min(0).max(100000000), hireDate: z.string().optional(), notes: z.string().trim().max(2000).optional(), linkedUserId: z.number().int().positive().optional(), clientOperationId: z.string().uuid() })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner"], "manageTeam");
      const hireDate = input.hireDate ? new Date(input.hireDate) : null;
      if (input.hireDate && Number.isNaN(hireDate?.getTime())) throw new TRPCError({ code: "BAD_REQUEST", message: "تاريخ التعيين غير صحيح." });
      const { data, error } = await supabaseAdmin().rpc("powerhub_create_employee_online", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id, p_full_name: input.fullName,
        p_identity_no: input.identityNo ?? null, p_phone: input.phone ?? null, p_job_title: input.jobTitle,
        p_employment_status: input.employmentStatus, p_contract_type: input.contractType, p_base_wage: input.baseWage,
        p_hire_date: input.hireDate ?? null, p_notes: input.notes ?? null, p_linked_user_id: input.linkedUserId ?? null,
        p_client_operation_id: input.clientOperationId,
      });
      const result = (data as Array<{ employee_id: number | string; replayed?: boolean }> | null)?.[0];
      if (!error && result?.employee_id) return { id: Number(result.employee_id), replayed: Boolean(result.replayed) };
      const errorText = String(error?.code ?? "") + " " + String(error?.message ?? "");
      if (errorText.includes("SITE_OUT_OF_SCOPE")) throw new TRPCError({ code: "FORBIDDEN", message: "الفرع غير تابع لمساحة الشركة." });
      if (errorText.includes("LINKED_USER_OUT_OF_SCOPE")) throw new TRPCError({ code: "FORBIDDEN", message: "حساب الدخول المحدد ليس ضمن مساحة الشركة." });
      if (errorText.includes("INVALID_EMPLOYEE_INPUT")) throw new TRPCError({ code: "BAD_REQUEST", message: "بيانات الموظف غير صحيحة." });
      if (errorText.includes("EMPLOYEE_OPERATION_CONFLICT")) throw new TRPCError({ code: "CONFLICT", message: "معرّف العملية مستخدم لبيانات موظف مختلفة." });
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
      const { data, error } = await supabaseAdmin().rpc("powerhub_create_employee_adjustment", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id, p_employee_id: input.employeeId,
        p_adjustment_type: input.adjustmentType, p_amount: input.amount, p_reason: input.reason,
      });
      const result = (data as Array<{ adjustment_id: number | string }> | null)?.[0];
      if (!error && result?.adjustment_id) return { id: Number(result.adjustment_id) };
      const errorText = `${error?.code ?? ""} ${error?.message ?? ""}`;
      if (errorText.includes("EMPLOYEE_OUT_OF_SCOPE")) throw new TRPCError({ code: "NOT_FOUND", message: "الموظف غير موجود ضمن نطاقك." });
      if (errorText.includes("INVALID_EMPLOYEE_ADJUSTMENT_INPUT")) throw new TRPCError({ code: "BAD_REQUEST", message: "بيانات السلفة أو الخصم غير صحيحة." });
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر حفظ السلفة أو الخصم في Supabase." });
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
      if (errorText.includes("DUPLICATE_PAYROLL_EMPLOYEE") || errorText.includes("INVALID_PAYROLL_DRAFT_INPUT")) throw new TRPCError({ code: "BAD_REQUEST", message: "بيانات مسودة الرواتب غير صحيحة." });
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر إنشاء مسودة الرواتب في Supabase." });
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
    summary: protectedProcedure.input(siteScoped.extend({ from: z.string().datetime().optional(), to: z.string().datetime().optional() })).query(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "viewer"], "viewAudit");
      const from = input.from ? new Date(input.from) : new Date(Date.now() - 24 * 60 * 60 * 1000);
      const to = input.to ? new Date(input.to) : new Date();
      const { data, error } = await supabaseAdmin().from("mobile_sync_events")
        .select("user_id, status, synced_count, retryable_count, needs_review_count, occurred_at")
        .eq("tenant_id", access.tenantId).eq("site_id", input.siteId)
        .gte("occurred_at", from.toISOString()).lte("occurred_at", to.toISOString());
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
        .eq("entity_type", "meter_reading").eq("action", "mobile_create");
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
        .eq("entity_type", "meter_reading").eq("action", "mobile_create").eq("entity_id", String(input.readingId)).maybeSingle();
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
    approveAndIssue: protectedProcedure.input(mobileSyncApproveInput).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "approveReadings");
      await requireSupabaseSiteRole(ctx.user.id, input.siteId, createRoles, "issueInvoices");
      const admin = supabaseAdmin();
      const { data: reading, error: readingError } = await admin.from("meter_readings")
        .select("id,version_no,reading_at").eq("id", input.readingId).eq("tenant_id", access.tenantId).eq("site_id", input.siteId).maybeSingle();
      if (readingError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل القراءة الميدانية من Supabase." });
      if (!reading) throw new TRPCError({ code: "NOT_FOUND", message: "القراءة الميدانية غير موجودة ضمن الفرع المحدد." });

      const readingAt = new Date(reading.reading_at);
      const dueDate = new Date(readingAt);
      dueDate.setDate(dueDate.getDate() + 14);
      const { data, error } = await admin.rpc("powerhub_approve_and_issue_mobile_reading", {
        p_tenant_id: access.tenantId,
        p_site_id: input.siteId,
        p_user_id: ctx.user.id,
        p_reading_id: input.readingId,
        p_base_version: input.baseVersion,
        p_due_date: dueDate.toISOString(),
        p_billing_period: readingAt.toISOString().slice(0, 7),
        p_discount_amount: 0,
      });
      const row = (data as Array<{ invoice_id: number | string; invoice_no: string; total_amount: number | string; notification_ids?: unknown; already_processed?: boolean }> | null)?.[0];
      if (!error && row) {
        const notificationIds = Array.isArray(row.notification_ids) ? row.notification_ids.map(Number).filter(Number.isInteger) : [];
        let delivery = { requested: 0, submitted: 0, failed: 0, skipped: 0 };
        if (input.sendNow && notificationIds.length) {
          const { data: smsRows, error: smsError } = await admin.from("notification_messages").select("id").eq("tenant_id", access.tenantId).eq("channel", "sms").in("id", notificationIds);
          if (smsError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تم إصدار الفاتورة لكن تعذر تحديد رسائل SMS للإرسال." });
          delivery = await processNotificationQueueForTenant(access.tenantId, ctx.user.id, (smsRows ?? []).map((item) => Number(item.id)).filter(Number.isInteger));
        }
        return {
          success: true as const,
          alreadyProcessed: Boolean(row.already_processed),
          invoiceId: Number(row.invoice_id),
          invoiceNo: row.invoice_no,
          totalAmount: Number(row.total_amount),
          notificationIds,
          delivery,
        };
      }
      const errorText = `${error?.code ?? ""} ${error?.message ?? ""}`;
      if (errorText.includes("READING_OUT_OF_SCOPE")) throw new TRPCError({ code: "NOT_FOUND", message: "القراءة لا تتبع للفرع المحدد." });
      if (errorText.includes("SITE_OUT_OF_SCOPE")) throw new TRPCError({ code: "NOT_FOUND", message: "الفرع لا يتبع لمساحة صاحب المولد." });
      if (errorText.includes("READING_NOT_PENDING")) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "القراءة ليست بانتظار المراجعة أو تم اعتمادها مسبقاً." });
      if (errorText.includes("READING_VERSION_CONFLICT")) throw new TRPCError({ code: "CONFLICT", message: "تغيرت القراءة قبل الاعتماد؛ حدّث البيانات ثم أعد المحاولة." });
      if (errorText.includes("TARIFF_NOT_FOUND")) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "لا توجد تعرفة فعالة لهذا الفرع؛ أضف تعرفة فعالة قبل إصدار الفاتورة." });
      if (errorText.includes("INVALID_BILLING_PERIOD") || errorText.includes("INVALID_DISCOUNT")) throw new TRPCError({ code: "BAD_REQUEST", message: "بيانات فترة الفوترة غير صالحة." });
      if (error?.code === "23505") throw new TRPCError({ code: "CONFLICT", message: "تعذر تثبيت رقم فاتورة فريد؛ أعد المحاولة." });
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر اعتماد القراءة وإصدار الفاتورة في Supabase." });
    }),
    approveAllAndIssue: protectedProcedure.input(mobileSyncBulkApprovalInput).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "approveReadings");
      await requireSupabaseSiteRole(ctx.user.id, input.siteId, createRoles, "issueInvoices");
      const admin = supabaseAdmin();
      let query = admin.from("meter_readings").select("id,version_no,reading_at")
        .eq("tenant_id", access.tenantId).eq("site_id", input.siteId).eq("status", "pending_review")
        .order("reading_at", { ascending: true }).limit(input.limit);
      if (input.from) query = query.gte("reading_at", input.from);
      if (input.to) query = query.lte("reading_at", input.to);
      const { data: rows, error: rowsError } = await query;
      if (rowsError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل القراءات الميدانية المعلقة من Supabase." });

      const results: Array<Record<string, unknown>> = [];
      const smsNotificationIds: number[] = [];
      for (const reading of rows ?? []) {
        const readingAt = new Date(reading.reading_at);
        const dueDate = new Date(readingAt);
        dueDate.setDate(dueDate.getDate() + 14);
        const { data, error } = await admin.rpc("powerhub_approve_and_issue_mobile_reading", {
          p_tenant_id: access.tenantId,
          p_site_id: input.siteId,
          p_user_id: ctx.user.id,
          p_reading_id: Number(reading.id),
          p_base_version: Number(reading.version_no),
          p_due_date: dueDate.toISOString(),
          p_billing_period: readingAt.toISOString().slice(0, 7),
          p_discount_amount: 0,
        });
        const row = (data as Array<{ invoice_id: number | string; invoice_no: string; total_amount: number | string; notification_ids?: unknown; already_processed?: boolean }> | null)?.[0];
        if (error || !row) {
          results.push({ readingId: Number(reading.id), success: false, error: error?.message ?? "تعذر اعتماد القراءة وإصدار الفاتورة." });
          continue;
        }
        const ids = Array.isArray(row.notification_ids) ? row.notification_ids.map(Number).filter(Number.isInteger) : [];
        smsNotificationIds.push(...ids);
        results.push({ readingId: Number(reading.id), success: true, invoiceId: Number(row.invoice_id), invoiceNo: row.invoice_no, alreadyProcessed: Boolean(row.already_processed), notificationIds: ids });
      }

      let delivery = { requested: 0, submitted: 0, failed: 0, skipped: 0 };
      if (input.sendNow && smsNotificationIds.length) {
        const { data: smsRows, error: smsError } = await admin.from("notification_messages").select("id").eq("tenant_id", access.tenantId).eq("channel", "sms").in("id", Array.from(new Set(smsNotificationIds)));
        if (smsError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تم اعتماد بعض القراءات لكن تعذر تجهيز رسائل SMS للإرسال." });
        delivery = await processNotificationQueueForTenant(access.tenantId, ctx.user.id, (smsRows ?? []).map((item) => Number(item.id)).filter(Number.isInteger));
      }
      return {
        requested: (rows ?? []).length,
        approved: results.filter((item) => item.success).length,
        failed: results.filter((item) => !item.success).length,
        results,
        delivery,
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
