import { TRPCError } from "@trpc/server";
import { supabaseAdmin } from "./supabase-admin";

export type AdminSubscriptionPlan = "starter" | "professional" | "enterprise";
export type AdminSubscriptionStatus = "trial" | "active" | "overdue" | "suspended" | "cancelled";
export type AdminBillingCycle = "monthly" | "yearly";

function rpcError(operation: string, error: { message?: string } | null) {
  if (!error) return;
  const message = error.message?.trim() || "تعذر تنفيذ العملية في Supabase.";
  if (message.includes("FORBIDDEN") || message.includes("PLATFORM_ROLE")) {
    throw new TRPCError({ code: "FORBIDDEN", message: "دور المنصة الحالي لا يملك هذه الصلاحية." });
  }
  if (message.includes("NOT_FOUND") || message.includes("NOT_FOUND")) {
    throw new TRPCError({ code: "NOT_FOUND", message: "السجل المطلوب غير موجود في Supabase." });
  }
  if (message.includes("INVALID_") || message.includes("PLAN_NOT_ACTIVE")) {
    throw new TRPCError({ code: "BAD_REQUEST", message });
  }
  console.error(`[AdminSupabase] ${operation}`, { message });
  throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تنفيذ العملية في Supabase." });
}

export async function setTenantMembershipStatus(input: {
  actorUserId: number;
  tenantId: number;
  userId: number;
  status: "active" | "suspended" | "revoked";
}) {
  const { data, error } = await supabaseAdmin().rpc("powerhub_admin_set_tenant_membership_status", {
    p_actor_user_id: input.actorUserId,
    p_tenant_id: input.tenantId,
    p_user_id: input.userId,
    p_status: input.status,
  });
  rpcError("setTenantMembershipStatus", error);
  const row = data?.[0];
  if (!row) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "لم تُرجع Supabase نتيجة صالحة." });
  return { success: Boolean(row.success), membershipId: Number(row.membership_id), siteId: Number(row.site_id), status: row.status as string };
}

export async function attachOwnerUser(input: {
  actorUserId: number;
  tenantId: number;
  userId: number;
  siteId?: number;
}) {
  const { data, error } = await supabaseAdmin().rpc("powerhub_admin_attach_owner_user", {
    p_actor_user_id: input.actorUserId,
    p_tenant_id: input.tenantId,
    p_user_id: input.userId,
    p_site_id: input.siteId ?? null,
  });
  rpcError("attachOwnerUser", error);
  const row = data?.[0];
  if (!row) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "لم تُرجع Supabase نتيجة صالحة." });
  return { success: Boolean(row.success), siteId: Number(row.site_id) };
}

export async function updateSubscription(input: {
  actorUserId: number;
  tenantId: number;
  plan: AdminSubscriptionPlan;
  status: AdminSubscriptionStatus;
  billingCycle: AdminBillingCycle;
  endsAt: Date;
  autoRenew: boolean;
  notes?: string;
  smsPlanId?: number | null;
}) {
  const { data, error } = await supabaseAdmin().rpc("powerhub_admin_update_subscription", {
    p_actor_user_id: input.actorUserId,
    p_tenant_id: input.tenantId,
    p_plan: input.plan,
    p_status: input.status,
    p_billing_cycle: input.billingCycle,
    p_ends_at: input.endsAt.toISOString(),
    p_auto_renew: input.autoRenew,
    p_notes: input.notes ?? null,
    p_sms_plan_id: input.smsPlanId ?? null,
  });
  rpcError("updateSubscription", error);
  const row = data?.[0];
  if (!row) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "لم تُرجع Supabase نتيجة صالحة." });
  return { success: Boolean(row.success), subscriptionId: Number(row.subscription_id), siteId: Number(row.site_id) };
}
