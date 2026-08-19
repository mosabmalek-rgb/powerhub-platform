import crypto from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  auditLogs,
  expenses,
  invoiceLines,
  generators,
  invoiceShareLinks,
  invoices,
  meterReadings,
  meters,
  notificationMessages,
  payments,
  sites,
  staffProfiles,
  subscribers,
  tariffs,
  users,
} from "../drizzle/schema";
import { getDb } from "./db";
import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
import { calculateInvoiceAmounts, generateInvoiceShareToken, hashInvoiceShareToken, nextInvoiceNo } from "./powerhub-utils";
import { storagePut } from "./storage";

type PowerRole = "owner" | "manager" | "accountant" | "collector" | "technician" | "viewer";

const createRoles: PowerRole[] = ["owner", "manager", "accountant"];
const recordRoles: PowerRole[] = ["owner", "manager", "accountant", "collector"];

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

async function resolveRole(userId: number, siteId: number): Promise<PowerRole> {
  const db = await dbOrThrow();
  const [user] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1);
  if (user?.role === "admin") return "owner";

  const [profile] = await db
    .select({ role: staffProfiles.role })
    .from(staffProfiles)
    .where(and(eq(staffProfiles.userId, userId), eq(staffProfiles.siteId, siteId), eq(staffProfiles.isActive, true)))
    .limit(1);

  if (!profile) throw new TRPCError({ code: "FORBIDDEN", message: "لا توجد صلاحية للوصول إلى هذه المحطة." });
  return profile.role;
}

async function requireRole(userId: number, siteId: number, allowed: PowerRole[]) {
  const role = await resolveRole(userId, siteId);
  if (!allowed.includes(role)) throw new TRPCError({ code: "FORBIDDEN", message: "لا تملك صلاحية تنفيذ هذه العملية." });
  return role;
}

