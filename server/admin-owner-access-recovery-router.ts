import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { authenticatedProcedure, router } from "./_core/trpc";
import { z } from "zod";
import { requestOwnerAccessRecovery } from "./request-owner-access-recovery-supabase";

export const adminOwnerAccessRecoveryRouter = router({
  requestOwnerAccessRecovery: authenticatedProcedure
    .input(z.object({ tenantId: z.number().int().positive(), note: z.string().max(2000).optional(), clientOperationId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      if (ctx.user.role !== "admin" || !["platform_owner", "platform_admin"].includes(ctx.user.platformRole ?? "") || ctx.user.accountStatus !== "active") {
        throw new TRPCError({ code: "FORBIDDEN", message: "دور المنصة الحالي لا يملك هذه الصلاحية." });
      }
      return requestOwnerAccessRecovery({
        actorUserId: ctx.user.id,
        tenantId: input.tenantId,
        note: input.note,
      });
    }),
});
