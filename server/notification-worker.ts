import { TRPCError } from "@trpc/server";
import { decryptTenantCredential } from "./tenant-crypto";
import { supabaseAdmin } from "./supabase-admin";
import { checkTweetSmsBalance, sendTweetSms, type TweetSmsCredentials } from "./tweetsms-client";
import { normalizeInternationalPhone } from "../shared/phone";
import { writeSupabaseAudit } from "./powerhub-supabase";

type DispatchResult = { status: "submitted" | "failed" | "skipped" | "needs_review"; providerMessageId?: string | null; error?: string };
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
    const balanceBefore = await checkTweetSmsBalance({ endpoint: claim.api_endpoint, credentials });
    if (!balanceBefore.ok || balanceBefore.balance === undefined) {
      throw new Error("تعذر قراءة رصيد TweetSMS قبل الإرسال؛ لم تثبت نتيجة الإرسال.");
    }

    const providerResult = await sendTweetSms({
      endpoint: claim.api_endpoint,
      credentials,
      sender: claim.sender_name,
      message: claim.rendered_text,
      recipient: normalizeInternationalPhone(claim.recipient),
    });
    if (!providerResult.ok) throw new Error(providerResult.message || "رفض مزود TweetSMS الإرسال.");

    const balanceAfter = await checkTweetSmsBalance({ endpoint: claim.api_endpoint, credentials });
    if (!balanceAfter.ok || balanceAfter.balance === undefined) {
      throw new Error("تعذر التحقق من خصم رصيد TweetSMS؛ اعتُبرت الرسالة غير مرسلة.");
    }
    if (balanceAfter.balance >= balanceBefore.balance) {
      throw new Error("لم يثبت خصم رصيد TweetSMS؛ اعتُبرت الرسالة غير مرسلة.");
    }

    sent = true;
    providerMessageId = providerResult.providerMessageId ?? null;
  } catch (cause) {
    sendError = cause instanceof Error ? cause.message.slice(0, 2000) : "فشل غير معروف عند إرسال الرسالة.";
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
    if (sent) {
      const { error: reviewError } = await admin.rpc("powerhub_mark_sms_needs_review", {
        p_user_id: actorUserId,
        p_notification_id: claim.notification_id,
        p_attempt_number: claim.attempt_number,
        p_error: "تم قبول الرسالة والتحقق من خصم الرصيد، لكن تعذر تثبيت حالة الإرسال؛ أوقفت إعادة المحاولة التلقائية لحماية عدم التكرار.",
      });
      if (reviewError) return { status: "failed", error: "تعذر تثبيت نتيجة الإرسال أو عزلها للمراجعة؛ راجع سجل التدقيق قبل أي إعادة محاولة." };
      return { status: "needs_review", error: "تم قبول الإرسال لكن حالة النظام غير مؤكدة؛ أوقفت إعادة المحاولة التلقائية." };
    }
    return { status: "failed", error: "تعذر تثبيت نتيجة الإرسال؛ راجع سجل التدقيق قبل إعادة المحاولة." };
  }
  if (!sent) return { status: "failed", error: sendError ?? "رفض مزود TweetSMS الإرسال." };
  return { status: "submitted", providerMessageId };
}

export async function processNotificationQueueForTenant(tenantId: number, actorUserId: number, notificationIds: number[]) {
  if (!Number.isInteger(tenantId) || tenantId < 1) throw new TRPCError({ code: "BAD_REQUEST", message: "المولد غير صالح." });
  const uniqueIds = Array.from(new Set(notificationIds)).slice(0, 50);
  // Balance-deduction confirmation is account-scoped. Process one message at a time
  // per tenant so concurrent sends cannot hide one another's balance change.
  const results: Array<{ notificationId: number } & DispatchResult> = [];
  for (const notificationId of uniqueIds) {
    results.push({ notificationId, ...await processNotificationById(notificationId, actorUserId) });
  }
  return {
    requested: uniqueIds.length,
    submitted: results.filter((result) => result.status === "submitted").length,
    failed: results.filter((result) => result.status === "failed").length,
    skipped: results.filter((result) => result.status === "skipped").length,
    needsReview: results.filter((result) => result.status === "needs_review").length,
    results,
  };
}



/**
 * Dispatches queued unified SMS messages without touching the legacy invoice path.
 * The query is intentionally bounded; the next protected cron run continues the queue.
 */
