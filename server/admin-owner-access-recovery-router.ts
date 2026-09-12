import { z } from "zod";
import { authenticatedProcedure, router } from "./_core/trpc";
import { requestOwnerAccessRecovery } from "./request-owner-access-recovery-supabase";

export const adminOwnerAccessRecoveryRouter = router({
  requestOwnerAccessRecovery: authenticatedProcedure
    .input(z.object({ tenantId: z.number().int().positive(), note: z.string().max(2000).optional() }))
    .mutation(async ({ ctx, input }) => {
      if (ctx.user.role !== "admin" || !["platform_owner", "platform_admin"].includes(ctx.user.platformRole ?? "") || ctx.user.accountStatus !== "active") {
        throw new Error("هذه العملية مخصصة لحسابات إدارة المنصة النشطة.");
      }
      return requestOwnerAccessRecovery({
        actorUserId: ctx.user.id,
        tenantId: input.tenantId,
        note: input.note,
      });
    }),
});
