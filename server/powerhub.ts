import crypto from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { z } from "zod";
import {
  auditLogs,
  collectorSessions,
  expenses,
  invoiceLines,
  generators,
  invoiceShareLinks,
  invoices,
  meterReadings,
  meters,
  notificationMessages,
  payments,
  platformRolePolicies,
  sites,
  staffProfiles,
  subscribers,
  tariffs,
  tenantMembers,
  tenantMessagingConfigurations,
  tenants,
  users,
} from "../drizzle/schema";
import { getDb } from "./db";
import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
import { calculateInvoiceAmounts, generateInvoiceShareToken, hashInvoiceShareToken, nextInvoiceNo } from "./powerhub-utils";
import { resolveInvoiceNotificationChannels } from "./notification-channels";
import { storagePut } from "./storage";
import { encryptTenantCredential, hashWebhookVerifyToken } from "./tenant-crypto";
import { rolesWith, type PowerCapability, type PowerRole } from "../shared/powerhub-rbac";

const createRoles = rolesWith("issueInvoices");
const recordRoles = rolesWith("collectPayments");
const readingRoles = rolesWith("recordReadings");

export function reportDateRange(startDate: string, endDate: string) {
  const start = new Date(`${startDate}T00:00:00.000Z`);
  const endExclusive = new Date(`${endDate}T00:00:00.000Z`);
  endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);
  return { start, endExclusive };
}

async function dbOrThrow() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة حالياً." });
  return db;
}

function insertId(result: unknown) {
  const header = Array.isArray(result) ? result[0] : result;
  const value = (header as { insertId?: number | bigint })?.insertId;
  if (value === undefined) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر إنشاء السجل." });
  return Number(value);
}

async function getSiteTenant(siteId: number) {
  const db = await dbOrThrow();
  const [site] = await db.select({ id: sites.id, tenantId: sites.tenantId }).from(sites).where(eq(sites.id, siteId)).limit(1);
  if (!site) throw new TRPCError({ code: "NOT_FOUND", message: "المحطة غير موجودة." });
  return site.tenantId;
}

async function resolveRole(userId: number, siteId: number): Promise<PowerRole> {
  const db = await dbOrThrow();
  const [user] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1);
  if (user?.role === "admin") return "owner";

  const tenantId = await getSiteTenant(siteId);
  if (tenantId) {
    const [member] = await db.select({ role: tenantMembers.role }).from(tenantMembers)
      .where(and(eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.userId, userId), eq(tenantMembers.isActive, true), eq(tenantMembers.membershipStatus, "active"))).limit(1);
    if (!member) throw new TRPCError({ code: "FORBIDDEN", message: "لا توجد عضوية فعالة في مساحة صاحب المولد لهذه المحطة." });
    if (member.role === "owner") return "owner";
  }

  const [profile] = await db
    .select({ role: staffProfiles.role })
    .from(staffProfiles)
    .where(and(eq(staffProfiles.userId, userId), eq(staffProfiles.siteId, siteId), eq(staffProfiles.isActive, true)))
    .limit(1);

  if (profile) return profile.role;
  throw new TRPCError({ code: "FORBIDDEN", message: "لا يوجد تعيين فعال لك في هذه المحطة." });
}

async function enforcePlatformRolePolicy(role: PowerRole, capability?: PowerCapability) {
  if (!capability) return;
  const db = await dbOrThrow();
  const [policy] = await db.select({ isAllowed: platformRolePolicies.isAllowed }).from(platformRolePolicies)
    .where(and(eq(platformRolePolicies.role, role), eq(platformRolePolicies.capability, capability))).limit(1);
  if (policy && !policy.isAllowed) throw new TRPCError({ code: "FORBIDDEN", message: "هذه القدرة مقيّدة بسياسة المنصة للدور الحالي." });
}

async function requireRole(userId: number, siteId: number, allowed: PowerRole[], capability?: PowerCapability) {
  const role = await resolveRole(userId, siteId);
  if (!allowed.includes(role)) throw new TRPCError({ code: "FORBIDDEN", message: "لا تملك صلاحية تنفيذ هذه العملية." });
  const db = await dbOrThrow();
  const [user] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1);
  if (user?.role === "admin") return role;
  await enforcePlatformRolePolicy(role, capability);
  return role;
}

async function writeAudit(input: {
  userId?: number;
  siteId?: number;
  tenantId?: number;
  entityType: string;
  entityId: string;
  action: string;
  beforeData?: unknown;
  afterData?: unknown;
  metadata?: unknown;
}) {
  const db = await dbOrThrow();
  const fromAfter = input.afterData as { siteId?: unknown } | undefined;
  const fromMetadata = input.metadata as { siteId?: unknown } | undefined;
  const inferredSiteId = input.siteId ?? (typeof fromAfter?.siteId === "number" ? fromAfter.siteId : undefined) ?? (typeof fromMetadata?.siteId === "number" ? fromMetadata.siteId : undefined);
  const inferredTenantId = input.tenantId ?? (inferredSiteId ? await getSiteTenant(inferredSiteId) : undefined);
  if (!inferredSiteId || !inferredTenantId) throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن تسجيل تدقيق بلا سياق محطة ومستأجر." });
  const [actor] = input.userId ? await db.select({ platformRole: users.platformRole }).from(users).where(eq(users.id, input.userId)).limit(1) : [];
  await db.insert(auditLogs).values({
    tenantId: inferredTenantId,
    siteId: inferredSiteId,
    userId: input.userId,
    actorPlatformRole: actor?.platformRole,
    entityType: input.entityType,
    entityId: input.entityId,
    action: input.action,
    beforeData: input.beforeData,
    afterData: input.afterData,
    metadata: input.metadata,
  });
}

const siteInput = z.object({
  name: z.string().min(2).max(160),
  code: z.string().min(2).max(50).transform((value) => value.toUpperCase()),
  city: z.string().max(100).optional(),
  address: z.string().max(1000).optional(),
});

const siteScoped = z.object({ siteId: z.number().int().positive() });

