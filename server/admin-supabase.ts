import { TRPCError } from "@trpc/server";
import { supabaseAdmin } from "./supabase-admin";

type TenantRow = { id: number | string; name: string; slug: string; status: string; created_at: string; updated_at: string };
type OwnerRow = { id: number | string; tenant_id: number | string; owner_user_id: number | string | null; full_name: string; phone: string; whatsapp_number: string | null; email: string | null; company_name: string | null; report_logo_key: string | null; identity_number_last4: string | null; invited_at: string | null; claimed_at: string | null; created_at: string; updated_at: string };
type UserRow = { id: number | string; name: string | null; email: string | null; last_signed_in: string };
type SubscriptionRow = { id: number | string; tenant_id: number | string; package_code: string; status: string; billing_cycle: string; started_at: string; ends_at: string; auto_renew: boolean; renewal_count: number; last_renewed_at: string | null; notes: string | null; sms_plan_id: number | string | null; cancelled_at: string | null; read_only_until: string | null; archived_at: string | null; created_at: string; updated_at: string };
type SubscriberRow = { tenant_id: number | string; subscription_type: "residential" | "commercial" | "institution" | "mosque" };

const numberId = (value: string | number | null) => value === null ? null : Number(value);

function unavailable(error: { message: string; code?: string } | null, area = "admin.overview") {
  if (error) {
    // Read failures only: log the operation class and database error, never user or tenant identifiers.
    console.error("[PowerHub admin data read failed]", {
      area,
      code: error.code ?? "unknown",
      message: error.message,
    });
  }
  throw new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    // Keep database internals in server logs; the client receives only a safe operation label.
    message: `تعذر تحميل بيانات إدارة المنصة من Supabase (${area}).`,
  });
}

