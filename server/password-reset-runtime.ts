import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "./supabase-admin";

type PasswordResetCompletion = {
  data: Array<{ success: boolean; intent_status: string }> | null;
  error: { message: string } | null;
};

async function completeOnce(
  admin: SupabaseClient,
  intentId: number,
  actorUserId: number,
  success: boolean,
  failureReason?: string | null,
): Promise<PasswordResetCompletion> {
  return admin.rpc("powerhub_complete_password_reset", {
    p_intent_id: intentId,
    p_actor_user_id: actorUserId,
    p_success: success,
    p_failure_reason: failureReason ?? null,
  }) as Promise<PasswordResetCompletion>;
}

/**
 * Completes the password-reset intent without ever changing the Auth password.
 *
 * The second attempt is intentionally the same idempotent DB operation. This
 * handles transient failures where the first RPC committed successfully but
 * its HTTP response was lost. A retry therefore cannot issue a second
 * password and will simply observe the existing completed intent.
 */
export async function completePasswordResetWithRetry(
  intentId: number,
  actorUserId: number,
  success: boolean,
  failureReason?: string | null,
): Promise<{ ok: true; error: null } | { ok: false; error: { message: string } }> {
  const admin = supabaseAdmin();
  let lastError: { message: string } | null = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { error } = await completeOnce(admin, intentId, actorUserId, success, failureReason);
    if (!error) return { ok: true, error: null };
    lastError = error;
  }

  return { ok: false, error: lastError ?? { message: "PASSWORD_RESET_COMPLETION_FAILED" } };
}
