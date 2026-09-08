import { TRPCError } from "@trpc/server";
import { supabaseAdmin } from "./supabase-admin";

export type TenantSubscriptionState = "trial" | "active" | "overdue" | "suspended" | "cancelled";

export type TenantSubscription = {
  status: TenantSubscriptionState;
  endsAt: Date | null;
};

export function isTenantSubscriptionActive(subscription: TenantSubscription | null, now = new Date()): boolean {
  if (!subscription) return false;
  if (subscription.status === "suspended" || subscription.status === "cancelled" || subscription.status === "overdue") return false;
  // Commercial subscriptions must have an explicit expiry. Fail closed rather than
  // treating a missing endsAt as perpetual access.
  if (!subscription.endsAt) return false;
  return subscription.endsAt > now;
}

export async function requireTenantSubscription(tenantId: number, now = new Date()): Promise<TenantSubscription> {
  const { data, error } = await supabaseAdmin()
    .from("tenant_subscriptions")
    .select("status, ends_at")
    .eq("tenant_id", tenantId)
    .order("ends_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر التحقق من حالة اشتراك مساحة العمل." });
  }

  if (!data) {
    throw new TRPCError({ code: "FORBIDDEN", message: "لا يوجد اشتراك فعال لمساحة العمل." });
  }

  const subscription: TenantSubscription = {
    status: data.status as TenantSubscriptionState,
    endsAt: data.ends_at ? new Date(data.ends_at) : null,
  };

  if (!isTenantSubscriptionActive(subscription, now)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "انتهى اشتراك مساحة العمل أو تم إيقافه. يرجى تجديد الاشتراك للمتابعة." });
  }

  return subscription;
}
