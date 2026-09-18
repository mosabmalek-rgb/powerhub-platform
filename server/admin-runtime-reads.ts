import crypto from "node:crypto";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { authenticatedProcedure, router } from "./_core/trpc";
import { supabaseAdmin } from "./supabase-admin";
import { completePasswordResetWithRetry } from "./password-reset-runtime";
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
const platformFinanceProcedure = authenticatedProcedure.use(({ ctx, next }) => {
  const platformRole = ctx.user.platformRole ?? "platform_admin";
  if (ctx.user.role !== "admin" || !["platform_owner", "platform_admin", "finance_admin"].includes(platformRole) || ctx.user.accountStatus !== "active") {
    throw new TRPCError({ code: "FORBIDDEN", message: "دور المنصة الحالي لا يملك هذه الصلاحية المالية." });
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
const centralTweetSmsAccountInput = z.object({ apiEndpoint: z.string().trim().max(500).optional(), senderName: z.string().trim().min(1).max(120), lowBalanceThreshold: z.number().int().min(0).max(10_000_000), isActive: z.boolean() });
const emptyInput = z.object({});
const tenantStatusInput = z.object({ tenantId: z.number().int().positive(), status: z.enum(["active", "suspended"]) });

function runtimeCentralTweetSmsCredentials() {
  const apiKey = process.env.TWEETSMS_API_KEY?.trim() ?? "";
  const apiToken = process.env.TWEETSMS_API_TOKEN?.trim() ?? "";
  return apiKey ? { apiKey, ...(apiToken ? { apiSecret: apiToken } : {}) } : null;
}

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

  savePlatformTweetSmsAccount: platformAdminProcedure.input(centralTweetSmsAccountInput).mutation(async ({ ctx, input }) => {
    const credentials = runtimeCentralTweetSmsCredentials();
    const encrypted = credentials ? encryptTenantCredential(JSON.stringify(credentials)) : null;
    const { data, error } = await supabaseAdmin().rpc("powerhub_save_platform_tweetsms_account", { p_user_id: ctx.user.id, p_api_endpoint: input.apiEndpoint?.trim() || "https://tweetsms.ps", p_credential_ciphertext: encrypted?.ciphertext ?? "", p_credential_iv: encrypted?.iv ?? "", p_sender_name: input.senderName.trim(), p_low_balance_threshold: input.lowBalanceThreshold, p_is_active: input.isActive });
    if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر حفظ إعدادات TweetSMS المركزية في Supabase." });
    const row = data?.[0];
    return { id: Number(row?.account_id), isActive: Boolean(row?.is_active), activationRequired: Boolean(row?.activation_required) };
  }),
  testPlatformTweetSmsAccount: platformAdminProcedure.input(emptyInput.optional()).mutation(async ({ ctx }) => {
    const admin = supabaseAdmin();
    const { data: account, error: accountError } = await admin.from("platform_tweetsms_accounts").select("api_endpoint,sender_name,credential_ciphertext,credential_iv").order("updated_at", { ascending: false }).limit(1).maybeSingle();
    if (accountError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل حساب TweetSMS المركزي من Supabase." });
    if (!account) throw new TRPCError({ code: "NOT_FOUND", message: "لم يتم إعداد حساب TweetSMS المركزي." });
    let result: { ok: boolean; balance?: number; message?: string } = { ok: false, message: "تعذر فحص حساب TweetSMS المركزي." };
    try {
      const credentials = account.credential_ciphertext && account.credential_iv ? JSON.parse(decryptTenantCredential(account.credential_ciphertext, account.credential_iv)) as TweetSmsCredentialsShape : runtimeCentralTweetSmsCredentials();
      if (!credentials) throw new Error("لم تُحفظ بيانات اعتماد TweetSMS بعد.");
      const login = await checkTweetSmsAccount({ endpoint: account.api_endpoint, credentials });
      const sender = login.ok && account.sender_name ? await checkTweetSmsSender({ endpoint: account.api_endpoint, credentials, sender: account.sender_name }) : null;
      const balance = login.ok && (!sender || sender.ok) ? await checkTweetSmsBalance({ endpoint: account.api_endpoint, credentials }) : null;
      if (!login.ok) result = { ok: false, message: login.message }; else if (sender && !sender.ok) result = { ok: false, message: sender.message }; else if (!balance?.ok) result = { ok: false, message: balance?.message ?? "تعذر قراءة رصيد TweetSMS." }; else result = { ok: true, balance: balance.balance };
    } catch (cause) { result = { ok: false, message: cause instanceof Error ? cause.message : "تعذر فحص حساب TweetSMS المركزي." }; }
    const { data, error } = await admin.rpc("powerhub_record_platform_tweetsms_test", { p_user_id: ctx.user.id, p_success: result.ok, p_balance: Number.isFinite(result.balance) ? Math.max(0, Math.round(result.balance ?? 0)) : null, p_error: result.ok ? null : result.message });
    if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تسجيل نتيجة فحص TweetSMS المركزي في Supabase." });
    const row = data?.[0];
    return { ok: result.ok, balance: result.balance ?? null, message: result.message ?? null, accountActive: Boolean(row?.is_active) };
  }),
  sendOwnerUsageAlert: platformAdminProcedure.input(z.object({
    tenantId: z.number().int().positive(),
    usagePercent: z.number().int().min(0).max(100),
    message: z.string().trim().min(5).max(1200),
  })).mutation(async ({ ctx, input }) => {
    const admin = supabaseAdmin();
    const { data: ownerSite, error: siteError } = await admin.from("sites")
      .select("id,tenant_id").eq("tenant_id", input.tenantId).neq("status", "archived").order("id", { ascending: true }).limit(1).maybeSingle();
    if (siteError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحديد الفرع الرئيسي لصاحب المولد." });
    if (!ownerSite) throw new TRPCError({ code: "NOT_FOUND", message: "لا توجد محطة نشطة لمساحة صاحب المولد." });
    const severity = input.usagePercent >= 100 ? "critical" : input.usagePercent >= 80 ? "warning" : "info";
    const { data, error } = await admin.from("tenant_owner_alerts").insert({
      tenant_id: input.tenantId,
      site_id: Number(ownerSite.id),
      title: input.usagePercent >= 100 ? "تم بلوغ حد الاستهلاك" : "تنبيه استهلاك الباقة",
      message: input.message,
      severity,
      created_by_user_id: ctx.user.id,
      metadata: { usagePercent: input.usagePercent, source: "platform_admin" },
    }).select("id").single();
    if (error || !data) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر حفظ تنبيه صاحب المولد في Supabase." });
    return { success: true as const, alertId: Number(data.id) };
  }),

  setTenantStatus: platformAdminProcedure.input(tenantStatusInput).mutation(async ({ ctx, input }) => {
    const { data, error } = await supabaseAdmin().rpc("powerhub_set_tenant_status_atomic", {
      p_tenant_id: input.tenantId,
      p_status: input.status,
      p_actor_user_id: ctx.user.id,
    });
    if (error) {
      const message = error.message ?? "";
      if (message.includes("TENANT_NOT_FOUND")) throw new TRPCError({ code: "NOT_FOUND", message: "مساحة صاحب المولد غير موجودة." });
      if (message.includes("TENANT_SUBSCRIPTION_NOT_FOUND")) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "لا يوجد اشتراك مرتبط بمساحة صاحب المولد." });
      if (message.includes("INVALID_TENANT_STATUS")) throw new TRPCError({ code: "BAD_REQUEST", message: "حالة مساحة صاحب المولد غير صالحة." });
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحديث حالة مساحة صاحب المولد بشكل ذري في Supabase." });
    }
    const row = data?.[0];
    if (!row) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "لم تُعد عملية تحديث حالة المساحة نتيجة صالحة." });
    return { success: true as const, previousStatus: row.previous_status, newStatus: row.new_status };
  }),
  platformTweetSmsReport: platformAdminProcedure.input(reportInput).query(async ({ input }) => {
    const { data, error } = await supabaseAdmin().rpc("powerhub_tweetsms_report", { p_from: input?.from?.toISOString() ?? null, p_to: input?.to?.toISOString() ?? null });
    if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل تقرير TweetSMS المركزي من Supabase." });
    const report = (data as Array<{ account?: unknown; total?: string | number | null; usage_rows?: unknown; alerts?: unknown }> | null)?.[0];
    if (!report) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "لم تُعد دالة تقرير TweetSMS استجابة صالحة." });
    const usageRows = Array.isArray(report.usage_rows) ? (report.usage_rows as Array<Record<string, unknown>>).map((row) => ({ ...row, tenantId: row.tenant_id === undefined ? (row.tenantId === undefined ? undefined : Number(row.tenantId)) : Number(row.tenant_id) })) : [];
    const alerts = Array.isArray(report.alerts) ? (report.alerts as Array<Record<string, unknown>>).map((row) => ({ ...row, id: row.id === undefined ? undefined : Number(row.id) })) : [];
    return { account: report.account ?? null, total: Number(report.total ?? 0), usageRows, alerts };
  }),

  rolePolicies: platformAdminProcedure.query(async () => {
    const { data, error } = await supabaseAdmin().from("platform_role_policies").select("id,role,capability,is_allowed,updated_by_user_id,updated_at").order("role", { ascending: true });
    if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل سياسات الأدوار من Supabase." });
    return (data ?? []).map((row) => ({ id: Number(row.id), role: row.role, capability: row.capability, isAllowed: row.is_allowed, updatedByUserId: row.updated_by_user_id ? Number(row.updated_by_user_id) : null, updatedAt: row.updated_at }));
  }),
  platformAccessDirectory: platformAdminProcedure.query(async () => {
    const admin = supabaseAdmin();
    const accountsResult = await admin.from("users").select("id,name,email,platform_role,account_status,last_signed_in").eq("role", "admin").order("last_signed_in", { ascending: false }).limit(100);
    const invitationsResult = await admin.from("platform_access_invitations").select("id,email,platform_role,status,expires_at,accepted_at,invited_by_user_id").order("created_at", { ascending: false }).limit(100);
    if (accountsResult.error || invitationsResult.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل دليل وصول المنصة من Supabase." });
    return { accounts: (accountsResult.data ?? []).map((row) => ({ ...row, id: Number(row.id), platformRole: row.platform_role, accountStatus: row.account_status, lastSignedIn: row.last_signed_in })), invitations: (invitationsResult.data ?? []).map((row) => ({ ...row, id: Number(row.id), platformRole: row.platform_role, expiresAt: row.expires_at, acceptedAt: row.accepted_at, invitedByUserId: row.invited_by_user_id ? Number(row.invited_by_user_id) : null })) };
  }),
  generatorDetails: platformAdminProcedure.input(z.object({ generatorId: z.number().int().positive() })).query(async ({ input }) => {
    const admin = supabaseAdmin();
    const generatorResult = await admin.from("generators").select("id,code,name,status,rated_capacity_kw,fuel_type,fuel_level_liters,operating_hours,last_maintenance_at,tenant_id,site_id,created_at").eq("id", input.generatorId).maybeSingle();
    if (generatorResult.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل تفاصيل المولد من Supabase." });
    const generator = generatorResult.data;
    if (!generator) return { generator: null, activity: [] };
    const tenantResult = await admin.from("tenants").select("id,name").eq("id", generator.tenant_id).maybeSingle();
    const siteResult = await admin.from("sites").select("id,name").eq("id", generator.site_id).maybeSingle();
    const auditResult = await admin.from("audit_logs").select("id,action,created_at,user_id").eq("site_id", generator.site_id).order("created_at", { ascending: false }).limit(100);
    const userIds = Array.from(new Set((auditResult.data ?? []).map((row) => Number(row.user_id)).filter(Boolean)));
    const usersResult = await admin.from("users").select("id,name").in("id", userIds);
    if (tenantResult.error || siteResult.error || auditResult.error || usersResult.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل سياق نشاط المولد." });
    const names = new Map((usersResult.data ?? []).map((row) => [Number(row.id), row.name]));
    return { generator: { id: Number(generator.id), code: generator.code, name: generator.name, status: generator.status, ratedCapacityKw: String(generator.rated_capacity_kw), fuelType: generator.fuel_type, fuelLevelLiters: generator.fuel_level_liters, operatingHours: generator.operating_hours, lastMaintenanceAt: generator.last_maintenance_at, tenantId: Number(generator.tenant_id), siteId: Number(generator.site_id), tenantName: tenantResult.data?.name ?? "—", siteName: siteResult.data?.name ?? "—", createdAt: generator.created_at }, activity: (auditResult.data ?? []).map((row) => ({ id: Number(row.id), action: row.action, createdAt: row.created_at, userId: row.user_id ? Number(row.user_id) : null, userName: names.get(Number(row.user_id)) ?? "—" })) };
  }),
  financeOverview: platformFinanceProcedure.query(async () => {
    const { data, error } = await supabaseAdmin().rpc("powerhub_finance_overview");
    if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل الملخص المالي المركزي من Supabase." });
    const row = (data as Array<Record<string, unknown>> | null)?.[0] ?? {};
    return { subscriptions: Array.isArray(row.subscriptions) ? row.subscriptions : [], collections: { amount: Number(row.collections_amount ?? 0), count: Number(row.collections_count ?? 0) } };
  }),
  platformConfiguration: platformAdminProcedure.query(async () => {
    const admin = supabaseAdmin();
    const settingsResult = await admin.from("platform_settings").select("id,setting_key,is_enabled,value,message,updated_by_user_id,updated_at").order("setting_key", { ascending: true });
    const recoveriesResult = await admin.from("access_recovery_requests").select("id,tenant_id,method,status,note,created_at").order("created_at", { ascending: false });
    const tariffResult = await admin.from("platform_tariff_policies").select("id,minimum_price_per_kwh,maximum_price_per_kwh,effective_from,notification_requested,notes,created_by_user_id,created_at").order("effective_from", { ascending: false }).limit(1);
    if (settingsResult.error || recoveriesResult.error || tariffResult.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل إعدادات المنصة من Supabase." });
    const recoveries = recoveriesResult.data ?? [];
    const tenantIds = Array.from(new Set(recoveries.map((row) => Number(row.tenant_id)).filter(Boolean)));
    const tenantsResult = await admin.from("tenants").select("id,name").in("id", tenantIds);
    const ownersResult = await admin.from("tenant_owner_profiles").select("tenant_id,full_name,phone").in("tenant_id", tenantIds);
    if (tenantsResult.error || ownersResult.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر إثراء طلبات الاسترداد بأسماء المساحات والمالكين." });
    const tenantNames = new Map((tenantsResult.data ?? []).map((row) => [Number(row.id), row.name]));
    const ownerNames = new Map((ownersResult.data ?? []).map((row) => [Number(row.tenant_id), row.full_name]));
    return {
      settings: (settingsResult.data ?? []).map((row) => ({ id: Number(row.id), settingKey: row.setting_key, isEnabled: row.is_enabled, value: row.value, message: row.message, updatedByUserId: row.updated_by_user_id ? Number(row.updated_by_user_id) : null, updatedAt: row.updated_at })),
      recoveries: recoveries.map((row) => ({ id: Number(row.id), tenantId: Number(row.tenant_id), method: row.method, status: row.status, note: row.note, createdAt: row.created_at, tenantName: tenantNames.get(Number(row.tenant_id)) ?? "—", ownerName: ownerNames.get(Number(row.tenant_id)) ?? "—" })),
      currentTariff: tariffResult.data?.[0] ? { id: Number(tariffResult.data[0].id), minimumPricePerKwh: Number(tariffResult.data[0].minimum_price_per_kwh), maximumPricePerKwh: Number(tariffResult.data[0].maximum_price_per_kwh), effectiveFrom: tariffResult.data[0].effective_from, notificationRequested: tariffResult.data[0].notification_requested, notes: tariffResult.data[0].notes, createdByUserId: tariffResult.data[0].created_by_user_id ? Number(tariffResult.data[0].created_by_user_id) : null, createdAt: tariffResult.data[0].created_at } : null,
    };
  }),
  listTariffPolicies: platformAdminProcedure.query(async () => {
    const admin = supabaseAdmin();
    const policiesResult = await admin.from("platform_tariff_policies").select("id,minimum_price_per_kwh,maximum_price_per_kwh,effective_from,notification_requested,notes,created_by_user_id,created_at").order("effective_from", { ascending: false });
    if (policiesResult.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل سياسات التسعير من Supabase." });
    const userIds = Array.from(new Set((policiesResult.data ?? []).map((row) => Number(row.created_by_user_id)).filter(Boolean)));
    const usersResult = await admin.from("users").select("id,name").in("id", userIds);
    if (usersResult.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل منشئي سياسات التسعير." });
    const names = new Map((usersResult.data ?? []).map((row) => [Number(row.id), row.name]));
    return (policiesResult.data ?? []).map((row) => ({ id: Number(row.id), minimumPricePerKwh: String(row.minimum_price_per_kwh), maximumPricePerKwh: String(row.maximum_price_per_kwh), effectiveFrom: row.effective_from, notificationRequested: row.notification_requested, notes: row.notes, createdBy: names.get(Number(row.created_by_user_id)) ?? "—", createdByUserId: row.created_by_user_id ? Number(row.created_by_user_id) : null, createdAt: row.created_at }));
  }),
  listComplaints: platformAdminProcedure.input(z.object({ status: z.string().trim().optional() }).optional()).query(async ({ input }) => {
    const admin = supabaseAdmin();
    let query = admin.from("complaints").select("id,tenant_id,site_id,subscriber_id,title,description,priority,status,assigned_user_id,response,opened_at,resolved_at").order("opened_at", { ascending: false });
    if (input?.status) query = query.eq("status", input.status);
    const complaintsResult = await query;
    if (complaintsResult.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل الشكاوى من Supabase." });
    const complaints = complaintsResult.data ?? [];
    const tenantIds = Array.from(new Set(complaints.map((row) => Number(row.tenant_id)).filter(Boolean)));
    const siteIds = Array.from(new Set(complaints.map((row) => Number(row.site_id)).filter(Boolean)));
    const subscriberIds = Array.from(new Set(complaints.map((row) => Number(row.subscriber_id)).filter(Boolean)));
    const userIds = Array.from(new Set(complaints.map((row) => Number(row.assigned_user_id)).filter(Boolean)));
    const tenantsResult = await admin.from("tenants").select("id,name").in("id", tenantIds);
    const sitesResult = await admin.from("sites").select("id,name").in("id", siteIds);
    const subscribersResult = await admin.from("subscribers").select("id,full_name").in("id", subscriberIds);
    const usersResult = await admin.from("users").select("id,name").in("id", userIds);
    if (tenantsResult.error || sitesResult.error || subscribersResult.error || usersResult.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر إثراء الشكاوى بالمراجع المرتبطة." });
    const mapById = <T extends { id: number | string }>(rows: T[]) => new Map(rows.map((row) => [Number(row.id), row]));
    const tenants = mapById(tenantsResult.data ?? []); const sites = mapById(sitesResult.data ?? []); const subscribers = mapById(subscribersResult.data ?? []); const users = mapById(usersResult.data ?? []);
    return complaints.map((row) => ({ id: Number(row.id), tenantId: Number(row.tenant_id), siteId: Number(row.site_id), subscriberId: Number(row.subscriber_id), title: row.title, description: row.description, priority: row.priority, status: row.status, assignedUserId: row.assigned_user_id ? Number(row.assigned_user_id) : null, response: row.response, openedAt: row.opened_at, resolvedAt: row.resolved_at, tenantName: tenants.get(Number(row.tenant_id))?.name ?? "—", siteName: sites.get(Number(row.site_id))?.name ?? "—", subscriberName: subscribers.get(Number(row.subscriber_id))?.full_name ?? "—", assignedUserName: users.get(Number(row.assigned_user_id))?.name ?? "—" }));
  }),
  listSubscriptionUpgradeRequests: platformAdminProcedure.query(async () => {
    const admin = supabaseAdmin();
    const rpc = (admin as unknown as { rpc?: (name: string, args?: Record<string, unknown>) => Promise<{ data: Array<Record<string, unknown>> | null; error: unknown | null }> }).rpc;
    const rpcResult = typeof rpc === "function" ? await rpc.call(admin, "powerhub_admin_subscription_upgrade_requests") : { data: null, error: new Error("RPC unavailable") };
    if (!rpcResult.error) {
      return (rpcResult.data ?? []).map((row) => ({ id: Number(row.id), tenantId: Number(row.tenant_id), currentPlan: row.current_plan, requestedPlan: row.requested_plan, status: row.status, note: row.note, createdAt: row.created_at, reviewedAt: row.reviewed_at, tenantName: row.tenant_name ?? "—", ownerName: row.owner_name ?? "—", ownerEmail: row.owner_email ?? null }));
    }
    const requestsResult = await admin.from("subscription_upgrade_requests").select("id,tenant_id,current_plan,requested_plan,status,note,created_at,reviewed_at").order("created_at", { ascending: false }).limit(300);
    if (requestsResult.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل طلبات ترقية الاشتراكات من Supabase." });
    const requests = requestsResult.data ?? [];
    const tenantIds = Array.from(new Set(requests.map((row) => Number(row.tenant_id)).filter(Boolean)));
    const tenantsResult = await admin.from("tenants").select("id,name").in("id", tenantIds);
    const ownersResult = await admin.from("tenant_owner_profiles").select("tenant_id,full_name,email").in("tenant_id", tenantIds);
    if (tenantsResult.error || ownersResult.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر إثراء طلبات الترقية بأسماء المساحات والمالكين." });
    const tenantNames = new Map((tenantsResult.data ?? []).map((row) => [Number(row.id), row.name]));
    const owners = new Map((ownersResult.data ?? []).map((row) => [Number(row.tenant_id), row]));
    return requests.map((row) => ({ id: Number(row.id), tenantId: Number(row.tenant_id), currentPlan: row.current_plan, requestedPlan: row.requested_plan, status: row.status, note: row.note, createdAt: row.created_at, reviewedAt: row.reviewed_at, tenantName: tenantNames.get(Number(row.tenant_id)) ?? "—", ownerName: owners.get(Number(row.tenant_id))?.full_name ?? "—", ownerEmail: owners.get(Number(row.tenant_id))?.email ?? null }));
  }),
  listTenantBranchSettings: platformAdminProcedure.query(async () => {
    const admin = supabaseAdmin();
    const tenantsResult = await admin.from("tenants").select("id,name").order("name", { ascending: true });
    const ownersResult = await admin.from("tenant_owner_profiles").select("tenant_id,full_name");
    const settingsResult = await admin.from("tenant_branch_settings").select("tenant_id,is_enabled_override,max_branches_override,disabled_behavior");
    const sitesResult = await admin.from("sites").select("id,tenant_id,status").eq("status", "archived");
    if (tenantsResult.error || ownersResult.error || settingsResult.error || sitesResult.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل إعدادات الفروع من Supabase." });
    const owners = new Map((ownersResult.data ?? []).map((row) => [Number(row.tenant_id), row.full_name]));
    const settings = new Map((settingsResult.data ?? []).map((row) => [Number(row.tenant_id), row]));
    const activeCounts = new Map<number, number>(); for (const site of sitesResult.data ?? []) activeCounts.set(Number(site.tenant_id), (activeCounts.get(Number(site.tenant_id)) ?? 0) + 1);
    return (tenantsResult.data ?? []).map((tenant) => { const setting = settings.get(Number(tenant.id)); return { tenantId: Number(tenant.id), tenantName: tenant.name, ownerName: owners.get(Number(tenant.id)) ?? "—", isEnabledOverride: setting?.is_enabled_override ?? null, maxBranchesOverride: setting?.max_branches_override ?? null, disabledBehavior: setting?.disabled_behavior ?? null, currentBranchCount: activeCounts.get(Number(tenant.id)) ?? 0 }; });
  }),
  globalSearch: platformAdminProcedure.input(z.object({ query: z.string().trim().min(2).max(100) })).query(async ({ input }) => {
    const admin = supabaseAdmin(); const pattern = `%${input.query}%`;
    const generatorByName = await admin.from("generators").select("id,name,code,tenant_id").ilike("name", pattern).limit(50);
    await admin.from("generators").select("id,code,tenant_id").ilike("code", pattern).limit(50);
    const subscribersByName = await admin.from("subscribers").select("id,full_name,subscriber_no,phone,tenant_id").ilike("full_name", pattern).limit(50);
    await admin.from("subscribers").select("id,subscriber_no,tenant_id").ilike("subscriber_no", pattern).limit(50);
    await admin.from("subscribers").select("id,phone,tenant_id").ilike("phone", pattern).limit(50);
    const ownersByName = await admin.from("tenant_owner_profiles").select("id,tenant_id,full_name").ilike("full_name", pattern).limit(50);
    await admin.from("tenant_owner_profiles").select("id,tenant_id,phone").ilike("phone", pattern).limit(50);
    const tenantIds = Array.from(new Set([...(generatorByName.data ?? []).map((row) => Number(row.tenant_id)), ...(subscribersByName.data ?? []).map((row) => Number(row.tenant_id)), ...(ownersByName.data ?? []).map((row) => Number(row.tenant_id))].filter(Boolean)));
    const tenantsResult = await admin.from("tenants").select("id,name").in("id", tenantIds); if (tenantsResult.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر إثراء نتائج البحث." });
    const names = new Map((tenantsResult.data ?? []).map((row) => [Number(row.id), row.name]));
    return [...(generatorByName.data ?? []).map((row) => ({ id: Number(row.id), kind: "generator" as const, label: row.name, reference: row.code, tenantId: Number(row.tenant_id), tenantName: names.get(Number(row.tenant_id)) ?? "—" })), ...(subscribersByName.data ?? []).map((row) => ({ id: Number(row.id), kind: "subscriber" as const, label: row.full_name, reference: row.subscriber_no, tenantId: Number(row.tenant_id), tenantName: names.get(Number(row.tenant_id)) ?? "—" })), ...(ownersByName.data ?? []).map((row) => ({ id: Number(row.id), kind: "owner" as const, label: row.full_name, tenantId: Number(row.tenant_id), tenantName: names.get(Number(row.tenant_id)) ?? "—" }))];
  }),
  operationalMonitoring: platformAdminProcedure.query(async () => {
    const admin = supabaseAdmin();
    const tenantsResult = await admin.from("tenants").select("id,name").limit(500);
    const failedMessages = await admin.from("notification_messages").select("id,tenant_id,channel,event_type,last_error,created_at,status").eq("status", "failed").order("created_at", { ascending: false }).limit(100);
    await admin.from("notification_messages").select("id", { count: "exact", head: true });
    const syncResult = await admin.from("mobile_sync_events").select("id,tenant_id,status,error_code,error_message,occurred_at").in("status", ["needs_review", "failed"]).order("occurred_at", { ascending: false }).limit(100);
    const securityResult = await admin.from("platform_security_events").select("id,severity,status,title,details,created_at").in("status", ["open", "failed"]).order("created_at", { ascending: false }).limit(100);
    const tenantsForAlerts = await admin.from("tenants").select("id,name").limit(500);
    if (tenantsResult.error || failedMessages.error || syncResult.error || securityResult.error || tenantsForAlerts.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل المراقبة التشغيلية من Supabase." });
    const names = new Map((tenantsForAlerts.data ?? tenantsResult.data ?? []).map((row) => [Number(row.id), row.name]));
    const alerts = [ ...(failedMessages.data ?? []).map((row) => ({ id: `message-${row.id}`, severity: "critical", state: "critical", title: row.event_type, details: row.last_error, tenantName: names.get(Number(row.tenant_id)) ?? "—", createdAt: row.created_at })), ...(syncResult.data ?? []).map((row) => ({ id: `sync-${row.id}`, severity: "warning", state: row.status, title: "مزامنة تحتاج مراجعة", details: row.error_message ?? row.error_code, tenantName: names.get(Number(row.tenant_id)) ?? "—", createdAt: row.occurred_at })), ...(securityResult.data ?? []).map((row) => ({ id: `security-${row.id}`, severity: row.severity, state: row.status, title: row.title, details: row.details, createdAt: row.created_at })) ];
    return { health: [{ key: "database", state: "healthy", message: "Supabase متاح" }, { key: "messaging", state: failedMessages.data?.length ? "critical" : "healthy", message: failedMessages.data?.length ? "توجد رسائل فاشلة" : "لا توجد رسائل فاشلة" }], alerts };
  }),
  advancedDashboard: platformAdminProcedure.query(async () => {
    const { data, error } = await supabaseAdmin().rpc("powerhub_advanced_dashboard");
    if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل لوحة التحليلات المركزية من Supabase." });
    const dashboard = (data as Array<Record<string, unknown>> | null)?.[0];
    if (!dashboard) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "لم تُعد دالة لوحة التحليلات استجابة صالحة." });
    return { kpis: dashboard.kpis ?? {}, monthlyGrowth: dashboard.monthly_growth ?? dashboard.monthlyGrowth ?? [], consumptionByRegion: dashboard.consumption_by_region ?? dashboard.consumptionByRegion ?? [], collectionsByGenerator: dashboard.collections_by_generator ?? dashboard.collectionsByGenerator ?? [], latestGenerators: dashboard.latest_generators ?? dashboard.latestGenerators ?? [], recentComplaints: dashboard.recent_complaints ?? dashboard.recentComplaints ?? [], expiringSubscriptions: dashboard.expiring_subscriptions ?? dashboard.expiringSubscriptions ?? [] };
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
    await supabaseAdmin().from("tenant_tweetsms_accounts").select("id").eq("tenant_id", input.tenantId).limit(1);
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
  resetUserPassword: platformAdminProcedure.input(z.object({
    tenantId: z.number().int().positive(),
    targetUserId: z.number().int().positive(),
    siteId: z.number().int().positive().optional(),
  })).mutation(async ({ ctx, input }) => {
    const admin = supabaseAdmin();
    const { data: prepared, error: prepareError } = await admin.rpc("powerhub_prepare_password_reset", {
      p_actor_user_id: ctx.user.id,
      p_tenant_id: input.tenantId,
      p_target_user_id: input.targetUserId,
      p_site_id: input.siteId ?? null,
    });
    if (prepareError || !prepared?.[0]) {
      const message = prepareError?.message ?? "";
      if (message.includes("PASSWORD_RESET_IN_PROGRESS")) throw new TRPCError({ code: "CONFLICT", message: "توجد عملية إعادة تعيين قيد التنفيذ لهذا الحساب. حاول بعد قليل." });
      if (message.includes("PASSWORD_RESET_TARGET_NOT_FOUND")) throw new TRPCError({ code: "NOT_FOUND", message: "الحساب المطلوب غير موجود." });
      if (message.includes("PASSWORD_RESET_TARGET_NOT_ELIGIBLE") || message.includes("PASSWORD_RESET_TARGET_OUT_OF_SCOPE") || message.includes("PASSWORD_RESET_TARGET_SITE_OUT_OF_SCOPE")) throw new TRPCError({ code: "FORBIDDEN", message: "الحساب المطلوب غير صالح لإعادة التعيين أو خارج نطاق مساحة صاحب المولد." });
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تجهيز إعادة تعيين كلمة المرور." });
    }
    const intentId = Number(prepared[0].intent_id);
    const temporaryPassword = `PH-${crypto.randomBytes(12).toString("base64url")}`;
    const { error: authError } = await admin.auth.admin.updateUserById(String(prepared[0].target_auth_user_id), { password: temporaryPassword });
    if (authError) {
      await admin.rpc("powerhub_complete_password_reset", { p_intent_id: intentId, p_actor_user_id: ctx.user.id, p_success: false, p_failure_reason: authError.message });
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحديث كلمة مرور الحساب في Supabase Auth." });
    }
    const completion = await completePasswordResetWithRetry(intentId, ctx.user.id, true);
    if (!completion.ok) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تم تحديث كلمة المرور، لكن تعذر تأكيد عملية التدقيق بعد إعادة المحاولة. لا تُجرِ إعادة تعيين أخرى لهذا الحساب حتى يتم التحقق من العملية." });
    return { success: true as const, temporaryPassword };
  })
});