async function writeAudit(input: {
  userId?: number;
  entityType: string;
  entityId: string;
  action: string;
  beforeData?: unknown;
  afterData?: unknown;
  metadata?: unknown;
}) {
  const db = await dbOrThrow();
  await db.insert(auditLogs).values({
    userId: input.userId,
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
  sites: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      const db = await dbOrThrow();
      if (ctx.user.role === "admin") return db.select().from(sites).orderBy(desc(sites.createdAt));
      return db.select({ id: sites.id, name: sites.name, code: sites.code, city: sites.city, status: sites.status })
        .from(staffProfiles)
        .innerJoin(sites, eq(staffProfiles.siteId, sites.id))
        .where(and(eq(staffProfiles.userId, ctx.user.id), eq(staffProfiles.isActive, true)));
    }),
    create: protectedProcedure.input(siteInput).mutation(async ({ ctx, input }) => {
      if (ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "إنشاء المحطات مخصص للمالك." });
      const db = await dbOrThrow();
      const id = insertId(await db.insert(sites).values(input));
      await writeAudit({ userId: ctx.user.id, entityType: "site", entityId: String(id), action: "create", afterData: input });
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
      await requireRole(ctx.user.id, input.siteId, createRoles);
      const db = await dbOrThrow();
      const id = insertId(await db.insert(subscribers).values(input));
      await writeAudit({ userId: ctx.user.id, entityType: "subscriber", entityId: String(id), action: "create", afterData: input });
      return { id };
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
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "technician"]);
      const db = await dbOrThrow();
      const [subscriber] = await db.select({ id: subscribers.id }).from(subscribers).where(and(eq(subscribers.id, input.subscriberId), eq(subscribers.siteId, input.siteId))).limit(1);
      if (!subscriber) throw new TRPCError({ code: "NOT_FOUND", message: "المشترك لا يتبع للمحطة المحددة." });
      const id = insertId(await db.insert(meters).values({ subscriberId: input.subscriberId, generatorId: input.generatorId, serialNumber: input.serialNumber, meterType: input.meterType, multiplier: input.multiplier }));
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
      await requireRole(ctx.user.id, input.siteId, createRoles);
      const db = await dbOrThrow();
      const id = insertId(await db.insert(tariffs).values({ ...input, pricePerKwh: String(input.pricePerKwh), fixedFee: String(input.fixedFee), taxRate: String(input.taxRate) }));
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
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "technician"]);
      const db = await dbOrThrow();
      const id = insertId(await db.insert(generators).values(input));
      await writeAudit({ userId: ctx.user.id, entityType: "generator", entityId: String(id), action: "create", afterData: input });
      return { id };
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
      captureMethod: z.enum(["manual", "photo", "smart_meter"]).default("manual"), imageData: z.string().max(9_500_000).optional(), imageMime: z.enum(["image/jpeg", "image/png", "image/webp"]).optional(), notes: z.string().max(1000).optional(),
    })).mutation(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, recordRoles);
      const db = await dbOrThrow();
      const [previous] = await db.select({ readingValue: meterReadings.readingValue }).from(meterReadings)
        .where(and(eq(meterReadings.meterId, input.meterId), eq(meterReadings.status, "approved")))
        .orderBy(desc(meterReadings.readingAt)).limit(1);
      const previousValue = previous ? Number(previous.readingValue) : 0;
      const nextValue = Number(input.readingValue);
      if (nextValue < previousValue) throw new TRPCError({ code: "BAD_REQUEST", message: "القراءة الحالية أقل من القراءة المعتمدة السابقة." });
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
        meterId: input.meterId, readingValue: input.readingValue, previousReadingValue: previous?.readingValue,
        consumptionKwh: String(nextValue - previousValue), captureMethod: input.captureMethod, imageKey, imageHash,
        notes: input.notes, enteredByUserId: ctx.user.id,
      }));
      await writeAudit({ userId: ctx.user.id, entityType: "meter_reading", entityId: String(id), action: "create", afterData: input });
      return { id, consumptionKwh: nextValue - previousValue, status: "pending_review" as const };
    }),
    approve: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), readingId: z.number().int().positive(), baseVersion: z.number().int().positive() }))
      .mutation(async ({ ctx, input }) => {
        await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"]);
        const db = await dbOrThrow();
        const result = await db.update(meterReadings).set({ status: "approved", reviewedByUserId: ctx.user.id, reviewedAt: new Date(), versionNo: sql`${meterReadings.versionNo} + 1` })
          .where(and(eq(meterReadings.id, input.readingId), eq(meterReadings.versionNo, input.baseVersion)));
        if (Number((result[0] as { affectedRows?: number }).affectedRows ?? 0) !== 1) throw new TRPCError({ code: "CONFLICT", message: "تم تعديل القراءة من جهة أخرى؛ حدّث البيانات ثم أعد المحاولة." });
        await writeAudit({ userId: ctx.user.id, entityType: "meter_reading", entityId: String(input.readingId), action: "approve" });
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
      await requireRole(ctx.user.id, input.siteId, createRoles);
      const db = await dbOrThrow();
      const [reading] = await db.select().from(meterReadings).where(eq(meterReadings.id, input.readingId)).limit(1);
      if (!reading || reading.status !== "approved") throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن فوترة قراءة غير معتمدة." });
      const [meter] = await db.select().from(meters).where(eq(meters.id, reading.meterId)).limit(1);
      const [tariff] = await db.select().from(tariffs).where(and(eq(tariffs.id, input.tariffId), eq(tariffs.siteId, input.siteId), eq(tariffs.isActive, true))).limit(1);
      const [site] = await db.select().from(sites).where(eq(sites.id, input.siteId)).limit(1);
      if (!meter || !tariff || !site) throw new TRPCError({ code: "NOT_FOUND", message: "بيانات العداد أو التعرفة أو المحطة غير مكتملة." });
      const countResult = await db.select({ count: sql<number>`count(*)` }).from(invoices).where(eq(invoices.siteId, input.siteId));
      const calculated = calculateInvoiceAmounts({ consumptionKwh: Number(reading.consumptionKwh ?? 0), pricePerKwh: Number(tariff.pricePerKwh), fixedFee: Number(tariff.fixedFee), taxRate: Number(tariff.taxRate), discountAmount: input.discountAmount });
      const invoiceNo = nextInvoiceNo(site.code, input.billingPeriod, Number(countResult[0]?.count ?? 0) + 1);
      const id = await db.transaction(async (tx) => {
        const invoiceId = insertId(await tx.insert(invoices).values({
          siteId: input.siteId, subscriberId: meter.subscriberId, meterId: meter.id, readingId: reading.id, tariffId: tariff.id,
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
        await tx.insert(invoiceLines).values(lines.map((line) => ({ ...line, invoiceId })));
        return invoiceId;
      });
      await writeAudit({ userId: ctx.user.id, entityType: "invoice", entityId: String(id), action: "issue", afterData: { invoiceNo, ...calculated } });
      return { id, invoiceNo, totalAmount: calculated.totalAmount };
    }),
    createShareLink: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), invoiceId: z.number().int().positive(), expiresAt: z.date().optional() }))
      .mutation(async ({ ctx, input }) => {
        await requireRole(ctx.user.id, input.siteId, createRoles);
        const db = await dbOrThrow();
        const [invoice] = await db.select().from(invoices).where(and(eq(invoices.id, input.invoiceId), eq(invoices.siteId, input.siteId))).limit(1);
        if (!invoice || invoice.status === "draft" || invoice.status === "cancelled") throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن مشاركة فاتورة غير صادرة أو ملغاة." });
        const token = generateInvoiceShareToken();
        const id = insertId(await db.insert(invoiceShareLinks).values({ invoiceId: invoice.id, tokenHash: hashInvoiceShareToken(token), tokenPreview: token.slice(0, 8), expiresAt: input.expiresAt }));
        await writeAudit({ userId: ctx.user.id, entityType: "invoice_share_link", entityId: String(id), action: "create", metadata: { invoiceId: invoice.id } });
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
      await requireRole(ctx.user.id, input.siteId, recordRoles);
      const db = await dbOrThrow();
      const id = insertId(await db.insert(payments).values({ ...input, amount: String(input.amount), collectedByUserId: ctx.user.id }));
      if (input.invoiceId) {
        const [invoice] = await db.select().from(invoices).where(eq(invoices.id, input.invoiceId)).limit(1);
        if (invoice) {
          const paidAmount = Number(invoice.paidAmount) + input.amount;
          const balanceDue = Math.max(0, Number(invoice.totalAmount) - paidAmount);
          await db.update(invoices).set({ paidAmount: String(paidAmount), balanceDue: String(balanceDue), status: balanceDue === 0 ? "paid" : "partially_paid" }).where(eq(invoices.id, invoice.id));
        }
      }
      await writeAudit({ userId: ctx.user.id, entityType: "payment", entityId: String(id), action: "create", afterData: input });
      return { id };
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
      await requireRole(ctx.user.id, input.siteId, createRoles);
      const db = await dbOrThrow();
      const id = insertId(await db.insert(expenses).values({ ...input, amount: String(input.amount), createdByUserId: ctx.user.id }));
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

  notifications: router({
    list: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "viewer"]);
      const db = await dbOrThrow();
      return db.select({ notification: notificationMessages, subscriber: subscribers }).from(notificationMessages)
        .innerJoin(subscribers, eq(notificationMessages.subscriberId, subscribers.id))
        .where(eq(subscribers.siteId, input.siteId)).orderBy(desc(notificationMessages.createdAt));
    }),
  }),

  audit: router({
    list: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "viewer"]);
      const db = await dbOrThrow();
      return db.select().from(auditLogs).orderBy(desc(auditLogs.createdAt)).limit(100);
    }),
  }),
});
