import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { authenticatedProcedure, router } from "./_core/trpc";
import { adminRouter } from "./admin";
import { adminRouterWithSupabasePlatformAccessRole } from "./admin-platform-access-role-router";
import { createTariffPolicy } from "./tariff-policy-supabase";

const platformAdminCreateTariffPolicyProcedure = authenticatedProcedure
  .input(z.object({
    minimumPricePerKwh: z.number().nonnegative(),
    maximumPricePerKwh: z.number().positive(),
    effectiveFrom: z.date(),
    notificationRequested: z.boolean().default(false),
    notes: z.string().max(2000).optional(),
  }).refine((input) => input.maximumPricePerKwh >= input.minimumPricePerKwh, {
    message: "الحد الأقصى يجب أن يساوي أو يتجاوز الحد الأدنى.",
    path: ["maximumPricePerKwh"],
  }))
  .mutation(async ({ ctx, input }) => {
    if (ctx.user.role !== "admin" || !["platform_owner", "platform_admin"].includes(ctx.user.platformRole ?? "") || ctx.user.accountStatus !== "active") {
      throw new TRPCError({ code: "FORBIDDEN", message: "دور المنصة الحالي لا يملك هذه الصلاحية." });
    }
    return createTariffPolicy({
      actorUserId: ctx.user.id,
      minimumPricePerKwh: input.minimumPricePerKwh,
      maximumPricePerKwh: input.maximumPricePerKwh,
      effectiveFrom: input.effectiveFrom,
      notificationRequested: input.notificationRequested,
      notes: input.notes,
    });
  });

const legacyProcedures = (adminRouterWithSupabasePlatformAccessRole as any)._def.procedures as Record<string, unknown>;

export const adminRouterWithSupabaseTariffPolicy = (router({
  ...legacyProcedures,
  createTariffPolicy: platformAdminCreateTariffPolicyProcedure,
}) as unknown) as typeof adminRouter;
