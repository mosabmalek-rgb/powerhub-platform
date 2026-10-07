import { TRPCError } from "@trpc/server";
import { defaultCapabilitiesForRole, type PowerCapability, type PowerRole } from "../shared/powerhub-rbac";
import { supabaseAdmin } from "./supabase-admin";
import { requireTenantSubscription } from "./subscription-access";
import { storageGet } from "./storage";
import { buildFinancialOverview } from "./financial-overview-utils";
import { isActivePlatformAdmin } from "./platform-admin";

const allCapabilities: PowerCapability[] = [
  "manageSubscribers", "manageGenerators", "recordReadings", "accessFieldApp", "approveReadings", "manageTariffs",
  "issueInvoices", "collectPayments", "approvePaymentDocumentation", "manageExpenses", "managePayroll", "manageTeam", "manageMessaging", "viewAudit",
];

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
    .select("id, tenant_id, name, code, city, address, status, anomaly_alert_percent, invoice_due_days, created_at, tenants!inner(name)")
    .eq("id", siteId).maybeSingle();
  if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل الفرع من Supabase." });
  if (!data) throw new TRPCError({ code: "NOT_FOUND", message: "المحطة غير موجودة." });
  return {
    id: Number(data.id), tenantId: Number(data.tenant_id), tenantName: (data as any).tenants?.name ?? data.name, name: data.name, code: data.code, city: data.city, address: data.address,
    status: data.status as SupabaseSite["status"], anomalyAlertPercent: data.anomaly_alert_percent, invoiceDueDays: data.invoice_due_days,
    createdAt: new Date(data.created_at),
  };
}