export async function processAutomaticUnifiedNotifications(now = new Date()) {
  const admin = supabaseAdmin();
  const { error: reclaimError } = await admin.rpc("powerhub_reclaim_stale_sms_notifications", { p_limit: 200 });
  if (reclaimError) throw new Error("تعذر استرداد رسائل المراسلة الموحدة العالقة قبل بدء الدورة.");

  const { data: messages, error: messagesError } = await admin
    .from("notification_messages")
    .select("id,tenant_id,subscriber_id")
    .eq("channel", "sms")
    .in("send_type", ["automatic", "scheduled"])
    .neq("event_type", "invoice_issued")
    .eq("status", "pending")
    .not("scheduled_at", "is", null)
    .lte("scheduled_at", now.toISOString())
    .order("scheduled_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(200);
  if (messagesError) throw new Error("تعذر تحميل رسائل المراسلة الموحدة المعلقة.");

  const { data: actor, error: actorError } = await admin.from("users")
    .select("id")
    .eq("account_status", "active")
    .in("platform_role", ["platform_owner", "platform_admin"])
    .order("id", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (actorError) throw new Error("تعذر تحديد منفذ المعالجة المركزي للمراسلات الموحدة.");
  if (!actor) throw new Error("لا يوجد حساب آدمن منصة نشط لمعالجة المراسلات الموحدة.");

  const notificationRows = (messages ?? []).filter((row: any) => Number.isInteger(Number(row.id)) && Number.isInteger(Number(row.tenant_id)) && Number.isInteger(Number(row.subscriber_id)));
  const subscriberIds = notificationRows.map((row: any) => Number(row.subscriber_id));
  const { data: subscribers, error: subscribersError } = subscriberIds.length
    ? await admin.from("subscribers").select("id,tenant_id,site_id").in("id", subscriberIds)
    : { data: [], error: null };
  if (subscribersError) throw new Error("تعذر التحقق من فروع رسائل المراسلة الموحدة.");
  const subscriberScope = new Map((subscribers ?? []).map((row: any) => [Number(row.id), { tenantId: Number(row.tenant_id), siteId: Number(row.site_id) }]));
  const byScope = new Map<string, { tenantId: number; siteId: number; ids: number[] }>();
  for (const row of notificationRows) {
    const tenantId = Number(row.tenant_id);
    const notificationId = Number(row.id);
    const scope = subscriberScope.get(Number(row.subscriber_id));
    if (!scope || scope.tenantId !== tenantId || !Number.isInteger(scope.siteId) || scope.siteId < 1) continue;
    const key = `${tenantId}:${scope.siteId}`;
    const group = byScope.get(key) ?? { tenantId, siteId: scope.siteId, ids: [] };
    group.ids.push(notificationId);
    byScope.set(key, group);
  }

  const results: Array<{ tenantId: number; siteId: number; scanned: number; submitted: number; failed: number; skipped: number }> = [];
  for (const { tenantId, siteId, ids: notificationIds } of byScope.values()) {
    // Re-read the tenant scope before invoking the worker. Never hand a mixed-tenant
    // ID list to a tenant worker, even if the queue changed between the two reads.
    const { data: scopedRows, error: scopeError } = await admin.from("notification_messages")
      .select("id,subscriber_id")
      .eq("tenant_id", tenantId)
      .in("id", notificationIds)
      .eq("channel", "sms")
      .in("send_type", ["automatic", "scheduled"])
      .neq("event_type", "invoice_issued")
      .eq("status", "pending")
      .not("scheduled_at", "is", null)
      .lte("scheduled_at", now.toISOString());
    if (scopeError) throw new Error("تعذر التحقق من عزل مستأجر رسائل المراسلة الموحدة.");
    const scopedIds = (scopedRows ?? [])
      .filter((row: any) => subscriberScope.get(Number(row.subscriber_id))?.tenantId === tenantId && subscriberScope.get(Number(row.subscriber_id))?.siteId === siteId)
      .map((row: any) => Number(row.id))
      .filter(Number.isInteger);
    if (!scopedIds.length) continue;

    const totals = { requested: 0, submitted: 0, failed: 0, skipped: 0 };
    for (let offset = 0; offset < scopedIds.length; offset += 50) {
      const batch = scopedIds.slice(offset, offset + 50);
      const result = await processNotificationQueueForTenant(tenantId, Number(actor.id), batch);
      totals.requested += result.requested;
      totals.submitted += result.submitted;
      totals.failed += result.failed;
      totals.skipped += result.skipped;
    }
    const summary = {
      tenantId,
      siteId,
      scanned: scopedIds.length,
      submitted: totals.submitted,
      failed: totals.failed,
      skipped: totals.skipped,
    };
    results.push(summary);
    await writeSupabaseAudit({
      userId: Number(actor.id),
      tenantId,
      siteId,
      entityType: "unified_notification_dispatcher",
      entityId: `cron:${now.toISOString()}`,
      action: "dispatch",
      metadata: summary,
    });
  }

  return {
    scanned: results.reduce((sum, row) => sum + row.scanned, 0),
    submitted: results.reduce((sum, row) => sum + row.submitted, 0),
    failed: results.reduce((sum, row) => sum + row.failed, 0),
    skipped: results.reduce((sum, row) => sum + row.skipped, 0),
    results,
  };
}

export async function processAutomaticInvoiceNotifications(now = new Date()) {
  const admin = supabaseAdmin();

  const { error: reclaimError } = await admin.rpc("powerhub_reclaim_stale_sms_notifications", { p_limit: 200 });
  if (reclaimError) throw new Error("تعذر استرداد رسائل SMS العالقة قبل بدء الدورة.");

  // Business rule: the only automatic SMS is invoice_issued.
  // The cron is an internal dispatcher only; tenant-configured cycles are enforced by scheduled_at.
  const { data: messages, error: messagesError } = await admin
    .from("notification_messages")
    .select("id, tenant_id")
    .eq("channel", "sms")
    .eq("event_type", "invoice_issued")
    .eq("status", "pending")
    // Legacy rows may predate scheduled_at. Treat them as immediately due;
    // the reconciliation migration backfills the column for future runs.
    .or(`scheduled_at.is.null,scheduled_at.lte.${now.toISOString()}`)
    .order("scheduled_at", { ascending: true })
    .order("created_at", { ascending: true })
    .limit(200);

  if (messagesError) throw new Error("تعذر تحميل رسائل فواتير SMS المعلقة.");

  const { data: actor, error: actorError } = await admin
    .from("users")
    .select("id")
    .eq("account_status", "active")
    .in("platform_role", ["platform_owner", "platform_admin"])
    .order("id", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (actorError) throw new Error("تعذر تحديد منفذ المعالجة المركزي.");
  if (!actor) throw new Error("لا يوجد حساب آدمن منصة نشط لمعالجة طابور SMS.");

  const byTenant = new Map<number, number[]>();
  for (const row of messages ?? []) {
    const tenantId = Number(row.tenant_id);
    const id = Number(row.id);
    if (!Number.isInteger(tenantId) || !Number.isInteger(id)) continue;
    const ids = byTenant.get(tenantId) ?? [];
    ids.push(id);
    byTenant.set(tenantId, ids);
  }

  const results = await Promise.all(Array.from(byTenant, async ([tenantId, ids]) => {
    const result = await processNotificationQueueForTenant(tenantId, Number(actor.id), ids);
    const summary = {
      tenantId,
      scanned: result.requested,
      submitted: result.submitted,
      failed: result.failed,
      skipped: result.skipped,
    };

    // Keep the existing operational audit trail, but explicitly identify this
    // as internal queue processing rather than a tenant-configured schedule.
    const configuration = await admin
      .from("tenant_messaging_configurations")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("channel", "sms")
      .maybeSingle();

    if (configuration.data?.id) {
      await admin.from("messaging_schedule_runs").insert({
        tenant_id: tenantId,
        configuration_id: Number(configuration.data.id),
        status: result.failed ? "failed" : "success",
        scanned: result.requested,
        submitted: result.submitted,
        failed: result.failed,
        skipped: result.skipped,
        error: null,
        task_uid: "supabase:invoice-sms-dispatch:v2",
        started_at: now.toISOString(),
        finished_at: new Date().toISOString(),
      });
    }
    return summary;
  }));

  return {
    processedConfigurations: results.length,
    submitted: results.reduce((sum, row) => sum + row.submitted, 0),
    failed: results.reduce((sum, row) => sum + row.failed, 0),
    skipped: results.reduce((sum, row) => sum + row.skipped, 0),
    results,
  };
}
