import { TRPCError } from "@trpc/server";
import { supabaseAdmin } from "./supabase-admin";

const PACKAGE_CODES = ["basic", "advanced", "professional", "business", "vip"] as const;
const PACKAGE_FEATURE_KEYS = ["subscribers", "sms", "fieldUsers", "platformUsers", "branches", "logo", "support"] as const;
function validatePackageCatalog(value: Record<string, unknown>) {
  const packages = value.packages;
  if (!Array.isArray(packages) || packages.length !== 5) throw new TRPCError({ code: "BAD_REQUEST", message: "يجب أن يحتوي كتالوج الباقات على الباقات الخمس فقط." });
  const seen = new Set<string>();
  for (const item of packages) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new TRPCError({ code: "BAD_REQUEST", message: "تعريف إحدى الباقات غير صالح." });
    const pkg = item as Record<string, unknown>;
    const code = typeof pkg.code === "string" ? pkg.code : "";
    if (!(PACKAGE_CODES as readonly string[]).includes(code) || seen.has(code)) throw new TRPCError({ code: "BAD_REQUEST", message: "رمز الباقة غير صالح أو مكرر." });
    seen.add(code);
    for (const key of ["price","smsCost","serviceNet","includedMessages","includedSubscribers","fieldUsers","platformUsers","branches","logoAddonPrice"]) {
      const n = Number(pkg[key] ?? 0);
      if (!Number.isInteger(n) || n < 0 || n > 100000000) throw new TRPCError({ code: "BAD_REQUEST", message: `القيمة الرقمية ${key} في الباقة ${code} غير صالحة.` });
    }
    if (Number(pkg.branches) < 1) throw new TRPCError({ code: "BAD_REQUEST", message: `يجب أن يكون حد فروع الباقة ${code} واحدًا على الأقل.` });
    if (!["maximum","minimum"].includes(String(pkg.subscriberLimitMode ?? "maximum"))) throw new TRPCError({ code: "BAD_REQUEST", message: `وضع حد المشتركين في الباقة ${code} غير صالح.` });
    const features = pkg.features;
    if (!features || typeof features !== "object" || Array.isArray(features)) throw new TRPCError({ code: "BAD_REQUEST", message: `عقد الميزات في الباقة ${code} مفقود.` });
    for (const key of PACKAGE_FEATURE_KEYS) {
      if (!(key in (features as Record<string, unknown>))) throw new TRPCError({ code: "BAD_REQUEST", message: `الميزة ${key} مفقودة من الباقة ${code}.` });
    }
  }
}

export async function savePlatformSetting(input: {
  actorUserId: number;
  settingKey: string;
  isEnabled: boolean;
  message?: string;
  value?: Record<string, unknown>;
}) {
  if (input.settingKey === "subscription_package_catalog") {
    if (!input.value) throw new TRPCError({ code: "BAD_REQUEST", message: "كتالوج الباقات يتطلب قيمة كاملة." });
    validatePackageCatalog(input.value);
  }
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
