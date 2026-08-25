import { TRPCError } from "@trpc/server";
import { supabaseAdmin } from "./supabase-admin";

type TenantRow = { id: number | string; name: string; slug: string; status: string; plan: string; created_at: string; updated_at: string };
type OwnerRow = { id: number | string; tenant_id: number | string; owner_user_id: number | string | null; full_name: string; phone: string; whatsapp_number: string | null; email: string | null; company_name: string | null; report_logo_key: string | null; identity_number_last4: string | null; invited_at: string | null; claimed_at: string | null; created_at: string; updated_at: string };
type UserRow = { id: number | string; name: string | null; email: string | null; last_signed_in: string };
type SubscriptionRow = { id: number | string; tenant_id: number | string; plan: string; status: string; billing_cycle: string; started_at: string; ends_at: string; auto_renew: boolean; renewal_count: number; last_renewed_at: string | null; notes: string | null; sms_plan_id: number | string | null; created_at: string; updated_at: string };
type SubscriberRow = { tenant_id: number | string; subscription_type: "residential" | "commercial" };

const numberId = (value: string | number | null) => value === null ? null : Number(value);

function unavailable(error: { message: string } | null) {
  throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `تعذر تحميل ملخص إدارة المنصة من Supabase${error ? `: ${error.message}` : "."}` });
}

export async function ownerOverviewFromSupabase(tenantId?: number) {
  const admin = supabaseAdmin();
  let tenantQuery = admin.from("tenants").select("id, name, slug, status, plan, created_at, updated_at").order("created_at", { ascending: false });
  if (tenantId) tenantQuery = tenantQuery.eq("id", tenantId);
  const { data: tenantRows, error: tenantsError } = await tenantQuery;
  if (tenantsError) unavailable(tenantsError);
  const tenants = (tenantRows ?? []) as TenantRow[];
  const tenantIds = tenants.map((tenant) => Number(tenant.id));
  if (!tenantIds.length) return [];

  const [ownersResult, subscriptionsResult, subscribersResult] = await Promise.all([
    admin.from("tenant_owner_profiles").select("id, tenant_id, owner_user_id, full_name, phone, whatsapp_number, email, company_name, report_logo_key, identity_number_last4, invited_at, claimed_at, created_at, updated_at").in("tenant_id", tenantIds),
    admin.from("tenant_subscriptions").select("id, tenant_id, plan, status, billing_cycle, started_at, ends_at, auto_renew, renewal_count, last_renewed_at, notes, sms_plan_id, created_at, updated_at").in("tenant_id", tenantIds),
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
      tenant: { id: Number(tenant.id), name: tenant.name, slug: tenant.slug, status: tenant.status, plan: tenant.plan, createdAt: tenant.created_at, updatedAt: tenant.updated_at },
      owner: owner ? { id: Number(owner.id), tenantId: Number(owner.tenant_id), ownerUserId: numberId(owner.owner_user_id), fullName: owner.full_name, phone: owner.phone, whatsappNumber: owner.whatsapp_number, email: owner.email, companyName: owner.company_name, reportLogoKey: owner.report_logo_key, identityNumberLast4: owner.identity_number_last4, invitedAt: owner.invited_at, claimedAt: owner.claimed_at, createdAt: owner.created_at, updatedAt: owner.updated_at } : null,
      ownerAccount: account ? { id: Number(account.id), name: account.name, email: account.email, lastSignedIn: account.last_signed_in } : null,
      subscription: subscription ? { id: Number(subscription.id), tenantId: Number(subscription.tenant_id), plan: subscription.plan, status: subscription.status, billingCycle: subscription.billing_cycle, startedAt: subscription.started_at, endsAt: subscription.ends_at, autoRenew: subscription.auto_renew, renewalCount: subscription.renewal_count, lastRenewedAt: subscription.last_renewed_at, notes: subscription.notes, smsPlanId: numberId(subscription.sms_plan_id), createdAt: subscription.created_at, updatedAt: subscription.updated_at } : null,
      subscribers: countByTenant.get(Number(tenant.id)) ?? { total: 0, residential: 0, commercial: 0 },
    };
  });
}
