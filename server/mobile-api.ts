import type { Express, Request, Response } from "express";
import { createClient } from "@supabase/supabase-js";
import { SignJWT, jwtVerify } from "jose";
import { z } from "zod";
import crypto from "node:crypto";
import { can, type PowerCapability, type PowerRole } from "../shared/powerhub-rbac";
import { storagePut } from "./storage";
import { supabaseAdmin } from "./supabase-admin";
import { consumeHttpRateLimit, getClientIp } from "./http-rate-limit";

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
const mobileChangePasswordSchema = z.object({ newPassword: z.string().min(8).max(128) }).strict();
const refreshSchema = z.object({ refreshToken: z.string().min(32).max(256) });
const subscriberQuerySchema = z.object({ branchId: z.coerce.number().int().positive(), limit: z.coerce.number().int().min(1).max(100).default(100), cursor: z.coerce.number().int().min(0).default(0) });
const readingSchema = z.object({
  clientOperationId: z.string().uuid(),
  branchId: z.number().int().positive(),
  subscriberId: z.number().int().positive(),
  readingValue: z.string().regex(/^\d+(\.\d{1,2})?$/),
  readingAt: z.string().datetime(),
  captureMethod: z.enum(["manual", "photo", "smart_meter"]).default("manual"),
  isReadingReset: z.boolean().default(false),
  fieldVerified: z.boolean().default(false),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  imageData: z.string().max(9_500_000).optional(),
  imageMime: z.enum(["image/jpeg", "image/png", "image/webp"]).optional(),
  notes: z.string().trim().max(1000).optional(),
}).strict();
const syncEventSchema = z.object({
  eventKey: z.string().uuid(),
  branchId: z.number().int().positive(),
  eventType: z.enum(["sync_cycle", "sync_error"]),
  status: z.enum(["success", "partial", "retryable", "needs_review", "failed"]),
  syncedCount: z.number().int().min(0).max(10_000).default(0),
  retryableCount: z.number().int().min(0).max(10_000).default(0),
  needsReviewCount: z.number().int().min(0).max(10_000).default(0),
  errorCode: z.string().trim().max(100).optional(),
  errorMessage: z.string().trim().max(1500).optional(),
  appVersion: z.string().trim().max(64).optional(),
  deviceLabel: z.string().trim().max(160).optional(),
  occurredAt: z.string().datetime().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

type MobileScope = {
  userId: number;
  userName: string | null;
  tenantId: number;
  branchIds: number[];
  role: PowerRole;
  permissions: string[] | null;
  subscriptionEndsAt: string;
  mustChangePassword: boolean;
};

const toNumber = (value: number | string | null | undefined) => Number(value);
const isoNow = () => new Date().toISOString();

export function hashMobileToken(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function hasFieldAppAccess(role: PowerRole, permissions: readonly PowerCapability[] | null | undefined) {
  return role === "technician" && can(role, "recordReadings", permissions) && can(role, "accessFieldApp", permissions);
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

function sendSupabaseError(res: Response, error: { message: string } | null, message = "تعذر الوصول إلى قاعدة البيانات.") {
  if (error) console.error("[Mobile API] Supabase error:", error.message);
  return sendError(res, 503, "DATABASE_UNAVAILABLE", message, true);
}

function readBearerToken(req: Request) {
  const value = req.headers.authorization;
  return typeof value === "string" && value.startsWith("Bearer ") ? value.slice(7) : null;
}

async function syncMobileProfile(input: { id: string; email: string; name?: string | null }) {
  const admin = supabaseAdmin();
  const email = input.email.trim().toLowerCase();
  const { data, error } = await admin.from("users")
    .upsert({ auth_user_id: input.id, email, name: input.name?.trim() || email.split("@")[0], login_method: "supabase", last_signed_in: isoNow() }, { onConflict: "auth_user_id" })
    .select("id, name, account_status, must_change_password")
    .single();
  if (error || !data) throw new Error(error?.message || "Supabase user profile was not returned");
  return { id: toNumber(data.id), name: data.name as string | null, accountStatus: data.account_status as string, mustChangePassword: Boolean(data.must_change_password) };
}

async function resolveMobileScope(userId: number, tenantId: number, allowPasswordChange = false): Promise<MobileScope | null> {
  const admin = supabaseAdmin();
  const [userResult, membershipResult, tenantResult, profilesResult] = await Promise.all([
    admin.from("users").select("id, name, account_status, must_change_password").eq("id", userId).maybeSingle(),
    admin.from("tenant_members").select("id").eq("user_id", userId).eq("tenant_id", tenantId).eq("is_active", true).eq("membership_status", "active").maybeSingle(),
    admin.from("tenants").select("id, status").eq("id", tenantId).maybeSingle(),
    admin.from("staff_profiles").select("site_id, role, permissions, suspension_started_at, suspension_ends_at").eq("user_id", userId).eq("tenant_id", tenantId).eq("is_active", true),
  ]);
  if (userResult.error || membershipResult.error || tenantResult.error || profilesResult.error) throw new Error("Supabase mobile scope lookup failed");
  const user = userResult.data;
  if (!user || user.account_status !== "active" || (!allowPasswordChange && user.must_change_password) || !membershipResult.data || tenantResult.data?.status !== "active") return null;

  const now = new Date();
  const permitted = (profilesResult.data ?? []).filter((profile) => {
    const suspendedAt = profile.suspension_started_at ? new Date(profile.suspension_started_at) : null;
    const suspensionEndsAt = profile.suspension_ends_at ? new Date(profile.suspension_ends_at) : null;
    const suspended = Boolean(suspendedAt && suspendedAt <= now && (!suspensionEndsAt || suspensionEndsAt >= now));
    return !suspended && hasFieldAppAccess(profile.role as PowerRole, (profile.permissions as PowerCapability[] | null) ?? null);
  });
  if (!permitted.length) return null;

  const allBranches = permitted.some((profile) => profile.site_id === null);
  const { data: activeSites, error: sitesError } = await admin.from("sites").select("id").eq("tenant_id", tenantId).eq("status", "active");
  if (sitesError) throw new Error(`Supabase active site lookup failed: ${sitesError.message}`);
  const branchIds = allBranches
    ? (activeSites ?? []).map((site) => toNumber(site.id))
    : Array.from(new Set(permitted.flatMap((profile) => profile.site_id ? [toNumber(profile.site_id)] : [])));
  if (!branchIds.length) return null;
  const { data: subscription, error: subscriptionError } = await admin.from("tenant_subscriptions")
    .select("status, ends_at")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (subscriptionError) throw new Error(`Supabase subscription lookup failed: ${subscriptionError.message}`);
  const subscriptionEndsAt = subscription?.ends_at as string | null;
  const subscriptionActive = Boolean(subscription && ["trial", "active"].includes(String(subscription.status)) && (!subscriptionEndsAt || new Date(subscriptionEndsAt).getTime() > Date.now()));
  if (!subscriptionActive || !subscriptionEndsAt) return null;
  const selected = permitted[0];
  return { userId, userName: user.name as string | null, tenantId, branchIds, role: selected.role as PowerRole, permissions: (selected.permissions as string[] | null) ?? null, subscriptionEndsAt, mustChangePassword: Boolean(user.must_change_password) };
}

async function authenticateMobile(req: Request, allowPasswordChange = false): Promise<{ scope: MobileScope; sessionId: number } | null> {
  const token = readBearerToken(req);
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, jwtSecret(), { algorithms: ["HS256"] });
    if (payload.tokenUse !== "mobile_access" || !payload.sub || typeof payload.sessionId !== "number" || typeof payload.tenantId !== "number") return null;
    const userId = Number(payload.sub);
    if (!Number.isInteger(userId)) return null;
    const admin = supabaseAdmin();
    const { data: session, error } = await admin.from("mobile_api_sessions").select("id")
      .eq("id", payload.sessionId).eq("user_id", userId).eq("tenant_id", payload.tenantId).is("revoked_at", null).gt("expires_at", isoNow()).maybeSingle();
    if (error || !session) return null;
    const scope = await resolveMobileScope(userId, payload.tenantId, allowPasswordChange);
    if (!scope) return null;
    await admin.from("mobile_api_sessions").update({ last_used_at: isoNow() }).eq("id", session.id);
    return { scope, sessionId: toNumber(session.id) };
  } catch {
    return null;
  }
}

async function availableTenantsForUser(userId: number) {
  const admin = supabaseAdmin();
  const { data: memberships, error } = await admin.from("tenant_members").select("tenant_id, tenants!inner(id, name, status)")
    .eq("user_id", userId).eq("is_active", true).eq("membership_status", "active").eq("tenants.status", "active");
  if (error) throw new Error(error.message);
  return (memberships ?? []).map((membership: any) => ({ id: toNumber(membership.tenants.id), name: membership.tenants.name as string }));
}

async function createSession(scope: MobileScope, deviceLabel?: string) {
  const refreshToken = newRefreshToken();
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const admin = supabaseAdmin();
  const { error: revokeError } = await admin.from("mobile_api_sessions")
    .update({ revoked_at: isoNow() })
    .eq("user_id", scope.userId).eq("tenant_id", scope.tenantId).is("revoked_at", null);
  if (revokeError) throw new Error(revokeError.message || "تعذر إغلاق جلسة الجهاز السابق.");
  const { data: session, error } = await admin.from("mobile_api_sessions")
    .insert({ user_id: scope.userId, tenant_id: scope.tenantId, refresh_token_hash: hashMobileToken(refreshToken), device_label: deviceLabel, expires_at: expiresAt })
    .select("id")
    .single();
  if (error || !session) throw new Error(error?.message || "Supabase mobile session was not created");
  const sessionId = toNumber(session.id);
  return { accessToken: await issueAccessToken({ userId: scope.userId, tenantId: scope.tenantId, sessionId }), refreshToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS, sessionId };
}

function mobileUserPayload(scope: MobileScope) {
  return { id: scope.userId, name: scope.userName, role: scope.role, tenantId: scope.tenantId, branchIds: scope.branchIds, subscriptionEndsAt: scope.subscriptionEndsAt, mustChangePassword: scope.mustChangePassword };
}

async function writeAudit(input: { tenantId: number; branchId: number; userId: number; role: string; entityType: string; entityId: string; action: string; afterData: Record<string, unknown> }) {
  const { error } = await supabaseAdmin().from("audit_logs").insert({
    tenant_id: input.tenantId,
    site_id: input.branchId,
    user_id: input.userId,
    actor_tenant_role: input.role,
    entity_type: input.entityType,
    entity_id: input.entityId,
    action: input.action,
    after_data: input.afterData,
  });
  if (error) throw new Error(`Supabase audit write failed: ${error.message}`);
}

export function registerMobileApi(app: Express) {
  app.post("/api/mobile/v1/auth/login", async (req, res) => {
    const parsed = mobileLoginSchema.safeParse(req.body);
    const ip = getClientIp(req);
    const loginIpAllowed = await consumeHttpRateLimit({
      req,
      scope: "mobile-login-ip",
      windowSeconds: 600,
      maxAttempts: 20,
    });
    if (!loginIpAllowed) {
      res.setHeader("Retry-After", "600");
      return sendError(res, 429, "RATE_LIMITED", "تم تجاوز عدد محاولات تسجيل الدخول المسموح بها. حاول لاحقاً.", true);
    }
    if (!parsed.success) return sendError(res, 400, "INVALID_LOGIN_INPUT", "بيانات الدخول غير صالحة.");
    const emailKeyAllowed = await consumeHttpRateLimit({
      req,
      scope: "mobile-login-email-ip",
      keyMaterial: `${parsed.data.email.trim().toLowerCase()}|${ip}`,
      windowSeconds: 900,
      maxAttempts: 8,
    });
    if (!emailKeyAllowed) {
      res.setHeader("Retry-After", "900");
      return sendError(res, 429, "RATE_LIMITED", "تم تجاوز عدد محاولات تسجيل الدخول لهذا الحساب. حاول لاحقاً.", true);
    }
    if (!parsed.success) return sendError(res, 400, "INVALID_LOGIN_INPUT", "بيانات الدخول غير صالحة.");
    const url = process.env.VITE_SUPABASE_URL;
    const key = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
    if (!url || !key) return sendError(res, 503, "AUTH_NOT_CONFIGURED", "مصادقة الموبايل غير مهيأة.");
    const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await supabase.auth.signInWithPassword({ email: parsed.data.email.trim().toLowerCase(), password: parsed.data.password });
    if (error || !data.user?.email) return sendError(res, 401, "INVALID_CREDENTIALS", "بيانات الدخول غير صحيحة.");
    try {
      const user = await syncMobileProfile({ id: data.user.id, email: data.user.email, name: (data.user.user_metadata?.name as string | undefined) ?? null });
      const memberships = await availableTenantsForUser(user.id);
      const tenantId = parsed.data.tenantId ?? (memberships.length === 1 ? memberships[0].id : undefined);
      if (!tenantId) return res.status(409).json({ error: { code: "TENANT_SELECTION_REQUIRED", message: "اختر مساحة الشركة قبل المتابعة.", retryable: false }, tenants: memberships });
      const scope = await resolveMobileScope(user.id, tenantId, true);
      if (!scope) return sendError(res, 403, "MOBILE_ACCESS_DENIED", "لا يملك هذا الحساب صلاحية الدخول للتطبيق الميداني.");
      return res.json({ ...(await createSession(scope, parsed.data.deviceLabel)), user: mobileUserPayload(scope) });
    } catch (profileError) {
      return sendSupabaseError(res, profileError instanceof Error ? profileError : null, "تعذر تهيئة حساب الموبايل.");
    }
  });

  app.post("/api/mobile/v1/auth/change-password", async (req, res) => {
    const parsed = mobileChangePasswordSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, 400, "INVALID_PASSWORD_INPUT", "كلمة المرور الجديدة غير صالحة.");
    const context = await authenticateMobile(req, true);
    if (!context) return sendError(res, 401, "UNAUTHORIZED", "جلسة الموبايل غير صالحة.");
    if (!context.scope.mustChangePassword) return sendError(res, 409, "PASSWORD_CHANGE_NOT_REQUIRED", "لا توجد كلمة مرور مؤقتة معلقة.");
    const admin = supabaseAdmin();
    const { data: user, error: userError } = await admin.from("users").select("auth_user_id").eq("id", context.scope.userId).maybeSingle();
    if (userError) return sendSupabaseError(res, userError);
    if (!user?.auth_user_id) return sendError(res, 409, "AUTH_PROFILE_MISSING", "تعذر ربط حساب الموبايل بحساب المصادقة.");
    const { error: authError } = await admin.auth.admin.updateUserById(user.auth_user_id, { password: parsed.data.newPassword });
    if (authError) return sendError(res, 400, "PASSWORD_CHANGE_FAILED", "تعذر تغيير كلمة المرور.");
    const { error: profileError } = await admin.from("users").update({ must_change_password: false, temporary_password_issued_at: null, updated_at: isoNow() }).eq("id", context.scope.userId);
    if (profileError) return sendSupabaseError(res, profileError, "تم تغيير كلمة المرور لكن تعذر تحديث حالة الحساب.");
    await admin.from("mobile_api_sessions").update({ last_used_at: isoNow() }).eq("id", context.sessionId);
    return res.json({ success: true });
  });

  app.post("/api/mobile/v1/auth/refresh", async (req, res) => {
    const allowed = await consumeHttpRateLimit({ req, scope: "mobile-refresh-ip", windowSeconds: 300, maxAttempts: 30 });
    if (!allowed) {
      res.setHeader("Retry-After", "300");
      return sendError(res, 429, "RATE_LIMITED", "تم تجاوز عدد محاولات تجديد الجلسة. حاول لاحقاً.", true);
    }
    const parsed = refreshSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, 400, "INVALID_REFRESH_TOKEN", "رمز التجديد غير صالح.");
    try {
      const refreshToken = newRefreshToken();
      const { data: rows, error } = await supabaseAdmin().rpc("powerhub_mobile_rotate_refresh_session", {
        p_old_refresh_token_hash: hashMobileToken(parsed.data.refreshToken),
        p_new_refresh_token_hash: hashMobileToken(refreshToken),
        p_now: isoNow(),
      });
      if (error) return sendSupabaseError(res, error);
      const session = Array.isArray(rows) ? rows[0] : rows;
      if (!session) return sendError(res, 401, "REFRESH_TOKEN_EXPIRED", "انتهت جلسة الموبايل. سجّل الدخول مجدداً.");
      const scope = await resolveMobileScope(toNumber(session.user_id), toNumber(session.tenant_id));
      if (!scope) return sendError(res, 403, "MOBILE_ACCESS_DENIED", "لا يمكن متابعة جلسة هذا الحساب.");
      return res.json({ accessToken: await issueAccessToken({ userId: scope.userId, tenantId: scope.tenantId, sessionId: toNumber(session.id) }), refreshToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS, user: mobileUserPayload(scope) });
    } catch (scopeError) {
      return sendSupabaseError(res, scopeError instanceof Error ? scopeError : null);
    }
  });

  app.post("/api/mobile/v1/auth/logout", async (req, res) => {
    const context = await authenticateMobile(req);
    if (!context) return sendError(res, 401, "UNAUTHORIZED", "جلسة الموبايل غير صالحة.");
    const { error } = await supabaseAdmin().from("mobile_api_sessions").update({ revoked_at: isoNow(), last_used_at: isoNow() }).eq("id", context.sessionId);
    if (error) return sendSupabaseError(res, error);
    return res.status(204).send();
  });

  app.get("/api/mobile/v1/auth/me", async (req, res) => {
    const context = await authenticateMobile(req);
    if (!context) return sendError(res, 401, "UNAUTHORIZED", "جلسة الموبايل غير صالحة أو منتهية.");
    return res.json({ user: mobileUserPayload(context.scope) });
  });

  app.get("/api/mobile/v1/reading-cycle", async (req, res) => {
    const context = await authenticateMobile(req);
    if (!context) return sendError(res, 401, "UNAUTHORIZED", "جلسة الموبايل غير صالحة أو منتهية.");

    const branchId = Number(req.query.branchId);
    if (!Number.isInteger(branchId) || branchId <= 0) return sendError(res, 400, "INVALID_BRANCH", "الفرع المحدد غير صالح.");
    if (!context.scope.branchIds.includes(branchId)) return sendError(res, 403, "BRANCH_ACCESS_DENIED", "لا تملك صلاحية الوصول إلى هذا الفرع.");

    const { data, error } = await supabaseAdmin().rpc("powerhub_get_reading_cycle", {
      p_tenant_id: context.scope.tenantId,
      p_site_id: branchId,
    });
    if (error) return sendSupabaseError(res, error, "تعذر تحميل دورة القراءات من PowerHub.");

    const row = Array.isArray(data) ? data[0] : data;
    return res.json({
      cycle: {
        cycleType: row?.cycle_type ?? "MONTHLY",
        weeklyStartDay: Number(row?.weekly_start_day ?? 7),
        monthlyStartDay: Number(row?.monthly_start_day ?? 1),
        timezone: row?.timezone ?? "Asia/Gaza",
      },
    });
  });

  app.get("/api/mobile/v1/subscribers", async (req, res) => {
    const context = await authenticateMobile(req);
    if (!context) return sendError(res, 401, "UNAUTHORIZED", "جلسة الموبايل غير صالحة أو منتهية.");
    const parsed = subscriberQuerySchema.safeParse(req.query);
    if (!parsed.success) return sendError(res, 400, "INVALID_QUERY", "بيانات طلب المشتركين غير صالحة.");
    if (!context.scope.branchIds.includes(parsed.data.branchId)) return sendError(res, 403, "BRANCH_ACCESS_DENIED", "لا تملك صلاحية الوصول إلى هذا الفرع.");
    const admin = supabaseAdmin();
    const { data: rows, error } = await admin.from("subscribers").select("id, subscriber_no, full_name, phone, address, site_id")
      .eq("tenant_id", context.scope.tenantId).eq("site_id", parsed.data.branchId).eq("service_status", "active").order("id", { ascending: true }).range(parsed.data.cursor, parsed.data.cursor + parsed.data.limit - 1);
    if (error) return sendSupabaseError(res, error);
    try {
      const items = await Promise.all((rows ?? []).map(async (row) => {
        const { data: last, error: lastError } = await admin.from("meter_readings").select("reading_value, reading_at")
          .eq("subscriber_id", row.id).eq("status", "approved").order("reading_at", { ascending: false }).limit(1).maybeSingle();
        if (lastError) throw new Error(lastError.message);
        return { id: toNumber(row.id), subscriberNo: row.subscriber_no, fullName: row.full_name, phone: row.phone, address: row.address, branchId: toNumber(row.site_id), lastReading: last?.reading_value ?? null, lastReadingAt: last?.reading_at ?? null };
      }));
      return res.json({ items, nextCursor: (rows?.length ?? 0) === parsed.data.limit ? String(parsed.data.cursor + parsed.data.limit) : null });
    } catch (lastReadingError) {
      return sendSupabaseError(res, lastReadingError instanceof Error ? lastReadingError : null);
    }
  });

  app.post("/api/mobile/v1/readings", async (req, res) => {
    const context = await authenticateMobile(req);
    if (!context) return sendError(res, 401, "UNAUTHORIZED", "جلسة الموبايل غير صالحة أو منتهية.");
    const parsed = readingSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, 400, "INVALID_READING", "بيانات القراءة غير صالحة.");
    const input = parsed.data;
    if (!context.scope.branchIds.includes(input.branchId)) return sendError(res, 403, "BRANCH_ACCESS_DENIED", "لا تملك صلاحية تسجيل قراءة لهذا الفرع.");
    const admin = supabaseAdmin();
    const { data: existing, error: existingError } = await admin.from("meter_readings").select("id, status, consumption_kwh")
      .eq("tenant_id", context.scope.tenantId).eq("client_operation_id", input.clientOperationId).maybeSingle();
    if (existingError) return sendSupabaseError(res, existingError);
    if (existing) return res.status(200).json({ id: toNumber(existing.id), status: existing.status, consumptionKwh: existing.consumption_kwh, replayed: true });
    const { data: subscriber, error: subscriberError } = await admin.from("subscribers").select("id")
      .eq("id", input.subscriberId).eq("tenant_id", context.scope.tenantId).eq("site_id", input.branchId).eq("service_status", "active").maybeSingle();
    if (subscriberError) return sendSupabaseError(res, subscriberError);
    if (!subscriber) return sendError(res, 404, "SUBSCRIBER_NOT_FOUND", "المشترك لا يتبع للفرع المحدد أو أن خدمته غير نشطة.");
    const readingAt = new Date(input.readingAt);
    const dayStart = new Date(readingAt); dayStart.setUTCHours(0, 0, 0, 0);
    const nextDay = new Date(dayStart); nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    const { data: sameDayReading, error: sameDayError } = await admin.from("meter_readings").select("id")
      .eq("subscriber_id", subscriber.id).gte("reading_at", dayStart.toISOString()).lt("reading_at", nextDay.toISOString()).neq("status", "rejected").limit(1).maybeSingle();
    if (sameDayError) return sendSupabaseError(res, sameDayError);
    if (sameDayReading) return sendError(res, 409, "READING_ALREADY_EXISTS_TODAY", "توجد قراءة غير مرفوضة لهذا المشترك في اليوم نفسه.");
    const { data: previous, error: previousError } = await admin.from("meter_readings").select("reading_value")
      .eq("subscriber_id", subscriber.id).eq("status", "approved").order("reading_at", { ascending: false }).limit(1).maybeSingle();
    if (previousError) return sendSupabaseError(res, previousError);
    const previousValue = Number(previous?.reading_value ?? 0);
    const nextValue = Number(input.readingValue);
    if (nextValue < previousValue && !input.isReadingReset) return sendError(res, 409, "READING_BELOW_PREVIOUS", "القراءة الحالية أقل من القراءة المعتمدة السابقة.");
    if (nextValue < previousValue && !input.notes) return sendError(res, 400, "READING_RESET_NOTE_REQUIRED", "أدخل ملاحظة تشرح إعادة ضبط سجل القراءة.");
    const consumptionKwh = input.isReadingReset && nextValue < previousValue ? nextValue : nextValue - previousValue;
    let imageKey: string | undefined;
    let imageHash: string | undefined;
    if (input.imageData) {
      if (!input.imageMime) return sendError(res, 400, "IMAGE_MIME_REQUIRED", "حدد نوع صورة القراءة.");
      const imageBytes = Buffer.from(input.imageData, "base64");
      if (!imageBytes.byteLength || imageBytes.byteLength > 7 * 1024 * 1024) return sendError(res, 413, "IMAGE_TOO_LARGE", "يجب ألا يتجاوز حجم صورة القراءة 7 ميغابايت.");
      imageHash = crypto.createHash("sha256").update(imageBytes).digest("hex");
      const extension = input.imageMime === "image/png" ? "png" : input.imageMime === "image/webp" ? "webp" : "jpg";
      imageKey = (await storagePut(`subscriber-readings/mobile/${context.scope.userId}/${subscriber.id}-${Date.now()}.${extension}`, imageBytes, input.imageMime)).key;
    }
    const notes = [input.isReadingReset ? "[إعادة ضبط سجل القراءة]" : "", input.fieldVerified ? "[تم التحقق ميدانياً]" : "", input.notes ?? ""].filter(Boolean).join(" ");
    const { data: inserted, error: insertError } = await admin.from("meter_readings").insert({
      tenant_id: context.scope.tenantId, subscriber_id: subscriber.id, client_operation_id: input.clientOperationId, reading_at: readingAt.toISOString(), reading_value: input.readingValue,
      previous_reading_value: previous?.reading_value ?? null, consumption_kwh: String(consumptionKwh), capture_method: input.captureMethod, image_key: imageKey, image_hash: imageHash, entered_by_user_id: context.scope.userId, notes,
    }).select("id, status, consumption_kwh").single();
    if (insertError || !inserted) return sendSupabaseError(res, insertError, "تعذر تسجيل القراءة.");
    try {
      await writeAudit({ tenantId: context.scope.tenantId, branchId: input.branchId, userId: context.scope.userId, role: context.scope.role, entityType: "subscriber_reading", entityId: String(inserted.id), action: "mobile_create", afterData: { clientOperationId: input.clientOperationId, subscriberId: input.subscriberId, readingValue: input.readingValue, readingAt: input.readingAt, latitude: input.latitude, longitude: input.longitude, captureMethod: input.captureMethod } });
      return res.status(201).json({ id: toNumber(inserted.id), status: inserted.status, consumptionKwh: inserted.consumption_kwh, replayed: false });
    } catch (auditError) {
      return sendSupabaseError(res, auditError instanceof Error ? auditError : null, "تم حفظ القراءة لكن تعذر تسجيل التدقيق.");
    }
  });

  app.post("/api/mobile/v1/sync-events", async (req, res) => {
    const context = await authenticateMobile(req);
    if (!context) return sendError(res, 401, "UNAUTHORIZED", "جلسة الموبايل غير صالحة أو منتهية.");
    const parsed = syncEventSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, 400, "INVALID_SYNC_EVENT", "بيانات حدث المزامنة غير صالحة.");
    const input = parsed.data;
    if (!context.scope.branchIds.includes(input.branchId)) return sendError(res, 403, "BRANCH_ACCESS_DENIED", "لا تملك صلاحية تسجيل حدث لهذا الفرع.");
    const admin = supabaseAdmin();
    const { data: existing, error: existingError } = await admin.from("mobile_sync_events").select("id")
      .eq("tenant_id", context.scope.tenantId).eq("event_key", input.eventKey).maybeSingle();
    if (existingError) return sendSupabaseError(res, existingError);
    if (existing) return res.status(200).json({ id: toNumber(existing.id), replayed: true });
    const { data: inserted, error: insertError } = await admin.from("mobile_sync_events").insert({
      tenant_id: context.scope.tenantId, site_id: input.branchId, user_id: context.scope.userId, session_id: context.sessionId, event_key: input.eventKey, event_type: input.eventType, status: input.status,
      synced_count: input.syncedCount, retryable_count: input.retryableCount, needs_review_count: input.needsReviewCount, error_code: input.errorCode, error_message: input.errorMessage,
      app_version: input.appVersion, device_label: input.deviceLabel, metadata: input.metadata, occurred_at: input.occurredAt ?? isoNow(),
    }).select("id").single();
    if (insertError || !inserted) return sendSupabaseError(res, insertError, "تعذر تسجيل حدث المزامنة.");
    try {
      await writeAudit({ tenantId: context.scope.tenantId, branchId: input.branchId, userId: context.scope.userId, role: context.scope.role, entityType: "mobile_sync_event", entityId: String(inserted.id), action: input.eventType, afterData: { status: input.status, syncedCount: input.syncedCount, retryableCount: input.retryableCount, needsReviewCount: input.needsReviewCount, errorCode: input.errorCode } });
      return res.status(201).json({ id: toNumber(inserted.id), replayed: false });
    } catch (auditError) {
      return sendSupabaseError(res, auditError instanceof Error ? auditError : null, "تم تسجيل الحدث لكن تعذر تسجيل التدقيق.");
    }
  });
}

export const mobileApiSchemas = { login: mobileLoginSchema, changePassword: mobileChangePasswordSchema, refresh: refreshSchema, subscribers: subscriberQuerySchema, reading: readingSchema, syncEvent: syncEventSchema };
