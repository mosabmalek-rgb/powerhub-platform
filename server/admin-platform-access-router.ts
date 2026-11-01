import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { authenticatedProcedure, router } from "./_core/trpc";
import { adminRouter } from "./admin";
import { invitePlatformAccessSupabase, setPlatformAccessRoleSupabase, setPlatformAccountStatusSupabase } from "./admin-platform-access-supabase";

function assertPlatformOwner(ctx: { user: { role: "user" | "admin"; platformRole: string | null; accountStatus: string } }) {
  if (ctx.user.role !== "admin" || ctx.user.platformRole !== "platform_owner" || ctx.user.accountStatus !== "active") {
    throw new TRPCError({ code: "FORBIDDEN", message: "دور المنصة الحالي لا يملك هذه الصلاحية." });
  }
}

const legacyRecord = (adminRouter as any)._def.record as Record<string, unknown>;

export const adminRouterWithSupabasePlatformAccess = router({
  ...legacyRecord,
  invitePlatformAccess: authenticatedProcedure.input(z.object({
    email: z.string().email().transform((email) => email.trim().toLowerCase()),
    platformRole: z.enum(["platform_admin", "finance_admin", "platform_support"]),
    expiresInHours: z.number().int().min(1).max(168).default(72),
    clientOperationId: z.string().uuid(),
  })).mutation(async ({ ctx, input }) => {
    assertPlatformOwner(ctx);
    return invitePlatformAccessSupabase({ actorUserId: ctx.user.id, ...input });
  }),
  setPlatformAccountStatus: authenticatedProcedure.input(z.object({
    userId: z.number().int().positive(), status: z.enum(["active", "locked", "disabled"]),
  })).mutation(async ({ ctx, input }) => {
    assertPlatformOwner(ctx);
    return setPlatformAccountStatusSupabase({ actorUserId: ctx.user.id, userId: input.userId, accountStatus: input.status });
  }),
  setPlatformAccessRole: authenticatedProcedure.input(z.object({
    userId: z.number().int().positive(), platformRole: z.enum(["platform_admin", "finance_admin", "platform_support"]),
  })).mutation(async ({ ctx, input }) => {
    assertPlatformOwner(ctx);
    return setPlatformAccessRoleSupabase({ actorUserId: ctx.user.id, ...input });
  }),
});
