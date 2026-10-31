import { createHash } from "node:crypto";
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
  expiresInHours: number;
  clientOperationId: string;
};

export async function inviteTenantAccess(input: InviteTenantAccessInput) {
  const email = input.email.trim().toLowerCase();
  const siteRole = input.tenantRole === "owner" ? "owner" : input.siteRole ?? null;
  const requestFingerprint = createHash("sha256").update(JSON.stringify({
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    siteId: input.siteId ?? null,
    email,
    tenantRole: input.tenantRole,
    siteRole,
    expiresInHours: input.expiresInHours,
  })).digest("hex");

  const admin = supabaseAdmin();
  const { data: existingUser, error: userLookupError } = await admin
    .from("users")
    .select("id")
    .eq("email", email)
    .maybeSingle();

  if (userLookupError) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر التحقق من حساب المستخدم في PowerHub." });
  }
  if (!existingUser) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "لا يوجد حساب PowerHub مسجل بهذا البريد. أنشئ حساب الدخول أولاً، ثم امنحه الوصول إلى المساحة.",
    });
  }

  const { data, error } = await admin.rpc("powerhub_admin_invite_tenant_access", {
    p_actor_user_id: input.actorUserId,
    p_tenant_id: input.tenantId,
    p_site_id: input.siteId ?? null,
    p_email: email,
    p_tenant_role: input.tenantRole,
    p_site_role: siteRole,
    p_token_hash: input.tokenHash,
    p_expires_at: input.expiresAt.toISOString(),
    p_client_operation_id: input.clientOperationId,
    p_request_fingerprint: requestFingerprint,
  });

  if (error) {
    const message = error.message ?? "";
    if (message.includes("PLATFORM_ADMIN_REQUIRED")) throw new TRPCError({ code: "FORBIDDEN", message: "دور المنصة الحالي لا يملك هذه الصلاحية." });
    if (message.includes("TENANT_NOT_FOUND")) throw new TRPCError({ code: "NOT_FOUND", message: "المستأجر غير موجود." });
    if (message.includes("SITE_NOT_FOUND")) throw new TRPCError({ code: "NOT_FOUND", message: "الفرع غير موجود ضمن المستأجر المحدد." });
    if (message.includes("OPERATION_CONFLICT")) throw new TRPCError({ code: "CONFLICT", message: "تعارض معرّف العملية مع بيانات دعوة مختلفة. ابدأ دعوة جديدة بعد مراجعة البيانات." });
    if (message.includes("DUPLICATE_INVITATION")) throw new TRPCError({ code: "CONFLICT", message: "توجد دعوة نشطة لهذا البريد الإلكتروني ضمن المستأجر." });
    if (message.includes("ACCOUNT_ALREADY_EXISTS")) throw new TRPCError({ code: "CONFLICT", message: "يوجد حساب مرتبط بهذا البريد الإلكتروني بالفعل." });
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
    replayed: row.replayed === true,
  };
}