export async function resolveSupabaseSiteAccess(userId: number, siteId: number): Promise<{ role: PowerRole; permissions: PowerCapability[]; tenantId: number; usesPermissionOverride: boolean }> {
  const admin = supabaseAdmin();
  const [{ data: user, error: userError }, site] = await Promise.all([
    admin.from("users").select("role, platform_role, account_status").eq("id", userId).maybeSingle(),
    getSupabaseSite(siteId),
  ]);
  if (userError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل ملف المستخدم من Supabase." });
  if (!user) throw new TRPCError({ code: "UNAUTHORIZED", message: "ملف المستخدم غير متاح." });
  const platformAdmin = isActivePlatformAdmin({ role: user.role, platformRole: user.platform_role, accountStatus: user.account_status });
  if (platformAdmin) return { role: "owner", permissions: allCapabilities, tenantId: site.tenantId, usesPermissionOverride: false };

  const { data: membership, error: membershipError } = await admin.from("tenant_members")
    .select("role").eq("tenant_id", site.tenantId).eq("user_id", userId).eq("is_active", true).eq("membership_status", "active").maybeSingle();
  if (membershipError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر التحقق من عضوية المستأجر في Supabase." });
  if (!membership) throw new TRPCError({ code: "FORBIDDEN", message: "لا توجد عضوية فعالة في مساحة صاحب المولد لهذه المحطة." });

  await requireTenantSubscription(site.tenantId, new Date(), { allowReadOnlyRetention: true });

  if (membership.role === "owner") return { role: "owner", permissions: allCapabilities, tenantId: site.tenantId, usesPermissionOverride: false };

  const { data: profiles, error: profileError } = await admin.from("staff_profiles")
    .select("role, permissions, custom_role_id, suspension_started_at, suspension_ends_at, site_id")
    .eq("tenant_id", site.tenantId).eq("user_id", userId).eq("is_active", true);
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
  if (!hasExplicitPermissions && profile.custom_role_id) {
    const { data: customRole, error: customRoleError } = await admin.from("custom_permission_roles")
      .select("permissions").eq("id", profile.custom_role_id).eq("tenant_id", site.tenantId).eq("is_active", true).maybeSingle();
    if (customRoleError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل الصلاحيات المخصصة من Supabase." });
    permissions = asPermissions(customRole?.permissions);
  }
  return { role, permissions, usesPermissionOverride, tenantId: site.tenantId };
}

export async function requireSupabaseSiteRole(userId: number, siteId: number, allowed: PowerRole[], capability?: PowerCapability) {
  const access = await resolveSupabaseSiteAccess(userId, siteId);
  const { data: user, error: userError } = await supabaseAdmin().from("users").select("role, platform_role, account_status").eq("id", userId).maybeSingle();
  if (userError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر التحقق من ملف المستخدم في Supabase." });
  const platformAdmin = isActivePlatformAdmin({ role: user?.role, platformRole: user?.platform_role, accountStatus: user?.account_status });
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
    const { data, error } = await admin.from("sites").select("id, tenant_id, name, code, city, address, status, anomaly_alert_percent, invoice_due_days, created_at, tenants!inner(name)").order("created_at", { ascending: false });
    if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل الفروع من Supabase." });
    return (data ?? []).map((site) => ({ id: Number(site.id), tenantId: Number(site.tenant_id), tenantName: (site as any).tenants?.name ?? site.name, name: site.name, code: site.code, city: site.city, address: site.address, status: site.status as SupabaseSite["status"], anomalyAlertPercent: site.anomaly_alert_percent, invoiceDueDays: site.invoice_due_days, createdAt: new Date(site.created_at) }));
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
    ownerTenantIds.length ? admin.from("sites").select("id, tenant_id, name, code, city, address, status, anomaly_alert_percent, invoice_due_days, created_at, tenants!inner(name)").in("tenant_id", ownerTenantIds).order("created_at", { ascending: false }) : Promise.resolve({ data: [], error: null }),
    requestedIds.length ? admin.from("sites").select("id, tenant_id, name, code, city, address, status, anomaly_alert_percent, invoice_due_days, created_at, tenants!inner(name)").in("id", requestedIds).order("created_at", { ascending: false }) : Promise.resolve({ data: [], error: null }),
  ]);
  if (ownedResult.error || assignedResult.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل الفروع المتاحة من Supabase." });
  return Array.from(new Map([...(ownedResult.data ?? []), ...(assignedResult.data ?? [])].map((site) => [Number(site.id), ({ id: Number(site.id), tenantId: Number(site.tenant_id), tenantName: (site as any).tenants?.name ?? site.name, name: site.name, code: site.code, city: site.city, address: site.address, status: site.status as SupabaseSite["status"], anomalyAlertPercent: site.anomaly_alert_percent, invoiceDueDays: site.invoice_due_days, createdAt: new Date(site.created_at) })])).values());
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


export async function getSupabaseSubscriberAccountStatement(siteId: number, subscriberId: number) {
  const admin = supabaseAdmin();
  const { data: subscriber, error: subscriberError } = await admin.from("subscribers")
    .select("id, tenant_id, site_id, subscriber_no, full_name, phone, whatsapp_number, address, subscription_type, service_status, created_at, updated_at")
    .eq("site_id", siteId).eq("id", subscriberId).maybeSingle();
  if (subscriberError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل ملف المشترك من Supabase." });
  if (!subscriber) throw new TRPCError({ code: "NOT_FOUND", message: "المشترك غير موجود ضمن الفرع المحدد." });

  const [invoiceSummaryResult, invoiceRecentResult, paymentSummaryResult, paymentRecentResult, readingRecentResult, readingCountResult] = await Promise.all([
    admin.from("invoices")
      .select("total_amount, paid_amount, balance_due, consumption_kwh")
      .eq("tenant_id", Number(subscriber.tenant_id)).eq("site_id", siteId).eq("subscriber_id", subscriberId)
      .neq("status", "cancelled"),
    admin.from("invoices")
      .select("id, invoice_no, billing_period, issue_date, due_date, previous_reading, current_reading, consumption_kwh, total_amount, paid_amount, balance_due, status, reading_id")
      .eq("tenant_id", Number(subscriber.tenant_id)).eq("site_id", siteId).eq("subscriber_id", subscriberId)
      .neq("status", "cancelled").order("issue_date", { ascending: false }).order("id", { ascending: false }).limit(21),
    admin.from("payments")
      .select("amount")
      .eq("tenant_id", Number(subscriber.tenant_id)).eq("site_id", siteId).eq("subscriber_id", subscriberId).eq("status", "completed"),
    admin.from("payments")
      .select("id, payment_no, invoice_id, amount, payment_method, transfer_from_account, transfer_from_type, transfer_to_account, transfer_to_type, reference_no, status, paid_at")
      .eq("tenant_id", Number(subscriber.tenant_id)).eq("site_id", siteId).eq("subscriber_id", subscriberId).eq("status", "completed")
      .order("paid_at", { ascending: false }).order("id", { ascending: false }).limit(21),
    admin.from("meter_readings")
      .select("id, reading_at, reading_value, previous_reading_value, consumption_kwh, capture_method, status, version_no, notes")
      .eq("tenant_id", Number(subscriber.tenant_id)).eq("subscriber_id", subscriberId)
      .order("reading_at", { ascending: false }).order("id", { ascending: false }).limit(21),
    admin.from("meter_readings")
      .select("id")
      .eq("tenant_id", Number(subscriber.tenant_id)).eq("subscriber_id", subscriberId),
  ]);

  if (invoiceSummaryResult.error || invoiceRecentResult.error || paymentSummaryResult.error || paymentRecentResult.error || readingRecentResult.error || readingCountResult.error) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل كشف حساب المشترك من Supabase." });
  }

  const invoiceSummary = invoiceSummaryResult.data ?? [];
  const paymentSummary = paymentSummaryResult.data ?? [];
  const recentInvoices = invoiceRecentResult.data ?? [];
  const recentPayments = paymentRecentResult.data ?? [];
  const recentReadings = readingRecentResult.data ?? [];

  const totalInvoiced = invoiceSummary.reduce((sum, row) => sum + Number(row.total_amount ?? 0), 0);
  const totalCollected = paymentSummary.reduce((sum, row) => sum + Number(row.amount ?? 0), 0);
  const totalOutstanding = invoiceSummary.reduce((sum, row) => sum + Number(row.balance_due ?? 0), 0);
  const totalConsumptionKwh = invoiceSummary.reduce((sum, row) => sum + Number(row.consumption_kwh ?? 0), 0);

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
      createdAt: new Date(subscriber.created_at),
      updatedAt: new Date(subscriber.updated_at),
    },
    summary: {
      invoiceCount: invoiceSummary.length,
      paymentCount: paymentSummary.length,
      readingCount: (readingCountResult.data ?? []).length,
      totalInvoiced,
      totalCollected,
      totalOutstanding,
      totalConsumptionKwh,
      lastPaymentAt: recentPayments[0]?.paid_at ? new Date(recentPayments[0].paid_at) : null,
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
    status: row.status, createdByUserId: row.created_by_user_id === null ? null : Number(row.created_by_user_id), createdAt: new Date(row.created_at), updatedAt: new Date(row.updated_at),
  };
}

const invoiceSelect = "id, tenant_id, site_id, subscriber_id, reading_id, tariff_id, invoice_no, client_operation_id, billing_period, issue_date, due_date, previous_reading, current_reading, consumption_kwh, price_per_kwh, fixed_fee, tax_amount, discount_amount, total_amount, paid_amount, balance_due, status, created_by_user_id, created_at, updated_at";

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
      referenceNo: row.reference_no, receiptImageKey: row.receipt_image_key, receiptImageHash: row.receipt_image_hash, status: row.status,
      collectedByUserId: row.collected_by_user_id === null ? null : Number(row.collected_by_user_id), collectorSessionId: row.collector_session_id === null ? null : Number(row.collector_session_id),
      paidAt: new Date(row.paid_at), createdAt: new Date(row.created_at), receiptImageUrl: row.receipt_image_key ? (await storageGet(row.receipt_image_key)).url : null,
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
    return { payment: { id: Number(row.id), tenantId: Number(row.tenant_id), siteId: Number(row.site_id), subscriberId: Number(row.subscriber_id), invoiceId: row.invoice_id === null ? null : Number(row.invoice_id), paymentNo: row.payment_no, clientOperationId: row.client_operation_id, amount: String(row.amount), paymentMethod: row.payment_method, transferFromAccount: row.transfer_from_account, transferFromType: row.transfer_from_type, transferToAccount: row.transfer_to_account, transferToType: row.transfer_to_type, referenceNo: row.reference_no, receiptImageKey: row.receipt_image_key, receiptImageHash: row.receipt_image_hash, status: row.status, collectedByUserId: row.collected_by_user_id === null ? null : Number(row.collected_by_user_id), collectorSessionId: row.collector_session_id === null ? null : Number(row.collector_session_id), paidAt: new Date(row.paid_at), createdAt: new Date(row.created_at), receiptImageUrl: row.receipt_image_key ? (await storageGet(row.receipt_image_key)).url : null }, subscriber, invoiceNo: row.invoice_id === null ? null : invoiceNoById.get(Number(row.invoice_id)) ?? null };
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

export async function listSupabaseExpensePage(siteId: number, input: { limit?: number; cursor?: string }): Promise<SupabaseHistoryPage<any>> {
  const limit = historyLimit(input.limit);
  const cursor = decodeHistoryCursor(input.cursor);
  let query = supabaseAdmin().from("expenses").select("id, tenant_id, site_id, generator_id, company_account_id, category, description, amount, occurred_at, reference_no, created_by_user_id, created_at").eq("site_id", siteId);
  if (cursor) query = query.or(`occurred_at.lt.${cursor.at},and(occurred_at.eq.${cursor.at},id.lt.${cursor.id})`);
  const { data, error } = await query.order("occurred_at", { ascending: false }).order("id", { ascending: false }).limit(limit + 1);
  if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل صفحة المصروفات من Supabase." });
  const rows = data ?? [];
  const items = rows.slice(0, limit).map((row: any) => ({ id: Number(row.id), tenantId: Number(row.tenant_id), siteId: Number(row.site_id), generatorId: row.generator_id === null ? null : Number(row.generator_id), companyAccountId: row.company_account_id === null ? null : Number(row.company_account_id), category: row.category, description: row.description, amount: String(row.amount), occurredAt: new Date(row.occurred_at), referenceNo: row.reference_no, createdByUserId: row.created_by_user_id === null ? null : Number(row.created_by_user_id), createdAt: new Date(row.created_at) }));
  const last = items.at(-1);
  return { items, hasNext: rows.length > limit, nextCursor: rows.length > limit && last ? encodeHistoryCursor({ at: last.occurredAt.toISOString(), id: last.id }) : null };
}

export async function getSupabaseFinancialOverview(site: SupabaseSite) {
  const admin = supabaseAdmin();
  const [invoices, payments, expenses, subscribers] = await Promise.all([
    admin.from("invoices").select("id, site_id, subscriber_id, invoice_no, issue_date, due_date, total_amount, paid_amount, balance_due, status").eq("site_id", site.id),
    admin.from("payments").select("site_id, subscriber_id, amount, status, paid_at").eq("site_id", site.id),
    admin.from("expenses").select("site_id, amount, occurred_at").eq("site_id", site.id),
    admin.from("subscribers").select("id, full_name, subscriber_no, service_status").eq("site_id", site.id),
  ]);
  if (invoices.error || payments.error || expenses.error || subscribers.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل الملخص المالي من Supabase." });
  const byId = new Map((subscribers.data ?? []).map((row) => [Number(row.id), row]));
  return buildFinancialOverview({
    branches: [{ id: site.id, name: site.name, activeSubscribers: (subscribers.data ?? []).filter((row) => row.service_status === "active").length }],
    invoices: (invoices.data ?? []).map((row) => ({ id: Number(row.id), siteId: Number(row.site_id), subscriberId: Number(row.subscriber_id), subscriberName: byId.get(Number(row.subscriber_id))?.full_name ?? "مشترك", subscriberNo: byId.get(Number(row.subscriber_id))?.subscriber_no ?? "—", invoiceNo: row.invoice_no, issueDate: new Date(row.issue_date), dueDate: new Date(row.due_date), totalAmount: Number(row.total_amount), paidAmount: Number(row.paid_amount), balanceDue: Number(row.balance_due), status: row.status })),
    payments: (payments.data ?? []).map((row) => ({ siteId: Number(row.site_id), subscriberId: Number(row.subscriber_id), amount: Number(row.amount), status: row.status, paidAt: new Date(row.paid_at) })),
    expenses: (expenses.data ?? []).map((row) => ({ siteId: Number(row.site_id), amount: Number(row.amount), occurredAt: new Date(row.occurred_at) })),
  });
}

export async function listSupabaseCompanyAccounts(input: { tenantId: number; branchId?: number; from?: Date | null; to?: Date | null }) {
  const admin = supabaseAdmin();
  let { data: accountRows, error: accountsError } = await admin.from("company_accounts")
    .select("id, tenant_id, name, account_type, phone_number, color, opening_balance, is_active, allow_payment_documentation, created_at, updated_at")
    .eq("tenant_id", input.tenantId).eq("is_active", true).order("id", { ascending: true });
  if (accountsError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل حسابات الشركة من Supabase." });
  if (!(accountRows ?? []).length) {
    const defaults = [
      { tenant_id: input.tenantId, name: "كاش", account_type: "cash", color: "#64748b" },
      { tenant_id: input.tenantId, name: "جوال بي", account_type: "jawwal_pay", color: "#16a34a" },
      { tenant_id: input.tenantId, name: "بال بي", account_type: "palpay", color: "#9333ea" },
      { tenant_id: input.tenantId, name: "بنك فلسطين", account_type: "bank_of_palestine", color: "#0891b2" },
    ];
    const { error: defaultsError } = await admin.from("company_accounts").insert(defaults);
    if (defaultsError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تهيئة حسابات الشركة الافتراضية في Supabase." });
    const retry = await admin.from("company_accounts").select("id, tenant_id, name, account_type, phone_number, color, opening_balance, is_active, allow_payment_documentation, created_at, updated_at")
      .eq("tenant_id", input.tenantId).eq("is_active", true).order("id", { ascending: true });
    if (retry.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل حسابات الشركة بعد التهيئة." });
    accountRows = retry.data;
  }
  const accountIds = (accountRows ?? []).map((row) => Number(row.id));
  const [siteLinksResult, sitesResult, transactionsResult] = await Promise.all([
    accountIds.length ? admin.from("company_account_sites").select("account_id, site_id").eq("tenant_id", input.tenantId).in("account_id", accountIds) : Promise.resolve({ data: [], error: null }),
    admin.from("sites").select("id, name").eq("tenant_id", input.tenantId),
    accountIds.length ? admin.from("account_transactions").select("id, tenant_id, account_id, transaction_type, amount, description, reference_no, related_payment_id, related_account_id, created_by_user_id, occurred_at, created_at")
      .eq("tenant_id", input.tenantId).in("account_id", accountIds)
      .gte("occurred_at", input.from?.toISOString() ?? "1970-01-01T00:00:00.000Z").lte("occurred_at", input.to?.toISOString() ?? "9999-12-31T23:59:59.999Z").order("occurred_at", { ascending: false }).limit(1000) : Promise.resolve({ data: [], error: null }),
  ]);
  if (siteLinksResult.error || sitesResult.error || transactionsResult.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل حركات أو ربط حسابات الشركة من Supabase." });
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
    const balance = transactions.reduce((total, transaction) => {
      const amount = Number(transaction.amount ?? 0);
      return ["deposit", "transfer_in", "collection"].includes(String(transaction.transactionType)) ? total + amount : total - amount;
    }, Number(row.opening_balance));
    return [{ id, tenantId: Number(row.tenant_id), name: row.name, accountType: row.account_type, phoneNumber: row.phone_number, color: row.color, openingBalance: String(row.opening_balance), isActive: row.is_active, allowPaymentDocumentation: Boolean(row.allow_payment_documentation), createdAt: new Date(row.created_at), updatedAt: new Date(row.updated_at), linkedSites, balance, transactions }];
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

export async function getSupabaseOwnerSubscriberQuota(tenantId: number) {
  const admin = supabaseAdmin();
  const [tenantResult, countResult, quotaResult] = await Promise.all([
    admin.from("tenant_subscriptions")
      .select("package_code")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    admin.from("subscribers").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId),
    admin.rpc("powerhub_effective_tenant_quota", { p_tenant_id: tenantId, p_resource: "subscribers" }),
  ]);
  if (tenantResult.error || countResult.error || quotaResult.error) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل حصة المشتركين من Supabase." });
  }
  if (!tenantResult.data) throw new TRPCError({ code: "NOT_FOUND", message: "مساحة صاحب المولد غير موجودة." });
  const rawRpcLimit = quotaResult.data;
  const rpcLimit = typeof rawRpcLimit === "number" || typeof rawRpcLimit === "string" ? Number(rawRpcLimit) : NaN;
  const limit = Number.isFinite(rpcLimit) ? Math.max(0, rpcLimit) : configuredSubscriberLimit(String(tenantResult.data.package_code), null);
  const currentCount = countResult.count ?? 0;
  return { limit, currentCount, remaining: Math.max(0, limit - currentCount), plan: tenantResult.data.package_code as string };
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
