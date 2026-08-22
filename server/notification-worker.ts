import { and, asc, eq, gte, sql } from "drizzle-orm";
import { auditLogs, notificationMessages, platformSettings, platformSmsPlans, smsPackageRequests, subscribers, tenantMessagingConfigurations, tenantSubscriptions } from "../drizzle/schema";
import { getDb } from "./db";
import { decryptTenantCredential } from "./tenant-crypto";
import { invoiceDeliveryPolicyFromSetting, isInvoiceDeliveryChannelEnabled } from "./notification-channels";

type WhatsAppCredential = { accessToken: string; appSecret?: string };

function parseWhatsAppCredential(ciphertext: string, iv: string): WhatsAppCredential {
  const decrypted = iv === "unused" ? ciphertext : decryptTenantCredential(ciphertext, iv);
  try {
    const parsed = JSON.parse(decrypted) as Partial<WhatsAppCredential>;
    if (typeof parsed.accessToken === "string" && parsed.accessToken.length > 0) return { accessToken: parsed.accessToken, appSecret: parsed.appSecret };
  } catch { /* Legacy raw tokens remain supported. */ }
  return { accessToken: decrypted };
}

type MessagePayload = { renderedText?: string; invoiceTemplateParameters?: string[]; receiptTemplateParameters?: string[]; subscriberReferenceTemplateParameters?: string[] };
type MessageRow = typeof notificationMessages.$inferSelect;
type DispatchResult = { status: "submitted" | "failed" | "skipped"; providerMessageId?: string | null; error?: string };

function messagePayload(message: MessageRow) { return (message.payload ?? {}) as MessagePayload; }

async function recordSmsQuotaAlert(message: MessageRow, db: NonNullable<Awaited<ReturnType<typeof getDb>>>) {
  if (message.channel !== "sms" || !message.subscriberId) return;
  const [subscriber] = await db.select({ siteId: subscribers.siteId }).from(subscribers).where(eq(subscribers.id, message.subscriberId)).limit(1);
  if (!subscriber) return;
  const [subscription] = await db.select({ included: platformSmsPlans.includedMessages }).from(tenantSubscriptions).leftJoin(platformSmsPlans, eq(tenantSubscriptions.smsPlanId, platformSmsPlans.id)).where(eq(tenantSubscriptions.tenantId, message.tenantId)).limit(1);
  const [extra] = await db.select({ approved: sql<number>`coalesce(sum(${smsPackageRequests.approvedMessages}), 0)` }).from(smsPackageRequests).where(and(eq(smsPackageRequests.tenantId, message.tenantId), eq(smsPackageRequests.status, "approved")));
  const [usage] = await db.select({ used: sql<number>`count(*)` }).from(notificationMessages).where(and(eq(notificationMessages.tenantId, message.tenantId), eq(notificationMessages.channel, "sms"), sql`${notificationMessages.status} in ('submitted','delivered','read')`));
  const total = Number(subscription?.included ?? 0) + Number(extra?.approved ?? 0); const used = Number(usage?.used ?? 0); if (!total) return;
  const threshold = used >= total ? 100 : used / total >= 0.8 ? 80 : 0; if (!threshold) return;
  const start = new Date(); start.setDate(1); start.setHours(0, 0, 0, 0); const action = `sms_quota_alert_${threshold}`;
  const [existing] = await db.select({ id: auditLogs.id }).from(auditLogs).where(and(eq(auditLogs.tenantId, message.tenantId), eq(auditLogs.action, action), gte(auditLogs.createdAt, start))).limit(1);
  if (!existing) await db.insert(auditLogs).values({ tenantId: message.tenantId, siteId: subscriber.siteId, entityType: "sms_quota", entityId: String(message.tenantId), action, metadata: { threshold, used, total, remaining: Math.max(0, total - used), automatic: true } });
}

