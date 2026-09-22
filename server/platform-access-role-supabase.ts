import { TRPCError } from "@trpc/server";
import { supabaseAdmin } from "./supabase-admin";

export type PlatformAccessRole = "platform_admin" | "finance_admin" | "platform_support";

export async function setPlatformAccessRole(input: {
  actorUserId: number;
  userId: number;
  platformRole: PlatformAccessRole;
}) {
  const { data, error } = await supabaseAdmin().rpc("powerhub_admin_set_platform_access_role", {
    p_actor_user_id: input.actorUserId,
    p_user_id: input.userId,
    p_platform_role: input.platformRole,
  });

  if (error) {
    const message = error.message?.trim() ?? "";
    if (message.includes("FORBIDDEN")) throw new TRPCError({ code: "FORBIDDEN", message: "دور المنصة الحالي لا يملك هذه الصلاحية." });
    if (message.includes("SELF_ROLE_CHANGE")) throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن تغيير دور حسابك من هذه العملية." });
    if (message.includes("ACCOUNT_NOT_FOUND")) throw new TRPCError({ code: "NOT_FOUND", message: "حساب إدارة المنصة غير موجود." });
    if (message.includes("PLATFORM_OWNER_PROTECTED")) throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكن تعديل دور مالك المنصة من هذا المسار." });
    if (message.includes("INVALID_PLATFORM_ROLE")) throw new TRPCError({ code: "BAD_REQUEST", message: "دور حساب المنصة غير صالح." });
    console.error("[AdminSupabase] setPlatformAccessRole", { message });
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحديث دور حساب إدارة المنصة في Supabase." });
  }

  const row = data?.[0] as { success?: boolean; platform_role?: string } | undefined;
  if (!row || typeof row.platform_role !== "string") {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "أعادت Supabase نتيجة غير صالحة لتحديث دور الحساب." });
  }

  return { success: Boolean(row.success), platformRole: row.platform_role as PlatformAccessRole };
}
