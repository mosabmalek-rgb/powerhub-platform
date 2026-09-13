import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { authenticatedProcedure, router } from "./_core/trpc";
import { createSmsPlanSupabase, updateSmsPlanSupabase } from "./admin-sms-plan-supabase";

const platformAdminGuard = authenticatedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== "admin" || !["platform_owner", "platform_admin"].includes(ctx.user.platformRole ?? "") || ctx.user.accountStatus !== "active") {
    throw new TRPCError({ code: "FORBIDDEN", message: "دور المنصة الحالي لا يملك هذه الصلاحية." });
  }
  return next({ ctx });
});

export const adminSmsPlanRouter = router({
  createSmsPlan: platformAdminGuard
    .input(z.object({
      code: z.string().trim().min(2).max(80),
      name: z.string().trim().min(2).max(160),
      description: z.string().max(1000).optional(),
      includedMessages: z.number().int().min(0).max(100000000),
      isActive: z.boolean().default(true),
    }))
    .mutation(({ ctx, input }) => createSmsPlanSupabase({ actorUserId: ctx.user.id, ...input })),

  updateSmsPlan: platformAdminGuard
    .input(z.object({
      id: z.number().int().positive(),
      name: z.string().trim().min(2).max(160).optional(),
      description: z.string().max(1000).optional(),
      includedMessages: z.number().int().min(0).max(100000000).optional(),
      isActive: z.boolean().optional(),
    }))
    .mutation(({ ctx, input }) => updateSmsPlanSupabase({ actorUserId: ctx.user.id, ...input })),
});
