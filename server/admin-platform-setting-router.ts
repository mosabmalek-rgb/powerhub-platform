import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { authenticatedProcedure, router } from "./_core/trpc";
import type { adminRouter } from "./admin";
import { adminRouterWithSupabaseTariffPolicy } from "./admin-tariff-policy-router";
import { savePlatformSetting } from "./platform-setting-supabase";
import { supabaseAdmin } from "./supabase-admin";
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


const listTenantFeatureEntitlementsProcedure = authenticatedProcedure
  .query(async ({ ctx }) => {
    if (ctx.user.role !== "admin" || !["platform_owner", "platform_admin"].includes(ctx.user.platformRole ?? "") || ctx.user.accountStatus !== "active") {
      throw new TRPCError({ code: "FORBIDDEN", message: "دور المنصة الحالي لا يملك هذه الصلاحية." });
    }
    const { data, error } = await supabaseAdmin().from("tenant_feature_entitlements").select("tenant_id,feature_key,is_enabled,activated_at,activated_by_user_id").eq("feature_key", "subscriber_portal_logo");
    if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل إتاحة شعار بوابة الاستعلام." });
    return (data ?? []).map((row) => ({ tenantId: Number(row.tenant_id), featureKey: row.feature_key, isEnabled: Boolean(row.is_enabled), activatedAt: row.activated_at, activatedByUserId: row.activated_by_user_id ? Number(row.activated_by_user_id) : null }));
  });

const setTenantFeatureEntitlementProcedure = authenticatedProcedure
  .input(z.object({ tenantId: z.number().int().positive(), featureKey: z.literal("subscriber_portal_logo"), isEnabled: z.boolean() }))
  .mutation(async ({ ctx, input }) => {
    if (ctx.user.role !== "admin" || !["platform_owner", "platform_admin"].includes(ctx.user.platformRole ?? "") || ctx.user.accountStatus !== "active") {
      throw new TRPCError({ code: "FORBIDDEN", message: "دور المنصة الحالي لا يملك هذه الصلاحية." });
    }
    const { data, error } = await supabaseAdmin().rpc("powerhub_admin_set_tenant_feature_entitlement", {
      p_actor_user_id: ctx.user.id, p_tenant_id: input.tenantId, p_feature_key: input.featureKey, p_is_enabled: input.isEnabled,
    });
    if (error) {
      if (error.message.includes("FEATURE_NOT_INCLUDED_IN_PACKAGE")) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "لا يمكن تفعيل الشعار لأن الباقة الحالية تخفي هذه الميزة." });
      if (error.message.includes("TENANT_NOT_FOUND")) throw new TRPCError({ code: "NOT_FOUND", message: "صاحب المولد غير موجود." });
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحديث إتاحة شعار بوابة الاستعلام." });
    }
    const row = data?.[0];
    return { success: true, tenantId: Number(row?.tenant_id), featureKey: row?.feature_key, isEnabled: Boolean(row?.is_enabled), policy: row?.policy ?? "not_included" };
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
  setTenantFeatureEntitlement: setTenantFeatureEntitlementProcedure,
  listTenantFeatureEntitlements: listTenantFeatureEntitlementsProcedure,
}) as unknown) as typeof adminRouter;
