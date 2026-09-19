import { TRPCError } from "@trpc/server";
import { supabaseAdmin } from "./supabase-admin";

export type AdminSubscriptionPlan = "basic" | "advanced" | "professional" | "business" | "vip";
export type AdminSubscriptionStatus = "trial" | "active" | "overdue" | "suspended" | "cancelled";
export type AdminBillingCycle = "monthly" | "yearly";

function rpcError(operation: string, error: { message?: string } | null) {
  if (!error) return;
  const message = error.message?.trim() || "تعذر تنفيذ العملية في Supabase.";
  if (message.includes("FORBIDDEN") || message.includes("PLATFORM_ROLE")) {
    throw new TRPCError({ code: "FORBIDDEN", message: "دور المنصة الحالي لا يملك هذه الصلاحية." });
  }
  if (message.includes("NOT_FOUND")) {
    throw new TRPCError({ code: "NOT_FOUND", message: "السجل المطلوب غير موجود في Supabase." });
  }
  if (message.includes("INVALID_") || message.includes("PLAN_NOT_ACTIVE")) {
    throw new TRPCError({ code: "BAD_REQUEST", message });
  }
  console.error(`[AdminSupabase] ${operation}`, { message });
  throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تنفيذ العملية في Supabase." });
}

function reviewSubscriptionRpcError(error: { message?: string } | null) {
  const message = error?.message?.trim() ?? "";
  if (message.includes("REQUEST_NOT_FOUND")) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Subscription upgrade request not found." });
  }
  if (message.includes("REQUEST_ALREADY_PROCESSED")) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Subscription upgrade request was already processed." });
  }
  if (message.includes("INVALID_DECISION")) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid subscription upgrade decision." });
  }
  rpcError("reviewSubscriptionUpgradeRequest", error);
}

function quickUpgradeOwnerPlanRpcError(error: { message?: string } | null) {
  const message = error?.message?.trim() ?? "";
  if (message.includes("TENANT_NOT_FOUND")) {
    throw new TRPCError({ code: "NOT_FOUND", message: "صاحب المولد غير موجود." });
  }
  if (message.includes("SUBSCRIPTION_NOT_FOUND")) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "لا يوجد اشتراك مرتبط بصاحب المولد." });
  }
  if (message.includes("SITE_NOT_FOUND")) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "لا يمكن ترقية الباقة قبل وجود فرع/محطة مرتبطة بالمساحة." });
  }
  if (message.includes("PLAN_NOT_UPGRADE")) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "اختر باقة أعلى من الباقة الحالية." });
  }
  if (message.includes("INVALID_PLAN")) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "خطة الاشتراك غير صالحة." });
  }
  rpcError("quickUpgradeOwnerPlan", error);
}

function reviewSmsPackageRpcError(error: { message?: string } | null) {
  const message = error?.message?.trim() ?? "";
  if (message.includes("REQUEST_NOT_FOUND")) {
    throw new TRPCError({ code: "NOT_FOUND", message: "طلب حزمة الرسائل غير موجود." });
  }
  if (message.includes("REQUEST_ALREADY_PROCESSED")) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "تمت معالجة طلب حزمة الرسائل مسبقاً." });
  }
  if (message.includes("SITE_NOT_FOUND")) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "لا يمكن مراجعة طلب حزمة الرسائل قبل وجود فرع/محطة مرتبطة بالمساحة." });
  }
  if (message.includes("APPROVED_MESSAGES_REQUIRED") || message.includes("INVALID_APPROVED_MESSAGES") || message.includes("INVALID_STATUS")) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "بيانات مراجعة حزمة الرسائل غير صالحة." });
  }
  rpcError("reviewSmsPackageRequest", error);
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
  const row = data?.[0] as { success?: boolean; membership_id?: number|string; site_id?: number|string; status?: string; replayed?: boolean } | undefined;
  if (!row || row.success !== true || row.membership_id === undefined || row.site_id === undefined || typeof row.status !== "string" || typeof row.replayed !== "boolean") throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Supabase returned a non-successful or invalid membership status result." });
  return { success: true, membershipId: Number(row.membership_id), siteId: Number(row.site_id), status: row.status, replayed: row.replayed };
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
  const row = data?.[0] as { success?: boolean; site_id?: number|string; replayed?: boolean } | undefined;
  if (!row || row.success !== true || row.site_id === undefined || typeof row.replayed !== "boolean") throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Supabase returned a non-successful or invalid owner attachment result." });
  return { success: true, siteId: Number(row.site_id), replayed: row.replayed };
}

export async function updateSubscription(input: {
  actorUserId: number; tenantId: number; plan: AdminSubscriptionPlan; status: AdminSubscriptionStatus;
  billingCycle: AdminBillingCycle; endsAt: Date; autoRenew: boolean; notes?: string; smsPlanId?: number | null; clientOperationId: string;
}) {
  const { data, error } = await supabaseAdmin().rpc("powerhub_admin_update_subscription_idempotent", {
    p_actor_user_id: input.actorUserId, p_tenant_id: input.tenantId, p_plan: input.plan, p_status: input.status,
    p_billing_cycle: input.billingCycle, p_ends_at: input.endsAt.toISOString(), p_auto_renew: input.autoRenew,
    p_notes: input.notes ?? null, p_sms_plan_id: input.smsPlanId ?? null, p_client_operation_id: input.clientOperationId,
  });
  rpcError("updateSubscription", error);
  const row = data?.[0] as { success?: boolean; subscription_id?: number|string; site_id?: number|string; replayed?: boolean } | undefined;
  if (!row || row.success !== true || !row.subscription_id) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Supabase returned a non-successful or invalid subscription update result." });
  return { success: true, subscriptionId: Number(row.subscription_id), siteId: Number(row.site_id), replayed: row.replayed };
}

