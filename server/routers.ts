import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { z } from "zod";
import { systemRouter } from "./_core/systemRouter";
import { authenticatedProcedure, publicProcedure, router } from "./_core/trpc";
import { powerhubRouter } from "./powerhub";
import { powerhubDashboardRouter } from "./powerhub-dashboard";
import { adminRouter } from "./admin";
import { supabaseAdmin } from "./supabase-admin";

export const appRouter = router({
    // if you need to use socket.io, read and register route in server/_core/index.ts, all api should start with '/api/' so that the gateway can route correctly
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return {
        success: true,
      } as const;
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
  powerhub: powerhubRouter.merge("performance", powerhubDashboardRouter),
  admin: adminRouter,

  // TODO: add feature routers here, e.g.
  // todo: router({
  //   list: protectedProcedure.query(({ ctx }) =>
  //     db.getUserTodos(ctx.user.id)
  //   ),
  // }),
});

export type AppRouter = typeof appRouter;
