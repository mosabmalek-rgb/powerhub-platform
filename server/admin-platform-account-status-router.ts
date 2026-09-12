import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { authenticatedProcedure, router } from "./_core/trpc";
import { adminRouter } from "./admin";
import { adminRouterWithSupabasePlatformAccess } from "./admin-platform-access-router";
import { setPlatformAccountStatus } from "./platform-account-status-supabase";

const platformOwnerSetAccountStatusProcedure = authenticatedProcedure
  .input(z.object({
    userId: z.number().int().positive(),
    accountStatus: z.enum(["active", "locked", "disabled"]),
  }))
  .mutation(async ({ ctx, input }) => {
    if (ctx.user.role !== "admin" || ctx.user.platformRole !== "platform_owner" || ctx.user.accountStatus !== "active") {
      throw new TRPCError({ code: "FORBIDDEN", message: "دور المنصة الحالي لا يملك هذه الصلاحية." });
    }
    return setPlatformAccountStatus({
      actorUserId: ctx.user.id,
      userId: input.userId,
      accountStatus: input.accountStatus,
    });
  });

const legacyProcedures = (adminRouterWithSupabasePlatformAccess as any)._def.procedures as Record<string, unknown>;

export const adminRouterWithSupabasePlatformAccountStatus = router({
  ...legacyProcedures,
  setPlatformAccountStatus: platformOwnerSetAccountStatusProcedure,
}) as typeof adminRouter;
