import { supabaseAdmin } from "./supabase-admin";

export type SupabaseProfileUser = {
  id: number;
  openId: string;
  name: string | null;
  email: string | null;
  loginMethod: string | null;
  role: "user" | "admin";
  platformRole: "platform_owner" | "platform_admin" | "finance_admin" | "platform_support" | null;
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

type SupabaseRpcError = { code?: string; message?: string };

function isMissingRpc(error: SupabaseRpcError | null | undefined) {
  if (!error) return false;
  if (error.code === "42883" || error.code === "PGRST202") return true;
  return /could not find .* function in the schema cache/i.test(error.message ?? "");
}

export function mapSupabaseProfile(row: UserRow): SupabaseProfileUser {
  return {
    id: Number(row.id), openId: row.auth_user_id, name: row.name, email: row.email,
    loginMethod: row.login_method, role: row.role, platformRole: row.platform_role,
    accountStatus: row.account_status, mustChangePassword: row.must_change_password,
    temporaryPasswordIssuedAt: row.temporary_password_issued_at ? new Date(row.temporary_password_issued_at) : null,
    createdAt: new Date(row.created_at), updatedAt: new Date(row.updated_at), lastSignedIn: new Date(row.last_signed_in),
  };
}

const PROFILE_COLUMNS = "id, auth_user_id, name, email, login_method, role, platform_role, account_status, must_change_password, temporary_password_issued_at, created_at, updated_at, last_signed_in";
const INVITATION_CHECK_TTL_MS = 30_000;
const SIGN_IN_WRITE_INTERVAL_MS = 5 * 60_000;
const pendingInvitationChecks = new Map<string, { expiresAt: number; promise: Promise<boolean>; completed: boolean }>();

async function acceptPendingInvitations(input: { id: string; email: string | null }, admin: ReturnType<typeof supabaseAdmin>) {
  const now = Date.now();
  const cached = pendingInvitationChecks.get(input.id);
  if (cached && cached.expiresAt > now) return cached.completed ? false : cached.promise;
  if (cached) pendingInvitationChecks.delete(input.id);

  // Keep invitation processing off the hot path for every UI/API request.
  // Membership and account profile data are still fetched fresh on every request.
  // Newly issued invitations are picked up within at most this short TTL per warm instance.
  const entry = {
    expiresAt: now + INVITATION_CHECK_TTL_MS,
    completed: false,
    promise: (async () => {
      const [platformInvitation, tenantInvitation] = await Promise.all([
        admin.rpc("powerhub_accept_pending_platform_invitation", {
          p_auth_user_id: input.id, p_email: input.email,
        }),
        admin.rpc("powerhub_accept_pending_tenant_invitations", {
          p_auth_user_id: input.id, p_email: input.email,
        }),
      ]);

      if (platformInvitation.error && !isMissingRpc(platformInvitation.error)) {
        throw new Error(platformInvitation.error.message || "تعذر معالجة دعوة الوصول إلى إدارة المنصة.");
      }
      if (tenantInvitation.error && !isMissingRpc(tenantInvitation.error)) {
        throw new Error(tenantInvitation.error.message || "تعذر معالجة دعوة الوصول إلى حساب المولد.");
      }
      return Boolean(platformInvitation.data?.[0]?.accepted);
    })(),
  };
  pendingInvitationChecks.set(input.id, entry);
  // Bound the per-instance cache and remove expired entries without timers.
  if (pendingInvitationChecks.size > 2_000) {
    for (const [key, value] of pendingInvitationChecks) {
      if (value.expiresAt <= now) pendingInvitationChecks.delete(key);
      if (pendingInvitationChecks.size <= 1_500) break;
    }
  }
  try {
    const accepted = await entry.promise;
    entry.completed = true;
    return accepted;
  } catch (error) {
    if (pendingInvitationChecks.get(input.id) === entry) pendingInvitationChecks.delete(input.id);
    throw error;
  }
}

export async function syncSupabaseProfile(input: { id: string; email?: string | null; name?: string | null }) {
  const email = input.email?.trim().toLowerCase() ?? null;
  const name = input.name?.trim() || email?.split("@")[0] || null;
  const admin = supabaseAdmin();
  const { data: existing, error: lookupError } = await admin.from("users")
    .select(PROFILE_COLUMNS).eq("auth_user_id", input.id).maybeSingle();
  if (lookupError) throw new Error(lookupError.message || "تعذر تحميل ملف مستخدم Supabase.");

  const now = Date.now();
  const previousSignIn = existing?.last_signed_in ? new Date(existing.last_signed_in).getTime() : 0;
  const signInWriteDue = !Number.isFinite(previousSignIn) || now - previousSignIn >= SIGN_IN_WRITE_INTERVAL_MS;
  const identityChanged = !existing || existing.email !== email || existing.name !== name || existing.login_method !== "supabase";
  let profileRow: UserRow;

  if (!existing) {
    const { data, error } = await admin.from("users")
      .upsert({ auth_user_id: input.id, email, name, login_method: "supabase", last_signed_in: new Date(now).toISOString() }, { onConflict: "auth_user_id" })
      .select(PROFILE_COLUMNS).single();
    if (error || !data) throw new Error(error?.message || "تعذر مزامنة ملف مستخدم Supabase.");
    profileRow = data as UserRow;
  } else if (identityChanged || signInWriteDue) {
    const updates: Record<string, unknown> = {};
    if (identityChanged) Object.assign(updates, { email, name, login_method: "supabase" });
    if (signInWriteDue) updates.last_signed_in = new Date(now).toISOString();
    const { data, error } = await admin.from("users")
      .update(updates).eq("auth_user_id", input.id).select(PROFILE_COLUMNS).single();
    if (error || !data) throw new Error(error?.message || "تعذر تحديث ملف مستخدم Supabase.");
    profileRow = data as UserRow;
  } else {
    profileRow = existing as UserRow;
  }

  const platformInvitationAccepted = await acceptPendingInvitations({ id: input.id, email }, admin);
  if (!platformInvitationAccepted) return mapSupabaseProfile(profileRow);

  // Platform invitations may change the user's platform role, so return a fresh profile
  // immediately after acceptance rather than waiting for the next API request.
  const { data: refreshed, error: refreshError } = await admin.from("users")
    .select(PROFILE_COLUMNS).eq("auth_user_id", input.id).single();
  if (refreshError || !refreshed) throw new Error(refreshError?.message || "تعذر تحديث ملف مستخدم Supabase بعد معالجة الدعوة.");
  return mapSupabaseProfile(refreshed as UserRow);
}
