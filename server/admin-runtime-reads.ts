import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { authenticatedProcedure, router } from "./_core/trpc";
import { supabaseAdmin } from "./supabase-admin";
import { decryptTenantCredential, encryptTenantCredential } from "./tenant-crypto";
import { checkTweetSmsAccount, checkTweetSmsBalance, checkTweetSmsSender, type TweetSmsCredentials } from "./tweetsms-client";
import { adminRouter } from "./admin-runtime";

const legacyRecord = (adminRouter as any)._def.record as Record<string, any>;
const platformAdminProcedure = authenticatedProcedure.use(({ ctx, next }) => {
  const platformRole = ctx.user.platformRole ?? "platform_admin";
  if (ctx.user.role !== "admin" || !["platform_owner", "platform_admin"].includes(platformRole) || ctx.user.accountStatus !== "active") {
    throw new TRPCError({ code: "FORBIDDEN", message: "دور المنصة الحالي لا يملك هذه الصلاحية." });
  }
  return next({ ctx });
});

const reportInput = z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() }).optional();
const generatorStatusInput = z.object({ id: z.number().int().positive(), status: z.enum(["active", "maintenance", "stopped", "offline", "blocked"]) });
const generatorApprovalInput = z.object({ generatorId: z.number().int().positive() });
const notificationInput = z.object({ status: z.enum(["pending", "submitted", "delivered", "read", "failed"]).optional() }).optional();
const securityEventInput = z.object({ eventType: z.enum(["suspicious_login", "backup", "security_change"]), severity: z.enum(["info", "warning", "critical"]), status: z.enum(["open", "resolved", "success", "failed"]), title: z.string().min(3).max(180), details: z.string().max(4000).optional(), relatedUserId: z.number().int().positive().optional() });
const securitySettingInput = z.object({ settingKey: z.string().min(2).max(100), isEnabled: z.boolean(), value: z.string().max(4000).optional() });
const tweetSmsAccountInput = z.object({ tenantId: z.number().int().positive(), apiEndpoint: z.string().trim().max(500).optional(), apiKey: z.string().trim().min(8).max(4096).optional(), apiSecret: z.string().trim().max(4096).optional(), senderName: z.string().trim().min(1).max(120), monthlyLimit: z.number().int().min(0).max(10_000_000), isActive: z.boolean() });
const testTweetSmsInput = z.object({ tenantId: z.number().int().positive() });

type TweetSmsCredentialsShape = TweetSmsCredentials;

async function writeGeneratorAudit(actorUserId: number, generator: { tenant_id: number; site_id: number }, generatorId: number, action: string, beforeStatus: string, afterStatus: string) {
  const { error } = await supabaseAdmin().from("audit_logs").insert({ tenant_id: generator.tenant_id, site_id: generator.site_id, user_id: actorUserId, entity_type: "generator", entity_id: String(generatorId), action, before_data: { status: beforeStatus }, after_data: { status: afterStatus } });
  if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تم تحديث حالة المولد لكن تعذر تسجيل التدقيق في Supabase." });
}

function decryptTweetSmsCredentials(ciphertext: string, iv: string): TweetSmsCredentialsShape {
  const raw = decryptTenantCredential(ciphertext, iv);
  const parsed = JSON.parse(raw) as Partial<TweetSmsCredentialsShape>;
  if (typeof parsed.apiKey !== "string" || !parsed.apiKey.trim()) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "بيانات TweetSMS لهذا المولد غير صالحة؛ احفظ المفتاح من جديد." });
  return { apiKey: parsed.apiKey, ...(typeof parsed.apiSecret === "string" && parsed.apiSecret.trim() ? { apiSecret: parsed.apiSecret } : {}) };
}

