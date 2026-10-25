import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { supabaseAdmin } from "./supabase-admin";

export async function requestOwnerAccessRecovery(input: {
  actorUserId: number;
  tenantId: number;
  note?: string;
  clientOperationId: string;
}) {
  const normalizedNote = input.note?.trim() || null;
  const requestFingerprint = createHash("sha256").update(JSON.stringify({
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    note: normalizedNote,
  })).digest("hex");
  const { data, error } = await supabaseAdmin().rpc("powerhub_admin_request_owner_access_recovery", {
    p_actor_user_id: input.actorUserId,
    p_tenant_id: input.tenantId,
    p_note: normalizedNote,
    p_client_operation_id: input.clientOperationId,
    p_request_fingerprint: requestFingerprint,
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