async function dispatchNotification(message: MessageRow): Promise<DispatchResult> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable while processing notifications.");
  if (["invoice_issued", "payment_reminder", "payment_received", "subscriber_reference"].includes(message.eventType)) {
    const [setting] = await db.select({ isEnabled: platformSettings.isEnabled, value: platformSettings.value }).from(platformSettings)
      .where(eq(platformSettings.settingKey, "invoice_delivery_channels")).limit(1);
    if (!isInvoiceDeliveryChannelEnabled(message.channel, invoiceDeliveryPolicyFromSetting(setting))) {
      const error = "قناة إرسال الإيصالات والفواتير معطلة من إعدادات آدمن PowerHub.";
      await db.update(notificationMessages).set({ status: "failed", lastError: error }).where(eq(notificationMessages.id, message.id));
      return { status: "skipped", error };
    }
  }
  const claimed = await db.update(notificationMessages).set({ status: "submitted", attempts: sql`${notificationMessages.attempts} + 1` })
    .where(and(eq(notificationMessages.id, message.id), eq(notificationMessages.status, "pending")));
  if (Number((claimed[0] as { affectedRows?: number }).affectedRows ?? 0) !== 1) return { status: "skipped", error: "الرسالة لم تعد في انتظار الإرسال." };
  try {
    const [configuration] = await db.select().from(tenantMessagingConfigurations).where(and(
      eq(tenantMessagingConfigurations.tenantId, message.tenantId), eq(tenantMessagingConfigurations.channel, message.channel), eq(tenantMessagingConfigurations.isActive, true),
    )).limit(1);
    if (!configuration?.credentialCiphertext || !configuration.credentialIv) throw new Error(`لا توجد قناة ${message.channel} مفعلة لهذا المستأجر.`);
    const payload = messagePayload(message);
    let providerMessageId: string | undefined;
    if (message.channel === "whatsapp") {
      if (configuration.provider !== "meta_whatsapp_cloud" || !configuration.phoneNumberId) throw new Error("إرسال WhatsApp يتطلب مزود Meta وPhone Number ID فعالين.");
      const credential = parseWhatsAppCredential(configuration.credentialCiphertext, configuration.credentialIv);
      const isReceipt = message.eventType === "payment_received";
      const isSubscriberReference = message.eventType === "subscriber_reference";
      const templateName = isReceipt ? configuration.receiptTemplateName : isSubscriberReference ? configuration.subscriberReferenceTemplateName : configuration.templateName;
      if (!templateName) throw new Error(isReceipt ? "أدخل اسم قالب إيصال الدفع المعتمد من Meta أولاً." : isSubscriberReference ? "أدخل اسم قالب رسالة الرقم المرجعي المعتمد من Meta أولاً." : "أدخل اسم قالب فاتورة Meta المعتمد أولاً.");
      const parameters = isReceipt ? payload.receiptTemplateParameters : isSubscriberReference ? payload.subscriberReferenceTemplateParameters : payload.invoiceTemplateParameters;
      const components = parameters ? [{ type: "body", parameters: parameters.map((text) => ({ type: "text", text })) }] : undefined;
      const response = await fetch(`https://graph.facebook.com/v22.0/${encodeURIComponent(configuration.phoneNumberId)}/messages`, {
        method: "POST", headers: { Authorization: `Bearer ${credential.accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", to: message.recipient, type: "template", template: { name: templateName, language: { code: "ar" }, ...(components ? { components } : {}) } }),
      });
      const body = await response.json().catch(() => ({})) as { messages?: Array<{ id?: string }>; error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message || `رفض مزود WhatsApp الطلب (${response.status}).`);
      providerMessageId = body.messages?.[0]?.id;
    } else if (message.channel === "sms") {
      if (configuration.provider !== "jawwal_bulk_sms" || !configuration.phoneNumberId || !configuration.senderId) throw new Error("إعداد SMS لشركة جوال غير مكتمل؛ أدخل Client ID واسم المرسل وبيانات API الرسمية.");
      if (!payload.renderedText) throw new Error("نص الفاتورة غير متوفر للإرسال عبر SMS.");
      throw new Error("إرسال SMS لشركة جوال ينتظر تفعيل API الرسمي وتزويد بيانات العقد.");

    } else throw new Error("قناة الإرسال غير مدعومة.");
    await db.update(notificationMessages).set({ status: "submitted", providerMessageId: providerMessageId || null, lastError: null }).where(eq(notificationMessages.id, message.id));
    await recordSmsQuotaAlert(message, db);
    return { status: "submitted", providerMessageId };
  } catch (error) {
    const messageText = error instanceof Error ? error.message.slice(0, 2000) : "فشل غير معروف";
    await db.update(notificationMessages).set({ status: "failed", lastError: messageText }).where(eq(notificationMessages.id, message.id));
    return { status: "failed", error: messageText };
  }
}

export async function processNotificationById(notificationId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable while processing notifications.");
  const [message] = await db.select().from(notificationMessages).where(eq(notificationMessages.id, notificationId)).limit(1);
  if (!message) return { status: "skipped" as const, error: "رسالة الإشعار غير موجودة." };
  return dispatchNotification(message);
}

export async function processNotificationQueueForTenant(tenantId: number, limit = 25) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable while processing notifications.");
  const pending = await db.select().from(notificationMessages).where(and(eq(notificationMessages.tenantId, tenantId), eq(notificationMessages.channel, "sms"), eq(notificationMessages.eventType, "invoice_issued"), eq(notificationMessages.status, "pending"))).orderBy(asc(notificationMessages.createdAt)).limit(Math.min(Math.max(limit, 1), 50));
  const result = { scanned: pending.length, submitted: 0, failed: 0, skipped: 0 };
  for (const message of pending) { const dispatched = await dispatchNotification(message); result[dispatched.status] += 1; }
  return result;
}

export async function processNotificationQueue(limit = 25) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable while processing notifications.");
  const pending = await db.select().from(notificationMessages).where(eq(notificationMessages.status, "pending")).orderBy(asc(notificationMessages.createdAt)).limit(Math.min(Math.max(limit, 1), 50));
  const result = { scanned: pending.length, submitted: 0, failed: 0, skipped: 0 };
  for (const message of pending) {
    const dispatched = await dispatchNotification(message);
    result[dispatched.status] += 1;
  }
  return result;
}

export { parseWhatsAppCredential };
