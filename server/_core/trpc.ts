import { NOT_ADMIN_ERR_MSG, UNAUTHED_ERR_MSG } from '@shared/const';
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { supabaseAdmin } from "../supabase-admin";
import type { TrpcContext } from "./context";

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
});

export const router = t.router;
export const mergeRouters = t.mergeRouters;
export const publicProcedure = t.procedure;

const requireUser = t.middleware(async opts => {
  const { ctx, next } = opts;

  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  }
  if (ctx.user.accountStatus === "locked" || ctx.user.accountStatus === "disabled") {
    throw new TRPCError({ code: "FORBIDDEN", message: ctx.user.accountStatus === "locked" ? "الحساب مقفل مؤقتاً. يرجى التواصل مع إدارة المنصة." : "هذا الحساب معطّل." });
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
  if (!user || user.role === "admin" || opts.path === "auth.me") return opts.next();
  const { data: maintenance, error } = await supabaseAdmin().from("platform_settings")
    .select("is_enabled, message").eq("setting_key", "maintenance_mode").maybeSingle();
  if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر التحقق من وضع الصيانة في Supabase." });
  if (maintenance?.is_enabled) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: maintenance.message || "المنصة تحت الصيانة مؤقتاً. يرجى المحاولة لاحقاً." });
  }
  return opts.next();
});

export const authenticatedProcedure = t.procedure.use(requireUser);
export const protectedProcedure = authenticatedProcedure.use(enforceMaintenanceMode);

export const adminProcedure = t.procedure.use(
  t.middleware(async opts => {
    const { ctx, next } = opts;

    if (!ctx.user || ctx.user.role !== 'admin') {
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