export async function ownerOverviewFromSupabase(tenantId?: number) {
  const admin = supabaseAdmin();
  let tenantQuery = admin.from("tenants").select("id, name, slug, status, created_at, updated_at").order("created_at", { ascending: false });
  if (tenantId) tenantQuery = tenantQuery.eq("id", tenantId);
  const { data: tenantRows, error: tenantsError } = await tenantQuery;
  if (tenantsError) unavailable(tenantsError, "admin.overview.tenants");
  const tenants = (tenantRows ?? []) as TenantRow[];
  const tenantIds = tenants.map((tenant) => Number(tenant.id));
  if (!tenantIds.length) return [];

  const [ownersResult, subscriptionsResult, subscribersResult] = await Promise.all([
    admin.from("tenant_owner_profiles").select("id, tenant_id, owner_user_id, full_name, phone, whatsapp_number, email, company_name, report_logo_key, identity_number_last4, invited_at, claimed_at, created_at, updated_at").in("tenant_id", tenantIds),
    admin.from("tenant_subscriptions").select("id, tenant_id, package_code, status, billing_cycle, started_at, ends_at, auto_renew, renewal_count, last_renewed_at, notes, sms_plan_id, cancelled_at, read_only_until, archived_at, created_at, updated_at").in("tenant_id", tenantIds),
    admin.from("subscribers").select("tenant_id, subscription_type").in("tenant_id", tenantIds),
  ]);
  if (ownersResult.error) unavailable(ownersResult.error, "admin.overview.ownerProfiles");
  if (subscriptionsResult.error) unavailable(subscriptionsResult.error, "admin.overview.subscriptions");
  if (subscribersResult.error) unavailable(subscribersResult.error, "admin.overview.subscribers");

  const owners = (ownersResult.data ?? []) as OwnerRow[];
  const ownerUserIds = owners.flatMap((owner) => owner.owner_user_id === null ? [] : [Number(owner.owner_user_id)]);
  const { data: userRows, error: usersError } = ownerUserIds.length
    ? await admin.from("users").select("id, name, email, last_signed_in").in("id", ownerUserIds)
    : { data: [], error: null };
  if (usersError) unavailable(usersError, "admin.overview.ownerUsers");

  const ownerByTenant = new Map(owners.map((owner) => [Number(owner.tenant_id), owner]));
  const accountById = new Map(((userRows ?? []) as UserRow[]).map((user) => [Number(user.id), user]));
  const subscriptionByTenant = new Map(((subscriptionsResult.data ?? []) as SubscriptionRow[]).map((subscription) => [Number(subscription.tenant_id), subscription]));
  const countByTenant = new Map<number, { total: number; residential: number; commercial: number; institution: number; mosque: number }>();
  for (const subscriber of (subscribersResult.data ?? []) as SubscriberRow[]) {
    const id = Number(subscriber.tenant_id);
    const count = countByTenant.get(id) ?? { total: 0, residential: 0, commercial: 0, institution: 0, mosque: 0 };
    count.total += 1;
    if (subscriber.subscription_type === "residential") count.residential += 1;
    if (subscriber.subscription_type === "commercial") count.commercial += 1;
    if (subscriber.subscription_type === "institution") count.institution += 1;
    if (subscriber.subscription_type === "mosque") count.mosque += 1;
    countByTenant.set(id, count);
  }

  return tenants.map((tenant) => {
    const owner = ownerByTenant.get(Number(tenant.id));
    const account = owner?.owner_user_id === null || owner?.owner_user_id === undefined ? null : accountById.get(Number(owner.owner_user_id)) ?? null;
    const subscription = subscriptionByTenant.get(Number(tenant.id));
    return {
      tenant: { id: Number(tenant.id), name: tenant.name, slug: tenant.slug, status: tenant.status, packageCode: subscription?.package_code ?? null, createdAt: tenant.created_at, updatedAt: tenant.updated_at },
      owner: owner ? { id: Number(owner.id), tenantId: Number(owner.tenant_id), ownerUserId: numberId(owner.owner_user_id), fullName: owner.full_name, phone: owner.phone, whatsappNumber: owner.whatsapp_number, email: owner.email, companyName: owner.company_name, reportLogoKey: owner.report_logo_key, identityNumberLast4: owner.identity_number_last4, invitedAt: owner.invited_at, claimedAt: owner.claimed_at, createdAt: owner.created_at, updatedAt: owner.updated_at } : null,
      ownerAccount: account ? { id: Number(account.id), name: account.name, email: account.email, lastSignedIn: account.last_signed_in } : null,
      subscription: subscription ? { id: Number(subscription.id), tenantId: Number(subscription.tenant_id), packageCode: subscription.package_code, status: subscription.status, billingCycle: subscription.billing_cycle, startedAt: subscription.started_at, endsAt: subscription.ends_at, autoRenew: subscription.auto_renew, renewalCount: subscription.renewal_count, lastRenewedAt: subscription.last_renewed_at, notes: subscription.notes, smsPlanId: numberId(subscription.sms_plan_id), cancelledAt: subscription.cancelled_at, readOnlyUntil: subscription.read_only_until, archivedAt: subscription.archived_at, createdAt: subscription.created_at, updatedAt: subscription.updated_at } : null,
      subscribers: countByTenant.get(Number(tenant.id)) ?? { total: 0, residential: 0, commercial: 0, institution: 0, mosque: 0 },
    };
  });
}

type EntityRow = Record<string, unknown>;

function requireData<T>(result: { data: T[] | null; error: { message: string; code?: string } | null }, area: string) {
  if (result.error) unavailable(result.error, area);
  return result.data ?? [];
}

const numeric = (value: unknown) => Number(value ?? 0);

