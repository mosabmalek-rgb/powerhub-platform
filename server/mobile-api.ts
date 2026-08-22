import type { Express, Request, Response } from "express";
import { createClient } from "@supabase/supabase-js";
import { SignJWT, jwtVerify } from "jose";
import { and, desc, eq, gt, gte, isNull, lt, ne } from "drizzle-orm";
import { z } from "zod";
import { getDb, syncSupabaseUser } from "./db";
import { auditLogs, meterReadings, meters, mobileApiSessions, sites, staffProfiles, subscribers, tenantMembers, tenants, users } from "../drizzle/schema";
import { can, type PowerCapability, type PowerRole } from "../shared/powerhub-rbac";
import crypto from "node:crypto";

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const REFRESH_TOKEN_TTL_DAYS = 30;
const jwtSecret = () => {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("Mobile API authentication is not configured");
  return new TextEncoder().encode(secret);
};

const mobileLoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(256),
  tenantId: z.number().int().positive().optional(),
  deviceLabel: z.string().trim().min(1).max(160).optional(),
});
const refreshSchema = z.object({ refreshToken: z.string().min(32).max(256) });
const subscriberQuerySchema = z.object({ branchId: z.coerce.number().int().positive(), limit: z.coerce.number().int().min(1).max(100).default(100) });
const readingSchema = z.object({
  clientOperationId: z.string().uuid(),
  branchId: z.number().int().positive(),
  subscriberId: z.number().int().positive(),
  meterId: z.number().int().positive(),
  readingValue: z.string().regex(/^\d+(\.\d{1,3})?$/),
  readingAt: z.string().datetime(),
  captureMethod: z.enum(["manual", "photo", "smart_meter"]).default("manual"),
  isMeterReplacement: z.boolean().default(false),
  fieldVerified: z.boolean().default(false),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  notes: z.string().trim().max(1000).optional(),
});

type MobileScope = {
  userId: number;
  userName: string | null;
  tenantId: number;
  branchIds: number[];
  role: PowerRole;
  permissions: string[] | null;
};

export function hashMobileToken(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function newRefreshToken() {
  return crypto.randomBytes(48).toString("base64url");
}

async function issueAccessToken(input: { userId: number; tenantId: number; sessionId: number }) {
  return new SignJWT({ tenantId: input.tenantId, sessionId: input.sessionId, tokenUse: "mobile_access" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(String(input.userId))
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(jwtSecret());
}

function sendError(res: Response, status: number, code: string, message: string, retryable = false) {
  return res.status(status).json({ error: { code, message, retryable } });
}

function readBearerToken(req: Request) {
  const value = req.headers.authorization;
  return typeof value === "string" && value.startsWith("Bearer ") ? value.slice(7) : null;
}

async function resolveMobileScope(userId: number, tenantId: number): Promise<MobileScope | null> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const [[user], [membership], [tenant]] = await Promise.all([
    db.select({ id: users.id, name: users.name, accountStatus: users.accountStatus, mustChangePassword: users.mustChangePassword }).from(users).where(eq(users.id, userId)).limit(1),
    db.select({ id: tenantMembers.id }).from(tenantMembers).where(and(eq(tenantMembers.userId, userId), eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.isActive, true), eq(tenantMembers.membershipStatus, "active"))).limit(1),
    db.select({ id: tenants.id, status: tenants.status }).from(tenants).where(eq(tenants.id, tenantId)).limit(1),
  ]);
  if (!user || user.accountStatus !== "active" || user.mustChangePassword || !membership || tenant?.status !== "active") return null;

  const now = new Date();
  const profiles = await db.select({ siteId: staffProfiles.siteId, role: staffProfiles.role, permissions: staffProfiles.permissions, suspensionStartedAt: staffProfiles.suspensionStartedAt, suspensionEndsAt: staffProfiles.suspensionEndsAt })
    .from(staffProfiles)
    .where(and(eq(staffProfiles.userId, userId), eq(staffProfiles.tenantId, tenantId), eq(staffProfiles.isActive, true)));
  const permitted = profiles.filter((profile) => {
    const suspended = profile.suspensionStartedAt && profile.suspensionStartedAt <= now && (!profile.suspensionEndsAt || profile.suspensionEndsAt >= now);
    return !suspended && can(profile.role as PowerRole, "recordReadings", profile.permissions as PowerCapability[] | null);
  });
  if (!permitted.length) return null;

  const allBranches = permitted.some((profile) => profile.siteId === null);
  const activeSites = await db.select({ id: sites.id }).from(sites).where(and(eq(sites.tenantId, tenantId), eq(sites.status, "active")));
  const branchIds = allBranches ? activeSites.map((site) => site.id) : permitted.flatMap((profile) => profile.siteId ? [profile.siteId] : []);
  const uniqueBranchIds = Array.from(new Set(branchIds));
  if (!uniqueBranchIds.length) return null;
  const selected = permitted[0];
  return { userId, userName: user.name, tenantId, branchIds: uniqueBranchIds, role: selected.role as PowerRole, permissions: selected.permissions };
}

async function authenticateMobile(req: Request): Promise<{ scope: MobileScope; sessionId: number } | null> {
  const token = readBearerToken(req);
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, jwtSecret(), { algorithms: ["HS256"] });
    if (payload.tokenUse !== "mobile_access" || !payload.sub || typeof payload.sessionId !== "number" || typeof payload.tenantId !== "number") return null;
    const userId = Number(payload.sub);
    const sessionId = payload.sessionId;
    if (!Number.isInteger(userId)) return null;
    const db = await getDb();
    if (!db) throw new Error("Database unavailable");
    const [session] = await db.select({ id: mobileApiSessions.id }).from(mobileApiSessions)
      .where(and(eq(mobileApiSessions.id, sessionId), eq(mobileApiSessions.userId, userId), eq(mobileApiSessions.tenantId, payload.tenantId), isNull(mobileApiSessions.revokedAt), gt(mobileApiSessions.expiresAt, new Date()))).limit(1);
    if (!session) return null;
    const scope = await resolveMobileScope(userId, payload.tenantId);
    if (!scope) return null;
    await db.update(mobileApiSessions).set({ lastUsedAt: new Date() }).where(eq(mobileApiSessions.id, sessionId));
    return { scope, sessionId };
  } catch {
    return null;
  }
}

