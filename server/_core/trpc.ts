import { NOT_ADMIN_ERR_MSG, UNAUTHED_ERR_MSG } from '@shared/const';
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { supabaseAdmin } from "../supabase-admin";
import { requirePlatformCapability } from "../platform-capability";
import { isActivePlatformAdmin, isActivePlatformIdentity, isActivePlatformSupport } from "../platform-admin";
import type { TrpcContext } from "./context";
import { z } from "zod";

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
});

export const router = t.router;
export const mergeRouters = t.mergeRouters;
export const publicProcedure = t.procedure;

// A single HTTP request can carry multiple batched tRPC procedures. Keep
// device-claim deduplication strictly request-scoped: never reuse authorization
// decisions across requests, sessions, devices, or warm serverless invocations.
const deviceClaimByRequest = new WeakMap<object, Map<string, Promise<void>>>();

async function enforceSingleDeviceSession(ctx: TrpcContext) {
  // Some isolated procedure tests construct a minimal context without an HTTP request.
  // Real Express requests always provide headers, so production enforcement remains strict.
  if (!ctx.req?.headers) return;
  const deviceId = ctx.req.headers["x-powerhub-device-id"];
  if (typeof deviceId !== "string" || !/^[0-9a-f-]{36}$/i.test(deviceId)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "تعذر التحقق من جهاز الدخول. أعد تحميل PowerHub وحاول مرة أخرى." });
  }

  const request = ctx.req as object;
  let requestClaims = deviceClaimByRequest.get(request);
  if (!requestClaims) {
    requestClaims = new Map<string, Promise<void>>();
    deviceClaimByRequest.set(request, requestClaims);
  }
  const claimKey = `${ctx.user!.openId}:${deviceId}`;
  let claim = requestClaims.get(claimKey);
  if (!claim) {
    claim = (async () => {
      const { data, error } = await supabaseAdmin().rpc("powerhub_claim_user_device", {
        p_user_id: ctx.user!.openId,
        p_device_id: deviceId,
        p_lease_until: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
      });
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر التحقق من جلسة الجهاز." });
      const row = Array.isArray(data) ? data[0] : null;
      if (!row?.allowed) {
        throw new TRPCError({ code: "FORBIDDEN", message: "هذا الحساب مستخدم حاليًا على جهاز آخر. سجّل الخروج من الجهاز الآخر ثم حاول مرة أخرى." });
      }
    })();
    // Keep both success and failure for this request only so a batch cannot fan out
    // repeated device RPCs or produce inconsistent decisions within the same request.
    requestClaims.set(claimKey, claim);
  }
  await claim;
}

const requireUser = t.middleware(async opts => {
  const { ctx, next } = opts;

  if (ctx.authError) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر التحقق من جلسة الدخول مؤقتًا. أعد المحاولة." });
  }
  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  }
  await enforceSingleDeviceSession(ctx);
  if (ctx.user.accountStatus === "locked" || ctx.user.accountStatus === "disabled") {
    throw new TRPCError({ code: "FORBIDDEN", message: ctx.user.accountStatus === "locked" ? "الحساب مقفل مؤقتاً. يرجى التواصل مع إدارة المنصة." : "هذا الحساب معطّل." });
  }
  if (ctx.user.role === "admin" && !isActivePlatformIdentity(ctx.user)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "حساب المنصة الإداري غير نشط أو لا يملك دور منصة صالحاً." });
  }
  if (ctx.user.mustChangePassword && !["auth.me", "auth.updatePassword", "auth.updateProfile", "auth.logout"].includes(opts.path)) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "يجب تغيير كلمة المرور المؤقتة قبل استخدام مساحة التشغيل." });
  }

  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
    },
  });
});

// Reuse the maintenance-mode read only among procedures in the same HTTP
// batch. A new request always re-reads the setting, so administrative changes
// are not hidden by a cross-request cache.
const maintenanceSettingByRequest = new WeakMap<object, Promise<{ is_enabled: boolean; message: string | null } | null>>();

