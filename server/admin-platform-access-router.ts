import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { authenticatedProcedure, router } from "./_core/trpc";
import { adminRouter } from "./admin";
import { invitePlatformAccess } from "./platform-invitation-supabase";

const platformOwnerInviteProcedure = authenticatedProcedure
  .input(z.object({
    email: z.string().email().transform((email) => email.trim().toLowerCase()),
    platformRole: z.enum(["platform_admin", "finance_admin"]),
    expiresInHours: z.number().int().min(1).max(168).default(72),
  }))
  .mutation(async ({ ctx, input }) => {
    if (ctx.user.role !== "admin" || ctx.user.platformRole !== "platform_owner" || ctx.user.accountStatus !== "active") {
      throw new TRPCError({ code: "FORBIDDEN", message: "دور المنصة الحالي لا يملك هذه الصلاحية." });
    }
    return invitePlatformAccess({
      actorUserId: ctx.user.id,
      email: input.email,
      platformRole: input.platformRole,
      expiresInHours: input.expiresInHours,
    });
  });

const legacyProcedures = (adminRouter as any)._def.procedures as Record<string, unknown>;

export const adminRouterWithSupabasePlatformAccess = router({
  ...legacyProcedures,
  invitePlatformAccess: platformOwnerInviteProcedure,
});
