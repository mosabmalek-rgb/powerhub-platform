import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { authenticatedProcedure, router } from "./_core/trpc";
import { saveRolePolicy } from "./role-policy-supabase";
import { supabaseAdmin } from "./supabase-admin";
import { defaultCapabilitiesForRole, powerCapabilityLabels, type PowerCapability, type PowerRole } from "../shared/powerhub-rbac";

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
  "createInventoryItems",
  "editInventoryItems",
  "deactivateInventoryItems",
  "createSuppliers",
  "editSuppliers",
  "deactivateSuppliers",
  "createWarehouses",
  "editWarehouses",
  "deactivateWarehouses",
  "createPurchases",
  "approvePurchases",
  "receiveInventory",
  "manageSupplierPayments",
  "reverseSupplierPayments",
  "viewSupplierLedger",
  "issueInventory",
  "adjustInventory",
  "manageFuelAndConsumption",
  "manageMaintenance",
  "viewInventoryReports",
  "viewStocktakes",
  "manageStocktakes",
  "approveStocktakes",
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
      const [profilesResult, ownerMembershipsResult] = await Promise.all([
        admin.from("staff_profiles")
          .select("id,user_id,tenant_id,site_id,role,is_active,permissions,custom_role_id")
          .not("tenant_id", "is", null)
          .neq("role", "owner")
          .order("id", { ascending: false })
          .limit(500),
        admin.from("tenant_members")
          .select("tenant_id,user_id,role,is_active,membership_status")
          .eq("role", "owner")
          .order("tenant_id", { ascending: true })
          .limit(500),
      ]);
      if (profilesResult.error || ownerMembershipsResult.error) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل المستخدمين للصلاحيات الدقيقة." });
      }
      const profiles = profilesResult.data ?? [];
      const ownerMemberships = ownerMembershipsResult.data ?? [];
      const userIds = [...new Set([
        ...profiles.map((row) => Number(row.user_id)),
        ...ownerMemberships.map((row) => Number(row.user_id)),
      ].filter(Number.isSafeInteger))];
      const tenantIds = [...new Set([
        ...profiles.map((row) => Number(row.tenant_id)),
        ...ownerMemberships.map((row) => Number(row.tenant_id)),
      ].filter(Number.isSafeInteger))];
      const siteIds = [...new Set(profiles.map((row) => Number(row.site_id)).filter(Number.isSafeInteger))];
      const profileIds = profiles.map((row) => Number(row.id));
      const ownerUserIds = [...new Set(ownerMemberships.map((row) => Number(row.user_id)).filter(Number.isSafeInteger))];
      const ownerTenantIds = [...new Set(ownerMemberships.map((row) => Number(row.tenant_id)).filter(Number.isSafeInteger))];
      const customRoleIds = [...new Set(profiles.map((row) => Number(row.custom_role_id)).filter((id) => Number.isSafeInteger(id) && id > 0))];
      const [usersResult, tenantsResult, sitesResult, overridesResult, customRolesResult, ownerOverridesResult] = await Promise.all([
        userIds.length ? admin.from("users").select("id,name,email").in("id", userIds) : Promise.resolve({ data: [], error: null }),
        tenantIds.length ? admin.from("tenants").select("id,name").in("id", tenantIds) : Promise.resolve({ data: [], error: null }),
        siteIds.length ? admin.from("sites").select("id,name").in("id", siteIds) : Promise.resolve({ data: [], error: null }),
        profileIds.length
          ? admin.from("staff_profile_capability_overrides").select("profile_id,capability,is_allowed").in("profile_id", profileIds)
          : Promise.resolve({ data: [], error: null }),
        customRoleIds.length
          ? admin.from("custom_permission_roles").select("id,permissions").in("id", customRoleIds)
          : Promise.resolve({ data: [], error: null }),
        ownerMemberships.length
          ? admin.from("tenant_member_capability_overrides")
              .select("tenant_id,user_id,capability,is_allowed")
              .in("tenant_id", ownerTenantIds)
              .in("user_id", ownerUserIds)
          : Promise.resolve({ data: [], error: null }),
      ]);
      if (usersResult.error || tenantsResult.error || sitesResult.error || overridesResult.error || customRolesResult.error || ownerOverridesResult.error) {
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
      const ownerOverrides = new Map<string, Array<{ capability: string; isAllowed: boolean }>>();
      for (const row of ownerOverridesResult.data ?? []) {
        const key = `${Number(row.tenant_id)}:${Number(row.user_id)}`;
        const list = ownerOverrides.get(key) ?? [];
        list.push({ capability: row.capability, isAllowed: Boolean(row.is_allowed) });
        ownerOverrides.set(key, list);
      }
      const staffTargets = profiles.map((profile) => {
        const user = users.get(Number(profile.user_id));
        const tenant = tenants.get(Number(profile.tenant_id));
        const site = profile.site_id == null ? null : sites.get(Number(profile.site_id));
        return {
          targetType: "staff" as const,
          targetKey: `staff:${Number(profile.id)}`,
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
      const ownerTargets = ownerMemberships.map((member) => {
        const userId = Number(member.user_id);
        const tenantId = Number(member.tenant_id);
        const user = users.get(userId);
        const tenant = tenants.get(tenantId);
        return {
          targetType: "owner" as const,
          targetKey: `owner:${tenantId}:${userId}`,
          profileId: null,
          userId,
          userName: user?.name ?? null,
          email: user?.email ?? null,
          tenantId,
          tenantName: tenant?.name ?? `مساحة #${tenantId}`,
          siteId: null,
          siteName: "جميع فروع مساحة صاحب المولد",
          role: "owner" as const,
          isActive: Boolean(member.is_active && member.membership_status === "active"),
          baseCapabilities: Object.keys(powerCapabilityLabels) as PowerCapability[],
          overrides: ownerOverrides.get(`${tenantId}:${userId}`) ?? [],
        };
      });
      return [...ownerTargets, ...staffTargets];
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

  setOwnerCapabilityOverride: authenticatedProcedure
    .input(z.object({
      tenantId: z.number().int().positive(),
      userId: z.number().int().positive(),
      capability: capabilitySchema,
      isAllowed: z.boolean(),
    }))
    .mutation(async ({ ctx, input }) => {
      if (ctx.user.role !== "admin" || !["platform_owner", "platform_admin"].includes(ctx.user.platformRole ?? "") || ctx.user.accountStatus !== "active") {
        throw new TRPCError({ code: "FORBIDDEN", message: "دور المنصة الحالي لا يملك هذه الصلاحية." });
      }
      const { data, error } = await supabaseAdmin().rpc("powerhub_admin_set_owner_capability_override", {
        p_actor_user_id: ctx.user.id,
        p_tenant_id: input.tenantId,
        p_user_id: input.userId,
        p_capability: input.capability,
        p_is_allowed: input.isAllowed,
      });
      const message = error?.message?.trim() ?? "";
      if (message.includes("PLATFORM_ADMIN_REQUIRED")) throw new TRPCError({ code: "FORBIDDEN", message: "دور المنصة الحالي لا يملك هذه الصلاحية." });
      if (message.includes("INVALID_CAPABILITY") || message.includes("OWNER_MEMBERSHIP_NOT_FOUND")) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "عضوية صاحب المولد أو الصلاحية المحددة غير صالحة للتخصيص الفردي." });
      }
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر حفظ استثناء صلاحيات صاحب المولد." });
      const row = Array.isArray(data) ? data[0] : null;
      if (!row?.success) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "لم تؤكد قاعدة البيانات حفظ استثناء صلاحية صاحب المولد." });
      return {
        success: true as const,
        targetType: "owner" as const,
        tenantId: Number(row.tenant_id),
        userId: Number(row.user_id),
        capability: row.capability as PowerCapability,
        isAllowed: Boolean(row.is_allowed),
        replayed: Boolean(row.replayed),
      };
    }),

});
