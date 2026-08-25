import crypto from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, gte, inArray, like, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { accessInvitations, accessRecoveryRequests, auditLogs, complaints, generators, invoices, meterReadings, meters, mobileSyncEvents, notificationMessages, payments, platformAccessInvitations, platformRolePolicies, platformSecurityEvents, platformSecuritySettings, platformSettings, platformTariffPolicies, platformSmsFallbackProviders, platformTweetSmsAccounts, platformTweetSmsBalanceAlerts, sitePortalSettings, sites, staffProfiles, subscribers, subscriptionUpgradeRequests, platformSmsPlans, smsPackageRequests, tenantBranchSettings, tenantMembers, tenantMessagingConfigurations, tenantOwnerProfiles, tenantSubscriptions, tenantTweetSmsAccounts, tenants, users } from "../drizzle/schema";
import { getDb, syncSupabaseUser } from "./db";
import { authenticatedProcedure, router } from "./_core/trpc";
import { decryptTenantCredential, encryptTenantCredential } from "./tenant-crypto";
import { supabaseAdmin } from "./supabase-admin";
import { syncSupabaseProfile } from "./supabase-profile";
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

async function resolveOwnerLoginAccount(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, input: { email: string; name: string; temporaryPassword: string }) {
  const [existing] = await db.select({ id: users.id, openId: users.openId, role: users.role, platformRole: users.platformRole }).from(users).where(eq(users.email, input.email)).limit(1);
  if (existing) {
    if (isPlatformAccount(existing)) throw new TRPCError({ code: "FORBIDDEN", message: platformAccountOwnerMessage });
    const { data, error } = await supabaseAdmin().auth.admin.getUserById(existing.openId);
    if (error || !data.user) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "الحساب المحلي موجود لكن مصادقة Supabase غير متاحة. استخدم إجراء إصلاح الوصول أولاً." });
    return { ownerUser: existing, createdSupabaseUserId: null as string | null };
  }
  const { data: created, error: createError } = await supabaseAdmin().auth.admin.createUser({
    email: input.email,
    password: input.temporaryPassword,
    email_confirm: true,
    user_metadata: { name: input.name },
  });
  if (createError || !created.user) throw new TRPCError({ code: "BAD_REQUEST", message: "تعذر إنشاء حساب صاحب المولد في Supabase. قد يكون البريد مستخدماً بالفعل." });
  const ownerUser = await syncSupabaseUser({ id: created.user.id, email: input.email, name: input.name });
  return { ownerUser, createdSupabaseUserId: created.user.id };
}

