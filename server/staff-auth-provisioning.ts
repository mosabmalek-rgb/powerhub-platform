import type { supabaseAdmin } from "./supabase-admin";

type Admin = ReturnType<typeof supabaseAdmin>;

export class StaffAuthRecoveryRequired extends Error {
  constructor(public readonly reason: "UNVERIFIED_DATABASE_STATE" | "ASSIGNMENT_MAY_HAVE_COMMITTED" | "AUTH_COMPENSATION_FAILED") {
    super(reason);
    this.name = "StaffAuthRecoveryRequired";
  }
}

/**
 * Admin-only bootstrap of the application user for an Auth user just created
 * by the staff-create route. PowerHub deliberately has no auth.users trigger:
 * the normal login bootstrap and owner provisioning create public.users
 * explicitly. Never trust user_metadata for authorization attributes.
 *
 * An identity-generated bigint is allocated by public.users, not by the API.
 */
export async function createNewStaffProfile(
  admin: Admin,
  input: { authUserId: string; email: string; name: string },
): Promise<number> {
  const issuedAt = new Date().toISOString();
  const { data, error } = await admin.from("users")
    .upsert({
      auth_user_id: input.authUserId,
      name: input.name.trim(),
      email: input.email.trim().toLowerCase(),
      login_method: "supabase",
      role: "user",
      platform_role: null,
      account_status: "active",
      must_change_password: true,
      temporary_password_issued_at: issuedAt,
    }, { onConflict: "auth_user_id" })
    .select("id,auth_user_id,role,platform_role,account_status,must_change_password")
    .single();
  const userId = Number(data?.id);
  if (error || !Number.isSafeInteger(userId) || userId <= 0 ||
      data?.auth_user_id !== input.authUserId ||
      data?.role !== "user" || data?.platform_role !== null ||
      data?.account_status !== "active" || data?.must_change_password !== true) {
    throw new Error("STAFF_APPLICATION_PROFILE_NOT_PROVISIONED");
  }
  return userId;
}

/**
 * A failed RPC can be an ambiguous network response AFTER the database commit.
 * Check the post-condition before deleting Auth: FK ON DELETE CASCADE would
 * otherwise delete a legitimately assigned member/staff identity and audit
 * references. Check all tenant memberships, not just the requested tenant,
 * because a newly provisioned identity could become assigned elsewhere.
 * On any uncertain read, preserve the identity for reconciliation.
 */
export async function compensateUnassignedStaffAuth(
  admin: Admin,
  input: { authUserId: string; tenantId: number },
): Promise<void> {
  try {
    const { data: user, error: lookupError } = await admin.from("users")
      .select("id").eq("auth_user_id", input.authUserId).maybeSingle();
    if (lookupError) throw new StaffAuthRecoveryRequired("UNVERIFIED_DATABASE_STATE");
    if (user) {
      const id = Number(user.id);
      if (!Number.isSafeInteger(id) || id <= 0)
        throw new StaffAuthRecoveryRequired("UNVERIFIED_DATABASE_STATE");
      const [memberResult, staffResult] = await Promise.all([
        admin.from("tenant_members").select("id").eq("user_id", id).limit(1).maybeSingle(),
        admin.from("staff_profiles").select("id").eq("user_id", id).limit(1).maybeSingle(),
      ]);
      if (memberResult.error || staffResult.error)
        throw new StaffAuthRecoveryRequired("UNVERIFIED_DATABASE_STATE");
      if (memberResult.data || staffResult.data)
        throw new StaffAuthRecoveryRequired("ASSIGNMENT_MAY_HAVE_COMMITTED");
    }
  } catch (e) {
    if (e instanceof StaffAuthRecoveryRequired) throw e;
    throw new StaffAuthRecoveryRequired("UNVERIFIED_DATABASE_STATE");
  }

  try {
    const { error } = await admin.auth.admin.deleteUser(input.authUserId);
    if (error) throw new StaffAuthRecoveryRequired("AUTH_COMPENSATION_FAILED");
  } catch {
    throw new StaffAuthRecoveryRequired("AUTH_COMPENSATION_FAILED");
  }
}
