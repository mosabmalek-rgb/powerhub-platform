import crypto from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, gte, inArray, like, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { accessInvitations, accessRecoveryRequests, auditLogs, complaints, generators, invoices, meterReadings, meters, mobileSyncEvents, notificationMessages, payments, platformAccessInvitations, platformRolePolicies, platformSecurityEvents, platformSecuritySettings, platformSettings, platformTariffPolicies, platformSmsFallbackProviders, platformTweetSmsAccounts, platformTweetSmsBalanceAlerts, sitePortalSettings, sites, staffProfiles, subscribers, subscriptionUpgradeRequests, platformSmsPlans, smsPackageRequests, tenantBranchSettings, tenantMembers, tenantMessagingConfigurations, tenantOwnerProfiles, tenantSubscriptions, tenantTweetSmsAccounts, tenants, users } from "../drizzle/schema";
import { getDb } from "./db";
import { authenticatedProcedure, router } from "./_core/trpc";
import { decryptTenantCredential, encryptTenantCredential } from "./tenant-crypto";
import { supabaseAdmin } from "./supabase-admin";
import { checkTweetSmsAccount, checkTweetSmsBalance, checkTweetSmsSender, type TweetSmsCredentials } from "./tweetsms-client";
import { processNotificationById } from "./notification-worker";
import { ownerOverviewFromSupabase, platformSnapshotFromSupabase } from "./admin-supabase";

const planSchema = z.enum(["starter", "professional", "enterprise"]);
const subscriptionStatusSchema = z.enum(["trial", "active", "overdue", "suspended", "cancelled"]);
const billingCycleSchema = z.enum(["monthly", "yearly"]);
const tweetSmsAccountInput = z.object({
  tenantId: z.number().int().positive(),
  apiEndpoint: z.string().trim().max(500).optional(),
  apiKey: z.string().trim().min(8).max(4096).optional(),
  apiSecret: z.string().trim().max(4096).optional(),
  senderName: z.string().trim().min(1).max(120),
  monthlyLimit: z.number().int().min(0).max(10_000_000),
  isActive: z.boolean(),
});

const platformTweetSmsAccountInput = z.object({
  apiEndpoint: z.string().trim().url().max(500),
  apiKey: z.string().trim().min(8).max(4096).optional(),
  apiSecret: z.string().trim().max(4096).optional(),
  senderName: z.string().trim().min(1).max(120).optional(),
  lowBalanceThreshold: z.number().int().min(0).max(10_000_000),
  isActive: z.boolean(),
});

const platformSmsFallbackProviderInput = z.object({
  id: z.number().int().positive().optional(),
  name: z.string().trim().min(2).max(160),
  providerKey: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9_-]{1,79}$/, "استخدم رمزاً لاتينياً فريداً من أحرف وأرقام وشرطات فقط."),
  apiEndpoint: z.string().trim().url().max(500).optional().or(z.literal("")),
  credentials: z.string().trim().min(8).max(4096).optional(),
  senderName: z.string().trim().max(120).optional(),
  priority: z.number().int().min(1).max(10_000),
  isActive: z.boolean(),
});

function normalizeTweetSmsEndpoint(endpoint: string) {
  let url: URL;
  try { url = new URL(endpoint.trim()); } catch { throw new TRPCError({ code: "BAD_REQUEST", message: "رابط TweetSMS غير صالح." }); }
  if (url.protocol !== "https:" || !["tweetsms.ps", "www.tweetsms.ps"].includes(url.hostname.toLowerCase()) || url.username || url.password || url.search || url.hash) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "استخدم رابط TweetSMS الرسمي عبر HTTPS فقط." });
  }
  return `${url.origin}${url.pathname.replace(/\/$/, "")}`;
}

function runtimeTweetSmsCredentials(): TweetSmsCredentials {
  const apiKey = process.env.TWEETSMS_API_KEY?.trim();
  const apiSecret = process.env.TWEETSMS_API_TOKEN?.trim();
  if (!apiKey) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "مفتاح TweetSMS غير مهيأ في المتغيرات السرية للخادم." });
  return { apiKey, ...(apiSecret ? { apiSecret } : {}) };
}

function decryptTenantTweetSmsCredentials(ciphertext: string, iv: string): TweetSmsCredentials {
  const raw = decryptTenantCredential(ciphertext, iv);
  try {
    const parsed = JSON.parse(raw) as Partial<TweetSmsCredentials>;
    if (typeof parsed.apiKey === "string" && parsed.apiKey.trim()) {
      return { apiKey: parsed.apiKey, ...(typeof parsed.apiSecret === "string" && parsed.apiSecret.trim() ? { apiSecret: parsed.apiSecret } : {}) };
    }
  } catch { /* The encrypted payload is validated below without exposing it. */ }
  throw new TRPCError({ code: "PRECONDITION_FAILED", message: "بيانات TweetSMS لهذا المولد غير صالحة؛ احفظ مفتاح API من جديد." });
}

export function platformSmsFallbackProviderSummary(provider: {
  id: number;
  name: string;
  providerKey: string;
  apiEndpoint: string | null;
  senderName: string | null;
  priority: number;
  integrationStatus: "pending_contract" | "ready";
  isActive: boolean;
  credentialCiphertext: string | null;
  credentialIv: string | null;
  lastTestedAt: Date | null;
  lastError: string | null;
  updatedAt: Date;
}) {
  return {
    id: provider.id,
    name: provider.name,
    providerKey: provider.providerKey,
    apiEndpoint: provider.apiEndpoint,
    senderName: provider.senderName,
    priority: provider.priority,
    integrationStatus: provider.integrationStatus,
    isActive: provider.isActive,
    configured: Boolean(provider.credentialCiphertext && provider.credentialIv),
    lastTestedAt: provider.lastTestedAt,
    lastError: provider.lastError,
    updatedAt: provider.updatedAt,
  };
}

const platformRoleSchema = z.enum(["platform_owner", "platform_admin", "finance_admin"]);
type PlatformRole = z.infer<typeof platformRoleSchema>;

function platformRoleOf(user: { role: "user" | "admin"; platformRole: PlatformRole | null }) {
  return user.platformRole ?? "platform_admin";
}

function isPlatformAccount(user: { role: "user" | "admin"; platformRole: PlatformRole | null }) {
  return user.role === "admin" || Boolean(user.platformRole);
}

const platformAccountOwnerMessage = "لا يمكن استخدام حساب يملك صلاحيات إدارة المنصة كصاحب مولد. استخدم بريداً مختلفاً وفريداً لصاحب المولد.";

function requirePlatformRoles(allowedRoles: PlatformRole[]) {
  return authenticatedProcedure.use(({ ctx, next }) => {
    if (ctx.user.role !== "admin") {
      throw new TRPCError({ code: "FORBIDDEN", message: "هذه المساحة مخصصة لإدارة منصة PowerHub." });
    }
    const platformRole = platformRoleOf(ctx.user);
    if (!allowedRoles.includes(platformRole)) {
      throw new TRPCError({ code: "FORBIDDEN", message: "دور المنصة الحالي لا يملك هذه الصلاحية." });
    }
    return next({ ctx });
  });
}

const platformAdminProcedure = requirePlatformRoles(["platform_owner", "platform_admin"]);
const platformOwnerProcedure = requirePlatformRoles(["platform_owner"]);
const platformFinanceProcedure = requirePlatformRoles(["platform_owner", "platform_admin", "finance_admin"]);

export function addSubscriptionPeriod(from: Date, cycle: "monthly" | "yearly", units = 1) {
  const result = new Date(from);
  if (cycle === "yearly") result.setFullYear(result.getFullYear() + units);
  else result.setMonth(result.getMonth() + units);
  return result;
}

export function tenantStatusForSubscription(status: "trial" | "active" | "overdue" | "suspended" | "cancelled") {
  return status === "suspended" || status === "cancelled" ? "suspended" as const : "active" as const;
}

function insertId(result: unknown) {
  const header = Array.isArray(result) ? result[0] : result;
  const value = (header as { insertId?: number | bigint })?.insertId;
  if (value === undefined) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر إنشاء السجل." });
  return Number(value);
}

async function dbOrThrow() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة حالياً." });
  return db;
}

function assertLegacyAdminWriteMigrationGuard(operation: string): void {
  if (process.env.NODE_ENV !== "powerhub_admin_writes_reenabled_after_atomic_supabase_migration") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `${operation} متوقف مؤقتاً لأن تنفيذه ما زال يعتمد على MySQL. لا يُجرى أي تعديل حتى يُنقل إلى RPC Supabase ذرية مع تدقيق مناسب.`,
    });
  }
}

function containsSearchPattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, "\\$&")}%`;
}

async function recordPlatformSecurityChange(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, actor: typeof users.$inferSelect, targetUserId: number | undefined, title: string, metadata: Record<string, unknown>) {
  await db.insert(platformSecurityEvents).values({
    eventType: "security_change",
    severity: "info",
    status: "success",
    title,
    metadata: { ...metadata, actorPlatformRole: platformRoleOf(actor) },
    relatedUserId: targetUserId,
    createdByUserId: actor.id,
  });
}

async function ownerOverview(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, tenantId?: number) {
  const tenantWhere = tenantId ? eq(tenants.id, tenantId) : undefined;
  const rows = await db.select({ tenant: tenants, owner: tenantOwnerProfiles, subscription: tenantSubscriptions, ownerAccount: { id: users.id, name: users.name, email: users.email, lastSignedIn: users.lastSignedIn } })
    .from(tenants)
    .leftJoin(tenantOwnerProfiles, eq(tenantOwnerProfiles.tenantId, tenants.id))
    .leftJoin(users, eq(tenantOwnerProfiles.ownerUserId, users.id))
    .leftJoin(tenantSubscriptions, eq(tenantSubscriptions.tenantId, tenants.id))
    .where(tenantWhere)
    .orderBy(desc(tenants.createdAt));
  const ids = rows.map((row) => row.tenant.id);
  if (!ids.length) return [];
  const counts = await db.select({
    tenantId: subscribers.tenantId,
    total: sql<number>`count(*)`,
    residential: sql<number>`sum(case when ${subscribers.subscriptionType} = 'residential' then 1 else 0 end)`,
    commercial: sql<number>`sum(case when ${subscribers.subscriptionType} = 'commercial' then 1 else 0 end)`,
  }).from(subscribers).where(inArray(subscribers.tenantId, ids)).groupBy(subscribers.tenantId);
  const countByTenant = new Map(counts.map((count) => [count.tenantId, count]));
  return rows.map((row) => {
    const count = countByTenant.get(row.tenant.id);
    return {
      tenant: row.tenant,
      owner: row.owner,
      ownerAccount: row.ownerAccount,
      subscription: row.subscription,
      subscribers: {
        total: Number(count?.total ?? 0),
        residential: Number(count?.residential ?? 0),
        commercial: Number(count?.commercial ?? 0),
      },
    };
  });
}

export const adminRouter = router({
  createGeneratorOwnerSubscription: platformAdminProcedure.input(z.object({
    companyName: z.string().min(2).max(180),
    ownerName: z.string().min(2).max(180),
    identityNumber: z.string().min(4).max(50),
    ownerPhone: z.string().min(5).max(30),
    ownerWhatsapp: z.preprocess((value) => typeof value === "string" && !value.trim() ? undefined : value, z.string().min(5).max(30).optional()),
    ownerEmail: z.string().email(),
    temporaryPassword: z.string().min(8).max(128),
    plan: planSchema.default("starter"),
    trialDurationDays: z.number().int().min(1).max(3650).default(8),
  })).mutation(async ({ ctx, input }) => {
    const email = input.ownerEmail.trim().toLowerCase();
    const phone = input.ownerPhone.trim();
    const identity = encryptTenantCredential(input.identityNumber.trim());
    const slug = `owner-${crypto.randomUUID().replaceAll("-", "")}`;
    const siteCode = `SITE-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
    const admin = supabaseAdmin();
    const { data: authData, error: authError } = await admin.auth.admin.createUser({
      email,
      password: input.temporaryPassword,
      email_confirm: true,
      user_metadata: { name: input.ownerName.trim(), must_change_password: true },
    });
    if (authError || !authData.user) {
      throw new TRPCError({ code: authError?.status === 422 ? "CONFLICT" : "BAD_REQUEST", message: authError?.message || "تعذر إنشاء حساب صاحب المولد في Supabase Auth." });
    }
    try {
      const { data, error } = await admin.rpc("powerhub_create_generator_owner_subscription", {
        p_actor_user_id: ctx.user.id,
        p_auth_user_id: authData.user.id,
        p_tenant_name: input.companyName.trim(),
        p_slug: slug,
        p_company_name: input.companyName.trim(),
        p_owner_name: input.ownerName.trim(),
        p_identity_ciphertext: identity.ciphertext,
        p_identity_iv: identity.iv,
        p_identity_last4: input.identityNumber.trim().slice(-4),
        p_owner_phone: phone,
        p_owner_whatsapp: input.ownerWhatsapp ? input.ownerWhatsapp.trim() : null,
        p_owner_email: email,
        p_site_name: "الفرع الرئيسي",
        p_site_code: siteCode,
        p_plan: input.plan,
        p_billing_cycle: "monthly",
        p_subscription_status: "trial",
        p_trial_duration_days: input.trialDurationDays,
      });
      if (error || !data?.[0]) throw error ?? new Error("لم تُرجع معاملة Supabase نتيجة إنشاء الاشتراك.");
      return data[0];
    } catch (error) {
      const { error: cleanupError } = await admin.auth.admin.deleteUser(authData.user.id);
      if (cleanupError) console.error("[OwnerProvisioning] Auth compensation failed", { authUserId: authData.user.id, message: cleanupError.message });
      const message = error instanceof Error ? error.message : "تعذر إكمال إنشاء اشتراك صاحب المولد.";
      throw new TRPCError({ code: message.includes("مستخدم بالفعل") || message.includes("duplicate") ? "CONFLICT" : "INTERNAL_SERVER_ERROR", message });
    }
  }),
  createGeneratorOwnerWithTemporaryPassword: platformAdminProcedure.input(z.object({
    tenantName: z.string().min(2).max(160),
    slug: z.string().min(3).max(80).regex(/^[a-z0-9-]+$/),
    ownerName: z.string().min(2).max(180),
    ownerPhone: z.string().min(5).max(30),
    ownerWhatsapp: z.string().min(5).max(30),
    ownerEmail: z.string().email(),
    identityNumber: z.string().min(4).max(50),
    generatorName: z.string().min(2).max(160),
    generatorCode: z.string().min(2).max(50).transform((value) => value.toUpperCase()),
    generatorCapacityKw: z.number().positive().max(100000),
    generatorFuelType: z.enum(["diesel", "gasoline", "gas", "other"]).default("diesel"),
    companyName: z.string().max(180).optional(),
    temporaryPassword: z.string().min(8).max(128),
    siteName: z.string().min(2).max(160),
    siteCode: z.string().min(2).max(50).transform((value) => value.toUpperCase()),
    city: z.string().max(100).optional(),
    plan: planSchema.default("starter"),
    subscriptionStatus: subscriptionStatusSchema.default("trial"),
    billingCycle: billingCycleSchema.default("monthly"),
    endsAt: z.date().optional(),
    autoRenew: z.boolean().default(false),
    notes: z.string().max(2000).optional(),
  })).mutation(async ({ ctx, input }) => {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "إنشاء صاحب المولد مع مولده متوقف انتقالياً أثناء ترحيل دورة Supabase Auth والمعاملة الذرية. لا يتم إنشاء أي حساب أو مساحة حالياً.",
    });
  }),
  overview: platformAdminProcedure.input(z.object({ tenantId: z.number().int().positive().optional() }).optional()).query(async ({ input }) => {
    const owners = await ownerOverviewFromSupabase(input?.tenantId);
    const totals = owners.reduce((acc, item) => ({
      generatorOwners: acc.generatorOwners + 1,
      residential: acc.residential + item.subscribers.residential,
      commercial: acc.commercial + item.subscribers.commercial,
      subscribers: acc.subscribers + item.subscribers.total,
      activeSubscriptions: acc.activeSubscriptions + (item.subscription?.status === "active" || item.subscription?.status === "trial" ? 1 : 0),
    }), { generatorOwners: 0, residential: 0, commercial: 0, subscribers: 0, activeSubscriptions: 0 });
    return { totals, owners };
  }),

  listOwners: platformAdminProcedure.query(async () => ownerOverviewFromSupabase()),

  listTweetSmsAccounts: platformAdminProcedure.query(async () => {
    {
      const admin = supabaseAdmin();
      const monthStart = new Date();
      monthStart.setUTCDate(1);
      monthStart.setUTCHours(0, 0, 0, 0);
      const [ownersResult, accountsResult, usageResult, tenantsResult] = await Promise.all([
        admin.from("tenant_owner_profiles").select("tenant_id, full_name, phone").order("tenant_id", { ascending: true }),
        admin.from("tenant_tweetsms_accounts").select("id, tenant_id, api_endpoint, credential_ciphertext, credential_iv, sender_name, monthly_limit, is_active, last_tested_at, last_error, updated_at"),
        admin.from("notification_messages").select("tenant_id, status, segment_count").eq("channel", "sms").gte("created_at", monthStart.toISOString()).in("status", ["processing", "submitted", "delivered", "read"]),
        admin.from("tenants").select("id, name"),
      ]);
      if (ownersResult.error || accountsResult.error || usageResult.error || tenantsResult.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل حسابات TweetSMS من Supabase." });
      const accountByTenant = new Map((accountsResult.data ?? []).map((account) => [Number(account.tenant_id), account]));
      const usageByTenant = new Map<number, number>();
      for (const usage of usageResult.data ?? []) usageByTenant.set(Number(usage.tenant_id), (usageByTenant.get(Number(usage.tenant_id)) ?? 0) + Math.max(1, Number(usage.segment_count ?? 1)));
      const tenantNames = new Map((tenantsResult.data ?? []).map((tenant) => [Number(tenant.id), tenant.name]));
      return (ownersResult.data ?? []).map((owner) => {
        const tenantId = Number(owner.tenant_id);
        const account = accountByTenant.get(tenantId);
        const monthlyLimit = account?.monthly_limit ?? 0;
        const usedThisMonth = usageByTenant.get(tenantId) ?? 0;
        return { id: account ? Number(account.id) : null, tenantId, tenantName: tenantNames.get(tenantId) ?? "—", ownerName: owner.full_name, ownerPhone: owner.phone, apiEndpoint: account?.api_endpoint ?? null, senderName: account?.sender_name ?? null, monthlyLimit, usedThisMonth, remaining: Math.max(0, monthlyLimit - usedThisMonth), isActive: account?.is_active ?? false, configured: Boolean(account?.credential_ciphertext && account?.credential_iv), lastTestedAt: account?.last_tested_at ?? null, lastError: account?.last_error ?? null, updatedAt: account?.updated_at ?? null };
      });
    }
  }),

  getPlatformTweetSmsAccount: platformAdminProcedure.query(async () => {
    const { data: account, error } = await supabaseAdmin().from("platform_tweetsms_accounts")
      .select("id, api_endpoint, sender_name, low_balance_threshold, last_provider_balance, last_balance_checked_at, last_tested_at, last_error, is_active, credential_ciphertext, credential_iv")
      .order("updated_at", { ascending: false }).limit(1).maybeSingle();
    if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل إعدادات مزود الرسائل المركزي من Supabase." });
    if (!account) return null;
    return {
      id: Number(account.id), apiEndpoint: account.api_endpoint, senderName: account.sender_name, lowBalanceThreshold: Number(account.low_balance_threshold),
      lastProviderBalance: account.last_provider_balance, lastBalanceCheckedAt: account.last_balance_checked_at ? new Date(account.last_balance_checked_at) : null,
      lastTestedAt: account.last_tested_at ? new Date(account.last_tested_at) : null, lastError: account.last_error, isActive: account.is_active,
      configured: Boolean(process.env.TWEETSMS_API_KEY?.trim()),
    };
  }),

  listPlatformSmsFallbackProviders: platformAdminProcedure.query(async () => {
    const { data, error } = await supabaseAdmin().from("platform_sms_fallback_providers")
      .select("id, name, provider_key, api_endpoint, sender_name, priority, integration_status, is_active, credential_ciphertext, credential_iv, last_tested_at, last_error, updated_at")
      .order("priority", { ascending: true }).order("updated_at", { ascending: false });
    if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل مزودي الرسائل الاحتياطيين من Supabase." });
    return (data ?? []).map((provider) => ({
      id: Number(provider.id), name: provider.name, providerKey: provider.provider_key, apiEndpoint: provider.api_endpoint, senderName: provider.sender_name,
      priority: Number(provider.priority), integrationStatus: provider.integration_status as "pending_contract" | "ready", isActive: provider.is_active,
      configured: Boolean(provider.credential_ciphertext && provider.credential_iv), lastTestedAt: provider.last_tested_at ? new Date(provider.last_tested_at) : null,
      lastError: provider.last_error, updatedAt: new Date(provider.updated_at),
    }));
  }),

  savePlatformSmsFallbackProvider: platformAdminProcedure.input(platformSmsFallbackProviderInput).mutation(async ({ ctx, input }) => {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "حفظ إعدادات مزودات الرسائل متوقف أثناء الترحيل إلى تصميم Supabase/Vercel مشفر ومعتمد." });
  }),

  savePlatformTweetSmsAccount: platformAdminProcedure.input(platformTweetSmsAccountInput).mutation(async ({ ctx, input }) => {
    const admin = supabaseAdmin();
    const endpoint = normalizeTweetSmsEndpoint(input.apiEndpoint);
    if (input.apiKey || input.apiSecret) throw new TRPCError({ code: "BAD_REQUEST", message: "تُدار بيانات اعتماد TweetSMS عبر المتغيرات السرية للخادم ولا تحفظ من النموذج." });
    runtimeTweetSmsCredentials();
    const { data, error } = await admin.rpc("powerhub_save_platform_tweetsms_account", {
      p_user_id: ctx.user.id, p_api_endpoint: endpoint, p_credential_ciphertext: null, p_credential_iv: null,
      p_sender_name: input.senderName?.trim() || null, p_low_balance_threshold: input.lowBalanceThreshold, p_is_active: input.isActive,
    });
    if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر حفظ إعداد TweetSMS المركزي بصورة آمنة." });
    const row = (data as Array<Record<string, unknown>> | null)?.[0];
    if (!row) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "لم تعد عملية حفظ TweetSMS نتيجة صالحة." });
    return { id: Number(row.account_id), isActive: Boolean(row.is_active), activationRequired: Boolean(row.activation_required) };
  }),

  testPlatformTweetSmsAccount: platformAdminProcedure.mutation(async ({ ctx }) => {
    const admin = supabaseAdmin();
    const { data: account, error: accountError } = await admin.from("platform_tweetsms_accounts")
      .select("api_endpoint, credential_ciphertext, credential_iv, sender_name").order("updated_at", { ascending: false }).limit(1).maybeSingle();
    if (accountError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر قراءة إعداد TweetSMS للفحص." });
    if (!account?.api_endpoint) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "احفظ رابط TweetSMS المركزي قبل فحص الاتصال." });
    let result: { ok: boolean; message: string; balance?: number };
    try {
      const credentials = runtimeTweetSmsCredentials();
      const endpoint = normalizeTweetSmsEndpoint(account.api_endpoint);
      const login = await checkTweetSmsAccount({ endpoint, credentials });
      const sender = login.ok && account.sender_name ? await checkTweetSmsSender({ endpoint, credentials, sender: account.sender_name }) : null;
      const balance = login.ok && (!sender || sender.ok) ? await checkTweetSmsBalance({ endpoint, credentials }) : null;
      result = !login.ok ? login : sender && !sender.ok ? sender : balance && !balance.ok ? balance : balance ?? login;
    } catch (cause) {
      result = { ok: false, message: cause instanceof Error ? cause.message : "تعذر فحص اتصال TweetSMS." };
    }
    const { data, error } = await admin.rpc("powerhub_record_platform_tweetsms_test", {
      p_user_id: ctx.user.id, p_success: result.ok, p_balance: Number.isFinite(result.balance) ? Math.max(0, Math.round(result.balance!)) : null,
      p_error: result.ok ? null : result.message,
    });
    if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تسجيل نتيجة فحص TweetSMS." });
    const row = (data as Array<Record<string, unknown>> | null)?.[0];
    return { ok: result.ok, message: result.message, balance: result.balance ?? null, accountActive: Boolean(row?.is_active) };
  }),

  platformTweetSmsReport: platformAdminProcedure.input(z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() }).optional()).query(async ({ input }) => {
    const { data, error } = await supabaseAdmin().rpc("powerhub_tweetsms_report", { p_from: input?.from?.toISOString() ?? null, p_to: input?.to?.toISOString() ?? null });
    if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل تقرير TweetSMS المركزي من Supabase." });
    const report = (data as Array<{ account?: unknown; total?: string | number | null; usage_rows?: unknown; alerts?: unknown }> | null)?.[0];
    if (!report) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "لم تُعد دالة تقرير TweetSMS استجابة صالحة." });
    const rawAccount = report.account && typeof report.account === "object" ? report.account as Record<string, unknown> : null;
    const usageRows = Array.isArray(report.usage_rows) ? report.usage_rows : [];
    const alerts = Array.isArray(report.alerts) ? report.alerts : [];
    return {
      account: rawAccount ? { id: Number(rawAccount.id), isActive: Boolean(rawAccount.isActive), senderName: typeof rawAccount.senderName === "string" ? rawAccount.senderName : null, lowBalanceThreshold: Number(rawAccount.lowBalanceThreshold ?? 0), lastProviderBalance: rawAccount.lastProviderBalance === null ? null : Number(rawAccount.lastProviderBalance ?? 0), lastBalanceCheckedAt: rawAccount.lastBalanceCheckedAt ? new Date(String(rawAccount.lastBalanceCheckedAt)) : null, lastError: typeof rawAccount.lastError === "string" ? rawAccount.lastError : null, configured: Boolean(rawAccount.configured) } : null,
      total: Number(report.total ?? 0),
      usageRows: usageRows.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const row = item as Record<string, unknown>;
        return typeof row.tenantName === "string" ? [{ tenantId: Number(row.tenantId), tenantName: row.tenantName, total: Number(row.total ?? 0), submitted: Number(row.submitted ?? 0), failed: Number(row.failed ?? 0) }] : [];
      }),
      alerts: alerts.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const alert = item as Record<string, unknown>;
        return typeof alert.status === "string" ? [{ id: Number(alert.id), balance: Number(alert.balance ?? 0), threshold: Number(alert.threshold ?? 0), status: alert.status, notifiedAt: new Date(String(alert.notifiedAt)), resolvedAt: alert.resolvedAt ? new Date(String(alert.resolvedAt)) : null, createdAt: new Date(String(alert.createdAt)), updatedAt: new Date(String(alert.updatedAt)) }] : [];
      }),
    };
  }),

  saveTweetSmsAccount: platformAdminProcedure.input(tweetSmsAccountInput).mutation(async ({ ctx, input }) => {
    const admin = supabaseAdmin();
    const { data: existing, error: existingError } = await admin.from("tenant_tweetsms_accounts")
      .select("api_endpoint, credential_ciphertext, credential_iv").eq("tenant_id", input.tenantId).maybeSingle();
    if (existingError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر قراءة إعداد TweetSMS لهذا المولد." });
    if (input.apiSecret && !input.apiKey) throw new TRPCError({ code: "BAD_REQUEST", message: "أدخل مفتاح API مع الرمز الإضافي عند تغيير بيانات الاعتماد." });
    const endpointValue = input.apiEndpoint?.trim() || existing?.api_endpoint;
    if (!endpointValue) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "أدخل رابط TweetSMS الرسمي لهذا المولد." });
    if (!input.apiKey && (!existing?.credential_ciphertext || !existing.credential_iv)) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "أدخل مفتاح API الخاص بهذا المولد قبل حفظ الحساب." });
    }
    const encrypted = input.apiKey ? encryptTenantCredential(JSON.stringify({ apiKey: input.apiKey, ...(input.apiSecret ? { apiSecret: input.apiSecret } : {}) })) : null;
    const { data, error } = await admin.rpc("powerhub_save_tenant_tweetsms_account", {
      p_user_id: ctx.user.id, p_tenant_id: input.tenantId, p_api_endpoint: normalizeTweetSmsEndpoint(endpointValue),
      p_credential_ciphertext: encrypted?.ciphertext ?? null, p_credential_iv: encrypted?.iv ?? null,
      p_sender_name: input.senderName.trim(), p_monthly_limit: input.monthlyLimit, p_is_active: input.isActive,
    });
    if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر حفظ حساب TweetSMS لهذا المولد بصورة آمنة." });
    const row = (data as Array<Record<string, unknown>> | null)?.[0];
    if (!row) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "لم تعد عملية حفظ TweetSMS نتيجة صالحة." });
    return { id: Number(row.account_id), tenantId: Number(row.tenant_id), isActive: Boolean(row.is_active), activationRequired: Boolean(row.activation_required) };
  }),

  testTweetSmsAccount: platformAdminProcedure.input(z.object({ tenantId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    const admin = supabaseAdmin();
    const { data: account, error: accountError } = await admin.from("tenant_tweetsms_accounts")
      .select("tenant_id, api_endpoint, credential_ciphertext, credential_iv, sender_name, updated_at").eq("tenant_id", input.tenantId).maybeSingle();
    if (accountError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر قراءة إعداد TweetSMS لهذا المولد." });
    if (!account?.api_endpoint || !account.credential_ciphertext || !account.credential_iv || !account.sender_name || !account.updated_at) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "احفظ مفتاح TweetSMS واسم المرسل لهذا المولد قبل فحص الجاهزية." });
    }
    let result: { ok: boolean; message: string; balance?: number };
    try {
      const endpoint = normalizeTweetSmsEndpoint(account.api_endpoint);
      const credentials = decryptTenantTweetSmsCredentials(account.credential_ciphertext, account.credential_iv);
      const login = await checkTweetSmsAccount({ endpoint, credentials });
      const sender = login.ok ? await checkTweetSmsSender({ endpoint, credentials, sender: account.sender_name }) : null;
      const balance = login.ok && (!sender || sender.ok) ? await checkTweetSmsBalance({ endpoint, credentials }) : null;
      result = !login.ok ? login : sender && !sender.ok ? sender : balance && !balance.ok ? balance : balance ?? login;
    } catch (cause) {
      result = { ok: false, message: cause instanceof Error ? cause.message : "تعذر فحص TweetSMS لهذا المولد." };
    }
    const { data, error } = await admin.rpc("powerhub_record_tenant_tweetsms_test", {
      p_user_id: ctx.user.id, p_tenant_id: input.tenantId, p_expected_updated_at: account.updated_at,
      p_success: result.ok, p_balance: Number.isFinite(result.balance) ? Math.max(0, Math.round(result.balance!)) : null,
      p_error: result.ok ? null : result.message,
    });
    if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تسجيل نتيجة فحص TweetSMS لهذا المولد." });
    const row = (data as Array<Record<string, unknown>> | null)?.[0];
    return { ok: result.ok, message: result.message, balance: result.balance ?? null, accountActive: Boolean(row?.is_active) };
  }),

  listSubscriptionUpgradeRequests: platformAdminProcedure.query(async () => {
    const { data: requests, error } = await supabaseAdmin().from("subscription_upgrade_requests")
      .select("id, tenant_id, current_plan, requested_plan, status, note, created_at, reviewed_at").order("created_at", { ascending: false }).limit(300);
    if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل طلبات ترقية الباقات من Supabase." });
    const tenantIds = Array.from(new Set((requests ?? []).map((request) => Number(request.tenant_id))));
    const [tenantResult, profileResult] = await Promise.all([
      tenantIds.length ? supabaseAdmin().from("tenants").select("id, name").in("id", tenantIds) : Promise.resolve({ data: [], error: null }),
      tenantIds.length ? supabaseAdmin().from("tenant_owner_profiles").select("tenant_id, full_name, email").in("tenant_id", tenantIds) : Promise.resolve({ data: [], error: null }),
    ]);
    if (tenantResult.error || profileResult.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل أصحاب طلبات الترقية من Supabase." });
    const tenantById = new Map((tenantResult.data ?? []).map((tenant) => [Number(tenant.id), tenant.name]));
    const profileByTenantId = new Map((profileResult.data ?? []).map((profile) => [Number(profile.tenant_id), profile]));
    return (requests ?? []).map((request) => ({
      id: Number(request.id), tenantId: Number(request.tenant_id), tenantName: tenantById.get(Number(request.tenant_id)) ?? "مساحة غير معروفة",
      ownerName: profileByTenantId.get(Number(request.tenant_id))?.full_name ?? null, ownerEmail: profileByTenantId.get(Number(request.tenant_id))?.email ?? null,
      currentPlan: request.current_plan, requestedPlan: request.requested_plan, status: request.status, note: request.note,
      createdAt: new Date(request.created_at), reviewedAt: request.reviewed_at ? new Date(request.reviewed_at) : null,
    }));
  }),

  reviewSubscriptionUpgradeRequest: platformAdminProcedure.input(z.object({ id: z.number().int().positive(), decision: z.enum(["approved", "rejected"]), note: z.string().trim().max(1000).optional() })).mutation(async ({ ctx, input }) => {
    assertLegacyAdminWriteMigrationGuard("مراجعة طلب ترقية الباقة");
    const db = await dbOrThrow();
    const [request] = await db.select().from(subscriptionUpgradeRequests).where(eq(subscriptionUpgradeRequests.id, input.id)).limit(1);
    if (!request) throw new TRPCError({ code: "NOT_FOUND", message: "طلب الترقية غير موجود." });
    if (request.status !== "pending" && request.status !== "reviewing") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "تمت معالجة هذا الطلب مسبقاً." });
    const [site] = await db.select({ id: sites.id }).from(sites).where(eq(sites.tenantId, request.tenantId)).limit(1);
    await db.transaction(async (tx) => {
      await tx.update(subscriptionUpgradeRequests).set({ status: input.decision, note: input.note ?? null, reviewedByUserId: ctx.user.id, reviewedAt: new Date() }).where(eq(subscriptionUpgradeRequests.id, request.id));
      if (input.decision === "approved") {
        await tx.update(tenants).set({ plan: request.requestedPlan }).where(eq(tenants.id, request.tenantId));
        await tx.update(tenantSubscriptions).set({ plan: request.requestedPlan }).where(eq(tenantSubscriptions.tenantId, request.tenantId));
      }
    });
    await db.insert(auditLogs).values({ tenantId: request.tenantId, siteId: site?.id ?? null, userId: ctx.user.id, entityType: "subscription_upgrade_request", entityId: String(request.id), action: `platform_admin_${input.decision}_subscription_upgrade`, afterData: { requestedPlan: request.requestedPlan, decision: input.decision, note: input.note ?? null }, actorPlatformRole: platformRoleOf(ctx.user) });
    return { success: true, plan: input.decision === "approved" ? request.requestedPlan : request.currentPlan };
  }),

  quickUpgradeOwnerPlan: platformAdminProcedure.input(z.object({ tenantId: z.number().int().positive(), plan: planSchema, note: z.string().trim().max(1000).optional() })).mutation(async ({ ctx, input }) => {
    assertLegacyAdminWriteMigrationGuard("الترقية السريعة لباقة صاحب المولد");
    const db = await dbOrThrow(); const [tenant] = await db.select({ id: tenants.id, plan: tenants.plan }).from(tenants).where(eq(tenants.id, input.tenantId)).limit(1);
    if (!tenant) throw new TRPCError({ code: "NOT_FOUND", message: "صاحب المولد غير موجود." });
    const rank: Record<string, number> = { starter: 1, professional: 2, enterprise: 3 };
    if (rank[input.plan] <= (rank[tenant.plan] ?? 0)) throw new TRPCError({ code: "BAD_REQUEST", message: "اختر باقة أعلى من الباقة الحالية." });
    const [site] = await db.select({ id: sites.id }).from(sites).where(eq(sites.tenantId, input.tenantId)).limit(1);
    await db.transaction(async (tx) => { await tx.update(tenants).set({ plan: input.plan }).where(eq(tenants.id, input.tenantId)); await tx.update(tenantSubscriptions).set({ plan: input.plan }).where(eq(tenantSubscriptions.tenantId, input.tenantId)); });
    await db.insert(auditLogs).values({ tenantId: input.tenantId, siteId: site?.id ?? null, userId: ctx.user.id, entityType: "tenant_subscription", entityId: String(input.tenantId), action: "platform_admin_quick_upgrade_owner_plan", afterData: { fromPlan: tenant.plan, toPlan: input.plan, note: input.note ?? null }, actorPlatformRole: platformRoleOf(ctx.user) });
    return { success: true, plan: input.plan };
  }),

  sendOwnerUsageAlert: platformAdminProcedure.input(z.object({ tenantId: z.number().int().positive(), message: z.string().trim().min(5).max(1200), usagePercent: z.number().int().min(80).max(100) })).mutation(async ({ ctx, input }) => {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "إرسال تنبيهات المالك متوقف أثناء ترحيل الإرسال الخارجي إلى خدمة Supabase/Vercel مستقلة." });
  }),

  platformSnapshot: platformAdminProcedure.query(async () => {
    return platformSnapshotFromSupabase();
  }),

  userDirectory: platformAdminProcedure.query(async () => {
    const { data, error } = await supabaseAdmin().from("users")
      .select("id, name, email, role, platform_role, account_status, last_signed_in")
      .order("last_signed_in", { ascending: false }).limit(200);
    if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل دليل المستخدمين من Supabase." });
    return (data ?? []).map((user) => ({
      id: Number(user.id), name: user.name, email: user.email, role: user.role,
      platformRole: user.platform_role, accountStatus: user.account_status, lastSignedIn: user.last_signed_in,
    }));
  }),

  platformAccessDirectory: platformOwnerProcedure.query(async () => {
    const [accountsResult, invitationsResult] = await Promise.all([
      supabaseAdmin().from("users").select("id, name, email, platform_role, account_status, last_signed_in").eq("role", "admin").order("last_signed_in", { ascending: false }).limit(100),
      supabaseAdmin().from("platform_access_invitations").select("id, email, platform_role, status, expires_at, accepted_at, invited_by_user_id").order("created_at", { ascending: false }).limit(100),
    ]);
    if (accountsResult.error || invitationsResult.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل دليل وصول آدمن المنصة من Supabase." });
    return {
      accounts: (accountsResult.data ?? []).map((account) => ({
        id: Number(account.id), name: account.name, email: account.email,
        platformRole: account.platform_role as "platform_owner" | "platform_admin" | "finance_admin" | null,
        accountStatus: account.account_status as "active" | "locked" | "disabled", lastSignedIn: account.last_signed_in ? new Date(account.last_signed_in) : null,
      })),
      invitations: (invitationsResult.data ?? []).map((invitation) => ({
        id: Number(invitation.id), email: invitation.email,
        platformRole: invitation.platform_role as "platform_owner" | "platform_admin" | "finance_admin",
        status: invitation.status as "invited" | "accepted" | "revoked" | "expired",
        expiresAt: new Date(invitation.expires_at), acceptedAt: invitation.accepted_at ? new Date(invitation.accepted_at) : null,
        invitedByUserId: Number(invitation.invited_by_user_id),
      })),
    };
  }),

  invitePlatformAccess: platformOwnerProcedure.input(z.object({
    email: z.string().email().transform((email) => email.trim().toLowerCase()),
    platformRole: z.enum(["platform_admin", "finance_admin"]),
    expiresInHours: z.number().int().min(1).max(168).default(72),
  })).mutation(async ({ ctx, input }) => {
    assertLegacyAdminWriteMigrationGuard("دعوة وصول لإدارة المنصة");
    const db = await dbOrThrow();
    const expiresAt = new Date(Date.now() + input.expiresInHours * 60 * 60 * 1000);
    const tokenHash = crypto.createHash("sha256").update(crypto.randomBytes(32)).digest("hex");
    const id = insertId(await db.insert(platformAccessInvitations).values({ email: input.email, platformRole: input.platformRole, tokenHash, invitedByUserId: ctx.user.id, expiresAt }));
    await recordPlatformSecurityChange(db, ctx.user, undefined, "دعوة دور منصة", { invitationId: id, email: input.email, platformRole: input.platformRole, expiresAt });
    return { id, email: input.email, platformRole: input.platformRole, expiresAt, status: "invited" as const };
  }),

  setPlatformAccountStatus: platformOwnerProcedure.input(z.object({ userId: z.number().int().positive(), accountStatus: z.enum(["active", "locked", "disabled"]) })).mutation(async ({ ctx, input }) => {
    assertLegacyAdminWriteMigrationGuard("تغيير حالة حساب إدارة المنصة");
    if (input.userId === ctx.user.id) throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن تغيير حالة حسابك من هذه العملية." });
    const db = await dbOrThrow();
    const [target] = await db.select({ id: users.id, role: users.role, platformRole: users.platformRole, accountStatus: users.accountStatus }).from(users).where(eq(users.id, input.userId)).limit(1);
    if (!target?.id || target.role !== "admin") throw new TRPCError({ code: "NOT_FOUND", message: "حساب إدارة المنصة غير موجود." });
    if (target.platformRole === "platform_owner") throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكن تغيير حالة مالك المنصة من هذا المسار." });
    await db.update(users).set({ accountStatus: input.accountStatus }).where(eq(users.id, input.userId));
    await recordPlatformSecurityChange(db, ctx.user, input.userId, "تغيير حالة حساب منصة", { before: target.accountStatus, after: input.accountStatus });
    return { success: true };
  }),

  setPlatformAccessRole: platformOwnerProcedure.input(z.object({ userId: z.number().int().positive(), platformRole: z.enum(["platform_admin", "finance_admin"]) })).mutation(async ({ ctx, input }) => {
    assertLegacyAdminWriteMigrationGuard("تغيير دور حساب إدارة المنصة");
    if (input.userId === ctx.user.id) throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن تغيير دور حسابك من هذه العملية." });
    const db = await dbOrThrow();
    const [target] = await db.select({ id: users.id, role: users.role, platformRole: users.platformRole }).from(users).where(eq(users.id, input.userId)).limit(1);
    if (!target?.id || target.role !== "admin") throw new TRPCError({ code: "NOT_FOUND", message: "حساب إدارة المنصة غير موجود." });
    if (target.platformRole === "platform_owner") throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكن تعديل دور مالك المنصة من هذا المسار." });
    await db.update(users).set({ platformRole: input.platformRole, accountStatus: "active" }).where(eq(users.id, input.userId));
    await recordPlatformSecurityChange(db, ctx.user, input.userId, "تغيير دور منصة", { before: target.platformRole, after: input.platformRole });
    return { success: true };
  }),

  financeOverview: platformFinanceProcedure.query(async () => {
    const { data, error } = await supabaseAdmin().rpc("powerhub_finance_overview");
    if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل الملخص المالي المركزي من Supabase." });
    const overview = (data as Array<{ subscriptions?: unknown; collections_amount?: string | number | null; collections_count?: string | number | null }> | null)?.[0];
    if (!overview) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "لم تُعد دالة الملخص المالي استجابة صالحة." });
    const subscriptions = Array.isArray(overview.subscriptions) ? overview.subscriptions : [];
    return {
      subscriptions: subscriptions.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const subscription = item as { status?: unknown; count?: unknown };
        return typeof subscription.status === "string" ? [{ status: subscription.status, count: Number(subscription.count ?? 0) }] : [];
      }),
      collections: { amount: Number(overview.collections_amount ?? 0), count: Number(overview.collections_count ?? 0) },
    };
  }),

  inviteTenantAccess: platformAdminProcedure.input(z.object({
    tenantId: z.number().int().positive(),
    siteId: z.number().int().positive().optional(),
    email: z.string().email().transform((email) => email.trim().toLowerCase()),
    tenantRole: z.enum(["owner", "admin", "member"]).default("member"),
    siteRole: z.enum(["owner", "manager", "accountant", "collector", "technician", "viewer"]).optional(),
    expiresInHours: z.number().int().min(1).max(168).default(72),
  })).mutation(async ({ ctx, input }) => {
    assertLegacyAdminWriteMigrationGuard("دعوة وصول إلى مساحة صاحب المولد");
    const db = await dbOrThrow();
    const [site] = input.siteId ? await db.select({ id: sites.id, tenantId: sites.tenantId }).from(sites).where(eq(sites.id, input.siteId)).limit(1) : [undefined];
    if (input.siteId && (!site || site.tenantId !== input.tenantId)) throw new TRPCError({ code: "BAD_REQUEST", message: "المحطة لا تتبع لمساحة صاحب المولد المحددة." });
    const [tenant] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, input.tenantId)).limit(1);
    if (!tenant) throw new TRPCError({ code: "NOT_FOUND", message: "مساحة صاحب المولد غير موجودة." });
    if (input.tenantRole === "owner" && input.siteRole && input.siteRole !== "owner") throw new TRPCError({ code: "BAD_REQUEST", message: "دعوة صاحب المولد يجب أن تحمل دور مالك للمحطة أيضاً." });
    const expiresAt = new Date(Date.now() + input.expiresInHours * 60 * 60 * 1000);
    const tokenHash = crypto.createHash("sha256").update(crypto.randomBytes(32)).digest("hex");
    const id = insertId(await db.insert(accessInvitations).values({
      tenantId: input.tenantId,
      siteId: input.siteId,
      email: input.email,
      tenantRole: input.tenantRole,
      siteRole: input.tenantRole === "owner" ? "owner" : input.siteRole,
      tokenHash,
      invitedByUserId: ctx.user.id,
      expiresAt,
    }));
    if (site) await db.insert(auditLogs).values({ tenantId: input.tenantId, siteId: site.id, userId: ctx.user.id, actorPlatformRole: platformRoleOf(ctx.user), entityType: "access_invitation", entityId: String(id), action: "platform_admin_invite_tenant_access", metadata: { email: input.email, tenantRole: input.tenantRole, siteRole: input.siteRole, expiresAt } });
    return { id, email: input.email, expiresAt, status: "invited" as const };
  }),

  setTenantMembershipStatus: platformAdminProcedure.input(z.object({ tenantId: z.number().int().positive(), userId: z.number().int().positive(), status: z.enum(["active", "suspended", "revoked"]) })).mutation(async ({ ctx, input }) => {
    assertLegacyAdminWriteMigrationGuard("تغيير حالة عضوية صاحب المولد");
    const db = await dbOrThrow();
    const [membership] = await db.select().from(tenantMembers).where(and(eq(tenantMembers.tenantId, input.tenantId), eq(tenantMembers.userId, input.userId))).limit(1);
    const [site] = await db.select().from(sites).where(eq(sites.tenantId, input.tenantId)).limit(1);
    if (!membership || !site) throw new TRPCError({ code: "NOT_FOUND", message: "العضوية أو محطة المستأجر غير موجودة." });
    const isActive = input.status === "active";
    await db.transaction(async (tx) => {
      await tx.update(tenantMembers).set({ membershipStatus: input.status, isActive, expiresAt: input.status === "revoked" ? new Date() : null }).where(eq(tenantMembers.id, membership.id));
      await tx.update(staffProfiles).set({ isActive }).where(and(eq(staffProfiles.userId, input.userId), eq(staffProfiles.siteId, site.id)));
    });
    await db.insert(auditLogs).values({ tenantId: input.tenantId, siteId: site.id, userId: ctx.user.id, actorPlatformRole: platformRoleOf(ctx.user), entityType: "tenant_membership", entityId: String(membership.id), action: "platform_admin_set_tenant_membership_status", beforeData: { status: membership.membershipStatus }, afterData: { status: input.status } });
    return { success: true };
  }),

  createGeneratorOwner: platformAdminProcedure.input(z.object({
    tenantName: z.string().min(2).max(160),
    slug: z.string().min(3).max(80).regex(/^[a-z0-9-]+$/),
    ownerName: z.string().min(2).max(180),
    ownerPhone: z.string().min(5).max(30),
    ownerEmail: z.string().email().optional(),
    companyName: z.string().max(180).optional(),
    ownerUserId: z.number().int().positive().optional(),
    siteName: z.string().min(2).max(160),
    siteCode: z.string().min(2).max(50).transform((value) => value.toUpperCase()),
    generatorName: z.string().min(2).max(160),
    generatorCode: z.string().min(2).max(50).transform((value) => value.toUpperCase()),
    generatorCapacityKw: z.number().positive().max(100000),
    generatorFuelType: z.enum(["diesel", "gasoline", "gas", "other"]).default("diesel"),
    city: z.string().max(100).optional(),
    plan: planSchema.default("starter"),
    subscriptionStatus: subscriptionStatusSchema.default("trial"),
    billingCycle: billingCycleSchema.default("monthly"),
    endsAt: z.date().optional(),
    autoRenew: z.boolean().default(false),
    notes: z.string().max(2000).optional(),
  })).mutation(async ({ ctx, input }) => {
    assertLegacyAdminWriteMigrationGuard("إنشاء صاحب مولد");
    const db = await dbOrThrow();
    const phone = input.ownerPhone.trim();
    const generatorName = input.generatorName.trim();
    const [[existingPhone], [existingGenerator], [existingEmail]] = await Promise.all([
      db.select({ id: tenantOwnerProfiles.id }).from(tenantOwnerProfiles).where(eq(tenantOwnerProfiles.phone, phone)).limit(1),
      db.select({ id: generators.id }).from(generators).where(eq(generators.name, generatorName)).limit(1),
      input.ownerEmail ? db.select({ id: tenantOwnerProfiles.id }).from(tenantOwnerProfiles).where(eq(tenantOwnerProfiles.email, input.ownerEmail.trim().toLowerCase())).limit(1) : Promise.resolve([]),
    ]);
    if (existingPhone) throw new TRPCError({ code: "CONFLICT", message: "رقم هاتف صاحب المولد مستخدم بالفعل." });
    if (existingGenerator) throw new TRPCError({ code: "CONFLICT", message: "اسم المولد مستخدم بالفعل." });
    if (existingEmail) throw new TRPCError({ code: "CONFLICT", message: "البريد الإلكتروني لصاحب المولد مستخدم بالفعل." });
    if (input.ownerUserId) {
      const [ownerUser] = await db.select({ id: users.id }).from(users).where(eq(users.id, input.ownerUserId)).limit(1);
      if (!ownerUser) throw new TRPCError({ code: "NOT_FOUND", message: "حساب المالك المحدد غير موجود." });
    }
    const startedAt = new Date();
    const endsAt = input.endsAt ?? addSubscriptionPeriod(startedAt, input.billingCycle);
    const result = await db.transaction(async (tx) => {
      const tenantId = insertId(await tx.insert(tenants).values({
        name: input.tenantName,
        slug: input.slug,
        plan: input.plan,
        status: tenantStatusForSubscription(input.subscriptionStatus),
      }));
      await tx.insert(tenantOwnerProfiles).values({
        tenantId,
        ownerUserId: input.ownerUserId,
        fullName: input.ownerName,
        phone,
        email: input.ownerEmail,
        companyName: input.companyName,
        invitedAt: input.ownerUserId ? undefined : startedAt,
        claimedAt: input.ownerUserId ? startedAt : undefined,
      });
      await tx.insert(tenantSubscriptions).values({
        tenantId,
        plan: input.plan,
        status: input.subscriptionStatus,
        billingCycle: input.billingCycle,
        startedAt,
        endsAt,
        autoRenew: input.autoRenew,
        notes: input.notes,
      });
      const siteId = insertId(await tx.insert(sites).values({
        tenantId,
        name: input.siteName,
        code: input.siteCode,
        city: input.city,
      }));
      await tx.insert(sitePortalSettings).values({ tenantId, siteId, portalCode: input.siteCode.toLowerCase(), displayName: input.siteName });
      const generatorId = insertId(await tx.insert(generators).values({ tenantId, siteId, name: generatorName, code: input.generatorCode, ratedCapacityKw: String(input.generatorCapacityKw), fuelType: input.generatorFuelType, status: "pending" }));
      if (input.ownerUserId) {
        await tx.insert(tenantMembers).values({ tenantId, userId: input.ownerUserId, role: "owner", isActive: true });
        await tx.insert(staffProfiles).values({ tenantId, siteId, userId: input.ownerUserId, role: "owner", isActive: true });
      } else if (input.ownerEmail) {
        const tokenHash = crypto.createHash("sha256").update(crypto.randomBytes(32)).digest("hex");
        await tx.insert(accessInvitations).values({
          tenantId,
          siteId,
          email: input.ownerEmail.trim().toLowerCase(),
          tenantRole: "owner",
          siteRole: "owner",
          tokenHash,
          invitedByUserId: ctx.user.id,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        });
      }
      return { tenantId, siteId, generatorId };
    });
    await db.insert(auditLogs).values({
      tenantId: result.tenantId,
      siteId: result.siteId,
      userId: ctx.user.id,
      entityType: "generator",
      entityId: String(result.generatorId),
      action: "platform_admin_create_pending_generator_owner",
      afterData: { tenantName: input.tenantName, ownerName: input.ownerName, generatorName, generatorCode: input.generatorCode, generatorStatus: "pending", plan: input.plan, subscriptionStatus: input.subscriptionStatus },
      actorPlatformRole: platformRoleOf(ctx.user),
    });
    return result;
  }),

  attachOwnerUser: platformAdminProcedure.input(z.object({ tenantId: z.number().int().positive(), userId: z.number().int().positive(), siteId: z.number().int().positive().optional() }))
    .mutation(async ({ ctx, input }) => {
      assertLegacyAdminWriteMigrationGuard("ربط حساب مالك بصاحب مولد");
      const db = await dbOrThrow();
      const [tenant] = await db.select().from(tenants).where(eq(tenants.id, input.tenantId)).limit(1);
      const [user] = await db.select().from(users).where(eq(users.id, input.userId)).limit(1);
      if (!tenant || !user) throw new TRPCError({ code: "NOT_FOUND", message: "المستأجر أو حساب المالك غير موجود." });
      if (isPlatformAccount(user)) throw new TRPCError({ code: "FORBIDDEN", message: platformAccountOwnerMessage });
      const [site] = input.siteId
        ? await db.select().from(sites).where(and(eq(sites.id, input.siteId), eq(sites.tenantId, input.tenantId))).limit(1)
        : await db.select().from(sites).where(eq(sites.tenantId, input.tenantId)).limit(1);
      if (!site) throw new TRPCError({ code: "NOT_FOUND", message: "لا توجد محطة لهذا المستأجر لربط مالكها." });
      await db.transaction(async (tx) => {
        await tx.insert(tenantMembers).values({ tenantId: input.tenantId, userId: input.userId, role: "owner", isActive: true }).onDuplicateKeyUpdate({ set: { role: "owner", isActive: true } });
        await tx.insert(staffProfiles).values({ tenantId: input.tenantId, siteId: site.id, userId: input.userId, role: "owner", isActive: true }).onDuplicateKeyUpdate({ set: { isActive: true } });
        await tx.update(tenantOwnerProfiles).set({ ownerUserId: input.userId, claimedAt: new Date() }).where(eq(tenantOwnerProfiles.tenantId, input.tenantId));
      });
      await db.insert(auditLogs).values({ tenantId: input.tenantId, siteId: site.id, userId: ctx.user.id, entityType: "tenant_owner_profile", entityId: String(input.tenantId), action: "platform_admin_attach_owner_user", metadata: { attachedUserId: input.userId } });
      return { success: true };
    }),

  updateSubscription: platformAdminProcedure.input(z.object({
    tenantId: z.number().int().positive(),
    plan: planSchema,
    status: subscriptionStatusSchema,
    billingCycle: billingCycleSchema,
    endsAt: z.date(),
    autoRenew: z.boolean(),
    notes: z.string().max(2000).optional(),
    smsPlanId: z.number().int().positive().nullable().optional(),
  })).mutation(async ({ ctx, input }) => {
    assertLegacyAdminWriteMigrationGuard("تحديث اشتراك صاحب المولد");
    const db = await dbOrThrow();
    if (input.smsPlanId) {
      const [plan] = await db.select({ id: platformSmsPlans.id, isActive: platformSmsPlans.isActive }).from(platformSmsPlans).where(eq(platformSmsPlans.id, input.smsPlanId)).limit(1);
      if (!plan || !plan.isActive) throw new TRPCError({ code: "BAD_REQUEST", message: "خطة رسائل SMS غير موجودة أو متوقفة." });
    }
    const [subscription] = await db.select().from(tenantSubscriptions).where(eq(tenantSubscriptions.tenantId, input.tenantId)).limit(1);
    if (!subscription) throw new TRPCError({ code: "NOT_FOUND", message: "اشتراك المستأجر غير موجود." });
    const [site] = await db.select().from(sites).where(eq(sites.tenantId, input.tenantId)).limit(1);
    if (!site) throw new TRPCError({ code: "NOT_FOUND", message: "لا توجد محطة مرتبطة بالمستأجر." });
    await db.transaction(async (tx) => {
      await tx.update(tenantSubscriptions).set({ plan: input.plan, status: input.status, billingCycle: input.billingCycle, endsAt: input.endsAt, autoRenew: input.autoRenew, notes: input.notes, smsPlanId: input.smsPlanId ?? null }).where(eq(tenantSubscriptions.tenantId, input.tenantId));
      await tx.update(tenants).set({ plan: input.plan, status: tenantStatusForSubscription(input.status) }).where(eq(tenants.id, input.tenantId));
    });
    await db.insert(auditLogs).values({ tenantId: input.tenantId, siteId: site.id, userId: ctx.user.id, entityType: "tenant_subscription", entityId: String(subscription.id), action: "platform_admin_update_subscription", afterData: input });
    return { success: true };
  }),

  listSmsPlans: platformAdminProcedure.query(async () => {
    const { data, error } = await supabaseAdmin().from("platform_sms_plans")
      .select("id, code, name, description, included_messages, is_active, created_at, updated_at")
      .order("created_at", { ascending: false });
    if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل باقات الرسائل من Supabase." });
    return (data ?? []).map((plan) => ({ id: Number(plan.id), code: plan.code, name: plan.name, description: plan.description, includedMessages: plan.included_messages, isActive: plan.is_active, createdAt: plan.created_at, updatedAt: plan.updated_at }));
  }),
  createSmsPlan: platformAdminProcedure.input(z.object({ code: z.string().trim().min(2).max(80).regex(/^[a-z0-9_-]+$/), name: z.string().trim().min(2).max(160), description: z.string().max(1000).optional(), includedMessages: z.number().int().min(0).max(100000000), isActive: z.boolean().default(true) })).mutation(async ({ ctx, input }) => {
    assertLegacyAdminWriteMigrationGuard("إنشاء باقة رسائل SMS");
    const db = await dbOrThrow();
    const id = insertId(await db.insert(platformSmsPlans).values(input));
    await db.insert(platformSecurityEvents).values({ eventType: "security_change", severity: "info", status: "success", title: "إنشاء باقة رسائل SMS", createdByUserId: ctx.user.id, metadata: { planId: id, code: input.code, includedMessages: input.includedMessages } });
    return { id };
  }),
  updateSmsPlan: platformAdminProcedure.input(z.object({ id: z.number().int().positive(), name: z.string().trim().min(2).max(160).optional(), description: z.string().max(1000).optional(), includedMessages: z.number().int().min(0).max(100000000).optional(), isActive: z.boolean().optional() })).mutation(async ({ ctx, input }) => {
    assertLegacyAdminWriteMigrationGuard("تحديث باقة رسائل SMS");
    const db = await dbOrThrow();
    const { id, ...changes } = input;
    await db.update(platformSmsPlans).set(changes).where(eq(platformSmsPlans.id, id));
    await db.insert(platformSecurityEvents).values({ eventType: "security_change", severity: "info", status: "success", title: "تحديث باقة رسائل SMS", createdByUserId: ctx.user.id, metadata: { planId: id, changes } });
    return { success: true };
  }),
  listSmsPackageRequests: platformAdminProcedure.query(async () => {
    {
      const admin = supabaseAdmin();
      const { data: requests, error: requestsError } = await admin.from("sms_package_requests")
        .select("id, tenant_id, requested_by_user_id, requested_messages, approved_messages, status, note, reviewed_by_user_id, reviewed_at, created_at, updated_at")
        .order("created_at", { ascending: false }).limit(100);
      if (requestsError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل طلبات حزم الرسائل من Supabase." });
      const tenantIds = Array.from(new Set((requests ?? []).map((request) => Number(request.tenant_id))));
      const [tenantsResult, ownersResult] = await Promise.all([
        tenantIds.length ? admin.from("tenants").select("id, name").in("id", tenantIds) : Promise.resolve({ data: [], error: null }),
        tenantIds.length ? admin.from("tenant_owner_profiles").select("tenant_id, full_name").in("tenant_id", tenantIds) : Promise.resolve({ data: [], error: null }),
      ]);
      if (tenantsResult.error || ownersResult.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل بيانات أصحاب طلبات الرسائل من Supabase." });
      const tenantNames = new Map((tenantsResult.data ?? []).map((tenant) => [Number(tenant.id), tenant.name]));
      const ownerNames = new Map((ownersResult.data ?? []).map((owner) => [Number(owner.tenant_id), owner.full_name]));
      return (requests ?? []).map((request) => ({
        request: { id: Number(request.id), tenantId: Number(request.tenant_id), requestedByUserId: Number(request.requested_by_user_id), requestedMessages: request.requested_messages, approvedMessages: request.approved_messages, status: request.status, note: request.note, reviewedByUserId: request.reviewed_by_user_id ? Number(request.reviewed_by_user_id) : null, reviewedAt: request.reviewed_at, createdAt: request.created_at, updatedAt: request.updated_at },
        tenantName: tenantNames.get(Number(request.tenant_id)) ?? "—", ownerName: ownerNames.get(Number(request.tenant_id)) ?? "—",
      }));
    }
  }),
  reviewSmsPackageRequest: platformAdminProcedure.input(z.object({ id: z.number().int().positive(), status: z.enum(["approved", "rejected"]), approvedMessages: z.number().int().min(0).max(100000000), note: z.string().max(2000).optional() })).mutation(async ({ ctx, input }) => {
    assertLegacyAdminWriteMigrationGuard("مراجعة طلب حزمة رسائل SMS");
    const db = await dbOrThrow();
    const [request] = await db.select().from(smsPackageRequests).where(and(eq(smsPackageRequests.id, input.id), eq(smsPackageRequests.status, "pending"))).limit(1);
    if (!request) throw new TRPCError({ code: "NOT_FOUND", message: "طلب الحزمة غير موجود أو تمت مراجعته سابقاً." });
    if (input.status === "approved" && input.approvedMessages < 1) throw new TRPCError({ code: "BAD_REQUEST", message: "أدخل كمية رسائل موجبة عند اعتماد الطلب." });
    await db.update(smsPackageRequests).set({ status: input.status, approvedMessages: input.status === "approved" ? input.approvedMessages : 0, note: input.note, reviewedByUserId: ctx.user.id, reviewedAt: new Date() }).where(eq(smsPackageRequests.id, input.id));
    const [site] = await db.select({ id: sites.id }).from(sites).where(eq(sites.tenantId, request.tenantId)).limit(1);
    if (site) await db.insert(auditLogs).values({ tenantId: request.tenantId, siteId: site.id, userId: ctx.user.id, entityType: "sms_package_request", entityId: String(input.id), action: `platform_admin_${input.status}_sms_package_request`, metadata: { requestedMessages: request.requestedMessages, approvedMessages: input.approvedMessages, note: input.note } });
    return { success: true };
  }),
  renewSubscription: platformAdminProcedure.input(z.object({ tenantId: z.number().int().positive(), periods: z.number().int().min(1).max(24).default(1) })).mutation(async ({ ctx, input }) => {
    assertLegacyAdminWriteMigrationGuard("تجديد اشتراك صاحب المولد");
    const db = await dbOrThrow();
    const [subscription] = await db.select().from(tenantSubscriptions).where(eq(tenantSubscriptions.tenantId, input.tenantId)).limit(1);
    if (!subscription) throw new TRPCError({ code: "NOT_FOUND", message: "اشتراك المستأجر غير موجود." });
    const [site] = await db.select().from(sites).where(eq(sites.tenantId, input.tenantId)).limit(1);
    if (!site) throw new TRPCError({ code: "NOT_FOUND", message: "لا توجد محطة مرتبطة بالمستأجر." });
    const base = subscription.endsAt > new Date() ? subscription.endsAt : new Date();
    const endsAt = addSubscriptionPeriod(base, subscription.billingCycle, input.periods);
    await db.transaction(async (tx) => {
      await tx.update(tenantSubscriptions).set({ status: "active", endsAt, renewalCount: sql`${tenantSubscriptions.renewalCount} + ${input.periods}`, lastRenewedAt: new Date() }).where(eq(tenantSubscriptions.tenantId, input.tenantId));
      await tx.update(tenants).set({ status: "active" }).where(eq(tenants.id, input.tenantId));
    });
    await db.insert(auditLogs).values({ tenantId: input.tenantId, siteId: site.id, userId: ctx.user.id, entityType: "tenant_subscription", entityId: String(subscription.id), action: "platform_admin_renew_subscription", metadata: { periods: input.periods, endsAt } });
    return { endsAt };
  }),

  setTenantStatus: platformAdminProcedure.input(z.object({ tenantId: z.number().int().positive(), status: z.enum(["active", "suspended"]) })).mutation(async ({ ctx, input }) => {
    const admin = supabaseAdmin();
    const [{ data: tenant, error: tenantError }, { data: site, error: siteError }] = await Promise.all([
      admin.from("tenants").select("id, status").eq("id", input.tenantId).maybeSingle(),
      admin.from("sites").select("id").eq("tenant_id", input.tenantId).order("id", { ascending: true }).limit(1).maybeSingle(),
    ]);
    if (tenantError || siteError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل حالة مساحة صاحب المولد من Supabase." });
    if (!tenant) throw new TRPCError({ code: "NOT_FOUND", message: "مساحة صاحب المولد غير موجودة." });
    const { error: statusError } = await admin.from("tenants").update({ status: input.status }).eq("id", input.tenantId);
    if (statusError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحديث حالة مساحة صاحب المولد في Supabase." });
    if (input.status === "suspended") {
      const { error: subscriptionError } = await admin.from("tenant_subscriptions").update({ status: "suspended" }).eq("tenant_id", input.tenantId);
      if (subscriptionError) {
        await admin.from("tenants").update({ status: tenant.status }).eq("id", input.tenantId);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر إيقاف الاشتراك المرتبط بالمساحة؛ أُعيدت حالة المساحة السابقة." });
      }
    }
    if (site) {
      const { error: auditError } = await admin.from("audit_logs").insert({ tenant_id: Number(tenant.id), site_id: Number(site.id), user_id: ctx.user.id, entity_type: "tenant", entity_id: String(tenant.id), action: "platform_admin_set_tenant_status", before_data: { status: tenant.status }, after_data: { status: input.status }, actor_platform_role: platformRoleOf(ctx.user) });
      if (auditError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تم تحديث الحالة لكن تعذر تسجيل التدقيق في Supabase." });
    }
    return { success: true };
  }),

  setGeneratorStatus: platformAdminProcedure.input(z.object({ id: z.number().int().positive(), status: z.enum(["active", "maintenance", "stopped", "offline", "blocked"]) })).mutation(async ({ ctx, input }) => {
    const admin = supabaseAdmin();
    const { data: generator, error: generatorError } = await admin.from("generators").select("id, tenant_id, site_id, status").eq("id", input.id).maybeSingle();
    if (generatorError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل المولد من Supabase." });
    if (!generator) throw new TRPCError({ code: "NOT_FOUND", message: "المولد غير موجود." });
    const { error: statusError } = await admin.from("generators").update({ status: input.status }).eq("id", input.id);
    if (statusError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحديث حالة المولد في Supabase." });
    const { error: auditError } = await admin.from("audit_logs").insert({ tenant_id: Number(generator.tenant_id), site_id: Number(generator.site_id), user_id: ctx.user.id, entity_type: "generator", entity_id: String(generator.id), action: "platform_admin_update_generator_status", before_data: { status: generator.status }, after_data: { status: input.status }, actor_platform_role: platformRoleOf(ctx.user) });
    if (auditError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تم تحديث حالة المولد لكن تعذر تسجيل التدقيق في Supabase." });
    return { success: true };
  }),

  approvePendingGenerator: platformAdminProcedure.input(z.object({ generatorId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    const admin = supabaseAdmin();
    const { data: generator, error: generatorError } = await admin.from("generators").select("id, tenant_id, site_id, status").eq("id", input.generatorId).maybeSingle();
    if (generatorError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل المولد من Supabase." });
    if (!generator) throw new TRPCError({ code: "NOT_FOUND", message: "المولد غير موجود." });
    if (generator.status !== "pending") throw new TRPCError({ code: "CONFLICT", message: "لا يمكن اعتماد مولد ليس بحالة انتظار المراجعة." });
    const { data: approved, error: approvalError } = await admin.from("generators").update({ status: "active" }).eq("id", input.generatorId).eq("status", "pending").select("id").maybeSingle();
    if (approvalError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر اعتماد المولد في Supabase." });
    if (!approved) throw new TRPCError({ code: "CONFLICT", message: "تغيرت حالة المولد قبل الاعتماد، أعد تحميل الصفحة." });
    const { error: auditError } = await admin.from("audit_logs").insert({ tenant_id: Number(generator.tenant_id), site_id: Number(generator.site_id), user_id: ctx.user.id, entity_type: "generator", entity_id: String(generator.id), action: "platform_admin_approve_pending_generator", before_data: { status: "pending" }, after_data: { status: "active" }, actor_platform_role: platformRoleOf(ctx.user) });
    if (auditError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تم اعتماد المولد لكن تعذر تسجيل التدقيق في Supabase." });
    return { success: true, generatorId: Number(generator.id), status: "active" as const };
  }),

  listSyncEvents: platformAdminProcedure.input(z.object({ tenantId: z.number().int().positive().optional(), siteId: z.number().int().positive().optional(), status: z.enum(["success", "partial", "retryable", "needs_review", "failed"]).optional(), from: z.string().datetime().optional(), to: z.string().datetime().optional(), page: z.number().int().min(1).default(1), pageSize: z.number().int().min(10).max(100).default(25) })).query(async ({ input }) => {
    const admin = supabaseAdmin();
    let query = admin.from("mobile_sync_events").select("id, tenant_id, site_id, user_id, event_type, status, synced_count, retryable_count, needs_review_count, error_code, error_message, app_version, device_label, occurred_at");
    if (input.tenantId) query = query.eq("tenant_id", input.tenantId);
    if (input.siteId) query = query.eq("site_id", input.siteId);
    if (input.status) query = query.eq("status", input.status);
    if (input.from) query = query.gte("occurred_at", input.from);
    if (input.to) query = query.lte("occurred_at", input.to);
    const { data, error } = await query.order("occurred_at", { ascending: false }).range((input.page - 1) * input.pageSize, input.page * input.pageSize - 1);
    if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل سجل المزامنة المركزي من Supabase." });
    const rows = data ?? [];
    const tenantIds = Array.from(new Set(rows.map((row) => Number(row.tenant_id))));
    const siteIds = Array.from(new Set(rows.map((row) => Number(row.site_id))));
    const userIds = Array.from(new Set(rows.map((row) => Number(row.user_id))));
    const [tenantsResult, sitesResult, usersResult] = await Promise.all([
      tenantIds.length ? admin.from("tenants").select("id, name").in("id", tenantIds) : Promise.resolve({ data: [], error: null }),
      siteIds.length ? admin.from("sites").select("id, name").in("id", siteIds) : Promise.resolve({ data: [], error: null }),
      userIds.length ? admin.from("users").select("id, name, email").in("id", userIds) : Promise.resolve({ data: [], error: null }),
    ]);
    if (tenantsResult.error || sitesResult.error || usersResult.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل سياق أحداث المزامنة من Supabase." });
    const tenantNames = new Map((tenantsResult.data ?? []).map((tenant) => [Number(tenant.id), tenant.name]));
    const siteNames = new Map((sitesResult.data ?? []).map((site) => [Number(site.id), site.name]));
    const usersById = new Map((usersResult.data ?? []).map((user) => [Number(user.id), user]));
    return rows.map((row) => {
      const user = usersById.get(Number(row.user_id));
      return {
        id: Number(row.id), tenantId: Number(row.tenant_id), siteId: Number(row.site_id), tenantName: tenantNames.get(Number(row.tenant_id)) ?? "—", siteName: siteNames.get(Number(row.site_id)) ?? "—",
        userId: Number(row.user_id), userName: user?.name ?? null, userEmail: user?.email ?? null, eventType: row.event_type, status: row.status,
        syncedCount: Number(row.synced_count ?? 0), retryableCount: Number(row.retryable_count ?? 0), needsReviewCount: Number(row.needs_review_count ?? 0), errorCode: row.error_code, errorMessage: row.error_message,
        appVersion: row.app_version, deviceLabel: row.device_label, occurredAt: new Date(row.occurred_at),
      };
    });
  }),

  listNotifications: platformAdminProcedure.input(z.object({ status: z.enum(["pending", "submitted", "delivered", "read", "failed"]).optional() }).optional()).query(async ({ input }) => {
    const admin = supabaseAdmin();
    let query = admin.from("notification_messages").select("id, tenant_id, channel, event_type, recipient, status, attempts, last_error, created_at").order("created_at", { ascending: false }).limit(300);
    if (input?.status) query = query.eq("status", input.status);
    const { data, error } = await query;
    if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل سجل الإشعارات من Supabase." });
    const tenantIds = Array.from(new Set((data ?? []).map((item) => Number(item.tenant_id))));
    const { data: tenantRows, error: tenantsError } = tenantIds.length
      ? await admin.from("tenants").select("id, name").in("id", tenantIds)
      : { data: [], error: null };
    if (tenantsError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل أسماء مساحات الإشعارات من Supabase." });
    const tenantNames = new Map((tenantRows ?? []).map((tenant) => [Number(tenant.id), tenant.name]));
    return (data ?? []).map((message) => ({ id: Number(message.id), channel: message.channel, eventType: message.event_type, recipient: message.recipient, status: message.status, attempts: message.attempts, lastError: message.last_error, createdAt: message.created_at, tenantName: tenantNames.get(Number(message.tenant_id)) ?? "—" }));
  }),

  operationalMonitoring: platformAdminProcedure.query(async () => {
    const admin = supabaseAdmin();
    const [databaseProbe, failedMessagesResult, pendingMessagesResult, syncIssuesResult, securityIssuesResult] = await Promise.all([
      admin.from("tenants").select("id", { count: "exact", head: true }),
      admin.from("notification_messages").select("id, tenant_id, channel, event_type, last_error, created_at").eq("status", "failed").order("created_at", { ascending: false }).limit(12),
      admin.from("notification_messages").select("id", { count: "exact", head: true }).eq("status", "pending"),
      admin.from("mobile_sync_events").select("id, tenant_id, status, error_code, error_message, occurred_at").in("status", ["partial", "retryable", "needs_review", "failed"]).order("occurred_at", { ascending: false }).limit(12),
      admin.from("platform_security_events").select("id, severity, status, title, details, created_at").in("status", ["open", "failed"]).order("created_at", { ascending: false }).limit(12),
    ]);
    if (databaseProbe.error || failedMessagesResult.error || pendingMessagesResult.error || syncIssuesResult.error || securityIssuesResult.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل المراقبة التشغيلية من Supabase." });
    const failedMessages = failedMessagesResult.data ?? [];
    const syncIssues = syncIssuesResult.data ?? [];
    const securityIssues = securityIssuesResult.data ?? [];
    const tenantIds = Array.from(new Set([...failedMessages, ...syncIssues].map((item) => Number(item.tenant_id))));
    const tenantResult = tenantIds.length
      ? await admin.from("tenants").select("id, name").in("id", tenantIds)
      : { data: [], error: null };
    if (tenantResult.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل أسماء مساحات التنبيهات من Supabase." });
    const tenantNameById = new Map((tenantResult.data ?? []).map((tenant) => [Number(tenant.id), tenant.name]));
    const alerts = [
      ...failedMessages.map((item) => ({ id: `message-${item.id}`, category: "messaging" as const, severity: "critical" as const, title: `فشل إرسال ${item.channel === "sms" ? "SMS" : "WhatsApp"}`, detail: item.last_error ?? `تعذر إرسال ${item.event_type}.`, tenantName: tenantNameById.get(Number(item.tenant_id)) ?? "—", occurredAt: new Date(item.created_at), target: "notifications" as const })),
      ...syncIssues.map((item) => ({ id: `sync-${item.id}`, category: "sync" as const, severity: item.status === "failed" ? "critical" as const : "warning" as const, title: `مزامنة ميدانية: ${item.status}`, detail: item.error_message ?? item.error_code ?? "تحتاج دورة المزامنة إلى مراجعة.", tenantName: tenantNameById.get(Number(item.tenant_id)) ?? "—", occurredAt: new Date(item.occurred_at), target: "field_sync" as const })),
      ...securityIssues.map((item) => ({ id: `security-${item.id}`, category: "security" as const, severity: item.severity === "critical" ? "critical" as const : "warning" as const, title: item.title, detail: item.details ?? "حدث أمني مفتوح يحتاج إلى متابعة.", tenantName: null, occurredAt: new Date(item.created_at), target: "security" as const })),
    ].sort((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime()).slice(0, 24);
    const pending = Number(pendingMessagesResult.count ?? 0);
    return { health: [
      { key: "database", label: "البيانات", state: databaseProbe.count !== null ? "healthy" as const : "critical" as const, detail: databaseProbe.count !== null ? "استجابة قاعدة البيانات سليمة." : "تعذر التحقق من قاعدة البيانات.", count: Number(databaseProbe.count ?? 0), target: "reports" as const },
      { key: "messaging", label: "الإرسال", state: failedMessages.length ? "critical" as const : pending ? "warning" as const : "healthy" as const, detail: failedMessages.length ? `${failedMessages.length} رسالة فاشلة تحتاج مراجعة.` : pending ? `${pending} رسالة بانتظار المعالجة.` : "لا توجد رسائل معلقة أو فاشلة.", count: failedMessages.length || pending, target: "notifications" as const },
      { key: "sync", label: "المزامنة", state: syncIssues.some((item) => item.status === "failed") ? "critical" as const : syncIssues.length ? "warning" as const : "healthy" as const, detail: syncIssues.length ? `${syncIssues.length} حدث مزامنة يحتاج متابعة.` : "لا توجد أحداث مزامنة معلقة للمراجعة.", count: syncIssues.length, target: "field_sync" as const },
      { key: "security", label: "الأمان", state: securityIssues.some((item) => item.severity === "critical") ? "critical" as const : securityIssues.length ? "warning" as const : "healthy" as const, detail: securityIssues.length ? `${securityIssues.length} حدث أمني مفتوح.` : "لا توجد أحداث أمنية مفتوحة.", count: securityIssues.length, target: "security" as const },
    ], alerts };
  }),

  securityCenter: platformAdminProcedure.query(async () => {
    const admin = supabaseAdmin();
    const [eventsResult, settingsResult] = await Promise.all([
      admin.from("platform_security_events").select("id, event_type, severity, status, title, details, created_at, resolved_at, related_user_id").order("created_at", { ascending: false }).limit(300),
      admin.from("platform_security_settings").select("id, setting_key, is_enabled, value, updated_by_user_id, updated_at").order("setting_key", { ascending: true }),
    ]);
    if (eventsResult.error || settingsResult.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل مركز الأمان من Supabase." });
    const relatedIds = Array.from(new Set((eventsResult.data ?? []).flatMap((event) => event.related_user_id ? [Number(event.related_user_id)] : [])));
    const { data: relatedUsers, error: relatedUsersError } = relatedIds.length
      ? await admin.from("users").select("id, name").in("id", relatedIds)
      : { data: [], error: null };
    if (relatedUsersError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل مستخدمي مركز الأمان من Supabase." });
    const names = new Map((relatedUsers ?? []).map((user) => [Number(user.id), user.name]));
    return {
      events: (eventsResult.data ?? []).map((event) => ({ id: Number(event.id), eventType: event.event_type, severity: event.severity, status: event.status, title: event.title, details: event.details, createdAt: event.created_at, resolvedAt: event.resolved_at, userName: event.related_user_id ? names.get(Number(event.related_user_id)) ?? null : null })),
      settings: (settingsResult.data ?? []).map((setting) => ({ id: Number(setting.id), settingKey: setting.setting_key, isEnabled: setting.is_enabled, value: setting.value, updatedByUserId: setting.updated_by_user_id ? Number(setting.updated_by_user_id) : null, updatedAt: setting.updated_at })),
    };
  }),

  recordSecurityEvent: platformAdminProcedure.input(z.object({ eventType: z.enum(["suspicious_login", "backup", "security_change"]), severity: z.enum(["info", "warning", "critical"]), status: z.enum(["open", "resolved", "success", "failed"]), title: z.string().min(3).max(180), details: z.string().max(4000).optional(), relatedUserId: z.number().int().positive().optional() })).mutation(async ({ ctx, input }) => {
    const { error } = await supabaseAdmin().from("platform_security_events").insert({
      event_type: input.eventType, severity: input.severity, status: input.status, title: input.title, details: input.details ?? null,
      related_user_id: input.relatedUserId ?? null, created_by_user_id: ctx.user.id,
      resolved_at: input.status === "resolved" || input.status === "success" ? new Date().toISOString() : null,
    });
    if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تسجيل حدث الأمان في Supabase." });
    return { success: true };
  }),

  saveSecuritySetting: platformAdminProcedure.input(z.object({ settingKey: z.string().min(2).max(100), isEnabled: z.boolean(), value: z.string().max(4000).optional() })).mutation(async ({ ctx, input }) => {
    const admin = supabaseAdmin();
    const { error: settingError } = await admin.from("platform_security_settings").upsert({
      setting_key: input.settingKey, is_enabled: input.isEnabled, value: input.value ?? null, updated_by_user_id: ctx.user.id, updated_at: new Date().toISOString(),
    }, { onConflict: "setting_key" });
    if (settingError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر حفظ إعداد الحماية في Supabase." });
    const { error: eventError } = await admin.from("platform_security_events").insert({
      event_type: "security_change", severity: "info", status: "success", title: `تحديث إعداد الحماية: ${input.settingKey}`,
      created_by_user_id: ctx.user.id, metadata: { isEnabled: input.isEnabled },
    });
    if (eventError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تم حفظ الإعداد لكن تعذر تدوين حدث الأمان." });
    return { success: true };
  }),

  advancedDashboard: platformAdminProcedure.query(async () => {
    const { data, error } = await supabaseAdmin().rpc("powerhub_advanced_dashboard");
    if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل لوحة التحليلات المركزية من Supabase." });
    const dashboard = (data as Array<Record<string, unknown>> | null)?.[0];
    if (!dashboard) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "لم تُعد دالة لوحة التحليلات استجابة صالحة." });
    const records = (value: unknown): Array<Record<string, unknown>> => Array.isArray(value)
      ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
      : [];
    const rawKpis = dashboard.kpis && typeof dashboard.kpis === "object" ? dashboard.kpis as Record<string, unknown> : {};
    return {
      kpis: { activeGenerators: Number(rawKpis.activeGenerators ?? 0), subscribers: Number(rawKpis.subscribers ?? 0), dailyConsumption: Number(rawKpis.dailyConsumption ?? 0), monthlyConsumption: Number(rawKpis.monthlyConsumption ?? 0), monthlyCollections: Number(rawKpis.monthlyCollections ?? 0), openComplaints: Number(rawKpis.openComplaints ?? 0), generatorsToReview: Number(rawKpis.generatorsToReview ?? 0), collectionRate: Number(rawKpis.collectionRate ?? 0) },
      monthlyGrowth: records(dashboard.monthly_growth).flatMap((item) => typeof item.month === "string" ? [{ month: item.month, count: Number(item.count ?? 0) }] : []),
      consumptionByRegion: records(dashboard.consumption_by_region).flatMap((item) => typeof item.region === "string" ? [{ region: item.region, consumptionKwh: Number(item.consumptionKwh ?? 0) }] : []),
      collectionsByGenerator: records(dashboard.collections_by_generator).flatMap((item) => typeof item.generatorName === "string" && typeof item.code === "string" && typeof item.tenantName === "string" ? [{ generatorId: Number(item.generatorId), generatorName: item.generatorName, code: item.code, tenantName: item.tenantName, amount: Number(item.amount ?? 0) }] : []),
      latestGenerators: records(dashboard.latest_generators).flatMap((item) => typeof item.name === "string" && typeof item.code === "string" && typeof item.status === "string" && typeof item.tenantName === "string" ? [{ id: Number(item.id), name: item.name, code: item.code, status: item.status, tenantName: item.tenantName, createdAt: new Date(String(item.createdAt)) }] : []),
      recentComplaints: records(dashboard.recent_complaints).flatMap((item) => typeof item.title === "string" && typeof item.priority === "string" && typeof item.status === "string" && typeof item.tenantName === "string" && typeof item.siteName === "string" ? [{ id: Number(item.id), title: item.title, priority: item.priority, status: item.status, tenantName: item.tenantName, siteName: item.siteName, openedAt: new Date(String(item.openedAt)) }] : []),
      expiringSubscriptions: records(dashboard.expiring_subscriptions).flatMap((item) => typeof item.tenantName === "string" && typeof item.status === "string" ? [{ tenantId: Number(item.tenantId), tenantName: item.tenantName, ownerName: typeof item.ownerName === "string" ? item.ownerName : null, endsAt: new Date(String(item.endsAt)), status: item.status }] : []),
    };
  }),

  globalSearch: platformAdminProcedure.input(z.object({ query: z.string().trim().min(2).max(100) })).query(async ({ input }) => {
    const admin = supabaseAdmin();
    const term = containsSearchPattern(input.query);
    const [generatorNameResult, generatorCodeResult, subscriberNameResult, subscriberNumberResult, subscriberPhoneResult, ownerNameResult, ownerPhoneResult] = await Promise.all([
      admin.from("generators").select("id, name, code, tenant_id").ilike("name", term).limit(20),
      admin.from("generators").select("id, name, code, tenant_id").ilike("code", term).limit(20),
      admin.from("subscribers").select("id, full_name, subscriber_no, phone, tenant_id").ilike("full_name", term).limit(20),
      admin.from("subscribers").select("id, full_name, subscriber_no, phone, tenant_id").ilike("subscriber_no", term).limit(20),
      admin.from("subscribers").select("id, full_name, subscriber_no, phone, tenant_id").ilike("phone", term).limit(20),
      admin.from("tenant_owner_profiles").select("id, full_name, phone, tenant_id").ilike("full_name", term).limit(20),
      admin.from("tenant_owner_profiles").select("id, full_name, phone, tenant_id").ilike("phone", term).limit(20),
    ]);
    const resultSets = [generatorNameResult, generatorCodeResult, subscriberNameResult, subscriberNumberResult, subscriberPhoneResult, ownerNameResult, ownerPhoneResult];
    if (resultSets.some((result) => result.error)) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تنفيذ البحث المركزي من Supabase." });
    const uniqueById = <T extends { id: number | string }>(items: T[]) => Array.from(new Map(items.map((item) => [Number(item.id), item])).values()).slice(0, 20);
    const generatorsFound = uniqueById([...(generatorNameResult.data ?? []), ...(generatorCodeResult.data ?? [])]);
    const subscribersFound = uniqueById([...(subscriberNameResult.data ?? []), ...(subscriberNumberResult.data ?? []), ...(subscriberPhoneResult.data ?? [])]);
    const ownersFound = uniqueById([...(ownerNameResult.data ?? []), ...(ownerPhoneResult.data ?? [])]);
    const tenantIds = Array.from(new Set([...generatorsFound, ...subscribersFound, ...ownersFound].map((item) => Number(item.tenant_id))));
    const tenantResult = tenantIds.length
      ? await admin.from("tenants").select("id, name").in("id", tenantIds)
      : { data: [], error: null };
    if (tenantResult.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل أسماء مساحات نتائج البحث من Supabase." });
    const tenantNameById = new Map((tenantResult.data ?? []).map((tenant) => [Number(tenant.id), tenant.name]));
    return [
      ...generatorsFound.map((generator) => ({ id: Number(generator.id), label: generator.name, reference: generator.code, tenantName: tenantNameById.get(Number(generator.tenant_id)) ?? "مساحة غير معروفة", kind: "generator" as const })),
      ...subscribersFound.map((subscriber) => ({ id: Number(subscriber.id), label: subscriber.full_name, reference: subscriber.subscriber_no, tenantName: tenantNameById.get(Number(subscriber.tenant_id)) ?? "مساحة غير معروفة", kind: "subscriber" as const })),
      ...ownersFound.map((owner) => ({ id: Number(owner.id), label: owner.full_name, reference: owner.phone, tenantName: tenantNameById.get(Number(owner.tenant_id)) ?? "مساحة غير معروفة", kind: "owner" as const })),
    ];
  }),

  listComplaints: platformAdminProcedure.input(z.object({ status: z.enum(["open", "assigned", "in_progress", "resolved", "closed"]).optional() }).optional()).query(async ({ input }) => {
    const complaintsQuery = supabaseAdmin().from("complaints")
      .select("id, tenant_id, site_id, subscriber_id, title, description, priority, status, assigned_user_id, response, opened_at, resolved_at")
      .order("opened_at", { ascending: false }).limit(300);
    const complaintsResult = input?.status
      ? await complaintsQuery.eq("status", input.status)
      : await complaintsQuery;
    if (complaintsResult.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل الشكاوى من Supabase." });
    const rows = complaintsResult.data ?? [];
    const tenantIds = Array.from(new Set(rows.map((complaint) => Number(complaint.tenant_id))));
    const siteIds = Array.from(new Set(rows.map((complaint) => Number(complaint.site_id))));
    const subscriberIds = Array.from(new Set(rows.flatMap((complaint) => complaint.subscriber_id === null ? [] : [Number(complaint.subscriber_id)])));
    const assignedUserIds = Array.from(new Set(rows.flatMap((complaint) => complaint.assigned_user_id === null ? [] : [Number(complaint.assigned_user_id)])));
    const [tenantResult, siteResult, subscriberResult, assignedUserResult] = await Promise.all([
      tenantIds.length ? supabaseAdmin().from("tenants").select("id, name").in("id", tenantIds) : Promise.resolve({ data: [], error: null }),
      siteIds.length ? supabaseAdmin().from("sites").select("id, name").in("id", siteIds) : Promise.resolve({ data: [], error: null }),
      subscriberIds.length ? supabaseAdmin().from("subscribers").select("id, full_name").in("id", subscriberIds) : Promise.resolve({ data: [], error: null }),
      assignedUserIds.length ? supabaseAdmin().from("users").select("id, name").in("id", assignedUserIds) : Promise.resolve({ data: [], error: null }),
    ]);
    if (tenantResult.error || siteResult.error || subscriberResult.error || assignedUserResult.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل البيانات المرجعية للشكاوى من Supabase." });
    const tenantById = new Map((tenantResult.data ?? []).map((tenant) => [Number(tenant.id), tenant.name]));
    const siteById = new Map((siteResult.data ?? []).map((site) => [Number(site.id), site.name]));
    const subscriberById = new Map((subscriberResult.data ?? []).map((subscriber) => [Number(subscriber.id), subscriber.full_name]));
    const assignedUserById = new Map((assignedUserResult.data ?? []).map((user) => [Number(user.id), user.name]));
    return rows.map((complaint) => ({
      id: Number(complaint.id), title: complaint.title, description: complaint.description, priority: complaint.priority, status: complaint.status,
      response: complaint.response, openedAt: new Date(complaint.opened_at), resolvedAt: complaint.resolved_at ? new Date(complaint.resolved_at) : null,
      tenantId: Number(complaint.tenant_id), tenantName: tenantById.get(Number(complaint.tenant_id)) ?? "مساحة غير معروفة",
      siteName: siteById.get(Number(complaint.site_id)) ?? "فرع غير معروف",
      subscriberName: complaint.subscriber_id === null ? null : subscriberById.get(Number(complaint.subscriber_id)) ?? null,
      assignedUserId: complaint.assigned_user_id === null ? null : Number(complaint.assigned_user_id),
      assignedUserName: complaint.assigned_user_id === null ? null : assignedUserById.get(Number(complaint.assigned_user_id)) ?? null,
    }));
  }),

  updateComplaint: platformAdminProcedure.input(z.object({ id: z.number().int().positive(), status: z.enum(["open", "assigned", "in_progress", "resolved", "closed"]), assignedUserId: z.number().int().positive().nullable().optional(), response: z.string().max(4000).optional() })).mutation(async ({ ctx, input }) => {
    assertLegacyAdminWriteMigrationGuard("تحديث الشكوى");
    const db = await dbOrThrow(); const [complaint] = await db.select().from(complaints).where(eq(complaints.id, input.id)).limit(1);
    if (!complaint) throw new TRPCError({ code: "NOT_FOUND", message: "الشكوى غير موجودة." });
    await db.update(complaints).set({ status: input.status, assignedUserId: input.assignedUserId, response: input.response, resolvedAt: input.status === "resolved" || input.status === "closed" ? new Date() : null }).where(eq(complaints.id, input.id));
    await db.insert(auditLogs).values({ tenantId: complaint.tenantId, siteId: complaint.siteId, userId: ctx.user.id, entityType: "complaint", entityId: String(complaint.id), action: "platform_admin_update_complaint", afterData: { status: input.status, assignedUserId: input.assignedUserId } });
    return { success: true };
  }),

  listTariffPolicies: platformAdminProcedure.query(async () => {
    const policiesResult = await supabaseAdmin().from("platform_tariff_policies")
      .select("id, minimum_price_per_kwh, maximum_price_per_kwh, effective_from, notification_requested, notes, created_by_user_id, created_at")
      .order("effective_from", { ascending: false }).limit(100);
    if (policiesResult.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل سياسات التسعير من Supabase." });
    const creatorIds = Array.from(new Set((policiesResult.data ?? []).map((policy) => Number(policy.created_by_user_id))));
    const creatorsResult = creatorIds.length
      ? await supabaseAdmin().from("users").select("id, name").in("id", creatorIds)
      : { data: [], error: null };
    if (creatorsResult.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل منشئي سياسات التسعير من Supabase." });
    const creatorNameById = new Map((creatorsResult.data ?? []).map((creator) => [Number(creator.id), creator.name]));
    return (policiesResult.data ?? []).map((policy) => ({
      id: Number(policy.id), minimumPricePerKwh: String(policy.minimum_price_per_kwh), maximumPricePerKwh: String(policy.maximum_price_per_kwh),
      effectiveFrom: new Date(policy.effective_from), notificationRequested: policy.notification_requested, notes: policy.notes,
      createdAt: new Date(policy.created_at), createdBy: creatorNameById.get(Number(policy.created_by_user_id)) ?? null,
    }));
  }),

  createTariffPolicy: platformAdminProcedure.input(z.object({ minimumPricePerKwh: z.number().nonnegative(), maximumPricePerKwh: z.number().positive(), effectiveFrom: z.date(), notificationRequested: z.boolean().default(false), notes: z.string().max(2000).optional() }).refine((input) => input.maximumPricePerKwh >= input.minimumPricePerKwh, { message: "الحد الأقصى يجب أن يساوي أو يتجاوز الحد الأدنى.", path: ["maximumPricePerKwh"] })).mutation(async ({ ctx, input }) => {
    assertLegacyAdminWriteMigrationGuard("إنشاء سياسة تسعير");
    const db = await dbOrThrow(); await db.insert(platformTariffPolicies).values({ ...input, minimumPricePerKwh: String(input.minimumPricePerKwh), maximumPricePerKwh: String(input.maximumPricePerKwh), createdByUserId: ctx.user.id });
    let queuedNotifications = 0;
    if (input.notificationRequested) {
      const [ownerSites, messaging] = await Promise.all([
        db.select({ tenantId: tenantOwnerProfiles.tenantId, phone: tenantOwnerProfiles.phone, siteId: sites.id }).from(tenantOwnerProfiles).innerJoin(sites, eq(tenantOwnerProfiles.tenantId, sites.tenantId)),
        db.select({ tenantId: tenantMessagingConfigurations.tenantId, channel: tenantMessagingConfigurations.channel, isActive: tenantMessagingConfigurations.isActive }).from(tenantMessagingConfigurations),
      ]);
      const targetByTenant = new Map<number, { phone: string; siteId: number }>();
      ownerSites.forEach((row) => { if (!targetByTenant.has(row.tenantId)) targetByTenant.set(row.tenantId, { phone: row.phone, siteId: row.siteId }); });
      const channelsByTenant = new Map<number, Array<"whatsapp" | "sms">>();
      messaging.filter((row) => row.isActive).forEach((row) => channelsByTenant.set(row.tenantId, [...(channelsByTenant.get(row.tenantId) ?? []), row.channel]));
      const pending = Array.from(targetByTenant.entries()).flatMap(([tenantId, target]) => (channelsByTenant.get(tenantId) ?? ["whatsapp"]).map((channel) => ({ tenantId, channel, eventType: "service_alert" as const, recipient: target.phone, status: "pending" as const, payload: { type: "platform_tariff_policy", minimumPricePerKwh: input.minimumPricePerKwh, maximumPricePerKwh: input.maximumPricePerKwh, effectiveFrom: input.effectiveFrom, siteId: target.siteId } })));
      if (pending.length) { await db.insert(notificationMessages).values(pending); queuedNotifications = pending.length; }
    }
    await db.insert(platformSecurityEvents).values({ eventType: "security_change", severity: "info", status: "success", title: "تحديث التسعيرة الرسمية", createdByUserId: ctx.user.id, metadata: { ...input, notificationDeferred: input.notificationRequested } });
    return { success: true, queuedNotifications };
  }),

  listTenantBranchSettings: platformAdminProcedure.query(async () => {
    const [tenantResult, ownerResult, settingsResult] = await Promise.all([
      supabaseAdmin().from("tenants").select("id, name, plan, status, created_at").order("created_at", { ascending: false }).limit(500),
      supabaseAdmin().from("tenant_owner_profiles").select("tenant_id, full_name").limit(500),
      supabaseAdmin().from("tenant_branch_settings").select("tenant_id, is_enabled_override, max_branches_override, disabled_behavior").limit(500),
    ]);
    if (tenantResult.error || ownerResult.error || settingsResult.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل إعدادات الأفرع من Supabase." });
    const activeBranches: Array<{ tenant_id: number | string }> = [];
    const pageSize = 1_000;
    for (let offset = 0; ; offset += pageSize) {
      const activeSitesResult = await supabaseAdmin().from("sites").select("tenant_id").neq("status", "archived").range(offset, offset + pageSize - 1);
      if (activeSitesResult.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر احتساب الأفرع النشطة من Supabase." });
      const page = activeSitesResult.data ?? [];
      activeBranches.push(...page);
      if (page.length < pageSize) break;
    }
    const ownerNameByTenantId = new Map((ownerResult.data ?? []).map((owner) => [Number(owner.tenant_id), owner.full_name]));
    const settingsByTenantId = new Map((settingsResult.data ?? []).map((setting) => [Number(setting.tenant_id), setting]));
    const countByTenantId = new Map<number, number>();
    activeBranches.forEach((site) => countByTenantId.set(Number(site.tenant_id), (countByTenantId.get(Number(site.tenant_id)) ?? 0) + 1));
    return (tenantResult.data ?? []).map((tenant) => {
      const setting = settingsByTenantId.get(Number(tenant.id));
      return {
        tenantId: Number(tenant.id), tenantName: tenant.name, plan: tenant.plan as "starter" | "professional" | "enterprise", tenantStatus: tenant.status,
        ownerName: ownerNameByTenantId.get(Number(tenant.id)) ?? null,
        isEnabledOverride: setting?.is_enabled_override ?? null, maxBranchesOverride: setting?.max_branches_override ?? null,
        disabledBehavior: setting?.disabled_behavior ?? "read_only", currentBranchCount: countByTenantId.get(Number(tenant.id)) ?? 0,
      };
    });
  }),

  saveTenantBranchSettings: platformAdminProcedure.input(z.object({
    tenantId: z.number().int().positive(),
    isEnabledOverride: z.boolean().nullable(),
    maxBranchesOverride: z.number().int().min(1).max(1000).nullable(),
    disabledBehavior: z.enum(["read_only", "suspended"]).default("read_only"),
  })).mutation(async ({ ctx, input }) => {
    assertLegacyAdminWriteMigrationGuard("حفظ إعدادات فروع صاحب المولد");
    const db = await dbOrThrow();
    const [tenant] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, input.tenantId)).limit(1);
    if (!tenant) throw new TRPCError({ code: "NOT_FOUND", message: "صاحب المولد غير موجود." });
    await db.insert(tenantBranchSettings).values(input).onDuplicateKeyUpdate({ set: { isEnabledOverride: input.isEnabledOverride, maxBranchesOverride: input.maxBranchesOverride, disabledBehavior: input.disabledBehavior, updatedAt: new Date() } });
    const [site] = await db.select({ id: sites.id }).from(sites).where(eq(sites.tenantId, input.tenantId)).limit(1);
    if (site) await db.insert(auditLogs).values({ tenantId: input.tenantId, siteId: site.id, userId: ctx.user.id, entityType: "tenant_branch_settings", entityId: String(input.tenantId), action: "platform_admin_update_branch_settings", afterData: input, actorPlatformRole: platformRoleOf(ctx.user) });
    await db.insert(platformSecurityEvents).values({ eventType: "security_change", severity: "info", status: "success", title: "تحديث تفعيل الأفرع لصاحب مولد", createdByUserId: ctx.user.id, metadata: input });
    return { success: true };
  }),

  platformConfiguration: platformAdminProcedure.query(async () => {
    const [settingsResult, recoveryResult, tariffResult] = await Promise.all([
      supabaseAdmin().from("platform_settings").select("id, setting_key, is_enabled, value, message, updated_by_user_id, updated_at").order("setting_key", { ascending: true }).limit(200),
      supabaseAdmin().from("access_recovery_requests").select("id, tenant_id, method, status, note, created_at").order("created_at", { ascending: false }).limit(100),
      supabaseAdmin().from("platform_tariff_policies").select("id, minimum_price_per_kwh, maximum_price_per_kwh, effective_from, notification_requested, notes, created_by_user_id, created_at").order("effective_from", { ascending: false }).limit(1).maybeSingle(),
    ]);
    if (settingsResult.error || recoveryResult.error || tariffResult.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل إعدادات المنصة من Supabase." });
    const tenantIds = Array.from(new Set((recoveryResult.data ?? []).map((recovery) => Number(recovery.tenant_id))));
    const [tenantResult, ownerResult] = await Promise.all([
      tenantIds.length ? supabaseAdmin().from("tenants").select("id, name").in("id", tenantIds) : Promise.resolve({ data: [], error: null }),
      tenantIds.length ? supabaseAdmin().from("tenant_owner_profiles").select("tenant_id, full_name").in("tenant_id", tenantIds) : Promise.resolve({ data: [], error: null }),
    ]);
    if (tenantResult.error || ownerResult.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل بيانات طلبات الاسترداد من Supabase." });
    const tenantById = new Map((tenantResult.data ?? []).map((tenant) => [Number(tenant.id), tenant.name]));
    const ownerByTenantId = new Map((ownerResult.data ?? []).map((owner) => [Number(owner.tenant_id), owner.full_name]));
    return {
      settings: (settingsResult.data ?? []).map((setting) => ({ id: Number(setting.id), settingKey: setting.setting_key, isEnabled: setting.is_enabled, value: setting.value, message: setting.message, updatedByUserId: setting.updated_by_user_id === null ? null : Number(setting.updated_by_user_id), updatedAt: new Date(setting.updated_at) })),
      recoveries: (recoveryResult.data ?? []).map((recovery) => ({ id: Number(recovery.id), tenantName: tenantById.get(Number(recovery.tenant_id)) ?? "مساحة غير معروفة", ownerName: ownerByTenantId.get(Number(recovery.tenant_id)) ?? null, method: recovery.method, status: recovery.status, note: recovery.note, createdAt: new Date(recovery.created_at) })),
      currentTariff: tariffResult.data ? { id: Number(tariffResult.data.id), minimumPricePerKwh: Number(tariffResult.data.minimum_price_per_kwh), maximumPricePerKwh: Number(tariffResult.data.maximum_price_per_kwh), effectiveFrom: new Date(tariffResult.data.effective_from), notificationRequested: tariffResult.data.notification_requested, notes: tariffResult.data.notes, createdByUserId: Number(tariffResult.data.created_by_user_id), createdAt: new Date(tariffResult.data.created_at) } : null,
    };
  }),

  savePlatformSetting: platformAdminProcedure.input(z.object({ settingKey: z.string().min(2).max(100), isEnabled: z.boolean(), message: z.string().max(4000).optional(), value: z.record(z.string(), z.unknown()).optional() })).mutation(async ({ ctx, input }) => {
    assertLegacyAdminWriteMigrationGuard("حفظ إعدادات المنصة");
    const db = await dbOrThrow(); await db.insert(platformSettings).values({ ...input, updatedByUserId: ctx.user.id }).onDuplicateKeyUpdate({ set: { isEnabled: input.isEnabled, message: input.message, value: input.value, updatedByUserId: ctx.user.id } });
    await db.insert(platformSecurityEvents).values({ eventType: "security_change", severity: input.settingKey === "maintenance_mode" ? "warning" : "info", status: "success", title: `تحديث إعداد المنصة: ${input.settingKey}`, createdByUserId: ctx.user.id, metadata: { isEnabled: input.isEnabled } }); return { success: true };
  }),

  requestOwnerAccessRecovery: platformAdminProcedure.input(z.object({ tenantId: z.number().int().positive(), note: z.string().max(2000).optional() })).mutation(async ({ ctx, input }) => {
    assertLegacyAdminWriteMigrationGuard("طلب استرداد وصول صاحب المولد");
    const db = await dbOrThrow(); const [owner] = await db.select().from(tenantOwnerProfiles).where(eq(tenantOwnerProfiles.tenantId, input.tenantId)).limit(1); if (!owner) throw new TRPCError({ code: "NOT_FOUND", message: "ملف مالك المولد غير موجود." });
    await db.insert(accessRecoveryRequests).values({ tenantId: input.tenantId, ownerUserId: owner.ownerUserId, requestedByUserId: ctx.user.id, method: "oauth_invite", status: "pending", note: input.note });
    const [site] = await db.select().from(sites).where(eq(sites.tenantId, input.tenantId)).limit(1); if (site) await db.insert(auditLogs).values({ tenantId: input.tenantId, siteId: site.id, userId: ctx.user.id, entityType: "access_recovery", entityId: String(input.tenantId), action: "platform_admin_request_owner_access_recovery" });
    return { success: true, delivery: "deferred" as const };
  }),

  rolePolicies: platformAdminProcedure.query(async () => {
    const { data, error } = await supabaseAdmin().from("platform_role_policies")
      .select("id, role, capability, is_allowed, updated_by_user_id, updated_at").order("role", { ascending: true }).order("capability", { ascending: true }).limit(200);
    if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل سياسات صلاحيات المنصة من Supabase." });
    return (data ?? []).map((policy) => ({
      id: Number(policy.id), role: policy.role, capability: policy.capability, isAllowed: policy.is_allowed,
      updatedByUserId: policy.updated_by_user_id === null ? null : Number(policy.updated_by_user_id), updatedAt: new Date(policy.updated_at),
    }));
  }),

  saveRolePolicy: platformAdminProcedure.input(z.object({ role: z.enum(["owner", "manager", "accountant", "collector", "technician", "viewer"]), capability: z.enum(["manageSubscribers", "manageGenerators", "recordReadings", "accessFieldApp", "approveReadings", "manageTariffs", "issueInvoices", "collectPayments", "manageExpenses", "managePayroll", "manageTeam", "manageMessaging", "viewAudit"]), isAllowed: z.boolean() })).mutation(async ({ ctx, input }) => {
    assertLegacyAdminWriteMigrationGuard("حفظ سياسة صلاحيات المنصة");
    const db = await dbOrThrow();
    await db.insert(platformRolePolicies).values({ ...input, updatedByUserId: ctx.user.id }).onDuplicateKeyUpdate({ set: { isAllowed: input.isAllowed, updatedByUserId: ctx.user.id } });
    await db.insert(platformSecurityEvents).values({ eventType: "security_change", severity: "warning", status: "success", title: `تحديث سياسة الدور: ${input.role}`, createdByUserId: ctx.user.id, metadata: input });
    return { success: true };
  }),

  impersonationStatus: platformAdminProcedure.query(() => ({ enabled: false as const, confirmationRequired: true as const, reason: "انتحال جلسة مالك المولد معطّل إلى حين اعتماد سياسة أمان مستقلة وموافقة قانونية وسجل تدقيق غير قابل للتعديل." })),

  generatorDetails: platformAdminProcedure.input(z.object({ generatorId: z.number().int().positive() })).query(async ({ input }) => {
    const admin = supabaseAdmin();
    const { data: generatorRow, error: generatorError } = await admin.from("generators")
      .select("id, code, name, status, rated_capacity_kw, fuel_type, fuel_level_liters, operating_hours, last_maintenance_at, tenant_id, site_id")
      .eq("id", input.generatorId).maybeSingle();
    if (generatorError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل تفاصيل المولد من Supabase." });
    if (!generatorRow) throw new TRPCError({ code: "NOT_FOUND", message: "المولد غير موجود." });
    const [tenantResult, siteResult, activityResult] = await Promise.all([
      admin.from("tenants").select("id, name").eq("id", generatorRow.tenant_id).maybeSingle(),
      admin.from("sites").select("id, name").eq("id", generatorRow.site_id).maybeSingle(),
      admin.from("audit_logs").select("id, action, entity_type, created_at, user_id").eq("site_id", generatorRow.site_id).order("created_at", { ascending: false }).limit(30),
    ]);
    if (tenantResult.error || siteResult.error || activityResult.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل البيانات المرجعية لتفاصيل المولد من Supabase." });
    if (!tenantResult.data || !siteResult.data) throw new TRPCError({ code: "NOT_FOUND", message: "المولد غير موجود." });
    const activityRows = activityResult.data ?? [];
    const actorUserIds = Array.from(new Set(activityRows.flatMap((activity) => activity.user_id === null ? [] : [Number(activity.user_id)])));
    const actorResult = actorUserIds.length
      ? await admin.from("users").select("id, name").in("id", actorUserIds)
      : { data: [], error: null };
    if (actorResult.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل منفذي سجل نشاط المولد من Supabase." });
    const actorNameById = new Map((actorResult.data ?? []).map((actor) => [Number(actor.id), actor.name]));
    const generator = {
      id: Number(generatorRow.id), code: generatorRow.code, name: generatorRow.name, status: generatorRow.status,
      ratedCapacityKw: String(generatorRow.rated_capacity_kw), fuelType: generatorRow.fuel_type,
      fuelLevelLiters: String(generatorRow.fuel_level_liters), operatingHours: String(generatorRow.operating_hours),
      lastMaintenanceAt: generatorRow.last_maintenance_at ? new Date(generatorRow.last_maintenance_at) : null,
      tenantId: Number(generatorRow.tenant_id), tenantName: tenantResult.data.name, siteId: Number(generatorRow.site_id), siteName: siteResult.data.name,
    };
    const activity = activityRows.map((entry) => ({
      id: Number(entry.id), action: entry.action, entityType: entry.entity_type, createdAt: new Date(entry.created_at),
      userName: entry.user_id === null ? null : actorNameById.get(Number(entry.user_id)) ?? null,
    }));
    return {
      generator,
      activity,
      subscriberSummary: { total: 0, active: 0 },
      subscribers: [] as Array<{ id: number; fullName: string; subscriberNo: string; phone: string; subscriptionType: "residential" | "commercial"; serviceStatus: "active" | "suspended" | "disconnected" }>,
      invoices: [] as Array<{ id: number; invoiceNo: string; billingPeriod: string; totalAmount: string; balanceDue: string; status: "draft" | "issued" | "partially_paid" | "paid" | "overdue" | "cancelled"; subscriberName: string; issueDate: Date }>,
    };
  }),
});
