import { TRPCError } from "@trpc/server";
import { applyStaffCapabilityOverrides, defaultCapabilitiesForRole, powerCapabilityLabels, type PowerCapability, type PowerRole } from "../shared/powerhub-rbac";
import { supabaseAdmin } from "./supabase-admin";
import { requireTenantSubscription } from "./subscription-access";
import { storageGet } from "./storage";
import { buildFinancialOverview } from "./financial-overview-utils";
import { isActivePlatformAdmin } from "./platform-admin";

const allCapabilities = Object.keys(powerCapabilityLabels) as PowerCapability[];

type SupabaseSite = {
  id: number;
  tenantId: number;
  tenantName: string;
  name: string;
  code: string;
  city: string | null;
  address: string | null;
  status: "active" | "inactive" | "archived";
  anomalyAlertPercent: number;
  invoiceDueDays: number;
  invoiceDueHours: number;
  createdAt: Date;
};

export type SupabaseKeysetCursor = { at: string; id: number };
export type SupabaseHistoryPage<T> = { items: T[]; hasNext: boolean; nextCursor: string | null };

function encodeHistoryCursor(cursor: SupabaseKeysetCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeHistoryCursor(value: string | undefined): SupabaseKeysetCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<SupabaseKeysetCursor>;
    const id = parsed.id;
    if (typeof parsed.at !== "string" || !Number.isInteger(id) || (id ?? 0) < 1 || Number.isNaN(Date.parse(parsed.at))) throw new Error("invalid");
    return { at: new Date(parsed.at).toISOString(), id: id as number };
  } catch {
    throw new TRPCError({ code: "BAD_REQUEST", message: "مؤشر الصفحة غير صالح؛ أعد تحميل القائمة." });
  }
}

function historyLimit(value: number | undefined): number {
  return Math.min(200, Math.max(1, Math.trunc(value ?? 50)));
}

function asPowerRole(value: string): PowerRole {
  if (["owner", "manager", "accountant", "collector", "technician", "viewer"].includes(value)) return value as PowerRole;
  throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "يوجد دور غير صالح في ملف صلاحيات Supabase." });
}

function asPermissions(value: unknown): PowerCapability[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is PowerCapability => typeof item === "string" && allCapabilities.includes(item as PowerCapability));
}

function dateOrNull(value: string | null): Date | null {
  return value ? new Date(value) : null;
}

function isSuspended(now: Date, startsAt: Date | null, endsAt: Date | null) {
  return Boolean(startsAt && endsAt && now >= startsAt && now < endsAt);
}

type SupabaseAccountTransaction = {
  id: number;
  tenantId: number;
  accountId: number;
  transactionType: string;
  amount: string;
  description: string;
  referenceNo: string | null;
  relatedPaymentId: number | null;
  relatedAccountId: number | null;
  createdByUserId: number | null;
  occurredAt: Date;
  createdAt: Date;
};

export async function getSupabaseSite(siteId: number): Promise<SupabaseSite> {
  const { data, error } = await supabaseAdmin().from("sites")
    .select("id, tenant_id, name, code, city, address, status, anomaly_alert_percent, invoice_due_days, invoice_due_hours, created_at, tenants!inner(name)")
    .eq("id", siteId).maybeSingle();
  if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل الفرع من Supabase." });
  if (!data) throw new TRPCError({ code: "NOT_FOUND", message: "المحطة غير موجودة." });
  return {
    id: Number(data.id), tenantId: Number(data.tenant_id), tenantName: (data as any).tenants?.name ?? data.name, name: data.name, code: data.code, city: data.city, address: data.address,
    status: data.status as SupabaseSite["status"], anomalyAlertPercent: data.anomaly_alert_percent, invoiceDueDays: data.invoice_due_days, invoiceDueHours: Number(data.invoice_due_hours ?? Math.max(1, Math.min(2160, Number(data.invoice_due_days ?? 14) * 24))),
    createdAt: new Date(data.created_at),
  };
}

type ResolvedSupabaseSiteAccess = {
  role: PowerRole;
  permissions: PowerCapability[];
  tenantId: number;
  invoiceDueDays: number;
  invoiceDueHours: number;
  usesPermissionOverride: boolean;
  isPlatformAdmin: boolean;
};