export async function quickUpgradeOwnerPlan(input: {
  actorUserId: number;
  tenantId: number;
  plan: AdminSubscriptionPlan;
  note: string;
  clientOperationId: string;
}) {
  const { data, error } = await supabaseAdmin().rpc("powerhub_admin_quick_upgrade_owner_plan_idempotent", {
    p_actor_user_id: input.actorUserId,
    p_tenant_id: input.tenantId,
    p_plan: input.plan,
    p_note: input.note,
    p_client_operation_id: input.clientOperationId,
  });
  quickUpgradeOwnerPlanRpcError(error);
  const row = data?.[0] as { success?: boolean; plan?: string; replayed?: boolean } | undefined;
  if (!row || row.success !== true || typeof row.plan !== "string" || typeof row.replayed !== "boolean") throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Supabase returned a non-successful or invalid quick upgrade result." });
  return { success: true, plan: row.plan as AdminSubscriptionPlan, replayed: Boolean(row.replayed) };
}

export async function reviewSubscriptionUpgradeRequest(input: {
  actorUserId: number;
  requestId: number;
  decision: "approved" | "rejected";
  note?: string;
}) {
  const { data, error } = await supabaseAdmin().rpc("powerhub_admin_review_subscription_upgrade_request", {
    p_actor_user_id: input.actorUserId,
    p_request_id: input.requestId,
    p_decision: input.decision,
    p_note: input.note ?? null,
  });
  reviewSubscriptionRpcError(error);
  const row = data?.[0] as { success?: boolean; plan?: string; replayed?: boolean } | undefined;
  if (!row || row.success !== true || typeof row.plan !== "string") throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Supabase returned a non-successful or invalid subscription review result." });
  return { success: true, plan: row.plan as AdminSubscriptionPlan, replayed: Boolean(row.replayed) };
}

export async function reviewSmsPackageRequest(input: {
  actorUserId: number;
  requestId: number;
  status: "approved" | "rejected";
  approvedMessages: number;
  note?: string;
}) {
  const { data, error } = await supabaseAdmin().rpc("powerhub_admin_review_sms_package_request", {
    p_actor_user_id: input.actorUserId,
    p_request_id: input.requestId,
    p_status: input.status,
    p_approved_messages: input.approvedMessages,
    p_note: input.note ?? null,
  });
  reviewSmsPackageRpcError(error);
  const row = data?.[0] as { success?: boolean; tenant_id?: number | string; site_id?: number | string; status?: string; approved_messages?: number; replayed?: boolean } | undefined;
  if (!row || row.success !== true || typeof row.status !== "string" || typeof row.replayed !== "boolean") throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Supabase returned a non-successful or invalid SMS package review result." });
  return {
    success: true,
    tenantId: Number(row.tenant_id),
    siteId: Number(row.site_id),
    status: row.status as "approved" | "rejected",
    approvedMessages: Number(row.approved_messages ?? 0),
    replayed: Boolean(row.replayed),
  };
}

function renewSubscriptionRpcError(error: { message?: string } | null) {
  const message = error?.message?.trim() ?? "";
  if (message.includes("SUBSCRIPTION_NOT_FOUND")) {
    throw new TRPCError({ code: "NOT_FOUND", message: "اشتراك صاحب المولد غير موجود." });
  }
  if (message.includes("SITE_NOT_FOUND")) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "لا يمكن تجديد الاشتراك قبل وجود فرع/محطة مرتبطة بالمساحة." });
  }
  if (message.includes("INVALID_BILLING_CYCLE")) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "دورة الفوترة الحالية غير صالحة لتجديد الاشتراك." });
  }
  if (message.includes("INVALID_PERIODS")) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "عدد فترات التجديد يجب أن يكون بين 1 و24." });
  }
  rpcError("renewSubscription", error);
}

export async function renewSubscription(input: { actorUserId: number; tenantId: number; periods: number; clientOperationId: string }) {
  const { data, error } = await supabaseAdmin().rpc("powerhub_admin_renew_subscription_idempotent", {
    p_actor_user_id: input.actorUserId, p_tenant_id: input.tenantId, p_periods: input.periods, p_client_operation_id: input.clientOperationId,
  });
  renewSubscriptionRpcError(error);
  const row = data?.[0] as { success?: boolean; ends_at?: string; replayed?: boolean } | undefined;
  if (!row || row.success !== true || typeof row.ends_at !== "string") throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Supabase returned a non-successful or invalid subscription renewal result." });
  return { success: true, endsAt: new Date(row.ends_at), replayed: Boolean(row.replayed) };
}



