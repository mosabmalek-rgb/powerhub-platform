import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { systemRouter } from "./_core/systemRouter";
import { authenticatedProcedure, publicProcedure, mergeRouters, router } from "./_core/trpc";
import { powerhubRuntimeRouter } from "./powerhub-runtime-router";
import { powerhubDashboardRouter } from "./powerhub-dashboard";
import { adminRouterWithSupabasePlatformSetting } from "./admin-platform-setting-router";
import { adminRolePolicyRouter } from "./admin-role-policy-router";
import { supabaseAdmin } from "./supabase-admin";
import { claimPowerHubDevice } from "./auth-device-claim";
import { supportRouter } from "./support-router";
import { aiSupportRouter } from "./ai-support-router";
import { platformAnnouncementsRouter } from "./platform-announcements-router";
import { adminFeatureControlsRouter } from "./admin-feature-controls-router";

const adminRuntimeRouter = router({
  ...adminRouterWithSupabasePlatformSetting._def.record,
  resetUserPassword: adminRouterWithSupabasePlatformSetting.resetUserPassword,
  ...adminRolePolicyRouter._def.record,
  ...adminFeatureControlsRouter._def.record,
});

const powerhubAppRouter = mergeRouters(powerhubRuntimeRouter, router({ performance: powerhubDashboardRouter }));

const platformContactSettingsRouter = router({
  public: publicProcedure.query(async () => {
    const { data, error } = await supabaseAdmin().from("platform_settings").select("is_enabled,value").eq("setting_key","platform_contact").maybeSingle();
    if (error || !data?.is_enabled || !data.value || typeof data.value !== "object" || Array.isArray(data.value)) return { whatsappNumber: null as string | null };
    const value = data.value as Record<string, unknown>;
    return { whatsappNumber: typeof value.whatsappNumber === "string" ? value.whatsappNumber : null };
  }),
});

export const appRouter = router({
  platformContactSettings: platformContactSettingsRouter,
  system: systemRouter,
  auth: router({
    claimDevice: publicProcedure.input(z.object({ deviceId: z.string().uuid() })).mutation(async ({ ctx, input }) => {
      if (ctx.authError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر التحقق من جلسة الدخول مؤقتًا. أعد المحاولة." });
      if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED", message: "يجب تسجيل الدخول أولاً." });
      await claimPowerHubDevice({
        operation: "auth.claimDevice",
        userId: ctx.user.openId,
        deviceId: input.deviceId,
        rpcErrorMessage: "تعذر تثبيت جهاز الدخول.",
        timeoutMessage: "انتهت مهلة تثبيت جهاز الدخول. أعد المحاولة.",
      });
      return { allowed: true } as const;
    }),
    releaseDevice: authenticatedProcedure.mutation(async ({ ctx }) => {
      const deviceId = ctx.req.headers["x-powerhub-device-id"];
      if (typeof deviceId !== "string" || !z.string().uuid().safeParse(deviceId).success) return { released: false } as const;
      const { data, error } = await supabaseAdmin().rpc("powerhub_release_user_device", {
        p_user_id: ctx.user.openId,
        p_device_id: deviceId,
      });
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحرير جهاز الدخول." });
      return { released: Boolean(data) } as const;
    }),

    me: publicProcedure.query(async ({ ctx }) => {
      if (ctx.authError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر التحقق من جلسة الدخول مؤقتًا. أعد المحاولة." });
      if (!ctx.user) return null;
      const deviceId = ctx.req.headers["x-powerhub-device-id"];
      if (typeof deviceId !== "string" || !z.string().uuid().safeParse(deviceId).success) {
        throw new TRPCError({ code: "FORBIDDEN", message: "تعذر التحقق من جهاز الدخول." });
      }
      await claimPowerHubDevice({
        operation: "auth.me",
        userId: ctx.user.openId,
        deviceId,
        rpcErrorMessage: "تعذر التحقق من جلسة الجهاز.",
        timeoutMessage: "انتهت مهلة التحقق من جلسة الجهاز. أعد المحاولة.",
      });
      return ctx.user;
    }),
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
  powerhub: powerhubAppRouter,
  support: supportRouter,
  aiSupport: aiSupportRouter,
  platformAnnouncements: platformAnnouncementsRouter,
  admin: adminRuntimeRouter,
});

export type AppRouter = Omit<typeof appRouter, "admin"> & { admin: typeof adminRuntimeRouter };
