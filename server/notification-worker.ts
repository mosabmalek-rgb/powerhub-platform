import { TRPCError } from "@trpc/server";
import { decryptTenantCredential } from "./tenant-crypto";
import { supabaseAdmin } from "./supabase-admin";
import { sendTweetSms, type TweetSmsCredentials } from "./tweetsms-client";
import { normalizeInternationalPhone } from "../shared/phone";

type DispatchResult = { status: "submitted" | "failed" | "skipped"; providerMessageId?: string | null; error?: string };
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
    if (!providerResult.ok) throw new Error(providerResult.message);
    sent = true;
    providerMessageId = providerResult.providerMessageId ?? null;
  } catch (cause) {
    sendError = cause instanceof Error ? cause.message.slice(0, 2000) : "فشل غير معروف عند الاتصال بمزود الرسائل.";
  }

  const { data: rawFinish, error: finishError } = await admin.rpc("powerhub_finish_sms_notification", {
    p_user_id: actorUserId,
    p_notification_id: claim.notification_id,
    p_attempt_number: claim.attempt_number,
    p_success: sent,
    p_provider_message_id: providerMessageId,
    p_error: sendError,
  });
  if (finishError || !(rawFinish as unknown[] | null)?.[0]) {
    return { status: "failed", error: "تعذر تثبيت نتيجة الإرسال؛ لا تعاود المحاولة قبل مراجعة سجل التدقيق." };
  }
  if (!sent) return { status: "failed", error: sendError ?? "رفض مزود TweetSMS الإرسال." };
  return { status: "submitted", providerMessageId };
}

export async function processNotificationQueueForTenant(tenantId: number, actorUserId: number, notificationIds: number[]) {
  if (!Number.isInteger(tenantId) || tenantId < 1) throw new TRPCError({ code: "BAD_REQUEST", message: "المولد غير صالح." });
  const uniqueIds = Array.from(new Set(notificationIds)).slice(0, 50);
  const results = await Promise.all(uniqueIds.map(async (notificationId) => ({ notificationId, ...await processNotificationById(notificationId, actorUserId) })));
  return {
    requested: uniqueIds.length,
    submitted: results.filter((result) => result.status === "submitted").length,
    failed: results.filter((result) => result.status === "failed").length,
    skipped: results.filter((result) => result.status === "skipped").length,
    results,
  };
}


function cronIsDue(cron: string | null | undefined, now: Date) {
  const minute = now.getUTCMinutes();
  const hour = now.getUTCHours();
  if (cron === "0 0/15 * * * *") return minute % 15 === 0;
  if (cron === "0 0 * * * *") return minute === 0;
  if (cron === "0 0 8 * * *") return minute === 0 && hour === 8;
  return false;
}

export async function processAutomaticInvoiceNotifications(now = new Date()) {
  const admin = supabaseAdmin();
  const { data: configurations, error: configurationsError } = await admin
    .from("tenant_messaging_configurations")
    .select("id, tenant_id, auto_send_cron")
    .eq("channel", "sms")
    .eq("is_active", true)
    .eq("auto_send_after_approval", true);

  if (configurationsError) throw new Error("تعذر تحميل إعدادات الإرسال التلقائي.");

  const { data: actor, error: actorError } = await admin
    .from("users")
    .select("id")
    .eq("account_status", "active")
    .in("platform_role", ["platform_owner", "platform_admin"])
    .order("id", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (actorError) throw new Error("تعذر تحديد منفذ الجدولة المركزي.");
  if (!actor) throw new Error("لا يوجد حساب آدمن منصة نشط لتسجيل عمليات الإرسال المجدول.");

  const results: Array<{ tenantId: number; configurationId: number; status: "success" | "failed"; scanned: number; submitted: number; failed: number; skipped: number; error: string | null }> = [];

  for (const configuration of configurations ?? []) {
    const tenantId = Number(configuration.tenant_id);
    const configurationId = Number(configuration.id);
    if (!cronIsDue(configuration.auto_send_cron, now)) continue;

    const startedAt = new Date();
    let status: "success" | "failed" = "success";
    let errorMessage: string | null = null;
    let scanned = 0;
    let submitted = 0;
    let failed = 0;
    let skipped = 0;

    try {
      const { data: messages, error: messagesError } = await admin
        .from("notification_messages")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("channel", "sms")
        .eq("event_type", "invoice_issued")
        .eq("status", "pending")
        .order("created_at", { ascending: true })
        .limit(50);
      if (messagesError) throw new Error("تعذر تحميل رسائل الفواتير المؤجلة.");
      const ids = (messages ?? []).map((row) => Number(row.id)).filter(Number.isInteger);
      scanned = ids.length;
      if (ids.length) {
        const result = await processNotificationQueueForTenant(tenantId, Number(actor.id), ids);
        submitted = result.submitted;
        failed = result.failed;
        skipped = result.skipped;
      }
    } catch (cause) {
      status = "failed";
      errorMessage = cause instanceof Error ? cause.message.slice(0, 2000) : "فشل غير معروف في الإرسال المجدول.";
    }

    await admin.from("messaging_schedule_runs").insert({
      tenant_id: tenantId,
      configuration_id: configurationId,
      status,
      scanned,
      submitted,
      failed,
      skipped,
      error: errorMessage,
      task_uid: "vercel:invoice-notifications:v1",
      started_at: startedAt.toISOString(),
      finished_at: new Date().toISOString(),
    });

    results.push({ tenantId, configurationId, status, scanned, submitted, failed, skipped, error: errorMessage });
  }

  return {
    processedConfigurations: results.length,
    submitted: results.reduce((sum, row) => sum + row.submitted, 0),
    failed: results.reduce((sum, row) => sum + row.failed, 0),
    results,
  };
}
