import crypto from "node:crypto";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { authenticatedProcedure, router } from "./_core/trpc";
import { inviteTenantAccess } from "./invite-tenant-access-supabase";

export const adminTenantAccessRouter = router({
  inviteTenantAccess: authenticatedProcedure
    .input(z.object({
      tenantId: z.number().int().positive(),
      siteId: z.number().int().positive().optional(),
      email: z.string().email().transform((email) => email.trim().toLowerCase()),
      tenantRole: z.enum(["owner", "admin", "member"]),
      siteRole: z.enum(["owner", "manager", "accountant", "collector", "technician", "viewer"]).optional(),
      expiresInHours: z.number().int().min(1).max(168).default(72),
      clientOperationId: z.string().uuid(),
    }))
    .mutation(async ({ ctx, input }) => {
      if (ctx.user.role !== "admin" || !["platform_owner", "platform_admin"].includes(ctx.user.platformRole ?? "") || ctx.user.accountStatus !== "active") {
        throw new TRPCError({ code: "FORBIDDEN", message: "دور المنصة الحالي لا يملك هذه الصلاحية." });
      }
      const expiresAt = new Date(Date.now() + input.expiresInHours * 60 * 60 * 1000);
      const tokenHash = crypto.createHash("sha256").update(crypto.randomBytes(32)).digest("hex");
      return inviteTenantAccess({
        actorUserId: ctx.user.id,
        tenantId: input.tenantId,
        siteId: input.siteId,
        email: input.email,
        tenantRole: input.tenantRole,
        siteRole: input.tenantRole === "owner" ? "owner" : input.siteRole,
        tokenHash,
        expiresAt,
        expiresInHours: input.expiresInHours,
        clientOperationId: input.clientOperationId,
      });
    }),
});
