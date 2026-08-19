import { and, asc, eq, sql } from "drizzle-orm";
import { notificationMessages, tenantMessagingConfigurations } from "../drizzle/schema";
import { getDb } from "./db";
import { decryptTenantCredential } from "./tenant-crypto";

type WhatsAppCredential = { accessToken: string; appSecret?: string };

function parseWhatsAppCredential(ciphertext: string, iv: string): WhatsAppCredential {
  const decrypted = iv === "unused" ? ciphertext : decryptTenantCredential(ciphertext, iv);
  try {
    const parsed = JSON.parse(decrypted) as Partial<WhatsAppCredential>;
    if (typeof parsed.accessToken === "string" && parsed.accessToken.length > 0) return { accessToken: parsed.accessToken, appSecret: parsed.appSecret };
  } catch { /* Legacy raw tokens remain supported. */ }
  return { accessToken: decrypted };
}

export async function processNotificationQueue(limit = 25) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable while processing notifications.");
  const pending = await db.select().from(notificationMessages)
    .where(eq(notificationMessages.status, "pending")).orderBy(asc(notificationMessages.createdAt)).limit(Math.min(Math.max(limit, 1), 50));
  const result = { scanned: pending.length, submitted: 0, failed: 0, skipped: 0 };

  for (const message of pending) {
    const claimed = await db.update(notificationMessages).set({ status: "submitted", attempts: sql`${notificationMessages.attempts} + 1` })
      .where(and(eq(notificationMessages.id, message.id), eq(notificationMessages.status, "pending")));
    if (Number((claimed[0] as { affectedRows?: number }).affectedRows ?? 0) !== 1) { result.skipped += 1; continue; }
    try {
      const [configuration] = await db.select().from(tenantMessagingConfigurations).where(and(
        eq(tenantMessagingConfigurations.tenantId, message.tenantId), eq(tenantMessagingConfigurations.channel, message.channel), eq(tenantMessagingConfigurations.isActive, true),
      )).limit(1);
      if (!configuration?.credentialCiphertext || !configuration.credentialIv) throw new Error(`لا توجد قناة ${message.channel} مفعلة لهذا المستأجر.`);
      if (message.channel !== "whatsapp" || configuration.provider !== "meta_whatsapp_cloud" || !configuration.phoneNumberId) throw new Error("قناة الإرسال أو مزودها غير مدعومين في عامل الإرسال الحالي.");
      const credential = parseWhatsAppCredential(configuration.credentialCiphertext, configuration.credentialIv);
      const response = await fetch(`https://graph.facebook.com/v22.0/${encodeURIComponent(configuration.phoneNumberId)}/messages`, {
        method: "POST", headers: { Authorization: `Bearer ${credential.accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", to: message.recipient, type: "template", template: { name: configuration.templateName || "invoice_ready_ar", language: { code: "ar" } } }),
      });
      const body = await response.json().catch(() => ({})) as { messages?: Array<{ id?: string }>; error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message || `رفض مزود WhatsApp الطلب (${response.status}).`);
      await db.update(notificationMessages).set({ status: "submitted", providerMessageId: body.messages?.[0]?.id || null, lastError: null }).where(eq(notificationMessages.id, message.id));
      result.submitted += 1;
    } catch (error) {
      await db.update(notificationMessages).set({ status: "failed", lastError: error instanceof Error ? error.message.slice(0, 2000) : "فشل غير معروف" }).where(eq(notificationMessages.id, message.id));
      result.failed += 1;
    }
  }
  return result;
}

export { parseWhatsAppCredential };