export const adminRouterWithSupabaseReadContracts = router({
  ...legacyRecord,

  platformTweetSmsReport: platformAdminProcedure.input(reportInput).query(async ({ input }) => {
    const { data, error } = await supabaseAdmin().rpc("powerhub_tweetsms_report", { p_from: input?.from?.toISOString() ?? null, p_to: input?.to?.toISOString() ?? null });
    if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل تقرير TweetSMS المركزي من Supabase." });
    const report = (data as Array<{ account?: unknown; total?: string | number | null; usage_rows?: unknown; alerts?: unknown }> | null)?.[0];
    if (!report) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "لم تُعد دالة تقرير TweetSMS استجابة صالحة." });
    const usageRows = Array.isArray(report.usage_rows) ? (report.usage_rows as Array<Record<string, unknown>>).map((row) => ({ ...row, tenantId: row.tenant_id === undefined ? undefined : Number(row.tenant_id) })) : [];
    const alerts = Array.isArray(report.alerts) ? (report.alerts as Array<Record<string, unknown>>).map((row) => ({ ...row, id: row.id === undefined ? undefined : Number(row.id) })) : [];
    return { account: report.account ?? null, total: Number(report.total ?? 0), usageRows, alerts };
  }),

  advancedDashboard: platformAdminProcedure.query(async () => {
    const { data, error } = await supabaseAdmin().rpc("powerhub_advanced_dashboard");
    if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل لوحة التحليلات المركزية من Supabase." });
    const dashboard = (data as Array<Record<string, unknown>> | null)?.[0];
    if (!dashboard) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "لم تُعد دالة لوحة التحليلات استجابة صالحة." });
    return dashboard;
  }),

  setGeneratorStatus: platformAdminProcedure.input(generatorStatusInput).mutation(async ({ ctx, input }) => {
    const admin = supabaseAdmin();
    const { data: generator, error: generatorError } = await admin.from("generators").select("id,tenant_id,site_id,status").eq("id", input.id).maybeSingle();
    if (generatorError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل المولد من Supabase." });
    if (!generator) throw new TRPCError({ code: "NOT_FOUND", message: "المولد غير موجود." });
    const { error: statusError } = await admin.from("generators").update({ status: input.status }).eq("id", input.id);
    if (statusError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحديث حالة المولد في Supabase." });
    await writeGeneratorAudit(ctx.user.id, generator, input.id, "admin_set_generator_status", generator.status, input.status);
    return { success: true as const };
  }),

  approvePendingGenerator: platformAdminProcedure.input(generatorApprovalInput).mutation(async ({ ctx, input }) => {
    const admin = supabaseAdmin();
    const { data: generator, error: generatorError } = await admin.from("generators").select("id,tenant_id,site_id,status").eq("id", input.generatorId).maybeSingle();
    if (generatorError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل المولد من Supabase." });
    if (!generator) throw new TRPCError({ code: "NOT_FOUND", message: "المولد غير موجود." });
    if (generator.status !== "pending") throw new TRPCError({ code: "CONFLICT", message: "لا يمكن اعتماد مولد ليس بانتظار المراجعة." });
    const { data: updated, error: statusError } = await admin.from("generators").update({ status: "active" }).eq("id", input.generatorId).eq("status", "pending").select("id,status").maybeSingle();
    if (statusError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر اعتماد المولد في Supabase." });
    if (!updated) throw new TRPCError({ code: "CONFLICT", message: "تغيرت حالة المولد قبل إتمام الاعتماد؛ أعد المحاولة." });
    await writeGeneratorAudit(ctx.user.id, generator, input.generatorId, "admin_approve_pending_generator", "pending", "active");
    return { success: true as const, generatorId: input.generatorId, status: "active" as const };
  }),

  listNotifications: platformAdminProcedure.input(notificationInput).query(async ({ input }) => {
    const admin = supabaseAdmin();
    let query = admin.from("notification_messages").select("id,tenant_id,channel,event_type,recipient,status,attempts,last_error,created_at").order("created_at", { ascending: false }).limit(300);
    if (input?.status) query = query.eq("status", input.status);
    const { data, error } = await query;
    if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل سجل الإشعارات من Supabase." });
    const tenantIds = Array.from(new Set((data ?? []).map((row) => Number(row.tenant_id)).filter(Boolean)));
    const tenantNames = new Map<number, string>();
    if (tenantIds.length) {
      const { data: tenants, error: tenantError } = await admin.from("tenants").select("id,name").in("id", tenantIds);
      if (tenantError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل أسماء مساحات أصحاب المولدات." });
      for (const tenant of tenants ?? []) tenantNames.set(Number(tenant.id), tenant.name);
    }
    return (data ?? []).map((message) => ({ id: Number(message.id), channel: message.channel, eventType: message.event_type, recipient: message.recipient, status: message.status, attempts: Number(message.attempts ?? 0), lastError: message.last_error, createdAt: message.created_at, tenantName: tenantNames.get(Number(message.tenant_id)) ?? "—" }));
  }),

  securityCenter: platformAdminProcedure.query(async () => {
    const admin = supabaseAdmin();
    const [eventsResult, settingsResult] = await Promise.all([
      admin.from("platform_security_events").select("id,event_type,severity,status,title,details,created_at,resolved_at,related_user_id").order("created_at", { ascending: false }).limit(300),
      admin.from("platform_security_settings").select("id,setting_key,is_enabled,value,updated_at,updated_by_user_id").order("setting_key", { ascending: true }),
    ]);
    if (eventsResult.error || settingsResult.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل مركز الأمان من Supabase." });
    return { events: (eventsResult.data ?? []).map((event) => ({ id: Number(event.id), eventType: event.event_type, severity: event.severity, status: event.status, title: event.title, details: event.details, createdAt: event.created_at, resolvedAt: event.resolved_at, relatedUserId: event.related_user_id ? Number(event.related_user_id) : null })), settings: (settingsResult.data ?? []).map((setting) => ({ id: Number(setting.id), settingKey: setting.setting_key, isEnabled: setting.is_enabled, value: setting.value, updatedAt: setting.updated_at, updatedByUserId: setting.updated_by_user_id ? Number(setting.updated_by_user_id) : null })) };
  }),

  recordSecurityEvent: platformAdminProcedure.input(securityEventInput).mutation(async ({ ctx, input }) => {
    const { error } = await supabaseAdmin().from("platform_security_events").insert({ event_type: input.eventType, severity: input.severity, status: input.status, title: input.title, details: input.details ?? null, related_user_id: input.relatedUserId ?? null, created_by_user_id: ctx.user.id });
    if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تسجيل حدث الأمان في Supabase." });
    return { success: true as const };
  }),

  saveSecuritySetting: platformAdminProcedure.input(securitySettingInput).mutation(async ({ ctx, input }) => {
    const { error } = await supabaseAdmin().from("platform_security_settings").upsert({ setting_key: input.settingKey, is_enabled: input.isEnabled, value: input.value ?? null, updated_by_user_id: ctx.user.id, updated_at: new Date().toISOString() }, { onConflict: "setting_key" });
    if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر حفظ إعداد الأمان في Supabase." });
    return { success: true as const };
  }),

  saveTweetSmsAccount: platformAdminProcedure.input(tweetSmsAccountInput).mutation(async ({ ctx, input }) => {
    const identity = input.apiKey || input.apiSecret ? encryptTenantCredential(JSON.stringify({ apiKey: input.apiKey ?? "", apiSecret: input.apiSecret ?? "" })) : null;
    const { data, error } = await supabaseAdmin().rpc("powerhub_save_tenant_tweetsms_account", {
      p_user_id: ctx.user.id,
      p_tenant_id: input.tenantId,
      p_api_endpoint: input.apiEndpoint?.trim() || "https://tweetsms.ps",
      p_credential_ciphertext: identity?.ciphertext ?? "",
      p_credential_iv: identity?.iv ?? "",
      p_sender_name: input.senderName.trim(),
      p_monthly_limit: input.monthlyLimit,
      p_is_active: input.isActive,
    });
    if (error) {
      const message = error.message ?? "";
      if (message.includes("CREDENTIALS_REQUIRED")) throw new TRPCError({ code: "BAD_REQUEST", message: "أدخل مفتاح TweetSMS عند إنشاء الحساب." });
      if (message.includes("TENANT_NOT_FOUND")) throw new TRPCError({ code: "NOT_FOUND", message: "مساحة صاحب المولد غير موجودة." });
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر حفظ حساب TweetSMS في Supabase." });
    }
    const row = data?.[0];
    return { id: Number(row?.account_id), tenantId: Number(row?.tenant_id), isActive: Boolean(row?.is_active), activationRequired: Boolean(row?.activation_required) };
  }),

  testTweetSmsAccount: platformAdminProcedure.input(testTweetSmsInput).mutation(async ({ ctx, input }) => {
    const admin = supabaseAdmin();
    const { data: account, error: accountError } = await admin.from("tenant_tweetsms_accounts").select("tenant_id,api_endpoint,credential_ciphertext,credential_iv,sender_name,updated_at").eq("tenant_id", input.tenantId).maybeSingle();
    if (accountError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل حساب TweetSMS من Supabase." });
    if (!account) throw new TRPCError({ code: "NOT_FOUND", message: "لا يوجد حساب TweetSMS لهذا المولد." });
    let result: { ok: boolean; balance?: number; message?: string } = { ok: false, message: "تعذر فحص TweetSMS لهذا المولد." };
    try {
      const credentials = decryptTweetSmsCredentials(account.credential_ciphertext, account.credential_iv);
      const endpoint = account.api_endpoint;
      const login = await checkTweetSmsAccount({ endpoint, credentials });
      const sender = login.ok && account.sender_name ? await checkTweetSmsSender({ endpoint, credentials, sender: account.sender_name }) : null;
      const balance = login.ok && (!sender || sender.ok) ? await checkTweetSmsBalance({ endpoint, credentials }) : null;
      if (!login.ok) result = { ok: false, message: login.message };
      else if (sender && !sender.ok) result = { ok: false, message: sender.message };
      else if (!balance?.ok) result = { ok: false, message: balance?.message ?? "تعذر قراءة رصيد TweetSMS." };
      else result = { ok: true, balance: balance.balance };
    } catch (cause) {
      result = { ok: false, message: cause instanceof Error ? cause.message : "تعذر فحص TweetSMS لهذا المولد." };
    }
    const { data, error } = await admin.rpc("powerhub_record_tenant_tweetsms_test", { p_user_id: ctx.user.id, p_tenant_id: input.tenantId, p_expected_updated_at: account.updated_at, p_success: result.ok, p_balance: Number.isFinite(result.balance) ? Math.max(0, Math.round(result.balance ?? 0)) : null, p_error: result.ok ? null : result.message });
    if (error) {
      if ((error.message ?? "").includes("CONFIGURATION_CHANGED")) throw new TRPCError({ code: "CONFLICT", message: "تغير إعداد TweetSMS أثناء الفحص؛ أعد المحاولة." });
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر حفظ نتيجة فحص TweetSMS في Supabase." });
    }
    const row = data?.[0];
    return { ok: result.ok, balance: result.balance ?? null, message: result.message ?? null, accountActive: Boolean(row?.is_active) };
  }),
});
