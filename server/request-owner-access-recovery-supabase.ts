import { TRPCError } from "@trpc/server";
import { supabaseAdmin } from "./supabase-admin";

export async function requestOwnerAccessRecovery(input: {
  actorUserId: number;
  tenantId: number;
  note?: string;
}) {
  const { data, error } = await supabaseAdmin().rpc("powerhub_admin_request_owner_access_recovery", {
    p_actor_user_id: input.actorUserId,
    p_tenant_id: input.tenantId,
    p_note: input.note ?? null,
  });

  const message = error?.message?.trim() ?? "";
  if (message.includes("FORBIDDEN")) {
    throw new TRPCError({ code: "FORBIDDEN", message: "دور المنصة الحالي لا يملك هذه الصلاحية." });
  }
  if (message.includes("OWNER_PROFILE_NOT_FOUND")) {
    throw new TRPCError({ code: "NOT_FOUND", message: "ملف مالك المولد غير موجود." });
  }
  if (message.includes("INVALID_NOTE")) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "ملاحظة طلب الاسترداد تتجاوز الحد المسموح." });
  }
  if (error) {
    console.error("[AdminSupabase] requestOwnerAccessRecovery", { message });
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر إنشاء طلب استرداد وصول صاحب المولد في Supabase." });
  }

  const row = data?.[0] as { success?: boolean; recovery_request_id?: number | string } | undefined;
  if (!row || row.success !== true || row.recovery_request_id === undefined) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "أعادت Supabase نتيجة غير صالحة لطلب استرداد الوصول." });
  }

  return { success: true, delivery: "deferred" as const, recoveryRequestId: Number(row.recovery_request_id) };
}
