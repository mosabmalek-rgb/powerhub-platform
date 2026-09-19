import { TRPCError } from "@trpc/server";
import { supabaseAdmin } from "./supabase-admin";

export async function createTariffPolicy(input: {
  actorUserId: number;
  minimumPricePerKwh: number;
  maximumPricePerKwh: number;
  effectiveFrom: Date;
  notificationRequested: boolean;
  notes?: string;
}) {
  const { data, error } = await supabaseAdmin().rpc("powerhub_admin_create_tariff_policy", {
    p_actor_user_id: input.actorUserId,
    p_minimum_price_per_kwh: input.minimumPricePerKwh,
    p_maximum_price_per_kwh: input.maximumPricePerKwh,
    p_effective_from: input.effectiveFrom.toISOString(),
    p_notification_requested: input.notificationRequested,
    p_notes: input.notes ?? null,
  });

  if (error) {
    const message = error.message?.trim() ?? "";
    if (message.includes("FORBIDDEN")) throw new TRPCError({ code: "FORBIDDEN", message: "دور المنصة الحالي لا يملك هذه الصلاحية." });
    if (message.includes("INVALID_TARIFF_RANGE")) throw new TRPCError({ code: "BAD_REQUEST", message: "نطاق التسعيرة غير صالح." });
    if (message.includes("INVALID_EFFECTIVE_FROM")) throw new TRPCError({ code: "BAD_REQUEST", message: "تاريخ سريان التسعيرة غير صالح." });
    if (message.includes("INVALID_NOTES")) throw new TRPCError({ code: "BAD_REQUEST", message: "ملاحظات التسعيرة تتجاوز الحد المسموح." });
    console.error("[AdminSupabase] createTariffPolicy", { message });
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر إنشاء سياسة التسعير في Supabase." });
  }

  const row = data?.[0] as { success?: boolean; policy_id?: number | string; queued_notifications?: number } | undefined;
  if (!row || row.success !== true || row.policy_id === undefined) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "أعادت Supabase نتيجة غير صالحة لإنشاء سياسة التسعير." });
  }

  return {
    success: true,
    id: Number(row.policy_id),
    queuedNotifications: Number(row.queued_notifications ?? 0),
  };
}
