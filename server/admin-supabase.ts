import { TRPCError } from "@trpc/server";
import { supabaseAdmin } from "./supabase-admin";

type TenantRow = { id: number | string; name: string; slug: string; status: string; package_code: string; created_at: string; updated_at: string };
type OwnerRow = { id: number | string; tenant_id: number | string; owner_user_id: number | string | null; full_name: string; phone: string; whatsapp_number: string | null; email: string | null; company_name: string | null; report_logo_key: string | null; identity_number_last4: string | null; invited_at: string | null; claimed_at: string | null; created_at: string; updated_at: string };
type UserRow = { id: number | string; name: string | null; email: string | null; last_signed_in: string };
type SubscriptionRow = { id: number | string; tenant_id: number | string; package_code: string; status: string; billing_cycle: string; started_at: string; ends_at: string; auto_renew: boolean; renewal_count: number; last_renewed_at: string | null; notes: string | null; sms_plan_id: number | string | null; cancelled_at: string | null; read_only_until: string | null; archived_at: string | null; created_at: string; updated_at: string };
type SubscriberRow = { tenant_id: number | string; subscription_type: "residential" | "commercial" };

const numberId = (value: string | number | null) => value === null ? null : Number(value);

function unavailable(error: { message: string } | null) {
  throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `تعذر تحميل ملخص إدارة المنصة من Supabase${error ? `: ${error.message}` : "."}` });
}

export async function ownerOverviewFromSupabase(tenantId?: number) {
  const admin = supabaseAdmin();
  let tenantQuery = admin.from("tenants").select("id, name, slug, status, package_code, created_at, updated_at").order("created_at", { ascending: false });
  if (tenantId) tenantQuery = tenantQuery.eq("id", tenantId);
  const { data: tenantRows, error: tenantsError } = await tenantQuery;
  if (tenantsError) unavailable(tenantsError);
  const tenants = (tenantRows ?? []) as TenantRow[];
  const tenantIds = tenants.map((tenant) => Number(tenant.id));
  if (!tenantIds.length) return [];

  const [ownersResult, subscriptionsResult, subscribersResult] = await Promise.all([
    admin.from("tenant_owner_profiles").select("id, tenant_id, owner_user_id, full_name, phone, whatsapp_number, email, company_name, report_logo_key, identity_number_last4, invited_at, claimed_at, created_at, updated_at").in("tenant_id", tenantIds),
    admin.from("tenant_subscriptions").select("id, tenant_id, package_code, status, billing_cycle, started_at, ends_at, auto_renew, renewal_count, last_renewed_at, notes, sms_plan_id, cancelled_at, read_only_until, archived_at, created_at, updated_at").in("tenant_id", tenantIds),
    admin.from("subscribers").select("tenant_id, subscription_type").in("tenant_id", tenantIds),
  ]);
  if (ownersResult.error) unavailable(ownersResult.error);
  if (subscriptionsResult.error) unavailable(subscriptionsResult.error);
  if (subscribersResult.error) unavailable(subscribersResult.error);

  const owners = (ownersResult.data ?? []) as OwnerRow[];
  const ownerUserIds = owners.flatMap((owner) => owner.owner_user_id === null ? [] : [Number(owner.owner_user_id)]);
  const { data: userRows, error: usersError } = ownerUserIds.length
    ? await admin.from("users").select("id, name, email, last_signed_in").in("id", ownerUserIds)
    : { data: [], error: null };
  if (usersError) unavailable(usersError);

  const ownerByTenant = new Map(owners.map((owner) => [Number(owner.tenant_id), owner]));
  const accountById = new Map(((userRows ?? []) as UserRow[]).map((user) => [Number(user.id), user]));
  const subscriptionByTenant = new Map(((subscriptionsResult.data ?? []) as SubscriptionRow[]).map((subscription) => [Number(subscription.tenant_id), subscription]));
  const countByTenant = new Map<number, { total: number; residential: number; commercial: number }>();
  for (const subscriber of (subscribersResult.data ?? []) as SubscriberRow[]) {
    const id = Number(subscriber.tenant_id);
    const count = countByTenant.get(id) ?? { total: 0, residential: 0, commercial: 0 };
    count.total += 1;
    if (subscriber.subscription_type === "residential") count.residential += 1;
    if (subscriber.subscription_type === "commercial") count.commercial += 1;
    countByTenant.set(id, count);
  }

  return tenants.map((tenant) => {
    const owner = ownerByTenant.get(Number(tenant.id));
    const account = owner?.owner_user_id === null || owner?.owner_user_id === undefined ? null : accountById.get(Number(owner.owner_user_id)) ?? null;
    const subscription = subscriptionByTenant.get(Number(tenant.id));
    return {
      tenant: { id: Number(tenant.id), name: tenant.name, slug: tenant.slug, status: tenant.status, packageCode: tenant.package_code, createdAt: tenant.created_at, updatedAt: tenant.updated_at },
      owner: owner ? { id: Number(owner.id), tenantId: Number(owner.tenant_id), ownerUserId: numberId(owner.owner_user_id), fullName: owner.full_name, phone: owner.phone, whatsappNumber: owner.whatsapp_number, email: owner.email, companyName: owner.company_name, reportLogoKey: owner.report_logo_key, identityNumberLast4: owner.identity_number_last4, invitedAt: owner.invited_at, claimedAt: owner.claimed_at, createdAt: owner.created_at, updatedAt: owner.updated_at } : null,
      ownerAccount: account ? { id: Number(account.id), name: account.name, email: account.email, lastSignedIn: account.last_signed_in } : null,
      subscription: subscription ? { id: Number(subscription.id), tenantId: Number(subscription.tenant_id), packageCode: subscription.package_code, status: subscription.status, billingCycle: subscription.billing_cycle, startedAt: subscription.started_at, endsAt: subscription.ends_at, autoRenew: subscription.auto_renew, renewalCount: subscription.renewal_count, lastRenewedAt: subscription.last_renewed_at, notes: subscription.notes, smsPlanId: numberId(subscription.sms_plan_id), cancelledAt: subscription.cancelled_at, readOnlyUntil: subscription.read_only_until, archivedAt: subscription.archived_at, createdAt: subscription.created_at, updatedAt: subscription.updated_at } : null,
      subscribers: countByTenant.get(Number(tenant.id)) ?? { total: 0, residential: 0, commercial: 0 },
    };
  });
}

