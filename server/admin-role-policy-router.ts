import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { authenticatedProcedure, router } from "./_core/trpc";
import { saveRolePolicy } from "./role-policy-supabase";
import { supabaseAdmin } from "./supabase-admin";
import { defaultCapabilitiesForRole, type PowerCapability, type PowerRole } from "../shared/powerhub-rbac";

const roleSchema = z.enum(["owner", "manager", "accountant", "collector", "technician", "viewer"]);
const capabilitySchema = z.enum([
  "manageSubscribers",
  "manageGenerators",
  "recordReadings",
  "accessFieldApp",
  "approveReadings",
  "manageTariffs",
  "issueInvoices",
  "collectPayments",
  "approvePaymentDocumentation",
  "manageExpenses",
  "managePayroll",
  "manageTeam",
  "manageMessaging",
  "viewAudit",
  "viewInventory",
  "viewSuppliers",
  "viewPurchases",
  "manageInventoryItems",
  "manageSuppliers",
  "createPurchases",
  "approvePurchases",
  "receiveInventory",
  "manageSupplierPayments",
  "viewSupplierLedger",
  "issueInventory",
  "adjustInventory",
  "manageFuelAndConsumption",
  "manageMaintenance",
  "viewInventoryReports",
]);

export const adminRolePolicyRouter = router({
  saveRolePolicy: authenticatedProcedure
    .input(z.object({ role: roleSchema, capability: capabilitySchema, isAllowed: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      if (ctx.user.role !== "admin" || !["platform_owner", "platform_admin"].includes(ctx.user.platformRole ?? "") || ctx.user.accountStatus !== "active") {
        throw new TRPCError({ code: "FORBIDDEN", message: "دور المنصة الحالي لا يملك هذه الصلاحية." });
      }
      return saveRolePolicy({
        actorUserId: ctx.user.id,
        role: input.role,
        capability: input.capability,
        isAllowed: input.isAllowed,
      });
    }),

  staffPermissionTargets: authenticatedProcedure
    .input(z.object({}).optional())
    .query(async ({ ctx }) => {
      if (ctx.user.role !== "admin" || !["platform_owner", "platform_admin"].includes(ctx.user.platformRole ?? "") || ctx.user.accountStatus !== "active") {
        throw new TRPCError({ code: "FORBIDDEN", message: "دور المنصة الحالي لا يملك هذه الصلاحية." });
      }
      const admin = supabaseAdmin();
      const profilesResult = await admin.from("staff_profiles")
        .select("id,user_id,tenant_id,site_id,role,is_active,permissions,custom_role_id")
        .not("tenant_id", "is", null)
        .neq("role", "owner")
        .order("id", { ascending: false })
        .limit(500);
      if (profilesResult.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل حسابات الموظفين للصلاحيات الدقيقة." });
      const profiles = profilesResult.data ?? [];
      if (!profiles.length) return [];
      const userIds = [...new Set(profiles.map((row) => Number(row.user_id)).filter(Number.isSafeInteger))];
      const tenantIds = [...new Set(profiles.map((row) => Number(row.tenant_id)).filter(Number.isSafeInteger))];
      const siteIds = [...new Set(profiles.map((row) => Number(row.site_id)).filter(Number.isSafeInteger))];
      const profileIds = profiles.map((row) => Number(row.id));
      const customRoleIds = [...new Set(profiles.map((row) => Number(row.custom_role_id)).filter((id) => Number.isSafeInteger(id) && id > 0))];
      const [usersResult, tenantsResult, sitesResult, overridesResult, customRolesResult] = await Promise.all([
        admin.from("users").select("id,name,email").in("id", userIds),
        admin.from("tenants").select("id,name").in("id", tenantIds),
        siteIds.length ? admin.from("sites").select("id,name").in("id", siteIds) : Promise.resolve({ data: [], error: null }),
        admin.from("staff_profile_capability_overrides").select("profile_id,capability,is_allowed").in("profile_id", profileIds),
        customRoleIds.length ? admin.from("custom_permission_roles").select("id,permissions").in("id", customRoleIds) : Promise.resolve({ data: [], error: null }),
      ]);
      if (usersResult.error || tenantsResult.error || sitesResult.error || overridesResult.error || customRolesResult.error) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل تفاصيل الحسابات واستثناءات الصلاحيات." });
      }
      const users = new Map((usersResult.data ?? []).map((row) => [Number(row.id), row]));
      const tenants = new Map((tenantsResult.data ?? []).map((row) => [Number(row.id), row]));
      const sites = new Map((sitesResult.data ?? []).map((row) => [Number(row.id), row]));
      const customRoles = new Map((customRolesResult.data ?? []).map((row) => [Number(row.id), row]));
      const overrides = new Map<number, Array<{ capability: string; isAllowed: boolean }>>();
      for (const row of overridesResult.data ?? []) {
        const id = Number(row.profile_id);
        const list = overrides.get(id) ?? [];
        list.push({ capability: row.capability, isAllowed: Boolean(row.is_allowed) });
        overrides.set(id, list);
      }
      return profiles.map((profile) => {
        const user = users.get(Number(profile.user_id));
        const tenant = tenants.get(Number(profile.tenant_id));
        const site = profile.site_id == null ? null : sites.get(Number(profile.site_id));
        return {
          profileId: Number(profile.id),
          userId: Number(profile.user_id),
          userName: user?.name ?? null,
          email: user?.email ?? null,
          tenantId: Number(profile.tenant_id),
          tenantName: tenant?.name ?? `مساحة #${profile.tenant_id}`,
          siteId: profile.site_id == null ? null : Number(profile.site_id),
          siteName: site?.name ?? (profile.site_id == null ? "جميع الفروع" : `فرع #${profile.site_id}`),
          role: profile.role,
          isActive: Boolean(profile.is_active),
          baseCapabilities: Array.isArray(profile.permissions)
            ? profile.permissions.filter((capability): capability is PowerCapability => typeof capability === "string")
            : profile.custom_role_id
              ? ((customRoles.get(Number(profile.custom_role_id))?.permissions ?? []) as unknown[]).filter((capability): capability is PowerCapability => typeof capability === "string")
              : defaultCapabilitiesForRole(profile.role as PowerRole),
          overrides: overrides.get(Number(profile.id)) ?? [],
        };
      });
    }),

  setStaffCapabilityOverride: authenticatedProcedure
    .input(z.object({ profileId: z.number().int().positive(), capability: capabilitySchema, isAllowed: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      if (ctx.user.role !== "admin" || !["platform_owner", "platform_admin"].includes(ctx.user.platformRole ?? "") || ctx.user.accountStatus !== "active") {
        throw new TRPCError({ code: "FORBIDDEN", message: "دور المنصة الحالي لا يملك هذه الصلاحية." });
      }
      const { data, error } = await supabaseAdmin().rpc("powerhub_admin_set_staff_capability_override", {
        p_actor_user_id: ctx.user.id,
        p_profile_id: input.profileId,
        p_capability: input.capability,
        p_is_allowed: input.isAllowed,
      });
      const message = error?.message?.trim() ?? "";
      if (message.includes("PLATFORM_ADMIN_REQUIRED")) throw new TRPCError({ code: "FORBIDDEN", message: "دور المنصة الحالي لا يملك هذه الصلاحية." });
      if (message.includes("INVALID_CAPABILITY") || message.includes("STAFF_PROFILE_NOT_FOUND") || message.includes("OWNER_PERMISSION_OVERRIDE_NOT_SUPPORTED")) throw new TRPCError({ code: "BAD_REQUEST", message: "الحساب أو الصلاحية المحددة غير صالحة للتخصيص الفردي." });
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر حفظ استثناء صلاحيات المستخدم." });
      const row = Array.isArray(data) ? data[0] : null;
      if (!row?.success) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "لم تؤكد قاعدة البيانات حفظ استثناء الصلاحية." });
      return { success: true as const, profileId: Number(row.profile_id), capability: row.capability as string, isAllowed: Boolean(row.is_allowed) };
    }),
});
