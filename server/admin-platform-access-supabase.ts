import { TRPCError } from "@trpc/server";
import crypto from "node:crypto";
import { supabaseAdmin } from "./supabase-admin";

export type PlatformAccessRole = "platform_admin" | "finance_admin";
export type PlatformAccountStatus = "active" | "locked" | "disabled";

function mapRpcError(message: string, fallback: string): never {
  if (message.includes("PLATFORM_OWNER_REQUIRED")) throw new TRPCError({ code: "FORBIDDEN", message: "هذه العملية متاحة لمالك المنصة فقط." });
  if (message.includes("TARGET_NOT_FOUND")) throw new TRPCError({ code: "NOT_FOUND", message: "حساب إدارة المنصة غير موجود." });
  if (message.includes("TARGET_IS_OWNER")) throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكن تعديل مالك المنصة من هذا المسار." });
  if (message.includes("SELF_MODIFICATION")) throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن تعديل حالة أو دور حسابك من هذه العملية." });
  if (message.includes("DUPLICATE_INVITATION")) throw new TRPCError({ code: "CONFLICT", message: "توجد دعوة وصول نشطة بالفعل لهذا البريد الإلكتروني." });
  throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: fallback });
}

export async function invitePlatformAccessSupabase(input: {
  actorUserId: number;
  email: string;
  platformRole: PlatformAccessRole;
  expiresInHours: number;
}) {
  const expiresAt = new Date(Date.now() + input.expiresInHours * 60 * 60 * 1000).toISOString();
  const tokenHash = crypto.createHash("sha256").update(crypto.randomBytes(32)).digest("hex");
  const { data, error } = await supabaseAdmin().rpc("powerhub_admin_invite_platform_access", {
    p_actor_user_id: input.actorUserId,
    p_email: input.email,
    p_platform_role: input.platformRole,
    p_token_hash: tokenHash,
    p_expires_at: expiresAt,
  });
  if (error) mapRpcError(error.message, "تعذر إنشاء دعوة وصول إدارة المنصة.");
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "لم تُعد دالة دعوة وصول المنصة نتيجة صالحة." });
  return {
    id: Number(row.id),
    email: row.email,
    platformRole: row.platform_role as "platform_admin" | "finance_admin",
    expiresAt: new Date(row.expires_at),
    status: row.status as "invited",
  };
}

export async function setPlatformAccountStatusSupabase(input: {
  actorUserId: number;
  userId: number;
  accountStatus: PlatformAccountStatus;
}) {
  const { error } = await supabaseAdmin().rpc("powerhub_admin_set_platform_account_status", {
    p_actor_user_id: input.actorUserId,
    p_target_user_id: input.userId,
    p_account_status: input.accountStatus,
  });
  if (error) mapRpcError(error.message, "تعذر تحديث حالة حساب إدارة المنصة.");
  return { success: true as const };
}

export async function setPlatformAccessRoleSupabase(input: {
  actorUserId: number;
  userId: number;
  platformRole: PlatformAccessRole;
}) {
  const { error } = await supabaseAdmin().rpc("powerhub_admin_set_platform_access_role", {
    p_actor_user_id: input.actorUserId,
    p_target_user_id: input.userId,
    p_platform_role: input.platformRole,
  });
  if (error) mapRpcError(error.message, "تعذر تحديث دور حساب إدارة المنصة.");
  return { success: true as const };
}
