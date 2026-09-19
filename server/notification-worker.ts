import { TRPCError } from "@trpc/server";
import { decryptTenantCredential } from "./tenant-crypto";
import { supabaseAdmin } from "./supabase-admin";
import { sendTweetSms, type TweetSmsCredentials } from "./tweetsms-client";
import { normalizeInternationalPhone } from "../shared/phone";

type DispatchResult = { status: "submitted" | "failed" | "needs_review" | "skipped"; providerMessageId?: string | null; error?: string };
type SmsClaim = {
  notification_id: number;
  tenant_id: number;
  recipient: string;
  rendered_text: string;
  api_endpoint: string;
  credential_ciphertext: string;
  credential_iv: string;
  sender_name: string;
  attempt_number: number;
  character_count: number;
  segment_count: number;
};

export function tweetSmsProviderStatus(ok: boolean): "submitted" | "failed" {
  return ok ? "submitted" : "failed";
}

/** توافق قراءة بيانات القناة الموروثة فقط؛ لا تستعملها أي عملية إرسال في هذا الإصدار. */
export function parseWhatsAppCredential(raw: string, _iv: string): { accessToken: string; appSecret?: string } {
  try {
    const parsed = JSON.parse(raw) as { accessToken?: unknown; appSecret?: unknown };
    if (typeof parsed.accessToken === "string" && parsed.accessToken.trim()) {
      return { accessToken: parsed.accessToken, ...(typeof parsed.appSecret === "string" && parsed.appSecret.trim() ? { appSecret: parsed.appSecret } : {}) };
    }
  } catch { /* A legacy raw token remains supported for non-sending compatibility checks. */ }
  return { accessToken: raw };
}

function decryptTweetSmsCredentials(ciphertext: string, iv: string): TweetSmsCredentials {
  const raw = decryptTenantCredential(ciphertext, iv);
  try {
    const credentials = JSON.parse(raw) as Partial<TweetSmsCredentials>;
    if (typeof credentials.apiKey === "string" && credentials.apiKey.trim()) {
      return { apiKey: credentials.apiKey, ...(typeof credentials.apiSecret === "string" && credentials.apiSecret.trim() ? { apiSecret: credentials.apiSecret } : {}) };
    }
  } catch { /* Credentials are deliberately not surfaced in errors or logs. */ }
  throw new TRPCError({ code: "PRECONDITION_FAILED", message: "بيانات TweetSMS المشفرة غير صالحة؛ احفظ مفتاح المولد من جديد." });
}

function rpcErrorMessage(error: { message?: string } | null, fallback: string) {
  const code = error?.message ?? "";
  if (code.includes("SMS_QUOTA_EXCEEDED")) return "لا يكفي رصيد الرسائل لهذا المولد بعد احتساب أجزاء الرسالة.";
  if (code.includes("TWEETSMS_ACCOUNT_NOT_ACTIVE")) return "حساب TweetSMS لهذا المولد غير مفعل أو لم يجتز فحص الجاهزية.";
  if (code.includes("MESSAGING_PERMISSION_REQUIRED")) return "لا تملك صلاحية إدارة الرسائل ضمن هذا الفرع.";
  if (code.includes("NOTIFICATION_NOT_READY")) return "هذه الرسالة قيد المعالجة أو أُرسلت سابقاً.";
  if (code.includes("SMS_RENDERED_TEXT_REQUIRED")) return "نص SMS غير جاهز للإرسال.";
  return fallback;
}

/**
 * Performs only an explicitly requested send. It is never a background worker:
 * the caller must provide the authenticated actor responsible for the audit row.
 */
