import crypto from "node:crypto";
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

const resetUserPasswordProcedure = authenticatedProcedure
  .input(z.object({ userId: z.number().int().positive() }))
  .mutation(async ({ ctx, input }) => {
    if (ctx.user.role !== "admin" || !["platform_owner", "platform_admin"].includes(ctx.user.platformRole ?? "") || ctx.user.accountStatus !== "active") {
      throw new TRPCError({ code: "FORBIDDEN", message: "لا تملك صلاحية إعادة تعيين كلمات المرور." });
    }
    if (ctx.user.id === input.userId) throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكن استخدام هذا الإجراء لإعادة تعيين كلمة مرور حسابك الإداري." });

    const admin = supabaseAdmin();
    const { data: target, error: targetError } = await admin.from("users")
      .select("id,auth_user_id,name,email,role,platform_role,account_status,must_change_password,temporary_password_issued_at")
      .eq("id", input.userId).maybeSingle();
    if (targetError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر التحقق من الحساب المستهدف." });
    if (!target) throw new TRPCError({ code: "NOT_FOUND", message: "المستخدم غير موجود." });
    if (target.role === "admin" && target.platform_role === "platform_owner") throw new TRPCError({ code: "FORBIDDEN", message: "حساب مالك المنصة محمي ولا يمكن إعادة تعيينه من هذا الإجراء." });
    if (!target.auth_user_id) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "هذا الحساب غير مرتبط بمستخدم في Supabase Auth." });

    const occurredAt = new Date().toISOString();
    const targetRole = target.platform_role ?? target.role;
    const { data: auditEvent, error: auditStartError } = await admin.from("platform_security_events").insert({
      event_type: "security_change", severity: "warning", status: "open",
      title: "إعادة تعيين كلمة مرور مستخدم من إدارة المنصة",
      details: "بدأ آدمن المنصة إعادة تعيين كلمة المرور. لا تُحفظ كلمة المرور المؤقتة في سجل التدقيق.",
      created_by_user_id: ctx.user.id, related_user_id: input.userId,
      metadata: { event: "platform_admin_password_reset", scope: "platform", actorUserId: ctx.user.id, targetUserId: input.userId, targetRole, targetEmail: target.email ?? null, outcome: "started", occurredAt },
    }).select("id").single();
    if (auditStartError || !auditEvent) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر إنشاء سجل التدقيق؛ لم تتغير كلمة المرور." });

    const finishAudit = async (status: "success" | "failed", outcome: string, details: string) => {
      const { error } = await admin.from("platform_security_events").update({
        status, severity: status === "success" ? "warning" : "critical", details,
        metadata: { event: "platform_admin_password_reset", scope: "platform", actorUserId: ctx.user.id, targetUserId: input.userId, targetRole, targetEmail: target.email ?? null, outcome, occurredAt, updatedAt: new Date().toISOString(), temporaryPasswordStored: false },
      }).eq("id", auditEvent.id);
      return !error;
    };

    const issuedAt = new Date().toISOString();
    const { data: flagged, error: flagError } = await admin.from("users").update({
      must_change_password: true, temporary_password_issued_at: issuedAt, updated_at: issuedAt,
    }).eq("id", input.userId).select("id").maybeSingle();
    if (flagError || !flagged) {
      await finishAudit("failed", "profile_flag_failed", "تعذر تعيين إلزام تغيير كلمة المرور في سجل المستخدم؛ لم تتغير كلمة مرور المصادقة.");
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تجهيز الحساب لإلزام تغيير كلمة المرور؛ لم تتغير كلمة المرور الحالية." });
    }

    const { data: authResult, error: authReadError } = await admin.auth.admin.getUserById(target.auth_user_id);
    if (authReadError || !authResult.user) {
      await admin.from("users").update({ must_change_password: target.must_change_password ?? false, temporary_password_issued_at: target.temporary_password_issued_at ?? null, updated_at: new Date().toISOString() }).eq("id", input.userId);
      await finishAudit("failed", "auth_user_not_found", "تعذر العثور على حساب المصادقة؛ لم يتم تغيير كلمة المرور.");
      throw new TRPCError({ code: "NOT_FOUND", message: "تعذر العثور على حساب المصادقة المرتبط بالمستخدم؛ لم تتغير كلمة المرور." });
    }

    const temporaryPassword = `Ph!${crypto.randomBytes(12).toString("base64url")}`;
    const { error: authError } = await admin.auth.admin.updateUserById(target.auth_user_id, {
      password: temporaryPassword,
      user_metadata: { ...(authResult.user.user_metadata ?? {}), must_change_password: true },
    });
    if (authError) {
      await admin.from("users").update({ must_change_password: target.must_change_password ?? false, temporary_password_issued_at: target.temporary_password_issued_at ?? null, updated_at: new Date().toISOString() }).eq("id", input.userId);
      await finishAudit("failed", "auth_password_update_failed", "رفض مزود المصادقة تغيير كلمة المرور؛ تمت استعادة علامات ملف المستخدم السابقة.");
      throw new TRPCError({ code: "BAD_REQUEST", message: "تعذر تحديث كلمة المرور في خدمة المصادقة." });
    }

    const auditRecorded = await finishAudit("success", "completed", "أُعيد تعيين كلمة المرور بنجاح وأُلزم المستخدم بتغييرها عند الدخول التالي. لم تُحفظ كلمة المرور المؤقتة في سجل التدقيق.");
    return { success: true as const, userId: Number(target.id), userName: target.name ?? target.email ?? "المستخدم", temporaryPassword, auditRecorded };
  });

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


