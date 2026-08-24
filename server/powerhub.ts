import crypto from "node:crypto";
import { TRPCError } from "@trpc/server";
import { randomBytes } from "node:crypto";
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
import { calculateInvoiceAmounts, generateInvoiceShareToken, hashInvoiceShareToken, nextInvoiceNo } from "./powerhub-utils";
import { buildFinancialOverview } from "./financial-overview-utils";
import { invoiceDeliveryPolicyFromSetting, isInvoiceDeliveryChannelEnabled, resolveInvoiceNotificationChannels } from "./notification-channels";
import { defaultInvoiceMessageTemplates, renderInvoiceMessageTemplate } from "./invoice-message-template";
import { probeMessagingConnection } from "./messaging-connection";
import { defaultPaymentReceiptSmsTemplate, renderPaymentReceiptMessage, renderPaymentReceiptTemplate, paymentReceiptTemplateParameters } from "./payment-receipt-message";
import { normalizeInternationalPhone } from "../shared/phone";
import { processNotificationById } from "./notification-worker";
import { storagePut } from "./storage";
import { encryptTenantCredential, hashWebhookVerifyToken } from "./tenant-crypto";
import { rolesWith, type PowerCapability, type PowerRole } from "../shared/powerhub-rbac";
import { createHeartbeatJob, deleteHeartbeatJob, updateHeartbeatJob } from "./_core/heartbeat";
import { COOKIE_NAME } from "../shared/const";

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

async function ownerAllowedSubaccountRoles() {
  const db = await dbOrThrow();
  const [setting] = await db.select({ isEnabled: platformSettings.isEnabled, value: platformSettings.value })
    .from(platformSettings).where(eq(platformSettings.settingKey, "owner_subaccount_roles")).limit(1);
  return allowedOwnerSubaccountRoles(setting);
}

async function ownerSubaccountLimit(tenantId: number) {
  const db = await dbOrThrow();
  const [[tenant], [setting]] = await Promise.all([
    db.select({ plan: tenants.plan }).from(tenants).where(eq(tenants.id, tenantId)).limit(1),
    db.select({ value: platformSettings.value }).from(platformSettings).where(eq(platformSettings.settingKey, "owner_subaccount_limits")).limit(1),
  ]);
  if (!tenant) throw new TRPCError({ code: "NOT_FOUND", message: "مساحة صاحب المولد غير موجودة." });
  return ownerSubaccountLimitForPlan(tenant.plan, setting);
}

async function activeSubaccountCount(tenantId: number) {
  const db = await dbOrThrow();
  const [result] = await db.select({ count: sql<number>`count(*)` }).from(tenantMembers)
    .where(and(eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.role, "member"), eq(tenantMembers.isActive, true), eq(tenantMembers.membershipStatus, "active")));
  return Number(result?.count ?? 0);
}

async function ownerSubscriberQuota(tenantId: number) {
  const db = await dbOrThrow();
  const [[tenant], [setting], [countResult]] = await Promise.all([
    db.select({ plan: tenants.plan }).from(tenants).where(eq(tenants.id, tenantId)).limit(1),
    db.select({ value: platformSettings.value }).from(platformSettings).where(eq(platformSettings.settingKey, "owner_subscriber_limits")).limit(1),
    db.select({ count: sql<number>`count(*)` }).from(subscribers).where(eq(subscribers.tenantId, tenantId)),
  ]);
  if (!tenant) throw new TRPCError({ code: "NOT_FOUND", message: "مساحة صاحب المولد غير موجودة." });
  const limit = ownerSubscriberLimitForPlan(tenant.plan, setting);
  const currentCount = Number(countResult?.count ?? 0);
  return { limit, currentCount, remaining: Math.max(0, limit - currentCount), plan: tenant.plan };
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
  if (user?.role === "admin") return { role: "owner", permissions: ["manageSubscribers", "manageGenerators", "recordReadings", "approveReadings", "manageTariffs", "issueInvoices", "collectPayments", "manageExpenses", "managePayroll", "manageTeam", "manageMessaging", "viewAudit"] };

  const tenantId = await getSiteTenant(siteId);
  if (tenantId) {
    const [member] = await db.select({ role: tenantMembers.role }).from(tenantMembers)
      .where(and(eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.userId, userId), eq(tenantMembers.isActive, true), eq(tenantMembers.membershipStatus, "active"))).limit(1);
    if (!member) throw new TRPCError({ code: "FORBIDDEN", message: "لا توجد عضوية فعالة في مساحة صاحب المولد لهذه المحطة." });
    if (member.role === "owner") return { role: "owner", permissions: ["manageSubscribers", "manageGenerators", "recordReadings", "approveReadings", "manageTariffs", "issueInvoices", "collectPayments", "manageExpenses", "managePayroll", "manageTeam", "manageMessaging", "viewAudit"] };
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

function compactPhone(value: string) {
  return value.replace(/[\s\-()]/g, "");
}

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
  const db = await dbOrThrow();
  const [portal] = await db.select({
    id: sitePortalSettings.id,
    tenantId: sitePortalSettings.tenantId,
    siteId: sitePortalSettings.siteId,
    portalCode: sitePortalSettings.portalCode,
    displayName: sitePortalSettings.displayName,
    primaryColor: sitePortalSettings.primaryColor,
    accentColor: sitePortalSettings.accentColor,
    siteName: sites.name,
    city: sites.city,
  }).from(sitePortalSettings)
    .innerJoin(sites, eq(sitePortalSettings.siteId, sites.id))
    .where(and(eq(sitePortalSettings.portalCode, portalCode), eq(sitePortalSettings.isEnabled, true), eq(sites.status, "active")))
    .limit(1);
  if (!portal) throw new TRPCError({ code: "NOT_FOUND", message: "رابط بوابة المشتركين غير متاح." });
  return portal;
}

async function getVerifiedPortalSubscriber(input: z.infer<typeof subscriberPortalLookupInput>) {
  const [portal, db] = await Promise.all([getEnabledPortal(input.portalCode), dbOrThrow()]);
  const [subscriber] = await db.select().from(subscribers)
    .where(and(eq(subscribers.siteId, portal.siteId), eq(subscribers.subscriberNo, input.subscriberNo)))
    .limit(1);
  if (!subscriber || compactPhone(subscriber.phone) !== compactPhone(input.phone)) {
    throw new TRPCError({ code: "NOT_FOUND", message: "تعذر التحقق من بيانات المشترك. راجع الرقم المرجعي ورقم الهاتف." });
  }
  return { portal, subscriber };
}

