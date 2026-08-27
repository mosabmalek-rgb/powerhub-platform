import crypto from "node:crypto";
import { TRPCError } from "@trpc/server";
import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, gte, inArray, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  auditLogs,
  companyAccounts,
  companyAccountSites,
  accountTransactions,
  financialSettlements,
  collectorSessions,
  customPermissionRoles,
  expenses,
  employees,
  employeeAttendance,
  employeeAdjustments,
  payrollRuns,
  payrollItems,
  invoiceLines,
  generators,
  invoiceShareLinks,
  invoices,
  meterReadings,
  mobileSyncEvents,
  notificationMessages,
  offlineSyncOperations,
  messagingScheduleRuns,
  platformSmsPlans,
  smsPackageRequests,
  payments,
  platformRolePolicies,
  platformSettings,
  sitePortalSettings,
  sites,
  staffProfiles,
  subscribers,
  subscriptionUpgradeRequests,
  tariffs,
  tenantMembers,
  tenantInvoiceMessageTemplates,
  tenantMessagingConfigurations,
  tenantTweetSmsAccounts,
  tenantOwnerProfiles,
  tenantSubscriptions,
  tenantPaymentReceiptMessageTemplates,
  tenantBranchSettings,
  tenants,
  userQuickActionPreferences,
  users,
} from "../drizzle/schema";
import { getDb, syncSupabaseUser } from "./db";
import { supabaseAdmin } from "./supabase-admin";
import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
import { calculateCompanyAccountBalance } from "./company-account-utils";
import { calculateInvoiceAmounts, generateInvoiceShareToken, hashInvoiceShareToken, nextInvoiceNo } from "./powerhub-utils";
import { buildFinancialOverview } from "./financial-overview-utils";
import { invoiceDeliveryPolicyFromSetting, isInvoiceDeliveryChannelEnabled, resolveInvoiceNotificationChannels } from "./notification-channels";
import { defaultInvoiceMessageTemplates, renderInvoiceMessageTemplate } from "./invoice-message-template";
import { probeMessagingConnection } from "./messaging-connection";
import { defaultPaymentReceiptSmsTemplate, renderPaymentReceiptMessage, renderPaymentReceiptTemplate, paymentReceiptTemplateParameters } from "./payment-receipt-message";
import { normalizeInternationalPhone } from "../shared/phone";
import { processNotificationById } from "./notification-worker";
import { storageGet, storagePut } from "./storage";
import { encryptTenantCredential, hashWebhookVerifyToken } from "./tenant-crypto";
import { rolesWith, type PowerCapability, type PowerRole } from "../shared/powerhub-rbac";
import { COOKIE_NAME } from "../shared/const";
import { getSupabaseDashboardSummary, getSupabaseFinancialOverview, getSupabaseOwnerSubscriberQuota, getSupabaseSite, listSupabaseAccessibleSites, listSupabaseCompanyAccounts, listSupabaseExpenses, listSupabaseGenerators, listSupabaseInvoices, listSupabasePayments, listSupabaseReadings, listSupabaseSubscribers, listSupabaseTariffs, recordSupabaseSubscriberQuotaAlert, requireSupabaseAllBranchesRole, requireSupabaseSiteRole, resolveSupabaseSiteAccess, writeSupabaseAudit } from "./powerhub-supabase";

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

async function dbOrThrow() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة حالياً." });
  return db;
}

function insertId(result: unknown) {
  const header = Array.isArray(result) ? result[0] : result;
  const value = (header as { insertId?: number | bigint })?.insertId;
  if (value === undefined) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر إنشاء السجل." });
  return Number(value);
}

async function getSiteTenant(siteId: number) {
  const db = await dbOrThrow();
  const [site] = await db.select({ id: sites.id, tenantId: sites.tenantId }).from(sites).where(eq(sites.id, siteId)).limit(1);
  if (!site) throw new TRPCError({ code: "NOT_FOUND", message: "المحطة غير موجودة." });
  return site.tenantId;
}

type InvoiceIssueResult = { id: number; invoiceNo: string; totalAmount: number; notificationIds: number[]; alreadyIssued: boolean };

async function issueInvoiceForApprovedReading(db: any, input: { siteId: number; readingId: number; userId: number; billingPeriod: string; dueDate: Date; tariffId?: number; discountAmount?: number }): Promise<InvoiceIssueResult> {
  const [readingScope] = await db.select({ reading: meterReadings, subscriber: subscribers, site: sites })
    .from(meterReadings).innerJoin(subscribers, eq(meterReadings.subscriberId, subscribers.id)).innerJoin(sites, eq(sites.id, subscribers.siteId))
    .where(and(eq(meterReadings.id, input.readingId), eq(subscribers.siteId, input.siteId))).limit(1);
  const reading = readingScope?.reading; const subscriber = readingScope?.subscriber; const site = readingScope?.site;
  if (!reading || reading.status !== "approved" || !subscriber || !site) throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن فوترة قراءة غير معتمدة أو لا تتبع للمحطة المحددة." });
  const [existing] = await db.select({ id: invoices.id, invoiceNo: invoices.invoiceNo, totalAmount: invoices.totalAmount }).from(invoices).where(eq(invoices.readingId, reading.id)).limit(1);
  if (existing) return { id: existing.id, invoiceNo: existing.invoiceNo, totalAmount: Number(existing.totalAmount), notificationIds: [], alreadyIssued: true };
  const tariffConditions = [eq(tariffs.siteId, input.siteId), eq(tariffs.isActive, true)];
  if (input.tariffId) tariffConditions.push(eq(tariffs.id, input.tariffId));
  const [tariff] = await db.select().from(tariffs).where(and(...tariffConditions)).orderBy(desc(tariffs.effectiveFrom)).limit(1);
  if (!tariff) throw new TRPCError({ code: "NOT_FOUND", message: "لا توجد تعرفة فعالة يمكن استخدامها لإصدار الفاتورة." });
  await assertFinancialPeriodOpen(db, site.tenantId, input.siteId, input.dueDate, input.userId, "invoice");
  const [tenantMessaging, platformDeliverySettings, tenantTemplates] = await Promise.all([
    db.select({ channel: tenantMessagingConfigurations.channel, isActive: tenantMessagingConfigurations.isActive }).from(tenantMessagingConfigurations).where(eq(tenantMessagingConfigurations.tenantId, site.tenantId)),
    db.select({ isEnabled: platformSettings.isEnabled, value: platformSettings.value }).from(platformSettings).where(eq(platformSettings.settingKey, "invoice_delivery_channels")).limit(1),
    db.select({ channel: tenantInvoiceMessageTemplates.channel, body: tenantInvoiceMessageTemplates.body, isActive: tenantInvoiceMessageTemplates.isActive }).from(tenantInvoiceMessageTemplates).where(and(eq(tenantInvoiceMessageTemplates.tenantId, site.tenantId), eq(tenantInvoiceMessageTemplates.eventType, "invoice_issued"))),
  ]);
  const tenantChannels = resolveInvoiceNotificationChannels(tenantMessaging, invoiceDeliveryPolicyFromSetting(platformDeliverySettings[0]));
  const templateByChannel = new Map<"sms" | "whatsapp", string>(tenantTemplates.filter((template: { isActive: boolean }) => template.isActive).map((template: { channel: "sms" | "whatsapp"; body: string }) => [template.channel, template.body] as ["sms" | "whatsapp", string]));
  const countResult = await db.select({ count: sql<number>`count(*)` }).from(invoices).where(eq(invoices.siteId, input.siteId));
  const calculated = calculateInvoiceAmounts({ consumptionKwh: Number(reading.consumptionKwh ?? 0), pricePerKwh: Number(tariff.pricePerKwh), fixedFee: Number(tariff.fixedFee), taxRate: Number(tariff.taxRate), discountAmount: input.discountAmount ?? 0 });
  const invoiceNo = nextInvoiceNo(site.code, input.billingPeriod, Number(countResult[0]?.count ?? 0) + 1);
  const invoiceId = insertId(await db.insert(invoices).values({ tenantId: site.tenantId, siteId: input.siteId, subscriberId: subscriber.id, readingId: reading.id, tariffId: tariff.id, invoiceNo, billingPeriod: input.billingPeriod, dueDate: input.dueDate, previousReading: reading.previousReadingValue, currentReading: reading.readingValue, consumptionKwh: reading.consumptionKwh ?? "0", pricePerKwh: tariff.pricePerKwh, fixedFee: tariff.fixedFee, taxAmount: String(calculated.taxAmount), discountAmount: String(input.discountAmount ?? 0), totalAmount: String(calculated.totalAmount), balanceDue: String(calculated.totalAmount), status: "issued", createdByUserId: input.userId }));
  const lines: Array<{ lineType: "energy" | "fixed_fee" | "tax" | "discount"; description: string; quantity: string; unitPrice: string; amount: string; displayOrder: number }> = [
    { lineType: "energy", description: "استهلاك الكهرباء", quantity: String(reading.consumptionKwh ?? 0), unitPrice: tariff.pricePerKwh, amount: String(calculated.energyAmount), displayOrder: 1 },
    { lineType: "fixed_fee", description: "رسم ثابت", quantity: "1", unitPrice: tariff.fixedFee, amount: tariff.fixedFee, displayOrder: 2 },
    { lineType: "tax", description: "الضريبة", quantity: "1", unitPrice: String(tariff.taxRate), amount: String(calculated.taxAmount), displayOrder: 3 },
  ];
  if ((input.discountAmount ?? 0) > 0) lines.push({ lineType: "discount", description: "خصم", quantity: "1", unitPrice: String(input.discountAmount), amount: String(input.discountAmount), displayOrder: 4 });
  await db.insert(invoiceLines).values(lines.map((line) => ({ ...line, tenantId: site.tenantId, invoiceId })));
  const notificationIds: number[] = [];
  for (const channel of tenantChannels as Array<"sms" | "whatsapp">) notificationIds.push(insertId(await db.insert(notificationMessages).values({ tenantId: site.tenantId, invoiceId, subscriberId: subscriber.id, channel, eventType: "invoice_issued", recipient: subscriber.phone, status: "pending", payload: { invoiceNo, billingPeriod: input.billingPeriod, totalAmount: calculated.totalAmount, renderedText: renderInvoiceMessageTemplate(templateByChannel.get(channel) ?? defaultInvoiceMessageTemplates[channel], { subscriber_name: subscriber.fullName, invoice_no: invoiceNo, billing_period: input.billingPeriod, total_amount: String(calculated.totalAmount), due_date: input.dueDate.toLocaleDateString("ar-IQ") }) } })));
  return { id: invoiceId, invoiceNo, totalAmount: calculated.totalAmount, notificationIds, alreadyIssued: false };
}

async function dispatchInvoiceNotifications(notificationIds: number[]) {
  return Promise.all(notificationIds.map(async (notificationId) => {
    try { return { notificationId, ...await processNotificationById(notificationId) }; }
    catch (error) { return { notificationId, status: "failed" as const, error: error instanceof Error ? error.message : "تعذر بدء إرسال الفاتورة." }; }
  }));
}

async function queueInvoiceNotificationsForSelection(db: any, input: { siteId: number; invoiceIds: number[] }) {
  const [site] = await db.select({ id: sites.id, tenantId: sites.tenantId }).from(sites).where(eq(sites.id, input.siteId)).limit(1);
  if (!site) throw new TRPCError({ code: "NOT_FOUND", message: "المحطة غير موجودة." });
  const [[platformDeliverySetting], tenantMessaging, tenantTemplates] = await Promise.all([
    db.select({ isEnabled: platformSettings.isEnabled, value: platformSettings.value }).from(platformSettings).where(eq(platformSettings.settingKey, "invoice_delivery_channels")).limit(1),
    db.select({ channel: tenantMessagingConfigurations.channel, isActive: tenantMessagingConfigurations.isActive }).from(tenantMessagingConfigurations).where(eq(tenantMessagingConfigurations.tenantId, site.tenantId)),
    db.select({ channel: tenantInvoiceMessageTemplates.channel, body: tenantInvoiceMessageTemplates.body, isActive: tenantInvoiceMessageTemplates.isActive }).from(tenantInvoiceMessageTemplates).where(and(eq(tenantInvoiceMessageTemplates.tenantId, site.tenantId), eq(tenantInvoiceMessageTemplates.eventType, "invoice_issued"))),
  ]);
  const channels = resolveInvoiceNotificationChannels(tenantMessaging, invoiceDeliveryPolicyFromSetting(platformDeliverySetting));
  const templates = new Map<"sms" | "whatsapp", string>(tenantTemplates.filter((template: { isActive: boolean }) => template.isActive).map((template: { channel: "sms" | "whatsapp"; body: string }) => [template.channel, template.body] as ["sms" | "whatsapp", string]));
  const rows = await db.select({ invoice: invoices, subscriber: subscribers }).from(invoices).innerJoin(subscribers, eq(invoices.subscriberId, subscribers.id))
    .where(and(eq(invoices.siteId, input.siteId), inArray(invoices.id, input.invoiceIds))).limit(input.invoiceIds.length);
  const queued: Array<{ notificationId: number; invoiceId: number; invoiceNo: string }> = [];
  for (const { invoice, subscriber } of rows) {
    if (["draft", "cancelled"].includes(invoice.status)) continue;
    for (const channel of channels as Array<"sms" | "whatsapp">) {
      const payload = { invoiceNo: invoice.invoiceNo, billingPeriod: invoice.billingPeriod, totalAmount: invoice.totalAmount, renderedText: renderInvoiceMessageTemplate(templates.get(channel) ?? defaultInvoiceMessageTemplates[channel], { subscriber_name: subscriber.fullName, invoice_no: invoice.invoiceNo, billing_period: invoice.billingPeriod, total_amount: String(invoice.totalAmount), due_date: new Date(invoice.dueDate).toLocaleDateString("ar-IQ") }) };
      const [existing] = await db.select({ id: notificationMessages.id, status: notificationMessages.status }).from(notificationMessages).where(and(eq(notificationMessages.invoiceId, invoice.id), eq(notificationMessages.channel, channel), eq(notificationMessages.eventType, "invoice_issued"))).orderBy(desc(notificationMessages.createdAt)).limit(1);
      if (existing && ["sent", "delivered", "read"].includes(existing.status)) continue;
      const notificationId = existing?.id ?? insertId(await db.insert(notificationMessages).values({ tenantId: site.tenantId, invoiceId: invoice.id, subscriberId: subscriber.id, channel, eventType: "invoice_issued", recipient: subscriber.phone, status: "pending", payload }));
      if (existing) await db.update(notificationMessages).set({ status: "pending", lastError: null, recipient: subscriber.phone, payload }).where(eq(notificationMessages.id, notificationId));
      queued.push({ notificationId, invoiceId: invoice.id, invoiceNo: invoice.invoiceNo });
    }
  }
  return queued;
}

