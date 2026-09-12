import { TRPCError } from "@trpc/server";
import { supabaseAdmin } from "./supabase-admin";

export type PlatformAccountStatus = "active" | "locked" | "disabled";

export async function setPlatformAccountStatus(input: {
  actorUserId: number;
  userId: number;
  accountStatus: PlatformAccountStatus;
}) {
  const { data, error } = await supabaseAdmin().rpc("powerhub_admin_set_platform_account_status", {
    p_actor_user_id: input.actorUserId,
    p_user_id: input.userId,
    p_account_status: input.accountStatus,
  });

  if (error) {
    const message = error.message?.trim() ?? "";
    if (message.includes("FORBIDDEN")) throw new TRPCError({ code: "FORBIDDEN", message: "دور المنصة الحالي لا يملك هذه الصلاحية." });
    if (message.includes("SELF_STATUS_CHANGE")) throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن تغيير حالة حسابك من هذه العملية." });
    if (message.includes("ACCOUNT_NOT_FOUND")) throw new TRPCError({ code: "NOT_FOUND", message: "حساب إدارة المنصة غير موجود." });
    if (message.includes("PLATFORM_OWNER_PROTECTED")) throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكن تغيير حالة مالك المنصة من هذا المسار." });
    if (message.includes("INVALID_ACCOUNT_STATUS")) throw new TRPCError({ code: "BAD_REQUEST", message: "حالة حساب المنصة غير صالحة." });
    console.error("[AdminSupabase] setPlatformAccountStatus", { message });
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحديث حالة حساب إدارة المنصة في Supabase." });
  }

  const row = data?.[0] as { success?: boolean; account_status?: string } | undefined;
  if (!row || typeof row.account_status !== "string") {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "أعادت Supabase نتيجة غير صالحة لتحديث حالة الحساب." });
  }

  return { success: Boolean(row.success), accountStatus: row.account_status as PlatformAccountStatus };
}
