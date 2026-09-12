import { TRPCError } from "@trpc/server";
import { supabaseAdmin } from "./supabase-admin";

function rpcError(operation: string, error: { message?: string } | null): never {
  throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error?.message || `تعذر تنفيذ ${operation} عبر Supabase.` });
}

export async function invitePlatformAccess(input: { actorUserId: number; email: string; platformRole: "platform_admin" | "finance_admin"; expiresInHours: number }) {
  const { data, error } = await supabaseAdmin().rpc("powerhub_admin_invite_platform_access", {
    p_actor_user_id: input.actorUserId, p_email: input.email, p_platform_role: input.platformRole, p_expires_in_hours: input.expiresInHours,
  });
  if (error) {
    const message = error.message?.trim() ?? "";
    if (message.includes("FORBIDDEN")) throw new TRPCError({ code: "FORBIDDEN", message: "لا تملك صلاحية دعوة حسابات إدارة المنصة." });
    if (message.includes("INVALID_EMAIL")) throw new TRPCError({ code: "BAD_REQUEST", message: "البريد الإلكتروني غير صالح." });
    if (message.includes("INVALID_PLATFORM_ROLE")) throw new TRPCError({ code: "BAD_REQUEST", message: "دور المنصة غير صالح." });
    if (message.includes("INVALID_EXPIRATION")) throw new TRPCError({ code: "BAD_REQUEST", message: "مدة الدعوة غير صالحة." });
    if (message.includes("ACCOUNT_ALREADY_EXISTS")) throw new TRPCError({ code: "CONFLICT", message: "يوجد حساب إدارة منصة مرتبط بهذا البريد الإلكتروني." });
    if (message.includes("INVITATION_ALREADY_PENDING")) throw new TRPCError({ code: "CONFLICT", message: "توجد دعوة نشطة بالفعل لهذا البريد الإلكتروني." });
    rpcError("دعوة وصول لإدارة المنصة", error);
  }
  const row = data?.[0] as { id?: number; email?: string; platform_role?: string; expires_at?: string } | undefined;
  if (!row || typeof row.id !== "number" || typeof row.email !== "string" || typeof row.platform_role !== "string" || typeof row.expires_at !== "string") throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "لم تُعد Supabase نتيجة صالحة للدعوة." });
  return { id: row.id, email: row.email, platformRole: row.platform_role as "platform_admin" | "finance_admin", expiresAt: new Date(row.expires_at), status: "invited" as const };
}

export async function acceptPendingPlatformInvitation(input: { authUserId: string; email: string }) {
  const { data, error } = await supabaseAdmin().rpc("powerhub_accept_pending_platform_invitation", { p_auth_user_id: input.authUserId, p_email: input.email });
  if (error) rpcError("قبول دعوة إدارة المنصة", error);
  const row = data?.[0] as { accepted?: boolean; platform_role?: string | null; invitation_id?: number | null } | undefined;
  return { accepted: Boolean(row?.accepted), platformRole: typeof row?.platform_role === "string" ? row.platform_role : null, invitationId: typeof row?.invitation_id === "number" ? row.invitation_id : null };
}