async function approveAndIssueMobileReading(input: { siteId: number; readingId: number; userId: number; baseVersion?: number; sendNow?: boolean }) {
  const tenantId = await getSiteTenant(input.siteId);
  const db = await dbOrThrow();
  const result = await db.transaction(async (tx) => {
    const [scope] = await tx.select({ id: meterReadings.id, status: meterReadings.status, versionNo: meterReadings.versionNo, readingAt: meterReadings.readingAt, invoiceDueDays: sites.invoiceDueDays, invoiceId: invoices.id, invoiceNo: invoices.invoiceNo, invoiceTotal: invoices.totalAmount })
      .from(meterReadings).innerJoin(subscribers, eq(meterReadings.subscriberId, subscribers.id)).innerJoin(sites, eq(sites.id, subscribers.siteId))
      .innerJoin(auditLogs, and(eq(auditLogs.tenantId, tenantId), eq(auditLogs.siteId, input.siteId), eq(auditLogs.entityType, "meter_reading"), eq(auditLogs.action, "mobile_create"), sql`${auditLogs.entityId} = CAST(${meterReadings.id} AS CHAR)`))
      .leftJoin(invoices, eq(invoices.readingId, meterReadings.id))
      .where(and(eq(meterReadings.id, input.readingId), eq(meterReadings.tenantId, tenantId), eq(subscribers.siteId, input.siteId))).limit(1);
    if (!scope) throw new TRPCError({ code: "NOT_FOUND", message: "القراءة الميدانية غير موجودة ضمن الفرع المحدد." });
    if (scope.status === "approved" && scope.invoiceId) return { invoice: { id: scope.invoiceId, invoiceNo: scope.invoiceNo!, totalAmount: Number(scope.invoiceTotal) }, notificationIds: [] as number[], alreadyProcessed: true };
    if (scope.status !== "pending_review") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "يمكن اعتماد القراءات الميدانية بانتظار المراجعة فقط." });
    if (input.baseVersion !== undefined && scope.versionNo !== input.baseVersion) throw new TRPCError({ code: "CONFLICT", message: "تم تعديل القراءة من جهة أخرى؛ حدّث الصفحة ثم أعد المحاولة." });
    const approval = await tx.update(meterReadings).set({ status: "approved", reviewedByUserId: input.userId, reviewedAt: new Date(), versionNo: sql`${meterReadings.versionNo} + 1` }).where(and(eq(meterReadings.id, input.readingId), eq(meterReadings.status, "pending_review"), eq(meterReadings.versionNo, scope.versionNo)));
    if (Number((approval[0] as { affectedRows?: number }).affectedRows ?? 0) !== 1) throw new TRPCError({ code: "CONFLICT", message: "تم تعديل القراءة من جهة أخرى؛ حدّث البيانات ثم أعد المحاولة." });
    const dueDate = new Date(); dueDate.setDate(dueDate.getDate() + Math.max(1, Math.min(90, scope.invoiceDueDays ?? 14)));
    const issued = await issueInvoiceForApprovedReading(tx as any, { siteId: input.siteId, readingId: input.readingId, userId: input.userId, billingPeriod: scope.readingAt.toISOString().slice(0, 7), dueDate });
    return { invoice: { id: issued.id, invoiceNo: issued.invoiceNo, totalAmount: issued.totalAmount }, notificationIds: issued.notificationIds, alreadyProcessed: issued.alreadyIssued };
  });
  const deliveries = input.sendNow === false ? [] : await dispatchInvoiceNotifications(result.notificationIds);
  const notificationMode = input.sendNow === false ? "deferred" : "immediate";
  await writeAudit({ userId: input.userId, siteId: input.siteId, entityType: "meter_reading", entityId: String(input.readingId), action: result.alreadyProcessed ? "mobile_approve_replay" : "mobile_approve_and_issue", metadata: { invoiceId: result.invoice.id, invoiceNo: result.invoice.invoiceNo, automaticInvoice: true, notificationMode, deliveryCount: deliveries.length } });
  await writeAudit({ userId: input.userId, siteId: input.siteId, entityType: "invoice", entityId: String(result.invoice.id), action: result.alreadyProcessed ? "auto_issue_replay" : "auto_issue_after_mobile_approval", metadata: { readingId: input.readingId, notificationMode, deliveryCount: deliveries.length } });
  return { ...result.invoice, alreadyProcessed: result.alreadyProcessed, notificationMode, deliveries };
}

async function ownerLimitOverride(tenantId: number) {
  const db = await dbOrThrow();
  const [setting] = await db.select({ value: platformSettings.value }).from(platformSettings).where(eq(platformSettings.settingKey, "owner_limit_overrides")).limit(1);
  const value = setting?.value && typeof setting.value === "object" && !Array.isArray(setting.value) ? setting.value as Record<string, unknown> : {};
  const overrides = value.overrides && typeof value.overrides === "object" && !Array.isArray(value.overrides) ? value.overrides as Record<string, unknown> : {};
  const override = overrides[String(tenantId)] && typeof overrides[String(tenantId)] === "object" && !Array.isArray(overrides[String(tenantId)]) ? overrides[String(tenantId)] as Record<string, unknown> : {};
  return {
    subaccountLimit: typeof override.subaccountLimit === "number" && override.subaccountLimit >= 0 ? override.subaccountLimit : undefined,
    subscriberLimit: typeof override.subscriberLimit === "number" && override.subscriberLimit >= 0 ? override.subscriberLimit : undefined,
    allowedRoles: Array.isArray(override.allowedRoles) ? override.allowedRoles.filter((role): role is string => typeof role === "string") : undefined,
  };
}

async function ownerAllowedSubaccountRoles(tenantId?: number) {
  const db = await dbOrThrow();
  const [setting] = await db.select({ isEnabled: platformSettings.isEnabled, value: platformSettings.value })
    .from(platformSettings).where(eq(platformSettings.settingKey, "owner_subaccount_roles")).limit(1);
  const globalRoles = allowedOwnerSubaccountRoles(setting);
  if (!tenantId) return globalRoles;
  const override = await ownerLimitOverride(tenantId);
  return override.allowedRoles ? globalRoles.filter((role) => override.allowedRoles!.includes(role)) : globalRoles;
}

async function ownerSubaccountLimit(tenantId: number) {
  const db = await dbOrThrow();
  const [[tenant], [setting], override] = await Promise.all([
    db.select({ plan: tenants.plan }).from(tenants).where(eq(tenants.id, tenantId)).limit(1),
    db.select({ value: platformSettings.value }).from(platformSettings).where(eq(platformSettings.settingKey, "owner_subaccount_limits")).limit(1),
    ownerLimitOverride(tenantId),
  ]);
  if (!tenant) throw new TRPCError({ code: "NOT_FOUND", message: "مساحة صاحب المولد غير موجودة." });
  return override.subaccountLimit ?? ownerSubaccountLimitForPlan(tenant.plan, setting);
}

async function activeSubaccountCount(tenantId: number) {
  const db = await dbOrThrow();
  const [result] = await db.select({ count: sql<number>`count(*)` }).from(tenantMembers)
    .where(and(eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.role, "member"), eq(tenantMembers.isActive, true), eq(tenantMembers.membershipStatus, "active")));
  return Number(result?.count ?? 0);
}

async function ownerSubscriberQuota(tenantId: number) {
  const db = await dbOrThrow();
  const [[tenant], [setting], [countResult], override] = await Promise.all([
    db.select({ plan: tenants.plan }).from(tenants).where(eq(tenants.id, tenantId)).limit(1),
    db.select({ value: platformSettings.value }).from(platformSettings).where(eq(platformSettings.settingKey, "owner_subscriber_limits")).limit(1),
    db.select({ count: sql<number>`count(*)` }).from(subscribers).where(eq(subscribers.tenantId, tenantId)),
    ownerLimitOverride(tenantId),
  ]);
  if (!tenant) throw new TRPCError({ code: "NOT_FOUND", message: "مساحة صاحب المولد غير موجودة." });
  const limit = override.subscriberLimit ?? ownerSubscriberLimitForPlan(tenant.plan, setting);
  const currentCount = Number(countResult?.count ?? 0);
  return { limit, currentCount, remaining: Math.max(0, limit - currentCount), plan: tenant.plan };
}

async function recordSubscriberQuotaAlert({ tenantId, siteId, userId, quota }: { tenantId: number; siteId: number; userId: number; quota: { limit: number; currentCount: number; remaining: number; plan: string } }) {
  if (!Number.isFinite(quota.limit) || quota.limit <= 0 || quota.currentCount <= 0) return;
  const percentage = Math.min(100, Math.round((quota.currentCount / quota.limit) * 100));
  const threshold = percentage >= 100 ? 100 : percentage >= 80 ? 80 : 0;
  if (!threshold) return;
  const db = await dbOrThrow();
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const action = `subscriber_quota_alert_${threshold}`;
  const [existing] = await db.select({ id: auditLogs.id }).from(auditLogs).where(and(eq(auditLogs.tenantId, tenantId), eq(auditLogs.action, action), gte(auditLogs.createdAt, monthStart))).limit(1);
  if (!existing) await writeAudit({ userId, siteId, entityType: "owner_quota_alert", entityId: String(tenantId), action, metadata: { threshold, percentage, current: quota.currentCount, limit: quota.limit, remaining: quota.remaining, plan: quota.plan, automatic: true } });
}

async function tenantBranchPolicy(tenantId: number) {
  const db = await dbOrThrow();
  const [[tenant], [platformSetting], [tenantSetting], [countResult]] = await Promise.all([
    db.select({ plan: tenants.plan }).from(tenants).where(eq(tenants.id, tenantId)).limit(1),
    db.select({ isEnabled: platformSettings.isEnabled, value: platformSettings.value }).from(platformSettings).where(eq(platformSettings.settingKey, "branch_feature")).limit(1),
    db.select({ isEnabledOverride: tenantBranchSettings.isEnabledOverride, maxBranchesOverride: tenantBranchSettings.maxBranchesOverride, disabledBehavior: tenantBranchSettings.disabledBehavior }).from(tenantBranchSettings).where(eq(tenantBranchSettings.tenantId, tenantId)).limit(1),
    db.select({ count: sql<number>`count(*)` }).from(sites).where(and(eq(sites.tenantId, tenantId), ne(sites.status, "archived"))),
  ]);
  if (!tenant) throw new TRPCError({ code: "NOT_FOUND", message: "مساحة صاحب المولد غير موجودة." });
  return resolveBranchPolicy({ plan: tenant.plan, platformSetting, tenantSetting, currentCount: Number(countResult?.count ?? 0) });
}

export function isStaffSuspended(now: Date, startsAt: Date | null, endsAt: Date | null) {
  return Boolean(startsAt && endsAt && now >= startsAt && now < endsAt);
}

async function resolveRole(userId: number, siteId: number): Promise<PowerRole> {
  return (await resolveAccess(userId, siteId)).role;
}
async function resolveAccess(userId: number, siteId: number): Promise<{ role: PowerRole; permissions: PowerCapability[] }> {
  const db = await dbOrThrow();
  const [user] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1);
  if (user?.role === "admin") return { role: "owner", permissions: ["manageSubscribers", "manageGenerators", "recordReadings", "accessFieldApp", "approveReadings", "manageTariffs", "issueInvoices", "collectPayments", "manageExpenses", "managePayroll", "manageTeam", "manageMessaging", "viewAudit"] };

  const tenantId = await getSiteTenant(siteId);
  if (tenantId) {
    const [member] = await db.select({ role: tenantMembers.role }).from(tenantMembers)
      .where(and(eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.userId, userId), eq(tenantMembers.isActive, true), eq(tenantMembers.membershipStatus, "active"))).limit(1);
    if (!member) throw new TRPCError({ code: "FORBIDDEN", message: "لا توجد عضوية فعالة في مساحة صاحب المولد لهذه المحطة." });
    if (member.role === "owner") return { role: "owner", permissions: ["manageSubscribers", "manageGenerators", "recordReadings", "accessFieldApp", "approveReadings", "manageTariffs", "issueInvoices", "collectPayments", "manageExpenses", "managePayroll", "manageTeam", "manageMessaging", "viewAudit"] };
  }

  const [profile] = await db
    .select({ role: staffProfiles.role, permissions: staffProfiles.permissions, customRoleId: staffProfiles.customRoleId, suspensionStartedAt: staffProfiles.suspensionStartedAt, suspensionEndsAt: staffProfiles.suspensionEndsAt })
    .from(staffProfiles)
    .where(and(eq(staffProfiles.userId, userId), eq(staffProfiles.tenantId, tenantId), or(eq(staffProfiles.siteId, siteId), isNull(staffProfiles.siteId)), eq(staffProfiles.isActive, true)))
    .limit(1);

  if (profile) {
    const startsAt = profile.suspensionStartedAt;
    const endsAt = profile.suspensionEndsAt;
    if (isStaffSuspended(new Date(), startsAt, endsAt)) {
      throw new TRPCError({ code: "FORBIDDEN", message: `تم توقيف حسابك مؤقتاً حتى ${profile.suspensionEndsAt!.toLocaleString("ar-IQ")}.` });
    }
    let permissions = Array.isArray(profile.permissions) ? profile.permissions : [];
    if (!permissions.length && profile.customRoleId) {
      const [customRole] = await db.select({ permissions: customPermissionRoles.permissions }).from(customPermissionRoles)
        .where(and(eq(customPermissionRoles.id, profile.customRoleId), eq(customPermissionRoles.tenantId, tenantId), eq(customPermissionRoles.isActive, true))).limit(1);
      permissions = customRole?.permissions ?? [];
    }
    return { role: profile.role, permissions: permissions as PowerCapability[] };
  }
  throw new TRPCError({ code: "FORBIDDEN", message: "لا يوجد تعيين فعال لك في هذه المحطة." });
}

async function enforcePlatformRolePolicy(role: PowerRole, capability?: PowerCapability) {
  if (!capability) return;
  const db = await dbOrThrow();
  const [policy] = await db.select({ isAllowed: platformRolePolicies.isAllowed }).from(platformRolePolicies)
    .where(and(eq(platformRolePolicies.role, role), eq(platformRolePolicies.capability, capability))).limit(1);
  if (policy && !policy.isAllowed) throw new TRPCError({ code: "FORBIDDEN", message: "هذه القدرة مقيّدة بسياسة المنصة للدور الحالي." });
}

async function requireRole(userId: number, siteId: number, allowed: PowerRole[], capability?: PowerCapability) {
  const access = await resolveAccess(userId, siteId);
  const db = await dbOrThrow();
  const [user] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1);
  if (user?.role !== "admin" && !allowed.includes(access.role) && (!capability || !access.permissions.includes(capability))) {
    throw new TRPCError({ code: "FORBIDDEN", message: "لا تملك صلاحية تنفيذ هذه العملية." });
  }
  if (user?.role === "admin") return access.role;
  if (capability && access.permissions.length > 0 && !access.permissions.includes(capability)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "هذه العملية غير موجودة ضمن الصلاحيات الممنوحة لهذا الحساب." });
  }
  await enforcePlatformRolePolicy(access.role, capability);
  return access.role;
}

async function requireAllBranchRole(userId: number, siteId: number, allowed: PowerRole[]) {
  const db = await dbOrThrow();
  const [user] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1);
  if (user?.role === "admin") return "owner" as const;
  const tenantId = await getSiteTenant(siteId);
  const [membership] = await db.select({ role: tenantMembers.role }).from(tenantMembers)
    .where(and(eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.userId, userId), eq(tenantMembers.isActive, true), eq(tenantMembers.membershipStatus, "active"))).limit(1);
  if (membership?.role === "owner") return "owner" as const;
  const [globalProfile] = await db.select({ role: staffProfiles.role }).from(staffProfiles)
    .where(and(eq(staffProfiles.tenantId, tenantId), eq(staffProfiles.userId, userId), isNull(staffProfiles.siteId), eq(staffProfiles.isActive, true))).limit(1);
  if (!globalProfile || !allowed.includes(globalProfile.role)) throw new TRPCError({ code: "FORBIDDEN", message: "هذه البيانات المجمعة متاحة لمالك المولد أو لحساب عام معيّن على جميع الأفرع." });
  return globalProfile.role;
}