type EntityRow = Record<string, unknown>;

function requireData<T>(result: { data: T[] | null; error: { message: string } | null }) {
  if (result.error) unavailable(result.error);
  return result.data ?? [];
}

const numeric = (value: unknown) => Number(value ?? 0);

export async function platformSnapshotFromSupabase() {
  const admin = supabaseAdmin();
  const [generatorsResult, usersResult, staffResult, invoicesResult, paymentsResult, readingsResult, tenantsResult, subscribersResult, notificationsResult, auditResult, sitesResult] = await Promise.all([
    admin.from("generators").select("id, code, name, status, rated_capacity_kw, tenant_id, site_id, created_at").order("created_at", { ascending: false }).limit(200),
    admin.from("users").select("id, name, email, role, platform_role").limit(300),
    admin.from("staff_profiles").select("id, user_id, tenant_id, site_id, role, is_active, updated_at").order("updated_at", { ascending: false }).limit(300),
    admin.from("invoices").select("status, balance_due, total_amount").limit(5000),
    admin.from("payments").select("status, amount, payment_method").limit(5000),
    admin.from("meter_readings").select("status, consumption_kwh").limit(5000),
    admin.from("tenants").select("id, name").limit(500),
    admin.from("subscribers").select("id, subscriber_no, full_name, subscription_type, service_status, tenant_id, site_id, created_at").order("created_at", { ascending: false }).limit(300),
    admin.from("notification_messages").select("status").limit(5000),
    admin.from("audit_logs").select("id, action, entity_type, created_at, tenant_id, site_id, user_id").order("created_at", { ascending: false }).limit(30),
    admin.from("sites").select("id, name, tenant_id").limit(500),
  ]);

  const generators = requireData(generatorsResult as unknown as { data: EntityRow[] | null; error: { message: string } | null });
  const users = requireData(usersResult as unknown as { data: EntityRow[] | null; error: { message: string } | null });
  const staff = requireData(staffResult as unknown as { data: EntityRow[] | null; error: { message: string } | null });
  const invoices = requireData(invoicesResult as unknown as { data: EntityRow[] | null; error: { message: string } | null });
  const payments = requireData(paymentsResult as unknown as { data: EntityRow[] | null; error: { message: string } | null });
  const readings = requireData(readingsResult as unknown as { data: EntityRow[] | null; error: { message: string } | null });
  const tenants = requireData(tenantsResult as unknown as { data: EntityRow[] | null; error: { message: string } | null });
  const subscribers = requireData(subscribersResult as unknown as { data: EntityRow[] | null; error: { message: string } | null });
  const notifications = requireData(notificationsResult as unknown as { data: EntityRow[] | null; error: { message: string } | null });
  const audit = requireData(auditResult as unknown as { data: EntityRow[] | null; error: { message: string } | null });
  const sites = requireData(sitesResult as unknown as { data: EntityRow[] | null; error: { message: string } | null });

  const tenantById = new Map(tenants.map((tenant) => [numeric(tenant.id), String(tenant.name)]));
  const siteById = new Map(sites.map((site) => [numeric(site.id), String(site.name)]));
  const userById = new Map(users.map((user) => [numeric(user.id), user]));
  const generatorStatuses = new Map<string, number>();
  let capacityKw = 0;
  for (const generator of generators) {
    const status = String(generator.status);
    generatorStatuses.set(status, (generatorStatuses.get(status) ?? 0) + 1);
    capacityKw += numeric(generator.rated_capacity_kw);
  }
  const finance = { overdueCount: 0, overdueAmount: 0, issuedAmount: 0, completedPayments: 0, completedAmount: 0 };
  for (const invoice of invoices) {
    const status = String(invoice.status);
    if (status === "overdue") { finance.overdueCount += 1; finance.overdueAmount += numeric(invoice.balance_due); }
    if (["issued", "partially_paid", "paid", "overdue"].includes(status)) finance.issuedAmount += numeric(invoice.total_amount);
  }
  const paymentMethods = new Map<string, { method: string; count: number; amount: number }>();
  for (const payment of payments) {
    if (payment.status !== "completed") continue;
    finance.completedPayments += 1;
    finance.completedAmount += numeric(payment.amount);
    const method = String(payment.payment_method);
    const item = paymentMethods.get(method) ?? { method, count: 0, amount: 0 };
    item.count += 1; item.amount += numeric(payment.amount); paymentMethods.set(method, item);
  }
  let approvedReadings = 0;
  let consumptionKwh = 0;
  for (const reading of readings) if (reading.status === "approved") { approvedReadings += 1; consumptionKwh += numeric(reading.consumption_kwh); }
  const notificationStatuses = new Map<string, number>();
  for (const notification of notifications) {
    const status = String(notification.status);
    notificationStatuses.set(status, (notificationStatuses.get(status) ?? 0) + 1);
  }

  return {
    generators: {
      total: generators.length, active: generatorStatuses.get("active") ?? 0, pending: generatorStatuses.get("pending") ?? 0,
      maintenance: generatorStatuses.get("maintenance") ?? 0, stopped: (generatorStatuses.get("stopped") ?? 0) + (generatorStatuses.get("offline") ?? 0),
      blocked: generatorStatuses.get("blocked") ?? 0, capacityKw,
      directory: generators.map((generator) => ({ id: numeric(generator.id), code: String(generator.code), name: String(generator.name), status: String(generator.status), ratedCapacityKw: String(generator.rated_capacity_kw ?? 0), tenantId: numeric(generator.tenant_id), tenantName: tenantById.get(numeric(generator.tenant_id)) ?? "—", siteName: siteById.get(numeric(generator.site_id)) ?? "—" })),
      pendingRegistrations: generators.filter((generator) => generator.status === "pending").map((generator) => ({ generatorId: numeric(generator.id), generatorName: String(generator.name), generatorCode: String(generator.code), ratedCapacityKw: numeric(generator.rated_capacity_kw), tenantId: numeric(generator.tenant_id), ownerName: "—", phone: "—", tenantName: tenantById.get(numeric(generator.tenant_id)) ?? "—", siteName: siteById.get(numeric(generator.site_id)) ?? "—", createdAt: generator.created_at })),
    },
    users: {
      total: users.length, platformAdmins: users.filter((user) => user.role === "admin").length, activeStaff: staff.filter((item) => item.is_active === true).length,
      staffDirectory: staff.map((item) => { const user = userById.get(numeric(item.user_id)); return { id: numeric(item.id), role: item.role, isActive: item.is_active, userName: user?.name ?? null, userEmail: user?.email ?? null, tenantName: tenantById.get(numeric(item.tenant_id)) ?? "—", siteName: siteById.get(numeric(item.site_id)) ?? "—" }; }),
      subscriberDirectory: subscribers.map((item) => ({ id: numeric(item.id), subscriberNo: item.subscriber_no, fullName: item.full_name, subscriptionType: item.subscription_type, serviceStatus: item.service_status, tenantName: tenantById.get(numeric(item.tenant_id)) ?? "—", siteName: siteById.get(numeric(item.site_id)) ?? "—" })),
    },
    finance: { ...finance, paymentMethods: Array.from(paymentMethods.values()), collectionsByGenerator: [] as Array<{ generatorId: number; generatorName: string; generatorCode: string; tenantName: string; count: number; amount: number }> },
    reports: { approvedReadings, consumptionKwh, tenants: tenants.length, subscribers: subscribers.length, complaintsEnabled: false },
    notifications: { statuses: Array.from(notificationStatuses.entries()).map(([status, count]) => ({ status, count })) },
    security: { recentAudit: audit.map((item) => ({ id: numeric(item.id), action: item.action, entityType: item.entity_type, createdAt: item.created_at, tenantName: tenantById.get(numeric(item.tenant_id)) ?? null, siteName: siteById.get(numeric(item.site_id)) ?? null, userName: userById.get(numeric(item.user_id))?.name ?? null })) },
  };
}
