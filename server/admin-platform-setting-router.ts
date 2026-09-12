import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { authenticatedProcedure, router } from "./_core/trpc";
import { adminRouter } from "./admin";
import { adminRouterWithSupabaseTariffPolicy } from "./admin-tariff-policy-router";
import { savePlatformSetting } from "./platform-setting-supabase";

const platformAdminSavePlatformSettingProcedure = authenticatedProcedure
  .input(z.object({
    settingKey: z.string().min(2).max(100),
    isEnabled: z.boolean(),
    message: z.string().max(4000).optional(),
    value: z.record(z.string(), z.unknown()).optional(),
  }))
  .mutation(async ({ ctx, input }) => {
    if (ctx.user.role !== "admin" || !["platform_owner", "platform_admin"].includes(ctx.user.platformRole ?? "") || ctx.user.accountStatus !== "active") {
      throw new TRPCError({ code: "FORBIDDEN", message: "دور المنصة الحالي لا يملك هذه الصلاحية." });
    }
    return savePlatformSetting({
      actorUserId: ctx.user.id,
      settingKey: input.settingKey,
      isEnabled: input.isEnabled,
      message: input.message,
      value: input.value,
    });
  });

const legacyProcedures = (adminRouterWithSupabaseTariffPolicy as any)._def.procedures as Record<string, unknown>;

export const adminRouterWithSupabasePlatformSetting = (router({
  ...legacyProcedures,
  savePlatformSetting: platformAdminSavePlatformSettingProcedure,
}) as unknown) as typeof adminRouter;
