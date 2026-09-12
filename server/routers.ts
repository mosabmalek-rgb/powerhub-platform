import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { z } from "zod";
import { systemRouter } from "./_core/systemRouter";
import { authenticatedProcedure, publicProcedure, mergeRouters, router } from "./_core/trpc";
import { powerhubRuntimeRouter } from "./powerhub-runtime-router";
import { powerhubDashboardRouter } from "./powerhub-dashboard";
import { adminRouterWithSupabasePlatformSetting as baseAdminRouterWithSupabasePlatformSetting } from "./admin-platform-setting-router";
import { adminRolePolicyRouter } from "./admin-role-policy-router";
import { adminRouter } from "./admin";
import { supabaseAdmin } from "./supabase-admin";

const adminRuntimeRecord = {
  ...((baseAdminRouterWithSupabasePlatformSetting as any)._def.record as Record<string, unknown>),
};
delete adminRuntimeRecord.saveRolePolicy;
Object.assign(adminRuntimeRecord, (adminRolePolicyRouter as any)._def.record as Record<string, unknown>);

const adminRouterWithSupabasePlatformSetting = (router(adminRuntimeRecord as Record<string, any>) as unknown) as typeof adminRouter;

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
    updateProfile: authenticatedProcedure.input(z.object({ name: z.string().min(2).max(180) })).mutation(async ({ ctx, input }) => {
      const { error } = await supabaseAdmin().from("users").update({ name: input.name.trim() }).eq("id", ctx.user.id);
      if (error) throw new Error("تعذر تحديث الملف الشخصي في Supabase.");
      return { success: true } as const;
    }),
    updatePassword: authenticatedProcedure.input(z.object({ password: z.string().min(8).max(128) })).mutation(async ({ ctx, input }) => {
      const { error } = await supabaseAdmin().auth.admin.updateUserById(ctx.user.openId, { password: input.password });
      if (error) throw new Error("تعذر تحديث كلمة المرور في Supabase.");
      const { error: profileError } = await supabaseAdmin().from("users").update({ must_change_password: false, temporary_password_issued_at: null }).eq("id", ctx.user.id);
      if (profileError) throw new Error("تم تغيير كلمة المرور لكن تعذر تحديث حالة الحساب.");
      return { success: true } as const;
    }),
  }),
  powerhub: mergeRouters(powerhubRuntimeRouter, router({ performance: powerhubDashboardRouter })),
  admin: adminRouterWithSupabasePlatformSetting,
});

export type AppRouter = typeof appRouter;
