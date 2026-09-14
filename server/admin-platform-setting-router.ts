import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { authenticatedProcedure, router } from "./_core/trpc";
import type { adminRouter } from "./admin";
import { adminRouterWithSupabaseTariffPolicy } from "./admin-tariff-policy-router";
import { savePlatformSetting } from "./platform-setting-supabase";
import { adminOwnerAccessRecoveryRouter } from "./admin-owner-access-recovery-router";
import { adminRolePolicyRouter } from "./admin-role-policy-router";
import { adminRouterWithSupabasePlatformAccess } from "./admin-platform-access-router";
import { adminTenantAccessRouter } from "./admin-tenant-access-router";
import { adminSmsPlanRouter } from "./admin-sms-plan-router";
import { adminRouterWithSupabaseTenantBranchSettings } from "./admin-tenant-branch-settings-router";

const platformAdminSavePlatformSettingProcedure = authenticatedProcedure
  .input(z.object({
    settingKey: z.string().min(2).max(100),
    isEnabled: z.boolean(),
    message: z.string().max(4000).optional(),
    value: z.record(z.string(), z.unknown()).optional(),
  }))
  .mutation(async ({ ctx, input }) => {
    if (ctx.user.role !== "admin" || !["platform_owner", "platform_admin"].includes(ctx.user.platformRole ?? "") || ctx.user.accountStatus !== "active") {
      throw new TRPCError({ code: "FORBIDDEN", message: "دور المنصة الحالي لا يملك هذه الصلاحية." });
    }
    return savePlatformSetting({
      actorUserId: ctx.user.id,
      settingKey: input.settingKey,
      isEnabled: input.isEnabled,
      message: input.message,
      value: input.value,
    });
  });

const legacyRecord = { ...((adminRouterWithSupabaseTariffPolicy as any)._def.record as Record<string, unknown>) };
delete legacyRecord.saveRolePolicy;
const recoveryRecord = (adminOwnerAccessRecoveryRouter as any)._def.record as Record<string, unknown>;
const rolePolicyRecord = (adminRolePolicyRouter as any)._def.record as Record<string, unknown>;
const platformAccessRecord = (adminRouterWithSupabasePlatformAccess as any)._def.record as Record<string, unknown>;
const tenantAccessRecord = (adminTenantAccessRouter as any)._def.record as Record<string, unknown>;
const smsPlanRecord = (adminSmsPlanRouter as any)._def.record as Record<string, unknown>;
const tenantBranchRecord = (adminRouterWithSupabaseTenantBranchSettings as any)._def.record as Record<string, unknown>;

export const adminRouterWithSupabasePlatformSetting = (router({
  ...legacyRecord,
  ...recoveryRecord,
  ...rolePolicyRecord,
  ...platformAccessRecord,
  ...tenantAccessRecord,
  ...smsPlanRecord,
  ...tenantBranchRecord,
  savePlatformSetting: platformAdminSavePlatformSettingProcedure,
}) as unknown) as typeof adminRouter;
