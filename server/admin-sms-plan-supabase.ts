import { TRPCError } from "@trpc/server";
import { supabaseAdmin } from "./supabase-admin";

export type SmsPlanInput = {
  actorUserId: number;
  code?: string;
  name?: string;
  description?: string;
  includedMessages?: number;
  isActive?: boolean;
  id?: number;
};

type SmsPlanRow = {
  id: number | string;
  code: string;
  name: string;
  description: string | null;
  included_messages: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

function mapError(message: string, operation: "create" | "update"): never {
  if (message.includes("PLATFORM_ADMIN_REQUIRED")) throw new TRPCError({ code: "FORBIDDEN", message: "دور المنصة الحالي لا يملك هذه الصلاحية." });
  if (message.includes("DUPLICATE_CODE")) throw new TRPCError({ code: "CONFLICT", message: "رمز باقة SMS مستخدم بالفعل." });
  if (message.includes("PLAN_NOT_FOUND")) throw new TRPCError({ code: "NOT_FOUND", message: "باقة SMS غير موجودة." });
  if (message.includes("INVALID_")) throw new TRPCError({ code: "BAD_REQUEST", message: "بيانات باقة SMS غير صالحة." });
  throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `تعذر ${operation === "create" ? "إنشاء" : "تحديث"} باقة SMS عبر Supabase.` });
}

function mapPlan(row: SmsPlanRow) {
  return {
    id: Number(row.id),
    code: row.code,
    name: row.name,
    description: row.description,
    includedMessages: row.included_messages,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createSmsPlanSupabase(input: SmsPlanInput) {
  const { data, error } = await supabaseAdmin().rpc("powerhub_admin_create_sms_plan", {
    p_actor_user_id: input.actorUserId,
    p_code: input.code,
    p_name: input.name,
    p_description: input.description ?? null,
    p_included_messages: input.includedMessages ?? 0,
    p_is_active: input.isActive ?? true,
  });
  if (error) mapError(error.message, "create");
  const row = (data as SmsPlanRow[] | null)?.[0];
  if (!row) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Supabase لم يُرجع باقة SMS بعد الإنشاء." });
  return mapPlan(row);
}

export async function updateSmsPlanSupabase(input: SmsPlanInput) {
  const { data, error } = await supabaseAdmin().rpc("powerhub_admin_update_sms_plan", {
    p_actor_user_id: input.actorUserId,
    p_id: input.id,
    p_name: input.name ?? null,
    p_description: input.description ?? null,
    p_included_messages: input.includedMessages ?? null,
    p_is_active: input.isActive ?? null,
  });
  if (error) mapError(error.message, "update");
  const row = (data as SmsPlanRow[] | null)?.[0];
  if (!row) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Supabase لم يُرجع باقة SMS بعد التحديث." });
  return mapPlan(row);
}
