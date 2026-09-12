import { TRPCError } from "@trpc/server";
import { router, authenticatedProcedure } from "./_core/trpc";
import { adminRouter } from "./admin";
import { invitePlatformAccess } from "./platform-invitation-supabase";

const platformOwnerInviteProcedure = authenticatedProcedure.input(require("zod").z.object({
  email: require("zod").z.string().email().transform((email: string) => email.trim().toLowerCase()),
  platformRole: require("zod").z.enum(["platform_admin", "finance_admin"]),
  expiresInHours: require("zod").z.number().int().min(1).max(168).default(72),
})).mutation(async ({ ctx, input }: any) => {
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