async function resolveOwnerLoginAccountFromSupabase(input: { email: string; name: string; temporaryPassword: string }) {
  const admin = supabaseAdmin();
  const { data: existing, error: existingError } = await admin.from("users")
    .select("id, auth_user_id, role, platform_role").eq("email", input.email).maybeSingle();
  if (existingError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر فحص حساب صاحب المولد في Supabase." });
  if (existing) {
    if (existing.role === "admin" || existing.platform_role) throw new TRPCError({ code: "FORBIDDEN", message: platformAccountOwnerMessage });
    const { data, error } = await admin.auth.admin.getUserById(existing.auth_user_id);
    if (error || !data.user) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "ملف الحساب موجود لكن مستخدم Supabase غير متاح. استخدم إجراء إصلاح الوصول أولاً." });
    return { ownerUser: { id: Number(existing.id) }, createdSupabaseUserId: null as string | null };
  }
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email: input.email, password: input.temporaryPassword, email_confirm: true, user_metadata: { name: input.name },
  });
  if (createError || !created.user) throw new TRPCError({ code: "BAD_REQUEST", message: "تعذر إنشاء حساب صاحب المولد في Supabase. قد يكون البريد مستخدماً بالفعل." });
  const ownerUser = await syncSupabaseProfile({ id: created.user.id, email: input.email, name: input.name });
  return { ownerUser, createdSupabaseUserId: created.user.id };
}

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
    ownerWhatsapp: z.string().min(5).max(30),
    ownerEmail: z.string().email(),
    temporaryPassword: z.string().min(8).max(128),
    plan: planSchema.default("starter"),
  })).mutation(async ({ ctx, input }) => {
    {
      const admin = supabaseAdmin();
      const email = input.ownerEmail.trim().toLowerCase();
      const phone = input.ownerPhone.trim();
      const whatsappNumber = input.ownerWhatsapp.trim();
      const companyName = input.companyName.trim();
      const { data: existingPhone, error: phoneError } = await admin.from("tenant_owner_profiles").select("id").eq("phone", phone).maybeSingle();
      if (phoneError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر فحص رقم جوال صاحب المولد في Supabase." });
      if (existingPhone) throw new TRPCError({ code: "CONFLICT", message: "رقم جوال صاحب المولد مستخدم بالفعل." });
      const { ownerUser, createdSupabaseUserId } = await resolveOwnerLoginAccountFromSupabase({ email, name: input.ownerName, temporaryPassword: input.temporaryPassword });
      let tenantId: number | null = null;
      try {
        const startedAt = new Date();
        const tenantSlug = `owner-${crypto.randomBytes(6).toString("hex")}`;
        const siteCode = `SITE-${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
        const identity = encryptTenantCredential(input.identityNumber.trim());
        const { data: tenant, error: tenantError } = await admin.from("tenants").insert({ name: companyName, slug: tenantSlug, plan: input.plan, status: "active" }).select("id").single();
        if (tenantError || !tenant) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر إنشاء مساحة صاحب المولد في Supabase." });
        tenantId = Number(tenant.id);
        const { error: profileError } = await admin.from("tenant_owner_profiles").insert({ tenant_id: tenantId, owner_user_id: ownerUser.id, full_name: input.ownerName, phone, whatsapp_number: whatsappNumber, email, company_name: companyName, identity_number_ciphertext: identity.ciphertext, identity_number_iv: identity.iv, identity_number_last4: input.identityNumber.trim().slice(-4), invited_at: startedAt.toISOString(), claimed_at: startedAt.toISOString() });
        if (profileError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر حفظ ملف صاحب المولد في Supabase." });
        const { error: subscriptionError } = await admin.from("tenant_subscriptions").insert({ tenant_id: tenantId, plan: input.plan, status: "trial", billing_cycle: "monthly", started_at: startedAt.toISOString(), ends_at: addSubscriptionPeriod(startedAt, "monthly").toISOString() });
        if (subscriptionError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر إنشاء اشتراك صاحب المولد في Supabase." });
        const { data: site, error: siteError } = await admin.from("sites").insert({ tenant_id: tenantId, name: companyName, code: siteCode }).select("id").single();
        if (siteError || !site) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر إنشاء الفرع الرئيسي في Supabase." });
        const siteId = Number(site.id);
        const setupResults = await Promise.all([
          admin.from("site_portal_settings").insert({ tenant_id: tenantId, site_id: siteId, portal_code: siteCode.toLowerCase(), display_name: companyName }),
          admin.from("tenant_members").insert({ tenant_id: tenantId, user_id: ownerUser.id, role: "owner", is_active: true, membership_status: "active", invited_by_user_id: ctx.user.id }),
          admin.from("staff_profiles").insert({ tenant_id: tenantId, site_id: siteId, user_id: ownerUser.id, role: "owner", is_active: true }),
          admin.from("users").update({ role: "user", platform_role: null, account_status: "active", must_change_password: true, temporary_password_issued_at: startedAt.toISOString() }).eq("id", ownerUser.id),
        ]);
        if (setupResults.some((result) => result.error)) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر إكمال تهيئة مساحة صاحب المولد في Supabase." });
        const { error: auditError } = await admin.from("audit_logs").insert({ tenant_id: tenantId, site_id: siteId, user_id: ctx.user.id, entity_type: "tenant_owner_profile", entity_id: String(tenantId), action: "platform_admin_create_generator_owner_subscription", after_data: { companyName, ownerName: input.ownerName, ownerEmail: email, plan: input.plan, generatorSetup: "deferred" }, actor_platform_role: platformRoleOf(ctx.user) });
        if (auditError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تم إنشاء المساحة لكن تعذر تسجيل التدقيق في Supabase." });
        return { tenantId, siteId, ownerUserId: ownerUser.id, forcePasswordChange: true };
      } catch (error) {
        if (tenantId) await admin.from("tenants").delete().eq("id", tenantId);
        if (createdSupabaseUserId !== null) await supabaseAdmin().auth.admin.deleteUser(createdSupabaseUserId);
        throw error;
      }
    }
    const db = await dbOrThrow();
    const email = input.ownerEmail.trim().toLowerCase();
    const phone = input.ownerPhone.trim();
    const whatsappNumber = input.ownerWhatsapp.trim();
    const companyName = input.companyName.trim();
    const [[existingPhone]] = await Promise.all([
      db.select({ id: tenantOwnerProfiles.id }).from(tenantOwnerProfiles).where(eq(tenantOwnerProfiles.phone, phone)).limit(1),
    ]);
    if (existingPhone) throw new TRPCError({ code: "CONFLICT", message: "رقم جوال صاحب المولد مستخدم بالفعل." });
    const { ownerUser, createdSupabaseUserId } = await resolveOwnerLoginAccount(db, { email, name: input.ownerName, temporaryPassword: input.temporaryPassword });

    try {
      const startedAt = new Date();
      const tenantSlug = `owner-${crypto.randomBytes(6).toString("hex")}`;
      const siteCode = `SITE-${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
      const identity = encryptTenantCredential(input.identityNumber.trim());
      const result = await db.transaction(async (tx) => {
        const tenantId = insertId(await tx.insert(tenants).values({ name: companyName, slug: tenantSlug, plan: input.plan, status: "active" }));
        await tx.insert(tenantOwnerProfiles).values({
          tenantId,
          ownerUserId: ownerUser.id,
          fullName: input.ownerName,
          phone,
          whatsappNumber,
          email,
          companyName,
          identityNumberCiphertext: identity.ciphertext,
          identityNumberIv: identity.iv,
          identityNumberLast4: input.identityNumber.trim().slice(-4),
          invitedAt: startedAt,
          claimedAt: startedAt,
        });
        await tx.insert(tenantSubscriptions).values({ tenantId, plan: input.plan, status: "trial", billingCycle: "monthly", startedAt, endsAt: addSubscriptionPeriod(startedAt, "monthly") });
        const siteId = insertId(await tx.insert(sites).values({ tenantId, name: companyName, code: siteCode }));
        await tx.insert(sitePortalSettings).values({ tenantId, siteId, portalCode: siteCode.toLowerCase(), displayName: companyName });
        await tx.insert(tenantMembers).values({ tenantId, userId: ownerUser.id, role: "owner", isActive: true, membershipStatus: "active", invitedByUserId: ctx.user.id });
        await tx.insert(staffProfiles).values({ tenantId, siteId, userId: ownerUser.id, role: "owner", isActive: true });
        return { tenantId, siteId };
      });
      await db.update(users).set({ role: "user", platformRole: null, accountStatus: "active", mustChangePassword: true, temporaryPasswordIssuedAt: startedAt }).where(eq(users.id, ownerUser.id));
      await db.insert(auditLogs).values({ tenantId: result.tenantId, siteId: result.siteId, userId: ctx.user.id, entityType: "tenant_owner_profile", entityId: String(result.tenantId), action: "platform_admin_create_generator_owner_subscription", afterData: { companyName, ownerName: input.ownerName, ownerEmail: email, plan: input.plan, generatorSetup: "deferred" }, actorPlatformRole: platformRoleOf(ctx.user) });
      return { ...result, ownerUserId: ownerUser.id, forcePasswordChange: true };
    } catch (error) {
      const userIdToDelete = createdSupabaseUserId;
      if (typeof userIdToDelete === "string") await supabaseAdmin().auth.admin.deleteUser(userIdToDelete as string);
      throw error;
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
    const email = input.ownerEmail.trim().toLowerCase();
    const phone = input.ownerPhone.trim();
    const whatsappNumber = input.ownerWhatsapp.trim();
    const generatorName = input.generatorName.trim();
    const db = await dbOrThrow();
    const [[existingPhone], [existingGenerator]] = await Promise.all([
      db.select({ id: tenantOwnerProfiles.id }).from(tenantOwnerProfiles).where(eq(tenantOwnerProfiles.phone, phone)).limit(1),
      db.select({ id: generators.id }).from(generators).where(eq(generators.name, generatorName)).limit(1),
    ]);
    if (existingPhone) throw new TRPCError({ code: "CONFLICT", message: "رقم جوال صاحب المولد مستخدم بالفعل." });
    if (existingGenerator) throw new TRPCError({ code: "CONFLICT", message: "اسم المولد مستخدم بالفعل." });
    const { ownerUser, createdSupabaseUserId } = await resolveOwnerLoginAccount(db, { email, name: input.ownerName, temporaryPassword: input.temporaryPassword });

    try {
      const startedAt = new Date();
      const endsAt = input.endsAt ?? addSubscriptionPeriod(startedAt, input.billingCycle);
      const identity = encryptTenantCredential(input.identityNumber.trim());
      const result = await db.transaction(async (tx) => {
        const tenantId = insertId(await tx.insert(tenants).values({ name: input.tenantName, slug: input.slug, plan: input.plan, status: tenantStatusForSubscription(input.subscriptionStatus) }));
        await tx.insert(tenantOwnerProfiles).values({
          tenantId,
          ownerUserId: ownerUser.id,
          fullName: input.ownerName,
          phone,
          whatsappNumber,
          email,
          companyName: input.companyName,
          identityNumberCiphertext: identity.ciphertext,
          identityNumberIv: identity.iv,
          identityNumberLast4: input.identityNumber.trim().slice(-4),
          invitedAt: startedAt,
          claimedAt: startedAt,
        });
        await tx.insert(tenantSubscriptions).values({ tenantId, plan: input.plan, status: input.subscriptionStatus, billingCycle: input.billingCycle, startedAt, endsAt, autoRenew: input.autoRenew, notes: input.notes });
        const siteId = insertId(await tx.insert(sites).values({ tenantId, name: input.siteName, code: input.siteCode, city: input.city }));
        await tx.insert(sitePortalSettings).values({ tenantId, siteId, portalCode: input.siteCode.toLowerCase(), displayName: input.siteName });
        const generatorId = insertId(await tx.insert(generators).values({ tenantId, siteId, name: generatorName, code: input.generatorCode, ratedCapacityKw: String(input.generatorCapacityKw), fuelType: input.generatorFuelType, status: "pending" }));
        await tx.insert(tenantMembers).values({ tenantId, userId: ownerUser.id, role: "owner", isActive: true, membershipStatus: "active", invitedByUserId: ctx.user.id });
        await tx.insert(staffProfiles).values({ tenantId, siteId, userId: ownerUser.id, role: "owner", isActive: true });
        return { tenantId, siteId, generatorId };
      });
      await db.update(users).set({ role: "user", platformRole: null, accountStatus: "active", mustChangePassword: true, temporaryPasswordIssuedAt: startedAt }).where(eq(users.id, ownerUser.id));
      await db.insert(auditLogs).values({ tenantId: result.tenantId, siteId: result.siteId, userId: ctx.user.id, entityType: "generator", entityId: String(result.generatorId), action: "platform_admin_create_pending_generator_owner", afterData: { tenantName: input.tenantName, ownerName: input.ownerName, ownerEmail: email, generatorName, generatorCode: input.generatorCode, generatorStatus: "pending", plan: input.plan }, actorPlatformRole: platformRoleOf(ctx.user) });
      return { ...result, ownerUserId: ownerUser.id, forcePasswordChange: true };
    } catch (error) {
      if (createdSupabaseUserId) await supabaseAdmin().auth.admin.deleteUser(createdSupabaseUserId);
      throw error;
    }
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
        admin.from("notification_messages").select("tenant_id, status").eq("channel", "sms").gte("created_at", monthStart.toISOString()).in("status", ["submitted", "delivered", "read"]),
        admin.from("tenants").select("id, name"),
      ]);
      if (ownersResult.error || accountsResult.error || usageResult.error || tenantsResult.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل حسابات TweetSMS من Supabase." });
      const accountByTenant = new Map((accountsResult.data ?? []).map((account) => [Number(account.tenant_id), account]));
      const usageByTenant = new Map<number, number>();
      for (const usage of usageResult.data ?? []) usageByTenant.set(Number(usage.tenant_id), (usageByTenant.get(Number(usage.tenant_id)) ?? 0) + 1);
      const tenantNames = new Map((tenantsResult.data ?? []).map((tenant) => [Number(tenant.id), tenant.name]));
      return (ownersResult.data ?? []).map((owner) => {
        const tenantId = Number(owner.tenant_id);
        const account = accountByTenant.get(tenantId);
        const monthlyLimit = account?.monthly_limit ?? 0;
        const usedThisMonth = usageByTenant.get(tenantId) ?? 0;
        return { id: account ? Number(account.id) : null, tenantId, tenantName: tenantNames.get(tenantId) ?? "—", ownerName: owner.full_name, ownerPhone: owner.phone, apiEndpoint: account?.api_endpoint ?? null, senderName: account?.sender_name ?? null, monthlyLimit, usedThisMonth, remaining: Math.max(0, monthlyLimit - usedThisMonth), isActive: account?.is_active ?? false, configured: Boolean(account?.credential_ciphertext && account?.credential_iv), lastTestedAt: account?.last_tested_at ?? null, lastError: account?.last_error ?? null, updatedAt: account?.updated_at ?? null };
      });
    }
    const db = await dbOrThrow();
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const [accounts, usage] = await Promise.all([
      db.select({
        account: tenantTweetSmsAccounts,
        ownerTenantId: tenantOwnerProfiles.tenantId,
        tenantName: tenants.name,
        ownerName: tenantOwnerProfiles.fullName,
        ownerPhone: tenantOwnerProfiles.phone,
      }).from(tenantOwnerProfiles)
        .innerJoin(tenants, eq(tenantOwnerProfiles.tenantId, tenants.id))
        .leftJoin(tenantTweetSmsAccounts, eq(tenantTweetSmsAccounts.tenantId, tenants.id))
        .orderBy(tenants.name),
      db.select({ tenantId: notificationMessages.tenantId, used: sql<number>`count(*)` }).from(notificationMessages)
        .where(and(eq(notificationMessages.channel, "sms"), gte(notificationMessages.createdAt, monthStart), inArray(notificationMessages.status, ["submitted", "delivered", "read"])))
        .groupBy(notificationMessages.tenantId),
    ]);
    const usageByTenant = new Map(usage.map((row) => [row.tenantId, Number(row.used ?? 0)]));
    return accounts.map(({ account, ownerTenantId, tenantName, ownerName, ownerPhone }) => {
      const tenantId = account?.tenantId ?? ownerTenantId;
      const usedThisMonth = usageByTenant.get(tenantId) ?? 0;
      const monthlyLimit = account?.monthlyLimit ?? 0;
      return {
        id: account?.id ?? null,
        tenantId,
        tenantName,
        ownerName,
        ownerPhone,
        apiEndpoint: account?.apiEndpoint ?? null,
        senderName: account?.senderName ?? null,
        monthlyLimit,
        usedThisMonth,
        remaining: Math.max(0, monthlyLimit - usedThisMonth),
        isActive: account?.isActive ?? false,
        configured: Boolean(account?.credentialCiphertext && account?.credentialIv),
        lastTestedAt: account?.lastTestedAt ?? null,
        lastError: account?.lastError ?? null,
        updatedAt: account?.updatedAt ?? null,
      };
    });
  }),

  getPlatformTweetSmsAccount: platformAdminProcedure.query(async () => {
    const db = await dbOrThrow();
    const [account] = await db.select().from(platformTweetSmsAccounts).orderBy(desc(platformTweetSmsAccounts.updatedAt)).limit(1);
    if (!account) return null;
    return {
      id: account.id,
      apiEndpoint: account.apiEndpoint,
      senderName: account.senderName,
      lowBalanceThreshold: account.lowBalanceThreshold,
      lastProviderBalance: account.lastProviderBalance,
      lastBalanceCheckedAt: account.lastBalanceCheckedAt,
      lastTestedAt: account.lastTestedAt,
      lastError: account.lastError,
      isActive: account.isActive,
      configured: Boolean(account.credentialCiphertext && account.credentialIv),
    };
  }),

  listPlatformSmsFallbackProviders: platformAdminProcedure.query(async () => {
    const db = await dbOrThrow();
    const providers = await db.select().from(platformSmsFallbackProviders).orderBy(platformSmsFallbackProviders.priority, desc(platformSmsFallbackProviders.updatedAt));
    return providers.map(platformSmsFallbackProviderSummary);
  }),

  savePlatformSmsFallbackProvider: platformAdminProcedure.input(platformSmsFallbackProviderInput).mutation(async ({ ctx, input }) => {
    const db = await dbOrThrow();
    const [existing] = input.id
      ? await db.select().from(platformSmsFallbackProviders).where(eq(platformSmsFallbackProviders.id, input.id)).limit(1)
      : [];
    if (input.id && !existing) throw new TRPCError({ code: "NOT_FOUND", message: "مزود الرسائل الاحتياطي غير موجود." });
    const endpoint = input.apiEndpoint?.trim() || null;
    if (endpoint && !/^https:\/\//i.test(endpoint)) throw new TRPCError({ code: "BAD_REQUEST", message: "يجب أن يبدأ رابط API الآمن بـ https://" });
    const credentialsProvided = Boolean(input.credentials?.trim());
    const encrypted = credentialsProvided ? encryptTenantCredential(input.credentials!.trim()) : null;
    const values = {
      name: input.name,
      providerKey: input.providerKey,
      apiEndpoint: endpoint,
      senderName: input.senderName?.trim() || null,
      priority: input.priority,
      isActive: input.isActive,
      integrationStatus: "pending_contract" as const,
      updatedByUserId: ctx.user.id,
      ...(encrypted ? { credentialCiphertext: encrypted.ciphertext, credentialIv: encrypted.iv, credentialKeyVersion: 1 } : {}),
    };
    let providerId = existing?.id;
    if (existing) {
      await db.update(platformSmsFallbackProviders).set(values).where(eq(platformSmsFallbackProviders.id, existing.id));
    } else {
      const result = await db.insert(platformSmsFallbackProviders).values({ ...values, createdByUserId: ctx.user.id });
      providerId = Number(result[0].insertId);
    }
    await db.insert(platformSecurityEvents).values({
      eventType: "security_change",
      severity: "info",
      status: "success",
      title: "تم تحديث مزود SMS الاحتياطي",
      details: "تم حفظ إعداد احتياطي مشفر. لن يُستخدم للإرسال حتى إضافة عقد API موثق ومحول إرسال معتمد.",
      createdByUserId: ctx.user.id,
      metadata: { providerId, providerKey: input.providerKey, isActive: input.isActive, priority: input.priority, credentialsUpdated: credentialsProvided, integrationStatus: "pending_contract" },
    });
    return { success: true, id: providerId, configured: credentialsProvided || Boolean(existing?.credentialCiphertext && existing.credentialIv), integrationStatus: "pending_contract" as const };
  }),

  savePlatformTweetSmsAccount: platformAdminProcedure.input(platformTweetSmsAccountInput).mutation(async ({ ctx, input }) => {
    const db = await dbOrThrow();
    const [existing] = await db.select().from(platformTweetSmsAccounts).orderBy(desc(platformTweetSmsAccounts.updatedAt)).limit(1);
    const credentialsProvided = Boolean(input.apiKey);
    if (input.isActive && !credentialsProvided && !existing?.credentialCiphertext) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "أدخل مفتاح API لحساب TweetSMS المركزي قبل تفعيل الإرسال." });
    }
    const encrypted = credentialsProvided ? encryptTenantCredential(JSON.stringify({ apiKey: input.apiKey, apiSecret: input.apiSecret || undefined })) : null;
    const values = {
      apiEndpoint: input.apiEndpoint,
      senderName: input.senderName || null,
      lowBalanceThreshold: input.lowBalanceThreshold,
      isActive: input.isActive,
      updatedByUserId: ctx.user.id,
      ...(encrypted ? { credentialCiphertext: encrypted.ciphertext, credentialIv: encrypted.iv, credentialKeyVersion: 1 } : {}),
    };
    if (existing) await db.update(platformTweetSmsAccounts).set(values).where(eq(platformTweetSmsAccounts.id, existing.id));
    else if (!encrypted) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "أدخل مفتاح API لإنشاء حساب TweetSMS المركزي." });
    else await db.insert(platformTweetSmsAccounts).values({ ...values, credentialCiphertext: encrypted.ciphertext, credentialIv: encrypted.iv, credentialKeyVersion: 1, createdByUserId: ctx.user.id });
    await db.insert(platformSecurityEvents).values({ eventType: "security_change", severity: "info", status: "success", title: "تم تحديث حساب TweetSMS المركزي", details: "تم حفظ بيانات الربط المشفرة دون إظهار مفتاح API.", createdByUserId: ctx.user.id, metadata: { isActive: input.isActive, apiKeyUpdated: credentialsProvided, lowBalanceThreshold: input.lowBalanceThreshold } });
    return { success: true };
  }),

  testPlatformTweetSmsAccount: platformAdminProcedure.mutation(async ({ ctx }) => {
    const db = await dbOrThrow();
    const [account] = await db.select().from(platformTweetSmsAccounts).orderBy(desc(platformTweetSmsAccounts.updatedAt)).limit(1);
    if (!account?.credentialCiphertext || !account.credentialIv) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "أدخل بيانات حساب TweetSMS المركزي أولاً." });
    let credentials: TweetSmsCredentials;
    try { credentials = JSON.parse(decryptTenantCredential(account.credentialCiphertext, account.credentialIv)) as TweetSmsCredentials; }
    catch { throw new TRPCError({ code: "PRECONDITION_FAILED", message: "تعذر قراءة بيانات TweetSMS المشفرة. احفظ الحساب مرة أخرى." }); }
    const accountResult = await checkTweetSmsAccount({ endpoint: account.apiEndpoint, credentials });
    const senderResult = accountResult.ok && account.senderName ? await checkTweetSmsSender({ endpoint: account.apiEndpoint, credentials, sender: account.senderName }) : null;
    const balanceResult = accountResult.ok && (!account.senderName || senderResult?.ok) ? await checkTweetSmsBalance({ endpoint: account.apiEndpoint, credentials }) : null;
    const result = senderResult && !senderResult.ok ? senderResult : balanceResult && balanceResult.code !== null && !balanceResult.ok ? balanceResult : accountResult;
    const balance = balanceResult?.balance;
    await db.update(platformTweetSmsAccounts).set({ lastTestedAt: new Date(), lastBalanceCheckedAt: balance !== undefined ? new Date() : account.lastBalanceCheckedAt, lastProviderBalance: balance ?? account.lastProviderBalance, lastError: result.ok ? null : result.message, updatedByUserId: ctx.user.id }).where(eq(platformTweetSmsAccounts.id, account.id));
    if (balance !== undefined) {
      const [openAlert] = await db.select().from(platformTweetSmsBalanceAlerts).where(and(eq(platformTweetSmsBalanceAlerts.accountId, account.id), eq(platformTweetSmsBalanceAlerts.status, "open"))).orderBy(desc(platformTweetSmsBalanceAlerts.createdAt)).limit(1);
      if (balance <= account.lowBalanceThreshold && !openAlert) {
        await db.insert(platformTweetSmsBalanceAlerts).values({ accountId: account.id, balance, threshold: account.lowBalanceThreshold });
        await db.insert(platformSecurityEvents).values({ eventType: "security_change", severity: "warning", status: "open", title: "تنبيه رصيد TweetSMS منخفض", details: `الرصيد المتاح ${balance} أقل من أو يساوي حد التنبيه ${account.lowBalanceThreshold}.`, createdByUserId: ctx.user.id, metadata: { accountId: account.id, balance, threshold: account.lowBalanceThreshold } });
      } else if (balance > account.lowBalanceThreshold && openAlert) {
        await db.update(platformTweetSmsBalanceAlerts).set({ status: "resolved", resolvedAt: new Date() }).where(eq(platformTweetSmsBalanceAlerts.accountId, account.id));
      }
    }
    await db.insert(platformSecurityEvents).values({ eventType: "security_change", severity: result.ok ? "info" : "warning", status: result.ok ? "success" : "failed", title: "فحص حساب TweetSMS المركزي", details: result.message, createdByUserId: ctx.user.id, metadata: { code: result.code, senderCode: senderResult?.code ?? null, balance: balance ?? null } });
    return { ok: result.ok, message: result.message, balance: balance ?? null };
  }),

  platformTweetSmsReport: platformAdminProcedure.input(z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() }).optional()).query(async ({ input }) => {
    const db = await dbOrThrow();
    const [account] = await db.select().from(platformTweetSmsAccounts).orderBy(desc(platformTweetSmsAccounts.updatedAt)).limit(1);
    const filters = [eq(notificationMessages.channel, "sms")];
    if (input?.from) filters.push(gte(notificationMessages.createdAt, input.from));
    if (input?.to) filters.push(lte(notificationMessages.createdAt, input.to));
    const usageRows = await db.select({ tenantId: notificationMessages.tenantId, tenantName: tenants.name, total: sql<number>`count(*)`, submitted: sql<number>`sum(case when ${notificationMessages.status} = 'submitted' then 1 else 0 end)`, failed: sql<number>`sum(case when ${notificationMessages.status} = 'failed' then 1 else 0 end)` }).from(notificationMessages).innerJoin(tenants, eq(tenants.id, notificationMessages.tenantId)).where(and(...filters)).groupBy(notificationMessages.tenantId, tenants.name).orderBy(desc(sql`count(*)`)).limit(250);
    const alerts = account ? await db.select().from(platformTweetSmsBalanceAlerts).where(eq(platformTweetSmsBalanceAlerts.accountId, account.id)).orderBy(desc(platformTweetSmsBalanceAlerts.createdAt)).limit(30) : [];
    const total = usageRows.reduce((sum, row) => sum + Number(row.total ?? 0), 0);
    return {
      account: account ? { id: account.id, isActive: account.isActive, senderName: account.senderName, lowBalanceThreshold: account.lowBalanceThreshold, lastProviderBalance: account.lastProviderBalance, lastBalanceCheckedAt: account.lastBalanceCheckedAt, lastError: account.lastError, configured: Boolean(account.credentialCiphertext && account.credentialIv) } : null,
      total,
      usageRows: usageRows.map((row) => ({ ...row, total: Number(row.total ?? 0), submitted: Number(row.submitted ?? 0), failed: Number(row.failed ?? 0) })),
      alerts,
    };
  }),

  saveTweetSmsAccount: platformAdminProcedure.input(tweetSmsAccountInput).mutation(async ({ ctx, input }) => {
    const db = await dbOrThrow();
    const [tenant] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, input.tenantId)).limit(1);
    if (!tenant) throw new TRPCError({ code: "NOT_FOUND", message: "صاحب المولد غير موجود." });
    const [existing] = await db.select().from(tenantTweetSmsAccounts).where(eq(tenantTweetSmsAccounts.tenantId, input.tenantId)).limit(1);
    const [centralAccount] = await db.select({ credentialCiphertext: platformTweetSmsAccounts.credentialCiphertext, credentialIv: platformTweetSmsAccounts.credentialIv, isActive: platformTweetSmsAccounts.isActive }).from(platformTweetSmsAccounts).where(eq(platformTweetSmsAccounts.isActive, true)).orderBy(desc(platformTweetSmsAccounts.updatedAt)).limit(1);
    const centralAccountAvailable = Boolean(centralAccount?.isActive && centralAccount.credentialCiphertext && centralAccount.credentialIv);
    const endpoint = input.apiEndpoint?.trim() || existing?.apiEndpoint || null;
    if (endpoint && !/^https:\/\//i.test(endpoint)) throw new TRPCError({ code: "BAD_REQUEST", message: "يجب أن يكون رابط TweetSMS آمناً ويبدأ بـ https://" });
    const credentialsProvided = Boolean(input.apiKey);
    if (input.isActive && !centralAccountAvailable && (!endpoint || (!existing?.credentialCiphertext && !credentialsProvided))) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "فعّل الحساب بعد إدخال بيانات TweetSMS الفرعية، أو فعّل حساب TweetSMS المركزي للمنصة أولاً." });
    }
    const encrypted = credentialsProvided ? encryptTenantCredential(JSON.stringify({ apiKey: input.apiKey, apiSecret: input.apiSecret || undefined })) : null;
    const values = {
      apiEndpoint: endpoint,
      senderName: input.senderName,
      monthlyLimit: input.monthlyLimit,
      isActive: input.isActive,
      updatedByUserId: ctx.user.id,
      ...(encrypted ? { credentialCiphertext: encrypted.ciphertext, credentialIv: encrypted.iv, credentialKeyVersion: 1 } : {}),
    };
    if (existing) await db.update(tenantTweetSmsAccounts).set(values).where(eq(tenantTweetSmsAccounts.id, existing.id));
    else await db.insert(tenantTweetSmsAccounts).values({ tenantId: input.tenantId, createdByUserId: ctx.user.id, ...values });
    await db.insert(tenantMessagingConfigurations).values({
      tenantId: input.tenantId,
      channel: "sms",
      provider: "tweetsms",
      senderId: input.senderName,
      isActive: input.isActive,
    }).onDuplicateKeyUpdate({
      set: { provider: "tweetsms", senderId: input.senderName, phoneNumberId: null, credentialCiphertext: null, credentialIv: null, isActive: input.isActive },
    });
    const [site] = await db.select({ id: sites.id }).from(sites).where(eq(sites.tenantId, input.tenantId)).limit(1);
    await db.insert(auditLogs).values({
      tenantId: input.tenantId,
      siteId: site?.id ?? null,
      userId: ctx.user.id,
      entityType: "tweetsms_account",
      entityId: String(existing?.id ?? input.tenantId),
      action: "platform_admin_save_tweetsms_account",
      afterData: { senderName: input.senderName, monthlyLimit: input.monthlyLimit, isActive: input.isActive, apiEndpointConfigured: Boolean(endpoint), apiKeyUpdated: credentialsProvided },
      actorPlatformRole: platformRoleOf(ctx.user),
    });
    return { success: true };
  }),

  testTweetSmsAccount: platformAdminProcedure.input(z.object({ tenantId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    const db = await dbOrThrow();
    const [account] = await db.select().from(tenantTweetSmsAccounts).where(eq(tenantTweetSmsAccounts.tenantId, input.tenantId)).limit(1);
    if (!account?.credentialCiphertext || !account.credentialIv || !account.apiEndpoint) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "أدخل رابط API الرسمي وبيانات حساب TweetSMS أولاً." });
    }
    let credentials: TweetSmsCredentials;
    try {
      credentials = JSON.parse(decryptTenantCredential(account.credentialCiphertext, account.credentialIv)) as TweetSmsCredentials;
    } catch {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "تعذر قراءة بيانات TweetSMS المشفرة. احفظ بيانات الحساب مرة أخرى." });
    }
    if (!credentials.apiKey?.trim()) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "مفتاح API الخاص بـ TweetSMS غير صالح." });
    const accountResult = await checkTweetSmsAccount({ endpoint: account.apiEndpoint, credentials });
    const senderResult = accountResult.ok ? await checkTweetSmsSender({ endpoint: account.apiEndpoint, credentials, sender: account.senderName ?? "" }) : null;
    const balanceResult = accountResult.ok && senderResult?.ok ? await checkTweetSmsBalance({ endpoint: account.apiEndpoint, credentials }) : null;
    const result = senderResult && !senderResult.ok ? senderResult : balanceResult && balanceResult.code !== null && !balanceResult.ok ? balanceResult : accountResult;
    const balanceNote = balanceResult?.balance !== undefined ? ` الرصيد المتاح لدى المزود: ${balanceResult.balance}.` : balanceResult && balanceResult.code === null ? " نجح التحقق من الحساب؛ لم يُرجع المزود رصيداً رقمياً قابلاً للعرض." : "";
    const message = `${result.message}${balanceNote}`;
    const [site] = await db.select({ id: sites.id }).from(sites).where(eq(sites.tenantId, account.tenantId)).limit(1);
    if (!site) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "لا توجد محطة مرتبطة بصاحب المولد لتسجيل نتيجة اختبار TweetSMS." });
    await db.update(tenantTweetSmsAccounts).set({ lastTestedAt: new Date(), lastError: result.ok ? null : message, updatedByUserId: ctx.user.id }).where(eq(tenantTweetSmsAccounts.id, account.id));
    await db.insert(auditLogs).values({ tenantId: account.tenantId, siteId: site.id, userId: ctx.user.id, entityType: "tweetsms_account", entityId: String(account.id), action: "platform_admin_test_tweetsms_account", afterData: { ok: result.ok, code: result.code, senderCode: senderResult?.code ?? null, balance: balanceResult?.balance ?? null }, actorPlatformRole: platformRoleOf(ctx.user) });
    return { ok: result.ok, mode: "live" as const, message, balance: balanceResult?.balance ?? null };
  }),

  listSubscriptionUpgradeRequests: platformAdminProcedure.query(async () => {
    const db = await dbOrThrow();
    return db.select({ id: subscriptionUpgradeRequests.id, tenantId: subscriptionUpgradeRequests.tenantId, tenantName: tenants.name, ownerName: tenantOwnerProfiles.fullName, ownerEmail: tenantOwnerProfiles.email, currentPlan: subscriptionUpgradeRequests.currentPlan, requestedPlan: subscriptionUpgradeRequests.requestedPlan, status: subscriptionUpgradeRequests.status, note: subscriptionUpgradeRequests.note, createdAt: subscriptionUpgradeRequests.createdAt, reviewedAt: subscriptionUpgradeRequests.reviewedAt })
      .from(subscriptionUpgradeRequests).innerJoin(tenants, eq(subscriptionUpgradeRequests.tenantId, tenants.id)).leftJoin(tenantOwnerProfiles, eq(tenantOwnerProfiles.tenantId, tenants.id)).orderBy(desc(subscriptionUpgradeRequests.createdAt)).limit(300);
  }),

  reviewSubscriptionUpgradeRequest: platformAdminProcedure.input(z.object({ id: z.number().int().positive(), decision: z.enum(["approved", "rejected"]), note: z.string().trim().max(1000).optional() })).mutation(async ({ ctx, input }) => {
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
    const db = await dbOrThrow(); const [owner] = await db.select({ phone: tenantOwnerProfiles.phone, siteId: sites.id }).from(tenantOwnerProfiles).innerJoin(sites, eq(sites.tenantId, tenantOwnerProfiles.tenantId)).where(eq(tenantOwnerProfiles.tenantId, input.tenantId)).limit(1);
    if (!owner?.phone) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "لا يوجد رقم جوال لمالك هذا الحساب." });
    const notificationId = insertId(await db.insert(notificationMessages).values({ tenantId: input.tenantId, channel: "sms", eventType: "service_alert", recipient: owner.phone, status: "pending", payload: { renderedText: input.message, type: "owner_usage_limit_alert", usagePercent: input.usagePercent, siteId: owner.siteId } }));
    const delivery = await processNotificationById(notificationId).catch((error) => ({ status: "failed" as const, error: error instanceof Error ? error.message : "تعذر بدء الإرسال." }));
    await db.insert(auditLogs).values({ tenantId: input.tenantId, siteId: owner.siteId, userId: ctx.user.id, entityType: "owner_usage_alert", entityId: String(notificationId), action: "platform_admin_send_owner_usage_alert", afterData: { usagePercent: input.usagePercent, message: input.message, notificationStatus: delivery.status }, actorPlatformRole: platformRoleOf(ctx.user) });
    return { notificationId, status: delivery.status, error: delivery.error ?? null };
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
    const db = await dbOrThrow();
    const [accounts, invitations] = await Promise.all([
      db.select({ id: users.id, name: users.name, email: users.email, platformRole: users.platformRole, accountStatus: users.accountStatus, lastSignedIn: users.lastSignedIn })
        .from(users).where(eq(users.role, "admin")).orderBy(desc(users.lastSignedIn)).limit(100),
      db.select({ id: platformAccessInvitations.id, email: platformAccessInvitations.email, platformRole: platformAccessInvitations.platformRole, status: platformAccessInvitations.status, expiresAt: platformAccessInvitations.expiresAt, acceptedAt: platformAccessInvitations.acceptedAt, invitedByUserId: platformAccessInvitations.invitedByUserId })
        .from(platformAccessInvitations).orderBy(desc(platformAccessInvitations.createdAt)).limit(100),
    ]);
    return { accounts, invitations };
  }),

  invitePlatformAccess: platformOwnerProcedure.input(z.object({
    email: z.string().email().transform((email) => email.trim().toLowerCase()),
    platformRole: z.enum(["platform_admin", "finance_admin"]),
    expiresInHours: z.number().int().min(1).max(168).default(72),
  })).mutation(async ({ ctx, input }) => {
    const db = await dbOrThrow();
    const expiresAt = new Date(Date.now() + input.expiresInHours * 60 * 60 * 1000);
    const tokenHash = crypto.createHash("sha256").update(crypto.randomBytes(32)).digest("hex");
    const id = insertId(await db.insert(platformAccessInvitations).values({ email: input.email, platformRole: input.platformRole, tokenHash, invitedByUserId: ctx.user.id, expiresAt }));
    await recordPlatformSecurityChange(db, ctx.user, undefined, "دعوة دور منصة", { invitationId: id, email: input.email, platformRole: input.platformRole, expiresAt });
    return { id, email: input.email, platformRole: input.platformRole, expiresAt, status: "invited" as const };
  }),

  setPlatformAccountStatus: platformOwnerProcedure.input(z.object({ userId: z.number().int().positive(), accountStatus: z.enum(["active", "locked", "disabled"]) })).mutation(async ({ ctx, input }) => {
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
    const db = await dbOrThrow();
    const [subscriptionSummary, [collectionSummary]] = await Promise.all([
      db.select({ status: tenantSubscriptions.status, count: sql<number>`count(*)` }).from(tenantSubscriptions).groupBy(tenantSubscriptions.status),
      db.select({ amount: sql<string>`coalesce(sum(${payments.amount}), 0)`, count: sql<number>`count(*)` }).from(payments).where(eq(payments.status, "completed")),
    ]);
    return { subscriptions: subscriptionSummary.map((item) => ({ ...item, count: Number(item.count) })), collections: { amount: Number(collectionSummary?.amount ?? 0), count: Number(collectionSummary?.count ?? 0) } };
  }),

  inviteTenantAccess: platformAdminProcedure.input(z.object({
    tenantId: z.number().int().positive(),
    siteId: z.number().int().positive().optional(),
    email: z.string().email().transform((email) => email.trim().toLowerCase()),
    tenantRole: z.enum(["owner", "admin", "member"]).default("member"),
    siteRole: z.enum(["owner", "manager", "accountant", "collector", "technician", "viewer"]).optional(),
    expiresInHours: z.number().int().min(1).max(168).default(72),
  })).mutation(async ({ ctx, input }) => {
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
    const db = await dbOrThrow();
    const id = insertId(await db.insert(platformSmsPlans).values(input));
    await db.insert(platformSecurityEvents).values({ eventType: "security_change", severity: "info", status: "success", title: "إنشاء باقة رسائل SMS", createdByUserId: ctx.user.id, metadata: { planId: id, code: input.code, includedMessages: input.includedMessages } });
    return { id };
  }),
  updateSmsPlan: platformAdminProcedure.input(z.object({ id: z.number().int().positive(), name: z.string().trim().min(2).max(160).optional(), description: z.string().max(1000).optional(), includedMessages: z.number().int().min(0).max(100000000).optional(), isActive: z.boolean().optional() })).mutation(async ({ ctx, input }) => {
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
    const db = await dbOrThrow();
    return db.select({ request: smsPackageRequests, tenantName: tenants.name, ownerName: tenantOwnerProfiles.fullName }).from(smsPackageRequests).innerJoin(tenants, eq(smsPackageRequests.tenantId, tenants.id)).leftJoin(tenantOwnerProfiles, eq(tenantOwnerProfiles.tenantId, tenants.id)).orderBy(desc(smsPackageRequests.createdAt)).limit(100);
  }),
  reviewSmsPackageRequest: platformAdminProcedure.input(z.object({ id: z.number().int().positive(), status: z.enum(["approved", "rejected"]), approvedMessages: z.number().int().min(0).max(100000000), note: z.string().max(2000).optional() })).mutation(async ({ ctx, input }) => {
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
    const db = await dbOrThrow();
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, input.tenantId)).limit(1);
    if (!tenant) throw new TRPCError({ code: "NOT_FOUND", message: "مساحة صاحب المولد غير موجودة." });
    const [site] = await db.select().from(sites).where(eq(sites.tenantId, input.tenantId)).limit(1);
    await db.transaction(async (tx) => {
      await tx.update(tenants).set({ status: input.status }).where(eq(tenants.id, input.tenantId));
      if (input.status === "suspended") await tx.update(tenantSubscriptions).set({ status: "suspended" }).where(eq(tenantSubscriptions.tenantId, input.tenantId));
    });
    if (site) await db.insert(auditLogs).values({ tenantId: tenant.id, siteId: site.id, userId: ctx.user.id, entityType: "tenant", entityId: String(tenant.id), action: "platform_admin_set_tenant_status", beforeData: { status: tenant.status }, afterData: { status: input.status } });
    return { success: true };
  }),

  setGeneratorStatus: platformAdminProcedure.input(z.object({ id: z.number().int().positive(), status: z.enum(["active", "maintenance", "stopped", "offline", "blocked"]) })).mutation(async ({ ctx, input }) => {
    const db = await dbOrThrow();
    const [generator] = await db.select().from(generators).where(eq(generators.id, input.id)).limit(1);
    if (!generator) throw new TRPCError({ code: "NOT_FOUND", message: "المولد غير موجود." });
    await db.update(generators).set({ status: input.status }).where(eq(generators.id, input.id));
    await db.insert(auditLogs).values({ tenantId: generator.tenantId, siteId: generator.siteId, userId: ctx.user.id, entityType: "generator", entityId: String(generator.id), action: "platform_admin_update_generator_status", beforeData: { status: generator.status }, afterData: { status: input.status } });
    return { success: true };
  }),

  approvePendingGenerator: platformAdminProcedure.input(z.object({ generatorId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    const db = await dbOrThrow();
    const [generator] = await db.select().from(generators).where(eq(generators.id, input.generatorId)).limit(1);
    if (!generator) throw new TRPCError({ code: "NOT_FOUND", message: "المولد غير موجود." });
    if (generator.status !== "pending") throw new TRPCError({ code: "CONFLICT", message: "لا يمكن اعتماد مولد ليس بحالة انتظار المراجعة." });
    await db.update(generators).set({ status: "active" }).where(eq(generators.id, generator.id));
    await db.insert(auditLogs).values({ tenantId: generator.tenantId, siteId: generator.siteId, userId: ctx.user.id, entityType: "generator", entityId: String(generator.id), action: "platform_admin_approve_pending_generator", beforeData: { status: "pending" }, afterData: { status: "active" }, actorPlatformRole: platformRoleOf(ctx.user) });
    return { success: true, generatorId: generator.id, status: "active" as const };
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
    const db = await dbOrThrow();
    const [databaseProbe, failedMessages, pendingMessages, syncIssues, securityIssues] = await Promise.all([
      db.select({ tenants: sql<number>`count(*)` }).from(tenants).limit(1),
      db.select({ id: notificationMessages.id, tenantName: tenants.name, channel: notificationMessages.channel, eventType: notificationMessages.eventType, lastError: notificationMessages.lastError, createdAt: notificationMessages.createdAt }).from(notificationMessages).innerJoin(tenants, eq(notificationMessages.tenantId, tenants.id)).where(eq(notificationMessages.status, "failed")).orderBy(desc(notificationMessages.createdAt)).limit(12),
      db.select({ count: sql<number>`count(*)` }).from(notificationMessages).where(eq(notificationMessages.status, "pending")).limit(1),
      db.select({ id: mobileSyncEvents.id, tenantName: tenants.name, status: mobileSyncEvents.status, errorCode: mobileSyncEvents.errorCode, errorMessage: mobileSyncEvents.errorMessage, occurredAt: mobileSyncEvents.occurredAt }).from(mobileSyncEvents).innerJoin(tenants, eq(mobileSyncEvents.tenantId, tenants.id)).where(inArray(mobileSyncEvents.status, ["partial", "retryable", "needs_review", "failed"])).orderBy(desc(mobileSyncEvents.occurredAt)).limit(12),
      db.select({ id: platformSecurityEvents.id, severity: platformSecurityEvents.severity, status: platformSecurityEvents.status, title: platformSecurityEvents.title, details: platformSecurityEvents.details, createdAt: platformSecurityEvents.createdAt }).from(platformSecurityEvents).where(inArray(platformSecurityEvents.status, ["open", "failed"])).orderBy(desc(platformSecurityEvents.createdAt)).limit(12),
    ]);
    const alerts = [
      ...failedMessages.map((item) => ({ id: `message-${item.id}`, category: "messaging" as const, severity: "critical" as const, title: `فشل إرسال ${item.channel === "sms" ? "SMS" : "WhatsApp"}`, detail: item.lastError ?? `تعذر إرسال ${item.eventType}.`, tenantName: item.tenantName, occurredAt: item.createdAt, target: "notifications" as const })),
      ...syncIssues.map((item) => ({ id: `sync-${item.id}`, category: "sync" as const, severity: item.status === "failed" ? "critical" as const : "warning" as const, title: `مزامنة ميدانية: ${item.status}`, detail: item.errorMessage ?? item.errorCode ?? "تحتاج دورة المزامنة إلى مراجعة.", tenantName: item.tenantName, occurredAt: item.occurredAt, target: "field_sync" as const })),
      ...securityIssues.map((item) => ({ id: `security-${item.id}`, category: "security" as const, severity: item.severity === "critical" ? "critical" as const : "warning" as const, title: item.title, detail: item.details ?? "حدث أمني مفتوح يحتاج إلى متابعة.", tenantName: null, occurredAt: item.createdAt, target: "security" as const })),
    ].sort((left, right) => Number(right.occurredAt) - Number(left.occurredAt)).slice(0, 24);
    const pending = Number(pendingMessages[0]?.count ?? 0);
    return { health: [
      { key: "database", label: "البيانات", state: databaseProbe.length ? "healthy" as const : "critical" as const, detail: databaseProbe.length ? "استجابة قاعدة البيانات سليمة." : "تعذر التحقق من قاعدة البيانات.", count: Number(databaseProbe[0]?.tenants ?? 0), target: "reports" as const },
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
    const db = await dbOrThrow();
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const [kpis] = await db.select({
      activeGenerators: sql<number>`(select count(*) from ${generators} where ${generators.status} = 'active')`,
      subscribers: sql<number>`(select count(*) from ${subscribers})`,
      openComplaints: sql<number>`(select count(*) from ${complaints} where ${complaints.status} in ('open', 'assigned', 'in_progress'))`,
      generatorsToReview: sql<number>`(select count(*) from ${generators} where ${generators.status} in ('maintenance', 'stopped', 'offline', 'blocked'))`,
    }).from(tenants).limit(1);
    const [consumption] = await db.select({
      daily: sql<number>`sum(case when ${meterReadings.readingAt} >= ${today} and ${meterReadings.status} = 'approved' then ${meterReadings.consumptionKwh} else 0 end)`,
      monthly: sql<number>`sum(case when ${meterReadings.readingAt} >= ${monthStart} and ${meterReadings.status} = 'approved' then ${meterReadings.consumptionKwh} else 0 end)`,
    }).from(meterReadings);
    const [collections] = await db.select({
      monthly: sql<number>`sum(case when ${payments.paidAt} >= ${monthStart} and ${payments.status} = 'completed' then ${payments.amount} else 0 end)`,
      paid: sql<number>`sum(case when ${invoices.status} in ('paid', 'partially_paid') then ${invoices.paidAmount} else 0 end)`,
      total: sql<number>`sum(case when ${invoices.status} in ('issued', 'partially_paid', 'paid', 'overdue') then ${invoices.totalAmount} else 0 end)`,
    }).from(invoices).leftJoin(payments, eq(payments.invoiceId, invoices.id));
    const growthMonth = sql<string>`DATE_FORMAT(${subscribers.createdAt}, '%Y-%m')`;
    const monthlyGrowth = await db.select({ month: growthMonth, count: sql<number>`count(*)` })
      .from(subscribers).where(gte(subscribers.createdAt, new Date(now.getFullYear(), now.getMonth() - 11, 1))).groupBy(sql`1`).orderBy(sql`1`);
    const consumptionByRegion = await db.select({ region: sites.city, consumptionKwh: sql<number>`sum(${meterReadings.consumptionKwh})` })
      .from(meterReadings).innerJoin(subscribers, eq(meterReadings.subscriberId, subscribers.id)).innerJoin(sites, eq(subscribers.siteId, sites.id))
      .where(eq(meterReadings.status, "approved")).groupBy(sites.city).orderBy(desc(sql`sum(${meterReadings.consumptionKwh})`)).limit(12);
    const collectionsByGenerator: Array<{ generatorId: number; generatorName: string; code: string; tenantName: string; amount: number }> = [];
    const latestGenerators = await db.select({ id: generators.id, name: generators.name, code: generators.code, status: generators.status, createdAt: generators.createdAt, tenantName: tenants.name })
      .from(generators).innerJoin(tenants, eq(generators.tenantId, tenants.id)).orderBy(desc(generators.createdAt)).limit(8);
    const recentComplaints = await db.select({ id: complaints.id, title: complaints.title, priority: complaints.priority, status: complaints.status, tenantName: tenants.name, siteName: sites.name, openedAt: complaints.openedAt })
      .from(complaints).innerJoin(tenants, eq(complaints.tenantId, tenants.id)).innerJoin(sites, eq(complaints.siteId, sites.id)).orderBy(desc(complaints.openedAt)).limit(8);
    const expiringSubscriptions = await db.select({ tenantId: tenants.id, tenantName: tenants.name, ownerName: tenantOwnerProfiles.fullName, endsAt: tenantSubscriptions.endsAt, status: tenantSubscriptions.status })
      .from(tenantSubscriptions).innerJoin(tenants, eq(tenantSubscriptions.tenantId, tenants.id)).leftJoin(tenantOwnerProfiles, eq(tenantOwnerProfiles.tenantId, tenants.id)).orderBy(tenantSubscriptions.endsAt).limit(8);
    return {
      kpis: { activeGenerators: Number(kpis?.activeGenerators ?? 0), subscribers: Number(kpis?.subscribers ?? 0), dailyConsumption: Number(consumption?.daily ?? 0), monthlyConsumption: Number(consumption?.monthly ?? 0), monthlyCollections: Number(collections?.monthly ?? 0), openComplaints: Number(kpis?.openComplaints ?? 0), generatorsToReview: Number(kpis?.generatorsToReview ?? 0), collectionRate: Number(collections?.total ?? 0) ? Math.round((Number(collections?.paid ?? 0) / Number(collections?.total ?? 0)) * 100) : 0 },
      monthlyGrowth: monthlyGrowth.map((item) => ({ ...item, count: Number(item.count) })), consumptionByRegion: consumptionByRegion.map((item) => ({ ...item, consumptionKwh: Number(item.consumptionKwh) })), collectionsByGenerator: collectionsByGenerator.map((item) => ({ ...item, amount: Number(item.amount) })), latestGenerators, recentComplaints, expiringSubscriptions,
    };
  }),

  globalSearch: platformAdminProcedure.input(z.object({ query: z.string().trim().min(2).max(100) })).query(async ({ input }) => {
    const db = await dbOrThrow(); const term = `%${input.query}%`;
    const [generatorResults, subscriberResults, ownerResults] = await Promise.all([
      db.select({ id: generators.id, label: generators.name, reference: generators.code, tenantName: tenants.name, kind: sql<"generator">`'generator'` }).from(generators).innerJoin(tenants, eq(generators.tenantId, tenants.id)).where(or(like(generators.name, term), like(generators.code, term))).limit(20),
      db.select({ id: subscribers.id, label: subscribers.fullName, reference: subscribers.subscriberNo, tenantName: tenants.name, kind: sql<"subscriber">`'subscriber'` }).from(subscribers).innerJoin(tenants, eq(subscribers.tenantId, tenants.id)).where(or(like(subscribers.fullName, term), like(subscribers.subscriberNo, term), like(subscribers.phone, term))).limit(20),
      db.select({ id: tenantOwnerProfiles.id, label: tenantOwnerProfiles.fullName, reference: tenantOwnerProfiles.phone, tenantName: tenants.name, kind: sql<"owner">`'owner'` }).from(tenantOwnerProfiles).innerJoin(tenants, eq(tenantOwnerProfiles.tenantId, tenants.id)).where(or(like(tenantOwnerProfiles.fullName, term), like(tenantOwnerProfiles.phone, term))).limit(20),
    ]);
    return [...generatorResults, ...subscriberResults, ...ownerResults];
  }),

  listComplaints: platformAdminProcedure.input(z.object({ status: z.enum(["open", "assigned", "in_progress", "resolved", "closed"]).optional() }).optional()).query(async ({ input }) => {
    const db = await dbOrThrow();
    return db.select({ id: complaints.id, title: complaints.title, description: complaints.description, priority: complaints.priority, status: complaints.status, response: complaints.response, openedAt: complaints.openedAt, resolvedAt: complaints.resolvedAt, tenantId: complaints.tenantId, tenantName: tenants.name, siteName: sites.name, subscriberName: subscribers.fullName, assignedUserId: complaints.assignedUserId, assignedUserName: users.name })
      .from(complaints).innerJoin(tenants, eq(complaints.tenantId, tenants.id)).innerJoin(sites, eq(complaints.siteId, sites.id)).leftJoin(subscribers, eq(complaints.subscriberId, subscribers.id)).leftJoin(users, eq(complaints.assignedUserId, users.id))
      .where(input?.status ? eq(complaints.status, input.status) : undefined).orderBy(desc(complaints.openedAt)).limit(300);
  }),

  updateComplaint: platformAdminProcedure.input(z.object({ id: z.number().int().positive(), status: z.enum(["open", "assigned", "in_progress", "resolved", "closed"]), assignedUserId: z.number().int().positive().nullable().optional(), response: z.string().max(4000).optional() })).mutation(async ({ ctx, input }) => {
    const db = await dbOrThrow(); const [complaint] = await db.select().from(complaints).where(eq(complaints.id, input.id)).limit(1);
    if (!complaint) throw new TRPCError({ code: "NOT_FOUND", message: "الشكوى غير موجودة." });
    await db.update(complaints).set({ status: input.status, assignedUserId: input.assignedUserId, response: input.response, resolvedAt: input.status === "resolved" || input.status === "closed" ? new Date() : null }).where(eq(complaints.id, input.id));
    await db.insert(auditLogs).values({ tenantId: complaint.tenantId, siteId: complaint.siteId, userId: ctx.user.id, entityType: "complaint", entityId: String(complaint.id), action: "platform_admin_update_complaint", afterData: { status: input.status, assignedUserId: input.assignedUserId } });
    return { success: true };
  }),

  listTariffPolicies: platformAdminProcedure.query(async () => (await dbOrThrow()).select({ id: platformTariffPolicies.id, minimumPricePerKwh: platformTariffPolicies.minimumPricePerKwh, maximumPricePerKwh: platformTariffPolicies.maximumPricePerKwh, effectiveFrom: platformTariffPolicies.effectiveFrom, notificationRequested: platformTariffPolicies.notificationRequested, notes: platformTariffPolicies.notes, createdAt: platformTariffPolicies.createdAt, createdBy: users.name }).from(platformTariffPolicies).leftJoin(users, eq(platformTariffPolicies.createdByUserId, users.id)).orderBy(desc(platformTariffPolicies.effectiveFrom)).limit(100)),

  createTariffPolicy: platformAdminProcedure.input(z.object({ minimumPricePerKwh: z.number().nonnegative(), maximumPricePerKwh: z.number().positive(), effectiveFrom: z.date(), notificationRequested: z.boolean().default(false), notes: z.string().max(2000).optional() }).refine((input) => input.maximumPricePerKwh >= input.minimumPricePerKwh, { message: "الحد الأقصى يجب أن يساوي أو يتجاوز الحد الأدنى.", path: ["maximumPricePerKwh"] })).mutation(async ({ ctx, input }) => {
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
    const db = await dbOrThrow();
    const [rows, counts] = await Promise.all([
      db.select({ tenantId: tenants.id, tenantName: tenants.name, plan: tenants.plan, tenantStatus: tenants.status, ownerName: tenantOwnerProfiles.fullName, isEnabledOverride: tenantBranchSettings.isEnabledOverride, maxBranchesOverride: tenantBranchSettings.maxBranchesOverride, disabledBehavior: tenantBranchSettings.disabledBehavior })
        .from(tenants)
        .leftJoin(tenantOwnerProfiles, eq(tenantOwnerProfiles.tenantId, tenants.id))
        .leftJoin(tenantBranchSettings, eq(tenantBranchSettings.tenantId, tenants.id))
        .orderBy(desc(tenants.createdAt)),
      db.select({ tenantId: sites.tenantId, count: sql<number>`count(*)` }).from(sites).where(sql`${sites.status} <> 'archived'`).groupBy(sites.tenantId),
    ]);
    const countByTenant = new Map(counts.map((item) => [item.tenantId, Number(item.count)]));
    return rows.map((row) => ({ ...row, currentBranchCount: countByTenant.get(row.tenantId) ?? 0 }));
  }),

  saveTenantBranchSettings: platformAdminProcedure.input(z.object({
    tenantId: z.number().int().positive(),
    isEnabledOverride: z.boolean().nullable(),
    maxBranchesOverride: z.number().int().min(1).max(1000).nullable(),
    disabledBehavior: z.enum(["read_only", "suspended"]).default("read_only"),
  })).mutation(async ({ ctx, input }) => {
    const db = await dbOrThrow();
    const [tenant] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, input.tenantId)).limit(1);
    if (!tenant) throw new TRPCError({ code: "NOT_FOUND", message: "صاحب المولد غير موجود." });
    await db.insert(tenantBranchSettings).values(input).onDuplicateKeyUpdate({ set: { isEnabledOverride: input.isEnabledOverride, maxBranchesOverride: input.maxBranchesOverride, disabledBehavior: input.disabledBehavior, updatedAt: new Date() } });
    const [site] = await db.select({ id: sites.id }).from(sites).where(eq(sites.tenantId, input.tenantId)).limit(1);
    if (site) await db.insert(auditLogs).values({ tenantId: input.tenantId, siteId: site.id, userId: ctx.user.id, entityType: "tenant_branch_settings", entityId: String(input.tenantId), action: "platform_admin_update_branch_settings", afterData: input, actorPlatformRole: platformRoleOf(ctx.user) });
    await db.insert(platformSecurityEvents).values({ eventType: "security_change", severity: "info", status: "success", title: "تحديث تفعيل الأفرع لصاحب مولد", createdByUserId: ctx.user.id, metadata: input });
    return { success: true };
  }),

  platformConfiguration: platformAdminProcedure.query(async () => { const db = await dbOrThrow(); const [settings, recoveries, tariffPolicies] = await Promise.all([db.select().from(platformSettings).orderBy(platformSettings.settingKey), db.select({ id: accessRecoveryRequests.id, tenantName: tenants.name, ownerName: tenantOwnerProfiles.fullName, method: accessRecoveryRequests.method, status: accessRecoveryRequests.status, note: accessRecoveryRequests.note, createdAt: accessRecoveryRequests.createdAt }).from(accessRecoveryRequests).innerJoin(tenants, eq(accessRecoveryRequests.tenantId, tenants.id)).leftJoin(tenantOwnerProfiles, eq(tenantOwnerProfiles.tenantId, tenants.id)).orderBy(desc(accessRecoveryRequests.createdAt)).limit(100), db.select().from(platformTariffPolicies).orderBy(desc(platformTariffPolicies.effectiveFrom)).limit(1)]); return { settings, recoveries, currentTariff: tariffPolicies[0] ?? null }; }),

  savePlatformSetting: platformAdminProcedure.input(z.object({ settingKey: z.string().min(2).max(100), isEnabled: z.boolean(), message: z.string().max(4000).optional(), value: z.record(z.string(), z.unknown()).optional() })).mutation(async ({ ctx, input }) => {
    const db = await dbOrThrow(); await db.insert(platformSettings).values({ ...input, updatedByUserId: ctx.user.id }).onDuplicateKeyUpdate({ set: { isEnabled: input.isEnabled, message: input.message, value: input.value, updatedByUserId: ctx.user.id } });
    await db.insert(platformSecurityEvents).values({ eventType: "security_change", severity: input.settingKey === "maintenance_mode" ? "warning" : "info", status: "success", title: `تحديث إعداد المنصة: ${input.settingKey}`, createdByUserId: ctx.user.id, metadata: { isEnabled: input.isEnabled } }); return { success: true };
  }),

  requestOwnerAccessRecovery: platformAdminProcedure.input(z.object({ tenantId: z.number().int().positive(), note: z.string().max(2000).optional() })).mutation(async ({ ctx, input }) => {
    const db = await dbOrThrow(); const [owner] = await db.select().from(tenantOwnerProfiles).where(eq(tenantOwnerProfiles.tenantId, input.tenantId)).limit(1); if (!owner) throw new TRPCError({ code: "NOT_FOUND", message: "ملف مالك المولد غير موجود." });
    await db.insert(accessRecoveryRequests).values({ tenantId: input.tenantId, ownerUserId: owner.ownerUserId, requestedByUserId: ctx.user.id, method: "oauth_invite", status: "pending", note: input.note });
    const [site] = await db.select().from(sites).where(eq(sites.tenantId, input.tenantId)).limit(1); if (site) await db.insert(auditLogs).values({ tenantId: input.tenantId, siteId: site.id, userId: ctx.user.id, entityType: "access_recovery", entityId: String(input.tenantId), action: "platform_admin_request_owner_access_recovery" });
    return { success: true, delivery: "deferred" as const };
  }),

  rolePolicies: platformAdminProcedure.query(async () => (await dbOrThrow()).select().from(platformRolePolicies).orderBy(platformRolePolicies.role, platformRolePolicies.capability)),

  saveRolePolicy: platformAdminProcedure.input(z.object({ role: z.enum(["owner", "manager", "accountant", "collector", "technician", "viewer"]), capability: z.enum(["manageSubscribers", "manageGenerators", "recordReadings", "accessFieldApp", "approveReadings", "manageTariffs", "issueInvoices", "collectPayments", "manageExpenses", "managePayroll", "manageTeam", "manageMessaging", "viewAudit"]), isAllowed: z.boolean() })).mutation(async ({ ctx, input }) => {
    const db = await dbOrThrow();
    await db.insert(platformRolePolicies).values({ ...input, updatedByUserId: ctx.user.id }).onDuplicateKeyUpdate({ set: { isAllowed: input.isAllowed, updatedByUserId: ctx.user.id } });
    await db.insert(platformSecurityEvents).values({ eventType: "security_change", severity: "warning", status: "success", title: `تحديث سياسة الدور: ${input.role}`, createdByUserId: ctx.user.id, metadata: input });
    return { success: true };
  }),

  impersonationStatus: platformAdminProcedure.query(() => ({ enabled: false as const, confirmationRequired: true as const, reason: "انتحال جلسة مالك المولد معطّل إلى حين اعتماد سياسة أمان مستقلة وموافقة قانونية وسجل تدقيق غير قابل للتعديل." })),

  generatorDetails: platformAdminProcedure.input(z.object({ generatorId: z.number().int().positive() })).query(async ({ input }) => {
    const db = await dbOrThrow();
    const [generator] = await db.select({ id: generators.id, code: generators.code, name: generators.name, status: generators.status, ratedCapacityKw: generators.ratedCapacityKw, fuelType: generators.fuelType, fuelLevelLiters: generators.fuelLevelLiters, operatingHours: generators.operatingHours, lastMaintenanceAt: generators.lastMaintenanceAt, tenantId: generators.tenantId, tenantName: tenants.name, siteId: sites.id, siteName: sites.name })
      .from(generators).innerJoin(tenants, eq(generators.tenantId, tenants.id)).innerJoin(sites, eq(generators.siteId, sites.id)).where(eq(generators.id, input.generatorId)).limit(1);
    if (!generator) throw new TRPCError({ code: "NOT_FOUND", message: "المولد غير موجود." });
    const activity = await db.select({ id: auditLogs.id, action: auditLogs.action, entityType: auditLogs.entityType, createdAt: auditLogs.createdAt, userName: users.name })
      .from(auditLogs).leftJoin(users, eq(auditLogs.userId, users.id)).where(eq(auditLogs.siteId, generator.siteId)).orderBy(desc(auditLogs.createdAt)).limit(30);
    return {
      generator,
      activity,
      subscriberSummary: { total: 0, active: 0 },
      subscribers: [] as Array<{ id: number; fullName: string; subscriberNo: string; phone: string; subscriptionType: "residential" | "commercial"; serviceStatus: "active" | "suspended" | "disconnected" }>,
      invoices: [] as Array<{ id: number; invoiceNo: string; billingPeriod: string; totalAmount: string; balanceDue: string; status: "draft" | "issued" | "partially_paid" | "paid" | "overdue" | "cancelled"; subscriberName: string; issueDate: Date }>,
    };
  }),
});
