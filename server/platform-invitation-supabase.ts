import { TRPCError } from "@trpc/server";
import { supabaseAdmin } from "./supabase-admin";

export async function invitePlatformAccess(input: {
  actorUserId: number;
  email: string;
  platformRole: "platform_admin" | "finance_admin";
  expiresInHours: number;
}) {
  const { data, error } = await supabaseAdmin().rpc("powerhub_admin_invite_platform_access", {
    p_actor_user_id: input.actorUserId,
    p_email: input.email,
    p_platform_role: input.platformRole,
    p_expires_in_hours: input.expiresInHours,
  });

  if (error) {
    const message = error.message?.trim() ?? "";
    if (message.includes("FORBIDDEN")) throw new TRPCError({ code: "FORBIDDEN", message: "دور المنصة الحالي لا يملك هذه الصلاحية." });
    if (message.includes("ACCOUNT_ALREADY_EXISTS")) throw new TRPCError({ code: "CONFLICT", message: "يوجد حساب منصة مرتبط بهذا البريد الإلكتروني." });
    if (message.includes("INVITATION_ALREADY_PENDING")) throw new TRPCError({ code: "CONFLICT", message: "توجد دعوة وصول معلقة لهذا البريد الإلكتروني بالفعل." });
    if (message.includes("INVALID_EMAIL") || message.includes("INVALID_PLATFORM_ROLE") || message.includes("INVALID_EXPIRATION")) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "بيانات دعوة الوصول إلى إدارة المنصة غير صالحة." });
    }
    console.error("[AdminSupabase] invitePlatformAccess", { message });
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر إنشاء دعوة وصول إدارة المنصة في Supabase." });
  }

  const row = data?.[0] as { id?: number | string; email?: string; platform_role?: string; expires_at?: string; status?: string } | undefined;
  if (!row || row.id === undefined || typeof row.email !== "string" || typeof row.platform_role !== "string" || typeof row.expires_at !== "string") {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "أعادت Supabase نتيجة غير صالحة لدعوة الوصول." });
  }

  return {
    id: Number(row.id),
    email: row.email,
    platformRole: row.platform_role as "platform_admin" | "finance_admin",
    expiresAt: new Date(row.expires_at),
    status: (row.status ?? "invited") as "invited",
  };
}
