import { TRPCError } from "@trpc/server";
import { supabaseAdmin } from "./supabase-admin";

export async function savePlatformSetting(input: {
  actorUserId: number;
  settingKey: string;
  isEnabled: boolean;
  message?: string;
  value?: Record<string, unknown>;
}) {
  const { data, error } = await supabaseAdmin().rpc("powerhub_admin_save_platform_setting", {
    p_actor_user_id: input.actorUserId,
    p_setting_key: input.settingKey,
    p_is_enabled: input.isEnabled,
    p_message: input.message ?? null,
    p_value: input.value === undefined ? null : input.value,
    p_has_value: input.value !== undefined,
  });

  if (error) {
    const message = error.message?.trim() ?? "";
    if (message.includes("FORBIDDEN")) throw new TRPCError({ code: "FORBIDDEN", message: "دور المنصة الحالي لا يملك هذه الصلاحية." });
    if (message.includes("INVALID_SETTING_KEY")) throw new TRPCError({ code: "BAD_REQUEST", message: "مفتاح إعداد المنصة غير صالح." });
    if (message.includes("INVALID_SETTING_MESSAGE")) throw new TRPCError({ code: "BAD_REQUEST", message: "رسالة إعداد المنصة تتجاوز الحد المسموح." });
    console.error("[AdminSupabase] savePlatformSetting", { message });
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر حفظ إعداد المنصة في Supabase." });
  }

  const row = data?.[0] as { success?: boolean } | undefined;
  if (!row || row.success !== true) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "أعادت Supabase نتيجة غير صالحة لحفظ إعداد المنصة." });
  }

  return { success: true };
}
