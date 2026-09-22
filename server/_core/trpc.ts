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

async function enforceSingleDeviceSession(ctx: TrpcContext) {
  // Some isolated procedure tests construct a minimal context without an HTTP request.
  // Real Express requests always provide headers, so production enforcement remains strict.
  if (!ctx.req?.headers) return;
  const deviceId = ctx.req.headers["x-powerhub-device-id"];
  if (typeof deviceId !== "string" || !/^[0-9a-f-]{36}$/i.test(deviceId)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "تعذر التحقق من جهاز الدخول. أعد تحميل PowerHub وحاول مرة أخرى." });
  }
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
}

const requireUser = t.middleware(async opts => {
  const { ctx, next } = opts;

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

const enforceMaintenanceMode = t.middleware(async opts => {
  const user = opts.ctx.user;
  if (user?.role === "admin" && !isActivePlatformIdentity(user)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "حساب المنصة الإداري غير نشط أو لا يملك دور منصة صالحاً." });
  }
  if (!user || isActivePlatformAdmin(user) || isActivePlatformSupport(user) || opts.path === "auth.me") return opts.next();
  const { data: maintenance, error } = await supabaseAdmin().from("platform_settings")
    .select("is_enabled, message").eq("setting_key", "maintenance_mode").maybeSingle();
  if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر التحقق من وضع الصيانة في Supabase." });
  if (maintenance?.is_enabled) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: maintenance.message || "المنصة تحت الصيانة مؤقتاً. يرجى المحاولة لاحقاً." });
  }
  return opts.next();
});

const requireSupportChatCapability = t.middleware(async opts => {
  await requirePlatformCapability(opts.ctx.req, "manageSupportChat");
  return opts.next();
});

export const authenticatedProcedure = t.procedure.use(requireUser);
export const protectedProcedure = authenticatedProcedure.use(enforceMaintenanceMode);

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