async function readMaintenanceSettingForRequest(ctx: TrpcContext) {
  const request = ctx.req as object | undefined;
  if (!request) {
    const { data, error } = await supabaseAdmin().from("platform_settings")
      .select("is_enabled, message").eq("setting_key", "maintenance_mode").maybeSingle();
    if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر التحقق من وضع الصيانة في Supabase." });
    return data;
  }

  let pending = maintenanceSettingByRequest.get(request);
  if (!pending) {
    pending = (async () => {
      const { data, error } = await supabaseAdmin().from("platform_settings")
        .select("is_enabled, message").eq("setting_key", "maintenance_mode").maybeSingle();
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر التحقق من وضع الصيانة في Supabase." });
      return data;
    })();
    maintenanceSettingByRequest.set(request, pending);
  }
  return pending;
}

const enforceMaintenanceMode = t.middleware(async opts => {
  const user = opts.ctx.user;
  if (user?.role === "admin" && !isActivePlatformIdentity(user)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "حساب المنصة الإداري غير نشط أو لا يملك دور منصة صالحاً." });
  }
  if (!user || isActivePlatformAdmin(user) || isActivePlatformSupport(user) || opts.path === "auth.me") return opts.next();
  const maintenance = await readMaintenanceSettingForRequest(opts.ctx);
  if (maintenance?.is_enabled) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: maintenance.message || "المنصة تحت الصيانة مؤقتاً. يرجى المحاولة لاحقاً." });
  }
  return opts.next();
});

const enforceTenantReadOnlyRetention = t.middleware(async opts => {
  const user = opts.ctx.user;
  if (!user || isActivePlatformAdmin(user) || isActivePlatformSupport(user) || opts.type !== "mutation") return opts.next();

  const input = (opts as typeof opts & { input?: unknown }).input;
  const record = input && typeof input === "object" ? input as Record<string, unknown> : null;
  let tenantId = typeof record?.tenantId === "number" ? record.tenantId : null;
  const siteId = typeof record?.siteId === "number" ? record.siteId : null;

  if (!tenantId && siteId) {
    const { data: site, error: siteError } = await supabaseAdmin()
      .from("sites").select("tenant_id").eq("id", siteId).maybeSingle();
    if (siteError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر التحقق من مساحة صاحب المولد." });
    tenantId = site?.tenant_id ? Number(site.tenant_id) : null;
  }

  if (!tenantId) {
    const { data: memberships, error: membershipError } = await supabaseAdmin()
      .from("tenant_members")
      .select("tenant_id")
      .eq("user_id", user.id)
      .eq("is_active", true)
      .eq("membership_status", "active")
      .limit(10);
    if (membershipError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر التحقق من مساحة صاحب المولد." });
    if (memberships?.length === 1) tenantId = Number(memberships[0].tenant_id);
  }

  if (!tenantId) throw new TRPCError({ code: "FORBIDDEN", message: "تعذر تحديد مساحة صاحب المولد للتحقق من حالة الاشتراك." });

  const { data: subscription, error: subscriptionError } = await supabaseAdmin()
    .from("tenant_subscriptions")
    .select("status,read_only_until")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (subscriptionError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر التحقق من حالة الاشتراك." });

  if (subscription?.status === "cancelled" && subscription.read_only_until && new Date(subscription.read_only_until) > new Date()) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `الحساب في فترة احتفاظ للقراءة فقط حتى ${new Date(subscription.read_only_until).toLocaleString("ar-PS")}.`,
    });
  }

  return opts.next();
});

const requireSupportChatCapability = t.middleware(async opts => {
  await requirePlatformCapability(opts.ctx.req, "manageSupportChat");
  return opts.next();
});

export const authenticatedProcedure = t.procedure.use(requireUser);
export const protectedProcedure = authenticatedProcedure.use(enforceMaintenanceMode).use(enforceTenantReadOnlyRetention);

/**
 * Dedicated authorization boundary for PowerHub Support Center / Chat.
 *
 * IMPORTANT: Do not replace this with adminProcedure, tenant RBAC,
 * manageMessaging, or a users.role-based check. The capability resolver
 * derives identity from the authenticated Supabase token and applies the
 * explicit platform-scoped policy.
 */
export const platformSupportProcedure = authenticatedProcedure.use(
  requireSupportChatCapability,
);

export const adminProcedure = t.procedure.use(
  t.middleware(async opts => {
    const { ctx, next } = opts;

    if (ctx.authError) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر التحقق من جلسة الدخول مؤقتًا. أعد المحاولة." });
    }
    if (!isActivePlatformAdmin(ctx.user)) {
      throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
    }

    return next({
      ctx: {
        ...ctx,
        user: ctx.user,
      },
    });
  }),
);
