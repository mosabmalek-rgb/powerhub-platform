import { supabaseAdmin } from "./supabase-admin";

export type PowerHubUser = {
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

type SupabaseUserRow = {
  id: number;
  auth_user_id: string;
  name: string | null;
  email: string | null;
  login_method: string | null;
  role: PowerHubUser["role"];
  platform_role: PowerHubUser["platformRole"];
  account_status: PowerHubUser["accountStatus"];
  must_change_password: boolean;
  temporary_password_issued_at: string | null;
  created_at: string;
  updated_at: string;
  last_signed_in: string;
};

export function mapSupabaseUserRow(row: SupabaseUserRow): PowerHubUser {
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

function normalizeEmail(value: string | null | undefined) {
  return value?.trim().toLowerCase() || null;
}

function requireData<T>(data: T | null, error: { message: string } | null, resource: string): T {
  if (error) throw new Error(`Supabase ${resource} request failed: ${error.message}`);
  if (!data) throw new Error(`Supabase ${resource} request returned no data`);
  return data;
}

async function acceptPlatformInvitation(user: PowerHubUser) {
  if (!user.email) return;
  const admin = supabaseAdmin();
  const now = new Date().toISOString();
  const { data: invitation, error } = await admin
    .from("platform_access_invitations")
    .select("id, platform_role")
    .eq("email", user.email)
    .eq("status", "invited")
    .gte("expires_at", now)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Supabase platform invitation lookup failed: ${error.message}`);
  if (!invitation) return;

  const { error: profileError } = await admin
    .from("users")
    .update({ role: "admin", platform_role: invitation.platform_role, account_status: "active" })
    .eq("id", user.id);
  if (profileError) throw new Error(`Supabase platform invitation acceptance failed: ${profileError.message}`);

  const { error: invitationError } = await admin
    .from("platform_access_invitations")
    .update({ status: "accepted", accepted_by_user_id: user.id, accepted_at: now })
    .eq("id", invitation.id);
  if (invitationError) throw new Error(`Supabase platform invitation update failed: ${invitationError.message}`);
}

async function acceptTenantInvitations(user: PowerHubUser) {
  if (!user.email) return;
  const admin = supabaseAdmin();
  const now = new Date().toISOString();
  const { data: invitations, error } = await admin
    .from("access_invitations")
    .select("id, tenant_id, site_id, tenant_role, site_role, invited_by_user_id")
    .eq("email", user.email)
    .eq("status", "invited")
    .gte("expires_at", now);
  if (error) throw new Error(`Supabase tenant invitation lookup failed: ${error.message}`);

  for (const invitation of invitations ?? []) {
    const { error: membershipError } = await admin.from("tenant_members").upsert({
      tenant_id: invitation.tenant_id,
      user_id: user.id,
      role: invitation.tenant_role,
      is_active: true,
      membership_status: "active",
      invited_by_user_id: invitation.invited_by_user_id,
      expires_at: null,
    }, { onConflict: "tenant_id,user_id" });
    if (membershipError) throw new Error(`Supabase tenant membership acceptance failed: ${membershipError.message}`);

    if (invitation.site_id && invitation.site_role) {
      const { error: staffError } = await admin.from("staff_profiles").upsert({
        tenant_id: invitation.tenant_id,
        site_id: invitation.site_id,
        user_id: user.id,
        role: invitation.site_role,
        is_active: true,
      }, { onConflict: "user_id,site_id,role" });
      if (staffError) throw new Error(`Supabase staff invitation acceptance failed: ${staffError.message}`);
    }

    if (invitation.tenant_role === "owner") {
      const { error: ownerError } = await admin
        .from("tenant_owner_profiles")
        .update({ owner_user_id: user.id, claimed_at: now })
        .eq("tenant_id", invitation.tenant_id);
      if (ownerError) throw new Error(`Supabase owner profile acceptance failed: ${ownerError.message}`);
    }

    const { error: invitationError } = await admin
      .from("access_invitations")
      .update({ status: "accepted", accepted_by_user_id: user.id, accepted_at: now })
      .eq("id", invitation.id);
    if (invitationError) throw new Error(`Supabase tenant invitation update failed: ${invitationError.message}`);
  }
}

export async function syncSupabaseProfile(input: { id: string; email?: string | null; name?: string | null }) {
  const admin = supabaseAdmin();
  const email = normalizeEmail(input.email);
  const name = input.name?.trim() || email?.split("@")[0] || null;
  const now = new Date().toISOString();
  const { data: saved, error } = await admin
    .from("users")
    .upsert({
      auth_user_id: input.id,
      email,
      name,
      login_method: "supabase",
      last_signed_in: now,
    }, { onConflict: "auth_user_id" })
    .select("id, auth_user_id, name, email, login_method, role, platform_role, account_status, must_change_password, temporary_password_issued_at, created_at, updated_at, last_signed_in")
    .single();
  const initialUser = mapSupabaseUserRow(requireData(saved, error, "user profile"));

  await acceptPlatformInvitation(initialUser);
  await acceptTenantInvitations(initialUser);

  const { data: refreshed, error: refreshedError } = await admin
    .from("users")
    .select("id, auth_user_id, name, email, login_method, role, platform_role, account_status, must_change_password, temporary_password_issued_at, created_at, updated_at, last_signed_in")
    .eq("auth_user_id", input.id)
    .single();
  return mapSupabaseUserRow(requireData(refreshed, refreshedError, "synchronized user profile"));
}