const sendOwnerUsageAlertProcedure = authenticatedProcedure
  .input(z.object({
    tenantId: z.number().int().positive(),
    usagePercent: z.number().int().min(0).max(1000),
    message: z.string().trim().min(5).max(1200),
  }))
  .mutation(async ({ ctx, input }) => {
    if (ctx.user.role !== "admin" || !["platform_owner", "platform_admin"].includes(ctx.user.platformRole ?? "") || ctx.user.accountStatus !== "active") {
      throw new TRPCError({ code: "FORBIDDEN", message: "دور المنصة الحالي لا يملك هذه الصلاحية." });
    }
    const admin = supabaseAdmin();
    const { data: tenant, error: tenantError } = await admin.from("tenants").select("id,name").eq("id", input.tenantId).maybeSingle();
    if (tenantError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر التحقق من مساحة صاحب المولد." });
    if (!tenant) throw new TRPCError({ code: "NOT_FOUND", message: "مساحة صاحب المولد غير موجودة." });
    const title = input.usagePercent >= 100 ? "تنبيه: تم بلوغ حد الباقة" : "تنبيه: ارتفاع استهلاك الباقة";
    const { data, error } = await admin.from("platform_announcements").insert({
      tenant_id: input.tenantId,
      title,
      body: input.message,
      announcement_type: "alert",
      status: "published",
      published_at: new Date().toISOString(),
      scheduled_at: null,
      audience_roles: ["owner"],
      created_by_user_id: ctx.user.id,
      updated_by_user_id: ctx.user.id,
    }).select("id,title,body,status,published_at,created_at").single();
    if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر إرسال تنبيه صاحب المولد." });
    const { data: auditSite } = await admin.from("sites").select("id").eq("tenant_id", input.tenantId).order("id", { ascending: true }).limit(1).maybeSingle();
    if (auditSite?.id) await admin.from("audit_logs").insert({
      tenant_id: input.tenantId,
      site_id: Number(auditSite.id),
      user_id: ctx.user.id,
      entity_type: "platform_announcement",
      entity_id: String(data.id),
      action: "owner_usage_alert_sent",
      metadata: { usagePercent: input.usagePercent, tenantName: tenant.name },
    });
    return { success: true as const, announcementId: Number(data.id) };
  });

const listTenantFeatureEntitlementsProcedure = authenticatedProcedure
  .query(async ({ ctx }) => {
    if (ctx.user.role !== "admin" || !["platform_owner", "platform_admin"].includes(ctx.user.platformRole ?? "") || ctx.user.accountStatus !== "active") {
      throw new TRPCError({ code: "FORBIDDEN", message: "دور المنصة الحالي لا يملك هذه الصلاحية." });
    }
    const { data, error } = await supabaseAdmin().from("tenant_feature_entitlements").select("tenant_id,feature_key,is_enabled,activated_at,activated_by_user_id").in("feature_key", ["subscriber_portal_logo", "payment_documentation"]);
    if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل إتاحة الميزات لأصحاب المولدات." });
    return (data ?? []).map((row) => ({ tenantId: Number(row.tenant_id), featureKey: row.feature_key, isEnabled: Boolean(row.is_enabled), activatedAt: row.activated_at, activatedByUserId: row.activated_by_user_id ? Number(row.activated_by_user_id) : null }));
  });

const setTenantFeatureEntitlementProcedure = authenticatedProcedure
  .input(z.object({ tenantId: z.number().int().positive(), featureKey: z.enum(["subscriber_portal_logo", "payment_documentation"]), isEnabled: z.boolean() }))
  .mutation(async ({ ctx, input }) => {
    if (ctx.user.role !== "admin" || !["platform_owner", "platform_admin"].includes(ctx.user.platformRole ?? "") || ctx.user.accountStatus !== "active") {
      throw new TRPCError({ code: "FORBIDDEN", message: "دور المنصة الحالي لا يملك هذه الصلاحية." });
    }
    const { data, error } = await supabaseAdmin().rpc("powerhub_admin_set_tenant_feature_entitlement", {
      p_actor_user_id: ctx.user.id, p_tenant_id: input.tenantId, p_feature_key: input.featureKey, p_is_enabled: input.isEnabled,
    });
    if (error) {
      if (error.message.includes("FEATURE_NOT_INCLUDED_IN_PACKAGE")) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "لا يمكن تفعيل الميزة لأن الباقة الحالية لا تتيحها." });
      if (error.message.includes("TENANT_NOT_FOUND")) throw new TRPCError({ code: "NOT_FOUND", message: "صاحب المولد غير موجود." });
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحديث إتاحة الميزة لصاحب المولد." });
    }
    const row = data?.[0];
    return { success: true, tenantId: Number(row?.tenant_id), featureKey: row?.feature_key, isEnabled: Boolean(row?.is_enabled), policy: row?.policy ?? "not_included" };
  });

type PlatformSettingAdminRouter = Omit<typeof adminRouter, "inviteTenantAccess"> & {
  inviteTenantAccess: typeof adminTenantAccessRouter.inviteTenantAccess;
  resetUserPassword: typeof resetUserPasswordProcedure;
  sendOwnerUsageAlert: typeof sendOwnerUsageAlertProcedure;
  listTenantFeatureEntitlements: typeof listTenantFeatureEntitlementsProcedure;
  setTenantFeatureEntitlement: typeof setTenantFeatureEntitlementProcedure;
};

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
  resetUserPassword: resetUserPasswordProcedure,
  savePlatformSetting: platformAdminSavePlatformSettingProcedure,
  sendOwnerUsageAlert: sendOwnerUsageAlertProcedure,
  setTenantFeatureEntitlement: setTenantFeatureEntitlementProcedure,
  listTenantFeatureEntitlements: listTenantFeatureEntitlementsProcedure,
}) as unknown) as PlatformSettingAdminRouter;
