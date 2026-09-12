import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { authenticatedProcedure } from "./_core/trpc";
import { adminRouter } from "./admin";
import { supabaseAdmin } from "./supabase-admin";

const saveTenantBranchSettingsProcedure = authenticatedProcedure
  .input(z.object({
    tenantId: z.number().int().positive(),
    isEnabledOverride: z.boolean().nullable(),
    maxBranchesOverride: z.number().int().min(1).max(1000).nullable(),
    disabledBehavior: z.enum(["read_only", "suspended"]).default("read_only"),
  }))
  .mutation(async ({ ctx, input }) => {
    if (ctx.user.role !== "admin" || !["platform_owner", "platform_admin"].includes(ctx.user.platformRole ?? "") || ctx.user.accountStatus !== "active") {
      throw new TRPCError({ code: "FORBIDDEN", message: "دور المنصة الحالي لا يملك هذه الصلاحية." });
    }
    const { data, error } = await supabaseAdmin().rpc("powerhub_admin_save_tenant_branch_settings", {
      p_actor_user_id: ctx.user.id,
      p_tenant_id: input.tenantId,
      p_is_enabled_override: input.isEnabledOverride,
      p_max_branches_override: input.maxBranchesOverride,
      p_disabled_behavior: input.disabledBehavior,
    });
    if (error || !data?.[0]) {
      const message = error?.message ?? "تعذر حفظ إعدادات الأفرع في Supabase.";
      if (message.includes("TENANT_NOT_FOUND")) throw new TRPCError({ code: "NOT_FOUND", message: "صاحب المولد غير موجود." });
      if (message.includes("INVALID_DISABLED_BEHAVIOR") || message.includes("INVALID_MAX_BRANCHES")) throw new TRPCError({ code: "BAD_REQUEST", message: "إعدادات الأفرع غير صالحة." });
      if (message.includes("PLATFORM_ADMIN_FORBIDDEN")) throw new TRPCError({ code: "FORBIDDEN", message: "دور المنصة الحالي لا يملك هذه الصلاحية." });
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر حفظ إعدادات الأفرع في Supabase." });
    }
    return { success: true } as const;
  });

const legacyProcedures = (adminRouter as any)._def.procedures as Record<string, unknown>;

export const adminRouterWithSupabaseTenantBranchSettings = (Object.assign({}, legacyProcedures, {
  saveTenantBranchSettings: saveTenantBranchSettingsProcedure,
}) as unknown) as typeof adminRouter;
