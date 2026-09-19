import { TRPCError } from "@trpc/server";
import { supabaseAdmin } from "./supabase-admin";
import crypto from "node:crypto";

export async function requestOwnerAccessRecovery(input: {
  actorUserId: number;
  tenantId: number;
  note?: string;
  clientOperationId: string;
}) {
  const requestFingerprint = crypto.createHash("sha256").update(JSON.stringify({ actorUserId: input.actorUserId, tenantId: input.tenantId, note: input.note?.trim() ?? null })).digest("hex");
  const { data, error } = await supabaseAdmin().rpc("powerhub_admin_request_owner_access_recovery", {
    p_actor_user_id: input.actorUserId,
    p_tenant_id: input.tenantId,
    p_note: input.note ?? null,
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
  if (message.includes("INVALID_OPERATION_ID") || message.includes("INVALID_REQUEST_FINGERPRINT")) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "معرّف العملية أو بصمة الطلب غير صالحة." });
  }
  if (message.includes("OPERATION_CONFLICT")) {
    throw new TRPCError({ code: "CONFLICT", message: "معرّف العملية مستخدم لطلب استرداد مختلف." });
  }
  if (message.includes("TENANT_NOT_FOUND")) {
    throw new TRPCError({ code: "NOT_FOUND", message: "مساحة المولد غير موجودة." });
  }
  if (message.includes("INVALID_NOTE")) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "ملاحظة طلب الاسترداد تتجاوز الحد المسموح." });
  }
  if (error) {
    console.error("[AdminSupabase] requestOwnerAccessRecovery", { message });
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر إنشاء طلب استرداد وصول صاحب المولد في Supabase." });
  }

  const row = data?.[0] as { success?: boolean; recovery_request_id?: number | string; replayed?: boolean } | undefined;
  if (!row || row.success !== true || row.recovery_request_id === undefined || typeof row.replayed !== "boolean") {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "أعادت Supabase نتيجة غير صالحة لطلب استرداد الوصول." });
  }

  return { success: true, delivery: "deferred" as const, recoveryRequestId: Number(row.recovery_request_id), replayed: row.replayed };
}
