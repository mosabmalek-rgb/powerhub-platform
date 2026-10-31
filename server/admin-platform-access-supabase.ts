import { TRPCError } from "@trpc/server";
import crypto from "node:crypto";
import { supabaseAdmin } from "./supabase-admin";

export type PlatformAccessRole = "platform_admin" | "finance_admin" | "platform_support";
export type PlatformAccountStatus = "active" | "locked" | "disabled";

function mapRpcError(message: string, fallback: string): never {
  if (message.includes("PLATFORM_OWNER_REQUIRED")) throw new TRPCError({ code: "FORBIDDEN", message: "هذه العملية متاحة لمالك المنصة فقط." });
  if (message.includes("TARGET_NOT_FOUND") || message.includes("ACCOUNT_NOT_FOUND")) throw new TRPCError({ code: "NOT_FOUND", message: "حساب إدارة المنصة غير موجود." });
  if (message.includes("TARGET_IS_OWNER") || message.includes("PLATFORM_OWNER_PROTECTED")) throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكن تعديل مالك المنصة من هذا المسار." });
  if (message.includes("SELF_MODIFICATION") || message.includes("SELF_ROLE_CHANGE")) throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن تعديل حالة أو دور حسابك من هذه العملية." });
  if (message.includes("OPERATION_CONFLICT")) throw new TRPCError({ code: "CONFLICT", message: "تعارض معرّف العملية مع بيانات دعوة مختلفة. ابدأ دعوة جديدة بعد مراجعة البيانات." });
  if (message.includes("DUPLICATE_INVITATION")) throw new TRPCError({ code: "CONFLICT", message: "توجد دعوة وصول نشطة بالفعل لهذا البريد الإلكتروني." });
  if (message.includes("ACCOUNT_ALREADY_EXISTS")) throw new TRPCError({ code: "CONFLICT", message: "يوجد حساب مرتبط بهذا البريد الإلكتروني بالفعل." });
  if (message.includes("INVALID_")) throw new TRPCError({ code: "BAD_REQUEST", message: "بيانات دعوة الوصول غير صالحة." });
  throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: fallback });
}

export async function invitePlatformAccessSupabase(input: {
  actorUserId: number;
  email: string;
  platformRole: PlatformAccessRole;
  expiresInHours: number;
  clientOperationId: string;
}) {
  const email = input.email.trim().toLowerCase();
  const requestFingerprint = crypto.createHash("sha256").update(JSON.stringify({
    actorUserId: input.actorUserId,
    email,
    platformRole: input.platformRole,
    expiresInHours: input.expiresInHours,
  })).digest("hex");
  const expiresAt = new Date(Date.now() + input.expiresInHours * 60 * 60 * 1000).toISOString();
  const tokenHash = crypto.createHash("sha256").update(crypto.randomBytes(32)).digest("hex");
  const { data, error } = await supabaseAdmin().rpc("powerhub_admin_invite_platform_access", {
    p_actor_user_id: input.actorUserId,
    p_email: email,
    p_platform_role: input.platformRole,
    p_token_hash: tokenHash,
    p_expires_at: expiresAt,
    p_client_operation_id: input.clientOperationId,
    p_request_fingerprint: requestFingerprint,
  });
  if (error) mapRpcError(error.message, "تعذر إنشاء دعوة وصول إدارة المنصة.");
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "لم تُعد دالة دعوة وصول المنصة نتيجة صالحة." });
  return {
    id: Number(row.id),
    email: row.email,
    platformRole: row.platform_role as PlatformAccessRole,
    expiresAt: new Date(row.expires_at),
    status: row.status as "invited",
    replayed: row.replayed === true,
  };
}

export async function setPlatformAccountStatusSupabase(input: { actorUserId: number; userId: number; accountStatus: PlatformAccountStatus }) {
  const { error } = await supabaseAdmin().rpc("powerhub_admin_set_platform_account_status", { p_actor_user_id: input.actorUserId, p_target_user_id: input.userId, p_account_status: input.accountStatus });
  if (error) mapRpcError(error.message, "تعذر تحديث حالة حساب إدارة المنصة.");
  return { success: true as const };
}

export async function setPlatformAccessRoleSupabase(input: { actorUserId: number; userId: number; platformRole: PlatformAccessRole }) {
  const { error } = await supabaseAdmin().rpc("powerhub_admin_set_platform_access_role", { p_actor_user_id: input.actorUserId, p_target_user_id: input.userId, p_platform_role: input.platformRole });
  if (error) mapRpcError(error.message, "تعذر تحديث دور حساب إدارة المنصة.");
  return { success: true as const };
}
