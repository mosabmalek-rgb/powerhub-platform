import { TRPCError } from "@trpc/server";
import { supabaseAdmin } from "./supabase-admin";

export type InviteTenantAccessInput = {
  actorUserId: number;
  tenantId: number;
  siteId?: number;
  email: string;
  tenantRole: "owner" | "admin" | "member";
  siteRole?: "owner" | "manager" | "accountant" | "collector" | "technician" | "viewer";
  tokenHash: string;
  expiresAt: Date;
};

export async function inviteTenantAccess(input: InviteTenantAccessInput) {
  const { data, error } = await supabaseAdmin().rpc("powerhub_admin_invite_tenant_access", {
    p_actor_user_id: input.actorUserId,
    p_tenant_id: input.tenantId,
    p_site_id: input.siteId ?? null,
    p_email: input.email,
    p_tenant_role: input.tenantRole,
    p_site_role: input.siteRole ?? null,
    p_token_hash: input.tokenHash,
    p_expires_at: input.expiresAt.toISOString(),
  });

  if (error) {
    const message = error.message ?? "";
    if (message.includes("PLATFORM_ADMIN_REQUIRED")) throw new TRPCError({ code: "FORBIDDEN", message: "دور المنصة الحالي لا يملك هذه الصلاحية." });
    if (message.includes("TENANT_NOT_FOUND")) throw new TRPCError({ code: "NOT_FOUND", message: "المستأجر غير موجود." });
    if (message.includes("SITE_NOT_FOUND")) throw new TRPCError({ code: "NOT_FOUND", message: "الفرع غير موجود ضمن المستأجر المحدد." });
    if (message.includes("INVALID_")) throw new TRPCError({ code: "BAD_REQUEST", message: "بيانات دعوة الوصول غير صالحة." });
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر إنشاء دعوة الوصول في Supabase." });
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.invitation_id) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "لم يُرجع Supabase رقم دعوة صالحًا." });

  return {
    id: Number(row.invitation_id),
    email: String(row.email),
    expiresAt: new Date(String(row.expires_at)),
    status: String(row.status) as "invited",
  };
}