async function availableTenantsForUser(userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  return db.select({ id: tenants.id, name: tenants.name }).from(tenantMembers)
    .innerJoin(tenants, eq(tenants.id, tenantMembers.tenantId))
    .where(and(eq(tenantMembers.userId, userId), eq(tenantMembers.isActive, true), eq(tenantMembers.membershipStatus, "active"), eq(tenants.status, "active")));
}

async function createSession(scope: MobileScope, deviceLabel?: string) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const refreshToken = newRefreshToken();
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
  const result = await db.insert(mobileApiSessions).values({ userId: scope.userId, tenantId: scope.tenantId, refreshTokenHash: hashMobileToken(refreshToken), deviceLabel, expiresAt });
  const sessionId = Number(result[0].insertId);
  return { accessToken: await issueAccessToken({ userId: scope.userId, tenantId: scope.tenantId, sessionId }), refreshToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS, sessionId };
}

function mobileUserPayload(scope: MobileScope) {
  return { id: scope.userId, name: scope.userName, role: scope.role, tenantId: scope.tenantId, branchIds: scope.branchIds };
}

export function registerMobileApi(app: Express) {
  app.post("/api/mobile/v1/auth/login", async (req, res) => {
    const parsed = mobileLoginSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, 400, "INVALID_LOGIN_INPUT", "بيانات الدخول غير صالحة.");
    const url = process.env.VITE_SUPABASE_URL;
    const key = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
    if (!url || !key) return sendError(res, 503, "AUTH_NOT_CONFIGURED", "مصادقة الموبايل غير مهيأة.");
    const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await supabase.auth.signInWithPassword({ email: parsed.data.email.trim().toLowerCase(), password: parsed.data.password });
    if (error || !data.user?.email) return sendError(res, 401, "INVALID_CREDENTIALS", "بيانات الدخول غير صحيحة.");
    const user = await syncSupabaseUser({ id: data.user.id, email: data.user.email, name: (data.user.user_metadata?.name as string | undefined) ?? null });
    const memberships = await availableTenantsForUser(user.id);
    const tenantId = parsed.data.tenantId ?? (memberships.length === 1 ? memberships[0].id : undefined);
    if (!tenantId) return res.status(409).json({ error: { code: "TENANT_SELECTION_REQUIRED", message: "اختر مساحة الشركة قبل المتابعة.", retryable: false }, tenants: memberships });
    const scope = await resolveMobileScope(user.id, tenantId);
    if (!scope) return sendError(res, 403, "MOBILE_ACCESS_DENIED", "لا يملك هذا الحساب صلاحية تسجيل القراءات الميدانية أو يجب تغيير كلمة المرور المؤقتة أولاً.");
    const tokens = await createSession(scope, parsed.data.deviceLabel);
    return res.json({ ...tokens, user: mobileUserPayload(scope) });
  });

  app.post("/api/mobile/v1/auth/refresh", async (req, res) => {
    const parsed = refreshSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, 400, "INVALID_REFRESH_TOKEN", "رمز التجديد غير صالح.");
    const db = await getDb();
    if (!db) return sendError(res, 503, "DATABASE_UNAVAILABLE", "تعذر الوصول إلى قاعدة البيانات.", true);
    const [session] = await db.select().from(mobileApiSessions).where(and(eq(mobileApiSessions.refreshTokenHash, hashMobileToken(parsed.data.refreshToken)), isNull(mobileApiSessions.revokedAt), gt(mobileApiSessions.expiresAt, new Date()))).limit(1);
    if (!session) return sendError(res, 401, "REFRESH_TOKEN_EXPIRED", "انتهت جلسة الموبايل. سجّل الدخول مجدداً.");
    const scope = await resolveMobileScope(session.userId, session.tenantId);
    if (!scope) return sendError(res, 403, "MOBILE_ACCESS_DENIED", "لا يمكن متابعة جلسة هذا الحساب.");
    const refreshToken = newRefreshToken();
    await db.update(mobileApiSessions).set({ refreshTokenHash: hashMobileToken(refreshToken), lastUsedAt: new Date() }).where(eq(mobileApiSessions.id, session.id));
    return res.json({ accessToken: await issueAccessToken({ userId: scope.userId, tenantId: scope.tenantId, sessionId: session.id }), refreshToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS, user: mobileUserPayload(scope) });
  });

  app.post("/api/mobile/v1/auth/logout", async (req, res) => {
    const context = await authenticateMobile(req);
    if (!context) return sendError(res, 401, "UNAUTHORIZED", "جلسة الموبايل غير صالحة.");
    const db = await getDb();
    if (!db) return sendError(res, 503, "DATABASE_UNAVAILABLE", "تعذر الوصول إلى قاعدة البيانات.", true);
    await db.update(mobileApiSessions).set({ revokedAt: new Date(), lastUsedAt: new Date() }).where(eq(mobileApiSessions.id, context.sessionId));
    return res.status(204).send();
  });

  app.get("/api/mobile/v1/auth/me", async (req, res) => {
    const context = await authenticateMobile(req);
    if (!context) return sendError(res, 401, "UNAUTHORIZED", "جلسة الموبايل غير صالحة أو منتهية.");
    return res.json({ user: mobileUserPayload(context.scope) });
  });

  app.get("/api/mobile/v1/subscribers", async (req, res) => {
    const context = await authenticateMobile(req);
    if (!context) return sendError(res, 401, "UNAUTHORIZED", "جلسة الموبايل غير صالحة أو منتهية.");
    const parsed = subscriberQuerySchema.safeParse(req.query);
    if (!parsed.success) return sendError(res, 400, "INVALID_QUERY", "بيانات طلب المشتركين غير صالحة.");
    if (!context.scope.branchIds.includes(parsed.data.branchId)) return sendError(res, 403, "BRANCH_ACCESS_DENIED", "لا تملك صلاحية الوصول إلى هذا الفرع.");
    const db = await getDb();
    if (!db) return sendError(res, 503, "DATABASE_UNAVAILABLE", "تعذر الوصول إلى قاعدة البيانات.", true);
    const rows = await db.select({ subscriberId: subscribers.id, subscriberNo: subscribers.subscriberNo, fullName: subscribers.fullName, phone: subscribers.phone, address: subscribers.address, branchId: subscribers.siteId, meterId: meters.id, serialNumber: meters.serialNumber })
      .from(subscribers).innerJoin(meters, eq(meters.subscriberId, subscribers.id))
      .where(and(eq(subscribers.tenantId, context.scope.tenantId), eq(subscribers.siteId, parsed.data.branchId), eq(subscribers.serviceStatus, "active"), eq(meters.status, "active"))).limit(parsed.data.limit);
    const items = await Promise.all(rows.map(async (row) => {
      const [last] = await db.select({ readingValue: meterReadings.readingValue, readingAt: meterReadings.readingAt }).from(meterReadings)
        .where(and(eq(meterReadings.meterId, row.meterId), eq(meterReadings.status, "approved"))).orderBy(desc(meterReadings.readingAt)).limit(1);
      return { id: row.subscriberId, subscriberNo: row.subscriberNo, fullName: row.fullName, phone: row.phone, address: row.address, branchId: row.branchId, meterId: row.meterId, meterSerial: row.serialNumber, lastReading: last?.readingValue ?? null, lastReadingAt: last?.readingAt?.toISOString() ?? null };
    }));
    return res.json({ items, nextCursor: null });
  });

  app.post("/api/mobile/v1/readings", async (req, res) => {
    const context = await authenticateMobile(req);
    if (!context) return sendError(res, 401, "UNAUTHORIZED", "جلسة الموبايل غير صالحة أو منتهية.");
    const parsed = readingSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, 400, "INVALID_READING", "بيانات القراءة غير صالحة.");
    const input = parsed.data;
    if (!context.scope.branchIds.includes(input.branchId)) return sendError(res, 403, "BRANCH_ACCESS_DENIED", "لا تملك صلاحية تسجيل قراءة لهذا الفرع.");
    const db = await getDb();
    if (!db) return sendError(res, 503, "DATABASE_UNAVAILABLE", "تعذر الوصول إلى قاعدة البيانات.", true);
    const [existing] = await db.select({ id: meterReadings.id, status: meterReadings.status, consumptionKwh: meterReadings.consumptionKwh }).from(meterReadings)
      .where(and(eq(meterReadings.tenantId, context.scope.tenantId), eq(meterReadings.clientOperationId, input.clientOperationId))).limit(1);
    if (existing) return res.status(200).json({ id: existing.id, status: existing.status, consumptionKwh: existing.consumptionKwh, replayed: true });
    const [scope] = await db.select({ meterId: meters.id }).from(meters).innerJoin(subscribers, eq(meters.subscriberId, subscribers.id))
      .where(and(eq(meters.id, input.meterId), eq(subscribers.id, input.subscriberId), eq(subscribers.tenantId, context.scope.tenantId), eq(subscribers.siteId, input.branchId), eq(subscribers.serviceStatus, "active"), eq(meters.status, "active"))).limit(1);
    if (!scope) return sendError(res, 404, "METER_NOT_FOUND", "العداد أو المشترك لا يتبعان للفرع المحدد.");
    const readingAt = new Date(input.readingAt);
    const dayStart = new Date(readingAt); dayStart.setHours(0, 0, 0, 0);
    const nextDay = new Date(dayStart); nextDay.setDate(nextDay.getDate() + 1);
    const [sameDayReading] = await db.select({ id: meterReadings.id }).from(meterReadings)
      .where(and(eq(meterReadings.meterId, input.meterId), gte(meterReadings.readingAt, dayStart), lt(meterReadings.readingAt, nextDay), ne(meterReadings.status, "rejected"))).limit(1);
    if (sameDayReading) return sendError(res, 409, "READING_ALREADY_EXISTS_TODAY", "توجد قراءة غير مرفوضة لهذا العداد في اليوم نفسه.");
    const [previous] = await db.select({ readingValue: meterReadings.readingValue }).from(meterReadings).where(and(eq(meterReadings.meterId, input.meterId), eq(meterReadings.status, "approved"))).orderBy(desc(meterReadings.readingAt)).limit(1);
    const previousValue = Number(previous?.readingValue ?? 0);
    const nextValue = Number(input.readingValue);
    if (nextValue < previousValue && !input.isMeterReplacement) return sendError(res, 409, "READING_BELOW_PREVIOUS", "القراءة الحالية أقل من القراءة المعتمدة السابقة.");
    if (nextValue < previousValue && !input.notes) return sendError(res, 400, "METER_REPLACEMENT_NOTE_REQUIRED", "أدخل ملاحظة تشرح استبدال العداد.");
    const consumptionKwh = input.isMeterReplacement && nextValue < previousValue ? nextValue : nextValue - previousValue;
    const inserted = await db.insert(meterReadings).values({ tenantId: context.scope.tenantId, meterId: input.meterId, clientOperationId: input.clientOperationId, readingAt, readingValue: input.readingValue, previousReadingValue: previous?.readingValue, consumptionKwh: String(consumptionKwh), captureMethod: input.captureMethod, enteredByUserId: context.scope.userId, notes: [input.isMeterReplacement ? "[استبدال عداد]" : "", input.fieldVerified ? "[تم التحقق ميدانياً]" : "", input.notes ?? ""].filter(Boolean).join(" ") });
    const id = Number(inserted[0].insertId);
    await db.insert(auditLogs).values({ tenantId: context.scope.tenantId, siteId: input.branchId, userId: context.scope.userId, actorTenantRole: context.scope.role, entityType: "meter_reading", entityId: String(id), action: "mobile_create", afterData: { clientOperationId: input.clientOperationId, meterId: input.meterId, readingValue: input.readingValue, readingAt: input.readingAt, latitude: input.latitude, longitude: input.longitude, captureMethod: input.captureMethod } });
    return res.status(201).json({ id, status: "pending_review", consumptionKwh: String(consumptionKwh), replayed: false });
  });
}

export const mobileApiSchemas = { login: mobileLoginSchema, refresh: refreshSchema, subscribers: subscriberQuerySchema, reading: readingSchema };
