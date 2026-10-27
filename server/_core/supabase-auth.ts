import { ForbiddenError } from "@shared/_core/errors";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Request } from "express";
import { syncSupabaseProfile, type SupabaseProfileUser } from "../supabase-profile";

let cachedAuthClient: { url: string; publishableKey: string; client: SupabaseClient<any, "public", "public", any, any> } | null = null;

function getSupabaseAuthClient(url: string, publishableKey: string) {
  if (cachedAuthClient?.url === url && cachedAuthClient.publishableKey === publishableKey) {
    return cachedAuthClient.client;
  }
  const client = createClient(url, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  cachedAuthClient = { url, publishableKey, client };
  return client;
}

function getSupabasePublicConfig() {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const publishableKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;

  // Configuration failures are server faults, not evidence that a user session is invalid.
  if (!url || !publishableKey) {
    throw new Error("Supabase Auth is not configured");
  }

  return { url, publishableKey };
}

const RETRYABLE_AUTH_ERROR_CODES = new Set([
  "over_request_rate_limit",
  "request_timeout",
  "unexpected_failure",
  "server_error",
  "auth_retryable_fetch_error",
]);

const INVALID_ACCESS_TOKEN_ERROR_CODES = new Set([
  "bad_jwt",
  "invalid_token",
  "jwt_expired",
  "no_authorization",
  "session_not_found",
  "user_not_found",
]);

const AUTH_UPSTREAM_TIMEOUT_MS = 5_000;

async function withAuthUpstreamDeadline<T>(stage: string, operation: Promise<T>): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      const error = new Error(`PowerHub auth upstream stage timed out: ${stage}`);
      error.name = "PowerHubAuthUpstreamTimeoutError";
      console.warn("[PowerHub auth upstream timeout]", { stage, timeoutMs: AUTH_UPSTREAM_TIMEOUT_MS });
      reject(error);
    }, AUTH_UPSTREAM_TIMEOUT_MS);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

/** Distinguish a rejected bearer token from throttling, transport, and Auth service failures. */
export function isDefinitiveSupabaseAccessTokenRejection(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; status?: unknown; name?: unknown };
  const code = typeof value.code === "string" ? value.code.toLowerCase() : "";
  const name = typeof value.name === "string" ? value.name.toLowerCase() : "";
  const status = typeof value.status === "number" ? value.status : null;

  if (RETRYABLE_AUTH_ERROR_CODES.has(code) || name === "authretryablefetcherror") return false;
  if (status === 408 || status === 429 || (status !== null && status >= 500)) return false;
  if (INVALID_ACCESS_TOKEN_ERROR_CODES.has(code)) return true;
  // Auth's 401 response indicates the access token was not accepted. Do not
  // treat 403 generically: Supabase also uses it for unavailable Auth features.
  return status === 401;
}

/**
 * Verifies a browser Supabase access token and keeps its application profile in
 * sync. This deliberately has no dependency on the legacy OAuth/session SDK.
 */
export async function authenticateSupabaseRequest(req: Pick<Request, "headers">): Promise<SupabaseProfileUser> {
  const startedAt = performance.now();
  const authHeader = req.headers.authorization;
  if (typeof authHeader !== "string" || !authHeader.startsWith("Bearer ")) {
    throw ForbiddenError("Missing Supabase access token");
  }

  const { url, publishableKey } = getSupabasePublicConfig();
  const supabase = getSupabaseAuthClient(url, publishableKey);
  const authStartedAt = performance.now();
  const { data, error } = await withAuthUpstreamDeadline("supabase.getUser", supabase.auth.getUser(authHeader.slice(7)));
  const authMs = Math.round(performance.now() - authStartedAt);

  if (error) {
    const authError = error as { code?: unknown; status?: unknown; name?: unknown };
    if (authMs >= 500) {
      console.warn("[PowerHub auth latency]", {
        stage: "supabase.getUser",
        durationMs: authMs,
        errorName: typeof authError.name === "string" ? authError.name : undefined,
        errorCode: typeof authError.code === "string" ? authError.code : undefined,
        status: typeof authError.status === "number" ? authError.status : undefined,
      });
    }
    if (isDefinitiveSupabaseAccessTokenRejection(error)) {
      throw ForbiddenError("Invalid Supabase access token");
    }
    // Do not turn a timeout, 429, or Supabase 5xx into a false logout.
    throw new Error("Supabase Auth is temporarily unavailable");
  }

  if (!data.user?.email) throw ForbiddenError("Invalid Supabase access token");

  const profileStartedAt = performance.now();
  const user = await withAuthUpstreamDeadline("auth.profileSync", syncSupabaseProfile({
    id: data.user.id,
    email: data.user.email,
    name: (data.user.user_metadata?.name as string | undefined) ?? data.user.email.split("@")[0],
  }));
  const profileMs = Math.round(performance.now() - profileStartedAt);
  const totalMs = Math.round(performance.now() - startedAt);

  // No user identifiers, tokens, headers, or profile values are logged.
  if (totalMs >= 800) {
    console.warn("[PowerHub auth latency]", {
      stage: "authenticateSupabaseRequest",
      authMs,
      profileSyncMs: profileMs,
      totalMs,
    });
  }
  return user;
}