export const powerhubRouter = router({
  messaging: router({
    listConfigurations: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner"], "manageMessaging");
      const tenantId = await getSiteTenant(input.siteId);
      if (!tenantId) throw new TRPCError({ code: "BAD_REQUEST", message: "المحطة لا تتبع لمساحة مستأجر مهيأة بعد." });
      const db = await dbOrThrow();
      return db.select({ id: tenantMessagingConfigurations.id, channel: tenantMessagingConfigurations.channel, provider: tenantMessagingConfigurations.provider, senderId: tenantMessagingConfigurations.senderId, phoneNumberId: tenantMessagingConfigurations.phoneNumberId, templateName: tenantMessagingConfigurations.templateName, isActive: tenantMessagingConfigurations.isActive, updatedAt: tenantMessagingConfigurations.updatedAt }).from(tenantMessagingConfigurations).where(eq(tenantMessagingConfigurations.tenantId, tenantId));
    }),
    saveConfiguration: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(), channel: z.enum(["whatsapp", "sms"]), provider: z.string().min(2).max(80),
      senderId: z.string().max(120).optional(), phoneNumberId: z.string().max(120).optional(), templateName: z.string().max(120).optional(),
      credential: z.string().min(8).max(4096), webhookVerifyToken: z.string().min(16).max(256).optional(), webhookAppSecret: z.string().min(16).max(512).optional(), isActive: z.boolean().default(true),
    })).mutation(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner"], "manageMessaging");
      const tenantId = await getSiteTenant(input.siteId);
      if (!tenantId) throw new TRPCError({ code: "BAD_REQUEST", message: "المحطة لا تتبع لمساحة مستأجر مهيأة بعد." });
      const db = await dbOrThrow();
      const encrypted = encryptTenantCredential(input.channel === "whatsapp" ? JSON.stringify({ accessToken: input.credential, appSecret: input.webhookAppSecret || undefined }) : input.credential);
      await db.insert(tenantMessagingConfigurations).values({
        tenantId, channel: input.channel, provider: input.provider, senderId: input.senderId, phoneNumberId: input.phoneNumberId,
        templateName: input.templateName, credentialCiphertext: encrypted.ciphertext, credentialIv: encrypted.iv, webhookVerifyTokenHash: input.webhookVerifyToken ? hashWebhookVerifyToken(input.webhookVerifyToken) : undefined, isActive: input.isActive,
      }).onDuplicateKeyUpdate({ set: { provider: input.provider, senderId: input.senderId, phoneNumberId: input.phoneNumberId, templateName: input.templateName, credentialCiphertext: encrypted.ciphertext, credentialIv: encrypted.iv, webhookVerifyTokenHash: input.webhookVerifyToken ? hashWebhookVerifyToken(input.webhookVerifyToken) : sql`${tenantMessagingConfigurations.webhookVerifyTokenHash}`, isActive: input.isActive } });
      await writeAudit({ userId: ctx.user.id, siteId: input.siteId, entityType: "tenant_messaging_configuration", entityId: `${tenantId}:${input.channel}`, action: "upsert", metadata: { channel: input.channel, provider: input.provider, isActive: input.isActive } });
      return { success: true };
    }),
  }),
  staff: router({
    myAccess: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => ({ role: await resolveRole(ctx.user.id, input.siteId) })),
    list: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager"], "manageTeam");
      const db = await dbOrThrow();
      return db.select({ profile: staffProfiles, user: users }).from(staffProfiles)
        .innerJoin(users, eq(staffProfiles.userId, users.id))
        .where(and(eq(staffProfiles.siteId, input.siteId), eq(staffProfiles.isActive, true)));
    }),
    directory: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner"], "manageTeam");
      const db = await dbOrThrow();
      return db.select({ id: users.id, name: users.name, email: users.email, role: users.role }).from(users).orderBy(desc(users.lastSignedIn));
    }),
    assign: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), userId: z.number().int().positive(), role: z.enum(["owner", "manager", "accountant", "collector", "technician", "viewer"]) }))
      .mutation(async ({ ctx, input }) => {
        await requireRole(ctx.user.id, input.siteId, ["owner"], "manageTeam");
        const db = await dbOrThrow();
        const tenantId = await getSiteTenant(input.siteId);
        if (!tenantId) throw new TRPCError({ code: "BAD_REQUEST", message: "يجب ربط المحطة بمستأجر قبل تعيين الفريق." });
        const [existingMembership] = await db.select({ role: tenantMembers.role }).from(tenantMembers)
          .where(and(eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.userId, input.userId))).limit(1);
        const tenantRole = existingMembership?.role === "owner" ? "owner" : "member" as const;
        await db.transaction(async (tx) => {
          await tx.insert(tenantMembers).values({ tenantId, userId: input.userId, role: tenantRole, isActive: true, membershipStatus: "active", expiresAt: null }).onDuplicateKeyUpdate({ set: { role: tenantRole, isActive: true, membershipStatus: "active", expiresAt: null } });
          await tx.update(staffProfiles).set({ isActive: false }).where(and(eq(staffProfiles.siteId, input.siteId), eq(staffProfiles.userId, input.userId)));
          await tx.insert(staffProfiles).values({ siteId: input.siteId, userId: input.userId, role: input.role, isActive: true }).onDuplicateKeyUpdate({ set: { isActive: true, updatedAt: new Date() } });
        });
        await writeAudit({ userId: ctx.user.id, entityType: "staff_profile", entityId: `${input.siteId}:${input.userId}`, action: "assign_role", afterData: input });
        return { success: true };
      }),
  }),
  sites: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      const db = await dbOrThrow();
      if (ctx.user.role === "admin") return db.select().from(sites).orderBy(desc(sites.createdAt));
      const memberships = await db.select({ tenantId: tenantMembers.tenantId, role: tenantMembers.role }).from(tenantMembers)
        .where(and(eq(tenantMembers.userId, ctx.user.id), eq(tenantMembers.isActive, true), eq(tenantMembers.membershipStatus, "active")));
      const ownerTenantIds = memberships.filter((member) => member.role === "owner").map((member) => member.tenantId);
      const [ownedSites, assignedSites] = await Promise.all([
        ownerTenantIds.length ? db.select({ id: sites.id, name: sites.name, code: sites.code, city: sites.city, status: sites.status }).from(sites).where(inArray(sites.tenantId, ownerTenantIds)) : Promise.resolve([]),
        db.select({ id: sites.id, name: sites.name, code: sites.code, city: sites.city, status: sites.status }).from(staffProfiles)
          .innerJoin(sites, eq(staffProfiles.siteId, sites.id))
          .innerJoin(tenantMembers, and(eq(tenantMembers.tenantId, sites.tenantId), eq(tenantMembers.userId, ctx.user.id), eq(tenantMembers.isActive, true), eq(tenantMembers.membershipStatus, "active")))
          .where(and(eq(staffProfiles.userId, ctx.user.id), eq(staffProfiles.isActive, true))),
      ]);
      return Array.from(new Map([...ownedSites, ...assignedSites].map((site) => [site.id, site])).values());
    }),
    create: protectedProcedure.input(siteInput).mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const existingMemberships = await db.select({ tenantId: tenantMembers.tenantId }).from(tenantMembers)
        .where(and(eq(tenantMembers.userId, ctx.user.id), eq(tenantMembers.isActive, true))).limit(1);
      const id = await db.transaction(async (tx) => {
        let tenantId = existingMemberships[0]?.tenantId;
        if (!tenantId) {
          tenantId = insertId(await tx.insert(tenants).values({ name: input.name, slug: `${input.code.toLowerCase()}-${ctx.user.id}` }));
          await tx.insert(tenantMembers).values({ tenantId, userId: ctx.user.id, role: "owner", isActive: true });
        }
        return insertId(await tx.insert(sites).values({ ...input, tenantId }));
      });
      await writeAudit({ userId: ctx.user.id, siteId: id, entityType: "site", entityId: String(id), action: "create", afterData: input });
      return { id };
    }),
  }),

  subscribers: router({
    list: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "collector", "viewer"]);
      const db = await dbOrThrow();
      return db.select().from(subscribers).where(eq(subscribers.siteId, input.siteId)).orderBy(desc(subscribers.createdAt));
    }),
    create: protectedProcedure.input(siteInput.pick({ code: true }).extend({
      siteId: z.number().int().positive(),
      subscriberNo: z.string().min(1).max(50),
      fullName: z.string().min(2).max(180),
      phone: z.string().min(5).max(30),
      address: z.string().max(1000).optional(),
      subscriptionType: z.enum(["residential", "commercial"]).default("residential"),
    }).omit({ code: true })).mutation(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, createRoles, "manageSubscribers");
      const db = await dbOrThrow();
      const tenantId = await getSiteTenant(input.siteId);
      const id = insertId(await db.insert(subscribers).values({ ...input, tenantId }));
      await writeAudit({ userId: ctx.user.id, entityType: "subscriber", entityId: String(id), action: "create", afterData: input });
      return { id };
    }),
    update: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(), id: z.number().int().positive(), fullName: z.string().min(2).max(180), phone: z.string().min(5).max(30),
      address: z.string().max(1000).optional(), subscriptionType: z.enum(["residential", "commercial"]), serviceStatus: z.enum(["active", "suspended", "disconnected"]),
    })).mutation(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "manageSubscribers");
      const db = await dbOrThrow();
      const [existing] = await db.select().from(subscribers).where(and(eq(subscribers.id, input.id), eq(subscribers.siteId, input.siteId))).limit(1);
      if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "المشترك غير موجود ضمن المحطة المحددة." });
      await db.update(subscribers).set({ fullName: input.fullName, phone: input.phone, address: input.address, subscriptionType: input.subscriptionType, serviceStatus: input.serviceStatus }).where(eq(subscribers.id, input.id));
      await writeAudit({ userId: ctx.user.id, entityType: "subscriber", entityId: String(input.id), action: "update", beforeData: existing, afterData: input });
      return { success: true };
    }),
  }),

  meters: router({
    list: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "collector", "technician", "viewer"]);
      const db = await dbOrThrow();
      return db.select({ meter: meters, subscriber: subscribers }).from(meters)
        .innerJoin(subscribers, eq(meters.subscriberId, subscribers.id))
        .where(eq(subscribers.siteId, input.siteId)).orderBy(desc(meters.createdAt));
    }),
    create: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(), subscriberId: z.number().int().positive(), generatorId: z.number().int().positive().optional(),
      serialNumber: z.string().min(2).max(100), meterType: z.enum(["manual", "digital", "smart"]).default("manual"), multiplier: z.string().regex(/^\d+(\.\d{1,3})?$/).default("1"),
    })).mutation(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "technician"], "manageSubscribers");
      const db = await dbOrThrow();
      const [subscriber] = await db.select({ id: subscribers.id }).from(subscribers).where(and(eq(subscribers.id, input.subscriberId), eq(subscribers.siteId, input.siteId))).limit(1);
      if (!subscriber) throw new TRPCError({ code: "NOT_FOUND", message: "المشترك لا يتبع للمحطة المحددة." });
      if (input.generatorId) {
        const [generator] = await db.select({ id: generators.id }).from(generators).where(and(eq(generators.id, input.generatorId), eq(generators.siteId, input.siteId))).limit(1);
        if (!generator) throw new TRPCError({ code: "NOT_FOUND", message: "المولد لا يتبع للمحطة المحددة." });
      }
      const tenantId = await getSiteTenant(input.siteId);
      const id = insertId(await db.insert(meters).values({ tenantId, subscriberId: input.subscriberId, generatorId: input.generatorId, serialNumber: input.serialNumber, meterType: input.meterType, multiplier: input.multiplier }));
      await writeAudit({ userId: ctx.user.id, entityType: "meter", entityId: String(id), action: "create", afterData: input });
      return { id };
    }),
  }),

  tariffs: router({
    list: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "viewer"]);
      const db = await dbOrThrow();
      return db.select().from(tariffs).where(eq(tariffs.siteId, input.siteId)).orderBy(desc(tariffs.effectiveFrom));
    }),
    create: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(), name: z.string().min(2).max(160), code: z.string().min(2).max(50),
      pricePerKwh: z.number().min(0), fixedFee: z.number().min(0).default(0), taxRate: z.number().min(0).max(100).default(0),
    })).mutation(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, createRoles, "manageTariffs");
      const db = await dbOrThrow();
      const tenantId = await getSiteTenant(input.siteId);
      const id = insertId(await db.insert(tariffs).values({ ...input, tenantId, pricePerKwh: String(input.pricePerKwh), fixedFee: String(input.fixedFee), taxRate: String(input.taxRate) }));
      await writeAudit({ userId: ctx.user.id, entityType: "tariff", entityId: String(id), action: "create", afterData: input });
      return { id };
    }),
  }),

  generators: router({
    list: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "technician", "viewer"]);
      const db = await dbOrThrow();
      return db.select().from(generators).where(eq(generators.siteId, input.siteId)).orderBy(desc(generators.createdAt));
    }),
    create: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(), code: z.string().min(2).max(50), name: z.string().min(2).max(160),
      serialNumber: z.string().max(100).optional(), ratedCapacityKw: z.string().regex(/^\d+(\.\d{1,3})?$/),
      fuelType: z.enum(["diesel", "gasoline", "gas", "other"]).default("diesel"),
    })).mutation(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "technician"], "manageGenerators");
      const db = await dbOrThrow();
      const tenantId = await getSiteTenant(input.siteId);
      const id = insertId(await db.insert(generators).values({ ...input, tenantId }));
      await writeAudit({ userId: ctx.user.id, entityType: "generator", entityId: String(id), action: "create", afterData: input });
      return { id };
    }),
    update: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(), id: z.number().int().positive(), name: z.string().min(2).max(160), ratedCapacityKw: z.string().regex(/^\d+(\.\d{1,3})?$/),
      fuelLevelLiters: z.string().regex(/^\d+(\.\d{1,2})?$/), operatingHours: z.string().regex(/^\d+(\.\d{1,2})?$/), status: z.enum(["active", "maintenance", "stopped", "offline"]),
    })).mutation(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "technician"], "manageGenerators");
      const db = await dbOrThrow();
      const [existing] = await db.select().from(generators).where(and(eq(generators.id, input.id), eq(generators.siteId, input.siteId))).limit(1);
      if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "المولد غير موجود ضمن المحطة المحددة." });
      await db.update(generators).set({ name: input.name, ratedCapacityKw: input.ratedCapacityKw, fuelLevelLiters: input.fuelLevelLiters, operatingHours: input.operatingHours, status: input.status }).where(eq(generators.id, input.id));
      await writeAudit({ userId: ctx.user.id, entityType: "generator", entityId: String(input.id), action: "update", beforeData: existing, afterData: input });
      return { success: true };
    }),
  }),

  readings: router({
    list: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "collector", "technician", "viewer"]);
      const db = await dbOrThrow();
      return db.select({ reading: meterReadings, meter: meters, subscriber: subscribers }).from(meterReadings)
        .innerJoin(meters, eq(meterReadings.meterId, meters.id))
        .innerJoin(subscribers, eq(meters.subscriberId, subscribers.id))
        .where(eq(subscribers.siteId, input.siteId)).orderBy(desc(meterReadings.readingAt));
    }),
    create: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(), meterId: z.number().int().positive(), readingValue: z.string().regex(/^\d+(\.\d{1,3})?$/),
      captureMethod: z.enum(["manual", "photo", "smart_meter"]).default("manual"), clientOperationId: z.string().uuid().optional(), imageData: z.string().max(9_500_000).optional(), imageMime: z.enum(["image/jpeg", "image/png", "image/webp"]).optional(), notes: z.string().max(1000).optional(),
    })).mutation(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, readingRoles, "recordReadings");
      const db = await dbOrThrow();
      const [meterScope] = await db.select({ id: meters.id }).from(meters).innerJoin(subscribers, eq(meters.subscriberId, subscribers.id))
        .where(and(eq(meters.id, input.meterId), eq(subscribers.siteId, input.siteId))).limit(1);
      if (!meterScope) throw new TRPCError({ code: "NOT_FOUND", message: "العداد لا يتبع للمحطة المحددة." });
      const tenantId = await getSiteTenant(input.siteId);
      if (input.clientOperationId) {
        const [existing] = await db.select({ id: meterReadings.id, consumptionKwh: meterReadings.consumptionKwh, status: meterReadings.status }).from(meterReadings)
          .where(and(eq(meterReadings.tenantId, tenantId), eq(meterReadings.clientOperationId, input.clientOperationId))).limit(1);
        if (existing) return { id: existing.id, consumptionKwh: Number(existing.consumptionKwh ?? 0), status: existing.status, replayed: true };
      }
      const [previous] = await db.select({ readingValue: meterReadings.readingValue }).from(meterReadings)
        .where(and(eq(meterReadings.meterId, input.meterId), eq(meterReadings.status, "approved")))
        .orderBy(desc(meterReadings.readingAt)).limit(1);
      const previousValue = previous ? Number(previous.readingValue) : 0;
      const nextValue = Number(input.readingValue);
      if (nextValue < previousValue) throw new TRPCError({ code: "CONFLICT", message: "القراءة الحالية أقل من القراءة المعتمدة السابقة." });
      let imageKey: string | undefined;
      let imageHash: string | undefined;
      if (input.imageData) {
        if (!input.imageMime) throw new TRPCError({ code: "BAD_REQUEST", message: "نوع صورة العداد غير مدعوم." });
        const imageBytes = Buffer.from(input.imageData, "base64");
        if (imageBytes.byteLength === 0 || imageBytes.byteLength > 7 * 1024 * 1024) throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: "يجب ألا يتجاوز حجم صورة العداد 7 ميغابايت." });
        imageHash = crypto.createHash("sha256").update(imageBytes).digest("hex");
        const extension = input.imageMime === "image/png" ? "png" : input.imageMime === "image/webp" ? "webp" : "jpg";
        const stored = await storagePut(`meter-readings/${ctx.user.id}/${input.meterId}-${Date.now()}.${extension}`, imageBytes, input.imageMime);
        imageKey = stored.key;
      }
      const id = insertId(await db.insert(meterReadings).values({
        tenantId, meterId: input.meterId, clientOperationId: input.clientOperationId, readingValue: input.readingValue, previousReadingValue: previous?.readingValue,
        consumptionKwh: String(nextValue - previousValue), captureMethod: input.captureMethod, imageKey, imageHash,
        notes: input.notes, enteredByUserId: ctx.user.id,
      }));
      await writeAudit({ userId: ctx.user.id, entityType: "meter_reading", entityId: String(id), action: "create", afterData: input });
      return { id, consumptionKwh: nextValue - previousValue, status: "pending_review" as const, replayed: false };
    }),
    approve: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), readingId: z.number().int().positive(), baseVersion: z.number().int().positive() }))
      .mutation(async ({ ctx, input }) => {
        await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "approveReadings");
        const db = await dbOrThrow();
        const [readingScope] = await db.select({ id: meterReadings.id }).from(meterReadings)
          .innerJoin(meters, eq(meterReadings.meterId, meters.id))
          .innerJoin(subscribers, eq(meters.subscriberId, subscribers.id))
          .where(and(eq(meterReadings.id, input.readingId), eq(subscribers.siteId, input.siteId))).limit(1);
        if (!readingScope) throw new TRPCError({ code: "NOT_FOUND", message: "القراءة لا تتبع للمحطة المحددة." });
        const result = await db.update(meterReadings).set({ status: "approved", reviewedByUserId: ctx.user.id, reviewedAt: new Date(), versionNo: sql`${meterReadings.versionNo} + 1` })
          .where(and(eq(meterReadings.id, input.readingId), eq(meterReadings.versionNo, input.baseVersion)));
        if (Number((result[0] as { affectedRows?: number }).affectedRows ?? 0) !== 1) throw new TRPCError({ code: "CONFLICT", message: "تم تعديل القراءة من جهة أخرى؛ حدّث البيانات ثم أعد المحاولة." });
        await writeAudit({ userId: ctx.user.id, siteId: input.siteId, entityType: "meter_reading", entityId: String(input.readingId), action: "approve" });
        return { success: true };
      }),
  }),

  invoices: router({
    list: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "collector", "viewer"]);
      const db = await dbOrThrow();
      return db.select().from(invoices).where(eq(invoices.siteId, input.siteId)).orderBy(desc(invoices.issueDate));
    }),
    createFromReading: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(), readingId: z.number().int().positive(), tariffId: z.number().int().positive(),
      billingPeriod: z.string().regex(/^\d{4}-\d{2}$/), dueDate: z.date(), discountAmount: z.number().min(0).default(0),
    })).mutation(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, createRoles, "issueInvoices");
      const db = await dbOrThrow();
      const [readingScope] = await db.select({ reading: meterReadings, meter: meters, subscriber: subscribers }).from(meterReadings)
        .innerJoin(meters, eq(meterReadings.meterId, meters.id))
        .innerJoin(subscribers, eq(meters.subscriberId, subscribers.id))
        .where(and(eq(meterReadings.id, input.readingId), eq(subscribers.siteId, input.siteId))).limit(1);
      const reading = readingScope?.reading;
      const meter = readingScope?.meter;
      const subscriber = readingScope?.subscriber;
      if (!reading || reading.status !== "approved" || !meter || !subscriber) throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن فوترة قراءة غير معتمدة أو لا تتبع للمحطة المحددة." });
      const [tariff] = await db.select().from(tariffs).where(and(eq(tariffs.id, input.tariffId), eq(tariffs.siteId, input.siteId), eq(tariffs.isActive, true))).limit(1);
      const [site] = await db.select().from(sites).where(eq(sites.id, input.siteId)).limit(1);
      if (!meter || !tariff || !site || !subscriber) throw new TRPCError({ code: "NOT_FOUND", message: "بيانات العداد أو المشترك أو التعرفة أو المحطة غير مكتملة." });
      const tenantChannels = resolveInvoiceNotificationChannels(await db.select({ channel: tenantMessagingConfigurations.channel, isActive: tenantMessagingConfigurations.isActive })
        .from(tenantMessagingConfigurations).where(eq(tenantMessagingConfigurations.tenantId, site.tenantId)));
      const countResult = await db.select({ count: sql<number>`count(*)` }).from(invoices).where(eq(invoices.siteId, input.siteId));
      const calculated = calculateInvoiceAmounts({ consumptionKwh: Number(reading.consumptionKwh ?? 0), pricePerKwh: Number(tariff.pricePerKwh), fixedFee: Number(tariff.fixedFee), taxRate: Number(tariff.taxRate), discountAmount: input.discountAmount });
      const invoiceNo = nextInvoiceNo(site.code, input.billingPeriod, Number(countResult[0]?.count ?? 0) + 1);
      const id = await db.transaction(async (tx) => {
        const invoiceId = insertId(await tx.insert(invoices).values({
          tenantId: site.tenantId, siteId: input.siteId, subscriberId: meter.subscriberId, meterId: meter.id, readingId: reading.id, tariffId: tariff.id,
          invoiceNo, billingPeriod: input.billingPeriod, dueDate: input.dueDate, previousReading: reading.previousReadingValue,
          currentReading: reading.readingValue, consumptionKwh: reading.consumptionKwh ?? "0", pricePerKwh: tariff.pricePerKwh,
          fixedFee: tariff.fixedFee, taxAmount: String(calculated.taxAmount), discountAmount: String(input.discountAmount),
          totalAmount: String(calculated.totalAmount), balanceDue: String(calculated.totalAmount), status: "issued", createdByUserId: ctx.user.id,
        }));
        const lines: Array<{ lineType: "energy" | "fixed_fee" | "tax" | "discount"; description: string; quantity: string; unitPrice: string; amount: string; displayOrder: number }> = [
          { lineType: "energy" as const, description: "استهلاك الكهرباء", quantity: String(reading.consumptionKwh ?? 0), unitPrice: tariff.pricePerKwh, amount: String(calculated.energyAmount), displayOrder: 1 },
          { lineType: "fixed_fee" as const, description: "رسم ثابت", quantity: "1", unitPrice: tariff.fixedFee, amount: tariff.fixedFee, displayOrder: 2 },
          { lineType: "tax" as const, description: "الضريبة", quantity: "1", unitPrice: String(tariff.taxRate), amount: String(calculated.taxAmount), displayOrder: 3 },
        ];
        if (input.discountAmount > 0) lines.push({ lineType: "discount" as const, description: "خصم", quantity: "1", unitPrice: String(input.discountAmount), amount: String(input.discountAmount), displayOrder: 4 });
        await tx.insert(invoiceLines).values(lines.map((line) => ({ ...line, tenantId: site.tenantId, invoiceId })));
        return invoiceId;
      });
      await db.insert(notificationMessages).values(tenantChannels.map((channel) => ({
        tenantId: site.tenantId,
        invoiceId: id,
        subscriberId: subscriber.id,
        channel,
        eventType: "invoice_issued" as const,
        recipient: subscriber.phone,
        status: "pending" as const,
        payload: { invoiceNo, billingPeriod: input.billingPeriod, totalAmount: calculated.totalAmount },
      })));
      await writeAudit({ userId: ctx.user.id, siteId: input.siteId, entityType: "invoice", entityId: String(id), action: "issue", afterData: { invoiceNo, ...calculated } });
      return { id, invoiceNo, totalAmount: calculated.totalAmount };
    }),
    createShareLink: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), invoiceId: z.number().int().positive(), expiresAt: z.date().optional() }))
      .mutation(async ({ ctx, input }) => {
        await requireRole(ctx.user.id, input.siteId, createRoles);
        const db = await dbOrThrow();
        const [invoice] = await db.select().from(invoices).where(and(eq(invoices.id, input.invoiceId), eq(invoices.siteId, input.siteId))).limit(1);
        if (!invoice || invoice.status === "draft" || invoice.status === "cancelled") throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن مشاركة فاتورة غير صادرة أو ملغاة." });
        const token = generateInvoiceShareToken();
        const id = insertId(await db.insert(invoiceShareLinks).values({ tenantId: invoice.tenantId, invoiceId: invoice.id, tokenHash: hashInvoiceShareToken(token), tokenPreview: token.slice(0, 8), expiresAt: input.expiresAt }));
        await writeAudit({ userId: ctx.user.id, siteId: input.siteId, entityType: "invoice_share_link", entityId: String(id), action: "create", metadata: { invoiceId: invoice.id } });
        return { token, path: `/invoice/${token}` };
      }),
    publicByToken: publicProcedure.input(z.object({ token: z.string().min(16).max(200) })).query(async ({ input }) => {
      const db = await dbOrThrow();
      const [link] = await db.select().from(invoiceShareLinks).where(eq(invoiceShareLinks.tokenHash, hashInvoiceShareToken(input.token))).limit(1);
      if (!link || link.revokedAt || (link.expiresAt && link.expiresAt < new Date())) throw new TRPCError({ code: "NOT_FOUND", message: "رابط الفاتورة غير صالح أو منتهي." });
      const [invoice] = await db.select().from(invoices).where(eq(invoices.id, link.invoiceId)).limit(1);
      if (!invoice) throw new TRPCError({ code: "NOT_FOUND", message: "الفاتورة غير موجودة." });
      const [subscriber] = await db.select({ fullName: subscribers.fullName, subscriberNo: subscribers.subscriberNo }).from(subscribers).where(eq(subscribers.id, invoice.subscriberId)).limit(1);
      const lines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoice.id)).orderBy(invoiceLines.displayOrder);
      await db.update(invoiceShareLinks).set({ viewCount: sql`${invoiceShareLinks.viewCount} + 1`, lastViewedAt: new Date() }).where(eq(invoiceShareLinks.id, link.id));
      return { invoice, subscriber, lines };
    }),
  }),

  payments: router({
    list: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "collector", "viewer"]);
      const db = await dbOrThrow();
      return db.select({ payment: payments, subscriber: subscribers, invoiceNo: invoices.invoiceNo }).from(payments)
        .innerJoin(subscribers, eq(payments.subscriberId, subscribers.id))
        .leftJoin(invoices, eq(payments.invoiceId, invoices.id))
        .where(eq(payments.siteId, input.siteId)).orderBy(desc(payments.paidAt));
    }),
    create: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(), subscriberId: z.number().int().positive(), invoiceId: z.number().int().positive().optional(),
      paymentNo: z.string().min(3).max(60), amount: z.number().positive(), paymentMethod: z.enum(["cash", "wallet", "bank_transfer", "card"]).default("cash"), referenceNo: z.string().max(120).optional(),
    })).mutation(async ({ ctx, input }) => {
      const role = await requireRole(ctx.user.id, input.siteId, recordRoles, "collectPayments");
      const db = await dbOrThrow();
      const [subscriber] = await db.select({ id: subscribers.id }).from(subscribers).where(and(eq(subscribers.id, input.subscriberId), eq(subscribers.siteId, input.siteId))).limit(1);
      if (!subscriber) throw new TRPCError({ code: "NOT_FOUND", message: "المشترك لا يتبع للمحطة المحددة." });
      if (input.invoiceId) {
        const [invoiceScope] = await db.select({ id: invoices.id, balanceDue: invoices.balanceDue, status: invoices.status }).from(invoices).where(and(eq(invoices.id, input.invoiceId), eq(invoices.siteId, input.siteId), eq(invoices.subscriberId, input.subscriberId))).limit(1);
        if (!invoiceScope) throw new TRPCError({ code: "NOT_FOUND", message: "الفاتورة لا تتبع للمشترك والمحطة المحددين." });
        if (invoiceScope.status === "cancelled" || invoiceScope.status === "draft") throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن تسجيل دفعة على فاتورة ملغاة أو مسودة." });
        if (input.amount > Number(invoiceScope.balanceDue)) throw new TRPCError({ code: "BAD_REQUEST", message: "قيمة الدفعة تتجاوز الرصيد المتبقي للفواتير." });
      }
      const tenantId = await getSiteTenant(input.siteId);
      let collectorSessionId: number | undefined;
      if (role === "collector") {
        const [openSession] = await db.select({ id: collectorSessions.id }).from(collectorSessions).where(and(
          eq(collectorSessions.tenantId, tenantId), eq(collectorSessions.siteId, input.siteId), eq(collectorSessions.collectorUserId, ctx.user.id), eq(collectorSessions.status, "open"),
        )).limit(1);
        if (!openSession) throw new TRPCError({ code: "BAD_REQUEST", message: "افتح جلسة تحصيل قبل تسجيل دفعاتك الميدانية." });
        collectorSessionId = openSession.id;
      }
      const id = insertId(await db.insert(payments).values({ ...input, tenantId, amount: String(input.amount), collectedByUserId: ctx.user.id, collectorSessionId }));
      if (input.invoiceId) {
        const [invoice] = await db.select().from(invoices).where(eq(invoices.id, input.invoiceId)).limit(1);
        if (invoice) {
          const paidAmount = Number(invoice.paidAmount) + input.amount;
          const balanceDue = Math.max(0, Number(invoice.totalAmount) - paidAmount);
          await db.update(invoices).set({ paidAmount: String(paidAmount), balanceDue: String(balanceDue), status: balanceDue === 0 ? "paid" : "partially_paid" }).where(eq(invoices.id, invoice.id));
        }
      }
      await writeAudit({ userId: ctx.user.id, siteId: input.siteId, entityType: "payment", entityId: String(id), action: "create", afterData: input, metadata: { collectorSessionId } });
      return { id };
    }),
  }),

  collectorSessions: router({
    list: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      const role = await requireRole(ctx.user.id, input.siteId, recordRoles, "collectPayments");
      const db = await dbOrThrow();
      const scope = role === "collector" ? and(eq(collectorSessions.siteId, input.siteId), eq(collectorSessions.collectorUserId, ctx.user.id)) : eq(collectorSessions.siteId, input.siteId);
      return db.select({ session: collectorSessions, collector: users }).from(collectorSessions).innerJoin(users, eq(collectorSessions.collectorUserId, users.id)).where(scope).orderBy(desc(collectorSessions.openedAt)).limit(100);
    }),
    current: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, recordRoles, "collectPayments");
      const db = await dbOrThrow();
      const [session] = await db.select().from(collectorSessions).where(and(eq(collectorSessions.siteId, input.siteId), eq(collectorSessions.collectorUserId, ctx.user.id), eq(collectorSessions.status, "open"))).limit(1);
      return session ?? null;
    }),
    open: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), openingCash: z.number().min(0).default(0), notes: z.string().max(1000).optional() })).mutation(async ({ ctx, input }) => {
      const role = await requireRole(ctx.user.id, input.siteId, recordRoles, "collectPayments");
      if (role !== "collector") throw new TRPCError({ code: "FORBIDDEN", message: "جلسة التحصيل الميدانية مخصصة لدور المحصل." });
      const db = await dbOrThrow();
      const tenantId = await getSiteTenant(input.siteId);
      const [existing] = await db.select({ id: collectorSessions.id }).from(collectorSessions).where(and(eq(collectorSessions.tenantId, tenantId), eq(collectorSessions.siteId, input.siteId), eq(collectorSessions.collectorUserId, ctx.user.id), eq(collectorSessions.status, "open"))).limit(1);
      if (existing) throw new TRPCError({ code: "CONFLICT", message: "لديك جلسة تحصيل مفتوحة بالفعل لهذه المحطة." });
      const id = insertId(await db.insert(collectorSessions).values({ tenantId, siteId: input.siteId, collectorUserId: ctx.user.id, openingCash: String(input.openingCash), notes: input.notes }));
      await writeAudit({ userId: ctx.user.id, siteId: input.siteId, entityType: "collector_session", entityId: String(id), action: "open", afterData: input });
      return { id };
    }),
    close: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), sessionId: z.number().int().positive(), declaredCash: z.number().min(0), notes: z.string().max(1000).optional() })).mutation(async ({ ctx, input }) => {
      const role = await requireRole(ctx.user.id, input.siteId, recordRoles, "collectPayments");
      const db = await dbOrThrow();
      const [session] = await db.select().from(collectorSessions).where(and(eq(collectorSessions.id, input.sessionId), eq(collectorSessions.siteId, input.siteId))).limit(1);
      if (!session) throw new TRPCError({ code: "NOT_FOUND", message: "جلسة التحصيل غير موجودة ضمن المحطة المحددة." });
      if (session.status !== "open") throw new TRPCError({ code: "CONFLICT", message: "تم إغلاق جلسة التحصيل مسبقاً." });
      if (role === "collector" && session.collectorUserId !== ctx.user.id) throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكن للمحصل إغلاق جلسة محصل آخر." });
      const [cashTotals] = await db.select({ amount: sql<string>`coalesce(sum(${payments.amount}), 0)` }).from(payments).where(and(eq(payments.collectorSessionId, session.id), eq(payments.paymentMethod, "cash"), eq(payments.status, "completed")));
      const expectedCash = Number(session.openingCash) + Number(cashTotals?.amount ?? 0);
      const varianceAmount = input.declaredCash - expectedCash;
      await db.update(collectorSessions).set({ status: "closed", expectedCash: String(expectedCash), declaredCash: String(input.declaredCash), varianceAmount: String(varianceAmount), notes: input.notes ?? session.notes, closedAt: new Date(), closedByUserId: ctx.user.id }).where(eq(collectorSessions.id, session.id));
      await writeAudit({ userId: ctx.user.id, siteId: input.siteId, entityType: "collector_session", entityId: String(session.id), action: "close", beforeData: session, afterData: { declaredCash: input.declaredCash, expectedCash, varianceAmount } });
      return { expectedCash, varianceAmount };
    }),
  }),

  expenses: router({
    list: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "viewer"]);
      const db = await dbOrThrow();
      return db.select().from(expenses).where(eq(expenses.siteId, input.siteId)).orderBy(desc(expenses.occurredAt));
    }),
    create: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(), generatorId: z.number().int().positive().optional(), category: z.enum(["fuel", "maintenance", "payroll", "parts", "transport", "other"]),
      description: z.string().min(2).max(255), amount: z.number().positive(), referenceNo: z.string().max(120).optional(),
    })).mutation(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, createRoles, "manageExpenses");
      const db = await dbOrThrow();
      if (input.generatorId) {
        const [generator] = await db.select({ id: generators.id }).from(generators).where(and(eq(generators.id, input.generatorId), eq(generators.siteId, input.siteId))).limit(1);
        if (!generator) throw new TRPCError({ code: "NOT_FOUND", message: "المولد لا يتبع للمحطة المحددة." });
      }
      const tenantId = await getSiteTenant(input.siteId);
      const id = insertId(await db.insert(expenses).values({ ...input, tenantId, amount: String(input.amount), createdByUserId: ctx.user.id }));
      await writeAudit({ userId: ctx.user.id, entityType: "expense", entityId: String(id), action: "create", afterData: input });
      return { id };
    }),
  }),

  dashboard: router({
    summary: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "collector", "technician", "viewer"]);
      const db = await dbOrThrow();
      const [subscriberCount] = await db.select({ value: sql<number>`count(*)` }).from(subscribers).where(and(eq(subscribers.siteId, input.siteId), eq(subscribers.serviceStatus, "active")));
      const [generatorStatus] = await db.select({ active: sql<number>`sum(case when ${generators.status} = 'active' then 1 else 0 end)`, maintenance: sql<number>`sum(case when ${generators.status} = 'maintenance' then 1 else 0 end)` }).from(generators).where(eq(generators.siteId, input.siteId));
      const [invoiceTotals] = await db.select({ invoiced: sql<string>`coalesce(sum(${invoices.totalAmount}), 0)`, paid: sql<string>`coalesce(sum(${invoices.paidAmount}), 0)`, outstanding: sql<string>`coalesce(sum(${invoices.balanceDue}), 0)`, energy: sql<string>`coalesce(sum(${invoices.consumptionKwh}), 0)` }).from(invoices).where(and(eq(invoices.siteId, input.siteId), sql`${invoices.status} <> 'cancelled'`));
      const [expenseTotals] = await db.select({ amount: sql<string>`coalesce(sum(${expenses.amount}), 0)` }).from(expenses).where(eq(expenses.siteId, input.siteId));
      const [notificationTotals] = await db.select({ failed: sql<number>`sum(case when ${notificationMessages.status} = 'failed' then 1 else 0 end)` }).from(notificationMessages).where(sql`${notificationMessages.subscriberId} in (select ${subscribers.id} from ${subscribers} where ${subscribers.siteId} = ${input.siteId})`);
      return { subscribers: Number(subscriberCount?.value ?? 0), generators: { active: Number(generatorStatus?.active ?? 0), maintenance: Number(generatorStatus?.maintenance ?? 0) }, financial: { invoiced: Number(invoiceTotals?.invoiced ?? 0), collected: Number(invoiceTotals?.paid ?? 0), outstanding: Number(invoiceTotals?.outstanding ?? 0), expenses: Number(expenseTotals?.amount ?? 0), operatingProfit: Number(invoiceTotals?.paid ?? 0) - Number(expenseTotals?.amount ?? 0) }, energyKwh: Number(invoiceTotals?.energy ?? 0), failedNotifications: Number(notificationTotals?.failed ?? 0) };
    }),
  }),

  reports: router({
    range: protectedProcedure.input(z.object({
      siteId: z.number().int().positive(),
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }).refine((input) => input.startDate <= input.endDate, { message: "يجب أن يكون تاريخ البداية قبل تاريخ النهاية." })).query(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "viewer"]);
      const db = await dbOrThrow();
      const { start, endExclusive } = reportDateRange(input.startDate, input.endDate);
      const [invoiceRows, paymentRows, expenseRows] = await Promise.all([
        db.select({ invoice: invoices, subscriber: subscribers }).from(invoices)
          .innerJoin(subscribers, eq(invoices.subscriberId, subscribers.id))
          .where(and(eq(invoices.siteId, input.siteId), gte(invoices.issueDate, start), lt(invoices.issueDate, endExclusive), sql`${invoices.status} <> 'cancelled'`)),
        db.select({ payment: payments, collector: users }).from(payments)
          .leftJoin(users, eq(payments.collectedByUserId, users.id))
          .where(and(eq(payments.siteId, input.siteId), gte(payments.paidAt, start), lt(payments.paidAt, endExclusive))),
        db.select().from(expenses)
          .where(and(eq(expenses.siteId, input.siteId), gte(expenses.occurredAt, start), lt(expenses.occurredAt, endExclusive))),
      ]);
      const invoiced = invoiceRows.reduce((sum, row) => sum + Number(row.invoice.totalAmount), 0);
      const outstanding = invoiceRows.reduce((sum, row) => sum + Number(row.invoice.balanceDue), 0);
      const energyKwh = invoiceRows.reduce((sum, row) => sum + Number(row.invoice.consumptionKwh), 0);
      const completedPayments = paymentRows.filter((row) => row.payment.status === "completed");
      const collected = completedPayments.reduce((sum, row) => sum + Number(row.payment.amount), 0);
      const expenseTotal = expenseRows.reduce((sum, row) => sum + Number(row.amount), 0);
      const collectors = Object.values(completedPayments.reduce<Record<string, { name: string; count: number; amount: number }>>((acc, row) => {
        const key = String(row.payment.collectedByUserId ?? 0);
        const entry = acc[key] ?? { name: row.collector?.name || row.collector?.email || "محصل غير محدد", count: 0, amount: 0 };
        entry.count += 1;
        entry.amount += Number(row.payment.amount);
        acc[key] = entry;
        return acc;
      }, {})).sort((a, b) => b.amount - a.amount);
      const topDebtors = invoiceRows.filter((row) => Number(row.invoice.balanceDue) > 0).sort((a, b) => Number(b.invoice.balanceDue) - Number(a.invoice.balanceDue)).slice(0, 10).map((row) => ({ subscriber: row.subscriber.fullName, subscriberNo: row.subscriber.subscriberNo, invoiceNo: row.invoice.invoiceNo, balanceDue: Number(row.invoice.balanceDue), dueDate: row.invoice.dueDate }));
      return { range: { startDate: input.startDate, endDate: input.endDate }, summary: { invoiced, collected, outstanding, energyKwh, expenseTotal, operatingProfit: collected - expenseTotal }, collectors, topDebtors };
    }),
    monthly: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), billingPeriod: z.string().regex(/^\d{4}-\d{2}$/) })).query(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "viewer"]);
      const db = await dbOrThrow();
      const invoiceRows = await db.select({ invoice: invoices, subscriber: subscribers }).from(invoices)
        .innerJoin(subscribers, eq(invoices.subscriberId, subscribers.id))
        .where(and(eq(invoices.siteId, input.siteId), eq(invoices.billingPeriod, input.billingPeriod), sql`${invoices.status} <> 'cancelled'`));
      const paymentRows = await db.select({ payment: payments, collector: users }).from(payments)
        .leftJoin(users, eq(payments.collectedByUserId, users.id))
        .where(eq(payments.siteId, input.siteId));
      const expenseRows = await db.select().from(expenses).where(eq(expenses.siteId, input.siteId));
      const matchPeriod = (date: Date | null) => date ? date.toISOString().slice(0, 7) === input.billingPeriod : false;
      const periodPayments = paymentRows.filter((row) => matchPeriod(row.payment.paidAt));
      const periodExpenses = expenseRows.filter((row) => matchPeriod(row.occurredAt));
      const invoiced = invoiceRows.reduce((sum, row) => sum + Number(row.invoice.totalAmount), 0);
      const outstanding = invoiceRows.reduce((sum, row) => sum + Number(row.invoice.balanceDue), 0);
      const energyKwh = invoiceRows.reduce((sum, row) => sum + Number(row.invoice.consumptionKwh), 0);
      const collected = periodPayments.filter((row) => row.payment.status === "completed").reduce((sum, row) => sum + Number(row.payment.amount), 0);
      const expenseTotal = periodExpenses.reduce((sum, row) => sum + Number(row.amount), 0);
      const collectors = Object.values(periodPayments.reduce<Record<string, { name: string; count: number; amount: number }>>((acc, row) => {
        const key = String(row.payment.collectedByUserId ?? 0);
        const entry = acc[key] ?? { name: row.collector?.name || row.collector?.email || "محصل غير محدد", count: 0, amount: 0 };
        entry.count += 1;
        entry.amount += Number(row.payment.amount);
        acc[key] = entry;
        return acc;
      }, {})).sort((a, b) => b.amount - a.amount);
      const topDebtors = invoiceRows.filter((row) => Number(row.invoice.balanceDue) > 0).sort((a, b) => Number(b.invoice.balanceDue) - Number(a.invoice.balanceDue)).slice(0, 10).map((row) => ({ subscriber: row.subscriber.fullName, subscriberNo: row.subscriber.subscriberNo, invoiceNo: row.invoice.invoiceNo, balanceDue: Number(row.invoice.balanceDue), dueDate: row.invoice.dueDate }));
      return { summary: { invoiced, collected, outstanding, energyKwh, expenseTotal, operatingProfit: collected - expenseTotal }, collectors, topDebtors };
    }),
  }),

  notifications: router({
    list: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "viewer"]);
      const db = await dbOrThrow();
      return db.select({ notification: notificationMessages, subscriber: subscribers }).from(notificationMessages)
        .innerJoin(subscribers, eq(notificationMessages.subscriberId, subscribers.id))
        .where(eq(subscribers.siteId, input.siteId)).orderBy(desc(notificationMessages.createdAt));
    }),
    retry: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), notificationId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "manageMessaging");
      const db = await dbOrThrow();
      const [notificationScope] = await db.select({ id: notificationMessages.id, status: notificationMessages.status }).from(notificationMessages)
        .innerJoin(subscribers, eq(notificationMessages.subscriberId, subscribers.id))
        .where(and(eq(notificationMessages.id, input.notificationId), eq(subscribers.siteId, input.siteId))).limit(1);
      if (!notificationScope) throw new TRPCError({ code: "NOT_FOUND", message: "رسالة الإشعار لا تتبع للمحطة المحددة." });
      if (notificationScope.status !== "failed") throw new TRPCError({ code: "BAD_REQUEST", message: "يمكن إعادة محاولة الرسائل الفاشلة فقط." });
      await db.update(notificationMessages).set({ status: "pending", lastError: null }).where(eq(notificationMessages.id, input.notificationId));
      await writeAudit({ userId: ctx.user.id, siteId: input.siteId, entityType: "notification_message", entityId: String(input.notificationId), action: "retry", metadata: { previousStatus: "failed" } });
      return { success: true };
    }),
  }),

  audit: router({
    list: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "viewer"], "viewAudit");
      const db = await dbOrThrow();
      return db.select().from(auditLogs).where(eq(auditLogs.siteId, input.siteId)).orderBy(desc(auditLogs.createdAt)).limit(100);
    }),
  }),
});
