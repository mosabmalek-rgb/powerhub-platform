import { supabaseAdmin } from "./supabase-admin";

export type SupabaseProfileUser = {
  id: number;
  openId: string;
  name: string | null;
  email: string | null;
  loginMethod: string | null;
  role: "user" | "admin";
  platformRole: "platform_owner" | "platform_admin" | "finance_admin" | null;
  accountStatus: "active" | "locked" | "disabled";
  mustChangePassword: boolean;
  temporaryPasswordIssuedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  lastSignedIn: Date;
};

type UserRow = {
  id: number | string;
  auth_user_id: string;
  name: string | null;
  email: string | null;
  login_method: string | null;
  role: SupabaseProfileUser["role"];
  platform_role: SupabaseProfileUser["platformRole"];
  account_status: SupabaseProfileUser["accountStatus"];
  must_change_password: boolean;
  temporary_password_issued_at: string | null;
  created_at: string;
  updated_at: string;
  last_signed_in: string;
};

type SupabaseRpcError = {
  code?: string;
  message?: string;
};

function isMissingRpc(error: SupabaseRpcError | null | undefined) {
  return error?.code === "42883";
}

export function mapSupabaseProfile(row: UserRow): SupabaseProfileUser {
  return {
    id: Number(row.id),
    openId: row.auth_user_id,
    name: row.name,
    email: row.email,
    loginMethod: row.login_method,
    role: row.role,
    platformRole: row.platform_role,
    accountStatus: row.account_status,
    mustChangePassword: row.must_change_password,
    temporaryPasswordIssuedAt: row.temporary_password_issued_at ? new Date(row.temporary_password_issued_at) : null,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    lastSignedIn: new Date(row.last_signed_in),
  };
}

export async function syncSupabaseProfile(input: { id: string; email?: string | null; name?: string | null }) {
  const email = input.email?.trim().toLowerCase() ?? null;
  const name = input.name?.trim() || email?.split("@")[0] || null;
  const admin = supabaseAdmin();
  const { data, error } = await admin.from("users")
    .upsert({ auth_user_id: input.id, email, name, login_method: "supabase", last_signed_in: new Date().toISOString() }, { onConflict: "auth_user_id" })
    .select("id, auth_user_id, name, email, login_method, role, platform_role, account_status, must_change_password, temporary_password_issued_at, created_at, updated_at, last_signed_in")
    .single();
  if (error || !data) throw new Error(error?.message || "تعذر مزامنة ملف مستخدم Supabase.");

  const { data: platformInvitation, error: platformInvitationError } = await admin.rpc("powerhub_accept_pending_platform_invitation", {
    p_auth_user_id: input.id,
    p_email: email,
  });
  if (platformInvitationError && !isMissingRpc(platformInvitationError)) {
    throw new Error(platformInvitationError.message || "تعذر معالجة دعوة الوصول إلى إدارة المنصة.");
  }

  const { error: tenantInvitationError } = await admin.rpc("powerhub_accept_pending_tenant_invitations", {
    p_auth_user_id: input.id,
    p_email: email,
  });
  if (tenantInvitationError && !isMissingRpc(tenantInvitationError)) {
    throw new Error(tenantInvitationError.message || "تعذر معالجة دعوة الوصول إلى حساب المولد.");
  }

  const platformAccepted = Boolean(platformInvitation?.[0]?.accepted);
  if (!platformAccepted) return mapSupabaseProfile(data as UserRow);

  const { data: refreshed, error: refreshError } = await admin.from("users")
    .select("id, auth_user_id, name, email, login_method, role, platform_role, account_status, must_change_password, temporary_password_issued_at, created_at, updated_at, last_signed_in")
    .eq("auth_user_id", input.id)
    .single();
  if (refreshError || !refreshed) throw new Error(refreshError?.message || "تعذر تحديث ملف مستخدم Supabase بعد معالجة الدعوة.");
  return mapSupabaseProfile(refreshed as UserRow);
}