async function writeAudit(input: {
  userId?: number;
  siteId?: number;
  tenantId?: number;
  entityType: string;
  entityId: string;
  action: string;
  beforeData?: unknown;
  afterData?: unknown;
  metadata?: unknown;
}) {
  const db = await dbOrThrow();
  const fromAfter = input.afterData as { siteId?: unknown } | undefined;
  const fromMetadata = input.metadata as { siteId?: unknown } | undefined;
  const inferredSiteId = input.siteId ?? (typeof fromAfter?.siteId === "number" ? fromAfter.siteId : undefined) ?? (typeof fromMetadata?.siteId === "number" ? fromMetadata.siteId : undefined);
  const inferredTenantId = input.tenantId ?? (inferredSiteId ? await getSiteTenant(inferredSiteId) : undefined);
  if (!inferredSiteId || !inferredTenantId) throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن تسجيل تدقيق بلا سياق محطة ومستأجر." });
  const [actor] = input.userId ? await db.select({ platformRole: users.platformRole }).from(users).where(eq(users.id, input.userId)).limit(1) : [];
  await db.insert(auditLogs).values({
    tenantId: inferredTenantId,
    siteId: inferredSiteId,
    userId: input.userId,
    actorPlatformRole: actor?.platformRole,
    entityType: input.entityType,
    entityId: input.entityId,
    action: input.action,
    beforeData: input.beforeData,
    afterData: input.afterData,
    metadata: input.metadata,
  });
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

async function assertFinancialPeriodOpen(db: Awaited<ReturnType<typeof dbOrThrow>>, tenantId: number, siteId: number, occurredAt: Date, userId: number, entityType: string) {
  const [locked] = await db.select({ id: financialSettlements.id, periodStart: financialSettlements.periodStart, periodEnd: financialSettlements.periodEnd }).from(financialSettlements).where(and(eq(financialSettlements.tenantId, tenantId), eq(financialSettlements.siteId, siteId), eq(financialSettlements.status, "locked"), lte(financialSettlements.periodStart, occurredAt), gte(financialSettlements.periodEnd, occurredAt))).limit(1);
  if (locked) {
    await writeAudit({ userId, siteId, entityType, entityId: "period-lock", action: "blocked_by_locked_period", metadata: { settlementId: locked.id, occurredAt: occurredAt.toISOString(), periodStart: locked.periodStart.toISOString(), periodEnd: locked.periodEnd.toISOString() } });
    throw new TRPCError({ code: "FORBIDDEN", message: "الفترة المالية مقفلة؛ لا يمكن تعديل أو إضافة بيانات مالية داخلها." });
  }
}

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
      const monthStart = new Date();
      monthStart.setUTCDate(1);
      monthStart.setUTCHours(0, 0, 0, 0);
      const admin = supabaseAdmin();
      const [accountResult, usageResult] = await Promise.all([
        admin.from("tenant_tweetsms_accounts").select("sender_name, monthly_limit, is_active, credential_ciphertext, last_error").eq("tenant_id", scope.tenantId).maybeSingle(),
        admin.from("notification_messages").select("id").eq("tenant_id", scope.tenantId).eq("channel", "sms").gte("created_at", monthStart.toISOString()).in("status", ["submitted", "delivered", "read"]),
      ]);
      if (accountResult.error || usageResult.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل حصة الرسائل من Supabase." });
      const account = accountResult.data;
      const included = Number(account?.monthly_limit ?? 0);
      const additional = 0;
      const used = (usageResult.data ?? []).length;
      return { plan: "tweetsms", planName: "TweetSMS", senderName: account?.sender_name ?? null, isActive: account?.is_active ?? false, configured: Boolean(account?.credential_ciphertext), lastError: account?.last_error ?? null, included, additional, total: included, used, remaining: Math.max(0, included - used) };
    }),
    smsDailyUsage: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      const scope = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "collector"], "manageMessaging");
      const fourteenDaysAgo = new Date(); fourteenDaysAgo.setUTCDate(fourteenDaysAgo.getUTCDate() - 13); fourteenDaysAgo.setUTCHours(0, 0, 0, 0);
      const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
      const admin = supabaseAdmin();
      const [accountResult, messagesResult, monthUsageResult] = await Promise.all([
        admin.from("tenant_tweetsms_accounts").select("monthly_limit").eq("tenant_id", scope.tenantId).maybeSingle(),
        admin.from("notification_messages").select("created_at, status").eq("tenant_id", scope.tenantId).eq("channel", "sms").gte("created_at", fourteenDaysAgo.toISOString()),
        admin.from("notification_messages").select("id").eq("tenant_id", scope.tenantId).eq("channel", "sms").gte("created_at", monthStart.toISOString()).in("status", ["submitted", "delivered", "read"]),
      ]);
      if (accountResult.error || messagesResult.error || monthUsageResult.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل استخدام الرسائل من Supabase." });
      const messages = messagesResult.data ?? [];
      const daily = new Map<string, number>(); for (const message of messages) { if (!["submitted", "delivered", "read"].includes(message.status)) continue; const key = new Date(message.created_at).toISOString().slice(0, 10); daily.set(key, (daily.get(key) ?? 0) + 1); }
      const today = new Date(); const points = Array.from({ length: 14 }, (_, index) => { const date = new Date(today); date.setDate(today.getDate() - (13 - index)); const key = date.toISOString().slice(0, 10); return { date: key, count: daily.get(key) ?? 0 }; });
      const included = Number(accountResult.data?.monthly_limit ?? 0); const additional = 0; const total = included; const used = (monthUsageResult.data ?? []).length;
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
    create: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), email: z.string().email(), name: z.string().trim().min(2).max(160), temporaryPassword: z.string().min(8).max(128), role: z.enum(["manager", "accountant", "collector", "technician", "viewer"]), allBranches: z.boolean().default(false) })).mutation(async () => {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "إنشاء الحسابات الفرعية متوقف مؤقتاً أثناء ترحيله الآمن إلى Supabase Auth. لا تُنشأ حسابات من المسار الموروث." });
    }),
    activity: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), userId: z.number().int().positive() })).query(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner"], "manageTeam");
      const { data, error } = await supabaseAdmin().from("audit_logs").select("id, action, entity_type, created_at, metadata, after_data")
        .eq("tenant_id", access.tenantId).eq("site_id", input.siteId).eq("user_id", input.userId).order("created_at", { ascending: false }).limit(15);
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل سجل نشاط الحساب الفرعي من Supabase." });
      return (data ?? []).map((entry) => ({ id: Number(entry.id), action: entry.action, entityType: entry.entity_type, createdAt: new Date(entry.created_at), metadata: entry.metadata, afterData: entry.after_data }));
    }),
    resetPassword: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), profileId: z.number().int().positive() })).mutation(async () => {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "إعادة تعيين كلمات المرور للحسابات الفرعية متوقفة مؤقتاً أثناء ترحيلها الآمن إلى Supabase Auth. لا تُنفّذ أي عملية على المسار الموروث." });
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
      await requireRole(ctx.user.id, input.siteId, ["owner"], "manageSubscribers");
      const db = await dbOrThrow();
      const tenantId = await getSiteTenant(input.siteId);
      const quota = await ownerSubscriberQuota(tenantId);
      if (quota.remaining > 0) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "يتاح طلب الترقية من هذا الزر عند بلوغ الحد الأقصى للمشتركين." });
      const planRank: Record<SubscriptionPlan, number> = { starter: 1, professional: 2, enterprise: 3 };
      if (planRank[input.requestedPlan] <= planRank[quota.plan]) throw new TRPCError({ code: "BAD_REQUEST", message: "اختر باقة أعلى من باقتك الحالية." });
      const [pending] = await db.select({ id: subscriptionUpgradeRequests.id, requestedPlan: subscriptionUpgradeRequests.requestedPlan })
        .from(subscriptionUpgradeRequests).where(and(eq(subscriptionUpgradeRequests.tenantId, tenantId), eq(subscriptionUpgradeRequests.status, "pending"))).limit(1);
      if (pending) return { id: pending.id, requestedPlan: pending.requestedPlan, alreadyRequested: true };
      const id = insertId(await db.insert(subscriptionUpgradeRequests).values({ tenantId, requestedByUserId: ctx.user.id, currentPlan: quota.plan, requestedPlan: input.requestedPlan }));
      await writeAudit({ userId: ctx.user.id, siteId: input.siteId, entityType: "subscription_upgrade_request", entityId: String(id), action: "request_upgrade", afterData: { currentPlan: quota.plan, requestedPlan: input.requestedPlan, reason: "subscriber_limit_reached" } });
      return { id, requestedPlan: input.requestedPlan, alreadyRequested: false };
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
      await requireRole(ctx.user.id, input.siteId, ["owner"]);
      const db = await dbOrThrow();
      const [site] = await db.select({ tenantId: sites.tenantId }).from(sites).where(eq(sites.id, input.siteId)).limit(1);
      if (!site) throw new TRPCError({ code: "NOT_FOUND", message: "المحطة غير موجودة." });
      const code = input.portalCode.toLowerCase();
      const [conflict] = await db.select({ siteId: sitePortalSettings.siteId }).from(sitePortalSettings).where(eq(sitePortalSettings.portalCode, code)).limit(1);
      if (conflict && conflict.siteId !== input.siteId) throw new TRPCError({ code: "CONFLICT", message: "رمز الرابط مستخدم لمولد آخر. اختر رمزاً مختلفاً." });
      const values = { tenantId: site.tenantId, siteId: input.siteId, portalCode: code, displayName: input.displayName, primaryColor: input.primaryColor.toUpperCase(), accentColor: input.accentColor.toUpperCase(), isEnabled: input.isEnabled };
      await db.insert(sitePortalSettings).values(values).onDuplicateKeyUpdate({ set: { portalCode: values.portalCode, displayName: values.displayName, primaryColor: values.primaryColor, accentColor: values.accentColor, isEnabled: values.isEnabled, updatedAt: new Date() } });
      await writeAudit({ userId: ctx.user.id, siteId: input.siteId, entityType: "site_portal_settings", entityId: String(input.siteId), action: "update", afterData: values });
      return { success: true, portalCode: code };
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
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "collector", "viewer"]);
      return ownerSubscriberQuota(await getSiteTenant(input.siteId));
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
      if (input.clientOperationId) {
        const { data: applied, error: appliedError } = await admin.from("offline_sync_operations").select("operation_type, response")
          .eq("user_id", ctx.user.id).eq("client_operation_id", input.clientOperationId).maybeSingle();
        if (appliedError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر التحقق من مفتاح المزامنة في Supabase." });
        if (applied) {
          if (applied.operation_type !== "subscriber_create") throw new TRPCError({ code: "CONFLICT", message: "مفتاح عملية المزامنة مستخدم لنوع عملية مختلف." });
          return applied.response as { id: number; subscriberNo: string; referenceNotifications: Array<{ notificationId: number; status: string; error?: string }> };
        }
      }
      const quota = await getSupabaseOwnerSubscriberQuota(access.tenantId);
      if (quota.currentCount >= quota.limit) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `وصلت إلى الحد الأقصى للمشتركين في باقتك (${quota.limit}). تواصل مع إدارة المنصة لترقية الاشتراك.` });
      const phone = normalizeInternationalPhone(input.phone);
      const whatsappNumber = input.whatsappNumber ? normalizeInternationalPhone(input.whatsappNumber) : undefined;
      const site = await getSupabaseSite(input.siteId);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const requestedSubscriberNo = generateSubscriberReference(site.code);
        const { data, error } = await admin.rpc("powerhub_create_subscriber", {
          p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id, p_subscriber_no: requestedSubscriberNo,
          p_full_name: input.fullName.trim(), p_phone: phone, p_whatsapp_number: whatsappNumber ?? "", p_address: input.address?.trim() ?? "",
          p_subscription_type: input.subscriptionType, p_client_operation_id: input.clientOperationId ?? null, p_quota_limit: quota.limit,
        });
        if (!error && data?.[0]) {
          const row = data[0] as { subscriber_id: number | string; subscriber_no: string; replayed: boolean };
          const response = { id: Number(row.subscriber_id), subscriberNo: row.subscriber_no, referenceNotifications: [] as Array<{ notificationId: number; status: string; error?: string }> };
          if (!row.replayed) await recordSupabaseSubscriberQuotaAlert({ tenantId: access.tenantId, siteId: input.siteId, userId: ctx.user.id, quota: { ...quota, currentCount: quota.currentCount + 1, remaining: Math.max(0, quota.remaining - 1) } });
          return response;
        }
        const errorText = `${error?.code ?? ""} ${error?.message ?? ""}`;
        if (errorText.includes("SUBSCRIBER_QUOTA_REACHED")) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `وصلت إلى الحد الأقصى للمشتركين في باقتك (${quota.limit}). تواصل مع إدارة المنصة لترقية الاشتراك.` });
        if (errorText.includes("SITE_OUT_OF_SCOPE")) throw new TRPCError({ code: "FORBIDDEN", message: "المحطة لا تتبع لمساحة صاحب المولد الحالية." });
        if (error?.code === "23505" && attempt < 4) continue;
        throw new TRPCError({ code: error?.code === "23505" ? "CONFLICT" : "INTERNAL_SERVER_ERROR", message: error?.code === "23505" ? "تعذر توليد رقم مرجعي فريد للمشترك. أعد المحاولة." : "تعذر إنشاء المشترك في Supabase." });
      }
      throw new TRPCError({ code: "CONFLICT", message: "تعذر توليد رقم مرجعي فريد للمشترك. أعد المحاولة." });
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
      await requireRole(ctx.user.id, input.siteId, createRoles, "manageSubscribers");
      const db = await dbOrThrow();
      const tenantId = await getSiteTenant(input.siteId);
      const quota = await ownerSubscriberQuota(tenantId);
      const [site] = await db.select({ code: sites.code }).from(sites).where(eq(sites.id, input.siteId)).limit(1);
      if (!site) throw new TRPCError({ code: "NOT_FOUND", message: "المحطة غير موجودة." });
      const failureRows: Array<{ sourceRow: number; fullName: string; reason: string }> = [];
      const seenPhones = new Set<string>();
      const seenReferences = new Set<string>();
      const accepted: Array<{ sourceRow: number; subscriberNo?: string; fullName: string; phone: string; whatsappNumber?: string; address?: string; subscriptionType: "residential" | "commercial" }> = [];
      for (const row of input.rows) {
        if (row.fullName.trim().length < 2) { failureRows.push({ sourceRow: row.sourceRow, fullName: row.fullName, reason: "الاسم الكامل قصير جداً." }); continue; }
        let phone: string;
        try { phone = normalizeInternationalPhone(row.phone); }
        catch { failureRows.push({ sourceRow: row.sourceRow, fullName: row.fullName, reason: "رقم الجوال غير صالح؛ استخدم رمز الدولة مثل +970." }); continue; }
        let whatsappNumber: string | undefined;
        try { whatsappNumber = row.whatsappNumber ? normalizeInternationalPhone(row.whatsappNumber) : undefined; }
        catch { failureRows.push({ sourceRow: row.sourceRow, fullName: row.fullName, reason: "رقم واتساب غير صالح؛ اتركه فارغاً أو استخدم رمز الدولة مثل +970." }); continue; }
        if (seenPhones.has(phone)) { failureRows.push({ sourceRow: row.sourceRow, fullName: row.fullName, reason: "رقم الجوال مكرر داخل ملف الاستيراد." }); continue; }
        seenPhones.add(phone);
        const subscriberNo = row.subscriberNo?.replace(/\s+/g, "").toUpperCase();
        if (subscriberNo && !/^[A-Z0-9][A-Z0-9_-]{1,79}$/.test(subscriberNo)) { failureRows.push({ sourceRow: row.sourceRow, fullName: row.fullName, reason: "الرقم المرجعي غير صالح." }); continue; }
        if (subscriberNo && seenReferences.has(subscriberNo)) { failureRows.push({ sourceRow: row.sourceRow, fullName: row.fullName, reason: "الرقم المرجعي مكرر داخل ملف الاستيراد." }); continue; }
        if (subscriberNo) seenReferences.add(subscriberNo);
        accepted.push({ sourceRow: row.sourceRow, subscriberNo, fullName: row.fullName.trim(), phone, whatsappNumber, address: row.address?.trim() || undefined, subscriptionType: row.subscriptionType });
      }
      const existing = await db.select({ id: subscribers.id, subscriberNo: subscribers.subscriberNo, fullName: subscribers.fullName, phone: subscribers.phone, whatsappNumber: subscribers.whatsappNumber, address: subscribers.address, subscriptionType: subscribers.subscriptionType }).from(subscribers).where(eq(subscribers.siteId, input.siteId));
      const existingByReference = new Map(existing.map((row) => [row.subscriberNo.replace(/\s+/g, "").toUpperCase(), row]));
      const existingByKey = new Map(existing.map((row) => [`${row.fullName.trim().replace(/\s+/g, " ").toLocaleLowerCase("ar")}:${row.phone}`, row]));
      const updated: Array<{ id: number; sourceRow: number; fullName: string; subscriberNo: string }> = [];
      const uniqueRows: typeof accepted = [];
      for (const row of accepted) {
        const key = `${row.fullName.replace(/\s+/g, " ").toLocaleLowerCase("ar")}:${row.phone}`;
        const matched = row.subscriberNo ? existingByReference.get(row.subscriberNo) : existingByKey.get(key);
        if (row.subscriberNo && !matched) { failureRows.push({ sourceRow: row.sourceRow, fullName: row.fullName, reason: "الرقم المرجعي لا يطابق مشتركاً في هذا الفرع؛ اتركه فارغاً لإضافة مشترك جديد." }); continue; }
        if (!matched) { uniqueRows.push(row); continue; }
        if (input.updateExisting) {
          await db.update(subscribers).set({ fullName: row.fullName, phone: row.phone, whatsappNumber: row.whatsappNumber, address: row.address, subscriptionType: row.subscriptionType }).where(eq(subscribers.id, matched.id));
          await writeAudit({ userId: ctx.user.id, siteId: input.siteId, entityType: "subscriber", entityId: String(matched.id), action: "bulk_import_update", beforeData: matched, afterData: { ...row, matchMethod: row.subscriberNo ? "subscriber_no" : "full_name_and_phone" } });
          updated.push({ id: matched.id, sourceRow: row.sourceRow, fullName: row.fullName, subscriberNo: matched.subscriberNo });
          continue;
        }
        failureRows.push({ sourceRow: row.sourceRow, fullName: row.fullName, reason: row.subscriberNo ? "الرقم المرجعي يعود لمشترك موجود؛ فعّل خيار تحديث المشتركين المطابقين لتعديل بياناته." : "يوجد مشترك بالاسم ورقم الجوال نفسيهما في هذا الفرع." });
      }
      const remainingCapacity = quota.limit === Infinity ? uniqueRows.length : Math.max(0, quota.limit - quota.currentCount);
      const rowsToCreate = uniqueRows.slice(0, remainingCapacity);
      uniqueRows.slice(remainingCapacity).forEach((row) => failureRows.push({ sourceRow: row.sourceRow, fullName: row.fullName, reason: "يتجاوز هذا الصف الحد المتاح للمشتركين في الباقة." }));
      const created: Array<{ id: number; sourceRow: number; fullName: string; subscriberNo: string }> = [];
      for (const row of rowsToCreate) {
        let createdRow: { id: number; sourceRow: number; fullName: string; subscriberNo: string } | null = null;
        for (let attempt = 0; attempt < 5; attempt += 1) {
          const subscriberNo = generateSubscriberReference(site.code);
          try {
            const id = insertId(await db.insert(subscribers).values({ tenantId, siteId: input.siteId, subscriberNo, fullName: row.fullName, phone: row.phone, whatsappNumber: row.whatsappNumber, address: row.address, subscriptionType: row.subscriptionType }));
            await writeAudit({ userId: ctx.user.id, siteId: input.siteId, entityType: "subscriber", entityId: String(id), action: "bulk_import_create", afterData: { fullName: row.fullName, phone: row.phone, whatsappNumber: row.whatsappNumber, subscriberNo, sourceRow: row.sourceRow } });
            createdRow = { id, sourceRow: row.sourceRow, fullName: row.fullName, subscriberNo };
            break;
          } catch (error) {
            if (!isDuplicateKeyError(error) || attempt === 4) throw error;
          }
        }
        if (createdRow) created.push(createdRow);
        else failureRows.push({ sourceRow: row.sourceRow, fullName: row.fullName, reason: "تعذر توليد رقم مرجعي فريد للمشترك." });
      }
      await writeAudit({ userId: ctx.user.id, siteId: input.siteId, entityType: "subscriber_import", entityId: `bulk-${Date.now()}`, action: "bulk_import", afterData: { requested: input.rows.length, created: created.length, updated: updated.length, failed: failureRows.length, updateExisting: input.updateExisting } });
      await recordSubscriberQuotaAlert({ tenantId, siteId: input.siteId, userId: ctx.user.id, quota: { ...quota, currentCount: quota.currentCount + created.length, remaining: Math.max(0, quota.remaining - created.length) } });
      return { created, updated, failed: failureRows.sort((a, b) => a.sourceRow - b.sourceRow), notificationsQueued: 0, message: "لم تُرسل رسائل الأرقام المرجعية تلقائياً ضمن الاستيراد الجماعي لحماية رصيد الرسائل؛ استخدم إرسال الإشعارات بعد المراجعة." };
    }),
    update: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(), id: z.number().int().positive(), fullName: z.string().min(2).max(180), phone: z.string().min(5).max(30),
      address: z.string().max(1000).optional(), subscriptionType: z.enum(["residential", "commercial"]), serviceStatus: z.enum(["active", "suspended", "disconnected"]),
      clientOperationId: z.string().uuid().optional(), expectedUpdatedAt: z.date().optional(),
    })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "manageSubscribers");
      const admin = supabaseAdmin();
      if (input.clientOperationId) {
        const { data: applied, error: appliedError } = await admin.from("offline_sync_operations").select("operation_type, response")
          .eq("user_id", ctx.user.id).eq("client_operation_id", input.clientOperationId).maybeSingle();
        if (appliedError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر التحقق من مفتاح المزامنة في Supabase." });
        if (applied) {
          if (applied.operation_type !== "subscriber_update") throw new TRPCError({ code: "CONFLICT", message: "مفتاح عملية المزامنة مستخدم لنوع عملية مختلف." });
          const response = applied.response as { success: true; updatedAt: string | Date };
          return { success: true as const, updatedAt: new Date(response.updatedAt) };
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
        return { success: true as const, updatedAt: new Date(row.updated_at) };
      }
      const errorText = `${error?.code ?? ""} ${error?.message ?? ""}`;
      if (errorText.includes("SUBSCRIBER_OUT_OF_SCOPE")) throw new TRPCError({ code: "NOT_FOUND", message: "المشترك غير موجود ضمن المحطة المحددة." });
      if (errorText.includes("SUBSCRIBER_VERSION_CONFLICT")) throw new TRPCError({ code: "CONFLICT", message: "تغيرت بيانات المشترك على الخادم منذ حفظ هذه المسودة. راجع التعارض ثم أعد المحاولة." });
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحديث المشترك في Supabase." });
    }),
    phoneReview: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner"], "manageSubscribers");
      const db = await dbOrThrow();
      const rows = await db.select({ id: subscribers.id, subscriberNo: subscribers.subscriberNo, fullName: subscribers.fullName, phone: subscribers.phone }).from(subscribers).where(eq(subscribers.siteId, input.siteId)).orderBy(subscribers.fullName);
      return rows.map((row) => {
        try {
          const normalizedPhone = normalizeInternationalPhone(row.phone);
          return normalizedPhone === row.phone ? null : { ...row, status: "ready" as const, normalizedPhone, reason: "يمكن توحيد الصيغة تلقائياً." };
        } catch {
          return { ...row, status: "manual" as const, normalizedPhone: null, reason: "يتطلب رمز دولة صريحاً؛ عدّل الرقم يدوياً من إدارة المشتركين." };
        }
      }).filter(Boolean);
    }),
    applyPhoneNormalization: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), subscriberIds: z.array(z.number().int().positive()).min(1).max(500) })).mutation(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner"], "manageSubscribers");
      const db = await dbOrThrow();
      const rows = await db.select().from(subscribers).where(and(eq(subscribers.siteId, input.siteId), inArray(subscribers.id, input.subscriberIds)));
      let updated = 0;
      for (const row of rows) {
        try {
          const phone = normalizeInternationalPhone(row.phone);
          if (phone !== row.phone) {
            await db.update(subscribers).set({ phone }).where(eq(subscribers.id, row.id));
            updated += 1;
            await writeAudit({ userId: ctx.user.id, siteId: input.siteId, entityType: "subscriber", entityId: String(row.id), action: "normalize_phone", beforeData: { phone: row.phone }, afterData: { phone } });
          }
        } catch {
          // لا يخمن النظام رمز الدولة للأرقام المحلية غير القابلة للتحقق.
        }
      }
      return { updated, skipped: input.subscriberIds.length - updated };
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
    })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, createRoles, "manageTariffs");
      const { data, error } = await supabaseAdmin().from("tariffs").insert({
        tenant_id: access.tenantId, site_id: input.siteId, name: input.name.trim(), code: input.code.trim().toUpperCase(),
        price_per_kwh: input.pricePerKwh, fixed_fee: input.fixedFee, tax_rate: input.taxRate,
      }).select("id").single();
      if (error || !data) throw new TRPCError({ code: error?.code === "23505" ? "CONFLICT" : "INTERNAL_SERVER_ERROR", message: error?.code === "23505" ? "رمز التعرفة مستخدم بالفعل في هذا الفرع." : "تعذر إنشاء التعرفة في Supabase." });
      const id = Number(data.id);
      await writeSupabaseAudit({ userId: ctx.user.id, tenantId: access.tenantId, siteId: input.siteId, entityType: "tariff", entityId: String(id), action: "create", afterData: input });
      return { id };
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
      fuelType: z.enum(["diesel", "gasoline", "gas", "other"]).default("diesel"),
    })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "technician"], "manageGenerators");
      const { data, error } = await supabaseAdmin().from("generators").insert({
        tenant_id: access.tenantId, site_id: input.siteId, code: input.code.trim().toUpperCase(), name: input.name.trim(),
        serial_number: input.serialNumber?.trim() || null, rated_capacity_kw: input.ratedCapacityKw, fuel_type: input.fuelType,
      }).select("id").single();
      if (error || !data) throw new TRPCError({ code: error?.code === "23505" ? "CONFLICT" : "INTERNAL_SERVER_ERROR", message: error?.code === "23505" ? "رمز أو اسم المولد مستخدم بالفعل." : "تعذر إنشاء المولد في Supabase." });
      const id = Number(data.id);
      await writeSupabaseAudit({ userId: ctx.user.id, tenantId: access.tenantId, siteId: input.siteId, entityType: "generator", entityId: String(id), action: "create", afterData: input });
      return { id };
    }),
    update: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(), id: z.number().int().positive(), name: z.string().min(2).max(160), ratedCapacityKw: z.string().regex(/^\d+(\.\d{1,3})?$/),
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
        name: input.name.trim(), rated_capacity_kw: input.ratedCapacityKw, fuel_level_liters: input.fuelLevelLiters,
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
    create: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(), subscriberId: z.number().int().positive(), readingValue: z.string().regex(/^\d+(\.\d{1,3})?$/), readingAt: z.date().optional(),
      captureMethod: z.enum(["manual", "photo", "smart_meter"]).default("manual"), clientOperationId: z.string().uuid().optional(), imageData: z.string().max(9_500_000).optional(), imageMime: z.enum(["image/jpeg", "image/png", "image/webp"]).optional(), notes: z.string().max(1000).optional(), isReadingReset: z.boolean().default(false), overrideSameDay: z.boolean().default(false), fieldVerified: z.boolean().default(false),
    })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, readingRoles, "recordReadings");
      const readingAt = input.readingAt ?? new Date();
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
    createFromReading: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(), readingId: z.number().int().positive(), tariffId: z.number().int().positive(),
      billingPeriod: z.string().regex(/^\d{4}-\d{2}$/), dueDate: z.date(), discountAmount: z.number().min(0).default(0), clientOperationId: z.string().uuid().optional(),
    })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, createRoles, "issueInvoices");
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
        await requireRole(ctx.user.id, input.siteId, createRoles);
        const db = await dbOrThrow();
        const [invoice] = await db.select().from(invoices).where(and(eq(invoices.id, input.invoiceId), eq(invoices.siteId, input.siteId))).limit(1);
        if (!invoice || invoice.status === "draft" || invoice.status === "cancelled") throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن مشاركة فاتورة غير صادرة أو ملغاة." });
        const token = generateInvoiceShareToken();
        const id = insertId(await db.insert(invoiceShareLinks).values({ tenantId: invoice.tenantId, invoiceId: invoice.id, tokenHash: hashInvoiceShareToken(token), tokenPreview: token.slice(0, 8), expiresAt: input.expiresAt }));
        await writeAudit({ userId: ctx.user.id, siteId: input.siteId, entityType: "invoice_share_link", entityId: String(id), action: "create", metadata: { invoiceId: invoice.id } });
        return { token, path: `/invoice/${token}` };
      }),
    publicByToken: publicProcedure.input(z.object({ token: z.string().min(16).max(200) })).query(async ({ input }) => {
      const db = await dbOrThrow();
      const [link] = await db.select().from(invoiceShareLinks).where(eq(invoiceShareLinks.tokenHash, hashInvoiceShareToken(input.token))).limit(1);
      if (!link || link.revokedAt || (link.expiresAt && link.expiresAt < new Date())) throw new TRPCError({ code: "NOT_FOUND", message: "رابط الفاتورة غير صالح أو منتهي." });
      const [invoice] = await db.select().from(invoices).where(eq(invoices.id, link.invoiceId)).limit(1);
      if (!invoice) throw new TRPCError({ code: "NOT_FOUND", message: "الفاتورة غير موجودة." });
      const [subscriber] = await db.select({ fullName: subscribers.fullName, subscriberNo: subscribers.subscriberNo }).from(subscribers).where(eq(subscribers.id, invoice.subscriberId)).limit(1);
      const lines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoice.id)).orderBy(invoiceLines.displayOrder);
      await db.update(invoiceShareLinks).set({ viewCount: sql`${invoiceShareLinks.viewCount} + 1`, lastViewedAt: new Date() }).where(eq(invoiceShareLinks.id, link.id));
      return { invoice, subscriber, lines };
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
      if (!error && data?.[0]) return { id: Number((data[0] as { payment_id: number | string }).payment_id) };
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
    open: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), openingCash: z.number().min(0).default(0), notes: z.string().max(1000).optional() })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, recordRoles, "collectPayments");
      if (access.role !== "collector") throw new TRPCError({ code: "FORBIDDEN", message: "جلسة التحصيل الميدانية مخصصة لدور المحصل." });
      const { data, error } = await supabaseAdmin().rpc("powerhub_open_collector_session", { p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id, p_opening_cash: input.openingCash, p_notes: input.notes ?? null });
      if (!error && data?.[0]) return { id: Number((data[0] as { session_id: number | string }).session_id) };
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
      description: z.string().min(2).max(255), amount: z.number().positive(), referenceNo: z.string().max(120).optional(),
    })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, createRoles, "manageExpenses");
      const { data, error } = await supabaseAdmin().rpc("powerhub_create_expense", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id, p_generator_id: input.generatorId ?? null,
        p_category: input.category, p_description: input.description, p_amount: input.amount, p_reference_no: input.referenceNo ?? null,
      });
      if (!error && data?.[0]) return { id: Number((data[0] as { expense_id: number | string }).expense_id) };
      const errorText = `${error?.code ?? ""} ${error?.message ?? ""}`;
      if (errorText.includes("GENERATOR_OUT_OF_SCOPE")) throw new TRPCError({ code: "NOT_FOUND", message: "المولد لا يتبع للمحطة المحددة." });
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
      await requireAllBranchRole(ctx.user.id, input.siteId, ["manager", "accountant", "viewer"]);
      const db = await dbOrThrow();
      const tenantId = await getSiteTenant(input.siteId);
      const branchRows = await db.select({ id: sites.id }).from(sites).where(and(eq(sites.tenantId, tenantId), ne(sites.status, "archived")));
      const branchIds = branchRows.map((branch) => branch.id);
      if (!branchIds.length) return { branchCount: 0, subscribers: 0, generators: { active: 0, maintenance: 0 }, financial: { invoiced: 0, collected: 0, outstanding: 0, expenses: 0, operatingProfit: 0 }, energyKwh: 0, failedNotifications: 0 };
      const [subscriberCount, generatorStatus, invoiceTotals, expenseTotals, notificationTotals] = await Promise.all([
        db.select({ value: sql<number>`count(*)` }).from(subscribers).where(and(inArray(subscribers.siteId, branchIds), eq(subscribers.serviceStatus, "active"))),
        db.select({ active: sql<number>`sum(case when ${generators.status} = 'active' then 1 else 0 end)`, maintenance: sql<number>`sum(case when ${generators.status} = 'maintenance' then 1 else 0 end)` }).from(generators).where(inArray(generators.siteId, branchIds)),
        db.select({ invoiced: sql<string>`coalesce(sum(${invoices.totalAmount}), 0)`, paid: sql<string>`coalesce(sum(${invoices.paidAmount}), 0)`, outstanding: sql<string>`coalesce(sum(${invoices.balanceDue}), 0)`, energy: sql<string>`coalesce(sum(${invoices.consumptionKwh}), 0)` }).from(invoices).where(and(inArray(invoices.siteId, branchIds), sql`${invoices.status} <> 'cancelled'`)),
        db.select({ amount: sql<string>`coalesce(sum(${expenses.amount}), 0)` }).from(expenses).where(inArray(expenses.siteId, branchIds)),
        db.select({ failed: sql<number>`sum(case when ${notificationMessages.status} = 'failed' then 1 else 0 end)` }).from(notificationMessages).where(sql`${notificationMessages.subscriberId} in (select ${subscribers.id} from ${subscribers} where ${subscribers.tenantId} = ${tenantId})`),
      ]);
      return { branchCount: branchIds.length, subscribers: Number(subscriberCount[0]?.value ?? 0), generators: { active: Number(generatorStatus[0]?.active ?? 0), maintenance: Number(generatorStatus[0]?.maintenance ?? 0) }, financial: { invoiced: Number(invoiceTotals[0]?.invoiced ?? 0), collected: Number(invoiceTotals[0]?.paid ?? 0), outstanding: Number(invoiceTotals[0]?.outstanding ?? 0), expenses: Number(expenseTotals[0]?.amount ?? 0), operatingProfit: Number(invoiceTotals[0]?.paid ?? 0) - Number(expenseTotals[0]?.amount ?? 0) }, energyKwh: Number(invoiceTotals[0]?.energy ?? 0), failedNotifications: Number(notificationTotals[0]?.failed ?? 0) };
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
      const db = await dbOrThrow();
      const tenantId = await getSiteTenant(input.siteId);
      if (input.scope === "all") await requireAllBranchRole(ctx.user.id, input.siteId, ["manager", "accountant", "viewer"]);
      const branchRows = input.scope === "all"
        ? await db.select({ id: sites.id, name: sites.name }).from(sites).where(and(eq(sites.tenantId, tenantId), ne(sites.status, "archived"))).orderBy(desc(sites.createdAt))
        : await db.select({ id: sites.id, name: sites.name }).from(sites).where(and(eq(sites.id, input.siteId), eq(sites.tenantId, tenantId))).limit(1);
      const branchIds = branchRows.map((branch) => branch.id);
      if (!branchIds.length) return buildFinancialOverview({ branches: [], invoices: [], payments: [], expenses: [] });
      const [invoiceRows, paymentRows, expenseRows, subscriberCounts] = await Promise.all([
        db.select({ invoice: invoices, subscriber: subscribers }).from(invoices).innerJoin(subscribers, eq(invoices.subscriberId, subscribers.id))
          .where(and(inArray(invoices.siteId, branchIds), sql`${invoices.status} not in ('cancelled', 'draft')`)),
        db.select({ payment: payments }).from(payments).where(inArray(payments.siteId, branchIds)),
        db.select().from(expenses).where(inArray(expenses.siteId, branchIds)),
        db.select({ siteId: subscribers.siteId, count: sql<number>`count(*)` }).from(subscribers)
          .where(and(inArray(subscribers.siteId, branchIds), eq(subscribers.serviceStatus, "active"))).groupBy(subscribers.siteId),
      ]);
      const subscriberCountBySite = new Map(subscriberCounts.map((row) => [row.siteId, Number(row.count ?? 0)]));
      return buildFinancialOverview({
        branches: branchRows.map((branch) => ({ id: branch.id, name: branch.name, activeSubscribers: subscriberCountBySite.get(branch.id) ?? 0 })),
        invoices: invoiceRows.map((row) => ({
          id: row.invoice.id,
          siteId: row.invoice.siteId,
          subscriberId: row.invoice.subscriberId,
          subscriberName: row.subscriber.fullName,
          subscriberNo: row.subscriber.subscriberNo,
          invoiceNo: row.invoice.invoiceNo,
          issueDate: row.invoice.issueDate,
          dueDate: row.invoice.dueDate,
          totalAmount: Number(row.invoice.totalAmount),
          paidAmount: Number(row.invoice.paidAmount),
          balanceDue: Number(row.invoice.balanceDue),
          status: row.invoice.status,
        })),
        payments: paymentRows.map((row) => ({ siteId: row.payment.siteId, subscriberId: row.payment.subscriberId, amount: Number(row.payment.amount), status: row.payment.status, paidAt: row.payment.paidAt })),
        expenses: expenseRows.map((row) => ({ siteId: row.siteId, amount: Number(row.amount), occurredAt: row.occurredAt })),
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
      await resolveRole(ctx.user.id, input.siteId);
      const db = await dbOrThrow();
      const tenantId = await getSiteTenant(input.siteId);
      const [profile] = await db.select({ companyName: tenantOwnerProfiles.companyName, reportLogoKey: tenantOwnerProfiles.reportLogoKey })
        .from(tenantOwnerProfiles).where(eq(tenantOwnerProfiles.tenantId, tenantId)).limit(1);
      const logoUrl = profile?.reportLogoKey ? (await storageGet(profile.reportLogoKey)).url : null;
      return { companyName: profile?.companyName ?? null, reportLogoKey: profile?.reportLogoKey ?? null, logoUrl };
    }),
    update: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(),
      companyName: z.string().trim().min(2).max(180).optional(),
      logoData: z.string().min(20).max(4_500_000).optional(),
      logoMime: z.enum(["image/png", "image/jpeg", "image/webp"]).optional(),
    }).refine((input) => Boolean(input.companyName || (input.logoData && input.logoMime)), { message: "أدخل اسم الشركة أو اختر شعاراً صالحاً للتحديث." }).refine((input) => !input.logoData || Boolean(input.logoMime), { message: "تعذر التعرف إلى نوع ملف الشعار." })).mutation(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner"], "manageTeam");
      const db = await dbOrThrow();
      const tenantId = await getSiteTenant(input.siteId);
      let reportLogoKey: string | undefined;
      if (input.logoData && input.logoMime) {
        const bytes = Buffer.from(input.logoData, "base64");
        if (!bytes.length || bytes.length > 3 * 1024 * 1024) throw new TRPCError({ code: "BAD_REQUEST", message: "يجب ألا يتجاوز حجم شعار التقرير 3 ميغابايت." });
        const extension = input.logoMime === "image/png" ? "png" : input.logoMime === "image/jpeg" ? "jpg" : "webp";
        const uploaded = await storagePut(`tenant-report-branding/${tenantId}/logo-${Date.now()}.${extension}`, bytes, input.logoMime);
        reportLogoKey = uploaded.key;
      }
      const update: { companyName?: string; reportLogoKey?: string } = {};
      if (input.companyName) update.companyName = input.companyName;
      if (reportLogoKey) update.reportLogoKey = reportLogoKey;
      await db.update(tenantOwnerProfiles).set(update).where(eq(tenantOwnerProfiles.tenantId, tenantId));
      await writeAudit({ tenantId, siteId: input.siteId, userId: ctx.user.id, entityType: "tenant_owner_profile", entityId: String(tenantId), action: "update_report_branding", afterData: { companyName: input.companyName, hasReportLogo: Boolean(reportLogoKey) } });
      const [profile] = await db.select({ companyName: tenantOwnerProfiles.companyName, reportLogoKey: tenantOwnerProfiles.reportLogoKey }).from(tenantOwnerProfiles).where(eq(tenantOwnerProfiles.tenantId, tenantId)).limit(1);
      const logoUrl = profile?.reportLogoKey ? (await storageGet(profile.reportLogoKey)).url : null;
      return { companyName: profile?.companyName ?? null, reportLogoKey: profile?.reportLogoKey ?? null, logoUrl };
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
    retry: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), notificationId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      void ctx; void input;
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "إعادة محاولة الإشعارات معطّلة حالياً إلى أن تكتمل خدمة إرسال مستقلة متوافقة مع Supabase/Vercel." });
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "manageMessaging");
      const db = await dbOrThrow();
      const [notificationScope] = await db.select({ id: notificationMessages.id, status: notificationMessages.status }).from(notificationMessages)
        .innerJoin(subscribers, eq(notificationMessages.subscriberId, subscribers.id))
        .where(and(eq(notificationMessages.id, input.notificationId), eq(subscribers.siteId, input.siteId))).limit(1);
      if (!notificationScope) throw new TRPCError({ code: "NOT_FOUND", message: "رسالة الإشعار لا تتبع للمحطة المحددة." });
      if (notificationScope.status !== "failed") throw new TRPCError({ code: "BAD_REQUEST", message: "يمكن إعادة محاولة الرسائل الفاشلة فقط." });
      await db.update(notificationMessages).set({ status: "pending", lastError: null }).where(eq(notificationMessages.id, input.notificationId));
      await writeAudit({ userId: ctx.user.id, siteId: input.siteId, entityType: "notification_message", entityId: String(input.notificationId), action: "retry", metadata: { previousStatus: "failed" } });
      return { success: true };
    }),
    retryFailedInvoiceNotification: protectedProcedure.input(retryFailedInvoiceNotificationInput).mutation(async ({ ctx, input }) => {
      void ctx; void input;
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "إعادة إرسال الفواتير معطّلة حالياً إلى أن تكتمل خدمة إرسال مستقلة متوافقة مع Supabase/Vercel." });
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "manageMessaging");
      const db = await dbOrThrow();
      const [scope] = await db.select({ id: notificationMessages.id, status: notificationMessages.status, invoiceId: notificationMessages.invoiceId, invoiceNo: invoices.invoiceNo })
        .from(notificationMessages)
        .innerJoin(invoices, eq(notificationMessages.invoiceId, invoices.id))
        .innerJoin(subscribers, eq(notificationMessages.subscriberId, subscribers.id))
        .where(and(eq(notificationMessages.id, input.notificationId), eq(notificationMessages.eventType, "invoice_issued"), eq(notificationMessages.status, "failed"), eq(subscribers.siteId, input.siteId)))
        .limit(1);
      if (!scope) throw new TRPCError({ code: "NOT_FOUND", message: "لا يوجد إشعار فاتورة فاشل يتبع للفرع المحدد." });
      await db.update(notificationMessages).set({ status: "pending", lastError: null }).where(eq(notificationMessages.id, input.notificationId));
      let dispatch: { status: string; error?: string | null };
      try { dispatch = await processNotificationById(input.notificationId); }
      catch (error: any) { dispatch = { status: "failed", error: error instanceof Error ? error.message : "تعذر إعادة إرسال إشعار الفاتورة." }; }
      await writeAudit({ userId: ctx.user.id, siteId: input.siteId, entityType: "notification_message", entityId: String(input.notificationId), action: "retry_failed_invoice_notification", metadata: { invoiceId: scope.invoiceId, invoiceNo: scope.invoiceNo, dispatchStatus: dispatch.status, error: dispatch.error ?? null, source: "bulk_invoice_send_details" } });
      return { notificationId: input.notificationId, status: dispatch.status, error: dispatch.error ?? null };
    }),
    retryFailedInvoiceNotifications: protectedProcedure.input(retryFailedInvoiceNotificationsInput).mutation(async ({ ctx, input }) => {
      void ctx; void input;
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "إعادة الإرسال الجماعي للفواتير معطّلة حالياً إلى أن تكتمل خدمة إرسال مستقلة متوافقة مع Supabase/Vercel." });
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "manageMessaging");
      const db = await dbOrThrow();
      const notificationIds = Array.from(new Set(input.notificationIds));
      const rows = await db.select({ id: notificationMessages.id, invoiceId: notificationMessages.invoiceId, invoiceNo: invoices.invoiceNo })
        .from(notificationMessages)
        .innerJoin(invoices, eq(notificationMessages.invoiceId, invoices.id))
        .innerJoin(subscribers, eq(notificationMessages.subscriberId, subscribers.id))
        .where(and(inArray(notificationMessages.id, notificationIds), eq(notificationMessages.eventType, "invoice_issued"), eq(notificationMessages.status, "failed"), eq(subscribers.siteId, input.siteId)));
      const results = await Promise.all(rows.map(async (row) => {
        await db.update(notificationMessages).set({ status: "pending", lastError: null }).where(and(eq(notificationMessages.id, row.id), eq(notificationMessages.status, "failed")));
        try {
          const dispatch = await processNotificationById(row.id);
          return { notificationId: row.id, invoiceId: row.invoiceId, invoiceNo: row.invoiceNo, status: dispatch.status === "failed" ? "failed" as const : "submitted" as const, error: dispatch.error ?? null };
        } catch (error) {
          return { notificationId: row.id, invoiceId: row.invoiceId, invoiceNo: row.invoiceNo, status: "failed" as const, error: error instanceof Error ? error.message : "تعذر إعادة إرسال إشعار الفاتورة." };
        }
      }));
      await writeAudit({ userId: ctx.user.id, siteId: input.siteId, entityType: "notification_batch", entityId: rows.map((row) => row.id).join(",") || "none", action: "retry_failed_invoice_notifications", metadata: { requested: notificationIds.length, retried: rows.length, submitted: results.filter((item) => item.status === "submitted").length, failed: results.filter((item) => item.status === "failed").length, source: "bulk_invoice_send_details" } });
      return { requested: notificationIds.length, retried: rows.length, submitted: results.filter((item) => item.status === "submitted").length, failed: results.filter((item) => item.status === "failed").length, results };
    }),
    retryPaymentReceipt: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), notificationId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      void ctx; void input;
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "إعادة إرسال إيصالات الدفع معطّلة حالياً إلى أن تكتمل خدمة إرسال مستقلة متوافقة مع Supabase/Vercel." });
      await requireRole(ctx.user.id, input.siteId, ["owner"], "manageMessaging");
      const db = await dbOrThrow();
      const [scope] = await db.select({ id: notificationMessages.id, status: notificationMessages.status }).from(notificationMessages)
        .innerJoin(subscribers, eq(notificationMessages.subscriberId, subscribers.id))
        .where(and(eq(notificationMessages.id, input.notificationId), eq(notificationMessages.eventType, "payment_received"), eq(subscribers.siteId, input.siteId))).limit(1);
      if (!scope) throw new TRPCError({ code: "NOT_FOUND", message: "إيصال الدفع لا يتبع للمحطة المحددة." });
      if (scope.status !== "failed") throw new TRPCError({ code: "BAD_REQUEST", message: "يمكن إعادة إرسال الإيصالات الفاشلة فقط." });
      await db.update(notificationMessages).set({ status: "pending", lastError: null }).where(eq(notificationMessages.id, input.notificationId));
      await writeAudit({ userId: ctx.user.id, siteId: input.siteId, entityType: "notification_message", entityId: String(input.notificationId), action: "retry_payment_receipt", metadata: { previousStatus: "failed" } });
      return { notificationId: input.notificationId, ...await processNotificationById(input.notificationId) };
    }),
    sendDeferredInvoices: protectedProcedure.input(sendDeferredInvoiceNotificationsInput).mutation(async ({ ctx, input }) => {
      void ctx; void input;
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "إرسال الفواتير المؤجلة معطّل حالياً إلى أن تكتمل خدمة إرسال مستقلة متوافقة مع Supabase/Vercel." });
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "manageMessaging");
      const db = await dbOrThrow();
      const selectedIds = input.invoiceIds ? Array.from(new Set(input.invoiceIds)) : undefined;
      const rows = selectedIds
        ? await queueInvoiceNotificationsForSelection(db, { siteId: input.siteId, invoiceIds: selectedIds! })
        : await db.select({ notificationId: notificationMessages.id, invoiceId: invoices.id, invoiceNo: invoices.invoiceNo })
          .from(notificationMessages).innerJoin(subscribers, eq(notificationMessages.subscriberId, subscribers.id)).innerJoin(invoices, eq(notificationMessages.invoiceId, invoices.id))
          .where(and(eq(subscribers.siteId, input.siteId), eq(notificationMessages.eventType, "invoice_issued"), eq(notificationMessages.status, "pending"))).orderBy(notificationMessages.createdAt).limit(input.limit);
      const results = await Promise.all(rows.map(async (row) => {
        try { const dispatch = await processNotificationById(row.notificationId); return { ...row, status: dispatch.status === "failed" ? "failed" as const : "submitted" as const, message: dispatch.error ?? "تمت معالجة الإشعار." }; }
        catch (error) { return { ...row, status: "failed" as const, message: error instanceof Error ? error.message : "تعذر إرسال الإشعار." }; }
      }));
      await writeAudit({ userId: ctx.user.id, siteId: input.siteId, entityType: "notification_batch", entityId: rows.map((row) => row.notificationId).join(",") || "none", action: "send_deferred_invoice_notifications", metadata: { selectedInvoiceIds: selectedIds, notificationIds: rows.map((row) => row.notificationId), requested: rows.length, submitted: results.filter((row) => row.status === "submitted").length, failed: results.filter((row) => row.status === "failed").length } });
      return { requested: rows.length, submitted: results.filter((row) => row.status === "submitted").length, failed: results.filter((row) => row.status === "failed").length, results };
    }),
    sendBulkInvoiceSms: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), invoiceIds: z.array(z.number().int().positive()).min(1).max(200) })).mutation(async ({ ctx, input }) => {
      void ctx; void input;
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "إرسال فواتير SMS الجماعي معطّل حالياً إلى أن تكتمل خدمة إرسال مستقلة متوافقة مع Supabase/Vercel." });
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "manageMessaging");
      const db = await dbOrThrow();
      const ids = Array.from(new Set(input.invoiceIds));
      const [site] = await db.select({ id: sites.id, tenantId: sites.tenantId }).from(sites).where(eq(sites.id, input.siteId)).limit(1);
      if (!site) throw new TRPCError({ code: "NOT_FOUND", message: "المحطة غير موجودة." });
      const [platformSetting] = await db.select({ isEnabled: platformSettings.isEnabled, value: platformSettings.value }).from(platformSettings).where(eq(platformSettings.settingKey, "invoice_delivery_channels")).limit(1);
      if (!platformSetting || !isInvoiceDeliveryChannelEnabled("sms", invoiceDeliveryPolicyFromSetting(platformSetting))) throw new TRPCError({ code: "FORBIDDEN", message: "إرسال SMS معطل من إعدادات آدمن PowerHub." });
      const [configuration] = await db.select({ id: tenantMessagingConfigurations.id, provider: tenantMessagingConfigurations.provider, isActive: tenantMessagingConfigurations.isActive }).from(tenantMessagingConfigurations).where(and(eq(tenantMessagingConfigurations.tenantId, site.tenantId), eq(tenantMessagingConfigurations.channel, "sms"), eq(tenantMessagingConfigurations.isActive, true))).limit(1);
      if (!configuration || configuration.provider !== "jawwal_bulk_sms") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "احفظ إعداد SMS لشركة جوال أولاً قبل الإرسال الجماعي." });
      const rows = await db.select({ invoice: invoices, subscriber: subscribers }).from(invoices).innerJoin(subscribers, eq(invoices.subscriberId, subscribers.id)).where(and(eq(invoices.siteId, input.siteId), inArray(invoices.id, ids))).limit(200);
      const [[quota], [usage], [extra]] = await Promise.all([
        db.select({ included: platformSmsPlans.includedMessages }).from(tenantSubscriptions).leftJoin(platformSmsPlans, eq(tenantSubscriptions.smsPlanId, platformSmsPlans.id)).where(eq(tenantSubscriptions.tenantId, site.tenantId)).limit(1),
        db.select({ used: sql<number>`count(*)` }).from(notificationMessages).where(and(eq(notificationMessages.tenantId, site.tenantId), eq(notificationMessages.channel, "sms"))),
        db.select({ approved: sql<number>`coalesce(sum(${smsPackageRequests.approvedMessages}), 0)` }).from(smsPackageRequests).where(and(eq(smsPackageRequests.tenantId, site.tenantId), eq(smsPackageRequests.status, "approved"))),
      ]);
      const remainingSms = Number(quota?.included ?? 0) + Number(extra?.approved ?? 0) - Number(usage?.used ?? 0);
      if (remainingSms < rows.length) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `لا يكفي رصيد SMS لإرسال ${rows.length} فاتورة. المتبقي: ${Math.max(0, remainingSms)} رسالة. اطلب حزمة إضافية من إعدادات المراسلة.` });
      const results = await Promise.all(rows.map(async ({ invoice, subscriber }) => {
        if (!subscriber.phone) return { invoiceId: invoice.id, invoiceNo: invoice.invoiceNo, status: "failed" as const, message: "لا يوجد رقم هاتف مسجل للمشترك." };
        if (["draft", "cancelled"].includes(invoice.status)) return { invoiceId: invoice.id, invoiceNo: invoice.invoiceNo, status: "skipped" as const, message: "الفاتورة غير صالحة للإرسال." };
        let recipient: string;
        try { recipient = normalizeInternationalPhone(subscriber.phone); } catch (error) { return { invoiceId: invoice.id, invoiceNo: invoice.invoiceNo, status: "failed" as const, message: error instanceof Error ? `رقم الهاتف غير صالح: ${error.message}` : "رقم الهاتف غير صالح." }; }
        const [existing] = await db.select({ id: notificationMessages.id, status: notificationMessages.status }).from(notificationMessages).where(and(eq(notificationMessages.invoiceId, invoice.id), eq(notificationMessages.channel, "sms"), eq(notificationMessages.eventType, "invoice_issued"))).orderBy(desc(notificationMessages.createdAt)).limit(1);
        let notificationId = existing?.id;
        if (notificationId) await db.update(notificationMessages).set({ status: "pending", lastError: null, recipient }).where(eq(notificationMessages.id, notificationId));
        else notificationId = insertId(await db.insert(notificationMessages).values({ tenantId: site.tenantId, invoiceId: invoice.id, subscriberId: subscriber.id, channel: "sms", eventType: "invoice_issued", recipient, status: "pending", payload: { invoiceNo: invoice.invoiceNo, billingPeriod: invoice.billingPeriod, totalAmount: invoice.totalAmount, bulkRequested: true } }));
        try {
          const dispatch = await processNotificationById(notificationId);
          return { invoiceId: invoice.id, invoiceNo: invoice.invoiceNo, notificationId, status: dispatch.status === "failed" ? "failed" as const : "submitted" as const, message: dispatch.error ?? "تمت معالجة الرسالة." };
        } catch (error) { return { invoiceId: invoice.id, invoiceNo: invoice.invoiceNo, notificationId, status: "failed" as const, message: error instanceof Error ? error.message : "تعذر إرسال الرسالة." }; }
      }));
      await writeAudit({ userId: ctx.user.id, siteId: input.siteId, entityType: "notification_batch", entityId: ids.join(","), action: "send_invoice_sms_batch", metadata: { notificationIds: results.flatMap((item) => typeof item.notificationId === "number" ? [item.notificationId] : []), requested: ids.length, processed: results.length, successful: results.filter((item) => item.status === "submitted").length, failed: results.filter((item) => item.status === "failed").length } });
      return { requested: ids.length, processed: results.length, successful: results.filter((item) => item.status === "submitted").length, failed: results.filter((item) => item.status === "failed").length, skipped: ids.length - results.length, results };
    }),
    sendPaymentReminder: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), invoiceId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      void ctx; void input;
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "إرسال تذكيرات السداد معطّل حالياً إلى أن تكتمل خدمة إرسال مستقلة متوافقة مع Supabase/Vercel." });
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "manageMessaging");
      const db = await dbOrThrow();
      const [scope] = await db.select({ invoice: invoices, subscriber: subscribers, site: sites }).from(invoices)
        .innerJoin(subscribers, eq(invoices.subscriberId, subscribers.id))
        .innerJoin(sites, eq(invoices.siteId, sites.id))
        .where(and(eq(invoices.id, input.invoiceId), eq(invoices.siteId, input.siteId))).limit(1);
      if (!scope || !scope.subscriber.phone) throw new TRPCError({ code: "NOT_FOUND", message: "الفاتورة أو بيانات المشترك لا تتبع للفرع المحدد." });
      if (["paid", "cancelled", "draft"].includes(scope.invoice.status) || Number(scope.invoice.balanceDue) <= 0) throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن إرسال تذكير لفاتورة مسددة أو لا تحمل رصيداً مستحقاً." });
      let recipient: string;
      try { recipient = normalizeInternationalPhone(scope.subscriber.phone); } catch (error: any) { throw new TRPCError({ code: "PRECONDITION_FAILED", message: error instanceof Error ? `عدّل رقم هاتف المشترك قبل الإرسال. ${error.message}` : "عدّل رقم هاتف المشترك إلى صيغة دولية قبل الإرسال." }); }
      const [tenantMessaging, platformDeliverySettings, tenantTemplates] = await Promise.all([
        db.select({ channel: tenantMessagingConfigurations.channel, isActive: tenantMessagingConfigurations.isActive }).from(tenantMessagingConfigurations).where(eq(tenantMessagingConfigurations.tenantId, scope.site.tenantId)),
        db.select({ isEnabled: platformSettings.isEnabled, value: platformSettings.value }).from(platformSettings).where(eq(platformSettings.settingKey, "invoice_delivery_channels")).limit(1),
        db.select({ channel: tenantInvoiceMessageTemplates.channel, body: tenantInvoiceMessageTemplates.body, isActive: tenantInvoiceMessageTemplates.isActive }).from(tenantInvoiceMessageTemplates).where(and(eq(tenantInvoiceMessageTemplates.tenantId, scope.site.tenantId), eq(tenantInvoiceMessageTemplates.eventType, "invoice_issued"))),
      ]);
      const channels = resolveInvoiceNotificationChannels(tenantMessaging, invoiceDeliveryPolicyFromSetting(platformDeliverySettings[0]));
      if (!channels.length) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "لا توجد قناة WhatsApp أو SMS مفعلة ومتاحة لإرسال التذكير." });
      const templates = new Map(tenantTemplates.filter((template) => template.isActive).map((template) => [template.channel, template.body]));
      const values = { subscriber_name: scope.subscriber.fullName, invoice_no: scope.invoice.invoiceNo, billing_period: scope.invoice.billingPeriod, total_amount: String(scope.invoice.balanceDue), due_date: scope.invoice.dueDate.toLocaleDateString("ar-IQ") };
      const notificationIds: number[] = [];
      for (const channel of channels) notificationIds.push(insertId(await db.insert(notificationMessages).values({ tenantId: scope.site.tenantId, invoiceId: scope.invoice.id, subscriberId: scope.subscriber.id, channel, eventType: "payment_reminder", recipient, status: "pending", payload: { invoiceNo: scope.invoice.invoiceNo, renderedText: `تذكير بالسداد: ${renderInvoiceMessageTemplate(templates.get(channel) ?? defaultInvoiceMessageTemplates[channel], values)}`, invoiceTemplateParameters: [values.subscriber_name, values.invoice_no, values.billing_period, values.total_amount, values.due_date], reminder: true } })));
      await writeAudit({ userId: ctx.user.id, siteId: input.siteId, entityType: "notification_message", entityId: notificationIds.join(","), action: "send_payment_reminder", metadata: { invoiceId: scope.invoice.id, subscriberId: scope.subscriber.id, channels, recipient } });
      return { notificationIds, channels, recipient };
    }),
    sendPaymentReceipt: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), paymentId: z.number().int().positive(), channel: z.enum(["whatsapp", "sms"]) })).mutation(async ({ ctx, input }) => {
      void ctx; void input;
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "إرسال إيصالات الدفع معطّل حالياً إلى أن تكتمل خدمة إرسال مستقلة متوافقة مع Supabase/Vercel." });
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "manageMessaging");
      const db = await dbOrThrow();
      const [scope] = await db.select({ payment: payments, invoice: invoices, subscriber: subscribers, site: sites }).from(payments)
        .innerJoin(subscribers, eq(payments.subscriberId, subscribers.id))
        .innerJoin(invoices, eq(payments.invoiceId, invoices.id))
        .innerJoin(sites, eq(payments.siteId, sites.id))
        .where(and(eq(payments.id, input.paymentId), eq(payments.siteId, input.siteId), eq(payments.status, "completed"))).limit(1);
      if (!scope || !scope.invoice || !scope.subscriber.phone) throw new TRPCError({ code: "NOT_FOUND", message: "لا تتوفر دفعة مكتملة مرتبطة بفاتورة ومشترك ضمن المحطة المحددة." });
      let recipient: string;
      try {
        recipient = normalizeInternationalPhone(scope.subscriber.phone);
      } catch (error: any) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: error instanceof Error ? `عدّل رقم هاتف المشترك قبل الإرسال. ${error.message}` : "عدّل رقم هاتف المشترك إلى صيغة دولية قبل الإرسال." });
      }
      const [platformSetting] = await db.select({ isEnabled: platformSettings.isEnabled, value: platformSettings.value }).from(platformSettings)
        .where(eq(platformSettings.settingKey, "invoice_delivery_channels")).limit(1);
      if (!platformSetting || !isInvoiceDeliveryChannelEnabled(input.channel, invoiceDeliveryPolicyFromSetting(platformSetting))) throw new TRPCError({ code: "FORBIDDEN", message: `إرسال الإيصال عبر ${input.channel === "whatsapp" ? "WhatsApp" : "SMS"} معطل من إعدادات آدمن PowerHub.` });
      const [configuration] = await db.select().from(tenantMessagingConfigurations).where(and(eq(tenantMessagingConfigurations.tenantId, scope.site.tenantId), eq(tenantMessagingConfigurations.channel, input.channel), eq(tenantMessagingConfigurations.isActive, true))).limit(1);
      if (!configuration?.credentialCiphertext || !configuration.credentialIv) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `لا توجد بيانات ربط فعالة لقناة ${input.channel === "whatsapp" ? "WhatsApp" : "SMS"} لهذه المحطة.` });
      if (input.channel === "whatsapp" && (configuration.provider !== "meta_whatsapp_cloud" || !configuration.phoneNumberId || !configuration.receiptTemplateName)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "أدخل Phone Number ID واسم قالب إيصال الدفع المعتمد من Meta قبل إرسال الإيصال عبر WhatsApp." });
      if (input.channel === "sms" && (configuration.provider !== "jawwal_bulk_sms" || !configuration.phoneNumberId || !configuration.senderId)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "إرسال SMS الفعلي سيُفعّل عبر شركة جوال بعد إدخال Client ID واسم المرسل وبيانات API الرسمية." });
      const receipt = { subscriberName: scope.subscriber.fullName, paymentNo: scope.payment.paymentNo, paymentAmount: Number(scope.payment.amount), invoiceNo: scope.invoice.invoiceNo, balanceDue: Number(scope.invoice.balanceDue) };
      const [smsTemplate] = await db.select().from(tenantPaymentReceiptMessageTemplates).where(and(eq(tenantPaymentReceiptMessageTemplates.tenantId, scope.site.tenantId), eq(tenantPaymentReceiptMessageTemplates.channel, "sms"), eq(tenantPaymentReceiptMessageTemplates.isActive, true))).limit(1);
      const renderedSmsText = renderPaymentReceiptTemplate(smsTemplate?.body ?? defaultPaymentReceiptSmsTemplate, receipt);
      const notificationId = insertId(await db.insert(notificationMessages).values({ tenantId: scope.site.tenantId, invoiceId: scope.invoice.id, subscriberId: scope.subscriber.id, channel: input.channel, eventType: "payment_received", recipient, status: "pending", payload: { renderedText: renderedSmsText || renderPaymentReceiptMessage(receipt), receiptTemplateParameters: paymentReceiptTemplateParameters(receipt), paymentNo: receipt.paymentNo, invoiceNo: receipt.invoiceNo } }));
      await writeAudit({ userId: ctx.user.id, siteId: input.siteId, entityType: "notification_message", entityId: String(notificationId), action: "send_payment_receipt", metadata: { channel: input.channel, recipient, paymentId: scope.payment.id, invoiceId: scope.invoice.id } });
      const dispatch = await processNotificationById(notificationId);
      return { notificationId, recipient, channel: input.channel, ...dispatch };
    }),
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
    create: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), name: z.string().trim().min(2).max(120), accountType: z.enum(["cash", "jawwal_pay", "palpay", "bank_of_palestine", "other"]), phoneNumber: z.string().trim().regex(/^\+?[0-9]{7,20}$/, "أدخل رقم جوال صحيحاً."), openingBalance: z.number().nonnegative().default(0), color: z.string().trim().max(20).optional(), siteIds: z.array(z.number().int().positive()).min(1) })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager"], "manageExpenses");
      const { data, error } = await supabaseAdmin().rpc("powerhub_create_company_account", { p_tenant_id: access.tenantId, p_site_id: input.siteId, p_user_id: ctx.user.id, p_name: input.name, p_account_type: input.accountType, p_phone_number: input.phoneNumber, p_opening_balance: input.openingBalance, p_color: input.color ?? "#64748b", p_site_ids: input.siteIds });
      if (!error && data?.[0]) return { id: Number((data[0] as { account_id: number | string }).account_id) };
      const errorText = `${error?.code ?? ""} ${error?.message ?? ""}`;
      if (errorText.includes("ACCOUNT_SITE_OUT_OF_SCOPE")) throw new TRPCError({ code: "FORBIDDEN", message: "أحد الفروع المحددة لا يتبع مساحة الشركة." });
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
    addMovement: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), accountId: z.number().int().positive(), transactionType: z.enum(["deposit", "withdrawal"]), amount: z.number().positive(), description: z.string().trim().min(2).max(255), referenceNo: z.string().trim().max(120).optional() })).mutation(async ({ ctx, input }) => {
      const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "manageExpenses");
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
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "managePayroll"); const tenantId = await getSiteTenant(input.siteId); const db = await dbOrThrow(); const conditions = [eq(employeeAttendance.tenantId, tenantId), eq(employeeAttendance.siteId, input.siteId)]; if (input.employeeId) conditions.push(eq(employeeAttendance.employeeId, input.employeeId)); if (input.fromDate) conditions.push(gte(employeeAttendance.workDate, new Date(input.fromDate))); if (input.toDate) conditions.push(lte(employeeAttendance.workDate, new Date(input.toDate))); return db.select({ attendance: employeeAttendance, employee: employees }).from(employeeAttendance).innerJoin(employees, eq(employeeAttendance.employeeId, employees.id)).where(and(...conditions)).orderBy(desc(employeeAttendance.workDate)).limit(1000);
    }),
    upsertAttendance: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), employeeId: z.number().int().positive(), workDate: z.string(), regularHours: z.number().min(0).max(24).default(0), overtimeHours: z.number().min(0).max(24).default(0), absentDays: z.number().min(0).max(1).default(0), notes: z.string().trim().max(500).optional() })).mutation(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner", "accountant"], "managePayroll"); const tenantId = await getSiteTenant(input.siteId); const db = await dbOrThrow(); const date = new Date(input.workDate); if (Number.isNaN(date.getTime())) throw new TRPCError({ code: "BAD_REQUEST", message: "تاريخ الحضور غير صحيح." }); const [employee] = await db.select({ id: employees.id }).from(employees).where(and(eq(employees.id, input.employeeId), eq(employees.tenantId, tenantId), or(eq(employees.siteId, input.siteId), isNull(employees.siteId)))).limit(1); if (!employee) throw new TRPCError({ code: "NOT_FOUND", message: "الموظف غير موجود ضمن الفرع." }); const [existing] = await db.select({ id: employeeAttendance.id }).from(employeeAttendance).where(and(eq(employeeAttendance.employeeId, input.employeeId), eq(employeeAttendance.workDate, date))).limit(1); const values = { tenantId, employeeId: input.employeeId, siteId: input.siteId, workDate: date, regularHours: String(input.regularHours), overtimeHours: String(input.overtimeHours), absentDays: String(input.absentDays), notes: input.notes || null, createdByUserId: ctx.user.id, updatedAt: new Date() }; if (existing) await db.update(employeeAttendance).set(values).where(eq(employeeAttendance.id, existing.id)); else insertId(await db.insert(employeeAttendance).values(values)); await writeAudit({ userId: ctx.user.id, siteId: input.siteId, entityType: "employee_attendance", entityId: String(existing?.id ?? "new"), action: existing ? "update" : "create", afterData: input }); return { success: true };
    }),
    overview: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), period: z.string().regex(/^\\d{4}-(0[1-9]|1[0-2])$/).optional() })).query(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "viewAudit"); const tenantId = await getSiteTenant(input.siteId); const db = await dbOrThrow(); const employeeRows = await db.select({ status: employees.employmentStatus, count: sql<number>`count(*)`, wages: sql<number>`coalesce(sum(${employees.baseWage}),0)` }).from(employees).where(and(eq(employees.tenantId, tenantId), or(eq(employees.siteId, input.siteId), isNull(employees.siteId)))).groupBy(employees.employmentStatus); const payrollRows = await db.select({ totalNet: sql<number>`coalesce(sum(${payrollRuns.totalNet}),0)`, totalGross: sql<number>`coalesce(sum(${payrollRuns.totalGross}),0)`, totalDeductions: sql<number>`coalesce(sum(${payrollRuns.totalDeductions}),0)`, count: sql<number>`count(*)` }).from(payrollRuns).where(and(eq(payrollRuns.tenantId, tenantId), eq(payrollRuns.siteId, input.siteId), ...(input.period ? [eq(payrollRuns.period, input.period)] : []))); return { employees: employeeRows, payroll: payrollRows[0] ?? { totalNet: 0, totalGross: 0, totalDeductions: 0, count: 0 } };
    }),
    listEmployees: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), search: z.string().trim().max(120).optional(), employmentStatus: z.enum(["active", "suspended", "ended"]).optional(), jobTitle: z.enum(["accountant", "collector", "technician", "worker", "supervisor", "other"]).optional() })).query(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager"], "manageTeam"); const tenantId = await getSiteTenant(input.siteId); const db = await dbOrThrow();
      const conditions = [eq(employees.tenantId, tenantId), or(eq(employees.siteId, input.siteId), isNull(employees.siteId))];
      if (input.employmentStatus) conditions.push(eq(employees.employmentStatus, input.employmentStatus));
      if (input.jobTitle) conditions.push(eq(employees.jobTitle, input.jobTitle));
      if (input.search) conditions.push(or(sql`${employees.fullName} like ${`%${input.search}%`}`, sql`${employees.phone} like ${`%${input.search}%`}`));
      return db.select().from(employees).where(and(...conditions)).orderBy(desc(employees.createdAt)).limit(500);
    }),
    createEmployee: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), fullName: z.string().trim().min(2).max(180), identityNo: z.string().trim().max(80).optional(), phone: z.string().trim().max(40).optional(), jobTitle: z.enum(["accountant", "collector", "technician", "worker", "supervisor", "other"]), employmentStatus: z.enum(["active", "suspended", "ended"]).default("active"), contractType: z.enum(["daily", "monthly", "collection_percentage"]), baseWage: z.number().min(0).max(100000000), hireDate: z.string().optional(), notes: z.string().trim().max(2000).optional(), linkedUserId: z.number().int().positive().optional() })).mutation(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner"], "manageTeam"); const tenantId = await getSiteTenant(input.siteId); const db = await dbOrThrow();
      const [site] = await db.select({ id: sites.id }).from(sites).where(and(eq(sites.id, input.siteId), eq(sites.tenantId, tenantId))).limit(1); if (!site) throw new TRPCError({ code: "FORBIDDEN", message: "الفرع غير تابع لمساحة الشركة." });
      if (input.linkedUserId) { const [account] = await db.select({ id: tenantMembers.userId }).from(tenantMembers).where(and(eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.userId, input.linkedUserId), eq(tenantMembers.isActive, true))).limit(1); if (!account) throw new TRPCError({ code: "FORBIDDEN", message: "حساب الدخول المحدد ليس ضمن مساحة الشركة." }); }
      const id = insertId(await db.insert(employees).values({ tenantId, siteId: input.siteId, linkedUserId: input.linkedUserId || null, fullName: input.fullName, identityNo: input.identityNo || null, phone: input.phone || null, jobTitle: input.jobTitle, employmentStatus: input.employmentStatus, contractType: input.contractType, baseWage: String(input.baseWage), hireDate: input.hireDate ? new Date(input.hireDate) : null, notes: input.notes || null }));
      await writeAudit({ userId: ctx.user.id, siteId: input.siteId, entityType: "employee", entityId: String(id), action: "create", afterData: input }); return { id };
    }),
    listAdjustments: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), employeeId: z.number().int().positive().optional(), status: z.enum(["open", "settled", "cancelled"]).optional() })).query(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "manageExpenses"); const tenantId = await getSiteTenant(input.siteId); const db = await dbOrThrow();
      const conditions = [eq(employeeAdjustments.tenantId, tenantId), or(eq(employeeAdjustments.siteId, input.siteId), isNull(employeeAdjustments.siteId))]; if (input.employeeId) conditions.push(eq(employeeAdjustments.employeeId, input.employeeId)); if (input.status) conditions.push(eq(employeeAdjustments.status, input.status));
      return db.select({ adjustment: employeeAdjustments, employee: employees }).from(employeeAdjustments).innerJoin(employees, eq(employeeAdjustments.employeeId, employees.id)).where(and(...conditions)).orderBy(desc(employeeAdjustments.createdAt)).limit(500);
    }),
    createAdjustment: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), employeeId: z.number().int().positive(), adjustmentType: z.enum(["advance", "deduction"]), amount: z.number().positive().max(100000000), reason: z.string().trim().min(3).max(255) })).mutation(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner", "accountant"], "manageExpenses"); const tenantId = await getSiteTenant(input.siteId); const db = await dbOrThrow(); const [employee] = await db.select({ id: employees.id }).from(employees).where(and(eq(employees.id, input.employeeId), eq(employees.tenantId, tenantId), or(eq(employees.siteId, input.siteId), isNull(employees.siteId)))).limit(1); if (!employee) throw new TRPCError({ code: "NOT_FOUND", message: "الموظف غير موجود ضمن نطاقك." });
      const id = insertId(await db.insert(employeeAdjustments).values({ tenantId, employeeId: input.employeeId, siteId: input.siteId, adjustmentType: input.adjustmentType, amount: String(input.amount), remainingAmount: String(input.amount), reason: input.reason, createdByUserId: ctx.user.id })); await writeAudit({ userId: ctx.user.id, siteId: input.siteId, entityType: "employee_adjustment", entityId: String(id), action: "create", afterData: input }); return { id };
    }),
    getPayrollDetails: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), payrollRunId: z.number().int().positive() })).query(async ({ ctx, input }) => { await requireRole(ctx.user.id, input.siteId, ["owner", "accountant"], "managePayroll"); const tenantId = await getSiteTenant(input.siteId); const db = await dbOrThrow(); return db.select({ item: payrollItems, employee: { id: employees.id, fullName: employees.fullName, jobTitle: employees.jobTitle } }).from(payrollItems).innerJoin(employees, eq(employees.id, payrollItems.employeeId)).innerJoin(payrollRuns, eq(payrollRuns.id, payrollItems.payrollRunId)).where(and(eq(payrollItems.payrollRunId, input.payrollRunId), eq(payrollRuns.tenantId, tenantId), eq(payrollRuns.siteId, input.siteId))).orderBy(employees.fullName).limit(500); }),
    listPayrollRuns: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), period: z.string().regex(/^\\d{4}-(0[1-9]|1[0-2])$/).optional() })).query(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner", "accountant"], "managePayroll"); const tenantId = await getSiteTenant(input.siteId); const db = await dbOrThrow(); const conditions = [eq(payrollRuns.tenantId, tenantId), or(eq(payrollRuns.siteId, input.siteId), isNull(payrollRuns.siteId))]; if (input.period) conditions.push(eq(payrollRuns.period, input.period)); return db.select().from(payrollRuns).where(and(...conditions)).orderBy(desc(payrollRuns.period)).limit(120);
    }),
    createPayrollDraft: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), period: z.string().regex(/^\\d{4}-(0[1-9]|1[0-2])$/), items: z.array(z.object({ employeeId: z.number().int().positive(), extraAmount: z.number().min(0).default(0), advanceDeduction: z.number().min(0).default(0), otherDeduction: z.number().min(0).default(0), notes: z.string().trim().max(500).optional() })).min(1) })).mutation(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner", "accountant"], "managePayroll"); const tenantId = await getSiteTenant(input.siteId); const db = await dbOrThrow(); const employeeIds = input.items.map((item) => item.employeeId); const openAdvances = await db.select({ employeeId: employeeAdjustments.employeeId, amount: employeeAdjustments.remainingAmount }).from(employeeAdjustments).where(and(eq(employeeAdjustments.tenantId, tenantId), eq(employeeAdjustments.siteId, input.siteId), eq(employeeAdjustments.adjustmentType, "advance"), eq(employeeAdjustments.status, "open"), inArray(employeeAdjustments.employeeId, employeeIds))); const advanceByEmployee = new Map<number, number>(); for (const advance of openAdvances) advanceByEmployee.set(advance.employeeId, (advanceByEmployee.get(advance.employeeId) ?? 0) + Number(advance.amount)); const people = await db.select({ id: employees.id, baseWage: employees.baseWage }).from(employees).where(and(eq(employees.tenantId, tenantId), or(eq(employees.siteId, input.siteId), isNull(employees.siteId)), eq(employees.employmentStatus, "active"), inArray(employees.id, employeeIds))); if (people.length !== employeeIds.length) throw new TRPCError({ code: "BAD_REQUEST", message: "توجد موظفة أو موظف غير نشط أو خارج الفرع المحدد." }); const wages = new Map(people.map((person) => [person.id, Number(person.baseWage)])); const rows = input.items.map((item) => { const baseAmount = wages.get(item.employeeId) ?? 0; const advanceDeduction = Math.min(item.advanceDeduction + (advanceByEmployee.get(item.employeeId) ?? 0), baseAmount + item.extraAmount); const netAmount = baseAmount + item.extraAmount - advanceDeduction - item.otherDeduction; if (netAmount < 0) throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن أن يكون صافي راتب الموظف سالباً." }); return { employeeId: item.employeeId, baseAmount, extraAmount: item.extraAmount, advanceDeduction, otherDeduction: item.otherDeduction, netAmount, notes: item.notes }; }); const totalGross = rows.reduce((sum, row) => sum + row.baseAmount + row.extraAmount, 0); const totalDeductions = rows.reduce((sum, row) => sum + row.advanceDeduction + row.otherDeduction, 0); const totalNet = rows.reduce((sum, row) => sum + row.netAmount, 0); const id = insertId(await db.insert(payrollRuns).values({ tenantId, siteId: input.siteId, period: input.period, status: "draft", totalGross: String(totalGross), totalDeductions: String(totalDeductions), totalNet: String(totalNet), createdByUserId: ctx.user.id })); await db.insert(payrollItems).values(rows.map((row) => ({ payrollRunId: id, employeeId: row.employeeId, baseAmount: String(row.baseAmount), extraAmount: String(row.extraAmount), advanceDeduction: String(row.advanceDeduction), otherDeduction: String(row.otherDeduction), netAmount: String(row.netAmount), notes: row.notes || null }))); await writeAudit({ userId: ctx.user.id, siteId: input.siteId, entityType: "payroll_run", entityId: String(id), action: "create", afterData: { period: input.period, totalNet } }); return { id, totalNet };
    }),
    approvePayroll: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), payrollRunId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner", "accountant"], "managePayroll"); const tenantId = await getSiteTenant(input.siteId); const db = await dbOrThrow(); const [run] = await db.select({ id: payrollRuns.id, status: payrollRuns.status }).from(payrollRuns).where(and(eq(payrollRuns.id, input.payrollRunId), eq(payrollRuns.tenantId, tenantId), eq(payrollRuns.siteId, input.siteId))).limit(1); if (!run) throw new TRPCError({ code: "NOT_FOUND", message: "مسودة الراتب غير موجودة." }); if (run.status !== "draft") throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن اعتماد مسودة ليست في حالة مسودة." }); await db.update(payrollRuns).set({ status: "approved", approvedByUserId: ctx.user.id, updatedAt: new Date() }).where(eq(payrollRuns.id, input.payrollRunId)); await writeAudit({ userId: ctx.user.id, siteId: input.siteId, entityType: "payroll_run", entityId: String(input.payrollRunId), action: "approve" }); return { success: true };
    }),
    payPayroll: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), payrollRunId: z.number().int().positive(), accountId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner", "accountant"], "managePayroll"); const tenantId = await getSiteTenant(input.siteId); const db = await dbOrThrow(); const [run] = await db.select({ id: payrollRuns.id, status: payrollRuns.status, totalNet: payrollRuns.totalNet, period: payrollRuns.period }).from(payrollRuns).where(and(eq(payrollRuns.id, input.payrollRunId), eq(payrollRuns.tenantId, tenantId), eq(payrollRuns.siteId, input.siteId))).limit(1); if (!run) throw new TRPCError({ code: "NOT_FOUND", message: "كشف الراتب غير موجود." }); if (run.status !== "approved") throw new TRPCError({ code: "BAD_REQUEST", message: "يجب اعتماد كشف الراتب قبل صرفه." }); const [account] = await db.select({ id: companyAccounts.id }).from(companyAccounts).where(and(eq(companyAccounts.id, input.accountId), eq(companyAccounts.tenantId, tenantId), eq(companyAccounts.isActive, true))).limit(1); if (!account) throw new TRPCError({ code: "NOT_FOUND", message: "حساب الصرف غير موجود ضمن مساحة الشركة." }); const occurredAt = new Date(); await assertFinancialPeriodOpen(db, tenantId, input.siteId, occurredAt, ctx.user.id, "payroll"); await db.transaction(async (tx) => { const expenseId = insertId(await tx.insert(expenses).values({ tenantId, siteId: input.siteId, category: "payroll", description: `صرف رواتب شهر ${run.period}`, amount: String(run.totalNet), referenceNo: `PAYROLL-${input.payrollRunId}`, createdByUserId: ctx.user.id })); await tx.insert(accountTransactions).values({ tenantId, accountId: input.accountId, transactionType: "withdrawal", amount: String(run.totalNet), description: `صرف رواتب شهر ${run.period}`, referenceNo: `PAYROLL-${input.payrollRunId}`, createdByUserId: ctx.user.id, occurredAt }); await tx.update(payrollRuns).set({ status: "paid", paidFromAccountId: input.accountId, paidAt: occurredAt, updatedAt: occurredAt }).where(eq(payrollRuns.id, input.payrollRunId)); const paidItems = await tx.select({ employeeId: payrollItems.employeeId }).from(payrollItems).where(eq(payrollItems.payrollRunId, input.payrollRunId)); for (const item of paidItems) await tx.update(employeeAdjustments).set({ status: "settled", remainingAmount: "0", updatedAt: occurredAt }).where(and(eq(employeeAdjustments.tenantId, tenantId), eq(employeeAdjustments.siteId, input.siteId), eq(employeeAdjustments.employeeId, item.employeeId), eq(employeeAdjustments.adjustmentType, "advance"), eq(employeeAdjustments.status, "open"))); await writeAudit({ userId: ctx.user.id, siteId: input.siteId, entityType: "payroll_run", entityId: String(input.payrollRunId), action: "pay", afterData: { expenseId, accountId: input.accountId, amount: run.totalNet } }); }); return { success: true };
    }),
    updateEmployee: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), employeeId: z.number().int().positive(), fullName: z.string().trim().min(2).max(180).optional(), identityNo: z.string().trim().max(80).nullable().optional(), phone: z.string().trim().max(40).nullable().optional(), jobTitle: z.enum(["accountant", "collector", "technician", "worker", "supervisor", "other"]).optional(), employmentStatus: z.enum(["active", "suspended", "ended"]).optional(), contractType: z.enum(["daily", "monthly", "collection_percentage"]).optional(), baseWage: z.number().min(0).max(100000000).optional(), hireDate: z.string().nullable().optional(), notes: z.string().trim().max(2000).nullable().optional() })).mutation(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner"], "manageTeam"); const tenantId = await getSiteTenant(input.siteId); const db = await dbOrThrow();
      const [existing] = await db.select({ id: employees.id }).from(employees).where(and(eq(employees.id, input.employeeId), eq(employees.tenantId, tenantId), or(eq(employees.siteId, input.siteId), isNull(employees.siteId)))).limit(1); if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "الموظف غير موجود ضمن نطاقك." });
      const patch = { ...(input.fullName === undefined ? {} : { fullName: input.fullName }), ...(input.identityNo === undefined ? {} : { identityNo: input.identityNo }), ...(input.phone === undefined ? {} : { phone: input.phone }), ...(input.jobTitle === undefined ? {} : { jobTitle: input.jobTitle }), ...(input.employmentStatus === undefined ? {} : { employmentStatus: input.employmentStatus }), ...(input.contractType === undefined ? {} : { contractType: input.contractType }), ...(input.baseWage === undefined ? {} : { baseWage: String(input.baseWage) }), ...(input.hireDate === undefined ? {} : { hireDate: input.hireDate ? new Date(input.hireDate) : null }), ...(input.notes === undefined ? {} : { notes: input.notes }), updatedAt: new Date() };
      await db.update(employees).set(patch).where(eq(employees.id, input.employeeId)); await writeAudit({ userId: ctx.user.id, siteId: input.siteId, entityType: "employee", entityId: String(input.employeeId), action: "update", afterData: input }); return { success: true };
    }),
  }),
  audit: router({
    list: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "viewer"], "viewAudit");
      const db = await dbOrThrow();
      return db.select().from(auditLogs).where(eq(auditLogs.siteId, input.siteId)).orderBy(desc(auditLogs.createdAt)).limit(100);
    }),
  }),
  mobileSync: router({
    summary: protectedProcedure.input(siteScoped.extend({ from: z.string().datetime().optional(), to: z.string().datetime().optional() })).query(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "viewer"], "viewAudit");
      const tenantId = await getSiteTenant(input.siteId);
      const db = await dbOrThrow();
      const from = input.from ? new Date(input.from) : new Date(Date.now() - 24 * 60 * 60 * 1000);
      const to = input.to ? new Date(input.to) : new Date();
      const [row] = await db.select({
        cycles: sql<number>`count(*)`,
        syncedReadings: sql<number>`coalesce(sum(${mobileSyncEvents.syncedCount}), 0)`,
        retryableReadings: sql<number>`coalesce(sum(${mobileSyncEvents.retryableCount}), 0)`,
        needsReviewReadings: sql<number>`coalesce(sum(${mobileSyncEvents.needsReviewCount}), 0)`,
        failedEvents: sql<number>`coalesce(sum(case when ${mobileSyncEvents.status} in ('failed', 'needs_review') then 1 else 0 end), 0)`,
        activeTechnicians: sql<number>`count(distinct ${mobileSyncEvents.userId})`,
        lastEventAt: sql<Date | null>`max(${mobileSyncEvents.occurredAt})`,
      }).from(mobileSyncEvents).where(and(eq(mobileSyncEvents.tenantId, tenantId), eq(mobileSyncEvents.siteId, input.siteId), gte(mobileSyncEvents.occurredAt, from), lte(mobileSyncEvents.occurredAt, to)));
      return { cycles: Number(row?.cycles ?? 0), syncedReadings: Number(row?.syncedReadings ?? 0), retryableReadings: Number(row?.retryableReadings ?? 0), needsReviewReadings: Number(row?.needsReviewReadings ?? 0), failedEvents: Number(row?.failedEvents ?? 0), activeTechnicians: Number(row?.activeTechnicians ?? 0), lastEventAt: row?.lastEventAt ?? null };
    }),
    list: protectedProcedure.input(siteScoped.extend({ status: z.enum(["success", "partial", "retryable", "needs_review", "failed"]).optional(), userId: z.number().int().positive().optional(), from: z.string().datetime().optional(), to: z.string().datetime().optional(), page: z.number().int().min(1).default(1), pageSize: z.number().int().min(10).max(100).default(25) })).query(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "viewer"], "viewAudit");
      const tenantId = await getSiteTenant(input.siteId);
      const db = await dbOrThrow();
      const conditions = [eq(mobileSyncEvents.tenantId, tenantId), eq(mobileSyncEvents.siteId, input.siteId)];
      if (input.status) conditions.push(eq(mobileSyncEvents.status, input.status));
      if (input.userId) conditions.push(eq(mobileSyncEvents.userId, input.userId));
      if (input.from) conditions.push(gte(mobileSyncEvents.occurredAt, new Date(input.from)));
      if (input.to) conditions.push(lte(mobileSyncEvents.occurredAt, new Date(input.to)));
      const rows = await db.select({ id: mobileSyncEvents.id, eventType: mobileSyncEvents.eventType, status: mobileSyncEvents.status, syncedCount: mobileSyncEvents.syncedCount, retryableCount: mobileSyncEvents.retryableCount, needsReviewCount: mobileSyncEvents.needsReviewCount, errorCode: mobileSyncEvents.errorCode, errorMessage: mobileSyncEvents.errorMessage, appVersion: mobileSyncEvents.appVersion, deviceLabel: mobileSyncEvents.deviceLabel, occurredAt: mobileSyncEvents.occurredAt, userId: users.id, userName: users.name, userEmail: users.email }).from(mobileSyncEvents).innerJoin(users, eq(users.id, mobileSyncEvents.userId)).where(and(...conditions)).orderBy(desc(mobileSyncEvents.occurredAt)).limit(input.pageSize).offset((input.page - 1) * input.pageSize);
      return rows;
    }),
    readings: protectedProcedure.input(mobileSyncReadingsInput).query(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "viewer"], "viewAudit");
      const tenantId = await getSiteTenant(input.siteId);
      const db = await dbOrThrow();
      const conditions = [
        eq(meterReadings.tenantId, tenantId),
        eq(subscribers.tenantId, tenantId),
        eq(subscribers.siteId, input.siteId),
        eq(auditLogs.tenantId, tenantId),
        eq(auditLogs.siteId, input.siteId),
        eq(auditLogs.entityType, "meter_reading"),
        eq(auditLogs.action, "mobile_create"),
        sql`${auditLogs.entityId} = CAST(${meterReadings.id} AS CHAR)`,
      ];
      if (input.userId) conditions.push(eq(auditLogs.userId, input.userId));
      if (input.from) conditions.push(gte(auditLogs.createdAt, new Date(input.from)));
      if (input.to) conditions.push(lte(auditLogs.createdAt, new Date(input.to)));
      return db.select({ id: meterReadings.id, versionNo: meterReadings.versionNo, subscriberName: subscribers.fullName, subscriberNo: subscribers.subscriberNo, previousReading: meterReadings.previousReadingValue, currentReading: meterReadings.readingValue, readingAt: meterReadings.readingAt, syncedAt: auditLogs.createdAt, status: meterReadings.status, userId: auditLogs.userId })
        .from(meterReadings)
        .innerJoin(subscribers, eq(meterReadings.subscriberId, subscribers.id))
        .innerJoin(auditLogs, and(...conditions))
        .orderBy(desc(auditLogs.createdAt))
        .limit(input.pageSize)
        .offset((input.page - 1) * input.pageSize);
    }),
    readingDetail: protectedProcedure.input(mobileSyncReadingDetailInput).query(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "viewer"], "viewAudit");
      const tenantId = await getSiteTenant(input.siteId);
      const db = await dbOrThrow();
      const [row] = await db.select({ id: meterReadings.id, versionNo: meterReadings.versionNo, subscriberId: subscribers.id, subscriberName: subscribers.fullName, subscriberNo: subscribers.subscriberNo, previousReading: meterReadings.previousReadingValue, currentReading: meterReadings.readingValue, consumptionKwh: meterReadings.consumptionKwh, readingAt: meterReadings.readingAt, syncedAt: auditLogs.createdAt, status: meterReadings.status, captureMethod: meterReadings.captureMethod, notes: meterReadings.notes, technicianName: users.name, technicianEmail: users.email })
        .from(meterReadings)
        .innerJoin(subscribers, eq(meterReadings.subscriberId, subscribers.id))
        .innerJoin(auditLogs, and(eq(auditLogs.tenantId, tenantId), eq(auditLogs.siteId, input.siteId), eq(auditLogs.entityType, "meter_reading"), eq(auditLogs.action, "mobile_create"), sql`${auditLogs.entityId} = CAST(${meterReadings.id} AS CHAR)`))
        .innerJoin(users, eq(users.id, auditLogs.userId))
        .where(and(eq(meterReadings.id, input.readingId), eq(meterReadings.tenantId, tenantId), eq(subscribers.tenantId, tenantId), eq(subscribers.siteId, input.siteId)))
        .limit(1);
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "القراءة الميدانية غير موجودة ضمن الفرع المحدد." });
      return row;
    }),
    approveAndIssue: protectedProcedure.input(mobileSyncApproveInput).mutation(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "approveReadings");
      await requireRole(ctx.user.id, input.siteId, createRoles, "issueInvoices");
      return approveAndIssueMobileReading({ ...input, userId: ctx.user.id });
    }),
    approveAllAndIssue: protectedProcedure.input(mobileSyncBulkApprovalInput).mutation(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "approveReadings");
      await requireRole(ctx.user.id, input.siteId, createRoles, "issueInvoices");
      const tenantId = await getSiteTenant(input.siteId); const db = await dbOrThrow();
      const conditions = [eq(meterReadings.tenantId, tenantId), eq(subscribers.siteId, input.siteId), eq(meterReadings.status, "pending_review"), eq(auditLogs.tenantId, tenantId), eq(auditLogs.siteId, input.siteId), eq(auditLogs.entityType, "meter_reading"), eq(auditLogs.action, "mobile_create"), sql`${auditLogs.entityId} = CAST(${meterReadings.id} AS CHAR)`];
      if (input.userId) conditions.push(eq(auditLogs.userId, input.userId));
      if (input.from) conditions.push(gte(auditLogs.createdAt, new Date(input.from)));
      if (input.to) conditions.push(lte(auditLogs.createdAt, new Date(input.to)));
      const rows = await db.select({ id: meterReadings.id, versionNo: meterReadings.versionNo }).from(meterReadings).innerJoin(subscribers, eq(meterReadings.subscriberId, subscribers.id)).innerJoin(auditLogs, and(...conditions)).orderBy(desc(auditLogs.createdAt)).limit(input.limit);
      const results: Array<{ readingId: number; status: "issued" | "failed"; invoiceNo?: string; message?: string }> = [];
      for (const row of rows) {
        try { const issued = await approveAndIssueMobileReading({ siteId: input.siteId, readingId: row.id, baseVersion: row.versionNo, userId: ctx.user.id, sendNow: input.sendNow }); results.push({ readingId: row.id, status: "issued", invoiceNo: issued.invoiceNo }); }
        catch (error) { results.push({ readingId: row.id, status: "failed", message: error instanceof Error ? error.message : "تعذر اعتماد القراءة وإصدار فاتورتها." }); }
      }
      await writeAudit({ userId: ctx.user.id, siteId: input.siteId, entityType: "mobile_reading_batch", entityId: rows.map((row) => row.id).join(",") || "none", action: "approve_and_auto_issue", metadata: { requested: rows.length, issued: results.filter((row) => row.status === "issued").length, failed: results.filter((row) => row.status === "failed").length, userId: input.userId, from: input.from, to: input.to } });
      return { requested: rows.length, issued: results.filter((row) => row.status === "issued").length, failed: results.filter((row) => row.status === "failed").length, results };
    }),
    technicians: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "viewer"], "viewAudit");
      const tenantId = await getSiteTenant(input.siteId);
      const db = await dbOrThrow();
      return db.select({ id: users.id, name: users.name, email: users.email }).from(staffProfiles).innerJoin(users, eq(users.id, staffProfiles.userId)).where(and(eq(staffProfiles.tenantId, tenantId), or(eq(staffProfiles.siteId, input.siteId), isNull(staffProfiles.siteId)), eq(staffProfiles.isActive, true)));
    }),
  }),
});
