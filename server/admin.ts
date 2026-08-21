import crypto from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, gte, inArray, like, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { accessInvitations, accessRecoveryRequests, auditLogs, complaints, generators, invoices, meterReadings, meters, notificationMessages, payments, platformAccessInvitations, platformRolePolicies, platformSecurityEvents, platformSecuritySettings, platformSettings, platformTariffPolicies, sitePortalSettings, sites, staffProfiles, subscribers, tenantMembers, tenantMessagingConfigurations, tenantOwnerProfiles, tenantSubscriptions, tenants, users } from "../drizzle/schema";
import { getDb, syncSupabaseUser } from "./db";
import { authenticatedProcedure, router } from "./_core/trpc";
import { encryptTenantCredential } from "./tenant-crypto";
import { supabaseAdmin } from "./supabase-admin";

const planSchema = z.enum(["starter", "professional", "enterprise"]);
const subscriptionStatusSchema = z.enum(["trial", "active", "overdue", "suspended", "cancelled"]);
const billingCycleSchema = z.enum(["monthly", "yearly"]);

const platformRoleSchema = z.enum(["platform_owner", "platform_admin", "finance_admin"]);
type PlatformRole = z.infer<typeof platformRoleSchema>;

function platformRoleOf(user: { role: "user" | "admin"; platformRole: PlatformRole | null }) {
  return user.platformRole ?? "platform_admin";
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
  createGeneratorOwnerWithTemporaryPassword: platformAdminProcedure.input(z.object({
    tenantName: z.string().min(2).max(160),
    slug: z.string().min(3).max(80).regex(/^[a-z0-9-]+$/),
    ownerName: z.string().min(2).max(180),
    ownerPhone: z.string().min(5).max(30),
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
    const generatorName = input.generatorName.trim();
    const db = await dbOrThrow();
    const [[existingPhone], [existingGenerator], [existingEmail]] = await Promise.all([
      db.select({ id: tenantOwnerProfiles.id }).from(tenantOwnerProfiles).where(eq(tenantOwnerProfiles.phone, phone)).limit(1),
      db.select({ id: generators.id }).from(generators).where(eq(generators.name, generatorName)).limit(1),
      db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1),
    ]);
    if (existingPhone) throw new TRPCError({ code: "CONFLICT", message: "رقم هاتف صاحب المولد مستخدم بالفعل." });
    if (existingGenerator) throw new TRPCError({ code: "CONFLICT", message: "اسم المولد مستخدم بالفعل." });
    if (existingEmail) throw new TRPCError({ code: "CONFLICT", message: "البريد الإلكتروني لصاحب المولد مستخدم بالفعل." });
    const { data: created, error: createError } = await supabaseAdmin().auth.admin.createUser({
      email,
      password: input.temporaryPassword,
      email_confirm: true,
      user_metadata: { name: input.ownerName },
    });
    if (createError || !created.user) throw new TRPCError({ code: "BAD_REQUEST", message: "تعذر إنشاء حساب صاحب المولد في Supabase. قد يكون البريد مستخدماً بالفعل." });

    try {
      const ownerUser = await syncSupabaseUser({ id: created.user.id, email, name: input.ownerName });
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
        await tx.insert(staffProfiles).values({ siteId, userId: ownerUser.id, role: "owner", isActive: true });
        return { tenantId, siteId, generatorId };
      });
      await db.update(users).set({ mustChangePassword: true, temporaryPasswordIssuedAt: startedAt }).where(eq(users.id, ownerUser.id));
      await db.insert(auditLogs).values({ tenantId: result.tenantId, siteId: result.siteId, userId: ctx.user.id, entityType: "generator", entityId: String(result.generatorId), action: "platform_admin_create_pending_generator_owner", afterData: { tenantName: input.tenantName, ownerName: input.ownerName, ownerEmail: email, generatorName, generatorCode: input.generatorCode, generatorStatus: "pending", plan: input.plan }, actorPlatformRole: platformRoleOf(ctx.user) });
      return { ...result, ownerUserId: ownerUser.id, forcePasswordChange: true };
    } catch (error) {
      await supabaseAdmin().auth.admin.deleteUser(created.user.id);
      throw error;
    }
  }),
  overview: platformAdminProcedure.input(z.object({ tenantId: z.number().int().positive().optional() }).optional()).query(async ({ input }) => {
    const db = await dbOrThrow();
    const owners = await ownerOverview(db, input?.tenantId);
    const totals = owners.reduce((acc, item) => ({
      generatorOwners: acc.generatorOwners + 1,
      residential: acc.residential + item.subscribers.residential,
      commercial: acc.commercial + item.subscribers.commercial,
      subscribers: acc.subscribers + item.subscribers.total,
      activeSubscriptions: acc.activeSubscriptions + (item.subscription?.status === "active" || item.subscription?.status === "trial" ? 1 : 0),
    }), { generatorOwners: 0, residential: 0, commercial: 0, subscribers: 0, activeSubscriptions: 0 });
    return { totals, owners };
  }),

  listOwners: platformAdminProcedure.query(async () => ownerOverview(await dbOrThrow())),

  platformSnapshot: platformAdminProcedure.query(async () => {
    const db = await dbOrThrow();
    const [generatorTotals] = await db.select({
      total: sql<number>`count(*)`,
      active: sql<number>`sum(case when ${generators.status} = 'active' then 1 else 0 end)`,
      pending: sql<number>`sum(case when ${generators.status} = 'pending' then 1 else 0 end)`,
      maintenance: sql<number>`sum(case when ${generators.status} = 'maintenance' then 1 else 0 end)`,
      stopped: sql<number>`sum(case when ${generators.status} in ('stopped', 'offline') then 1 else 0 end)`,
      blocked: sql<number>`sum(case when ${generators.status} = 'blocked' then 1 else 0 end)`,
      capacityKw: sql<number>`sum(${generators.ratedCapacityKw})`,
    }).from(generators);
    const [userTotals] = await db.select({
      total: sql<number>`count(*)`,
      platformAdmins: sql<number>`sum(case when ${users.role} = 'admin' then 1 else 0 end)`,
    }).from(users);
    const [staffTotal] = await db.select({ total: sql<number>`count(*)` }).from(staffProfiles).where(eq(staffProfiles.isActive, true));
    const [invoiceTotals] = await db.select({
      overdueCount: sql<number>`sum(case when ${invoices.status} = 'overdue' then 1 else 0 end)`,
      overdueAmount: sql<number>`sum(case when ${invoices.status} = 'overdue' then ${invoices.balanceDue} else 0 end)`,
      issuedAmount: sql<number>`sum(case when ${invoices.status} in ('issued', 'partially_paid', 'paid', 'overdue') then ${invoices.totalAmount} else 0 end)`,
    }).from(invoices);
    const [paymentTotals] = await db.select({
      completedAmount: sql<number>`sum(case when ${payments.status} = 'completed' then ${payments.amount} else 0 end)`,
      completedCount: sql<number>`sum(case when ${payments.status} = 'completed' then 1 else 0 end)`,
    }).from(payments);
    const [readingTotals] = await db.select({
      approvedReadings: sql<number>`sum(case when ${meterReadings.status} = 'approved' then 1 else 0 end)`,
      consumptionKwh: sql<number>`sum(case when ${meterReadings.status} = 'approved' then ${meterReadings.consumptionKwh} else 0 end)`,
    }).from(meterReadings);
    const [growthTotals] = await db.select({
      tenants: sql<number>`count(*)`,
      subscribers: sql<number>`(select count(*) from ${subscribers})`,
    }).from(tenants);
    const paymentMethods = await db.select({
      method: payments.paymentMethod,
      count: sql<number>`count(*)`,
      amount: sql<number>`sum(${payments.amount})`,
    }).from(payments).where(eq(payments.status, "completed")).groupBy(payments.paymentMethod);
    const collectionsByGenerator = await db.select({
      generatorId: generators.id,
      generatorName: generators.name,
      generatorCode: generators.code,
      tenantName: tenants.name,
      count: sql<number>`count(${payments.id})`,
      amount: sql<number>`sum(${payments.amount})`,
    }).from(payments)
      .innerJoin(invoices, eq(payments.invoiceId, invoices.id))
      .innerJoin(meters, eq(invoices.meterId, meters.id))
      .innerJoin(generators, eq(meters.generatorId, generators.id))
      .innerJoin(tenants, eq(generators.tenantId, tenants.id))
      .where(eq(payments.status, "completed"))
      .groupBy(generators.id, generators.name, generators.code, tenants.name)
      .orderBy(desc(sql`sum(${payments.amount})`));
    const notificationStatuses = await db.select({
      status: notificationMessages.status,
      count: sql<number>`count(*)`,
    }).from(notificationMessages).groupBy(notificationMessages.status);
    const recentAudit = await db.select({
      id: auditLogs.id,
      action: auditLogs.action,
      entityType: auditLogs.entityType,
      createdAt: auditLogs.createdAt,
      tenantName: tenants.name,
      siteName: sites.name,
      userName: users.name,
    }).from(auditLogs)
      .leftJoin(tenants, eq(auditLogs.tenantId, tenants.id))
      .leftJoin(sites, eq(auditLogs.siteId, sites.id))
      .leftJoin(users, eq(auditLogs.userId, users.id))
      .orderBy(desc(auditLogs.createdAt)).limit(30);
    const generatorDirectory = await db.select({
      id: generators.id,
      code: generators.code,
      name: generators.name,
      status: generators.status,
      ratedCapacityKw: generators.ratedCapacityKw,
      tenantId: generators.tenantId,
      tenantName: tenants.name,
      siteName: sites.name,
    }).from(generators)
      .innerJoin(tenants, eq(generators.tenantId, tenants.id))
      .innerJoin(sites, eq(generators.siteId, sites.id))
      .orderBy(desc(generators.createdAt)).limit(200);
    const pendingRegistrations = await db.select({
      generatorId: generators.id,
      generatorName: generators.name,
      generatorCode: generators.code,
      ratedCapacityKw: generators.ratedCapacityKw,
      tenantId: tenantOwnerProfiles.tenantId,
      ownerName: tenantOwnerProfiles.fullName,
      phone: tenantOwnerProfiles.phone,
      tenantName: tenants.name,
      siteName: sites.name,
      createdAt: generators.createdAt,
    }).from(generators)
      .innerJoin(tenantOwnerProfiles, eq(generators.tenantId, tenantOwnerProfiles.tenantId))
      .innerJoin(tenants, eq(generators.tenantId, tenants.id))
      .innerJoin(sites, eq(generators.siteId, sites.id))
      .where(eq(generators.status, "pending"))
      .orderBy(desc(generators.createdAt));
    const staffDirectory = await db.select({ id: staffProfiles.id, role: staffProfiles.role, isActive: staffProfiles.isActive, userName: users.name, userEmail: users.email, tenantName: tenants.name, siteName: sites.name })
      .from(staffProfiles).innerJoin(users, eq(staffProfiles.userId, users.id)).leftJoin(sites, eq(staffProfiles.siteId, sites.id)).leftJoin(tenants, eq(sites.tenantId, tenants.id)).orderBy(desc(staffProfiles.updatedAt)).limit(300);
    const subscriberDirectory = await db.select({ id: subscribers.id, subscriberNo: subscribers.subscriberNo, fullName: subscribers.fullName, subscriptionType: subscribers.subscriptionType, serviceStatus: subscribers.serviceStatus, tenantName: tenants.name, siteName: sites.name })
      .from(subscribers).innerJoin(tenants, eq(subscribers.tenantId, tenants.id)).innerJoin(sites, eq(subscribers.siteId, sites.id)).orderBy(desc(subscribers.createdAt)).limit(300);
    return {
      generators: {
        total: Number(generatorTotals?.total ?? 0), active: Number(generatorTotals?.active ?? 0), pending: Number(generatorTotals?.pending ?? 0), maintenance: Number(generatorTotals?.maintenance ?? 0), stopped: Number(generatorTotals?.stopped ?? 0), blocked: Number(generatorTotals?.blocked ?? 0), capacityKw: Number(generatorTotals?.capacityKw ?? 0), directory: generatorDirectory, pendingRegistrations,
      },
      users: { total: Number(userTotals?.total ?? 0), platformAdmins: Number(userTotals?.platformAdmins ?? 0), activeStaff: Number(staffTotal?.total ?? 0), staffDirectory, subscriberDirectory },
      finance: { overdueCount: Number(invoiceTotals?.overdueCount ?? 0), overdueAmount: Number(invoiceTotals?.overdueAmount ?? 0), issuedAmount: Number(invoiceTotals?.issuedAmount ?? 0), completedPayments: Number(paymentTotals?.completedCount ?? 0), completedAmount: Number(paymentTotals?.completedAmount ?? 0), paymentMethods: paymentMethods.map((item) => ({ ...item, count: Number(item.count), amount: Number(item.amount) })), collectionsByGenerator: collectionsByGenerator.map((item) => ({ ...item, count: Number(item.count), amount: Number(item.amount) })) },
      reports: { approvedReadings: Number(readingTotals?.approvedReadings ?? 0), consumptionKwh: Number(readingTotals?.consumptionKwh ?? 0), tenants: Number(growthTotals?.tenants ?? 0), subscribers: Number(growthTotals?.subscribers ?? 0), complaintsEnabled: false },
      notifications: { statuses: notificationStatuses.map((item) => ({ ...item, count: Number(item.count) })) },
      security: { recentAudit },
    };
  }),

  userDirectory: platformAdminProcedure.query(async () => {
    const db = await dbOrThrow();
    return db.select({ id: users.id, name: users.name, email: users.email, role: users.role, platformRole: users.platformRole, accountStatus: users.accountStatus, lastSignedIn: users.lastSignedIn })
      .from(users).orderBy(desc(users.lastSignedIn)).limit(200);
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
        await tx.insert(staffProfiles).values({ siteId, userId: input.ownerUserId, role: "owner", isActive: true });
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
      const [site] = input.siteId
        ? await db.select().from(sites).where(and(eq(sites.id, input.siteId), eq(sites.tenantId, input.tenantId))).limit(1)
        : await db.select().from(sites).where(eq(sites.tenantId, input.tenantId)).limit(1);
      if (!site) throw new TRPCError({ code: "NOT_FOUND", message: "لا توجد محطة لهذا المستأجر لربط مالكها." });
      await db.transaction(async (tx) => {
        await tx.insert(tenantMembers).values({ tenantId: input.tenantId, userId: input.userId, role: "owner", isActive: true }).onDuplicateKeyUpdate({ set: { role: "owner", isActive: true } });
        await tx.insert(staffProfiles).values({ siteId: site.id, userId: input.userId, role: "owner", isActive: true }).onDuplicateKeyUpdate({ set: { isActive: true } });
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
  })).mutation(async ({ ctx, input }) => {
    const db = await dbOrThrow();
    const [subscription] = await db.select().from(tenantSubscriptions).where(eq(tenantSubscriptions.tenantId, input.tenantId)).limit(1);
    if (!subscription) throw new TRPCError({ code: "NOT_FOUND", message: "اشتراك المستأجر غير موجود." });
    const [site] = await db.select().from(sites).where(eq(sites.tenantId, input.tenantId)).limit(1);
    if (!site) throw new TRPCError({ code: "NOT_FOUND", message: "لا توجد محطة مرتبطة بالمستأجر." });
    await db.transaction(async (tx) => {
      await tx.update(tenantSubscriptions).set({ plan: input.plan, status: input.status, billingCycle: input.billingCycle, endsAt: input.endsAt, autoRenew: input.autoRenew, notes: input.notes }).where(eq(tenantSubscriptions.tenantId, input.tenantId));
      await tx.update(tenants).set({ plan: input.plan, status: tenantStatusForSubscription(input.status) }).where(eq(tenants.id, input.tenantId));
    });
    await db.insert(auditLogs).values({ tenantId: input.tenantId, siteId: site.id, userId: ctx.user.id, entityType: "tenant_subscription", entityId: String(subscription.id), action: "platform_admin_update_subscription", afterData: input });
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
    const db = await dbOrThrow();
    return db.select({ id: notificationMessages.id, channel: notificationMessages.channel, eventType: notificationMessages.eventType, recipient: notificationMessages.recipient, status: notificationMessages.status, attempts: notificationMessages.attempts, lastError: notificationMessages.lastError, createdAt: notificationMessages.createdAt, tenantName: tenants.name })
      .from(notificationMessages).innerJoin(tenants, eq(notificationMessages.tenantId, tenants.id))
      .where(input?.status ? eq(notificationMessages.status, input.status) : undefined).orderBy(desc(notificationMessages.createdAt)).limit(300);
  }),

  securityCenter: platformAdminProcedure.query(async () => {
    const db = await dbOrThrow();
    const events = await db.select({ id: platformSecurityEvents.id, eventType: platformSecurityEvents.eventType, severity: platformSecurityEvents.severity, status: platformSecurityEvents.status, title: platformSecurityEvents.title, details: platformSecurityEvents.details, createdAt: platformSecurityEvents.createdAt, resolvedAt: platformSecurityEvents.resolvedAt, userName: users.name })
      .from(platformSecurityEvents).leftJoin(users, eq(platformSecurityEvents.relatedUserId, users.id)).orderBy(desc(platformSecurityEvents.createdAt)).limit(300);
    const settings = await db.select().from(platformSecuritySettings).orderBy(platformSecuritySettings.settingKey);
    return { events, settings };
  }),

  recordSecurityEvent: platformAdminProcedure.input(z.object({ eventType: z.enum(["suspicious_login", "backup", "security_change"]), severity: z.enum(["info", "warning", "critical"]), status: z.enum(["open", "resolved", "success", "failed"]), title: z.string().min(3).max(180), details: z.string().max(4000).optional(), relatedUserId: z.number().int().positive().optional() })).mutation(async ({ ctx, input }) => {
    const db = await dbOrThrow();
    await db.insert(platformSecurityEvents).values({ ...input, createdByUserId: ctx.user.id, resolvedAt: input.status === "resolved" || input.status === "success" ? new Date() : undefined });
    return { success: true };
  }),

  saveSecuritySetting: platformAdminProcedure.input(z.object({ settingKey: z.string().min(2).max(100), isEnabled: z.boolean(), value: z.string().max(4000).optional() })).mutation(async ({ ctx, input }) => {
    const db = await dbOrThrow();
    await db.insert(platformSecuritySettings).values({ ...input, updatedByUserId: ctx.user.id }).onDuplicateKeyUpdate({ set: { isEnabled: input.isEnabled, value: input.value, updatedByUserId: ctx.user.id } });
    await db.insert(platformSecurityEvents).values({ eventType: "security_change", severity: "info", status: "success", title: `تحديث إعداد الحماية: ${input.settingKey}`, createdByUserId: ctx.user.id, metadata: { isEnabled: input.isEnabled } });
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
      .from(meterReadings).innerJoin(meters, eq(meterReadings.meterId, meters.id)).innerJoin(generators, eq(meters.generatorId, generators.id)).innerJoin(sites, eq(generators.siteId, sites.id))
      .where(eq(meterReadings.status, "approved")).groupBy(sites.city).orderBy(desc(sql`sum(${meterReadings.consumptionKwh})`)).limit(12);
    const collectionsByGenerator = await db.select({ generatorId: generators.id, generatorName: generators.name, code: generators.code, tenantName: tenants.name, amount: sql<number>`sum(${payments.amount})` })
      .from(payments).innerJoin(invoices, eq(payments.invoiceId, invoices.id)).innerJoin(meters, eq(invoices.meterId, meters.id)).innerJoin(generators, eq(meters.generatorId, generators.id)).innerJoin(tenants, eq(generators.tenantId, tenants.id))
      .where(eq(payments.status, "completed")).groupBy(generators.id, generators.name, generators.code, tenants.name).orderBy(desc(sql`sum(${payments.amount})`)).limit(10);
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

  saveRolePolicy: platformAdminProcedure.input(z.object({ role: z.enum(["owner", "manager", "accountant", "collector", "technician", "viewer"]), capability: z.enum(["manageSubscribers", "manageGenerators", "recordReadings", "approveReadings", "manageTariffs", "issueInvoices", "collectPayments", "manageExpenses", "manageTeam", "manageMessaging", "viewAudit"]), isAllowed: z.boolean() })).mutation(async ({ ctx, input }) => {
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
    const [subscriberSummary] = await db.select({ total: sql<number>`count(*)`, active: sql<number>`sum(case when ${subscribers.serviceStatus} = 'active' then 1 else 0 end)` }).from(meters).innerJoin(subscribers, eq(meters.subscriberId, subscribers.id)).where(eq(meters.generatorId, generator.id));
    const generatorSubscribers = await db.select({ id: subscribers.id, fullName: subscribers.fullName, subscriberNo: subscribers.subscriberNo, phone: subscribers.phone, subscriptionType: subscribers.subscriptionType, serviceStatus: subscribers.serviceStatus, meterSerial: meters.serialNumber })
      .from(meters).innerJoin(subscribers, eq(meters.subscriberId, subscribers.id)).where(eq(meters.generatorId, generator.id)).orderBy(desc(subscribers.createdAt)).limit(50);
    const latestInvoices = await db.select({ id: invoices.id, invoiceNo: invoices.invoiceNo, billingPeriod: invoices.billingPeriod, totalAmount: invoices.totalAmount, balanceDue: invoices.balanceDue, status: invoices.status, subscriberName: subscribers.fullName, issueDate: invoices.issueDate })
      .from(invoices).innerJoin(meters, eq(invoices.meterId, meters.id)).innerJoin(subscribers, eq(invoices.subscriberId, subscribers.id)).where(eq(meters.generatorId, generator.id)).orderBy(desc(invoices.issueDate)).limit(20);
    const activity = await db.select({ id: auditLogs.id, action: auditLogs.action, entityType: auditLogs.entityType, createdAt: auditLogs.createdAt, userName: users.name })
      .from(auditLogs).leftJoin(users, eq(auditLogs.userId, users.id)).where(eq(auditLogs.siteId, generator.siteId)).orderBy(desc(auditLogs.createdAt)).limit(30);
    return { generator, subscriberSummary: { total: Number(subscriberSummary?.total ?? 0), active: Number(subscriberSummary?.active ?? 0) }, subscribers: generatorSubscribers, invoices: latestInvoices, activity };
  }),
});
