import { TRPCError } from "@trpc/server";
import { type PowerCapability, type PowerRole } from "../shared/powerhub-rbac";
import { supabaseAdmin } from "./supabase-admin";

const allCapabilities: PowerCapability[] = [
  "manageSubscribers", "manageGenerators", "recordReadings", "accessFieldApp", "approveReadings", "manageTariffs",
  "issueInvoices", "collectPayments", "manageExpenses", "managePayroll", "manageTeam", "manageMessaging", "viewAudit",
];

type SupabaseSite = {
  id: number;
  tenantId: number;
  name: string;
  code: string;
  city: string | null;
  address: string | null;
  status: "active" | "inactive" | "archived";
  anomalyAlertPercent: number;
  invoiceDueDays: number;
  createdAt: Date;
};

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

export async function getSupabaseSite(siteId: number): Promise<SupabaseSite> {
  const { data, error } = await supabaseAdmin().from("sites")
    .select("id, tenant_id, name, code, city, address, status, anomaly_alert_percent, invoice_due_days, created_at")
    .eq("id", siteId).maybeSingle();
  if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل الفرع من Supabase." });
  if (!data) throw new TRPCError({ code: "NOT_FOUND", message: "المحطة غير موجودة." });
  return {
    id: Number(data.id), tenantId: Number(data.tenant_id), name: data.name, code: data.code, city: data.city, address: data.address,
    status: data.status as SupabaseSite["status"], anomalyAlertPercent: data.anomaly_alert_percent, invoiceDueDays: data.invoice_due_days,
    createdAt: new Date(data.created_at),
  };
}