export const powerhubRouter = router({
  messaging: router({
    smsQuota: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      const role = await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "collector"], "manageMessaging");
      void role;
      const tenantId = await getSiteTenant(input.siteId);
      const db = await dbOrThrow();
      const monthStart = new Date();
      monthStart.setUTCDate(1);
      monthStart.setUTCHours(0, 0, 0, 0);
      const [[account], [usage]] = await Promise.all([
        db.select({ senderName: tenantTweetSmsAccounts.senderName, monthlyLimit: tenantTweetSmsAccounts.monthlyLimit, isActive: tenantTweetSmsAccounts.isActive, configured: tenantTweetSmsAccounts.credentialCiphertext, lastError: tenantTweetSmsAccounts.lastError }).from(tenantTweetSmsAccounts).where(eq(tenantTweetSmsAccounts.tenantId, tenantId)).limit(1),
        db.select({ used: sql<number>`count(*)` }).from(notificationMessages).where(and(eq(notificationMessages.tenantId, tenantId), eq(notificationMessages.channel, "sms"), gte(notificationMessages.createdAt, monthStart), inArray(notificationMessages.status, ["submitted", "delivered", "read"]))),
      ]);
      const included = Number(account?.monthlyLimit ?? 0);
      const additional = 0;
      const used = Number(usage?.used ?? 0);
      return { plan: "tweetsms", planName: "TweetSMS", senderName: account?.senderName ?? null, isActive: account?.isActive ?? false, configured: Boolean(account?.configured), lastError: account?.lastError ?? null, included, additional, total: included, used, remaining: Math.max(0, included - used) };
    }),
    smsDailyUsage: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "collector"], "manageMessaging");
      const tenantId = await getSiteTenant(input.siteId); const db = await dbOrThrow();
      const [account] = await db.select({ monthlyLimit: tenantTweetSmsAccounts.monthlyLimit }).from(tenantTweetSmsAccounts).where(eq(tenantTweetSmsAccounts.tenantId, tenantId)).limit(1);
      const messages = await db.select({ createdAt: notificationMessages.createdAt, status: notificationMessages.status }).from(notificationMessages).where(and(eq(notificationMessages.tenantId, tenantId), eq(notificationMessages.channel, "sms"))).orderBy(desc(notificationMessages.createdAt)).limit(5000);
      const daily = new Map<string, number>(); for (const message of messages) { if (!["submitted", "delivered", "read"].includes(message.status)) continue; const key = new Date(message.createdAt).toISOString().slice(0, 10); daily.set(key, (daily.get(key) ?? 0) + 1); }
      const today = new Date(); const points = Array.from({ length: 14 }, (_, index) => { const date = new Date(today); date.setDate(today.getDate() - (13 - index)); const key = date.toISOString().slice(0, 10); return { date: key, count: daily.get(key) ?? 0 }; });
      const included = Number(account?.monthlyLimit ?? 0); const additional = 0; const total = included; const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0); const used = messages.filter((message) => ["submitted", "delivered", "read"].includes(message.status) && message.createdAt >= monthStart).length;
      return { points, included, additional, total, used, remaining: Math.max(0, total - used) };
    }),
    currentSmsPackageRequest: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => { const tenantId = await getSiteTenant(input.siteId); await requireRole(ctx.user.id, input.siteId, ["owner"], "manageMessaging"); const db = await dbOrThrow(); const [request] = await db.select({ id: smsPackageRequests.id, status: smsPackageRequests.status, requestedMessages: smsPackageRequests.requestedMessages, approvedMessages: smsPackageRequests.approvedMessages, note: smsPackageRequests.note, createdAt: smsPackageRequests.createdAt, reviewedAt: smsPackageRequests.reviewedAt }).from(smsPackageRequests).where(eq(smsPackageRequests.tenantId, tenantId)).orderBy(desc(smsPackageRequests.createdAt)).limit(1); return request ?? null; }),
    requestSmsPackage: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), requestedMessages: z.number().int().min(1).max(100000000), note: z.string().max(1000).optional() })).mutation(async ({ ctx, input }) => {
      const tenantId = await getSiteTenant(input.siteId);
      await requireRole(ctx.user.id, input.siteId, ["owner"], "manageMessaging");
      const db = await dbOrThrow();
      const [pending] = await db.select({ id: smsPackageRequests.id }).from(smsPackageRequests).where(and(eq(smsPackageRequests.tenantId, tenantId), eq(smsPackageRequests.status, "pending"))).limit(1);
      if (pending) throw new TRPCError({ code: "CONFLICT", message: "لديك طلب حزمة قيد المراجعة بالفعل." });
      const id = insertId(await db.insert(smsPackageRequests).values({ tenantId, requestedByUserId: ctx.user.id, requestedMessages: input.requestedMessages, note: input.note }));
      await writeAudit({ userId: ctx.user.id, siteId: input.siteId, entityType: "sms_package_request", entityId: String(id), action: "request_sms_package", metadata: { requestedMessages: input.requestedMessages } });
      return { id, status: "pending" as const };
    }),
    listConfigurations: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner"], "manageMessaging");
      const tenantId = await getSiteTenant(input.siteId);
      if (!tenantId) throw new TRPCError({ code: "BAD_REQUEST", message: "المحطة لا تتبع لمساحة مستأجر مهيأة بعد." });
      const db = await dbOrThrow();
      return db.select({ id: tenantMessagingConfigurations.id, channel: tenantMessagingConfigurations.channel, provider: tenantMessagingConfigurations.provider, senderId: tenantMessagingConfigurations.senderId, phoneNumberId: tenantMessagingConfigurations.phoneNumberId, templateName: tenantMessagingConfigurations.templateName, receiptTemplateName: tenantMessagingConfigurations.receiptTemplateName, subscriberReferenceTemplateName: tenantMessagingConfigurations.subscriberReferenceTemplateName, isActive: tenantMessagingConfigurations.isActive, autoSendAfterApproval: tenantMessagingConfigurations.autoSendAfterApproval, autoSendCron: tenantMessagingConfigurations.autoSendCron, scheduleCronTaskUid: tenantMessagingConfigurations.scheduleCronTaskUid, updatedAt: tenantMessagingConfigurations.updatedAt }).from(tenantMessagingConfigurations).where(eq(tenantMessagingConfigurations.tenantId, tenantId));
    }),
    listScheduleRuns: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), limit: z.number().int().min(1).max(50).default(20) })).query(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "manageMessaging");
      const tenantId = await getSiteTenant(input.siteId);
      const db = await dbOrThrow();
      const [config] = await db.select({ id: tenantMessagingConfigurations.id }).from(tenantMessagingConfigurations).where(and(eq(tenantMessagingConfigurations.tenantId, tenantId), eq(tenantMessagingConfigurations.channel, "sms"))).limit(1);
      if (!config) return [];
      return db.select({ id: messagingScheduleRuns.id, status: messagingScheduleRuns.status, scanned: messagingScheduleRuns.scanned, submitted: messagingScheduleRuns.submitted, failed: messagingScheduleRuns.failed, skipped: messagingScheduleRuns.skipped, error: messagingScheduleRuns.error, taskUid: messagingScheduleRuns.taskUid, startedAt: messagingScheduleRuns.startedAt, finishedAt: messagingScheduleRuns.finishedAt }).from(messagingScheduleRuns).where(and(eq(messagingScheduleRuns.tenantId, tenantId), eq(messagingScheduleRuns.configurationId, config.id))).orderBy(desc(messagingScheduleRuns.startedAt)).limit(input.limit);
    }),
    deliveryPolicy: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner"], "manageMessaging");
      const db = await dbOrThrow();
      const [setting] = await db.select({ isEnabled: platformSettings.isEnabled, value: platformSettings.value, message: platformSettings.message }).from(platformSettings)
        .where(eq(platformSettings.settingKey, "invoice_delivery_channels")).limit(1);
      return { ...invoiceDeliveryPolicyFromSetting(setting), configured: Boolean(setting), message: setting?.message ?? null };
    }),
    listInvoiceTemplates: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner"], "manageMessaging");
      const tenantId = await getSiteTenant(input.siteId);
      if (!tenantId) throw new TRPCError({ code: "BAD_REQUEST", message: "المحطة لا تتبع لمساحة مستأجر مهيأة بعد." });
      const db = await dbOrThrow();
      return db.select().from(tenantInvoiceMessageTemplates).where(and(eq(tenantInvoiceMessageTemplates.tenantId, tenantId), eq(tenantInvoiceMessageTemplates.eventType, "invoice_issued")));
    }),
    listPaymentReceiptTemplates: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner"], "manageMessaging");
      const tenantId = await getSiteTenant(input.siteId);
      const db = await dbOrThrow();
      return db.select().from(tenantPaymentReceiptMessageTemplates).where(eq(tenantPaymentReceiptMessageTemplates.tenantId, tenantId));
    }),
    saveConfiguration: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(), channel: z.enum(["whatsapp", "sms"]), provider: z.string().min(2).max(80),
      senderId: z.string().max(120).optional(), phoneNumberId: z.string().max(120).optional(), templateName: z.string().max(120).optional(), receiptTemplateName: z.string().max(120).optional(), subscriberReferenceTemplateName: z.string().max(120).optional(),
      credential: z.string().min(8).max(4096), webhookVerifyToken: z.string().min(16).max(256).optional(), webhookAppSecret: z.string().min(16).max(512).optional(), isActive: z.boolean().default(true),
    })).mutation(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner"], "manageMessaging");
      const tenantId = await getSiteTenant(input.siteId);
      if (!tenantId) throw new TRPCError({ code: "BAD_REQUEST", message: "المحطة لا تتبع لمساحة مستأجر مهيأة بعد." });
      const db = await dbOrThrow();
      const [platformSetting] = await db.select({ isEnabled: platformSettings.isEnabled, value: platformSettings.value }).from(platformSettings)
        .where(eq(platformSettings.settingKey, "invoice_delivery_channels")).limit(1);
      if (!platformSetting || !isInvoiceDeliveryChannelEnabled(input.channel, invoiceDeliveryPolicyFromSetting(platformSetting))) throw new TRPCError({ code: "FORBIDDEN", message: `ربط قناة ${input.channel === "whatsapp" ? "WhatsApp" : "SMS"} غير متاح حالياً من إعدادات آدمن المنصة.` });
      const encrypted = encryptTenantCredential(input.channel === "whatsapp" ? JSON.stringify({ accessToken: input.credential, appSecret: input.webhookAppSecret || undefined }) : input.credential);
      await db.insert(tenantMessagingConfigurations).values({
        tenantId, channel: input.channel, provider: input.provider, senderId: input.senderId, phoneNumberId: input.phoneNumberId,
        templateName: input.templateName, receiptTemplateName: input.receiptTemplateName, subscriberReferenceTemplateName: input.subscriberReferenceTemplateName, credentialCiphertext: encrypted.ciphertext, credentialIv: encrypted.iv, webhookVerifyTokenHash: input.webhookVerifyToken ? hashWebhookVerifyToken(input.webhookVerifyToken) : undefined, isActive: input.isActive,
      }).onDuplicateKeyUpdate({ set: { provider: input.provider, senderId: input.senderId, phoneNumberId: input.phoneNumberId, templateName: input.templateName, receiptTemplateName: input.receiptTemplateName, subscriberReferenceTemplateName: input.subscriberReferenceTemplateName, credentialCiphertext: encrypted.ciphertext, credentialIv: encrypted.iv, webhookVerifyTokenHash: input.webhookVerifyToken ? hashWebhookVerifyToken(input.webhookVerifyToken) : sql`${tenantMessagingConfigurations.webhookVerifyTokenHash}`, isActive: input.isActive } });
      await writeAudit({ userId: ctx.user.id, siteId: input.siteId, entityType: "tenant_messaging_configuration", entityId: `${tenantId}:${input.channel}`, action: "upsert", metadata: { channel: input.channel, provider: input.provider, isActive: input.isActive } });
      return { success: true };
    }),
    testConnection: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(), channel: z.enum(["whatsapp", "sms"]), provider: z.string().min(2).max(80),
      phoneNumberId: z.string().max(120).optional(), credential: z.string().min(8).max(4096),
    })).mutation(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner"], "manageMessaging");
      const db = await dbOrThrow();
      const [platformSetting] = await db.select({ isEnabled: platformSettings.isEnabled, value: platformSettings.value }).from(platformSettings)
        .where(eq(platformSettings.settingKey, "invoice_delivery_channels")).limit(1);
      if (!platformSetting || !isInvoiceDeliveryChannelEnabled(input.channel, invoiceDeliveryPolicyFromSetting(platformSetting))) throw new TRPCError({ code: "FORBIDDEN", message: "اختبار الاتصال غير متاح لقناة معطلة من آدمن المنصة." });
      try {
        const result = await probeMessagingConnection(input);
        await writeAudit({ userId: ctx.user.id, siteId: input.siteId, entityType: "tenant_messaging_configuration", entityId: `${input.siteId}:${input.channel}`, action: "connection_test", metadata: { channel: input.channel, provider: input.provider, ok: result.ok, mode: result.mode } });
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message.slice(0, 500) : "تعذر الاتصال بالمزود.";
        await writeAudit({ userId: ctx.user.id, siteId: input.siteId, entityType: "tenant_messaging_configuration", entityId: `${input.siteId}:${input.channel}`, action: "connection_test", metadata: { channel: input.channel, provider: input.provider, ok: false, mode: "live" } });
        return { ok: false, mode: "live" as const, message: `تعذر إتمام اختبار الاتصال: ${message}` };
      }
    }),
    configureInvoiceAutoSend: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), enabled: z.boolean(), cron: z.string().min(11).max(40).default("0 0/15 * * * *") })).mutation(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner"], "manageMessaging");
      const tenantId = await getSiteTenant(input.siteId);
      const db = await dbOrThrow();
      const [config] = await db.select({ id: tenantMessagingConfigurations.id, scheduleCronTaskUid: tenantMessagingConfigurations.scheduleCronTaskUid, provider: tenantMessagingConfigurations.provider }).from(tenantMessagingConfigurations).where(and(eq(tenantMessagingConfigurations.tenantId, tenantId), eq(tenantMessagingConfigurations.channel, "sms"))).limit(1);
      if (!config) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "يجب أن يربط آدمن PowerHub حساب TweetSMS لهذا صاحب المولد أولاً." });
      const userSession = sessionCookie(ctx.req);
      if (!input.enabled) {
        if (config.scheduleCronTaskUid) await deleteHeartbeatJob(config.scheduleCronTaskUid, userSession);
        await db.update(tenantMessagingConfigurations).set({ autoSendAfterApproval: false, autoSendCron: input.cron, scheduleCronTaskUid: null }).where(eq(tenantMessagingConfigurations.id, config.id));
        await writeAudit({ userId: ctx.user.id, siteId: input.siteId, entityType: "tenant_messaging_schedule", entityId: String(config.id), action: "disable" });
        return { enabled: false, cron: input.cron };
      }
      if (config.provider !== "tweetsms") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "هذه الجدولة متاحة لحساب TweetSMS الذي يديره آدمن PowerHub فقط." });
      const job = config.scheduleCronTaskUid ? await updateHeartbeatJob(config.scheduleCronTaskUid, { cron: input.cron, path: "/api/scheduled/send-invoice-sms", enable: true, description: "إرسال فواتير القراءات المعتمدة عبر SMS" }, userSession).then((result) => ({ taskUid: config.scheduleCronTaskUid!, nextExecutionAt: result.nextExecutionAt })) : await createHeartbeatJob({ name: `tenant-${tenantId}-invoice-sms`, cron: input.cron, path: "/api/scheduled/send-invoice-sms", description: "إرسال فواتير القراءات المعتمدة عبر SMS" }, userSession);
      await db.update(tenantMessagingConfigurations).set({ autoSendAfterApproval: true, autoSendCron: input.cron, scheduleCronTaskUid: job.taskUid }).where(eq(tenantMessagingConfigurations.id, config.id));
      await writeAudit({ userId: ctx.user.id, siteId: input.siteId, entityType: "tenant_messaging_schedule", entityId: String(config.id), action: "enable", metadata: { cron: input.cron, taskUid: job.taskUid } });
      return { enabled: true, cron: input.cron, nextExecutionAt: job.nextExecutionAt ?? null };
    }),
    saveInvoiceTemplate: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), channel: z.enum(["whatsapp", "sms"]), body: z.string().min(12).max(1600), isActive: z.boolean().default(true) })).mutation(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner"], "manageMessaging");
      const tenantId = await getSiteTenant(input.siteId);
      if (!tenantId) throw new TRPCError({ code: "BAD_REQUEST", message: "المحطة لا تتبع لمساحة مستأجر مهيأة بعد." });
      const db = await dbOrThrow();
      const [platformSetting] = await db.select({ isEnabled: platformSettings.isEnabled, value: platformSettings.value }).from(platformSettings)
        .where(eq(platformSettings.settingKey, "invoice_delivery_channels")).limit(1);
      if (!platformSetting || !isInvoiceDeliveryChannelEnabled(input.channel, invoiceDeliveryPolicyFromSetting(platformSetting))) throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكن حفظ قالب لقناة معطلة من آدمن المنصة." });
      await db.insert(tenantInvoiceMessageTemplates).values({ tenantId, channel: input.channel, body: input.body, isActive: input.isActive }).onDuplicateKeyUpdate({ set: { body: input.body, isActive: input.isActive } });
      await writeAudit({ userId: ctx.user.id, siteId: input.siteId, entityType: "tenant_invoice_message_template", entityId: `${tenantId}:${input.channel}`, action: "upsert", metadata: { channel: input.channel, isActive: input.isActive } });
      return { success: true };
    }),
    savePaymentReceiptTemplate: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), body: z.string().min(12).max(1600), isActive: z.boolean().default(true) })).mutation(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner"], "manageMessaging");
      const tenantId = await getSiteTenant(input.siteId);
      const db = await dbOrThrow();
      const [platformSetting] = await db.select({ isEnabled: platformSettings.isEnabled, value: platformSettings.value }).from(platformSettings)
        .where(eq(platformSettings.settingKey, "invoice_delivery_channels")).limit(1);
      if (!platformSetting || !isInvoiceDeliveryChannelEnabled("sms", invoiceDeliveryPolicyFromSetting(platformSetting))) throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكن حفظ قالب إيصال SMS لقناة معطلة من آدمن المنصة." });
      await db.insert(tenantPaymentReceiptMessageTemplates).values({ tenantId, channel: "sms", body: input.body, isActive: input.isActive }).onDuplicateKeyUpdate({ set: { body: input.body, isActive: input.isActive } });
      await writeAudit({ userId: ctx.user.id, siteId: input.siteId, entityType: "tenant_payment_receipt_message_template", entityId: `${tenantId}:sms`, action: "upsert", metadata: { channel: "sms", isActive: input.isActive } });
      return { success: true };
    }),
  }),
  quickActions: router({
    preferences: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      await resolveAccess(ctx.user.id, input.siteId);
      const db = await dbOrThrow();
      const [preference] = await db.select({ actionIds: userQuickActionPreferences.actionIds, updatedAt: userQuickActionPreferences.updatedAt })
        .from(userQuickActionPreferences)
        .where(and(eq(userQuickActionPreferences.userId, ctx.user.id), eq(userQuickActionPreferences.siteId, input.siteId)))
        .limit(1);
      const actionIds = Array.isArray(preference?.actionIds) ? preference.actionIds.filter((actionId): actionId is keyof typeof quickActionCapabilityById => typeof actionId === "string" && actionId in quickActionCapabilityById) : [];
      return { actionIds, updatedAt: preference?.updatedAt ?? null };
    }),
    savePreferences: protectedProcedure.input(siteScoped.extend({ actionIds: z.array(quickActionIdSchema).min(1).max(6).refine((actionIds) => new Set(actionIds).size === actionIds.length, "لا يمكن تكرار الإجراء المختار.") })).mutation(async ({ ctx, input }) => {
      const access = await resolveAccess(ctx.user.id, input.siteId);
      const unavailable = input.actionIds.find((actionId) => access.role !== "owner" && !access.permissions.includes(quickActionCapabilityById[actionId]));
      if (unavailable) throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكنك حفظ إجراء لا تملك صلاحيته في هذا الفرع." });
      const db = await dbOrThrow();
      await db.insert(userQuickActionPreferences).values({ userId: ctx.user.id, siteId: input.siteId, actionIds: input.actionIds }).onDuplicateKeyUpdate({ set: { actionIds: input.actionIds, updatedAt: new Date() } });
      return { success: true, actionIds: input.actionIds };
    }),
  }),
  staff: router({
    myAccess: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => resolveAccess(ctx.user.id, input.siteId)),
    allBranchAccess: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      const role = await resolveRole(ctx.user.id, input.siteId);
      if (ctx.user.role === "admin" || role === "owner") return { isGlobal: true };
      const db = await dbOrThrow();
      const tenantId = await getSiteTenant(input.siteId);
      const [globalProfile] = await db.select({ id: staffProfiles.id }).from(staffProfiles)
        .where(and(eq(staffProfiles.tenantId, tenantId), eq(staffProfiles.userId, ctx.user.id), isNull(staffProfiles.siteId), eq(staffProfiles.isActive, true))).limit(1);
      return { isGlobal: Boolean(globalProfile) };
    }),
    permissionChanges: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), userId: z.number().int().positive().optional() })).query(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner"], "viewAudit");
      const tenantId = await getSiteTenant(input.siteId); const db = await dbOrThrow();
      const conditions = [eq(auditLogs.tenantId, tenantId), eq(auditLogs.siteId, input.siteId), inArray(auditLogs.action, ["update_permissions", "create", "update"])];
      if (input.userId) conditions.push(eq(auditLogs.userId, input.userId));
      return db.select({ id: auditLogs.id, userId: auditLogs.userId, action: auditLogs.action, createdAt: auditLogs.createdAt, afterData: auditLogs.afterData, metadata: auditLogs.metadata }).from(auditLogs).where(and(...conditions)).orderBy(desc(auditLogs.createdAt)).limit(100);
    }),
    list: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager"], "manageTeam");
      const db = await dbOrThrow();
      const tenantId = await getSiteTenant(input.siteId);
      return db.select({ profile: staffProfiles, user: users }).from(staffProfiles)
        .innerJoin(users, eq(staffProfiles.userId, users.id))
        .where(and(eq(staffProfiles.tenantId, tenantId), or(eq(staffProfiles.siteId, input.siteId), isNull(staffProfiles.siteId))));
    }),
    directory: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner"], "manageTeam");
      const db = await dbOrThrow();
      return db.select({ id: users.id, name: users.name, email: users.email, role: users.role }).from(users).orderBy(desc(users.lastSignedIn));
    }),
    allowedSubaccountRoles: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      const actorRole = await resolveRole(ctx.user.id, input.siteId);
      if (actorRole !== "owner" && ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "هذه القائمة مخصصة لمالك المولد." });
      const tenantId = await getSiteTenant(input.siteId);
      const [roles, limit, currentCount] = await Promise.all([ownerAllowedSubaccountRoles(), ownerSubaccountLimit(tenantId), activeSubaccountCount(tenantId)]);
      return { roles, limit, currentCount, remaining: Math.max(0, limit - currentCount) };
    }),
    permissionCatalog: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner"], "manageTeam");
      const capabilities: PowerCapability[] = ["manageSubscribers", "manageGenerators", "recordReadings", "approveReadings", "manageTariffs", "issueInvoices", "collectPayments", "manageExpenses", "managePayroll", "manageTeam", "manageMessaging", "viewAudit"];
      return capabilities;
    }),
    customRoles: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner"], "manageTeam");
      const tenantId = await getSiteTenant(input.siteId);
      const db = await dbOrThrow();
      return db.select({ id: customPermissionRoles.id, name: customPermissionRoles.name, description: customPermissionRoles.description, permissions: customPermissionRoles.permissions, isActive: customPermissionRoles.isActive }).from(customPermissionRoles).where(and(eq(customPermissionRoles.tenantId, tenantId), eq(customPermissionRoles.isActive, true))).orderBy(customPermissionRoles.name);
    }),
    saveCustomRole: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), id: z.number().int().positive().optional(), name: z.string().trim().min(2).max(120), description: z.string().trim().max(255).optional(), permissions: z.array(z.enum(["manageSubscribers", "manageGenerators", "recordReadings", "approveReadings", "manageTariffs", "issueInvoices", "collectPayments", "manageExpenses", "managePayroll", "manageTeam", "manageMessaging", "viewAudit"])).min(1) })).mutation(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner"], "manageTeam");
      const tenantId = await getSiteTenant(input.siteId);
      const db = await dbOrThrow();
      if (input.id) await db.update(customPermissionRoles).set({ name: input.name, description: input.description || null, permissions: input.permissions, updatedAt: new Date() }).where(and(eq(customPermissionRoles.id, input.id), eq(customPermissionRoles.tenantId, tenantId)));
      else await db.insert(customPermissionRoles).values({ tenantId, name: input.name, description: input.description || null, permissions: input.permissions, createdByUserId: ctx.user.id, isActive: true });
      await writeAudit({ userId: ctx.user.id, siteId: input.siteId, entityType: "custom_permission_role", entityId: input.id ? String(input.id) : "new", action: input.id ? "update" : "create", afterData: { name: input.name, permissions: input.permissions } });
      return { success: true };
    }),
    deleteCustomRole: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), roleId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner"], "manageTeam");
      const tenantId = await getSiteTenant(input.siteId); const db = await dbOrThrow();
      const [linked] = await db.select({ id: staffProfiles.id }).from(staffProfiles).where(and(eq(staffProfiles.tenantId, tenantId), eq(staffProfiles.customRoleId, input.roleId), eq(staffProfiles.isActive, true))).limit(1);
      if (linked) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "لا يمكن حذف دور مرتبط بحساب فعال. أعد تعيين الحساب أولاً." });
      const [role] = await db.select({ id: customPermissionRoles.id }).from(customPermissionRoles).where(and(eq(customPermissionRoles.id, input.roleId), eq(customPermissionRoles.tenantId, tenantId))).limit(1);
      if (!role) throw new TRPCError({ code: "NOT_FOUND", message: "الدور المخصص غير موجود ضمن مساحة المستأجر." });
      await db.update(customPermissionRoles).set({ isActive: false, updatedAt: new Date() }).where(eq(customPermissionRoles.id, input.roleId));
      await writeAudit({ userId: ctx.user.id, siteId: input.siteId, entityType: "custom_permission_role", entityId: String(input.roleId), action: "delete", afterData: { isActive: false } });
      return { success: true };
    }),
    updatePermissions: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), profileId: z.number().int().positive(), customRoleId: z.number().int().positive().nullable().optional(), permissions: z.array(z.enum(["manageSubscribers", "manageGenerators", "recordReadings", "approveReadings", "manageTariffs", "issueInvoices", "collectPayments", "manageExpenses", "managePayroll", "manageTeam", "manageMessaging", "viewAudit"])).min(1) })).mutation(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner"], "manageTeam");
      const tenantId = await getSiteTenant(input.siteId);
      const db = await dbOrThrow();
      const roleId = input.customRoleId ?? null;
      if (roleId) {
        const [role] = await db.select({ id: customPermissionRoles.id }).from(customPermissionRoles).where(and(eq(customPermissionRoles.id, roleId), eq(customPermissionRoles.tenantId, tenantId), eq(customPermissionRoles.isActive, true))).limit(1);
        if (!role) throw new TRPCError({ code: "NOT_FOUND", message: "الدور المخصص غير موجود ضمن مساحة المستأجر." });
      }
      const [profile] = await db.select({ id: staffProfiles.id, userId: staffProfiles.userId, siteId: staffProfiles.siteId }).from(staffProfiles).where(and(eq(staffProfiles.id, input.profileId), eq(staffProfiles.tenantId, tenantId), or(eq(staffProfiles.siteId, input.siteId), isNull(staffProfiles.siteId)))).limit(1);
      if (!profile) throw new TRPCError({ code: "NOT_FOUND", message: "الحساب الفرعي غير موجود ضمن نطاقك." });
      await db.update(staffProfiles).set({ customRoleId: roleId, permissions: input.permissions, updatedAt: new Date() }).where(eq(staffProfiles.id, input.profileId));
      await writeAudit({ userId: ctx.user.id, siteId: input.siteId, entityType: "staff_profile", entityId: String(input.profileId), action: "update_permissions", afterData: { customRoleId: roleId, permissions: input.permissions, targetUserId: profile.userId } });
      return { success: true };
    }),
    assign: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), userId: z.number().int().positive(), role: z.enum(["owner", "manager", "accountant", "collector", "technician", "viewer"]), allBranches: z.boolean().default(false) }))
      .mutation(async ({ ctx, input }) => {
        await requireRole(ctx.user.id, input.siteId, ["owner"], "manageTeam");
        const db = await dbOrThrow();
        const actorRole = await resolveRole(ctx.user.id, input.siteId);
        if (ctx.user.role !== "admin" && actorRole === "owner") {
          const allowedRoles = await ownerAllowedSubaccountRoles();
          if (!allowedRoles.includes(input.role as OwnerSubaccountRole)) throw new TRPCError({ code: "FORBIDDEN", message: "هذا الدور غير مسموح للحسابات الفرعية وفق سياسة آدمن المنصة." });
        }
        const tenantId = await getSiteTenant(input.siteId);
        if (!tenantId) throw new TRPCError({ code: "BAD_REQUEST", message: "يجب ربط المحطة بمستأجر قبل تعيين الفريق." });
        const [existingMembership] = await db.select({ role: tenantMembers.role, isActive: tenantMembers.isActive, membershipStatus: tenantMembers.membershipStatus }).from(tenantMembers)
          .where(and(eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.userId, input.userId))).limit(1);
        const alreadyActiveSubaccount = existingMembership?.role === "member" && existingMembership.isActive && existingMembership.membershipStatus === "active";
        if (!alreadyActiveSubaccount) {
          const [limit, currentCount] = await Promise.all([ownerSubaccountLimit(tenantId), activeSubaccountCount(tenantId)]);
          if (currentCount >= limit) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `وصلت إلى الحد الأقصى للحسابات الفرعية في اشتراكك (${limit}).` });
        }
        const tenantRole = existingMembership?.role === "owner" ? "owner" : "member" as const;
        const targetSiteId = input.allBranches ? null : input.siteId;
        await db.transaction(async (tx) => {
          await tx.insert(tenantMembers).values({ tenantId, userId: input.userId, role: tenantRole, isActive: true, membershipStatus: "active", expiresAt: null }).onDuplicateKeyUpdate({ set: { role: tenantRole, isActive: true, membershipStatus: "active", expiresAt: null } });
          await tx.update(staffProfiles).set({ isActive: false }).where(and(eq(staffProfiles.tenantId, tenantId), input.allBranches ? isNull(staffProfiles.siteId) : eq(staffProfiles.siteId, input.siteId), eq(staffProfiles.userId, input.userId)));
          await tx.insert(staffProfiles).values({ tenantId, siteId: targetSiteId, userId: input.userId, role: input.role, isActive: true }).onDuplicateKeyUpdate({ set: { isActive: true, role: input.role, updatedAt: new Date() } });
        });
        await writeAudit({ userId: ctx.user.id, entityType: "staff_profile", entityId: `${targetSiteId ?? "all"}:${input.userId}`, action: "assign_role", afterData: { ...input, assignedSiteId: targetSiteId } });
        return { success: true };
      }),
    create: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), email: z.string().email(), name: z.string().trim().min(2).max(160), temporaryPassword: z.string().min(8).max(128), role: z.enum(["manager", "accountant", "collector", "technician", "viewer"]), allBranches: z.boolean().default(false) })).mutation(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner"], "manageTeam");
      const db = await dbOrThrow();
      const tenantId = await getSiteTenant(input.siteId);
      const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, input.email.trim().toLowerCase())).limit(1);
      if (existing.length) throw new TRPCError({ code: "CONFLICT", message: "يوجد حساب بهذا البريد. استخدم خيار تعيين مستخدم موجود." });
      const allowedRoles = await ownerAllowedSubaccountRoles();
      if (!allowedRoles.includes(input.role as OwnerSubaccountRole)) throw new TRPCError({ code: "FORBIDDEN", message: "هذا الدور غير مسموح للحسابات الفرعية وفق سياسة آدمن المنصة." });
      const [limit, currentCount] = await Promise.all([ownerSubaccountLimit(tenantId), activeSubaccountCount(tenantId)]);
      if (currentCount >= limit) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "وصلت إلى الحد الأقصى للحسابات الفرعية في اشتراكك (" + limit + ")." });
      const { data: created, error } = await supabaseAdmin().auth.admin.createUser({ email: input.email.trim().toLowerCase(), password: input.temporaryPassword, email_confirm: true, user_metadata: { name: input.name } });
      if (error || !created.user) throw new TRPCError({ code: "BAD_REQUEST", message: "تعذر إنشاء الحساب في نظام المصادقة. قد يكون البريد مستخدماً بالفعل." });
      try {
        const user = await syncSupabaseUser({ id: created.user.id, email: input.email.trim().toLowerCase(), name: input.name });
        await db.update(users).set({ role: "user", platformRole: null, mustChangePassword: true, temporaryPasswordIssuedAt: new Date(), accountStatus: "active" }).where(eq(users.id, user.id));
        await db.insert(tenantMembers).values({ tenantId, userId: user.id, role: "member", isActive: true, membershipStatus: "active", invitedByUserId: ctx.user.id });
        await db.insert(staffProfiles).values({ tenantId, siteId: input.allBranches ? null : input.siteId, userId: user.id, role: input.role, isActive: true });
        await writeAudit({ userId: ctx.user.id, entityType: "staff_profile", entityId: "new:" + user.id, action: "create_subaccount", afterData: { userId: user.id, email: input.email.trim().toLowerCase(), role: input.role, allBranches: input.allBranches } });
        return { success: true, userId: user.id };
      } catch (error) { await supabaseAdmin().auth.admin.deleteUser(created.user.id); throw error; }
    }),
    activity: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), userId: z.number().int().positive() })).query(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner"], "manageTeam");
      const tenantId = await getSiteTenant(input.siteId);
      const db = await dbOrThrow();
      return db.select({ id: auditLogs.id, action: auditLogs.action, entityType: auditLogs.entityType, createdAt: auditLogs.createdAt, metadata: auditLogs.metadata, afterData: auditLogs.afterData }).from(auditLogs)
        .where(and(eq(auditLogs.tenantId, tenantId), eq(auditLogs.siteId, input.siteId), eq(auditLogs.userId, input.userId))).orderBy(desc(auditLogs.createdAt)).limit(15);
    }),
    resetPassword: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), profileId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner"], "manageTeam");
      const tenantId = await getSiteTenant(input.siteId); const db = await dbOrThrow();
      const [profile] = await db.select({ userId: staffProfiles.userId, siteId: staffProfiles.siteId, email: users.email }).from(staffProfiles).innerJoin(users, eq(staffProfiles.userId, users.id))
        .where(and(eq(staffProfiles.id, input.profileId), eq(staffProfiles.tenantId, tenantId), or(eq(staffProfiles.siteId, input.siteId), isNull(staffProfiles.siteId)))).limit(1);
      if (!profile?.email) throw new TRPCError({ code: "NOT_FOUND", message: "الحساب الفرعي غير موجود أو لا يملك بريداً صالحاً." });
      const temporaryPassword = randomBytes(12).toString("base64url") + "A1!";
      const { error } = await supabaseAdmin().auth.admin.updateUserById((await db.select({ openId: users.openId }).from(users).where(eq(users.id, profile.userId)).limit(1))[0]?.openId ?? "", { password: temporaryPassword });
      if (error) throw new TRPCError({ code: "BAD_REQUEST", message: "تعذر إعادة تعيين كلمة المرور في نظام المصادقة." });
      await db.update(users).set({ mustChangePassword: true, temporaryPasswordIssuedAt: new Date() }).where(eq(users.id, profile.userId));
      await writeAudit({ userId: ctx.user.id, siteId: input.siteId, entityType: "staff_profile", entityId: String(input.profileId), action: "reset_temporary_password", afterData: { targetUserId: profile.userId } });
      return { success: true, temporaryPassword };
    }),
    suspend: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), profileId: z.number().int().positive(), startsAt: z.string().datetime(), endsAt: z.string().datetime() })).mutation(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner"], "manageTeam");
      const tenantId = await getSiteTenant(input.siteId); const db = await dbOrThrow();
      const startsAt = new Date(input.startsAt); const endsAt = new Date(input.endsAt);
      if (endsAt <= startsAt) throw new TRPCError({ code: "BAD_REQUEST", message: "يجب أن يكون تاريخ نهاية التوقيف بعد تاريخ البداية." });
      const [profile] = await db.select({ id: staffProfiles.id, userId: staffProfiles.userId, siteId: staffProfiles.siteId }).from(staffProfiles).where(and(eq(staffProfiles.id, input.profileId), eq(staffProfiles.tenantId, tenantId), or(eq(staffProfiles.siteId, input.siteId), isNull(staffProfiles.siteId)))).limit(1);
      if (!profile) throw new TRPCError({ code: "NOT_FOUND", message: "الحساب الفرعي غير موجود ضمن نطاقك." });
      await db.update(staffProfiles).set({ suspensionStartedAt: startsAt, suspensionEndsAt: endsAt, updatedAt: new Date() }).where(eq(staffProfiles.id, input.profileId));
      await writeAudit({ userId: ctx.user.id, siteId: input.siteId, entityType: "staff_profile", entityId: String(input.profileId), action: "suspend_until", afterData: { targetUserId: profile.userId, suspensionStartedAt: startsAt.toISOString(), suspensionEndsAt: endsAt.toISOString() } });
      return { success: true, suspensionEndsAt: endsAt };
    }),
    clearSuspension: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), profileId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner"], "manageTeam");
      const tenantId = await getSiteTenant(input.siteId); const db = await dbOrThrow();
      const [profile] = await db.select({ id: staffProfiles.id, userId: staffProfiles.userId }).from(staffProfiles).where(and(eq(staffProfiles.id, input.profileId), eq(staffProfiles.tenantId, tenantId), or(eq(staffProfiles.siteId, input.siteId), isNull(staffProfiles.siteId)))).limit(1);
      if (!profile) throw new TRPCError({ code: "NOT_FOUND", message: "الحساب الفرعي غير موجود ضمن نطاقك." });
      await db.update(staffProfiles).set({ suspensionStartedAt: null, suspensionEndsAt: null, updatedAt: new Date() }).where(eq(staffProfiles.id, input.profileId));
      await writeAudit({ userId: ctx.user.id, siteId: input.siteId, entityType: "staff_profile", entityId: String(input.profileId), action: "clear_suspension", afterData: { targetUserId: profile.userId } });
      return { success: true };
    }),
    setActive: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), profileId: z.number().int().positive(), isActive: z.boolean() })).mutation(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner"], "manageTeam");
      const db = await dbOrThrow();
      const tenantId = await getSiteTenant(input.siteId);
      const [profile] = await db.select({ id: staffProfiles.id, userId: staffProfiles.userId, siteId: staffProfiles.siteId }).from(staffProfiles)
        .where(and(eq(staffProfiles.id, input.profileId), eq(staffProfiles.tenantId, tenantId), or(eq(staffProfiles.siteId, input.siteId), isNull(staffProfiles.siteId)))).limit(1);
      if (!profile) throw new TRPCError({ code: "NOT_FOUND", message: "الحساب الفرعي غير موجود ضمن نطاقك." });
      await db.update(staffProfiles).set({ isActive: input.isActive, updatedAt: new Date() }).where(eq(staffProfiles.id, input.profileId));
      await writeAudit({ userId: ctx.user.id, siteId: input.siteId, entityType: "staff_profile", entityId: String(input.profileId), action: input.isActive ? "activate" : "deactivate", afterData: { isActive: input.isActive, userId: profile.userId, profileSiteId: profile.siteId } });
      return { success: true, isActive: input.isActive };
    }),
  }),
  subscription: router({
    currentUpgradeRequest: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "viewer"]);
      const db = await dbOrThrow();
      const tenantId = await getSiteTenant(input.siteId);
      const [request] = await db.select({ id: subscriptionUpgradeRequests.id, currentPlan: subscriptionUpgradeRequests.currentPlan, requestedPlan: subscriptionUpgradeRequests.requestedPlan, status: subscriptionUpgradeRequests.status, note: subscriptionUpgradeRequests.note, createdAt: subscriptionUpgradeRequests.createdAt, reviewedAt: subscriptionUpgradeRequests.reviewedAt })
        .from(subscriptionUpgradeRequests).where(eq(subscriptionUpgradeRequests.tenantId, tenantId)).orderBy(desc(subscriptionUpgradeRequests.createdAt)).limit(1);
      return request ?? null;
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
      const db = await dbOrThrow();
      return db.select({
        portalCode: sitePortalSettings.portalCode,
        displayName: sitePortalSettings.displayName,
        primaryColor: sitePortalSettings.primaryColor,
        accentColor: sitePortalSettings.accentColor,
        siteName: sites.name,
        city: sites.city,
      }).from(sitePortalSettings)
        .innerJoin(sites, eq(sitePortalSettings.siteId, sites.id))
        .where(and(eq(sitePortalSettings.isEnabled, true), eq(sites.status, "active")))
        .orderBy(sites.name);
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
      const { portal, subscriber } = await getVerifiedPortalSubscriber(input);
      const db = await dbOrThrow();
      const [rawInvoices, paymentRows] = await Promise.all([
        db.select().from(invoices).where(and(eq(invoices.siteId, portal.siteId), eq(invoices.subscriberId, subscriber.id))).orderBy(desc(invoices.issueDate)).limit(24),
        db.select({
          id: payments.id,
          paymentNo: payments.paymentNo,
          amount: payments.amount,
          paymentMethod: payments.paymentMethod,
          status: payments.status,
          paidAt: payments.paidAt,
          invoiceNo: invoices.invoiceNo,
        }).from(payments).leftJoin(invoices, eq(payments.invoiceId, invoices.id))
          .where(and(eq(payments.siteId, portal.siteId), eq(payments.subscriberId, subscriber.id)))
          .orderBy(desc(payments.paidAt)).limit(24),
      ]);
      const subscriberInvoices = rawInvoices.filter((invoice) => invoice.status !== "draft" && invoice.status !== "cancelled");
      const currentPeriod = new Date().toISOString().slice(0, 7);
      const currentInvoice = subscriberInvoices.find((invoice) => invoice.billingPeriod === currentPeriod);
      const completedPayments = paymentRows.filter((payment) => payment.status === "completed");
      const outstandingBalance = subscriberInvoices.reduce((total, invoice) => total + Number(invoice.balanceDue || 0), 0);
      return {
        portal: { portalCode: portal.portalCode, displayName: portal.displayName || portal.siteName, primaryColor: portal.primaryColor, accentColor: portal.accentColor, city: portal.city },
        subscriber: {
          subscriberNo: subscriber.subscriberNo,
          fullName: subscriber.fullName,
          phone: subscriber.phone,
          address: subscriber.address,
          subscriptionType: subscriber.subscriptionType,
          serviceStatus: subscriber.serviceStatus,
          joinedAt: subscriber.createdAt,
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
      const { portal, subscriber } = await getVerifiedPortalSubscriber(input);
      const db = await dbOrThrow();
      const [invoice] = await db.select().from(invoices)
        .where(and(eq(invoices.siteId, portal.siteId), eq(invoices.subscriberId, subscriber.id), eq(invoices.invoiceNo, input.invoiceNo)))
        .limit(1);
      if (!invoice || invoice.status === "draft" || invoice.status === "cancelled") throw new TRPCError({ code: "NOT_FOUND", message: "الفاتورة غير متاحة للعرض." });
      const lines = await db.select({ description: invoiceLines.description, quantity: invoiceLines.quantity, unitPrice: invoiceLines.unitPrice, amount: invoiceLines.amount })
        .from(invoiceLines).where(eq(invoiceLines.invoiceId, invoice.id)).orderBy(invoiceLines.displayOrder);
      return {
        portal: { displayName: portal.displayName || portal.siteName, primaryColor: portal.primaryColor, accentColor: portal.accentColor },
        subscriber: { fullName: subscriber.fullName, subscriberNo: subscriber.subscriberNo, phone: subscriber.phone, address: subscriber.address },
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
      await requireRole(ctx.user.id, input.siteId, ["owner"]);
      const db = await dbOrThrow();
      const [site] = await db.select({ id: sites.id, tenantId: sites.tenantId, name: sites.name, code: sites.code }).from(sites).where(eq(sites.id, input.siteId)).limit(1);
      if (!site) throw new TRPCError({ code: "NOT_FOUND", message: "المحطة غير موجودة." });
      const [setting] = await db.select().from(sitePortalSettings).where(eq(sitePortalSettings.siteId, input.siteId)).limit(1);
      return setting || { siteId: site.id, tenantId: site.tenantId, portalCode: site.code.toLowerCase(), displayName: site.name, primaryColor: "#0D1117", accentColor: "#F5B800", isEnabled: true };
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
      const db = await dbOrThrow();
      if (ctx.user.role === "admin") return db.select().from(sites).orderBy(desc(sites.createdAt));
      const memberships = await db.select({ tenantId: tenantMembers.tenantId, role: tenantMembers.role }).from(tenantMembers)
        .where(and(eq(tenantMembers.userId, ctx.user.id), eq(tenantMembers.isActive, true), eq(tenantMembers.membershipStatus, "active")));
      const ownerTenantIds = memberships.filter((member) => member.role === "owner").map((member) => member.tenantId);
      const [ownedSites, assignedSites] = await Promise.all([
        ownerTenantIds.length ? db.select({ id: sites.id, name: sites.name, code: sites.code, city: sites.city, address: sites.address, status: sites.status, anomalyAlertPercent: sites.anomalyAlertPercent, invoiceDueDays: sites.invoiceDueDays, createdAt: sites.createdAt }).from(sites).where(inArray(sites.tenantId, ownerTenantIds)).orderBy(desc(sites.createdAt)) : Promise.resolve([]),
        db.select({ id: sites.id, name: sites.name, code: sites.code, city: sites.city, address: sites.address, status: sites.status, anomalyAlertPercent: sites.anomalyAlertPercent, invoiceDueDays: sites.invoiceDueDays, createdAt: sites.createdAt }).from(staffProfiles)
          .innerJoin(sites, eq(staffProfiles.siteId, sites.id))
          .innerJoin(tenantMembers, and(eq(tenantMembers.tenantId, sites.tenantId), eq(tenantMembers.userId, ctx.user.id), eq(tenantMembers.isActive, true), eq(tenantMembers.membershipStatus, "active")))
          .where(and(eq(staffProfiles.userId, ctx.user.id), eq(staffProfiles.isActive, true))).orderBy(desc(sites.createdAt)),
      ]);
      return Array.from(new Map([...ownedSites, ...assignedSites].map((site) => [site.id, site])).values());
    }),
    branchPolicy: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner"]);
      return tenantBranchPolicy(await getSiteTenant(input.siteId));
    }),
    create: protectedProcedure.input(siteInput).mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const existingMemberships = await db.select({ tenantId: tenantMembers.tenantId, role: tenantMembers.role, membershipStatus: tenantMembers.membershipStatus }).from(tenantMembers)
        .where(and(eq(tenantMembers.userId, ctx.user.id), eq(tenantMembers.isActive, true), eq(tenantMembers.membershipStatus, "active"))).limit(1);
      const existingMembership = existingMemberships[0];
      if (existingMembership && existingMembership.role !== "owner" && ctx.user.role !== "admin") {
        throw new TRPCError({ code: "FORBIDDEN", message: "إنشاء فرع جديد متاح لصاحب المولد فقط." });
      }
      if (existingMembership) {
        const policy = await tenantBranchPolicy(existingMembership.tenantId);
        if (!policy.isEnabled) throw new TRPCError({ code: "FORBIDDEN", message: "ميزة تعدد الأفرع غير مفعّلة لحسابك من إدارة المنصة." });
        if (policy.currentCount >= policy.maxBranches) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `وصلت إلى الحد الأقصى للأفرع في اشتراكك (${policy.maxBranches}).` });
      }
      const id = await db.transaction(async (tx) => {
        let tenantId = existingMembership?.tenantId;
        if (!tenantId) {
          tenantId = insertId(await tx.insert(tenants).values({ name: input.name, slug: `${input.code.toLowerCase()}-${ctx.user.id}` }));
          await tx.insert(tenantMembers).values({ tenantId, userId: ctx.user.id, role: "owner", isActive: true });
        }
        const siteId = insertId(await tx.insert(sites).values({ ...input, tenantId }));
        await tx.insert(sitePortalSettings).values({ tenantId, siteId, portalCode: input.code.toLowerCase(), displayName: input.name });
        return siteId;
      });
      await writeAudit({ userId: ctx.user.id, siteId: id, entityType: "site", entityId: String(id), action: "create", afterData: input });
      return { id };
    }),
    anomalyAlert: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "collector", "viewer"]);
      const db = await dbOrThrow();
      const [site] = await db.select({ anomalyAlertPercent: sites.anomalyAlertPercent }).from(sites).where(eq(sites.id, input.siteId)).limit(1);
      if (!site) throw new TRPCError({ code: "NOT_FOUND", message: "الفرع غير موجود." });
      return site;
    }),
    updateAnomalyAlert: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), anomalyAlertPercent: z.number().int().min(10).max(500) })).mutation(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner"]);
      const db = await dbOrThrow();
      await db.update(sites).set({ anomalyAlertPercent: input.anomalyAlertPercent, updatedAt: new Date() }).where(eq(sites.id, input.siteId));
      await writeAudit({ userId: ctx.user.id, siteId: input.siteId, entityType: "site", entityId: String(input.siteId), action: "update_anomaly_alert", afterData: input });
      return { success: true, anomalyAlertPercent: input.anomalyAlertPercent };
    }),
    updateBranch: protectedProcedure.input(siteInput.pick({ name: true, city: true, address: true }).extend({ siteId: z.number().int().positive(), status: z.enum(["active", "inactive", "archived"]), invoiceDueDays: z.number().int().min(1).max(90) })).mutation(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner"]);
      const db = await dbOrThrow();
      await db.update(sites).set({ name: input.name, city: input.city, address: input.address, status: input.status, invoiceDueDays: input.invoiceDueDays, updatedAt: new Date() }).where(eq(sites.id, input.siteId));
      await writeAudit({ userId: ctx.user.id, siteId: input.siteId, entityType: "branch", entityId: String(input.siteId), action: "update", afterData: input });
      return { success: true };
    }),
  }),

  subscribers: router({
    list: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "collector", "viewer"]);
      const db = await dbOrThrow();
      return db.select().from(subscribers).where(eq(subscribers.siteId, input.siteId)).orderBy(desc(subscribers.createdAt));
    }),
    quota: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "collector", "viewer"]);
      return ownerSubscriberQuota(await getSiteTenant(input.siteId));
    }),
    create: protectedProcedure.input(siteInput.pick({ code: true }).extend({
      siteId: z.number().int().positive(),
      fullName: z.string().min(2).max(180),
      phone: z.string().min(5).max(30),
      address: z.string().max(1000).optional(),
      subscriptionType: z.enum(["residential", "commercial"]).default("residential"),
    }).omit({ code: true })).mutation(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, createRoles, "manageSubscribers");
      const db = await dbOrThrow();
      const tenantId = await getSiteTenant(input.siteId);
      const quota = await ownerSubscriberQuota(tenantId);
      if (quota.currentCount >= quota.limit) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `وصلت إلى الحد الأقصى للمشتركين في باقتك (${quota.limit}). تواصل مع إدارة المنصة لترقية الاشتراك.` });
      const phone = normalizeInternationalPhone(input.phone);
      const [site] = await db.select({ code: sites.code }).from(sites).where(eq(sites.id, input.siteId)).limit(1);
      if (!site) throw new TRPCError({ code: "NOT_FOUND", message: "المحطة غير موجودة." });
      const [portalSetting] = await db.select({ portalCode: sitePortalSettings.portalCode }).from(sitePortalSettings).where(eq(sitePortalSettings.siteId, input.siteId)).limit(1);
      const portalCode = portalSetting?.portalCode ?? site.code.toLowerCase();
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const subscriberNo = generateSubscriberReference(site.code);
        try {
          const id = insertId(await db.insert(subscribers).values({ ...input, subscriberNo, phone, tenantId }));
          await writeAudit({ userId: ctx.user.id, entityType: "subscriber", entityId: String(id), action: "create", afterData: { ...input, subscriberNo, phone } });
          const channels = await db.select({ channel: tenantMessagingConfigurations.channel }).from(tenantMessagingConfigurations)
            .where(and(eq(tenantMessagingConfigurations.tenantId, tenantId), eq(tenantMessagingConfigurations.isActive, true)));
          const renderedText = renderSubscriberReferenceMessage({ subscriberName: input.fullName, subscriberNo, portalCode });
          const notificationIds = await Promise.all(channels.map(async ({ channel }) => insertId(await db.insert(notificationMessages).values({
            tenantId, subscriberId: id, channel, eventType: "subscriber_reference", recipient: phone, status: "pending",
            payload: { renderedText, subscriberReferenceTemplateParameters: subscriberReferenceTemplateParameters({ subscriberName: input.fullName, subscriberNo, portalCode }), subscriberNo, portalCode },
          }))));
          const deliveries = await Promise.all(notificationIds.map(async (notificationId) => ({ notificationId, ...await processNotificationById(notificationId).catch((error) => ({ status: "failed" as const, error: error instanceof Error ? error.message : "تعذر بدء إرسال الرسالة." })) })));
          return { id, subscriberNo, referenceNotifications: deliveries };
        } catch (error) {
          if (!isDuplicateKeyError(error) || attempt === 4) throw error;
        }
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
      const accepted: Array<{ sourceRow: number; subscriberNo?: string; fullName: string; phone: string; address?: string; subscriptionType: "residential" | "commercial" }> = [];
      for (const row of input.rows) {
        if (row.fullName.trim().length < 2) { failureRows.push({ sourceRow: row.sourceRow, fullName: row.fullName, reason: "الاسم الكامل قصير جداً." }); continue; }
        let phone: string;
        try { phone = normalizeInternationalPhone(row.phone); }
        catch { failureRows.push({ sourceRow: row.sourceRow, fullName: row.fullName, reason: "رقم الجوال غير صالح؛ استخدم رمز الدولة مثل +970." }); continue; }
        if (seenPhones.has(phone)) { failureRows.push({ sourceRow: row.sourceRow, fullName: row.fullName, reason: "رقم الجوال مكرر داخل ملف الاستيراد." }); continue; }
        seenPhones.add(phone);
        const subscriberNo = row.subscriberNo?.replace(/\s+/g, "").toUpperCase();
        if (subscriberNo && !/^[A-Z0-9][A-Z0-9_-]{1,79}$/.test(subscriberNo)) { failureRows.push({ sourceRow: row.sourceRow, fullName: row.fullName, reason: "الرقم المرجعي غير صالح." }); continue; }
        if (subscriberNo && seenReferences.has(subscriberNo)) { failureRows.push({ sourceRow: row.sourceRow, fullName: row.fullName, reason: "الرقم المرجعي مكرر داخل ملف الاستيراد." }); continue; }
        if (subscriberNo) seenReferences.add(subscriberNo);
        accepted.push({ sourceRow: row.sourceRow, subscriberNo, fullName: row.fullName.trim(), phone, address: row.address?.trim() || undefined, subscriptionType: row.subscriptionType });
      }
      const existing = await db.select({ id: subscribers.id, subscriberNo: subscribers.subscriberNo, fullName: subscribers.fullName, phone: subscribers.phone, address: subscribers.address, subscriptionType: subscribers.subscriptionType }).from(subscribers).where(eq(subscribers.siteId, input.siteId));
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
          await db.update(subscribers).set({ fullName: row.fullName, phone: row.phone, address: row.address, subscriptionType: row.subscriptionType }).where(eq(subscribers.id, matched.id));
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
            const id = insertId(await db.insert(subscribers).values({ tenantId, siteId: input.siteId, subscriberNo, fullName: row.fullName, phone: row.phone, address: row.address, subscriptionType: row.subscriptionType }));
            await writeAudit({ userId: ctx.user.id, siteId: input.siteId, entityType: "subscriber", entityId: String(id), action: "bulk_import_create", afterData: { fullName: row.fullName, phone: row.phone, subscriberNo, sourceRow: row.sourceRow } });
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
      return { created, updated, failed: failureRows.sort((a, b) => a.sourceRow - b.sourceRow), notificationsQueued: 0, message: "لم تُرسل رسائل الأرقام المرجعية تلقائياً ضمن الاستيراد الجماعي لحماية رصيد الرسائل؛ استخدم إرسال الإشعارات بعد المراجعة." };
    }),
    update: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(), id: z.number().int().positive(), fullName: z.string().min(2).max(180), phone: z.string().min(5).max(30),
      address: z.string().max(1000).optional(), subscriptionType: z.enum(["residential", "commercial"]), serviceStatus: z.enum(["active", "suspended", "disconnected"]),
    })).mutation(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "manageSubscribers");
      const db = await dbOrThrow();
      const [existing] = await db.select().from(subscribers).where(and(eq(subscribers.id, input.id), eq(subscribers.siteId, input.siteId))).limit(1);
      if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "المشترك غير موجود ضمن المحطة المحددة." });
      const phone = normalizeInternationalPhone(input.phone);
      await db.update(subscribers).set({ fullName: input.fullName, phone, address: input.address, subscriptionType: input.subscriptionType, serviceStatus: input.serviceStatus }).where(eq(subscribers.id, input.id));
      await writeAudit({ userId: ctx.user.id, entityType: "subscriber", entityId: String(input.id), action: "update", beforeData: existing, afterData: { ...input, phone } });
      return { success: true };
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
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "viewer"]);
      const db = await dbOrThrow();
      return db.select().from(tariffs).where(eq(tariffs.siteId, input.siteId)).orderBy(desc(tariffs.effectiveFrom));
    }),
    create: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(), name: z.string().min(2).max(160), code: z.string().min(2).max(50),
      pricePerKwh: z.number().min(0), fixedFee: z.number().min(0).default(0), taxRate: z.number().min(0).max(100).default(0),
    })).mutation(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, createRoles, "manageTariffs");
      const db = await dbOrThrow();
      const tenantId = await getSiteTenant(input.siteId);
      const id = insertId(await db.insert(tariffs).values({ ...input, tenantId, pricePerKwh: String(input.pricePerKwh), fixedFee: String(input.fixedFee), taxRate: String(input.taxRate) }));
      await writeAudit({ userId: ctx.user.id, entityType: "tariff", entityId: String(id), action: "create", afterData: input });
      return { id };
    }),
  }),

  generators: router({
    list: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "technician", "viewer"]);
      const db = await dbOrThrow();
      return db.select().from(generators).where(eq(generators.siteId, input.siteId)).orderBy(desc(generators.createdAt));
    }),
    create: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(), code: z.string().min(2).max(50), name: z.string().min(2).max(160),
      serialNumber: z.string().max(100).optional(), ratedCapacityKw: z.string().regex(/^\d+(\.\d{1,3})?$/),
      fuelType: z.enum(["diesel", "gasoline", "gas", "other"]).default("diesel"),
    })).mutation(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "technician"], "manageGenerators");
      const db = await dbOrThrow();
      const tenantId = await getSiteTenant(input.siteId);
      const id = insertId(await db.insert(generators).values({ ...input, tenantId }));
      await writeAudit({ userId: ctx.user.id, entityType: "generator", entityId: String(id), action: "create", afterData: input });
      return { id };
    }),
    update: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(), id: z.number().int().positive(), name: z.string().min(2).max(160), ratedCapacityKw: z.string().regex(/^\d+(\.\d{1,3})?$/),
      fuelLevelLiters: z.string().regex(/^\d+(\.\d{1,2})?$/), operatingHours: z.string().regex(/^\d+(\.\d{1,2})?$/), status: z.enum(["active", "maintenance", "stopped", "offline"]),
    })).mutation(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "technician"], "manageGenerators");
      const db = await dbOrThrow();
      const [existing] = await db.select().from(generators).where(and(eq(generators.id, input.id), eq(generators.siteId, input.siteId))).limit(1);
      if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "المولد غير موجود ضمن المحطة المحددة." });
      await db.update(generators).set({ name: input.name, ratedCapacityKw: input.ratedCapacityKw, fuelLevelLiters: input.fuelLevelLiters, operatingHours: input.operatingHours, status: input.status }).where(eq(generators.id, input.id));
      await writeAudit({ userId: ctx.user.id, entityType: "generator", entityId: String(input.id), action: "update", beforeData: existing, afterData: input });
      return { success: true };
    }),
  }),

  readings: router({
    list: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "collector", "technician", "viewer"]);
      const db = await dbOrThrow();
      return db.select({ reading: meterReadings, subscriber: subscribers }).from(meterReadings)
        .innerJoin(subscribers, eq(meterReadings.subscriberId, subscribers.id))
        .where(eq(subscribers.siteId, input.siteId)).orderBy(desc(meterReadings.readingAt));
    }),
    create: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(), subscriberId: z.number().int().positive(), readingValue: z.string().regex(/^\d+(\.\d{1,3})?$/), readingAt: z.date().optional(),
      captureMethod: z.enum(["manual", "photo", "smart_meter"]).default("manual"), clientOperationId: z.string().uuid().optional(), imageData: z.string().max(9_500_000).optional(), imageMime: z.enum(["image/jpeg", "image/png", "image/webp"]).optional(), notes: z.string().max(1000).optional(), isReadingReset: z.boolean().default(false), overrideSameDay: z.boolean().default(false), fieldVerified: z.boolean().default(false),
    })).mutation(async ({ ctx, input }) => {
      const actorRole = await requireRole(ctx.user.id, input.siteId, readingRoles, "recordReadings");
      const db = await dbOrThrow();
      const tenantId = await getSiteTenant(input.siteId);
      const [subscriberScope] = await db.select({ id: subscribers.id }).from(subscribers).where(and(eq(subscribers.id, input.subscriberId), eq(subscribers.siteId, input.siteId), eq(subscribers.serviceStatus, "active"))).limit(1);
      if (!subscriberScope) throw new TRPCError({ code: "NOT_FOUND", message: "المشترك لا يتبع للمحطة المحددة أو أن خدمته غير نشطة." });
      if (input.clientOperationId) {
        const [existing] = await db.select({ id: meterReadings.id, consumptionKwh: meterReadings.consumptionKwh, status: meterReadings.status }).from(meterReadings)
          .where(and(eq(meterReadings.tenantId, tenantId), eq(meterReadings.clientOperationId, input.clientOperationId))).limit(1);
        if (existing) return { id: existing.id, consumptionKwh: Number(existing.consumptionKwh ?? 0), status: existing.status, replayed: true };
      }
      const readingAt = input.readingAt ?? new Date();
      const dayStart = new Date(readingAt); dayStart.setHours(0, 0, 0, 0);
      const nextDay = new Date(dayStart); nextDay.setDate(nextDay.getDate() + 1);
      const [sameDayReading] = await db.select({ id: meterReadings.id }).from(meterReadings)
        .where(and(eq(meterReadings.subscriberId, subscriberScope.id), gte(meterReadings.readingAt, dayStart), lt(meterReadings.readingAt, nextDay), ne(meterReadings.status, "rejected"))).limit(1);
      if (sameDayReading && (!input.overrideSameDay || !["owner", "manager", "accountant"].includes(actorRole))) throw new TRPCError({ code: "CONFLICT", message: "توجد قراءة مسجلة لهذا المشترك في اليوم نفسه. يقتصر تجاوز ذلك على المالك أو المدير أو المحاسب مع تأكيد صريح." });
      const [previous] = await db.select({ readingValue: meterReadings.readingValue }).from(meterReadings)
        .where(and(eq(meterReadings.subscriberId, subscriberScope.id), eq(meterReadings.status, "approved")))
        .orderBy(desc(meterReadings.readingAt)).limit(1);
      const previousValue = previous ? Number(previous.readingValue) : 0;
      const nextValue = Number(input.readingValue);
      if (nextValue < previousValue && !input.isReadingReset) throw new TRPCError({ code: "CONFLICT", message: "القراءة الحالية أقل من القراءة المعتمدة السابقة. فعّل خيار إعادة ضبط سجل القراءة وسجل ملاحظة للتأكيد." });
      if (nextValue < previousValue && !input.notes?.trim()) throw new TRPCError({ code: "BAD_REQUEST", message: "أدخل ملاحظة توضح سبب إعادة ضبط سجل القراءة قبل حفظها." });
      let imageKey: string | undefined;
      let imageHash: string | undefined;
      if (input.imageData) {
        if (!input.imageMime) throw new TRPCError({ code: "BAD_REQUEST", message: "نوع صورة القراءة غير مدعوم." });
        const imageBytes = Buffer.from(input.imageData, "base64");
        if (imageBytes.byteLength === 0 || imageBytes.byteLength > 7 * 1024 * 1024) throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: "يجب ألا يتجاوز حجم صورة القراءة 7 ميغابايت." });
        imageHash = crypto.createHash("sha256").update(imageBytes).digest("hex");
        const extension = input.imageMime === "image/png" ? "png" : input.imageMime === "image/webp" ? "webp" : "jpg";
        const stored = await storagePut(`subscriber-readings/${ctx.user.id}/${subscriberScope.id}-${Date.now()}.${extension}`, imageBytes, input.imageMime);
        imageKey = stored.key;
      }
      const id = insertId(await db.insert(meterReadings).values({
        tenantId, subscriberId: subscriberScope.id, clientOperationId: input.clientOperationId, readingAt, readingValue: input.readingValue, previousReadingValue: previous?.readingValue,
        consumptionKwh: String(input.isReadingReset && nextValue < previousValue ? nextValue : nextValue - previousValue), captureMethod: input.captureMethod, imageKey, imageHash,
        notes: [input.isReadingReset ? "[إعادة ضبط سجل القراءة]" : "", input.fieldVerified ? "[تم التحقق ميدانياً]" : "", input.notes?.trim() ?? ""].filter(Boolean).join(" "), enteredByUserId: ctx.user.id,
      }));
      const consumptionKwh = input.isReadingReset && nextValue < previousValue ? nextValue : nextValue - previousValue;
      await writeAudit({ userId: ctx.user.id, siteId: input.siteId, entityType: "meter_reading", entityId: String(id), action: "create", afterData: { ...input, readingAt, consumptionKwh } });
      return { id, consumptionKwh, status: "pending_review" as const, replayed: false };
    }),
    updatePending: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), readingId: z.number().int().positive(), baseVersion: z.number().int().positive(), readingValue: z.string().regex(/^\d+(\.\d{1,3})?$/), readingAt: z.date(), notes: z.string().max(1000).optional() })).mutation(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "approveReadings");
      const db = await dbOrThrow();
      const [existing] = await db.select({ id: meterReadings.id, subscriberId: meterReadings.subscriberId, status: meterReadings.status }).from(meterReadings)
        .innerJoin(subscribers, eq(meterReadings.subscriberId, subscribers.id))
        .where(and(eq(meterReadings.id, input.readingId), eq(subscribers.siteId, input.siteId))).limit(1);
      if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "القراءة لا تتبع للفرع المحدد." });
      if (existing.status !== "pending_review") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "لا يمكن تعديل قراءة معتمدة أو مرفوضة من هذه الواجهة." });
      const [previous] = await db.select({ readingValue: meterReadings.readingValue }).from(meterReadings)
        .where(and(eq(meterReadings.subscriberId, existing.subscriberId), eq(meterReadings.status, "approved"))).orderBy(desc(meterReadings.readingAt)).limit(1);
      const currentValue = Number(input.readingValue); const previousValue = Number(previous?.readingValue ?? 0);
      if (currentValue < previousValue) throw new TRPCError({ code: "CONFLICT", message: "القراءة المعدلة أقل من القراءة السابقة المعتمدة." });
      const result = await db.update(meterReadings).set({ readingValue: input.readingValue, readingAt: input.readingAt, previousReadingValue: previous?.readingValue, consumptionKwh: String(currentValue - previousValue), notes: input.notes, versionNo: sql`${meterReadings.versionNo} + 1` }).where(and(eq(meterReadings.id, input.readingId), eq(meterReadings.versionNo, input.baseVersion), eq(meterReadings.status, "pending_review")));
      if (Number((result[0] as { affectedRows?: number }).affectedRows ?? 0) !== 1) throw new TRPCError({ code: "CONFLICT", message: "تم تعديل القراءة من جهة أخرى؛ حدّث الصفحة ثم أعد المحاولة." });
      await writeAudit({ userId: ctx.user.id, siteId: input.siteId, entityType: "meter_reading", entityId: String(input.readingId), action: "update_pending", afterData: input });
      return { success: true, consumptionKwh: currentValue - previousValue };
    }),
    deletePending: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), readingId: z.number().int().positive(), baseVersion: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "recordReadings");
      const db = await dbOrThrow();
      const [existing] = await db.select({ id: meterReadings.id, status: meterReadings.status, versionNo: meterReadings.versionNo }).from(meterReadings)
        .innerJoin(subscribers, eq(meterReadings.subscriberId, subscribers.id))
        .where(and(eq(meterReadings.id, input.readingId), eq(subscribers.siteId, input.siteId))).limit(1);
      if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "القراءة لا تتبع للفرع المحدد." });
      if (existing.status !== "pending_review") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "يمكن حذف القراءات بانتظار المراجعة فقط." });
      if (existing.versionNo !== input.baseVersion) throw new TRPCError({ code: "CONFLICT", message: "تم تحديث القراءة من جهة أخرى؛ حدّث الصفحة ثم أعد المحاولة." });
      await db.delete(meterReadings).where(and(eq(meterReadings.id, input.readingId), eq(meterReadings.versionNo, input.baseVersion), eq(meterReadings.status, "pending_review")));
      await writeAudit({ userId: ctx.user.id, siteId: input.siteId, entityType: "meter_reading", entityId: String(input.readingId), action: "delete_pending" });
      return { success: true };
    }),
    approve: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), readingId: z.number().int().positive(), baseVersion: z.number().int().positive(), sendNow: z.boolean().default(true) }))
      .mutation(async ({ ctx, input }) => {
        await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "approveReadings");
        const db = await dbOrThrow();
        const [readingScope] = await db.select({ id: meterReadings.id }).from(meterReadings)
          .innerJoin(subscribers, eq(meterReadings.subscriberId, subscribers.id))
          .where(and(eq(meterReadings.id, input.readingId), eq(subscribers.siteId, input.siteId))).limit(1);
        if (!readingScope) throw new TRPCError({ code: "NOT_FOUND", message: "القراءة لا تتبع للمحطة المحددة." });
        const tenantId = await getSiteTenant(input.siteId);
        const [mobileAudit] = await db.select({ id: auditLogs.id }).from(auditLogs).where(and(eq(auditLogs.tenantId, tenantId), eq(auditLogs.siteId, input.siteId), eq(auditLogs.entityType, "meter_reading"), eq(auditLogs.entityId, String(input.readingId)), eq(auditLogs.action, "mobile_create"))).limit(1);
        if (mobileAudit) {
          await requireRole(ctx.user.id, input.siteId, createRoles, "issueInvoices");
          const issued = await approveAndIssueMobileReading({ ...input, userId: ctx.user.id });
          return { success: true, automaticInvoice: issued };
        }
        const result = await db.update(meterReadings).set({ status: "approved", reviewedByUserId: ctx.user.id, reviewedAt: new Date(), versionNo: sql`${meterReadings.versionNo} + 1` })
          .where(and(eq(meterReadings.id, input.readingId), eq(meterReadings.versionNo, input.baseVersion)));
        if (Number((result[0] as { affectedRows?: number }).affectedRows ?? 0) !== 1) throw new TRPCError({ code: "CONFLICT", message: "تم تعديل القراءة من جهة أخرى؛ حدّث البيانات ثم أعد المحاولة." });
        await writeAudit({ userId: ctx.user.id, siteId: input.siteId, entityType: "meter_reading", entityId: String(input.readingId), action: "approve" });
        return { success: true };
      }),
  }),

  invoices: router({
    list: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "collector", "viewer"]);
      const db = await dbOrThrow();
      return db.select().from(invoices).where(eq(invoices.siteId, input.siteId)).orderBy(desc(invoices.issueDate));
    }),
    createFromReading: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(), readingId: z.number().int().positive(), tariffId: z.number().int().positive(),
      billingPeriod: z.string().regex(/^\d{4}-\d{2}$/), dueDate: z.date(), discountAmount: z.number().min(0).default(0),
    })).mutation(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, createRoles, "issueInvoices");
      const db = await dbOrThrow();
      const [readingScope] = await db.select({ reading: meterReadings, subscriber: subscribers }).from(meterReadings)
        .innerJoin(subscribers, eq(meterReadings.subscriberId, subscribers.id))
        .where(and(eq(meterReadings.id, input.readingId), eq(subscribers.siteId, input.siteId))).limit(1);
      const reading = readingScope?.reading;
      const subscriber = readingScope?.subscriber;
      if (!reading || reading.status !== "approved" || !subscriber) throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن فوترة قراءة غير معتمدة أو لا تتبع للمحطة المحددة." });
      const [tariff] = await db.select().from(tariffs).where(and(eq(tariffs.id, input.tariffId), eq(tariffs.siteId, input.siteId), eq(tariffs.isActive, true))).limit(1);
      const [site] = await db.select().from(sites).where(eq(sites.id, input.siteId)).limit(1);
      if (!tariff || !site || !subscriber) throw new TRPCError({ code: "NOT_FOUND", message: "بيانات المشترك أو التعرفة أو المحطة غير مكتملة." });
      await assertFinancialPeriodOpen(db, site.tenantId, input.siteId, input.dueDate, ctx.user.id, "invoice");
      const [tenantMessaging, platformDeliverySettings, tenantTemplates] = await Promise.all([
        db.select({ channel: tenantMessagingConfigurations.channel, isActive: tenantMessagingConfigurations.isActive })
          .from(tenantMessagingConfigurations).where(eq(tenantMessagingConfigurations.tenantId, site.tenantId)),
        db.select({ isEnabled: platformSettings.isEnabled, value: platformSettings.value }).from(platformSettings)
          .where(eq(platformSettings.settingKey, "invoice_delivery_channels")).limit(1),
        db.select({ channel: tenantInvoiceMessageTemplates.channel, body: tenantInvoiceMessageTemplates.body, isActive: tenantInvoiceMessageTemplates.isActive }).from(tenantInvoiceMessageTemplates)
          .where(and(eq(tenantInvoiceMessageTemplates.tenantId, site.tenantId), eq(tenantInvoiceMessageTemplates.eventType, "invoice_issued"))),
      ]);
      const tenantChannels = resolveInvoiceNotificationChannels(tenantMessaging, invoiceDeliveryPolicyFromSetting(platformDeliverySettings[0]));
      const templateByChannel = new Map(tenantTemplates.filter((template) => template.isActive).map((template) => [template.channel, template.body]));
      const countResult = await db.select({ count: sql<number>`count(*)` }).from(invoices).where(eq(invoices.siteId, input.siteId));
      const calculated = calculateInvoiceAmounts({ consumptionKwh: Number(reading.consumptionKwh ?? 0), pricePerKwh: Number(tariff.pricePerKwh), fixedFee: Number(tariff.fixedFee), taxRate: Number(tariff.taxRate), discountAmount: input.discountAmount });
      const invoiceNo = nextInvoiceNo(site.code, input.billingPeriod, Number(countResult[0]?.count ?? 0) + 1);
      const id = await db.transaction(async (tx) => {
        const invoiceId = insertId(await tx.insert(invoices).values({
          tenantId: site.tenantId, siteId: input.siteId, subscriberId: subscriber.id, readingId: reading.id, tariffId: tariff.id,
          invoiceNo, billingPeriod: input.billingPeriod, dueDate: input.dueDate, previousReading: reading.previousReadingValue,
          currentReading: reading.readingValue, consumptionKwh: reading.consumptionKwh ?? "0", pricePerKwh: tariff.pricePerKwh,
          fixedFee: tariff.fixedFee, taxAmount: String(calculated.taxAmount), discountAmount: String(input.discountAmount),
          totalAmount: String(calculated.totalAmount), balanceDue: String(calculated.totalAmount), status: "issued", createdByUserId: ctx.user.id,
        }));
        const lines: Array<{ lineType: "energy" | "fixed_fee" | "tax" | "discount"; description: string; quantity: string; unitPrice: string; amount: string; displayOrder: number }> = [
          { lineType: "energy" as const, description: "استهلاك الكهرباء", quantity: String(reading.consumptionKwh ?? 0), unitPrice: tariff.pricePerKwh, amount: String(calculated.energyAmount), displayOrder: 1 },
          { lineType: "fixed_fee" as const, description: "رسم ثابت", quantity: "1", unitPrice: tariff.fixedFee, amount: tariff.fixedFee, displayOrder: 2 },
          { lineType: "tax" as const, description: "الضريبة", quantity: "1", unitPrice: String(tariff.taxRate), amount: String(calculated.taxAmount), displayOrder: 3 },
        ];
        if (input.discountAmount > 0) lines.push({ lineType: "discount" as const, description: "خصم", quantity: "1", unitPrice: String(input.discountAmount), amount: String(input.discountAmount), displayOrder: 4 });
        await tx.insert(invoiceLines).values(lines.map((line) => ({ ...line, tenantId: site.tenantId, invoiceId })));
        return invoiceId;
      });
      if (tenantChannels.length) await db.insert(notificationMessages).values(tenantChannels.map((channel) => ({
        tenantId: site.tenantId,
        invoiceId: id,
        subscriberId: subscriber.id,
        channel,
        eventType: "invoice_issued" as const,
        recipient: subscriber.phone,
        status: "pending" as const,
        payload: { invoiceNo, billingPeriod: input.billingPeriod, totalAmount: calculated.totalAmount, renderedText: renderInvoiceMessageTemplate(templateByChannel.get(channel) ?? defaultInvoiceMessageTemplates[channel], { subscriber_name: subscriber.fullName, invoice_no: invoiceNo, billing_period: input.billingPeriod, total_amount: String(calculated.totalAmount), due_date: input.dueDate.toLocaleDateString("ar-IQ") }) },
      })));
      await writeAudit({ userId: ctx.user.id, siteId: input.siteId, entityType: "invoice", entityId: String(id), action: "issue", afterData: { invoiceNo, ...calculated } });
      return { id, invoiceNo, totalAmount: calculated.totalAmount };
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
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "collector", "viewer"]);
      const db = await dbOrThrow();
      return db.select({ payment: payments, subscriber: subscribers, invoiceNo: invoices.invoiceNo }).from(payments)
        .innerJoin(subscribers, eq(payments.subscriberId, subscribers.id))
        .leftJoin(invoices, eq(payments.invoiceId, invoices.id))
        .where(eq(payments.siteId, input.siteId)).orderBy(desc(payments.paidAt));
    }),
    create: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(), subscriberId: z.number().int().positive(), invoiceId: z.number().int().positive().optional(),
      paymentNo: z.string().min(3).max(60), amount: z.number().positive(), paymentMethod: z.enum(["cash", "jawwal_pay", "palpay", "bank_of_palestine", "wallet", "bank_transfer", "card"]).default("cash"), transferFromAccount: z.string().trim().regex(/^\+?[0-9]{7,20}$/, "رقم الحساب المحوِّل يجب أن يكون رقم جوال صحيحاً.").optional(), transferFromType: z.enum(["jawwal_pay", "palpay", "bank_of_palestine"]).optional(), transferToAccount: z.string().trim().regex(/^\+?[0-9]{7,20}$/, "رقم الحساب المستقبِل يجب أن يكون رقم جوال صحيحاً.").optional(), transferToType: z.enum(["jawwal_pay", "palpay", "bank_of_palestine"]).optional(), referenceNo: z.string().max(120).optional(), receiptImageData: z.string().max(9_500_000).optional(), receiptImageMime: z.enum(["image/jpeg", "image/png", "image/webp"]).optional(),
    }).superRefine((input, ctx) => {
      const electronic = input.paymentMethod !== "cash";
      if (electronic && (!input.transferFromAccount || !input.transferFromType || !input.transferToAccount || !input.transferToType)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["transferFromAccount"], message: "للدفعات الإلكترونية يجب إدخال حساب التحويل المحوِّل والمستقبِل ونوع كل حساب." });
    })).mutation(async ({ ctx, input }) => {
      const role = await requireRole(ctx.user.id, input.siteId, recordRoles, "collectPayments");
      const db = await dbOrThrow();
      const [duplicatePayment] = await db.select({ id: payments.id }).from(payments).where(eq(payments.paymentNo, input.paymentNo)).limit(1);
      if (duplicatePayment) throw new TRPCError({ code: "CONFLICT", message: "رقم الإيصال مستخدم مسبقاً؛ أدخل رقماً مرجعياً مختلفاً." });
      const [subscriber] = await db.select({ id: subscribers.id }).from(subscribers).where(and(eq(subscribers.id, input.subscriberId), eq(subscribers.siteId, input.siteId))).limit(1);
      if (!subscriber) throw new TRPCError({ code: "NOT_FOUND", message: "المشترك لا يتبع للمحطة المحددة." });
      if (input.invoiceId) {
        const [invoiceScope] = await db.select({ id: invoices.id, balanceDue: invoices.balanceDue, status: invoices.status }).from(invoices).where(and(eq(invoices.id, input.invoiceId), eq(invoices.siteId, input.siteId), eq(invoices.subscriberId, input.subscriberId))).limit(1);
        if (!invoiceScope) throw new TRPCError({ code: "NOT_FOUND", message: "الفاتورة لا تتبع للمشترك والمحطة المحددين." });
        if (invoiceScope.status === "cancelled" || invoiceScope.status === "draft") throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن تسجيل دفعة على فاتورة ملغاة أو مسودة." });
        if (input.amount > Number(invoiceScope.balanceDue)) throw new TRPCError({ code: "BAD_REQUEST", message: "قيمة الدفعة تتجاوز الرصيد المتبقي للفواتير." });
      }
      const tenantId = await getSiteTenant(input.siteId);
      await assertFinancialPeriodOpen(db, tenantId, input.siteId, new Date(), ctx.user.id, "payment");
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
      if (role === "collector") {
        const [openSession] = await db.select({ id: collectorSessions.id }).from(collectorSessions).where(and(
          eq(collectorSessions.tenantId, tenantId), eq(collectorSessions.siteId, input.siteId), eq(collectorSessions.collectorUserId, ctx.user.id), eq(collectorSessions.status, "open"),
        )).limit(1);
        if (!openSession) throw new TRPCError({ code: "BAD_REQUEST", message: "افتح جلسة تحصيل قبل تسجيل دفعاتك الميدانية." });
        collectorSessionId = openSession.id;
      }
      const { receiptImageData: _receiptImageData, receiptImageMime: _receiptImageMime, ...paymentInput } = input;
      const id = insertId(await db.insert(payments).values({ ...paymentInput, tenantId, amount: String(input.amount), receiptImageKey, receiptImageHash, collectedByUserId: ctx.user.id, collectorSessionId }));
      if (input.invoiceId) {
        const [invoice] = await db.select().from(invoices).where(eq(invoices.id, input.invoiceId)).limit(1);
        if (invoice) {
          const paidAmount = Number(invoice.paidAmount) + input.amount;
          const balanceDue = Math.max(0, Number(invoice.totalAmount) - paidAmount);
          await db.update(invoices).set({ paidAmount: String(paidAmount), balanceDue: String(balanceDue), status: balanceDue === 0 ? "paid" : "partially_paid" }).where(eq(invoices.id, invoice.id));
        }
      }
      await writeAudit({ userId: ctx.user.id, siteId: input.siteId, entityType: "payment", entityId: String(id), action: "create", afterData: { ...paymentInput, receiptImageKey }, metadata: { collectorSessionId, receiptImageAttached: Boolean(receiptImageKey) } });
      const accountType = input.paymentMethod === "cash" ? "cash" : input.paymentMethod === "jawwal_pay" ? "jawwal_pay" : input.paymentMethod === "palpay" ? "palpay" : input.paymentMethod === "bank_of_palestine" ? "bank_of_palestine" : null;
      if (accountType) { const [account] = await db.select({ id: companyAccounts.id }).from(companyAccounts).where(and(eq(companyAccounts.tenantId, tenantId), eq(companyAccounts.accountType, accountType))).limit(1); if (account) await db.insert(accountTransactions).values({ tenantId, accountId: account.id, transactionType: "collection", amount: String(input.amount), description: `تحصيل الفاتورة ${input.paymentNo}`, referenceNo: input.referenceNo, relatedPaymentId: id, createdByUserId: ctx.user.id }); }
      return { id };
    }),
  }),

  collectorSessions: router({
    list: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      const role = await requireRole(ctx.user.id, input.siteId, recordRoles, "collectPayments");
      const db = await dbOrThrow();
      const scope = role === "collector" ? and(eq(collectorSessions.siteId, input.siteId), eq(collectorSessions.collectorUserId, ctx.user.id)) : eq(collectorSessions.siteId, input.siteId);
      return db.select({ session: collectorSessions, collector: users }).from(collectorSessions).innerJoin(users, eq(collectorSessions.collectorUserId, users.id)).where(scope).orderBy(desc(collectorSessions.openedAt)).limit(100);
    }),
    current: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, recordRoles, "collectPayments");
      const db = await dbOrThrow();
      const [session] = await db.select().from(collectorSessions).where(and(eq(collectorSessions.siteId, input.siteId), eq(collectorSessions.collectorUserId, ctx.user.id), eq(collectorSessions.status, "open"))).limit(1);
      return session ?? null;
    }),
    open: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), openingCash: z.number().min(0).default(0), notes: z.string().max(1000).optional() })).mutation(async ({ ctx, input }) => {
      const role = await requireRole(ctx.user.id, input.siteId, recordRoles, "collectPayments");
      if (role !== "collector") throw new TRPCError({ code: "FORBIDDEN", message: "جلسة التحصيل الميدانية مخصصة لدور المحصل." });
      const db = await dbOrThrow();
      const tenantId = await getSiteTenant(input.siteId);
      const [existing] = await db.select({ id: collectorSessions.id }).from(collectorSessions).where(and(eq(collectorSessions.tenantId, tenantId), eq(collectorSessions.siteId, input.siteId), eq(collectorSessions.collectorUserId, ctx.user.id), eq(collectorSessions.status, "open"))).limit(1);
      if (existing) throw new TRPCError({ code: "CONFLICT", message: "لديك جلسة تحصيل مفتوحة بالفعل لهذه المحطة." });
      const id = insertId(await db.insert(collectorSessions).values({ tenantId, siteId: input.siteId, collectorUserId: ctx.user.id, openingCash: String(input.openingCash), notes: input.notes }));
      await writeAudit({ userId: ctx.user.id, siteId: input.siteId, entityType: "collector_session", entityId: String(id), action: "open", afterData: input });
      return { id };
    }),
    close: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), sessionId: z.number().int().positive(), declaredCash: z.number().min(0), notes: z.string().max(1000).optional() })).mutation(async ({ ctx, input }) => {
      const role = await requireRole(ctx.user.id, input.siteId, recordRoles, "collectPayments");
      const db = await dbOrThrow();
      const [session] = await db.select().from(collectorSessions).where(and(eq(collectorSessions.id, input.sessionId), eq(collectorSessions.siteId, input.siteId))).limit(1);
      if (!session) throw new TRPCError({ code: "NOT_FOUND", message: "جلسة التحصيل غير موجودة ضمن المحطة المحددة." });
      if (session.status !== "open") throw new TRPCError({ code: "CONFLICT", message: "تم إغلاق جلسة التحصيل مسبقاً." });
      if (role === "collector" && session.collectorUserId !== ctx.user.id) throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكن للمحصل إغلاق جلسة محصل آخر." });
      const [cashTotals] = await db.select({ amount: sql<string>`coalesce(sum(${payments.amount}), 0)` }).from(payments).where(and(eq(payments.collectorSessionId, session.id), eq(payments.paymentMethod, "cash"), eq(payments.status, "completed")));
      const expectedCash = Number(session.openingCash) + Number(cashTotals?.amount ?? 0);
      const varianceAmount = input.declaredCash - expectedCash;
      await db.update(collectorSessions).set({ status: "closed", expectedCash: String(expectedCash), declaredCash: String(input.declaredCash), varianceAmount: String(varianceAmount), notes: input.notes ?? session.notes, closedAt: new Date(), closedByUserId: ctx.user.id }).where(eq(collectorSessions.id, session.id));
      await writeAudit({ userId: ctx.user.id, siteId: input.siteId, entityType: "collector_session", entityId: String(session.id), action: "close", beforeData: session, afterData: { declaredCash: input.declaredCash, expectedCash, varianceAmount } });
      return { expectedCash, varianceAmount };
    }),
  }),

  expenses: router({
    list: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "viewer"]);
      const db = await dbOrThrow();
      return db.select().from(expenses).where(eq(expenses.siteId, input.siteId)).orderBy(desc(expenses.occurredAt));
    }),
    create: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(), generatorId: z.number().int().positive().optional(), category: z.enum(["fuel", "maintenance", "payroll", "parts", "transport", "other"]),
      description: z.string().min(2).max(255), amount: z.number().positive(), referenceNo: z.string().max(120).optional(),
    })).mutation(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, createRoles, "manageExpenses");
      const db = await dbOrThrow();
      if (input.generatorId) {
        const [generator] = await db.select({ id: generators.id }).from(generators).where(and(eq(generators.id, input.generatorId), eq(generators.siteId, input.siteId))).limit(1);
        if (!generator) throw new TRPCError({ code: "NOT_FOUND", message: "المولد لا يتبع للمحطة المحددة." });
      }
      const tenantId = await getSiteTenant(input.siteId);
      await assertFinancialPeriodOpen(db, tenantId, input.siteId, new Date(), ctx.user.id, "expense");
      const id = insertId(await db.insert(expenses).values({ ...input, tenantId, amount: String(input.amount), createdByUserId: ctx.user.id }));
      await writeAudit({ userId: ctx.user.id, entityType: "expense", entityId: String(id), action: "create", afterData: input });
      return { id };
    }),
  }),

  dashboard: router({
    summary: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "collector", "technician", "viewer"]);
      const db = await dbOrThrow();
      const [subscriberCount] = await db.select({ value: sql<number>`count(*)` }).from(subscribers).where(and(eq(subscribers.siteId, input.siteId), eq(subscribers.serviceStatus, "active")));
      const [generatorStatus] = await db.select({ active: sql<number>`sum(case when ${generators.status} = 'active' then 1 else 0 end)`, maintenance: sql<number>`sum(case when ${generators.status} = 'maintenance' then 1 else 0 end)` }).from(generators).where(eq(generators.siteId, input.siteId));
      const [invoiceTotals] = await db.select({ invoiced: sql<string>`coalesce(sum(${invoices.totalAmount}), 0)`, paid: sql<string>`coalesce(sum(${invoices.paidAmount}), 0)`, outstanding: sql<string>`coalesce(sum(${invoices.balanceDue}), 0)`, energy: sql<string>`coalesce(sum(${invoices.consumptionKwh}), 0)` }).from(invoices).where(and(eq(invoices.siteId, input.siteId), sql`${invoices.status} <> 'cancelled'`));
      const [expenseTotals] = await db.select({ amount: sql<string>`coalesce(sum(${expenses.amount}), 0)` }).from(expenses).where(eq(expenses.siteId, input.siteId));
      const [notificationTotals] = await db.select({ failed: sql<number>`sum(case when ${notificationMessages.status} = 'failed' then 1 else 0 end)` }).from(notificationMessages).where(sql`${notificationMessages.subscriberId} in (select ${subscribers.id} from ${subscribers} where ${subscribers.siteId} = ${input.siteId})`);
      return { subscribers: Number(subscriberCount?.value ?? 0), generators: { active: Number(generatorStatus?.active ?? 0), maintenance: Number(generatorStatus?.maintenance ?? 0) }, financial: { invoiced: Number(invoiceTotals?.invoiced ?? 0), collected: Number(invoiceTotals?.paid ?? 0), outstanding: Number(invoiceTotals?.outstanding ?? 0), expenses: Number(expenseTotals?.amount ?? 0), operatingProfit: Number(invoiceTotals?.paid ?? 0) - Number(expenseTotals?.amount ?? 0) }, energyKwh: Number(invoiceTotals?.energy ?? 0), failedNotifications: Number(notificationTotals?.failed ?? 0) };
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
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "viewer"]);
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
    list: protectedProcedure.input(siteScoped.extend({ branchId: z.number().int().positive().optional(), allBranches: z.boolean().optional() })).query(async ({ ctx, input }) => { await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "viewer"]); const db=await dbOrThrow(); const tenantId=await getSiteTenant(input.siteId); const branchRows=input.allBranches ? await db.select({id:sites.id}).from(sites).where(and(eq(sites.tenantId,tenantId),ne(sites.status,"archived"))) : [{id:input.branchId??input.siteId}]; const branchIds=branchRows.map((row)=>row.id); if(!branchIds.length) return []; const validCount=await db.select({value:sql<number>`count(*)`}).from(sites).where(and(eq(sites.tenantId,tenantId),inArray(sites.id,branchIds))); if(Number(validCount[0]?.value??0)!==branchIds.length) throw new TRPCError({code:"NOT_FOUND",message:"الفرع غير موجود ضمن حساب الشركة."}); return db.select().from(financialSettlements).where(and(eq(financialSettlements.tenantId, tenantId), inArray(financialSettlements.siteId, branchIds))).orderBy(desc(financialSettlements.periodStart)).limit(300); }),
    create: protectedProcedure.input(z.object({ siteId:z.number().int().positive(), periodStart:z.string().datetime(), periodEnd:z.string().datetime(), totalCollected:z.number().nonnegative(), totalExpenses:z.number().nonnegative(), actualCash:z.number().nonnegative().optional(), notes:z.string().max(2000).optional() })).mutation(async ({ctx,input})=>{ await requireRole(ctx.user.id,input.siteId,["owner","manager","accountant"],"manageExpenses"); const db=await dbOrThrow(); const tenantId=await getSiteTenant(input.siteId); const start=new Date(input.periodStart), end=new Date(input.periodEnd); if(start>=end) throw new TRPCError({code:"BAD_REQUEST",message:"بداية الفترة يجب أن تسبق نهايتها."}); const bookProfit=input.totalCollected-input.totalExpenses; const difference=input.actualCash===undefined?null:input.actualCash-bookProfit; const id=insertId(await db.insert(financialSettlements).values({tenantId,siteId:input.siteId,periodStart:start,periodEnd:end,totalCollected:String(input.totalCollected),totalExpenses:String(input.totalExpenses),bookProfit:String(bookProfit),actualCash:input.actualCash===undefined?null:String(input.actualCash),difference:difference===null?null:String(difference),notes:input.notes??null,status:"draft",createdByUserId:ctx.user.id})); await writeAudit({userId:ctx.user.id,siteId:input.siteId,entityType:"financial_settlement",entityId:String(id),action:"create",afterData:input}); return {id}; }),
    exceptionalEdit: protectedProcedure.input(z.object({ siteId:z.number().int().positive(), entityType:z.enum(["invoice","payment","expense"]), entityId:z.number().int().positive(), reason:z.string().trim().min(10,"سبب التصحيح يجب ألا يقل عن 10 أحرف.").max(1000), changes:z.object({ description:z.string().trim().min(2).max(255).optional(), referenceNo:z.string().trim().max(120).optional(), dueDate:z.date().optional(), category:z.enum(["fuel","maintenance","payroll","parts","transport","other"]).optional() }).refine((value)=>Object.keys(value).length>0,{message:"أدخل حقلاً واحداً على الأقل للتعديل."}) })).mutation(async({ctx,input})=>{ await requireRole(ctx.user.id,input.siteId,["manager"],"manageExpenses"); const db=await dbOrThrow(); const tenantId=await getSiteTenant(input.siteId); let before:any; let occurredAt:Date;
      if(input.entityType==="invoice"){ [before]=await db.select().from(invoices).where(and(eq(invoices.id,input.entityId),eq(invoices.siteId,input.siteId),eq(invoices.tenantId,tenantId))).limit(1); occurredAt=before?.dueDate??new Date(); }
      else if(input.entityType==="payment"){ [before]=await db.select().from(payments).where(and(eq(payments.id,input.entityId),eq(payments.siteId,input.siteId),eq(payments.tenantId,tenantId))).limit(1); occurredAt=before?.paidAt??new Date(); }
      else { [before]=await db.select().from(expenses).where(and(eq(expenses.id,input.entityId),eq(expenses.siteId,input.siteId),eq(expenses.tenantId,tenantId))).limit(1); occurredAt=before?.occurredAt??new Date(); }
      if(!before) throw new TRPCError({code:"NOT_FOUND",message:"العملية غير موجودة ضمن الفرع المحدد."});
      const [locked]=await db.select({id:financialSettlements.id}).from(financialSettlements).where(and(eq(financialSettlements.tenantId,tenantId),eq(financialSettlements.siteId,input.siteId),eq(financialSettlements.status,"locked"),lte(financialSettlements.periodStart,occurredAt),gte(financialSettlements.periodEnd,occurredAt))).limit(1);
      if(!locked) throw new TRPCError({code:"BAD_REQUEST",message:"هذه العملية ليست ضمن فترة مقفلة."});
      const allowed:any = input.entityType==="invoice" ? { ...(input.changes.dueDate!==undefined?{dueDate:input.changes.dueDate}:{}), ...(input.changes.description!==undefined?{}:{}) } : input.entityType==="payment" ? { ...(input.changes.referenceNo!==undefined?{referenceNo:input.changes.referenceNo}:{}), ...(input.changes.description!==undefined?{}:{}) } : { ...(input.changes.description!==undefined?{description:input.changes.description}:{}), ...(input.changes.referenceNo!==undefined?{referenceNo:input.changes.referenceNo}:{}), ...(input.changes.category!==undefined?{category:input.changes.category}:{}) };
      if(!Object.keys(allowed).length) throw new TRPCError({code:"BAD_REQUEST",message:"الحقول المسموح تعديلها لهذا النوع غير موجودة."});
      if(input.entityType==="invoice") await db.update(invoices).set(allowed).where(eq(invoices.id,input.entityId)); else if(input.entityType==="payment") await db.update(payments).set(allowed).where(eq(payments.id,input.entityId)); else await db.update(expenses).set(allowed).where(eq(expenses.id,input.entityId));
      const [after]=input.entityType==="invoice"?await db.select().from(invoices).where(eq(invoices.id,input.entityId)).limit(1):input.entityType==="payment"?await db.select().from(payments).where(eq(payments.id,input.entityId)).limit(1):await db.select().from(expenses).where(eq(expenses.id,input.entityId)).limit(1);
      await writeAudit({userId:ctx.user.id,siteId:input.siteId,tenantId,entityType:input.entityType,entityId:String(input.entityId),action:"exceptional_edit_locked",beforeData:before,afterData:after,metadata:{reason:input.reason,reasonCode:input.reason.startsWith("تراجع سريع") ? "Reversal" : "Correction",settlementId:locked.id,allowedChanges:allowed}}); return {success:true, before, after}; }),
    setStatus: protectedProcedure.input(z.object({ siteId:z.number().int().positive(), settlementId:z.number().int().positive(), status:z.enum(["submitted","approved","locked"]) })).mutation(async({ctx,input})=>{ const role=await requireRole(ctx.user.id,input.siteId,["owner","manager","accountant"],"manageExpenses"); void role; const db=await dbOrThrow(); const tenantId=await getSiteTenant(input.siteId); const [row]=await db.select().from(financialSettlements).where(and(eq(financialSettlements.id,input.settlementId),eq(financialSettlements.tenantId,tenantId),eq(financialSettlements.siteId,input.siteId))).limit(1); if(!row) throw new TRPCError({code:"NOT_FOUND",message:"التسوية غير موجودة."}); if(row.status==="locked") throw new TRPCError({code:"BAD_REQUEST",message:"التسوية مقفلة ولا يمكن تعديلها."}); const patch=input.status==="approved"?{status:input.status,approvedByUserId:ctx.user.id}:{status:input.status}; if(input.status==="locked") Object.assign(patch,{status:input.status,lockedAt:new Date(),approvedByUserId:ctx.user.id}); await db.update(financialSettlements).set(patch).where(eq(financialSettlements.id,row.id)); await writeAudit({userId:ctx.user.id,siteId:input.siteId,entityType:"financial_settlement",entityId:String(row.id),action:"status_change",afterData:{status:input.status}}); return {success:true}; }),
  }),
  reports: router({
    range: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(),
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }).refine((input) => input.startDate <= input.endDate, { message: "يجب أن يكون تاريخ البداية قبل تاريخ النهاية." })).query(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "viewer"]);
      const db = await dbOrThrow();
      const { start, endExclusive } = reportDateRange(input.startDate, input.endDate);
      const [invoiceRows, paymentRows, expenseRows] = await Promise.all([
        db.select({ invoice: invoices, subscriber: subscribers }).from(invoices)
          .innerJoin(subscribers, eq(invoices.subscriberId, subscribers.id))
          .where(and(eq(invoices.siteId, input.siteId), gte(invoices.issueDate, start), lt(invoices.issueDate, endExclusive), sql`${invoices.status} <> 'cancelled'`)),
        db.select({ payment: payments, collector: users }).from(payments)
          .leftJoin(users, eq(payments.collectedByUserId, users.id))
          .where(and(eq(payments.siteId, input.siteId), gte(payments.paidAt, start), lt(payments.paidAt, endExclusive))),
        db.select().from(expenses)
          .where(and(eq(expenses.siteId, input.siteId), gte(expenses.occurredAt, start), lt(expenses.occurredAt, endExclusive))),
      ]);
      const invoiced = invoiceRows.reduce((sum, row) => sum + Number(row.invoice.totalAmount), 0);
      const outstanding = invoiceRows.reduce((sum, row) => sum + Number(row.invoice.balanceDue), 0);
      const energyKwh = invoiceRows.reduce((sum, row) => sum + Number(row.invoice.consumptionKwh), 0);
      const completedPayments = paymentRows.filter((row) => row.payment.status === "completed");
      const collected = completedPayments.reduce((sum, row) => sum + Number(row.payment.amount), 0);
      const expenseTotal = expenseRows.reduce((sum, row) => sum + Number(row.amount), 0);
      const collectors = Object.values(completedPayments.reduce<Record<string, { name: string; count: number; amount: number }>>((acc, row) => {
        const key = String(row.payment.collectedByUserId ?? 0);
        const entry = acc[key] ?? { name: row.collector?.name || row.collector?.email || "محصل غير محدد", count: 0, amount: 0 };
        entry.count += 1;
        entry.amount += Number(row.payment.amount);
        acc[key] = entry;
        return acc;
      }, {})).sort((a, b) => b.amount - a.amount);
      const topDebtors = invoiceRows.filter((row) => Number(row.invoice.balanceDue) > 0).sort((a, b) => Number(b.invoice.balanceDue) - Number(a.invoice.balanceDue)).slice(0, 10).map((row) => ({ subscriber: row.subscriber.fullName, subscriberNo: row.subscriber.subscriberNo, invoiceNo: row.invoice.invoiceNo, balanceDue: Number(row.invoice.balanceDue), dueDate: row.invoice.dueDate }));
      const paymentDetails = completedPayments.map((row) => ({ paymentNo: row.payment.paymentNo, amount: Number(row.payment.amount), paymentMethod: row.payment.paymentMethod, paidAt: row.payment.paidAt, transferFromAccount: row.payment.transferFromAccount, transferFromType: row.payment.transferFromType, transferToAccount: row.payment.transferToAccount, transferToType: row.payment.transferToType }));
      return { range: { startDate: input.startDate, endDate: input.endDate }, summary: { invoiced, collected, outstanding, energyKwh, expenseTotal, operatingProfit: collected - expenseTotal }, collectors, topDebtors, paymentDetails };
    }),
    allBranchesRange: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(),
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }).refine((input) => input.startDate <= input.endDate, { message: "يجب أن يكون تاريخ البداية قبل تاريخ النهاية." })).query(async ({ ctx, input }) => {
      await requireAllBranchRole(ctx.user.id, input.siteId, ["manager", "accountant", "viewer"]);
      const db = await dbOrThrow();
      const tenantId = await getSiteTenant(input.siteId);
      const { start, endExclusive } = reportDateRange(input.startDate, input.endDate);
      const branchRows = await db.select({ id: sites.id, name: sites.name }).from(sites).where(and(eq(sites.tenantId, tenantId), ne(sites.status, "archived"))).orderBy(desc(sites.createdAt));
      const branchIds = branchRows.map((branch) => branch.id);
      if (!branchIds.length) return { range: { startDate: input.startDate, endDate: input.endDate }, scope: { branchCount: 0 }, summary: { invoiced: 0, collected: 0, outstanding: 0, energyKwh: 0, expenseTotal: 0, operatingProfit: 0 }, collectors: [], topDebtors: [], branchSummaries: [] };
      const [invoiceRows, paymentRows, expenseRows] = await Promise.all([
        db.select({ invoice: invoices, subscriber: subscribers }).from(invoices).innerJoin(subscribers, eq(invoices.subscriberId, subscribers.id))
          .where(and(inArray(invoices.siteId, branchIds), gte(invoices.issueDate, start), lt(invoices.issueDate, endExclusive), sql`${invoices.status} <> 'cancelled'`)),
        db.select({ payment: payments, collector: users }).from(payments).leftJoin(users, eq(payments.collectedByUserId, users.id))
          .where(and(inArray(payments.siteId, branchIds), gte(payments.paidAt, start), lt(payments.paidAt, endExclusive))),
        db.select().from(expenses).where(and(inArray(expenses.siteId, branchIds), gte(expenses.occurredAt, start), lt(expenses.occurredAt, endExclusive))),
      ]);
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
        const entry = acc[key] ?? { name: row.collector?.name || row.collector?.email || "محصل غير محدد", count: 0, amount: 0 };
        entry.count += 1;
        entry.amount += Number(row.payment.amount);
        return acc;
      }, {})).sort((a, b) => b.amount - a.amount);
      const topDebtors = invoiceRows.filter((row) => Number(row.invoice.balanceDue) > 0).sort((a, b) => Number(b.invoice.balanceDue) - Number(a.invoice.balanceDue)).slice(0, 10).map((row) => ({ branchName: branchNameById.get(row.invoice.siteId) ?? "فرع غير محدد", subscriber: row.subscriber.fullName, subscriberNo: row.subscriber.subscriberNo, invoiceNo: row.invoice.invoiceNo, balanceDue: Number(row.invoice.balanceDue), dueDate: row.invoice.dueDate }));
      const paymentDetails = completedPayments.map((row) => ({ siteId: row.payment.siteId, paymentNo: row.payment.paymentNo, amount: Number(row.payment.amount), paymentMethod: row.payment.paymentMethod, paidAt: row.payment.paidAt, transferFromAccount: row.payment.transferFromAccount, transferFromType: row.payment.transferFromType, transferToAccount: row.payment.transferToAccount, transferToType: row.payment.transferToType }));
      return { range: { startDate: input.startDate, endDate: input.endDate }, scope: { branchCount: branchIds.length }, summary, collectors, topDebtors, branchSummaries, paymentDetails };
    }),
    monthly: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), billingPeriod: z.string().regex(/^\d{4}-\d{2}$/) })).query(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "viewer"]);
      const db = await dbOrThrow();
      const invoiceRows = await db.select({ invoice: invoices, subscriber: subscribers }).from(invoices)
        .innerJoin(subscribers, eq(invoices.subscriberId, subscribers.id))
        .where(and(eq(invoices.siteId, input.siteId), eq(invoices.billingPeriod, input.billingPeriod), sql`${invoices.status} <> 'cancelled'`));
      const paymentRows = await db.select({ payment: payments, collector: users }).from(payments)
        .leftJoin(users, eq(payments.collectedByUserId, users.id))
        .where(eq(payments.siteId, input.siteId));
      const expenseRows = await db.select().from(expenses).where(eq(expenses.siteId, input.siteId));
      const matchPeriod = (date: Date | null) => date ? date.toISOString().slice(0, 7) === input.billingPeriod : false;
      const periodPayments = paymentRows.filter((row) => matchPeriod(row.payment.paidAt));
      const periodExpenses = expenseRows.filter((row) => matchPeriod(row.occurredAt));
      const invoiced = invoiceRows.reduce((sum, row) => sum + Number(row.invoice.totalAmount), 0);
      const outstanding = invoiceRows.reduce((sum, row) => sum + Number(row.invoice.balanceDue), 0);
      const energyKwh = invoiceRows.reduce((sum, row) => sum + Number(row.invoice.consumptionKwh), 0);
      const collected = periodPayments.filter((row) => row.payment.status === "completed").reduce((sum, row) => sum + Number(row.payment.amount), 0);
      const expenseTotal = periodExpenses.reduce((sum, row) => sum + Number(row.amount), 0);
      const collectors = Object.values(periodPayments.reduce<Record<string, { name: string; count: number; amount: number }>>((acc, row) => {
        const key = String(row.payment.collectedByUserId ?? 0);
        const entry = acc[key] ?? { name: row.collector?.name || row.collector?.email || "محصل غير محدد", count: 0, amount: 0 };
        entry.count += 1;
        entry.amount += Number(row.payment.amount);
        acc[key] = entry;
        return acc;
      }, {})).sort((a, b) => b.amount - a.amount);
      const topDebtors = invoiceRows.filter((row) => Number(row.invoice.balanceDue) > 0).sort((a, b) => Number(b.invoice.balanceDue) - Number(a.invoice.balanceDue)).slice(0, 10).map((row) => ({ subscriber: row.subscriber.fullName, subscriberNo: row.subscriber.subscriberNo, invoiceNo: row.invoice.invoiceNo, balanceDue: Number(row.invoice.balanceDue), dueDate: row.invoice.dueDate }));
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
      return { companyName: profile?.companyName ?? null, reportLogoKey: profile?.reportLogoKey ?? null, logoUrl: profile?.reportLogoKey ? `/manus-storage/${profile.reportLogoKey}` : null };
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
      return { companyName: profile?.companyName ?? null, reportLogoKey: profile?.reportLogoKey ?? null, logoUrl: profile?.reportLogoKey ? `/manus-storage/${profile.reportLogoKey}` : null };
    }),
  }),

  notifications: router({
    list: protectedProcedure.input(siteScoped.extend({ eventType: z.enum(["invoice_issued", "payment_reminder", "payment_received", "service_alert", "subscriber_reference"]).optional() })).query(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "viewer"]);
      const db = await dbOrThrow();
      return db.select({ notification: notificationMessages, subscriber: subscribers, invoiceNo: invoices.invoiceNo }).from(notificationMessages)
        .innerJoin(subscribers, eq(notificationMessages.subscriberId, subscribers.id))
        .leftJoin(invoices, eq(notificationMessages.invoiceId, invoices.id))
        .where(input.eventType ? and(eq(subscribers.siteId, input.siteId), eq(notificationMessages.eventType, input.eventType)) : eq(subscribers.siteId, input.siteId)).orderBy(desc(notificationMessages.createdAt));
    }),
    listBulkInvoiceSends: protectedProcedure.input(bulkInvoiceSendLogInput).query(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "manageMessaging");
      const db = await dbOrThrow();
      const tenantId = await getSiteTenant(input.siteId);
      const start = input.from ? new Date(`${input.from}T00:00:00.000Z`) : undefined;
      const endExclusive = input.to ? new Date(`${input.to}T00:00:00.000Z`) : undefined;
      if (endExclusive) endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);
      const conditions = [
        eq(auditLogs.tenantId, tenantId),
        eq(auditLogs.siteId, input.siteId),
        eq(auditLogs.entityType, "notification_batch"),
        inArray(auditLogs.action, [...bulkInvoiceSendAuditActions]),
      ];
      if (start) conditions.push(gte(auditLogs.createdAt, start));
      if (endExclusive) conditions.push(lt(auditLogs.createdAt, endExclusive));
      return db.select({
        id: auditLogs.id,
        action: auditLogs.action,
        createdAt: auditLogs.createdAt,
        metadata: auditLogs.metadata,
        executorId: auditLogs.userId,
        executorName: users.name,
        executorEmail: users.email,
      }).from(auditLogs)
        .leftJoin(users, eq(auditLogs.userId, users.id))
        .where(and(...conditions))
        .orderBy(desc(auditLogs.createdAt))
        .limit(20);
    }),
    bulkInvoiceSendDetails: protectedProcedure.input(bulkInvoiceSendDetailsInput).query(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "manageMessaging");
      const db = await dbOrThrow();
      const tenantId = await getSiteTenant(input.siteId);
      const [operation] = await db.select({ id: auditLogs.id, action: auditLogs.action, entityId: auditLogs.entityId, metadata: auditLogs.metadata, createdAt: auditLogs.createdAt })
        .from(auditLogs)
        .where(and(eq(auditLogs.id, input.auditLogId), eq(auditLogs.tenantId, tenantId), eq(auditLogs.siteId, input.siteId), eq(auditLogs.entityType, "notification_batch"), inArray(auditLogs.action, [...bulkInvoiceSendAuditActions])))
        .limit(1);
      if (!operation) throw new TRPCError({ code: "NOT_FOUND", message: "عملية الإرسال الجماعي لا تتبع للفرع المحدد." });
      const metadata = operation.metadata && typeof operation.metadata === "object" && !Array.isArray(operation.metadata) ? operation.metadata as Record<string, unknown> : {};
      const notificationIds = Array.isArray(metadata.notificationIds) ? metadata.notificationIds.filter((value): value is number => typeof value === "number" && Number.isInteger(value) && value > 0) : operation.action === "send_deferred_invoice_notifications" ? operation.entityId.split(",").map(Number).filter((value) => Number.isInteger(value) && value > 0) : [];
      const invoiceIds = notificationIds.length ? [] : operation.entityId.split(",").map(Number).filter((value) => Number.isInteger(value) && value > 0);
      if (!notificationIds.length && !invoiceIds.length) return { operation, items: [] as Array<never> };
      const scope = notificationIds.length ? inArray(notificationMessages.id, notificationIds) : inArray(notificationMessages.invoiceId, invoiceIds);
      const rows = await db.select({
        notificationId: notificationMessages.id,
        status: notificationMessages.status,
        channel: notificationMessages.channel,
        lastError: notificationMessages.lastError,
        recipient: notificationMessages.recipient,
        invoiceId: invoices.id,
        invoiceNo: invoices.invoiceNo,
        totalAmount: invoices.totalAmount,
        subscriberName: subscribers.fullName,
      }).from(notificationMessages)
        .innerJoin(invoices, eq(notificationMessages.invoiceId, invoices.id))
        .innerJoin(subscribers, eq(notificationMessages.subscriberId, subscribers.id))
        .where(and(eq(notificationMessages.tenantId, tenantId), eq(invoices.siteId, input.siteId), scope))
        .orderBy(invoices.invoiceNo, notificationMessages.id);
      return { operation, items: rows };
    }),
    retry: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), notificationId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
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
      catch (error) { dispatch = { status: "failed", error: error instanceof Error ? error.message : "تعذر إعادة إرسال إشعار الفاتورة." }; }
      await writeAudit({ userId: ctx.user.id, siteId: input.siteId, entityType: "notification_message", entityId: String(input.notificationId), action: "retry_failed_invoice_notification", metadata: { invoiceId: scope.invoiceId, invoiceNo: scope.invoiceNo, dispatchStatus: dispatch.status, error: dispatch.error ?? null, source: "bulk_invoice_send_details" } });
      return { notificationId: input.notificationId, status: dispatch.status, error: dispatch.error ?? null };
    }),
    retryFailedInvoiceNotifications: protectedProcedure.input(retryFailedInvoiceNotificationsInput).mutation(async ({ ctx, input }) => {
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
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "manageMessaging");
      const db = await dbOrThrow();
      const selectedIds = input.invoiceIds ? Array.from(new Set(input.invoiceIds)) : undefined;
      const rows = selectedIds
        ? await queueInvoiceNotificationsForSelection(db, { siteId: input.siteId, invoiceIds: selectedIds })
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
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "manageMessaging");
      const db = await dbOrThrow();
      const [scope] = await db.select({ invoice: invoices, subscriber: subscribers, site: sites }).from(invoices)
        .innerJoin(subscribers, eq(invoices.subscriberId, subscribers.id))
        .innerJoin(sites, eq(invoices.siteId, sites.id))
        .where(and(eq(invoices.id, input.invoiceId), eq(invoices.siteId, input.siteId))).limit(1);
      if (!scope || !scope.subscriber.phone) throw new TRPCError({ code: "NOT_FOUND", message: "الفاتورة أو بيانات المشترك لا تتبع للفرع المحدد." });
      if (["paid", "cancelled", "draft"].includes(scope.invoice.status) || Number(scope.invoice.balanceDue) <= 0) throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن إرسال تذكير لفاتورة مسددة أو لا تحمل رصيداً مستحقاً." });
      let recipient: string;
      try { recipient = normalizeInternationalPhone(scope.subscriber.phone); } catch (error) { throw new TRPCError({ code: "PRECONDITION_FAILED", message: error instanceof Error ? `عدّل رقم هاتف المشترك قبل الإرسال. ${error.message}` : "عدّل رقم هاتف المشترك إلى صيغة دولية قبل الإرسال." }); }
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
      } catch (error) {
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
      const role = await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "manageExpenses");
      void role;
      const db = await dbOrThrow(); const tenantId = await getSiteTenant(input.siteId);
      let accounts = await db.select().from(companyAccounts).where(and(eq(companyAccounts.tenantId, tenantId), eq(companyAccounts.isActive, true))).orderBy(companyAccounts.id);
      if (!accounts.length) {
        const defaults = [["كاش", "cash", "#64748b"], ["جوال بي", "jawwal_pay", "#16a34a"], ["بال بي", "palpay", "#9333ea"], ["بنك فلسطين", "bank_of_palestine", "#0891b2"]] as const;
        for (const [name, accountType, color] of defaults) await db.insert(companyAccounts).values({ tenantId, name, accountType, color });
        accounts = await db.select().from(companyAccounts).where(and(eq(companyAccounts.tenantId, tenantId), eq(companyAccounts.isActive, true))).orderBy(companyAccounts.id);
      }
      const accountSiteRows = await db.select({ accountId: companyAccountSites.accountId, siteId: companyAccountSites.siteId, siteName: sites.name }).from(companyAccountSites).innerJoin(sites, eq(companyAccountSites.siteId, sites.id)).where(eq(companyAccountSites.tenantId, tenantId));
      const visibleAccountIds = input.branchId ? new Set(accountSiteRows.filter((row) => row.siteId === input.branchId).map((row) => row.accountId)) : null;
      const from = input.fromDate ? new Date(input.fromDate) : null; const to = input.toDate ? new Date(input.toDate) : null;
      if (from && Number.isNaN(from.getTime())) throw new TRPCError({ code: "BAD_REQUEST", message: "تاريخ البداية غير صحيح." });
      if (to && Number.isNaN(to.getTime())) throw new TRPCError({ code: "BAD_REQUEST", message: "تاريخ النهاية غير صحيح." });
      if (from && to && from > to) throw new TRPCError({ code: "BAD_REQUEST", message: "تاريخ البداية يجب أن يسبق تاريخ النهاية." });
      const rows = await db.select().from(accountTransactions).where(and(eq(accountTransactions.tenantId, tenantId), ...(from ? [gte(accountTransactions.occurredAt, from)] : []), ...(to ? [lte(accountTransactions.occurredAt, to)] : []))).orderBy(desc(accountTransactions.occurredAt)).limit(1000);
      return accounts.filter((account) => !visibleAccountIds || visibleAccountIds.has(account.id)).map((account) => ({ ...account, linkedSites: accountSiteRows.filter((row) => row.accountId === account.id), balance: rows.filter((row) => row.accountId === account.id).reduce((sum, row) => sum + (row.transactionType === "withdrawal" || row.transactionType === "transfer_out" ? -Number(row.amount) : Number(row.amount)), 0), transactions: rows.filter((row) => row.accountId === account.id) }));
    }),
    create: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), name: z.string().trim().min(2).max(120), accountType: z.enum(["cash", "jawwal_pay", "palpay", "bank_of_palestine", "other"]), phoneNumber: z.string().trim().regex(/^\+?[0-9]{7,20}$/, "أدخل رقم جوال صحيحاً."), color: z.string().trim().max(20).optional(), siteIds: z.array(z.number().int().positive()).min(1) })).mutation(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager"], "manageExpenses"); const db = await dbOrThrow(); const tenantId = await getSiteTenant(input.siteId);
      const validSites = await db.select({ id: sites.id }).from(sites).where(and(eq(sites.tenantId, tenantId), inArray(sites.id, input.siteIds))); if (validSites.length !== input.siteIds.length) throw new TRPCError({ code: "FORBIDDEN", message: "أحد الفروع المحددة لا يتبع مساحة الشركة." });
      const id = insertId(await db.insert(companyAccounts).values({ tenantId, name: input.name, accountType: input.accountType, phoneNumber: input.phoneNumber, color: input.color ?? "#64748b" }));
      await db.insert(companyAccountSites).values(input.siteIds.map((siteId) => ({ tenantId, accountId: id, siteId })));
      await writeAudit({ userId: ctx.user.id, siteId: input.siteId, entityType: "company_account", entityId: String(id), action: "create", afterData: input }); return { id };
    }),
    updatePhone: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), accountId: z.number().int().positive(), phoneNumber: z.string().trim().regex(/^\\+?[0-9]{7,20}$/, "أدخل رقم جوال صحيحاً بصيغة دولية أو محلية.") })).mutation(async ({ ctx, input }) => { await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "manageExpenses"); const db = await dbOrThrow(); const tenantId = await getSiteTenant(input.siteId); const [account] = await db.select({ id: companyAccounts.id }).from(companyAccounts).where(and(eq(companyAccounts.id, input.accountId), eq(companyAccounts.tenantId, tenantId))).limit(1); if (!account) throw new TRPCError({ code: "NOT_FOUND", message: "الحساب غير موجود ضمن مساحة الشركة." }); await db.update(companyAccounts).set({ phoneNumber: input.phoneNumber }).where(eq(companyAccounts.id, input.accountId)); await writeAudit({ userId: ctx.user.id, siteId: input.siteId, entityType: "company_account", entityId: String(input.accountId), action: "update_phone", afterData: { phoneNumber: input.phoneNumber } }); return { success: true }; }),
    updateOpeningBalance: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), accountId: z.number().int().positive(), openingBalance: z.number().nonnegative() })).mutation(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager"], "manageExpenses"); const db = await dbOrThrow(); const tenantId = await getSiteTenant(input.siteId);
      const [account] = await db.select({ id: companyAccounts.id }).from(companyAccounts).where(and(eq(companyAccounts.id, input.accountId), eq(companyAccounts.tenantId, tenantId))).limit(1);
      if (!account) throw new TRPCError({ code: "NOT_FOUND", message: "الحساب غير موجود ضمن مساحة الشركة." });
      await db.update(companyAccounts).set({ openingBalance: String(input.openingBalance) }).where(and(eq(companyAccounts.id, input.accountId), eq(companyAccounts.tenantId, tenantId)));
      await writeAudit({ userId: ctx.user.id, siteId: input.siteId, entityType: "company_account", entityId: String(input.accountId), action: "update_opening_balance", afterData: { openingBalance: input.openingBalance } }); return { success: true };
    }),
    updateSites: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), accountId: z.number().int().positive(), siteIds: z.array(z.number().int().positive()).min(1) })).mutation(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager"], "manageExpenses"); const db = await dbOrThrow(); const tenantId = await getSiteTenant(input.siteId);
      const [account] = await db.select({ id: companyAccounts.id }).from(companyAccounts).where(and(eq(companyAccounts.id, input.accountId), eq(companyAccounts.tenantId, tenantId))).limit(1);
      if (!account) throw new TRPCError({ code: "NOT_FOUND", message: "الحساب غير موجود ضمن مساحة الشركة." });
      const validSites = await db.select({ id: sites.id }).from(sites).where(and(eq(sites.tenantId, tenantId), inArray(sites.id, input.siteIds)));
      if (validSites.length !== input.siteIds.length) throw new TRPCError({ code: "FORBIDDEN", message: "أحد الفروع المحددة لا يتبع مساحة الشركة." });
      await db.delete(companyAccountSites).where(and(eq(companyAccountSites.accountId, input.accountId), eq(companyAccountSites.tenantId, tenantId)));
      await db.insert(companyAccountSites).values(input.siteIds.map((siteId) => ({ tenantId, accountId: input.accountId, siteId })));
      await writeAudit({ userId: ctx.user.id, siteId: input.siteId, entityType: "company_account", entityId: String(input.accountId), action: "update_sites", afterData: { siteIds: input.siteIds } }); return { success: true };
    }),
    addMovement: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), accountId: z.number().int().positive(), transactionType: z.enum(["deposit", "withdrawal"]), amount: z.number().positive(), description: z.string().trim().min(2).max(255), referenceNo: z.string().trim().max(120).optional() })).mutation(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "manageExpenses"); const db = await dbOrThrow(); const tenantId = await getSiteTenant(input.siteId);
      const [account] = await db.select({ id: companyAccounts.id }).from(companyAccounts).where(and(eq(companyAccounts.id, input.accountId), eq(companyAccounts.tenantId, tenantId))).limit(1); if (!account) throw new TRPCError({ code: "NOT_FOUND", message: "الحساب غير موجود ضمن مساحة الشركة." });
      const id = insertId(await db.insert(accountTransactions).values({ tenantId, accountId: input.accountId, transactionType: input.transactionType, amount: String(input.amount), description: input.description, referenceNo: input.referenceNo, createdByUserId: ctx.user.id }));
      await writeAudit({ userId: ctx.user.id, siteId: input.siteId, entityType: "company_account", entityId: String(input.accountId), action: input.transactionType, afterData: input }); return { id };
    }),
    transfer: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), fromAccountId: z.number().int().positive(), toAccountId: z.number().int().positive(), amount: z.number().positive(), description: z.string().trim().min(2).max(255) })).mutation(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "manageExpenses"); if (input.fromAccountId === input.toAccountId) throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن التحويل إلى الحساب نفسه." }); const db = await dbOrThrow(); const tenantId = await getSiteTenant(input.siteId);
      const accounts = await db.select({ id: companyAccounts.id }).from(companyAccounts).where(and(eq(companyAccounts.tenantId, tenantId), inArray(companyAccounts.id, [input.fromAccountId, input.toAccountId]))); if (accounts.length !== 2) throw new TRPCError({ code: "NOT_FOUND", message: "حساب التحويل غير موجود ضمن مساحة الشركة." });
      await db.insert(accountTransactions).values([{ tenantId, accountId: input.fromAccountId, relatedAccountId: input.toAccountId, transactionType: "transfer_out", amount: String(input.amount), description: input.description, createdByUserId: ctx.user.id }, { tenantId, accountId: input.toAccountId, relatedAccountId: input.fromAccountId, transactionType: "transfer_in", amount: String(input.amount), description: input.description, createdByUserId: ctx.user.id }]); await writeAudit({ userId: ctx.user.id, siteId: input.siteId, entityType: "company_account", entityId: String(input.fromAccountId), action: "transfer", afterData: input }); return { success: true };
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
