import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { authenticatedProcedure, router } from "./_core/trpc";
import { adminRouter } from "./admin";
import { adminRouterWithSupabasePlatformAccess } from "./admin-platform-access-router";
import { setPlatformAccessRole } from "./platform-access-role-supabase";

const platformOwnerSetAccessRoleProcedure = authenticatedProcedure
  .input(z.object({
    userId: z.number().int().positive(),
    platformRole: z.enum(["platform_admin", "finance_admin"]),
  }))
  .mutation(async ({ ctx, input }) => {
    if (ctx.user.role !== "admin" || ctx.user.platformRole !== "platform_owner" || ctx.user.accountStatus !== "active") {
      throw new TRPCError({ code: "FORBIDDEN", message: "دور المنصة الحالي لا يملك هذه الصلاحية." });
    }
    return setPlatformAccessRole({
      actorUserId: ctx.user.id,
      userId: input.userId,
      platformRole: input.platformRole,
    });
  });

const legacyRecord = (adminRouterWithSupabasePlatformAccess as any)._def.record as Record<string, unknown>;

export const adminRouterWithSupabasePlatformAccessRole = (router({
  ...legacyRecord,
  setPlatformAccessRole: platformOwnerSetAccessRoleProcedure,
}) as unknown) as typeof adminRouter;