export async function platformSnapshotFromSupabase() {
  const admin = supabaseAdmin();
  const [
    generatorsResult,
    usersResult,
    staffResult,
    membershipResult,
    invoicesResult,
    paymentsResult,
    readingsResult,
    tenantsResult,
    subscribersResult,
    notificationsResult,
    auditResult,
    sitesResult,
    ownerProfilesResult,
    employeesResult,
    tenantInvitationsResult,
    platformInvitationsResult,
  ] = await Promise.all([
    admin.from("generators").select("id, code, name, status, rated_capacity_kw, tenant_id, site_id, created_at").order("created_at", { ascending: false }).limit(200),
    admin.from("users").select("id, name, email, role, platform_role, account_status, last_signed_in").limit(5000),
    admin.from("staff_profiles").select("id, user_id, tenant_id, site_id, role, is_active, suspension_started_at, suspension_ends_at, updated_at").order("updated_at", { ascending: false }).limit(5000),
    admin.from("tenant_members").select("id, user_id, tenant_id, role, is_active, membership_status, expires_at, updated_at").limit(5000),
    admin.from("invoices").select("status, balance_due, total_amount").limit(5000),
    admin.from("payments").select("status, amount, payment_method").limit(5000),
    admin.from("meter_readings").select("status, consumption_kwh").limit(5000),
    admin.from("tenants").select("id, name").limit(1000),
    admin.from("subscribers").select("id, subscriber_no, full_name, subscription_type, service_status, tenant_id, site_id, created_at").order("created_at", { ascending: false }).limit(300),
    admin.from("notification_messages").select("status").limit(5000),
    admin.from("audit_logs").select("id, action, entity_type, created_at, tenant_id, site_id, user_id").order("created_at", { ascending: false }).limit(30),
    admin.from("sites").select("id, name, tenant_id").limit(2000),
    admin.from("tenant_owner_profiles").select("tenant_id, owner_user_id, full_name, phone, whatsapp_number, email").limit(1000),
    admin.from("employees").select("tenant_id, site_id, linked_user_id, full_name, phone, job_title").not("linked_user_id", "is", null).limit(5000),
    admin.from("access_invitations").select("id,tenant_id,site_id,email,tenant_role,site_role,status,expires_at,created_at").eq("status","invited").order("created_at",{ascending:false}).limit(1000),
    admin.from("platform_access_invitations").select("id,email,platform_role,status,expires_at,created_at").eq("status","invited").order("created_at",{ascending:false}).limit(500),
  ]);

  const generators = requireData(generatorsResult as unknown as { data: EntityRow[] | null; error: { message: string; code?: string } | null }, "admin.snapshot.generators");
  const users = requireData(usersResult as unknown as { data: EntityRow[] | null; error: { message: string; code?: string } | null }, "admin.snapshot.users");
  const staff = requireData(staffResult as unknown as { data: EntityRow[] | null; error: { message: string; code?: string } | null }, "admin.snapshot.staffProfiles");
  const memberships = requireData(membershipResult as unknown as { data: EntityRow[] | null; error: { message: string; code?: string } | null }, "admin.snapshot.tenantMembers");
  const invoices = requireData(invoicesResult as unknown as { data: EntityRow[] | null; error: { message: string; code?: string } | null }, "admin.snapshot.invoices");
  const payments = requireData(paymentsResult as unknown as { data: EntityRow[] | null; error: { message: string; code?: string } | null }, "admin.snapshot.payments");
  const readings = requireData(readingsResult as unknown as { data: EntityRow[] | null; error: { message: string; code?: string } | null }, "admin.snapshot.meterReadings");
  const tenants = requireData(tenantsResult as unknown as { data: EntityRow[] | null; error: { message: string; code?: string } | null }, "admin.snapshot.tenants");
  const subscribers = requireData(subscribersResult as unknown as { data: EntityRow[] | null; error: { message: string; code?: string } | null }, "admin.snapshot.subscribers");
  const notifications = requireData(notificationsResult as unknown as { data: EntityRow[] | null; error: { message: string; code?: string } | null }, "admin.snapshot.notifications");
  const audit = requireData(auditResult as unknown as { data: EntityRow[] | null; error: { message: string; code?: string } | null }, "admin.snapshot.auditLogs");
  const sites = requireData(sitesResult as unknown as { data: EntityRow[] | null; error: { message: string; code?: string } | null }, "admin.snapshot.sites");
  const ownerProfiles = requireData(ownerProfilesResult as unknown as { data: EntityRow[] | null; error: { message: string; code?: string } | null }, "admin.snapshot.ownerProfiles");
  const employees = requireData(employeesResult as unknown as { data: EntityRow[] | null; error: { message: string; code?: string } | null }, "admin.snapshot.employees");
  const tenantInvitations = requireData(tenantInvitationsResult as unknown as { data: EntityRow[] | null; error: { message: string; code?: string } | null }, "admin.snapshot.accessInvitations");
  const platformInvitations = requireData(platformInvitationsResult as unknown as { data: EntityRow[] | null; error: { message: string; code?: string } | null }, "admin.snapshot.platformAccessInvitations");

  const tenantById = new Map(tenants.map((tenant) => [numeric(tenant.id), String(tenant.name)]));
  const siteById = new Map(sites.map((site) => [numeric(site.id), String(site.name)]));
  const userById = new Map(users.map((user) => [numeric(user.id), user]));
  const membershipByTenantUser = new Map(memberships.map((membership) => [`${numeric(membership.tenant_id)}:${numeric(membership.user_id)}`, membership]));
  const ownerProfileByUser = new Map(ownerProfiles.map((row) => [numeric(row.owner_user_id), row]));
  const employeeByUser = new Map<number, EntityRow[]>();
  for (const employee of employees) {
    const userId = numeric(employee.linked_user_id);
    const current = employeeByUser.get(userId) ?? [];
    current.push(employee);
    employeeByUser.set(userId, current);
  }

  const generatorsByTenant = new Map<number, EntityRow[]>();
  for (const generator of generators) {
    const list = generatorsByTenant.get(numeric(generator.tenant_id)) ?? [];
    list.push(generator);
    generatorsByTenant.set(numeric(generator.tenant_id), list);
  }

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

  const userDirectory = [
    ...users.filter((user) => user.role === "admin").map((user) => {
      const ownerProfile = ownerProfileByUser.get(numeric(user.id));
      return {
        id: numeric(user.id),
        userId: numeric(user.id),
        kind: "platform",
        name: user.name ?? ownerProfile?.full_name ?? null,
        email: user.email ?? ownerProfile?.email ?? null,
        phone: ownerProfile?.phone ?? ownerProfile?.whatsapp_number ?? null,
        role: user.platform_role ?? "platform_admin",
        tenantId: null,
        tenantName: null,
        siteId: null,
        siteName: null,
        accountStatus: user.account_status ?? "active",
        membershipStatus: null,
        status: user.account_status ?? "active",
        isActive: user.account_status === "active",
        lastSignedIn: user.last_signed_in ?? null,
        staffProfileId: null,
        invitationStatus: null,
        invitationExpiresAt: null,
        canManageStatus: user.platform_role !== "platform_owner",
      };
    }),
    ...memberships.map((membership) => {
      const user = userById.get(numeric(membership.user_id));
      if (!user || user.role === "admin") return null;
      const staffProfile = staff.find((item) =>
        numeric(item.user_id) === numeric(membership.user_id) &&
        numeric(item.tenant_id) === numeric(membership.tenant_id)
      );
      const ownerProfile = ownerProfileByUser.get(numeric(membership.user_id));
      const employeePhones = employeeByUser.get(numeric(membership.user_id)) ?? [];
      const phone = ownerProfile?.phone ?? ownerProfile?.whatsapp_number ?? employeePhones.find((row) => row.phone)?.phone ?? null;
      const membershipStatus = membership.membership_status ?? (membership.is_active ? "active" : "suspended");
      return {
        id: numeric(membership.id),
        userId: numeric(membership.user_id),
        kind: "tenant",
        name: user.name ?? ownerProfile?.full_name ?? employeePhones.find((row) => row.full_name)?.full_name ?? null,
        email: user.email ?? ownerProfile?.email ?? null,
        phone,
        role: String(staffProfile?.role ?? membership.role),
        tenantId: numeric(membership.tenant_id),
        tenantName: tenantById.get(numeric(membership.tenant_id)) ?? "—",
        siteId: staffProfile ? numeric(staffProfile.site_id) : null,
        siteName: staffProfile ? (siteById.get(numeric(staffProfile.site_id)) ?? "—") : "—",
        accountStatus: user.account_status ?? "active",
        membershipStatus,
        status: membershipStatus,
        isActive: Boolean(membership.is_active && membershipStatus === "active" && user.account_status === "active"),
        lastSignedIn: user.last_signed_in ?? null,
        staffProfileId: staffProfile ? numeric(staffProfile.id) : null,
        invitationStatus: null,
        invitationExpiresAt: null,
        suspensionStartedAt: staffProfile?.suspension_started_at ?? null,
        suspensionEndsAt: staffProfile?.suspension_ends_at ?? null,
        canManageStatus: true,
      };
    }).filter(Boolean),
    ...tenantInvitations.map((invite) => ({
      id: -numeric(invite.id),
      userId: null,
      kind: "tenant",
      name: invite.email,
      email: invite.email,
      phone: null,
      role: invite.site_role ?? invite.tenant_role ?? "viewer",
      tenantId: numeric(invite.tenant_id),
      tenantName: tenantById.get(numeric(invite.tenant_id)) ?? "—",
      siteId: numeric(invite.site_id),
      siteName: siteById.get(numeric(invite.site_id)) ?? "—",
      accountStatus: null,
      membershipStatus: "invited",
      status: "invited",
      isActive: false,
      lastSignedIn: null,
      staffProfileId: null,
      invitationStatus: "invited",
      invitationExpiresAt: invite.expires_at ?? null,
      canManageStatus: false,
      sourceInvitationId: numeric(invite.id),
      invitationCreatedAt: invite.created_at ?? null,
    })),
    ...platformInvitations.map((invite) => ({
      id: -1000000 - numeric(invite.id),
      userId: null,
      kind: "platform",
      name: invite.email,
      email: invite.email,
      phone: null,
      role: invite.platform_role ?? "platform_support",
      tenantId: null,
      tenantName: null,
      siteId: null,
      siteName: null,
      accountStatus: null,
      membershipStatus: "invited",
      status: "invited",
      isActive: false,
      lastSignedIn: null,
      staffProfileId: null,
      invitationStatus: "invited",
      invitationExpiresAt: invite.expires_at ?? null,
      canManageStatus: false,
      sourceInvitationId: numeric(invite.id),
      invitationCreatedAt: invite.created_at ?? null,
    })),
  ];

  return {
    generators: {
      total: generators.length, active: generatorStatuses.get("active") ?? 0, pending: generatorStatuses.get("pending") ?? 0,
      maintenance: generatorStatuses.get("maintenance") ?? 0, stopped: (generatorStatuses.get("stopped") ?? 0) + (generatorStatuses.get("offline") ?? 0),
      blocked: generatorStatuses.get("blocked") ?? 0, capacityKw,
      directory: generators.map((generator) => ({ id: numeric(generator.id), code: String(generator.code), name: String(generator.name), status: String(generator.status), ratedCapacityKw: generator.rated_capacity_kw == null ? null : String(generator.rated_capacity_kw), tenantId: numeric(generator.tenant_id), tenantName: tenantById.get(numeric(generator.tenant_id)) ?? "—", siteName: siteById.get(numeric(generator.site_id)) ?? "—" })),
      pendingRegistrations: generators.filter((generator) => generator.status === "pending").map((generator) => ({ generatorId: numeric(generator.id), generatorName: String(generator.name), generatorCode: String(generator.code), ratedCapacityKw: generator.rated_capacity_kw == null ? null : numeric(generator.rated_capacity_kw), tenantId: numeric(generator.tenant_id), ownerName: "—", phone: "—", tenantName: tenantById.get(numeric(generator.tenant_id)) ?? "—", siteName: siteById.get(numeric(generator.site_id)) ?? "—", createdAt: generator.created_at })),
    },
    users: {
      total: userDirectory.length,
      platformAdmins: users.filter((user) => user.role === "admin").length,
      activeStaff: userDirectory.filter((item) => item !== null).filter((item) => item.kind === "tenant" && item.status === "active").length,
      directory: userDirectory,
      staffDirectory: staff.map((item) => {
        const user = userById.get(numeric(item.user_id));
        const membership = membershipByTenantUser.get(`${numeric(item.tenant_id)}:${numeric(item.user_id)}`);
        return {
          id: numeric(item.id),
          userId: numeric(item.user_id),
          role: item.role,
          isActive: item.is_active,
          membershipStatus: membership?.membership_status ?? (item.is_active ? "active" : "suspended"),
          accountStatus: user?.account_status ?? "active",
          userName: user?.name ?? null,
          userEmail: user?.email ?? null,
          tenantId: numeric(item.tenant_id),
          tenantName: tenantById.get(numeric(item.tenant_id)) ?? "—",
          siteId: numeric(item.site_id),
          siteName: siteById.get(numeric(item.site_id)) ?? "—",
        };
      }),
      subscriberDirectory: subscribers.map((item) => ({ id: numeric(item.id), subscriberNo: item.subscriber_no, fullName: item.full_name, subscriptionType: item.subscription_type, serviceStatus: item.service_status, tenantName: tenantById.get(numeric(item.tenant_id)) ?? "—", siteName: siteById.get(numeric(item.site_id)) ?? "—" })),
    },
    finance: { ...finance, paymentMethods: Array.from(paymentMethods.values()), collectionsByGenerator: [] as Array<{ generatorId: number; generatorName: string; generatorCode: string; tenantName: string; count: number; amount: number }> },
    reports: { approvedReadings, consumptionKwh, tenants: tenants.length, subscribers: subscribers.length, complaintsEnabled: false },
    notifications: { statuses: Array.from(notificationStatuses.entries()).map(([status, count]) => ({ status, count })) },
    security: { recentAudit: audit.map((item) => ({ id: numeric(item.id), action: item.action, entityType: item.entity_type, createdAt: item.created_at, tenantName: tenantById.get(numeric(item.tenant_id)) ?? null, siteName: siteById.get(numeric(item.site_id)) ?? null, userName: userById.get(numeric(item.user_id))?.name ?? null })) },
  };
}
