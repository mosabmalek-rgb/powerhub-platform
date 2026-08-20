import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { auditLogs, generators, invoices, meterReadings, meters, notificationMessages, payments, platformSecurityEvents, platformSecuritySettings, sites, staffProfiles, subscribers, tenantMembers, tenantOwnerProfiles, tenantSubscriptions, tenants, users } from "../drizzle/schema";
import { getDb } from "./db";
import { protectedProcedure, router } from "./_core/trpc";

const planSchema = z.enum(["starter", "professional", "enterprise"]);
const subscriptionStatusSchema = z.enum(["trial", "active", "overdue", "suspended", "cancelled"]);
const billingCycleSchema = z.enum(["monthly", "yearly"]);

const platformAdminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN", message: "هذه المساحة مخصصة لآدمن PowerHub فقط." });
  }
  return next({ ctx });
});

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

async function ownerOverview(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, tenantId?: number) {
  const tenantWhere = tenantId ? eq(tenants.id, tenantId) : undefined;
  const rows = await db.select({ tenant: tenants, owner: tenantOwnerProfiles, subscription: tenantSubscriptions })
    .from(tenants)
    .leftJoin(tenantOwnerProfiles, eq(tenantOwnerProfiles.tenantId, tenants.id))
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
      tenantId: tenantOwnerProfiles.tenantId,
      ownerName: tenantOwnerProfiles.fullName,
      phone: tenantOwnerProfiles.phone,
      invitedAt: tenantOwnerProfiles.invitedAt,
      tenantName: tenants.name,
    }).from(tenantOwnerProfiles)
      .innerJoin(tenants, eq(tenantOwnerProfiles.tenantId, tenants.id))
      .where(sql`${tenantOwnerProfiles.ownerUserId} is null`)
      .orderBy(desc(tenantOwnerProfiles.createdAt));
    const staffDirectory = await db.select({ id: staffProfiles.id, role: staffProfiles.role, isActive: staffProfiles.isActive, userName: users.name, userEmail: users.email, tenantName: tenants.name, siteName: sites.name })
      .from(staffProfiles).innerJoin(users, eq(staffProfiles.userId, users.id)).leftJoin(sites, eq(staffProfiles.siteId, sites.id)).leftJoin(tenants, eq(sites.tenantId, tenants.id)).orderBy(desc(staffProfiles.updatedAt)).limit(300);
    const subscriberDirectory = await db.select({ id: subscribers.id, subscriberNo: subscribers.subscriberNo, fullName: subscribers.fullName, subscriptionType: subscribers.subscriptionType, serviceStatus: subscribers.serviceStatus, tenantName: tenants.name, siteName: sites.name })
      .from(subscribers).innerJoin(tenants, eq(subscribers.tenantId, tenants.id)).innerJoin(sites, eq(subscribers.siteId, sites.id)).orderBy(desc(subscribers.createdAt)).limit(300);
    return {
      generators: {
        total: Number(generatorTotals?.total ?? 0), active: Number(generatorTotals?.active ?? 0), maintenance: Number(generatorTotals?.maintenance ?? 0), stopped: Number(generatorTotals?.stopped ?? 0), blocked: Number(generatorTotals?.blocked ?? 0), capacityKw: Number(generatorTotals?.capacityKw ?? 0), directory: generatorDirectory, pendingRegistrations,
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
    return db.select({ id: users.id, name: users.name, email: users.email, role: users.role, lastSignedIn: users.lastSignedIn })
      .from(users).orderBy(desc(users.lastSignedIn)).limit(200);
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
    city: z.string().max(100).optional(),
    plan: planSchema.default("starter"),
    subscriptionStatus: subscriptionStatusSchema.default("trial"),
    billingCycle: billingCycleSchema.default("monthly"),
    endsAt: z.date().optional(),
    autoRenew: z.boolean().default(false),
    notes: z.string().max(2000).optional(),
  })).mutation(async ({ ctx, input }) => {
    const db = await dbOrThrow();
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
        phone: input.ownerPhone,
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
      if (input.ownerUserId) {
        await tx.insert(tenantMembers).values({ tenantId, userId: input.ownerUserId, role: "owner", isActive: true });
        await tx.insert(staffProfiles).values({ siteId, userId: input.ownerUserId, role: "owner", isActive: true });
      }
      return { tenantId, siteId };
    });
    await db.insert(auditLogs).values({
      tenantId: result.tenantId,
      siteId: result.siteId,
      userId: ctx.user.id,
      entityType: "tenant",
      entityId: String(result.tenantId),
      action: "platform_admin_create_generator_owner",
      afterData: { tenantName: input.tenantName, ownerName: input.ownerName, plan: input.plan, subscriptionStatus: input.subscriptionStatus },
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

  setGeneratorStatus: platformAdminProcedure.input(z.object({ id: z.number().int().positive(), status: z.enum(["active", "maintenance", "stopped", "offline", "blocked"]) })).mutation(async ({ ctx, input }) => {
    const db = await dbOrThrow();
    const [generator] = await db.select().from(generators).where(eq(generators.id, input.id)).limit(1);
    if (!generator) throw new TRPCError({ code: "NOT_FOUND", message: "المولد غير موجود." });
    await db.update(generators).set({ status: input.status }).where(eq(generators.id, input.id));
    await db.insert(auditLogs).values({ tenantId: generator.tenantId, siteId: generator.siteId, userId: ctx.user.id, entityType: "generator", entityId: String(generator.id), action: "platform_admin_update_generator_status", beforeData: { status: generator.status }, afterData: { status: input.status } });
    return { success: true };
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
});
