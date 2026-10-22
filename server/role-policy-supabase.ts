import { TRPCError } from "@trpc/server";
import { supabaseAdmin } from "./supabase-admin";
import type { PowerCapability, PowerRole } from "../shared/powerhub-rbac";

export async function saveRolePolicy(input: {
  actorUserId: number;
  role: PowerRole;
  capability: PowerCapability;
  isAllowed: boolean;
}) {
  const { data, error } = await supabaseAdmin().rpc("powerhub_admin_save_role_policy", {
    p_actor_user_id: input.actorUserId,
    p_role: input.role,
    p_capability: input.capability,
    p_is_allowed: input.isAllowed,
  });

  const message = error?.message?.trim() ?? "";
  if (message.includes("PLATFORM_ADMIN_REQUIRED")) {
    throw new TRPCError({ code: "FORBIDDEN", message: "دور المنصة الحالي لا يملك هذه الصلاحية." });
  }
  if (message.includes("INVALID_ROLE") || message.includes("INVALID_CAPABILITY")) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "بيانات سياسة الصلاحيات غير صالحة." });
  }
  if (error) {
    console.error("[AdminSupabase] saveRolePolicy", { message });
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر حفظ سياسة الصلاحيات في Supabase." });
  }

  const row = data?.[0] as {
    success?: boolean;
    policy_id?: number | string;
    role?: string;
    capability?: string;
    is_allowed?: boolean;
  } | undefined;
  if (!row || row.success !== true || row.policy_id === undefined) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "أعادت Supabase نتيجة غير صالحة لسياسة الصلاحيات." });
  }

  return {
    success: true,
    policyId: Number(row.policy_id),
    role: row.role,
    capability: row.capability,
    isAllowed: row.is_allowed,
  };
}