export async function processNotificationById(notificationId: number, actorUserId?: number): Promise<DispatchResult> {
  if (!Number.isInteger(actorUserId) || !actorUserId || actorUserId < 1) {
    return { status: "skipped", error: "يلزم منفذ مصادق عليه لمعالجة رسالة SMS." };
  }
  const admin = supabaseAdmin();
  const { data: rawClaim, error: claimError } = await admin.rpc("powerhub_claim_sms_notification", {
    p_user_id: actorUserId, p_notification_id: notificationId,
  });
  const claim = (rawClaim as SmsClaim[] | null)?.[0];
  if (claimError || !claim) return { status: "skipped", error: rpcErrorMessage(claimError, "تعذر حجز رسالة SMS للإرسال.") };

  let sent = false;
  let providerMessageId: string | null = null;
  let sendError: string | null = null;
  try {
    const credentials = decryptTweetSmsCredentials(claim.credential_ciphertext, claim.credential_iv);
    const providerResult = await sendTweetSms({
      endpoint: claim.api_endpoint,
      credentials,
      sender: claim.sender_name,
      message: claim.rendered_text,
      recipient: normalizeInternationalPhone(claim.recipient),
    });
    if (!providerResult.ok) {
      sendError = providerResult.message;
      if (providerResult.deliveryUncertain) {
        const { data: uncertainFinish, error: uncertainFinishError } = await admin.rpc("powerhub_finish_sms_notification", {
          p_user_id: actorUserId,
          p_notification_id: claim.notification_id,
          p_attempt_number: claim.attempt_number,
          p_success: false,
          p_provider_message_id: providerResult.providerMessageId ?? null,
          p_error: sendError,
          p_delivery_uncertain: true,
        });
        if (uncertainFinishError || !(uncertainFinish as unknown[] | null)?.[0]) {
          return { status: "needs_review", error: "无法确认短信是否已被供应商接受；请检查供应商发送记录，且不要立即重新发送。" };
        }
        return { status: "needs_review", error: sendError };
      }
      throw new Error(providerResult.message);
    }
    sent = true;
    providerMessageId = providerResult.providerMessageId ?? null;
  } catch (cause) {
    sendError = cause instanceof Error ? cause.message.slice(0, 2000) : "فشل غير معروف عند الاتصال بمزود الرسائل.";
  }

  let rawFinish: unknown;
  let finishError: { message?: string } | null = null;
  for (let finishAttempt = 0; finishAttempt < 2; finishAttempt += 1) {
    const finishResult = await admin.rpc("powerhub_finish_sms_notification", {
      p_user_id: actorUserId,
      p_notification_id: claim.notification_id,
      p_attempt_number: claim.attempt_number,
      p_success: sent,
      p_provider_message_id: providerMessageId,
      p_error: sendError,
      p_delivery_uncertain: false,
    });
    rawFinish = finishResult.data;
    finishError = finishResult.error;
    if (!finishError && (rawFinish as unknown[] | null)?.[0]) break;
  }
  if (finishError || !(rawFinish as unknown[] | null)?.[0]) {
    return { status: "needs_review", error: "تعذر تثبيت نتيجة الإرسال؛ لا تعاود المحاولة قبل مراجعة سجل التدقيق." };
  }
  if (!sent) return { status: "failed", error: sendError ?? "رفض مزود TweetSMS الإرسال." };
  return { status: "submitted", providerMessageId };
}

export async function processNotificationQueueForTenant(tenantId: number, actorUserId: number, notificationIds: number[]) {
  if (!Number.isInteger(tenantId) || tenantId < 1) throw new TRPCError({ code: "BAD_REQUEST", message: "المولد غير صالح." });
  const uniqueIds = Array.from(new Set(notificationIds));
  const allResults: Array<{ notificationId: number } & DispatchResult> = [];
  for (let offset = 0; offset < uniqueIds.length; offset += 50) {
    const batch = uniqueIds.slice(offset, offset + 50);
    const results = await Promise.all(batch.map(async (notificationId) => ({ notificationId, ...await processNotificationById(notificationId, actorUserId) })));
    allResults.push(...results);
  }
  return {
    requested: allResults.length,
    submitted: allResults.filter((result) => result.status === "submitted").length,
    failed: allResults.filter((result) => result.status === "failed").length,
    needsReview: allResults.filter((result) => result.status === "needs_review").length,
    skipped: allResults.filter((result) => result.status === "skipped").length,
    results: allResults,
  };
}
