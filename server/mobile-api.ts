import type { Express, Request, Response } from "express";
import { createClient } from "@supabase/supabase-js";
import { SignJWT, jwtVerify } from "jose";
import { z } from "zod";
import crypto from "node:crypto";
import { can, type PowerCapability, type PowerRole } from "../shared/powerhub-rbac";
import { storagePutAtKey } from "./storage";
import { supabaseAdmin } from "./supabase-admin";

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
  readingValue: z.string().regex(/^\d+(\.\d{1,3})?$/),
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
};

const toNumber = (value: number | string | null | undefined) => Number(value);
const isoNow = () => new Date().toISOString();

export function hashMobileToken(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function hasFieldAppAccess(role: PowerRole, permissions: readonly PowerCapability[] | null | undefined) {
  return can(role, "recordReadings", permissions) && can(role, "accessFieldApp", permissions);
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

async function resolveMobileScope(userId: number, tenantId: number): Promise<MobileScope | null> {
  const admin = supabaseAdmin();
  const [userResult, membershipResult, tenantResult, profilesResult] = await Promise.all([
    admin.from("users").select("id, name, account_status, must_change_password").eq("id", userId).maybeSingle(),
    admin.from("tenant_members").select("id").eq("user_id", userId).eq("tenant_id", tenantId).eq("is_active", true).eq("membership_status", "active").maybeSingle(),
    admin.from("tenants").select("id, status").eq("id", tenantId).maybeSingle(),
    admin.from("staff_profiles").select("site_id, role, permissions, suspension_started_at, suspension_ends_at").eq("user_id", userId).eq("tenant_id", tenantId).eq("is_active", true),
  ]);
  if (userResult.error || membershipResult.error || tenantResult.error || profilesResult.error) throw new Error("Supabase mobile scope lookup failed");
  const user = userResult.data;
  if (!user || user.account_status !== "active" || user.must_change_password || !membershipResult.data || tenantResult.data?.status !== "active") return null;

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
  const selected = permitted[0];
  return { userId, userName: user.name as string | null, tenantId, branchIds, role: selected.role as PowerRole, permissions: (selected.permissions as string[] | null) ?? null };
}

async function authenticateMobile(req: Request): Promise<{ scope: MobileScope; sessionId: number } | null> {
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
    const scope = await resolveMobileScope(userId, payload.tenantId);
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
  const { data: session, error } = await supabaseAdmin().from("mobile_api_sessions")
    .insert({ user_id: scope.userId, tenant_id: scope.tenantId, refresh_token_hash: hashMobileToken(refreshToken), device_label: deviceLabel, expires_at: expiresAt })
    .select("id")
    .single();
  if (error || !session) throw new Error(error?.message || "Supabase mobile session was not created");
  const sessionId = toNumber(session.id);
  return { accessToken: await issueAccessToken({ userId: scope.userId, tenantId: scope.tenantId, sessionId }), refreshToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS, sessionId };
}

function mobileUserPayload(scope: MobileScope) {
  return { id: scope.userId, name: scope.userName, role: scope.role, tenantId: scope.tenantId, branchIds: scope.branchIds };
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
      const scope = await resolveMobileScope(user.id, tenantId);
      if (!scope) return sendError(res, 403, "MOBILE_ACCESS_DENIED", "لا يملك هذا الحساب صلاحيتي الدخول للتطبيق الميداني وتسجيل القراءات، أو يجب تغيير كلمة المرور المؤقتة أولاً.");
      return res.json({ ...(await createSession(scope, parsed.data.deviceLabel)), user: mobileUserPayload(scope) });
    } catch (profileError) {
      return sendSupabaseError(res, profileError instanceof Error ? profileError : null, "تعذر تهيئة حساب الموبايل.");
    }
  });

  app.post("/api/mobile/v1/auth/refresh", async (req, res) => {
    const parsed = refreshSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, 400, "INVALID_REFRESH_TOKEN", "رمز التجديد غير صالح.");
    try {
      const admin = supabaseAdmin();
      const refreshTokenHash = hashMobileToken(parsed.data.refreshToken);
      const refreshToken = newRefreshToken();
      const { data: rotation, error } = await admin.rpc("powerhub_mobile_rotate_refresh_token", {
        p_refresh_token_hash: refreshTokenHash,
        p_new_refresh_token_hash: hashMobileToken(refreshToken),
      });
      if (error) {
        if (error.message.includes("REFRESH_TOKEN_INVALID")) {
          return sendError(res, 401, "REFRESH_TOKEN_EXPIRED", "انتهت جلسة الموبايل أو تم استهلاك رمز التجديد. سجّل الدخول مجدداً.");
        }
        return sendSupabaseError(res, error);
      }
      const session = Array.isArray(rotation) ? rotation[0] : rotation;
      if (!session?.success || session.session_id === undefined || session.user_id === undefined || session.tenant_id === undefined) {
        return sendError(res, 401, "REFRESH_TOKEN_EXPIRED", "انتهت جلسة الموبايل. سجّل الدخول مجدداً.");
      }
      const scope = await resolveMobileScope(toNumber(session.user_id), toNumber(session.tenant_id));
      if (!scope) return sendError(res, 403, "MOBILE_ACCESS_DENIED", "لا يمكن متابعة جلسة هذا الحساب.");
      return res.json({ accessToken: await issueAccessToken({ userId: scope.userId, tenantId: scope.tenantId, sessionId: toNumber(session.session_id) }), refreshToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS, user: mobileUserPayload(scope) });
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

  app.get("/api/mobile/v1/subscribers", async (req, res) => {
    const context = await authenticateMobile(req);
    if (!context) return sendError(res, 401, "UNAUTHORIZED", "جلسة الموبايل غير صالحة أو منتهية.");
    const parsed = subscriberQuerySchema.safeParse(req.query);
    if (!parsed.success) return sendError(res, 400, "INVALID_QUERY", "بيانات طلب المشتركين غير صالحة.");
    if (!context.scope.branchIds.includes(parsed.data.branchId)) return sendError(res, 403, "BRANCH_ACCESS_DENIED", "لا تملك صلاحية الوصول إلى هذا الفرع.");
    const admin = supabaseAdmin();
    const { data: rows, error } = await admin.from("subscribers").select("id, subscriber_no, full_name, phone, address, site_id")
      .eq("tenant_id", context.scope.tenantId).eq("site_id", parsed.data.branchId).eq("service_status", "active").limit(parsed.data.limit);
    if (error) return sendSupabaseError(res, error);
    try {
      const items = await Promise.all((rows ?? []).map(async (row) => {
        const { data: last, error: lastError } = await admin.from("meter_readings").select("reading_value, reading_at")
          .eq("subscriber_id", row.id).eq("status", "approved").order("reading_at", { ascending: false }).limit(1).maybeSingle();
        if (lastError) throw new Error(lastError.message);
        return { id: toNumber(row.id), subscriberNo: row.subscriber_no, fullName: row.full_name, phone: row.phone, address: row.address, branchId: toNumber(row.site_id), lastReading: last?.reading_value ?? null, lastReadingAt: last?.reading_at ?? null };
      }));
      return res.json({ items, nextCursor: null });
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
        const { data: subscriber, error: subscriberError } = await admin.from("subscribers").select("id")
      .eq("id", input.subscriberId).eq("tenant_id", context.scope.tenantId).eq("site_id", input.branchId).eq("service_status", "active").maybeSingle();
    if (subscriberError) return sendSupabaseError(res, subscriberError);
    if (!subscriber) return sendError(res, 404, "SUBSCRIBER_NOT_FOUND", "المشترك لا يتبع للفرع المحدد أو أن خدمته غير نشطة.");
    const readingAt = new Date(input.readingAt);
    const dayStart = new Date(readingAt); dayStart.setUTCHours(0, 0, 0, 0);
    const nextDay = new Date(dayStart); nextDay.setUTCDate(nextDay.getUTCDate() + 1);
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
      const deterministicImageKey = `subscriber-readings/mobile/${context.scope.tenantId}/${subscriber.id}/${input.clientOperationId}-${imageHash}.${extension}`;\n      try {\n        imageKey = (await storagePutAtKey(deterministicImageKey, imageBytes, input.imageMime)).key;\n      } catch (uploadError) {\n        const message = uploadError instanceof Error ? uploadError.message : String(uploadError);\n        if (!message.toLowerCase().includes("already exists")) throw uploadError;\n        imageKey = deterministicImageKey;\n      }
    }
    const notes = [input.isReadingReset ? "[إعادة ضبط سجل القراءة]" : "", input.fieldVerified ? "[تم التحقق ميدانياً]" : "", input.notes ?? ""].filter(Boolean).join(" ");
    const { data: inserted, error: insertError } = await admin.rpc("powerhub_mobile_create_reading", {
      p_tenant_id: context.scope.tenantId,
      p_site_id: input.branchId,
      p_user_id: context.scope.userId,
      p_subscriber_id: subscriber.id,
      p_client_operation_id: input.clientOperationId,
      p_reading_at: readingAt.toISOString(),
      p_reading_value: input.readingValue,
      p_previous_reading_value: previous?.reading_value ?? null,
      p_consumption_kwh: consumptionKwh,
      p_capture_method: input.captureMethod,
      p_image_key: imageKey ?? null,
      p_image_hash: imageHash ?? null,
      p_notes: notes,
      p_same_day_key: readingAt.toISOString().slice(0, 10),
    });
    if (insertError) {
      if (insertError.message.includes("OPERATION_CONFLICT")) return sendError(res, 409, "OPERATION_CONFLICT", "معرّف العملية مستخدم لعملية قراءة مختلفة.");
      if (insertError.message.includes("READING_ALREADY_EXISTS_TODAY")) return sendError(res, 409, "READING_ALREADY_EXISTS_TODAY", "توجد قراءة غير مرفوضة لهذا المشترك في اليوم نفسه.");
      return sendSupabaseError(res, insertError, "تعذر تسجيل القراءة.");
    }
    const result = Array.isArray(inserted) ? inserted[0] : inserted;
    if (!result?.success || result.reading_id === undefined || typeof result.replayed !== "boolean") {
      return sendError(res, 500, "INVALID_READING_RESULT", "تعذر التحقق من نتيجة تسجيل القراءة.");
    }
    return res.status(result.replayed ? 200 : 201).json({
      id: toNumber(result.reading_id),
      status: result.status,
      consumptionKwh: result.consumption_kwh,
      replayed: result.replayed === true,
    });
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

export const mobileApiSchemas = { login: mobileLoginSchema, refresh: refreshSchema, subscribers: subscriberQuerySchema, reading: readingSchema, syncEvent: syncEventSchema };