export async function resolveSupabaseSiteAccess(userId: number, siteId: number): Promise<{ role: PowerRole; permissions: PowerCapability[]; tenantId: number }> {
  const admin = supabaseAdmin();
  const [{ data: user, error: userError }, site] = await Promise.all([
    admin.from("users").select("role").eq("id", userId).maybeSingle(),
    getSupabaseSite(siteId),
  ]);
  if (userError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل ملف المستخدم من Supabase." });
  if (!user) throw new TRPCError({ code: "UNAUTHORIZED", message: "ملف المستخدم غير متاح." });
  if (user.role === "admin") return { role: "owner", permissions: allCapabilities, tenantId: site.tenantId };

  const { data: membership, error: membershipError } = await admin.from("tenant_members")
    .select("role").eq("tenant_id", site.tenantId).eq("user_id", userId).eq("is_active", true).eq("membership_status", "active").maybeSingle();
  if (membershipError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر التحقق من عضوية المستأجر في Supabase." });
  if (!membership) throw new TRPCError({ code: "FORBIDDEN", message: "لا توجد عضوية فعالة في مساحة صاحب المولد لهذه المحطة." });
  if (membership.role === "owner") return { role: "owner", permissions: allCapabilities, tenantId: site.tenantId };

  const { data: profiles, error: profileError } = await admin.from("staff_profiles")
    .select("role, permissions, custom_role_id, suspension_started_at, suspension_ends_at, site_id")
    .eq("tenant_id", site.tenantId).eq("user_id", userId).eq("is_active", true);
  if (profileError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل تعيين المستخدم في Supabase." });
  const profile = (profiles ?? []).find((item) => Number(item.site_id) === siteId) ?? (profiles ?? []).find((item) => item.site_id === null);
  if (!profile) throw new TRPCError({ code: "FORBIDDEN", message: "لا يوجد تعيين فعال لك في هذه المحطة." });
  if (isSuspended(new Date(), dateOrNull(profile.suspension_started_at), dateOrNull(profile.suspension_ends_at))) {
    throw new TRPCError({ code: "FORBIDDEN", message: `تم توقيف حسابك مؤقتاً حتى ${new Date(profile.suspension_ends_at!).toLocaleString("ar-IQ")}.` });
  }
  let permissions = asPermissions(profile.permissions);
  if (!permissions.length && profile.custom_role_id) {
    const { data: customRole, error: customRoleError } = await admin.from("custom_permission_roles")
      .select("permissions").eq("id", profile.custom_role_id).eq("tenant_id", site.tenantId).eq("is_active", true).maybeSingle();
    if (customRoleError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل الصلاحيات المخصصة من Supabase." });
    permissions = asPermissions(customRole?.permissions);
  }
  return { role: asPowerRole(profile.role), permissions, tenantId: site.tenantId };
}

export async function requireSupabaseSiteRole(userId: number, siteId: number, allowed: PowerRole[], capability?: PowerCapability) {
  const access = await resolveSupabaseSiteAccess(userId, siteId);
  const { data: user, error: userError } = await supabaseAdmin().from("users").select("role").eq("id", userId).maybeSingle();
  if (userError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر التحقق من ملف المستخدم في Supabase." });
  if (user?.role !== "admin" && !allowed.includes(access.role) && (!capability || !access.permissions.includes(capability))) {
    throw new TRPCError({ code: "FORBIDDEN", message: "لا تملك صلاحية تنفيذ هذه العملية." });
  }
  if (user?.role !== "admin" && capability && access.permissions.length > 0 && !access.permissions.includes(capability)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "هذه العملية غير موجودة ضمن الصلاحيات الممنوحة لهذا الحساب." });
  }
  if (user?.role !== "admin" && capability) {
    const { data: policy, error: policyError } = await supabaseAdmin().from("platform_role_policies")
      .select("is_allowed").eq("role", access.role).eq("capability", capability).maybeSingle();
    if (policyError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر التحقق من سياسة الصلاحيات في Supabase." });
    if (policy && !policy.is_allowed) throw new TRPCError({ code: "FORBIDDEN", message: "هذه القدرة مقيّدة بسياسة المنصة للدور الحالي." });
  }
  return access;
}

export async function listSupabaseAccessibleSites(userId: number, isPlatformAdmin: boolean): Promise<SupabaseSite[]> {
  const admin = supabaseAdmin();
  if (isPlatformAdmin) {
    const { data, error } = await admin.from("sites").select("id, tenant_id, name, code, city, address, status, anomaly_alert_percent, invoice_due_days, created_at").order("created_at", { ascending: false });
    if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل الفروع من Supabase." });
    return (data ?? []).map((site) => ({ id: Number(site.id), tenantId: Number(site.tenant_id), name: site.name, code: site.code, city: site.city, address: site.address, status: site.status as SupabaseSite["status"], anomalyAlertPercent: site.anomaly_alert_percent, invoiceDueDays: site.invoice_due_days, createdAt: new Date(site.created_at) }));
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
    ownerTenantIds.length ? admin.from("sites").select("id, tenant_id, name, code, city, address, status, anomaly_alert_percent, invoice_due_days, created_at").in("tenant_id", ownerTenantIds).order("created_at", { ascending: false }) : Promise.resolve({ data: [], error: null }),
    requestedIds.length ? admin.from("sites").select("id, tenant_id, name, code, city, address, status, anomaly_alert_percent, invoice_due_days, created_at").in("id", requestedIds).order("created_at", { ascending: false }) : Promise.resolve({ data: [], error: null }),
  ]);
  if (ownedResult.error || assignedResult.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل الفروع المتاحة من Supabase." });
  return Array.from(new Map([...(ownedResult.data ?? []), ...(assignedResult.data ?? [])].map((site) => [Number(site.id), ({ id: Number(site.id), tenantId: Number(site.tenant_id), name: site.name, code: site.code, city: site.city, address: site.address, status: site.status as SupabaseSite["status"], anomalyAlertPercent: site.anomaly_alert_percent, invoiceDueDays: site.invoice_due_days, createdAt: new Date(site.created_at) })])).values());
}

export async function listSupabaseSubscribers(siteId: number) {
  const { data, error } = await supabaseAdmin().from("subscribers")
    .select("id, tenant_id, site_id, subscriber_no, client_operation_id, full_name, phone, whatsapp_number, address, subscription_type, service_status, created_at, updated_at")
    .eq("site_id", siteId).order("created_at", { ascending: false });
  if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل المشتركين من Supabase." });
  return (data ?? []).map((row) => ({
    id: Number(row.id), tenantId: Number(row.tenant_id), siteId: Number(row.site_id), subscriberNo: row.subscriber_no,
    clientOperationId: row.client_operation_id, fullName: row.full_name, phone: row.phone, whatsappNumber: row.whatsapp_number,
    address: row.address, subscriptionType: row.subscription_type, serviceStatus: row.service_status, createdAt: new Date(row.created_at), updatedAt: new Date(row.updated_at),
  }));
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

export async function listSupabaseGenerators(siteId: number) {
  const { data, error } = await supabaseAdmin().from("generators")
    .select("id, tenant_id, site_id, code, name, serial_number, rated_capacity_kw, fuel_type, fuel_level_liters, operating_hours, status, last_maintenance_at, created_at, updated_at")
    .eq("site_id", siteId).order("created_at", { ascending: false });
  if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل المولدات من Supabase." });
  return (data ?? []).map((row) => ({
    id: Number(row.id), tenantId: Number(row.tenant_id), siteId: Number(row.site_id), code: row.code, name: row.name, serialNumber: row.serial_number,
    ratedCapacityKw: String(row.rated_capacity_kw), fuelType: row.fuel_type, fuelLevelLiters: String(row.fuel_level_liters), operatingHours: String(row.operating_hours),
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

export async function getSupabaseDashboardSummary(siteId: number) {
  const admin = supabaseAdmin();
  const { data: subscriberRows, error: subscribersError } = await admin.from("subscribers").select("id, service_status").eq("site_id", siteId);
  if (subscribersError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل مؤشرات المشتركين من Supabase." });
  const subscriberIds = (subscriberRows ?? []).map((row) => Number(row.id));
  const [generatorResult, invoiceResult, expenseResult, notificationResult] = await Promise.all([
    admin.from("generators").select("status").eq("site_id", siteId),
    admin.from("invoices").select("status, total_amount, paid_amount, balance_due, consumption_kwh").eq("site_id", siteId),
    admin.from("expenses").select("amount").eq("site_id", siteId),
    subscriberIds.length ? admin.from("notification_messages").select("status").in("subscriber_id", subscriberIds) : Promise.resolve({ data: [], error: null }),
  ]);
  if (generatorResult.error || invoiceResult.error || expenseResult.error || notificationResult.error) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل مؤشرات لوحة التشغيل من Supabase." });
  }
  const activeSubscribers = (subscriberRows ?? []).filter((row) => row.service_status === "active").length;
  const activeGenerators = (generatorResult.data ?? []).filter((row) => row.status === "active").length;
  const maintenanceGenerators = (generatorResult.data ?? []).filter((row) => row.status === "maintenance").length;
  const invoiceTotals = (invoiceResult.data ?? []).filter((row) => row.status !== "cancelled").reduce((totals, row) => ({
    invoiced: totals.invoiced + Number(row.total_amount ?? 0), paid: totals.paid + Number(row.paid_amount ?? 0),
    outstanding: totals.outstanding + Number(row.balance_due ?? 0), energy: totals.energy + Number(row.consumption_kwh ?? 0),
  }), { invoiced: 0, paid: 0, outstanding: 0, energy: 0 });
  const expenses = (expenseResult.data ?? []).reduce((total, row) => total + Number(row.amount ?? 0), 0);
  const failedNotifications = (notificationResult.data ?? []).filter((row) => row.status === "failed").length;
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
  const defaults: Record<string, number> = { starter: 100, professional: 500, enterprise: 2000 };
  const limits = objectValue(objectValue(value).limits);
  const candidate = limits[plan];
  const parsed = typeof candidate === "number" ? candidate : typeof candidate === "string" ? Number(candidate) : NaN;
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 100000 ? parsed : (defaults[plan] ?? defaults.starter);
}

function subscriberOverride(tenantId: number, value: unknown) {
  const override = objectValue(objectValue(objectValue(value).overrides)[String(tenantId)]);
  const candidate = override.subscriberLimit;
  return typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 0 ? candidate : undefined;
}

export async function getSupabaseOwnerSubscriberQuota(tenantId: number) {
  const admin = supabaseAdmin();
  const [tenantResult, limitsResult, overridesResult, countResult] = await Promise.all([
    admin.from("tenants").select("plan").eq("id", tenantId).maybeSingle(),
    admin.from("platform_settings").select("value").eq("setting_key", "owner_subscriber_limits").maybeSingle(),
    admin.from("platform_settings").select("value").eq("setting_key", "owner_limit_overrides").maybeSingle(),
    admin.from("subscribers").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId),
  ]);
  if (tenantResult.error || limitsResult.error || overridesResult.error || countResult.error) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل حصة المشتركين من Supabase." });
  }
  if (!tenantResult.data) throw new TRPCError({ code: "NOT_FOUND", message: "مساحة صاحب المولد غير موجودة." });
  const plan = tenantResult.data.plan;
  const limit = subscriberOverride(tenantId, overridesResult.data?.value) ?? configuredSubscriberLimit(plan, limitsResult.data?.value);
  const currentCount = countResult.count ?? 0;
  return { limit, currentCount, remaining: Math.max(0, limit - currentCount), plan };
}

export async function recordSupabaseSubscriberQuotaAlert(input: { tenantId: number; siteId: number; userId: number; quota: { limit: number; currentCount: number; remaining: number; plan: string } }) {
  if (!Number.isFinite(input.quota.limit) || input.quota.limit <= 0 || input.quota.currentCount <= 0) return;
  const percentage = Math.min(100, Math.round((input.quota.currentCount / input.quota.limit) * 100));
  const threshold = percentage >= 100 ? 100 : percentage >= 80 ? 80 : 0;
  if (!threshold) return;
  const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
  const action = `subscriber_quota_alert_${threshold}`;
  const { data: existing, error } = await supabaseAdmin().from("audit_logs").select("id")
    .eq("tenant_id", input.tenantId).eq("action", action).gte("created_at", monthStart.toISOString()).maybeSingle();
  if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر التحقق من تنبيه حصة المشتركين في Supabase." });
  if (!existing) await writeSupabaseAudit({
    userId: input.userId, tenantId: input.tenantId, siteId: input.siteId, entityType: "owner_quota_alert", entityId: String(input.tenantId), action,
    metadata: { threshold, percentage, current: input.quota.currentCount, limit: input.quota.limit, remaining: input.quota.remaining, plan: input.quota.plan, automatic: true },
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