async function resolveSupabaseSiteAccessDetails(userId: number, siteId: number): Promise<ResolvedSupabaseSiteAccess> {
  const accessStartedAt = performance.now();
  let userAndSiteMs = 0;
  let membershipAndSubscriptionMs = 0;
  let staffProfilesMs = 0;
  let permissionResolutionMs = 0;
  const reportSlowAccess = (outcome: "platform_admin" | "owner" | "staff") => {
    const totalMs = Math.round(performance.now() - accessStartedAt);
    if (totalMs < 800) return;
    // Do not log user, tenant, or site identifiers or any permission contents.
    console.warn("[PowerHub access latency]", {
      stage: "resolveSupabaseSiteAccessDetails",
      outcome,
      totalMs,
      userAndSiteMs,
      membershipAndSubscriptionMs,
      staffProfilesMs,
      permissionResolutionMs,
    });
  };
  const admin = supabaseAdmin();
  const identityAndSiteStartedAt = performance.now();
  const [{ data: user, error: userError }, site] = await Promise.all([
    admin.from("users").select("role, platform_role, account_status").eq("id", userId).maybeSingle(),
    getSupabaseSite(siteId),
  ]);
  userAndSiteMs = Math.round(performance.now() - identityAndSiteStartedAt);
  if (userError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل ملف المستخدم من Supabase." });
  if (!user) throw new TRPCError({ code: "UNAUTHORIZED", message: "ملف المستخدم غير متاح." });
  const platformAdmin = isActivePlatformAdmin({ role: user.role, platformRole: user.platform_role, accountStatus: user.account_status });
  if (platformAdmin) {
    reportSlowAccess("platform_admin");
    return { role: "owner", permissions: allCapabilities, tenantId: site.tenantId, invoiceDueDays: site.invoiceDueDays, invoiceDueHours: site.invoiceDueHours, usesPermissionOverride: false, isPlatformAdmin: true };
  }

  // Membership and subscription are independent checks once the site's tenant is known.
  // Run them concurrently to avoid adding one network round trip to every protected operation.
  const membershipAndSubscriptionStartedAt = performance.now();
  const [membershipResult] = await Promise.all([
    admin.from("tenant_members")
      .select("role,tenant_member_capability_overrides(capability,is_allowed)").eq("tenant_id", site.tenantId).eq("user_id", userId).eq("is_active", true).eq("membership_status", "active").maybeSingle(),
    requireTenantSubscription(site.tenantId, new Date(), { allowReadOnlyRetention: true }),
  ]);
  membershipAndSubscriptionMs = Math.round(performance.now() - membershipAndSubscriptionStartedAt);
  const { data: membership, error: membershipError } = membershipResult;
  if (membershipError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر التحقق من عضوية المستأجر في Supabase." });
  if (!membership) throw new TRPCError({ code: "FORBIDDEN", message: "لا توجد عضوية فعالة في مساحة صاحب المولد لهذه المحطة." });

  if (membership.role === "owner") {
    const ownerOverrides = Array.isArray((membership as any).tenant_member_capability_overrides)
      ? (membership as any).tenant_member_capability_overrides.map((override: { capability: string; is_allowed: boolean }) => ({
          capability: override.capability,
          is_allowed: Boolean(override.is_allowed),
        }))
      : [];
    const permissions = applyStaffCapabilityOverrides(allCapabilities, ownerOverrides);
    reportSlowAccess("owner");
    return {
      role: "owner",
      permissions,
      tenantId: site.tenantId,
      invoiceDueDays: site.invoiceDueDays,
      invoiceDueHours: site.invoiceDueHours,
      usesPermissionOverride: ownerOverrides.length > 0,
      isPlatformAdmin: false,
    };
  }

  const staffProfilesStartedAt = performance.now();
  const { data: profiles, error: profileError } = await admin.from("staff_profiles")
    .select("id, role, permissions, custom_role_id, suspension_started_at, suspension_ends_at, site_id")
    .eq("tenant_id", site.tenantId).eq("user_id", userId).eq("is_active", true);
  staffProfilesMs = Math.round(performance.now() - staffProfilesStartedAt);
  if (profileError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل تعيين المستخدم في Supabase." });
  const profile = (profiles ?? []).find((item) => Number(item.site_id) === siteId) ?? (profiles ?? []).find((item) => item.site_id === null);
  if (!profile) throw new TRPCError({ code: "FORBIDDEN", message: "لا يوجد تعيين فعال لك في هذه المحطة." });
  if (isSuspended(new Date(), dateOrNull(profile.suspension_started_at), dateOrNull(profile.suspension_ends_at))) {
    throw new TRPCError({ code: "FORBIDDEN", message: `تم توقيف حسابك مؤقتاً حتى ${new Date(profile.suspension_ends_at!).toLocaleString("ar-IQ")}.` });
  }
  // NULL means "inherit from custom role"; [] is an explicit deny-all override.
  const hasExplicitPermissions = profile.permissions !== null && profile.permissions !== undefined;
  const role = asPowerRole(profile.role);
  const usesPermissionOverride = hasExplicitPermissions || Boolean(profile.custom_role_id);
  let permissions = hasExplicitPermissions ? asPermissions(profile.permissions) : defaultCapabilitiesForRole(role);

  // Load custom-role permissions and per-profile capability overrides concurrently.
  // Explicit per-profile entries are applied last, so the platform admin can grant
  // or deny a capability for one account without mutating the reusable role.
  const customRoleStartedAt = performance.now();
  const [customRoleResult, userOverridesResult] = await Promise.all([
    !hasExplicitPermissions && profile.custom_role_id
      ? admin.from("custom_permission_roles").select("permissions")
          .eq("id", profile.custom_role_id).eq("tenant_id", site.tenantId).eq("is_active", true).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    admin.from("staff_profile_capability_overrides")
      .select("capability,is_allowed")
      .eq("tenant_id", site.tenantId)
      .eq("profile_id", profile.id),
  ]);
  permissionResolutionMs = Math.round(performance.now() - customRoleStartedAt);
  if (customRoleResult.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل الصلاحيات المخصصة من Supabase." });
  if (userOverridesResult.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل استثناءات صلاحيات المستخدم من Supabase." });
  if (!hasExplicitPermissions && profile.custom_role_id) {
    permissions = asPermissions(customRoleResult.data?.permissions);
  }
  permissions = applyStaffCapabilityOverrides(
    permissions,
    (userOverridesResult.data ?? []).map((override) => ({ capability: override.capability, is_allowed: Boolean(override.is_allowed) })),
  );
  reportSlowAccess("staff");
  return { role, permissions, usesPermissionOverride: usesPermissionOverride || (userOverridesResult.data ?? []).length > 0, tenantId: site.tenantId, invoiceDueDays: site.invoiceDueDays, invoiceDueHours: site.invoiceDueHours, isPlatformAdmin: false };
}

export async function resolveSupabaseSiteAccess(userId: number, siteId: number): Promise<{ role: PowerRole; permissions: PowerCapability[]; tenantId: number; usesPermissionOverride: boolean }> {
  const { role, permissions, tenantId, usesPermissionOverride } = await resolveSupabaseSiteAccessDetails(userId, siteId);
  return { role, permissions, tenantId, usesPermissionOverride };
}

export async function requireSupabaseSiteRole(userId: number, siteId: number, allowed: PowerRole[], capability?: PowerCapability) {
  const access = await resolveSupabaseSiteAccessDetails(userId, siteId);
  // The access resolver already loaded the current platform role and account status.
  // Reuse that result instead of issuing a duplicate users-table query on every operation.
  const platformAdmin = access.isPlatformAdmin === true;
  if (!platformAdmin && capability && !access.permissions.includes(capability)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "لا تملك صلاحية تنفيذ هذه العملية." });
  }
  if (!platformAdmin && !capability && !allowed.includes(access.role)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "لا تملك صلاحية تنفيذ هذه العملية." });
  }
  if (!platformAdmin && capability) {
    const { data: policy, error: policyError } = await supabaseAdmin().from("platform_role_policies")
      .select("is_allowed").eq("role", access.role).eq("capability", capability).maybeSingle();
    if (policyError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر التحقق من سياسة الصلاحيات في Supabase." });
    if (policy && !policy.is_allowed) throw new TRPCError({ code: "FORBIDDEN", message: "هذه القدرة مقيّدة بسياسة المنصة للدور الحالي." });
  }
  return { role: access.role, permissions: access.permissions, tenantId: access.tenantId, usesPermissionOverride: access.usesPermissionOverride, invoiceDueDays: access.invoiceDueDays, invoiceDueHours: access.invoiceDueHours };
}

export async function requireSupabaseSiteCapabilities(userId: number, siteId: number, capabilities: PowerCapability[]) {
  const access = await resolveSupabaseSiteAccessDetails(userId, siteId);
  if (access.isPlatformAdmin) return access;

  const missing = capabilities.find((capability) => !access.permissions.includes(capability));
  if (missing) throw new TRPCError({ code: "FORBIDDEN", message: "لا تملك صلاحية تنفيذ هذه العملية." });

  // Resolve all capability policies in parallel after one membership/subscription/site lookup.
  const policies = await Promise.all(capabilities.map((capability) =>
    supabaseAdmin().from("platform_role_policies")
      .select("is_allowed").eq("role", access.role).eq("capability", capability).maybeSingle()
  ));
  for (const policyResult of policies) {
    if (policyResult.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر التحقق من سياسة الصلاحيات في Supabase." });
    if (policyResult.data && !policyResult.data.is_allowed) {
      throw new TRPCError({ code: "FORBIDDEN", message: "هذه القدرة مقيّدة بسياسة المنصة للدور الحالي." });
    }
  }
  return access;
}

export async function requireSupabaseAccessibleSiteIds(
  userId: number,
  currentSiteId: number,
  targetSiteIds: number[],
  allowed: PowerRole[],
  capability?: PowerCapability,
) {
  const access = await requireSupabaseSiteRole(userId, currentSiteId, allowed, capability);
  const ids = Array.from(new Set(targetSiteIds.map((siteId) => Number(siteId))));
  if (!ids.length) throw new TRPCError({ code: "BAD_REQUEST", message: "يجب تحديد فرع واحد على الأقل." });
  for (const siteId of ids) {
    const targetAccess = await requireSupabaseSiteRole(userId, siteId, allowed, capability);
    if (targetAccess.tenantId !== access.tenantId) {
      throw new TRPCError({ code: "FORBIDDEN", message: "لا تملك صلاحية الوصول إلى أحد الفروع المحددة." });
    }
  }
  return access;
}

export async function requireSupabaseAllBranchesRole(userId: number, siteId: number, allowed: PowerRole[]) {
  const access = await resolveSupabaseSiteAccess(userId, siteId);
  const admin = supabaseAdmin();
  const { data: user, error: userError } = await admin.from("users").select("role, platform_role, account_status").eq("id", userId).maybeSingle();
  if (userError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر التحقق من ملف المستخدم في Supabase." });
  if (isActivePlatformAdmin({ role: user?.role, platformRole: user?.platform_role, accountStatus: user?.account_status })) return { tenantId: access.tenantId, role: "owner" as const };
  const { data: membership, error: membershipError } = await admin.from("tenant_members").select("role")
    .eq("tenant_id", access.tenantId).eq("user_id", userId).eq("is_active", true).eq("membership_status", "active").maybeSingle();
  if (membershipError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر التحقق من عضوية المستأجر في Supabase." });
  if (membership?.role === "owner") return { tenantId: access.tenantId, role: "owner" as const };
  const { data: profile, error: profileError } = await admin.from("staff_profiles").select("role")
    .eq("tenant_id", access.tenantId).eq("user_id", userId).is("site_id", null).eq("is_active", true).maybeSingle();
  if (profileError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر التحقق من تعيين جميع الأفرع في Supabase." });
  if (!profile) throw new TRPCError({ code: "FORBIDDEN", message: "هذه البيانات المجمعة متاحة لمالك المولد أو لحساب عام معيّن على جميع الأفرع." });
  const role = asPowerRole(profile.role);
  if (!allowed.includes(role)) throw new TRPCError({ code: "FORBIDDEN", message: "هذه البيانات المجمعة متاحة لمالك المولد أو لحساب عام معيّن على جميع الأفرع." });
  return { tenantId: access.tenantId, role };
}

export async function listSupabaseAccessibleSites(userId: number, isPlatformAdmin: boolean): Promise<SupabaseSite[]> {
  const admin = supabaseAdmin();
  if (isPlatformAdmin) {
    const { data, error } = await admin.from("sites").select("id, tenant_id, name, code, city, address, status, anomaly_alert_percent, invoice_due_days, invoice_due_hours, created_at, tenants!inner(name)").order("created_at", { ascending: false });
    if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل الفروع من Supabase." });
    return (data ?? []).map((site) => ({ id: Number(site.id), tenantId: Number(site.tenant_id), tenantName: (site as any).tenants?.name ?? site.name, name: site.name, code: site.code, city: site.city, address: site.address, status: site.status as SupabaseSite["status"], anomalyAlertPercent: site.anomaly_alert_percent, invoiceDueDays: site.invoice_due_days, invoiceDueHours: Number(site.invoice_due_hours ?? Math.max(1, Math.min(2160, Number(site.invoice_due_days ?? 14) * 24))), createdAt: new Date(site.created_at) }));
  }
  const { data: memberships, error: membershipsError } = await admin.from("tenant_members").select("tenant_id, role")
    .eq("user_id", userId).eq("is_active", true).eq("membership_status", "active");
  if (membershipsError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل عضويات المستخدم من Supabase." });
  const ownerTenantIds = (memberships ?? []).filter((member) => member.role === "owner").map((member) => Number(member.tenant_id));
  const { data: profiles, error: profilesError } = await admin.from("staff_profiles").select("site_id")
    .eq("user_id", userId).eq("is_active", true);
  if (profilesError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل تعيينات الفروع من Supabase." });
  const assignedSiteIds = (profiles ?? []).map((profile) => profile.site_id).filter((id): id is number => id !== null).map(Number);
  const requestedIds = Array.from(new Set(assignedSiteIds));
  const [ownedResult, assignedResult] = await Promise.all([
    ownerTenantIds.length ? admin.from("sites").select("id, tenant_id, name, code, city, address, status, anomaly_alert_percent, invoice_due_days, invoice_due_hours, created_at, tenants!inner(name)").in("tenant_id", ownerTenantIds).order("created_at", { ascending: false }) : Promise.resolve({ data: [], error: null }),
    requestedIds.length ? admin.from("sites").select("id, tenant_id, name, code, city, address, status, anomaly_alert_percent, invoice_due_days, invoice_due_hours, created_at, tenants!inner(name)").in("id", requestedIds).order("created_at", { ascending: false }) : Promise.resolve({ data: [], error: null }),
  ]);
  if (ownedResult.error || assignedResult.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل الفروع المتاحة من Supabase." });
  return Array.from(new Map([...(ownedResult.data ?? []), ...(assignedResult.data ?? [])].map((site) => [Number(site.id), ({ id: Number(site.id), tenantId: Number(site.tenant_id), tenantName: (site as any).tenants?.name ?? site.name, name: site.name, code: site.code, city: site.city, address: site.address, status: site.status as SupabaseSite["status"], anomalyAlertPercent: site.anomaly_alert_percent, invoiceDueDays: site.invoice_due_days, invoiceDueHours: Number(site.invoice_due_hours ?? Math.max(1, Math.min(2160, Number(site.invoice_due_days ?? 14) * 24))), createdAt: new Date(site.created_at) })])).values());
}

export async function listSupabaseSubscribers(siteId: number) {
  const { data, error } = await supabaseAdmin().from("subscribers")
    .select("id, tenant_id, site_id, subscriber_no, client_operation_id, full_name, phone, whatsapp_number, address, subscription_type, service_status, created_at, updated_at")
    .eq("site_id", siteId).is("archived_at", null).order("created_at", { ascending: false });
  if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل المشتركين من Supabase." });
  return (data ?? []).map((row) => ({
    id: Number(row.id), tenantId: Number(row.tenant_id), siteId: Number(row.site_id), subscriberNo: row.subscriber_no,
    clientOperationId: row.client_operation_id, fullName: row.full_name, phone: row.phone, whatsappNumber: row.whatsapp_number,
    address: row.address, subscriptionType: row.subscription_type, serviceStatus: row.service_status, createdAt: new Date(row.created_at), updatedAt: new Date(row.updated_at),
  }));
}


export async function listSupabaseSubscriberDirectoryPage(input: {
  tenantId: number;
  siteId: number;
  page: number;
  pageSize: number;
  search?: string;
  subscriptionType?: "residential" | "commercial" | "institution" | "mosque";
}) {
  const admin = supabaseAdmin();
  let query = admin.from("subscribers")
    .select("id, tenant_id, site_id, subscriber_no, client_operation_id, full_name, phone, whatsapp_number, address, subscription_type, service_status, created_at, updated_at", { count: "exact" })
    .eq("tenant_id", input.tenantId)
    .eq("site_id", input.siteId)
    .is("archived_at", null);

  if (input.subscriptionType) query = query.eq("subscription_type", input.subscriptionType);
  // Remove characters that can alter the PostgREST OR-filter grammar while retaining
  // normal Arabic names, subscriber references, phone numbers, and invoice-like terms.
  const term = (input.search ?? "").trim().replace(/[%,().*\\]/g, " ").replace(/\s+/g, " ").trim();
  if (term) {
    query = query.or([
      `full_name.ilike.%${term}%`,
      `subscriber_no.ilike.%${term}%`,
      `phone.ilike.%${term}%`,
      `whatsapp_number.ilike.%${term}%`,
      `address.ilike.%${term}%`,
    ].join(","));
  }
  const from = (input.page - 1) * input.pageSize;
  const { data, error, count } = await query
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(from, from + input.pageSize - 1);
  if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل صفحة سجل المشتركين من Supabase." });
  const totalCount = count ?? 0;
  return {
    items: (data ?? []).map((row) => ({
      id: Number(row.id), tenantId: Number(row.tenant_id), siteId: Number(row.site_id), subscriberNo: row.subscriber_no,
      clientOperationId: row.client_operation_id, fullName: row.full_name, phone: row.phone, whatsappNumber: row.whatsapp_number,
      address: row.address, subscriptionType: row.subscription_type, serviceStatus: row.service_status,
      createdAt: new Date(row.created_at), updatedAt: new Date(row.updated_at),
    })),
    totalCount,
    page: input.page,
    pageSize: input.pageSize,
    totalPages: Math.max(1, Math.ceil(totalCount / input.pageSize)),
  };
}


export async function getSupabaseSubscriberAccountStatement(siteId: number, subscriberId: number) {
  const admin = supabaseAdmin();
  const { data: subscriber, error: subscriberError } = await admin.from("subscribers")
    .select("id, tenant_id, site_id, subscriber_no, full_name, phone, whatsapp_number, address, subscription_type, service_status, archived_at, purge_after_at, created_at, updated_at")
    .eq("site_id", siteId).eq("id", subscriberId).maybeSingle();
  if (subscriberError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل ملف المشترك من Supabase." });
  if (!subscriber) throw new TRPCError({ code: "NOT_FOUND", message: "المشترك غير موجود ضمن الفرع المحدد." });

  const [statementSummaryResult, invoiceRecentResult, paymentRecentResult, readingRecentResult] = await Promise.all([
    admin.rpc("powerhub_subscriber_statement_summary", {
      p_tenant_id: Number(subscriber.tenant_id),
      p_site_id: siteId,
      p_subscriber_id: subscriberId,
    }),
    admin.from("invoices")
      .select("id, invoice_no, billing_period, issue_date, due_date, previous_reading, current_reading, consumption_kwh, total_amount, paid_amount, balance_due, status, reading_id")
      .eq("tenant_id", Number(subscriber.tenant_id)).eq("site_id", siteId).eq("subscriber_id", subscriberId)
      .neq("status", "cancelled").order("issue_date", { ascending: false }).order("id", { ascending: false }).limit(21),
    admin.from("payments")
      .select("id, payment_no, invoice_id, amount, payment_method, transfer_from_account, transfer_from_type, transfer_to_account, transfer_to_type, reference_no, status, paid_at")
      .eq("tenant_id", Number(subscriber.tenant_id)).eq("site_id", siteId).eq("subscriber_id", subscriberId).eq("status", "completed")
      .order("paid_at", { ascending: false }).order("id", { ascending: false }).limit(21),
    admin.from("meter_readings")
      .select("id, reading_at, reading_value, previous_reading_value, consumption_kwh, capture_method, status, version_no, notes")
      .eq("tenant_id", Number(subscriber.tenant_id)).eq("subscriber_id", subscriberId)
      .order("reading_at", { ascending: false }).order("id", { ascending: false }).limit(21),
  ]);

  if (statementSummaryResult.error || invoiceRecentResult.error || paymentRecentResult.error || readingRecentResult.error) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل كشف حساب المشترك من Supabase." });
  }

  const statementSummary = statementSummaryResult.data?.[0];
  if (!statementSummary) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر حساب إجماليات كشف حساب المشترك." });
  }

  const recentInvoices = invoiceRecentResult.data ?? [];
  const recentPayments = paymentRecentResult.data ?? [];
  const recentReadings = readingRecentResult.data ?? [];
  const totalInvoiced = Number(statementSummary.total_invoiced ?? 0);
  const totalCollected = Number(statementSummary.total_collected ?? 0);
  const totalOutstanding = Number(statementSummary.total_outstanding ?? 0);
  const totalConsumptionKwh = Number(statementSummary.total_consumption_kwh ?? 0);

  const invoiceIds = recentPayments.map((row) => row.invoice_id === null ? null : Number(row.invoice_id)).filter((id): id is number => id !== null);
  const [paymentInvoiceResult] = invoiceIds.length
    ? await Promise.all([admin.from("invoices").select("id, invoice_no").eq("tenant_id", Number(subscriber.tenant_id)).eq("site_id", siteId).in("id", invoiceIds)])
    : [{ data: [], error: null }];
  if (paymentInvoiceResult.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر ربط دفعات المشترك بفواتيرها." });
  const invoiceNoById = new Map((paymentInvoiceResult.data ?? []).map((row) => [Number(row.id), row.invoice_no]));

  return {
    subscriber: {
      id: Number(subscriber.id),
      tenantId: Number(subscriber.tenant_id),
      siteId: Number(subscriber.site_id),
      subscriberNo: subscriber.subscriber_no,
      fullName: subscriber.full_name,
      phone: subscriber.phone,
      whatsappNumber: subscriber.whatsapp_number,
      address: subscriber.address,
      subscriptionType: subscriber.subscription_type,
      serviceStatus: subscriber.service_status,
      archivedAt: subscriber.archived_at ? new Date(subscriber.archived_at) : null,
      purgeAfterAt: subscriber.purge_after_at ? new Date(subscriber.purge_after_at) : null,
      createdAt: new Date(subscriber.created_at),
      updatedAt: new Date(subscriber.updated_at),
    },
    summary: {
      invoiceCount: Number(statementSummary.invoice_count ?? 0),
      paymentCount: Number(statementSummary.payment_count ?? 0),
      readingCount: Number(statementSummary.reading_count ?? 0),
      totalInvoiced,
      totalCollected,
      totalOutstanding,
      totalConsumptionKwh,
      lastPaymentAt: statementSummary.last_payment_at ? new Date(statementSummary.last_payment_at) : null,
    },
    limits: {
      invoiceHasMore: recentInvoices.length > 20,
      paymentHasMore: recentPayments.length > 20,
      readingHasMore: recentReadings.length > 20,
      visiblePerSection: 20,
    },
    invoices: recentInvoices.slice(0, 20).map((row) => ({
      id: Number(row.id),
      invoiceNo: row.invoice_no,
      billingPeriod: row.billing_period,
      issueDate: new Date(row.issue_date),
      dueDate: new Date(row.due_date),
      previousReading: row.previous_reading === null ? null : String(row.previous_reading),
      currentReading: row.current_reading === null ? null : String(row.current_reading),
      consumptionKwh: String(row.consumption_kwh),
      totalAmount: String(row.total_amount),
      paidAmount: String(row.paid_amount),
      balanceDue: String(row.balance_due),
      status: row.status,
      readingId: row.reading_id === null ? null : Number(row.reading_id),
    })),
    payments: recentPayments.slice(0, 20).map((row) => ({
      id: Number(row.id),
      paymentNo: row.payment_no,
      invoiceId: row.invoice_id === null ? null : Number(row.invoice_id),
      invoiceNo: row.invoice_id === null ? null : invoiceNoById.get(Number(row.invoice_id)) ?? null,
      amount: String(row.amount),
      paymentMethod: row.payment_method,
      transferFromAccount: row.transfer_from_account,
      transferFromType: row.transfer_from_type,
      transferToAccount: row.transfer_to_account,
      transferToType: row.transfer_to_type,
      referenceNo: row.reference_no,
      status: row.status,
      paidAt: new Date(row.paid_at),
    })),
    readings: recentReadings.slice(0, 20).map((row) => ({
      id: Number(row.id),
      readingAt: new Date(row.reading_at),
      readingValue: String(row.reading_value),
      previousReadingValue: row.previous_reading_value === null ? null : String(row.previous_reading_value),
      consumptionKwh: row.consumption_kwh === null ? null : String(row.consumption_kwh),
      captureMethod: row.capture_method,
      status: row.status,
      versionNo: Number(row.version_no),
      notes: row.notes,
    })),
  };
}


export async function listSupabaseTariffs(siteId: number) {
  const { data, error } = await supabaseAdmin().from("tariffs")
    .select("id, tenant_id, site_id, name, code, price_per_kwh, fixed_fee, tax_rate, is_active, effective_from, created_at")
    .eq("site_id", siteId).order("effective_from", { ascending: false });
  if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل التعرفات من Supabase." });
  return (data ?? []).map((row) => ({
    id: Number(row.id), tenantId: Number(row.tenant_id), siteId: Number(row.site_id), name: row.name, code: row.code,
    pricePerKwh: String(row.price_per_kwh), fixedFee: String(row.fixed_fee), taxRate: String(row.tax_rate),
    isActive: row.is_active, effectiveFrom: new Date(row.effective_from), createdAt: new Date(row.created_at),
  }));
}

function gazaDateBoundary(dateKey: string): Date {
  const [year, month, day] = dateKey.split("-").map(Number);
  const wallClock = Date.UTC(year, month - 1, day);
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Gaza", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  let candidate = wallClock;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = formatter.formatToParts(new Date(candidate));
    const get = (kind: string) => Number(parts.find((part) => part.type === kind)?.value ?? 0);
    const represented = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
    const delta = represented - candidate;
    if (delta === 0) break;
    candidate = wallClock - delta;
  }
  return new Date(candidate);
}

function nextDateKey(dateKey: string): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`;
}

export async function listSupabaseTariffPriceHistory(
  siteId: number,
  options: { from?: string; to?: string; limit?: number; offset?: number } = {},
) {
  const admin = supabaseAdmin();
  const limit = Math.min(100, Math.max(1, Math.trunc(options.limit ?? 50)));
  const offset = Math.min(50_000, Math.max(0, Math.trunc(options.offset ?? 0)));
  let query = admin.from("tariff_price_history")
    .select("id, tenant_id, site_id, tariff_id, price_per_kwh, fixed_fee, tax_rate, is_active, valid_from, valid_to, change_kind", { count: "exact" })
    .eq("site_id", siteId);
  if (options.from) query = query.or("valid_to.is.null,valid_to.gt." + gazaDateBoundary(options.from).toISOString());
  if (options.to) query = query.lt("valid_from", gazaDateBoundary(nextDateKey(options.to)).toISOString());
  const { data, error, count } = await query
    .order("valid_from", { ascending: false })
    .order("id", { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل سجل أسعار الكيلوواط." });
  const items = (data ?? []).map((row) => ({
    id: Number(row.id), tenantId: Number(row.tenant_id), siteId: Number(row.site_id), tariffId: Number(row.tariff_id),
    pricePerKwh: String(row.price_per_kwh), fixedFee: String(row.fixed_fee), taxRate: String(row.tax_rate),
    isActive: Boolean(row.is_active), validFrom: new Date(row.valid_from), validTo: row.valid_to ? new Date(row.valid_to) : null,
    changeKind: row.change_kind,
  }));
  const total = count ?? items.length;
  return { items, total, hasNext: offset + items.length < total };
}

export async function listSupabaseGenerators(siteId: number) {
  const { data, error } = await supabaseAdmin().from("generators")
    .select("id, tenant_id, site_id, code, name, serial_number, rated_capacity_kw, fuel_type, fuel_level_liters, operating_hours, status, last_maintenance_at, created_at, updated_at")
    .eq("site_id", siteId).order("created_at", { ascending: false });
  if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل المولدات من Supabase." });
  return (data ?? []).map((row) => ({
    id: Number(row.id), tenantId: Number(row.tenant_id), siteId: Number(row.site_id), code: row.code, name: row.name, serialNumber: row.serial_number,
    ratedCapacityKw: row.rated_capacity_kw == null ? null : String(row.rated_capacity_kw), fuelType: row.fuel_type, fuelLevelLiters: String(row.fuel_level_liters), operatingHours: String(row.operating_hours),
    status: row.status, lastMaintenanceAt: row.last_maintenance_at ? new Date(row.last_maintenance_at) : null, createdAt: new Date(row.created_at), updatedAt: new Date(row.updated_at),
  }));
}

export async function listSupabaseReadings(siteId: number) {
  const admin = supabaseAdmin();
  const { data: subscriberRows, error: subscribersError } = await admin.from("subscribers")
    .select("id, tenant_id, site_id, subscriber_no, full_name, phone, whatsapp_number, address, subscription_type, service_status, created_at, updated_at")
    .eq("site_id", siteId);
  if (subscribersError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل نطاق قراءات الفرع من Supabase." });
  if (!(subscriberRows ?? []).length) return [];
  const subscriberIds = subscriberRows!.map((row) => Number(row.id));
  const { data: readingRows, error: readingsError } = await admin.from("meter_readings")
    .select("id, tenant_id, subscriber_id, client_operation_id, reading_at, reading_value, previous_reading_value, consumption_kwh, capture_method, image_key, image_hash, status, entered_by_user_id, reviewed_by_user_id, reviewed_at, notes, version_no, created_at, updated_at")
    .in("subscriber_id", subscriberIds).order("reading_at", { ascending: false });
  if (readingsError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل القراءات من Supabase." });
  const subscribersById = new Map(subscriberRows!.map((row) => [Number(row.id), {
    id: Number(row.id), tenantId: Number(row.tenant_id), siteId: Number(row.site_id), subscriberNo: row.subscriber_no, fullName: row.full_name,
    phone: row.phone, whatsappNumber: row.whatsapp_number, address: row.address, subscriptionType: row.subscription_type,
    serviceStatus: row.service_status, createdAt: new Date(row.created_at), updatedAt: new Date(row.updated_at),
  }]));
  return (readingRows ?? []).flatMap((row) => {
    const subscriber = subscribersById.get(Number(row.subscriber_id));
    if (!subscriber) return [];
    return [{
      reading: {
        id: Number(row.id), tenantId: Number(row.tenant_id), subscriberId: Number(row.subscriber_id), clientOperationId: row.client_operation_id,
        readingAt: new Date(row.reading_at), readingValue: String(row.reading_value), previousReadingValue: row.previous_reading_value === null ? null : String(row.previous_reading_value),
        consumptionKwh: row.consumption_kwh === null ? null : String(row.consumption_kwh), captureMethod: row.capture_method,
        imageKey: row.image_key, imageHash: row.image_hash, status: row.status, enteredByUserId: row.entered_by_user_id === null ? null : Number(row.entered_by_user_id),
        reviewedByUserId: row.reviewed_by_user_id === null ? null : Number(row.reviewed_by_user_id), reviewedAt: row.reviewed_at ? new Date(row.reviewed_at) : null,
        notes: row.notes, versionNo: row.version_no, createdAt: new Date(row.created_at), updatedAt: new Date(row.updated_at),
      },
      subscriber,
    }];
  });
}

export async function listSupabaseReadingPage(siteId: number, input: { limit?: number; cursor?: string }): Promise<SupabaseHistoryPage<Awaited<ReturnType<typeof listSupabaseReadings>>[number]>> {
  const limit = historyLimit(input.limit);
  const cursor = decodeHistoryCursor(input.cursor);
  let query = supabaseAdmin().from("meter_readings")
    .select("id, tenant_id, subscriber_id, client_operation_id, reading_at, reading_value, previous_reading_value, consumption_kwh, capture_method, image_key, image_hash, status, entered_by_user_id, reviewed_by_user_id, reviewed_at, notes, version_no, created_at, updated_at, subscribers!inner(id, tenant_id, site_id, subscriber_no, full_name, phone, whatsapp_number, address, subscription_type, service_status, created_at, updated_at)")
    .eq("subscribers.site_id", siteId);
  if (cursor) query = query.or(`reading_at.lt.${cursor.at},and(reading_at.eq.${cursor.at},id.lt.${cursor.id})`);
  const { data, error } = await query.order("reading_at", { ascending: false }).order("id", { ascending: false }).limit(limit + 1);
  if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل صفحة القراءات من Supabase." });
  const rows = data ?? [];
  const hasNext = rows.length > limit;
  const items = rows.slice(0, limit).map((row: any) => ({
    reading: {
      id: Number(row.id), tenantId: Number(row.tenant_id), subscriberId: Number(row.subscriber_id), clientOperationId: row.client_operation_id,
      readingAt: new Date(row.reading_at), readingValue: String(row.reading_value), previousReadingValue: row.previous_reading_value === null ? null : String(row.previous_reading_value),
      consumptionKwh: row.consumption_kwh === null ? null : String(row.consumption_kwh), captureMethod: row.capture_method, imageKey: row.image_key, imageHash: row.image_hash,
      status: row.status, enteredByUserId: row.entered_by_user_id === null ? null : Number(row.entered_by_user_id), reviewedByUserId: row.reviewed_by_user_id === null ? null : Number(row.reviewed_by_user_id),
      reviewedAt: row.reviewed_at ? new Date(row.reviewed_at) : null, notes: row.notes, versionNo: row.version_no, createdAt: new Date(row.created_at), updatedAt: new Date(row.updated_at),
    },
    subscriber: { id: Number(row.subscribers.id), tenantId: Number(row.subscribers.tenant_id), siteId: Number(row.subscribers.site_id), subscriberNo: row.subscribers.subscriber_no, fullName: row.subscribers.full_name,
      phone: row.subscribers.phone, whatsappNumber: row.subscribers.whatsapp_number, address: row.subscribers.address, subscriptionType: row.subscribers.subscription_type, serviceStatus: row.subscribers.service_status,
      createdAt: new Date(row.subscribers.created_at), updatedAt: new Date(row.subscribers.updated_at) },
  }));
  const last = items.at(-1);
  return { items, hasNext, nextCursor: hasNext && last ? encodeHistoryCursor({ at: last.reading.readingAt.toISOString(), id: last.reading.id }) : null };
}

function mapSupabaseInvoice(row: any) {
  return {
    id: Number(row.id), tenantId: Number(row.tenant_id), siteId: Number(row.site_id), subscriberId: Number(row.subscriber_id),
    readingId: row.reading_id === null ? null : Number(row.reading_id), tariffId: row.tariff_id === null ? null : Number(row.tariff_id),
    invoiceNo: row.invoice_no, clientOperationId: row.client_operation_id, billingPeriod: row.billing_period, issueDate: new Date(row.issue_date), dueDate: new Date(row.due_date),
    previousReading: row.previous_reading === null ? null : String(row.previous_reading), currentReading: row.current_reading === null ? null : String(row.current_reading),
    consumptionKwh: String(row.consumption_kwh), pricePerKwh: String(row.price_per_kwh), fixedFee: String(row.fixed_fee), taxAmount: String(row.tax_amount),
    discountAmount: String(row.discount_amount), totalAmount: String(row.total_amount), paidAmount: String(row.paid_amount), balanceDue: String(row.balance_due),
    status: row.status, cycleKey: row.cycle_key ?? null, cycleStartAt: row.cycle_start_at ? new Date(row.cycle_start_at) : null, cycleEndAt: row.cycle_end_at ? new Date(row.cycle_end_at) : null, createdByUserId: row.created_by_user_id === null ? null : Number(row.created_by_user_id), createdAt: new Date(row.created_at), updatedAt: new Date(row.updated_at),
  };
}

const invoiceSelect = "id, tenant_id, site_id, subscriber_id, reading_id, tariff_id, invoice_no, client_operation_id, billing_period, issue_date, due_date, previous_reading, current_reading, consumption_kwh, price_per_kwh, fixed_fee, tax_amount, discount_amount, total_amount, paid_amount, balance_due, status, cycle_key, cycle_start_at, cycle_end_at, created_by_user_id, created_at, updated_at";

export async function listSupabaseInvoices(siteId: number) {
  const { data, error } = await supabaseAdmin().from("invoices")
    .select(invoiceSelect)
    .eq("site_id", siteId).order("issue_date", { ascending: false });
  if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل الفواتير من Supabase." });
  return (data ?? []).map(mapSupabaseInvoice);
}

export async function listSupabaseInvoicePage(siteId: number, input: { limit?: number; cursor?: string }): Promise<SupabaseHistoryPage<ReturnType<typeof mapSupabaseInvoice>>> {
  const limit = historyLimit(input.limit);
  const cursor = decodeHistoryCursor(input.cursor);
  let query = supabaseAdmin().from("invoices").select(invoiceSelect).eq("site_id", siteId);
  if (cursor) query = query.or(`issue_date.lt.${cursor.at},and(issue_date.eq.${cursor.at},id.lt.${cursor.id})`);
  const { data, error } = await query.order("issue_date", { ascending: false }).order("id", { ascending: false }).limit(limit + 1);
  if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل صفحة الفواتير من Supabase." });
  const rows = data ?? [];
  const hasNext = rows.length > limit;
  const items = rows.slice(0, limit).map(mapSupabaseInvoice);
  const last = items.at(-1);
  return { items, hasNext, nextCursor: hasNext && last ? encodeHistoryCursor({ at: last.issueDate.toISOString(), id: last.id }) : null };
}

export async function listSupabasePayments(siteId: number) {
  const admin = supabaseAdmin();
  const { data: paymentRows, error: paymentsError } = await admin.from("payments")
    .select("id, tenant_id, site_id, subscriber_id, invoice_id, payment_no, client_operation_id, amount, payment_method, transfer_from_account, transfer_from_type, transfer_to_account, transfer_to_type, reference_no, receipt_image_key, receipt_image_hash, status, collected_by_user_id, collector_session_id, paid_at, created_at")
    .eq("site_id", siteId).order("paid_at", { ascending: false });
  if (paymentsError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل الدفعات من Supabase." });
  const subscriberIds = Array.from(new Set((paymentRows ?? []).map((row) => Number(row.subscriber_id))));
  const invoiceIds = Array.from(new Set((paymentRows ?? []).flatMap((row) => row.invoice_id === null ? [] : [Number(row.invoice_id)])));
  const [{ data: subscriberRows, error: subscribersError }, { data: invoiceRows, error: invoicesError }] = await Promise.all([
    subscriberIds.length ? admin.from("subscribers").select("id, tenant_id, site_id, subscriber_no, full_name, phone, whatsapp_number, address, subscription_type, service_status, created_at, updated_at").in("id", subscriberIds) : Promise.resolve({ data: [], error: null }),
    invoiceIds.length ? admin.from("invoices").select("id, invoice_no").in("id", invoiceIds) : Promise.resolve({ data: [], error: null }),
  ]);
  if (subscribersError || invoicesError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل مراجع الدفعات من Supabase." });
  const subscriberById = new Map((subscriberRows ?? []).map((row) => [Number(row.id), {
    id: Number(row.id), tenantId: Number(row.tenant_id), siteId: Number(row.site_id), subscriberNo: row.subscriber_no, fullName: row.full_name,
    phone: row.phone, whatsappNumber: row.whatsapp_number, address: row.address, subscriptionType: row.subscription_type, serviceStatus: row.service_status,
    createdAt: new Date(row.created_at), updatedAt: new Date(row.updated_at),
  }]));
  const invoiceNoById = new Map((invoiceRows ?? []).map((row) => [Number(row.id), row.invoice_no]));
  return (await Promise.all((paymentRows ?? []).map(async (row) => {
    const subscriber = subscriberById.get(Number(row.subscriber_id));
    if (!subscriber) return [];
    const payment = {
      id: Number(row.id), tenantId: Number(row.tenant_id), siteId: Number(row.site_id), subscriberId: Number(row.subscriber_id), invoiceId: row.invoice_id === null ? null : Number(row.invoice_id),
      paymentNo: row.payment_no, clientOperationId: row.client_operation_id, amount: String(row.amount), paymentMethod: row.payment_method,
      transferFromAccount: row.transfer_from_account, transferFromType: row.transfer_from_type, transferToAccount: row.transfer_to_account, transferToType: row.transfer_to_type,
      referenceNo: row.reference_no, hasReceiptImage: Boolean(row.receipt_image_key), status: row.status,
      collectedByUserId: row.collected_by_user_id === null ? null : Number(row.collected_by_user_id), collectorSessionId: row.collector_session_id === null ? null : Number(row.collector_session_id),
      paidAt: new Date(row.paid_at), createdAt: new Date(row.created_at), receiptImageUrl: null,
    };
    return [{ payment, subscriber, invoiceNo: row.invoice_id === null ? null : invoiceNoById.get(Number(row.invoice_id)) ?? null }];
  }))).flat();
}

export async function listSupabasePaymentPage(siteId: number, input: { limit?: number; cursor?: string }): Promise<SupabaseHistoryPage<any>> {
  const limit = historyLimit(input.limit);
  const cursor = decodeHistoryCursor(input.cursor);
  let query = supabaseAdmin().from("payments")
    .select("id, tenant_id, site_id, subscriber_id, invoice_id, payment_no, client_operation_id, amount, payment_method, transfer_from_account, transfer_from_type, transfer_to_account, transfer_to_type, reference_no, receipt_image_key, receipt_image_hash, status, collected_by_user_id, collector_session_id, paid_at, created_at")
    .eq("site_id", siteId);
  if (cursor) query = query.or(`paid_at.lt.${cursor.at},and(paid_at.eq.${cursor.at},id.lt.${cursor.id})`);
  const { data: paymentRows, error } = await query.order("paid_at", { ascending: false }).order("id", { ascending: false }).limit(limit + 1);
  if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل صفحة الدفعات من Supabase." });
  const rows = paymentRows ?? [];
  const pageRows = rows.slice(0, limit);
  const subscriberIds = Array.from(new Set(pageRows.map((row: any) => Number(row.subscriber_id))));
  const invoiceIds = Array.from(new Set(pageRows.flatMap((row: any) => row.invoice_id === null ? [] : [Number(row.invoice_id)])));
  const admin = supabaseAdmin();
  const [{ data: subscribers, error: subscriberError }, { data: invoices, error: invoiceError }] = await Promise.all([
    subscriberIds.length ? admin.from("subscribers").select("id, tenant_id, site_id, subscriber_no, full_name, phone, whatsapp_number, address, subscription_type, service_status, created_at, updated_at").in("id", subscriberIds) : Promise.resolve({ data: [], error: null }),
    invoiceIds.length ? admin.from("invoices").select("id, invoice_no").in("id", invoiceIds) : Promise.resolve({ data: [], error: null }),
  ]);
  if (subscriberError || invoiceError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل مراجع صفحة الدفعات من Supabase." });
  const subscriberById = new Map((subscribers ?? []).map((row: any) => [Number(row.id), { id: Number(row.id), tenantId: Number(row.tenant_id), siteId: Number(row.site_id), subscriberNo: row.subscriber_no, fullName: row.full_name, phone: row.phone, whatsappNumber: row.whatsapp_number, address: row.address, subscriptionType: row.subscription_type, serviceStatus: row.service_status, createdAt: new Date(row.created_at), updatedAt: new Date(row.updated_at) }]));
  const invoiceNoById = new Map((invoices ?? []).map((row: any) => [Number(row.id), row.invoice_no]));
  const items = await Promise.all(pageRows.map(async (row: any) => {
    const subscriber = subscriberById.get(Number(row.subscriber_id));
    if (!subscriber) return null;
    return { payment: { id: Number(row.id), tenantId: Number(row.tenant_id), siteId: Number(row.site_id), subscriberId: Number(row.subscriber_id), invoiceId: row.invoice_id === null ? null : Number(row.invoice_id), paymentNo: row.payment_no, clientOperationId: row.client_operation_id, amount: String(row.amount), paymentMethod: row.payment_method, transferFromAccount: row.transfer_from_account, transferFromType: row.transfer_from_type, transferToAccount: row.transfer_to_account, transferToType: row.transfer_to_type, referenceNo: row.reference_no, hasReceiptImage: Boolean(row.receipt_image_key), status: row.status, collectedByUserId: row.collected_by_user_id === null ? null : Number(row.collected_by_user_id), collectorSessionId: row.collector_session_id === null ? null : Number(row.collector_session_id), paidAt: new Date(row.paid_at), createdAt: new Date(row.created_at), receiptImageUrl: null }, subscriber, invoiceNo: row.invoice_id === null ? null : invoiceNoById.get(Number(row.invoice_id)) ?? null };
  })).then((values) => values.filter(Boolean));
  const last = pageRows.at(-1) as any;
  return { items, hasNext: rows.length > limit, nextCursor: rows.length > limit && last ? encodeHistoryCursor({ at: new Date(last.paid_at).toISOString(), id: Number(last.id) }) : null };
}

export async function listSupabaseExpenses(siteId: number) {
  const { data, error } = await supabaseAdmin().from("expenses")
    .select("id, tenant_id, site_id, generator_id, company_account_id, category, description, amount, occurred_at, reference_no, created_by_user_id, created_at")
    .eq("site_id", siteId).order("occurred_at", { ascending: false });
  if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل المصروفات من Supabase." });
  return (data ?? []).map((row) => ({
    id: Number(row.id), tenantId: Number(row.tenant_id), siteId: Number(row.site_id), generatorId: row.generator_id === null ? null : Number(row.generator_id),
    category: row.category, description: row.description, amount: String(row.amount), occurredAt: new Date(row.occurred_at), referenceNo: row.reference_no,
    createdByUserId: row.created_by_user_id === null ? null : Number(row.created_by_user_id), createdAt: new Date(row.created_at),
  }));
}

export async function listSupabaseExpensePage(siteId: number, input: { limit?: number; cursor?: string; startDate?: string; endDate?: string; companyAccountId?: number }, tenantId: number): Promise<SupabaseHistoryPage<any>> {
  const limit = historyLimit(input.limit);
  const cursor = decodeHistoryCursor(input.cursor);
  let query = supabaseAdmin().from("expenses").select("id, tenant_id, site_id, generator_id, company_account_id, category, description, amount, occurred_at, reference_no, created_by_user_id, created_at").eq("tenant_id", tenantId).eq("site_id", siteId);
  if (input.companyAccountId) query = query.eq("company_account_id", input.companyAccountId);
  if (input.startDate) query = query.gte("occurred_at", gazaDateBoundary(input.startDate).toISOString());
  if (input.endDate) query = query.lt("occurred_at", gazaDateBoundary(nextDateKey(input.endDate)).toISOString());
  if (cursor) query = query.or(`occurred_at.lt.${cursor.at},and(occurred_at.eq.${cursor.at},id.lt.${cursor.id})`);
  const { data, error } = await query.order("occurred_at", { ascending: false }).order("id", { ascending: false }).limit(limit + 1);
  if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل صفحة المصروفات من Supabase." });
  const rows = data ?? [];
  const items = rows.slice(0, limit).map((row: any) => ({ id: Number(row.id), tenantId: Number(row.tenant_id), siteId: Number(row.site_id), generatorId: row.generator_id === null ? null : Number(row.generator_id), companyAccountId: row.company_account_id == null ? null : Number(row.company_account_id), category: row.category, description: row.description, amount: String(row.amount), occurredAt: new Date(row.occurred_at), referenceNo: row.reference_no, createdByUserId: row.created_by_user_id === null ? null : Number(row.created_by_user_id), createdAt: new Date(row.created_at) }));
  const last = items.at(-1);
  return { items, hasNext: rows.length > limit, nextCursor: rows.length > limit && last ? encodeHistoryCursor({ at: last.occurredAt.toISOString(), id: last.id }) : null };
}

type SupabaseReportInvoice = {
  id: number;
  siteId: number;
  subscriberId: number;
  invoiceNo: string;
  billingPeriod: string;
  issueDate: Date;
  dueDate: Date;
  totalAmount: number;
  paidAmount: number;
  balanceDue: number;
  consumptionKwh: number;
  status: string;
};

type SupabaseReportPayment = {
  payment: {
    id: number;
    siteId: number;
    subscriberId: number;
    paymentNo: string;
    amount: string;
    paymentMethod: string;
    transferFromAccount: string | null;
    transferFromType: string | null;
    transferToAccount: string | null;
    transferToType: string | null;
    status: string;
    paidAt: Date;
    collectedByUserId: number | null;
  };
};

type SupabaseReportExpense = { siteId: number; amount: number; occurredAt: Date };
type SupabaseReportSubscriber = { id: number; siteId: number; fullName: string; subscriberNo: string };

export async function readSupabaseReportPages<T>(
  readPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  errorMessage: string,
): Promise<T[]> {
  // Keep requests comfortably under PostgREST's usual row cap and follow every page.
  const pageSize = 500;
  const result: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const page = await readPage(from, from + pageSize - 1);
    if (page.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: errorMessage });
    const rows = page.data ?? [];
    result.push(...rows);
    if (rows.length < pageSize) break;
  }
  return result;
}

function normalizeReportSiteIds(siteIds: number[]) {
  return Array.from(new Set(siteIds.map(Number).filter((siteId) => Number.isInteger(siteId) && siteId > 0)));
}

/**
 * Report-only invoice query. Apply date/cycle and tenant/site filters in PostgreSQL;
 * do not reuse the general invoice listing, which intentionally returns the full history.
 */
export async function listSupabaseReportInvoices(input: {
  tenantId: number;
  siteIds: number[];
  start?: Date;
  endExclusive?: Date;
  billingPeriod?: string;
  summaryOnly?: boolean;
}): Promise<SupabaseReportInvoice[]> {
  const siteIds = normalizeReportSiteIds(input.siteIds);
  if (!siteIds.length) return [];
  if (!input.billingPeriod && (!input.start || !input.endExclusive || input.start >= input.endExclusive)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "الفترة الزمنية لتقرير الفواتير غير صالحة." });
  }
  const admin = supabaseAdmin();
  const rows = await readSupabaseReportPages((from, to) => {
    let query: any = admin.from("invoices")
      .select(input.summaryOnly
        ? "id, site_id, subscriber_id, issue_date, due_date, total_amount, balance_due, status"
        : "id, site_id, subscriber_id, invoice_no, billing_period, issue_date, due_date, total_amount, paid_amount, balance_due, consumption_kwh, status")
      .eq("tenant_id", input.tenantId)
      .in("site_id", siteIds);
    if (input.billingPeriod) query = query.eq("billing_period", input.billingPeriod);
    else query = query.gte("issue_date", input.start!.toISOString()).lt("issue_date", input.endExclusive!.toISOString());
    return query.order("id", { ascending: true }).range(from, to);
  }, "تعذر تحميل فواتير الفترة المحددة من Supabase.");
  return rows.map((row: any) => ({
    id: Number(row.id),
    siteId: Number(row.site_id),
    subscriberId: Number(row.subscriber_id),
    invoiceNo: String(row.invoice_no ?? ""),
    billingPeriod: String(row.billing_period ?? ""),
    issueDate: new Date(row.issue_date),
    dueDate: new Date(row.due_date),
    totalAmount: Number(row.total_amount ?? 0),
    paidAmount: Number(row.paid_amount ?? 0),
    balanceDue: Number(row.balance_due ?? 0),
    consumptionKwh: Number(row.consumption_kwh ?? 0),
    status: row.status,
  }));
}

/**
 * Lightweight report payment query. Receipt image keys/URLs are deliberately
 * omitted because aggregate reports never render or open payment images.
 */
export async function listSupabaseReportPayments(input: {
  tenantId: number;
  siteIds: number[];
  start: Date;
  endExclusive: Date;
  summaryOnly?: boolean;
}): Promise<SupabaseReportPayment[]> {
  const siteIds = normalizeReportSiteIds(input.siteIds);
  if (!siteIds.length) return [];
  if (input.start >= input.endExclusive) throw new TRPCError({ code: "BAD_REQUEST", message: "الفترة الزمنية لتقرير التحصيلات غير صالحة." });
  const admin = supabaseAdmin();
  const rows = await readSupabaseReportPages((from, to) =>
    admin.from("payments")
      .select(input.summaryOnly
        ? "id, site_id, subscriber_id, amount, status, paid_at"
        : "id, site_id, subscriber_id, payment_no, amount, payment_method, transfer_from_account, transfer_from_type, transfer_to_account, transfer_to_type, status, paid_at, collected_by_user_id")
      .eq("tenant_id", input.tenantId)
      .in("site_id", siteIds)
      .gte("paid_at", input.start.toISOString())
      .lt("paid_at", input.endExclusive.toISOString())
      .order("id", { ascending: true })
      .range(from, to),
  "تعذر تحميل تحصيلات الفترة المحددة من Supabase.");
  return rows.map((row: any) => ({
    payment: {
      id: Number(row.id),
      siteId: Number(row.site_id),
      subscriberId: Number(row.subscriber_id),
      paymentNo: String(row.payment_no ?? ""),
      amount: String(row.amount),
      paymentMethod: String(row.payment_method ?? ""),
      transferFromAccount: row.transfer_from_account == null ? null : String(row.transfer_from_account),
      transferFromType: row.transfer_from_type == null ? null : String(row.transfer_from_type),
      transferToAccount: row.transfer_to_account == null ? null : String(row.transfer_to_account),
      transferToType: row.transfer_to_type == null ? null : String(row.transfer_to_type),
      status: String(row.status ?? ""),
      paidAt: new Date(row.paid_at),
      collectedByUserId: row.collected_by_user_id == null ? null : Number(row.collected_by_user_id),
    },
  }));
}

export async function listSupabaseReportExpenses(input: {
  tenantId: number;
  siteIds: number[];
  start: Date;
  endExclusive: Date;
}): Promise<SupabaseReportExpense[]> {
  const siteIds = normalizeReportSiteIds(input.siteIds);
  if (!siteIds.length) return [];
  if (input.start >= input.endExclusive) throw new TRPCError({ code: "BAD_REQUEST", message: "الفترة الزمنية لتقرير المصروفات غير صالحة." });
  const admin = supabaseAdmin();
  const rows = await readSupabaseReportPages((from, to) =>
    admin.from("expenses")
      .select("site_id, amount, occurred_at")
      .eq("tenant_id", input.tenantId)
      .in("site_id", siteIds)
      .gte("occurred_at", input.start.toISOString())
      .lt("occurred_at", input.endExclusive.toISOString())
      .order("id", { ascending: true })
      .range(from, to),
  "تعذر تحميل مصروفات الفترة المحددة من Supabase.");
  return rows.map((row: any) => ({ siteId: Number(row.site_id), amount: Number(row.amount ?? 0), occurredAt: new Date(row.occurred_at) }));
}

export async function listSupabaseReportSubscribers(input: {
  tenantId: number;
  siteIds: number[];
  subscriberIds: number[];
}): Promise<SupabaseReportSubscriber[]> {
  const siteIds = normalizeReportSiteIds(input.siteIds);
  const subscriberIds = Array.from(new Set(input.subscriberIds.map(Number).filter((id) => Number.isInteger(id) && id > 0)));
  if (!siteIds.length || !subscriberIds.length) return [];
  const admin = supabaseAdmin();
  const result: SupabaseReportSubscriber[] = [];
  // The report only needs names for subscribers attached to outstanding invoices.
  // Chunk the IN predicate to keep request URLs small and concurrency bounded.
  for (let offset = 0; offset < subscriberIds.length; offset += 1000) {
    const batches = [];
    for (let index = offset; index < Math.min(offset + 1000, subscriberIds.length); index += 200) {
      batches.push(subscriberIds.slice(index, index + 200));
    }
    const pages = await Promise.all(batches.map(async (ids) => {
      const { data, error } = await admin.from("subscribers")
        .select("id, site_id, full_name, subscriber_no")
        .eq("tenant_id", input.tenantId)
        .in("site_id", siteIds)
        .in("id", ids)
        .is("archived_at", null);
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل أسماء المشتركين أصحاب المستحقات من Supabase." });
      return data ?? [];
    }));
    for (const rows of pages) {
      result.push(...rows.map((row: any) => ({
        id: Number(row.id),
        siteId: Number(row.site_id),
        fullName: row.full_name,
        subscriberNo: row.subscriber_no,
      })));
    }
  }
  return result;
}

export async function getSupabaseFinancialOverview(site: SupabaseSite, includeDetails = true) {
  const admin = supabaseAdmin();
  const tenantId = Number(site.tenantId);
  const aggregate = await admin.rpc("powerhub_dashboard_financial_overview", {
    p_tenant_id: tenantId,
    p_site_id: Number(site.id),
    p_now: new Date().toISOString(),
    p_include_details: includeDetails,
  });
  if (!aggregate.error) {
    return dashboardRpcObject(aggregate.data, "dashboard.financialOverview.aggregate");
  }
  if (!isMissingDashboardAggregateRpc(aggregate.error, "powerhub_dashboard_financial_overview")) {
    logSupabaseDataReadFailure("dashboard.financialOverview.aggregate", aggregate.error);
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل الملخص المالي من Supabase." });
  }
  // Preserve compatibility until the matching SQL migration is installed.
  // Supabase's configured REST row cap can silently truncate ordinary selects.
  // Read every table in ordered, bounded pages so the debt totals and search workspace are complete.
  const readAllPages = async <T,>(area: string, readPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string; code?: string } | null }>) => {
    const result: T[] = [];
    for (let from = 0; ; from += 1000) {
      const page = await readPage(from, from + 999);
      if (page.error) {
        logSupabaseDataReadFailure(area, page.error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `تعذر تحميل بيانات الملخص المالي من Supabase (${area}).` });
      }
      const rows = page.data ?? [];
      result.push(...rows);
      if (rows.length < 1000) break;
    }
    return result;
  };
  const [invoices, payments, expenses, subscribers] = await Promise.all([
    readAllPages("dashboard.financialOverview.invoices", (from, to) => admin.from("invoices").select("id, site_id, subscriber_id, invoice_no, issue_date, due_date, total_amount, paid_amount, balance_due, status").eq("site_id", site.id).order("id", { ascending: true }).range(from, to)),
    readAllPages("dashboard.financialOverview.payments", (from, to) => admin.from("payments").select("site_id, subscriber_id, amount, status, paid_at").eq("site_id", site.id).order("id", { ascending: true }).range(from, to)),
    readAllPages("dashboard.financialOverview.expenses", (from, to) => admin.from("expenses").select("site_id, amount, occurred_at").eq("site_id", site.id).order("id", { ascending: true }).range(from, to)),
    readAllPages("dashboard.financialOverview.subscribers", (from, to) => admin.from("subscribers").select("id, full_name, subscriber_no, service_status").eq("site_id", site.id).order("id", { ascending: true }).range(from, to)),
  ]);
  const byId = new Map(subscribers.map((row) => [Number(row.id), row]));
  const overview = buildFinancialOverview({
    branches: [{ id: site.id, name: site.name, activeSubscribers: subscribers.filter((row) => row.service_status === "active").length }],
    invoices: invoices.map((row) => ({ id: Number(row.id), siteId: Number(row.site_id), subscriberId: Number(row.subscriber_id), subscriberName: byId.get(Number(row.subscriber_id))?.full_name ?? "مشترك", subscriberNo: byId.get(Number(row.subscriber_id))?.subscriber_no ?? "—", invoiceNo: row.invoice_no, issueDate: new Date(row.issue_date), dueDate: new Date(row.due_date), totalAmount: Number(row.total_amount), paidAmount: Number(row.paid_amount), balanceDue: Number(row.balance_due), status: row.status })),
    payments: payments.map((row) => ({ siteId: Number(row.site_id), subscriberId: Number(row.subscriber_id), amount: Number(row.amount), status: row.status, paidAt: new Date(row.paid_at) })),
    expenses: expenses.map((row) => ({ siteId: Number(row.site_id), amount: Number(row.amount), occurredAt: new Date(row.occurred_at) })),
  });
  return includeDetails ? overview : { ...overview, outstandingInvoices: [] };
}

export async function listSupabaseCompanyAccounts(input: { tenantId: number; branchId?: number; from?: Date | null; to?: Date | null }) {
  const admin = supabaseAdmin();
  let { data: accountRows, error: accountsError } = await admin.from("company_accounts")
    .select("id, tenant_id, name, account_type, phone_number, color, opening_balance, is_active, allow_payment_documentation, created_at, updated_at")
    .eq("tenant_id", input.tenantId).eq("is_active", true).order("id", { ascending: true });
  if (accountsError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل حسابات الشركة من Supabase." });
  // Dashboard reads must remain read-only: do not create default financial accounts as a side effect.
  // An empty result means the tenant has not configured any company accounts yet.
  const accountIds = (accountRows ?? []).map((row) => Number(row.id));
  const [siteLinksResult, sitesResult, transactionsResult, balancesResult] = await Promise.all([
    accountIds.length ? admin.from("company_account_sites").select("account_id, site_id").eq("tenant_id", input.tenantId).in("account_id", accountIds) : Promise.resolve({ data: [], error: null }),
    admin.from("sites").select("id, name").eq("tenant_id", input.tenantId),
    accountIds.length ? admin.from("account_transactions").select("id, tenant_id, account_id, transaction_type, amount, description, reference_no, related_payment_id, related_account_id, created_by_user_id, occurred_at, created_at")
      .eq("tenant_id", input.tenantId).in("account_id", accountIds)
      .gte("occurred_at", input.from?.toISOString() ?? "1970-01-01T00:00:00.000Z").lte("occurred_at", input.to?.toISOString() ?? "9999-12-31T23:59:59.999Z").order("occurred_at", { ascending: false }).order("id", { ascending: false }).limit(1000) : Promise.resolve({ data: [], error: null }),
    accountIds.length ? admin.rpc("powerhub_company_account_balance_rollup", { p_tenant_id: input.tenantId, p_account_ids: accountIds }) : Promise.resolve({ data: [], error: null }),
  ]);
  if (siteLinksResult.error || sitesResult.error || transactionsResult.error || balancesResult.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل حركات أو أرصدة حسابات الشركة من Supabase." });
  const balanceByAccountId = new Map<number, number>((balancesResult.data ?? []).map((row: { account_id: number | string; balance: number | string }) => [Number(row.account_id), Number(row.balance)]));
  const siteNameById = new Map((sitesResult.data ?? []).map((site) => [Number(site.id), site.name]));
  const linksByAccount = new Map<number, Array<{ accountId: number; siteId: number; siteName: string }>>();
  for (const link of siteLinksResult.data ?? []) {
    const accountId = Number(link.account_id); const siteId = Number(link.site_id);
    linksByAccount.set(accountId, [...(linksByAccount.get(accountId) ?? []), { accountId, siteId, siteName: siteNameById.get(siteId) ?? "فرع" }]);
  }
  const transactionsByAccount = new Map<number, SupabaseAccountTransaction[]>();
  for (const row of transactionsResult.data ?? []) {
    const accountId = Number(row.account_id);
    const transaction: SupabaseAccountTransaction = { id: Number(row.id), tenantId: Number(row.tenant_id), accountId, transactionType: row.transaction_type, amount: String(row.amount), description: row.description, referenceNo: row.reference_no, relatedPaymentId: row.related_payment_id === null ? null : Number(row.related_payment_id), relatedAccountId: row.related_account_id === null ? null : Number(row.related_account_id), createdByUserId: row.created_by_user_id === null ? null : Number(row.created_by_user_id), occurredAt: new Date(row.occurred_at), createdAt: new Date(row.created_at) };
    transactionsByAccount.set(accountId, [...(transactionsByAccount.get(accountId) ?? []), transaction]);
  }
  return (accountRows ?? []).flatMap((row) => {
    const id = Number(row.id); const linkedSites = linksByAccount.get(id) ?? [];
    if (input.branchId && !linkedSites.some((link) => link.siteId === input.branchId)) return [];
    const transactions = transactionsByAccount.get(id) ?? [];
    const balance = balanceByAccountId.get(id);
    if (balance === undefined || !Number.isFinite(balance)) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر احتساب الرصيد الكامل لحساب الشركة." });
    }
    return [{ id, tenantId: Number(row.tenant_id), name: row.name, accountType: row.account_type, phoneNumber: row.phone_number, color: row.color, openingBalance: String(row.opening_balance), isActive: row.is_active, allowPaymentDocumentation: Boolean(row.allow_payment_documentation), createdAt: new Date(row.created_at), updatedAt: new Date(row.updated_at), linkedSites, balance, transactions }];
  });
}

function logSupabaseDataReadFailure(area: string, error: { message: string; code?: string }) {
  // Keep query failures actionable without logging tenant/user IDs or query payloads.
  console.error("[PowerHub data read failed]", {
    area,
    code: error.code ?? "unknown",
    message: error.message,
  });
}

function isMissingDashboardAggregateRpc(error: { code?: string; message?: string } | null | undefined, functionName: string) {
  if (!error) return false;
  return error.code === "PGRST202"
    || error.code === "42883"
    || new RegExp(`could not find .*${functionName}.*schema cache|function .*${functionName}.*does not exist`, "i").test(error.message ?? "");
}

function dashboardRpcObject(data: unknown, area: string): Record<string, unknown> {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `تعذر تحميل بيانات لوحة التحكم من Supabase (${area}).` });
  }
  return data as Record<string, unknown>;
}

export async function getSupabaseDashboardSummary(siteId: number, tenantId: number) {
  const admin = supabaseAdmin();
  const aggregate = await admin.rpc("powerhub_dashboard_operational_summary", { p_tenant_id: tenantId, p_site_id: siteId });
  if (!aggregate.error) {
    const result = dashboardRpcObject(aggregate.data, "dashboard.summary.aggregate");
    return {
      subscribers: Number(result.subscribers ?? 0),
      generators: {
        active: Number(objectValue(result.generators).active ?? 0),
        maintenance: Number(objectValue(result.generators).maintenance ?? 0),
      },
      financial: {
        invoiced: Number(objectValue(result.financial).invoiced ?? 0),
        collected: Number(objectValue(result.financial).collected ?? 0),
        outstanding: Number(objectValue(result.financial).outstanding ?? 0),
        expenses: Number(objectValue(result.financial).expenses ?? 0),
        operatingProfit: Number(objectValue(result.financial).operatingProfit ?? 0),
      },
      energyKwh: Number(result.energyKwh ?? 0),
      failedNotifications: Number(result.failedNotifications ?? 0),
    };
  }
  if (!isMissingDashboardAggregateRpc(aggregate.error, "powerhub_dashboard_operational_summary")) {
    logSupabaseDataReadFailure("dashboard.summary.aggregate", aggregate.error);
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل ملخص لوحة التحكم من Supabase." });
  }
  // Compatibility during a migration-first rollout: use the existing paged path
  // only when the aggregate function has not yet been installed, never on data/permission errors.
  // Avoid a preliminary round of SELECTs whose rows were discarded before the
  // complete paged reads below. The dashboard only needs these four projections.
  const readAllPages = async <T,>(area: string, readPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string; code?: string } | null }>) => {
    const result: T[] = [];
    for (let from = 0; ; from += 1000) {
      const page = await readPage(from, from + 999);
      if (page.error) {
        logSupabaseDataReadFailure(area, page.error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `تعذر تحميل بيانات لوحة التشغيل من Supabase (${area}).` });
      }
      const rows = page.data ?? [];
      result.push(...rows);
      if (rows.length < 1000) break;
    }
    return result;
  };
  const [subscriberRows, generatorRows, invoiceRows, expenseRows] = await Promise.all([
    readAllPages("dashboard.summary.subscribers", (from, to) => admin.from("subscribers").select("id, service_status").eq("tenant_id", tenantId).eq("site_id", siteId).is("archived_at", null).order("id", { ascending: true }).range(from, to)),
    readAllPages("dashboard.summary.generators", (from, to) => admin.from("generators").select("status").eq("tenant_id", tenantId).eq("site_id", siteId).order("id", { ascending: true }).range(from, to)),
    readAllPages("dashboard.summary.invoices", (from, to) => admin.from("invoices").select("total_amount, paid_amount, balance_due, consumption_kwh").eq("tenant_id", tenantId).eq("site_id", siteId).neq("status", "cancelled").neq("status", "draft").order("id", { ascending: true }).range(from, to)),
    readAllPages("dashboard.summary.expenses", (from, to) => admin.from("expenses").select("amount").eq("tenant_id", tenantId).eq("site_id", siteId).order("id", { ascending: true }).range(from, to)),
  ]);
  const subscriberIds = subscriberRows.map((row) => Number((row as { id: number }).id)).filter(Number.isInteger);
  const notificationRows = await readAllPages("dashboard.summary.notifications", (from, to) => admin.from("notification_messages").select("status").eq("tenant_id", tenantId).in("subscriber_id", subscriberIds.length ? subscriberIds : [-1]).order("id", { ascending: true }).range(from, to));
  const activeSubscribers = subscriberRows.filter((row) => (row as { service_status: string }).service_status === "active").length;
  const activeGenerators = generatorRows.filter((row) => (row as { status: string }).status === "active").length;
  const maintenanceGenerators = generatorRows.filter((row) => (row as { status: string }).status === "maintenance").length;
  const invoiceTotals = invoiceRows.reduce((totals, raw) => {
    const row = raw as { total_amount: number | string | null; paid_amount: number | string | null; balance_due: number | string | null; consumption_kwh: number | string | null };
    return {
      invoiced: totals.invoiced + Number(row.total_amount ?? 0),
      paid: totals.paid + Number(row.paid_amount ?? 0),
      outstanding: totals.outstanding + Number(row.balance_due ?? 0),
      energy: totals.energy + Number(row.consumption_kwh ?? 0),
    };
  }, { invoiced: 0, paid: 0, outstanding: 0, energy: 0 });
  const expenses = expenseRows.reduce((total, raw) => total + Number((raw as { amount: number | string | null }).amount ?? 0), 0);
  const failedNotifications = notificationRows.filter((row) => (row as { status: string }).status === "failed").length;
  return {
    subscribers: activeSubscribers, generators: { active: activeGenerators, maintenance: maintenanceGenerators },
    financial: { invoiced: invoiceTotals.invoiced, collected: invoiceTotals.paid, outstanding: invoiceTotals.outstanding, expenses, operatingProfit: invoiceTotals.paid - expenses },
    energyKwh: invoiceTotals.energy, failedNotifications,
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function configuredSubscriberLimit(plan: string, value: unknown) {
  const defaults: Record<string, number> = { basic: 150, advanced: 300, professional: 500, business: 750, vip: 900 };
  const limits = objectValue(objectValue(value).limits);
  const candidate = limits[plan];
  const parsed = typeof candidate === "number" ? candidate : typeof candidate === "string" ? Number(candidate) : NaN;
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 100000 ? parsed : (defaults[plan] ?? defaults.basic);
}

function subscriberOverride(tenantId: number, value: unknown) {
  const override = objectValue(objectValue(objectValue(value).overrides)[String(tenantId)]);
  const candidate = override.subscriberLimit;
  return typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 0 ? candidate : undefined;
}

function isMissingSubscriberQuotaSummaryRpc(error: { code?: string; message?: string } | null | undefined) {
  if (!error) return false;
  return error.code === "PGRST202"
    || error.code === "42883"
    || /could not find .*powerhub_subscriber_quota_summary.*schema cache|function .*powerhub_subscriber_quota_summary.*does not exist/i.test(error.message ?? "");
}

export async function getSupabaseOwnerSubscriberQuota(tenantId: number) {
  const admin = supabaseAdmin();
  // The one-round-trip RPC is deployed with this PR's migration. Until that migration
  // has been applied to a production database, fall back only for Postgres/PostgREST
  // "function missing" errors. Network, permission, and data errors must not be hidden.
  const summary = await admin.rpc("powerhub_subscriber_quota_summary", { p_tenant_id: tenantId });
  if (!summary.error) {
    const row = Array.isArray(summary.data) ? summary.data[0] : null;
    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "مساحة صاحب المولد غير موجودة." });
    const plan = String(row.package_code ?? "");
    const rawLimit = row.quota_limit;
    const parsedLimit = typeof rawLimit === "number" || typeof rawLimit === "string" ? Number(rawLimit) : NaN;
    const limit = Number.isFinite(parsedLimit) ? Math.max(0, parsedLimit) : configuredSubscriberLimit(plan, null);
    const parsedCount = Number(row.current_count ?? 0);
    const currentCount = Number.isFinite(parsedCount) ? Math.max(0, parsedCount) : 0;
    return { limit, currentCount, remaining: Math.max(0, limit - currentCount), plan };
  }

  if (!isMissingSubscriberQuotaSummaryRpc(summary.error)) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل حصة المشتركين من Supabase." });
  }

  // Backward-compatible rollout path: three parallel reads preserve behavior if the
  // migration has not yet reached the target database. The create RPC remains the
  // authoritative atomic quota gate, so this preflight is never an access-control decision.
  const [tenantResult, countResult, quotaResult] = await Promise.all([
    admin.from("tenant_subscriptions")
      .select("package_code")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    // Match powerhub_create_subscriber's current quota count, which includes archived rows.
    admin.from("subscribers")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId),
    admin.rpc("powerhub_effective_tenant_quota", { p_tenant_id: tenantId, p_resource: "subscribers" }),
  ]);
  if (tenantResult.error || countResult.error || quotaResult.error) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل حصة المشتركين من Supabase." });
  }
  if (!tenantResult.data) throw new TRPCError({ code: "NOT_FOUND", message: "مساحة صاحب المولد غير موجودة." });
  const plan = String(tenantResult.data.package_code ?? "");
  const quotaData = Array.isArray(quotaResult.data) ? quotaResult.data[0] : quotaResult.data;
  const rawLimit = typeof quotaData === "object" && quotaData !== null && "quota_limit" in quotaData
    ? (quotaData as { quota_limit?: unknown }).quota_limit
    : quotaData;
  const parsedLimit = typeof rawLimit === "number" || typeof rawLimit === "string" ? Number(rawLimit) : NaN;
  const limit = Number.isFinite(parsedLimit) ? Math.max(0, parsedLimit) : configuredSubscriberLimit(plan, null);
  const currentCount = Number(countResult.count ?? 0);
  return { limit, currentCount, remaining: Math.max(0, limit - currentCount), plan };
}

export type SupabaseQuotaResource = "subscribers" | "platformUser" | "fieldUser" | "branch" | "sms";

async function resolveSupabaseQuotaAlertState(input: {
  tenantId: number;
  resource: SupabaseQuotaResource;
  currentCount?: number;
  quotaLimit?: number;
}) {
  const admin = supabaseAdmin();
  let currentCount = input.currentCount;
  let quotaLimit = input.quotaLimit;
  if (currentCount == null) {
    if (input.resource === "subscribers") {
      const result = await admin.from("subscribers").select("id", { count: "exact", head: true }).eq("tenant_id", input.tenantId);
      if (result.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر احتساب استهلاك المشتركين." });
      currentCount = result.count ?? 0;
    } else if (input.resource === "branch") {
      const result = await admin.from("sites").select("id", { count: "exact", head: true }).eq("tenant_id", input.tenantId).neq("status", "archived");
      if (result.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر احتساب استهلاك الفروع." });
      currentCount = result.count ?? 0;
    } else if (input.resource === "fieldUser") {
      const result = await admin.from("tenant_members").select("user_id", { count: "exact", head: true })
        .eq("tenant_id", input.tenantId).eq("role", "technician").eq("is_active", true).eq("membership_status", "active");
      if (result.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر احتساب المستخدمين الميدانيين." });
      currentCount = result.count ?? 0;
    } else if (input.resource === "platformUser") {
      const result = await admin.from("tenant_members").select("user_id", { count: "exact", head: true })
        .eq("tenant_id", input.tenantId).eq("is_active", true).eq("membership_status", "active").neq("role", "owner");
      if (result.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر احتساب مستخدمي المنصة." });
      currentCount = result.count ?? 0;
    }
  }
  if (quotaLimit == null) {
    const result = await admin.rpc("powerhub_effective_tenant_quota", { p_tenant_id: input.tenantId, p_resource: input.resource });
    if (result.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل حد الميزة من Supabase." });
    const raw = Array.isArray(result.data) ? result.data[0] : result.data;
    quotaLimit = Number(raw ?? 0);
  }
  return { currentCount: currentCount ?? 0, quotaLimit: quotaLimit ?? 0 };
}

export async function recordSupabaseQuotaAlert(input: {
  tenantId: number;
  siteId: number;
  userId: number;
  resource: SupabaseQuotaResource;
  alertType?: "reached" | "blocked_attempt";
  currentCount?: number;
  quotaLimit?: number;
}) {
  const state = await resolveSupabaseQuotaAlertState(input);
  if (state.quotaLimit <= 0 || state.currentCount < state.quotaLimit) return { recorded: false, alertId: null };
  const admin = supabaseAdmin();
  const subscription = await admin.from("tenant_subscriptions").select("id")
    .eq("tenant_id", input.tenantId).in("status", ["trial", "active"])
    .order("ends_at", { ascending: false, nullsFirst: false }).order("id", { ascending: false }).limit(1).maybeSingle();
  if (subscription.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحديد دورة الاشتراك لتنبيه الحصة." });
  const { data, error } = await admin.rpc("powerhub_record_quota_alert", {
    p_tenant_id: input.tenantId,
    p_site_id: input.siteId,
    p_user_id: input.userId,
    p_resource: input.resource,
    p_alert_type: input.alertType ?? "reached",
    p_current_count: state.currentCount,
    p_quota_limit: state.quotaLimit,
    p_subscription_id: subscription.data?.id ? Number(subscription.data.id) : null,
  });
  if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تسجيل تنبيه الحصة." });
  return { recorded: Boolean(data?.[0]?.recorded), alertId: data?.[0]?.alert_id ? Number(data[0].alert_id) : null };
}

export async function recordSupabaseSubscriberQuotaAlert(input: {
  tenantId: number;
  siteId: number;
  userId: number;
  quota: { limit: number; currentCount: number; remaining: number; plan: string };
  blockedAttempt?: boolean;
}) {
  return recordSupabaseQuotaAlert({
    tenantId: input.tenantId,
    siteId: input.siteId,
    userId: input.userId,
    resource: "subscribers",
    alertType: input.blockedAttempt ? "blocked_attempt" : "reached",
    currentCount: input.quota.currentCount,
    quotaLimit: input.quota.limit,
  });
}

export async function writeSupabaseAudit(input: { userId?: number; tenantId: number; siteId: number; entityType: string; entityId: string; action: string; beforeData?: unknown; afterData?: unknown; metadata?: unknown }) {
  const admin = supabaseAdmin();
  const { data: actor, error: actorError } = input.userId ? await admin.from("users").select("platform_role").eq("id", input.userId).maybeSingle() : { data: null, error: null };
  if (actorError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل منفذ العملية للتدقيق." });
  const { error } = await admin.from("audit_logs").insert({
    tenant_id: input.tenantId, site_id: input.siteId, user_id: input.userId ?? null, actor_platform_role: actor?.platform_role ?? null,
    entity_type: input.entityType, entity_id: input.entityId, action: input.action, before_data: input.beforeData ?? null,
    after_data: input.afterData ?? null, metadata: input.metadata ?? null,
  });
  if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تسجيل التدقيق في Supabase." });
}
