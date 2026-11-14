import { ForbiddenError } from "@shared/_core/errors";
import { createHash } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Request } from "express";
import { syncSupabaseProfile, type SupabaseProfileUser } from "../supabase-profile";
import { measureB5Stage } from "../b5-request-trace";

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

const AUTH_UPSTREAM_TIMEOUT_MS = 3_500;
const AUTH_CLAIMS_TIMEOUT_MS = 6_500;
// A successful JWT verification can be reused briefly across a burst of
// independent tRPC HTTP requests. Account status, membership, site permissions
// and the single-device lease are NOT cached; they remain checked per request.
// Never cache failed verification, and do not use the JWT as a permission source.
const VERIFIED_CLAIMS_TTL_MS = 10_000;
const VERIFIED_CLAIMS_MAX_ENTRIES = 256;
type VerifiedAuthClaims = {
  sub?: unknown; email?: unknown; role?: unknown; exp?: unknown;
  user_metadata?: unknown;
};
const verifiedClaimsCache = new Map<string, { expiresAt: number; claims: VerifiedAuthClaims }>();
const pendingClaimsChecks = new Map<string, Promise<VerifiedAuthClaims>>();
function claimsCacheKey(token: string) {
  return createHash("sha256").update(token).digest("hex");
}
function tokenClaimsAreFresh(claims: VerifiedAuthClaims, now = Date.now()) {
  return typeof claims.exp === "number" && Number.isFinite(claims.exp) &&
    claims.exp * 1000 > now;
}
async function getVerifiedSupabaseClaims(
  authClient: ReturnType<typeof getSupabaseAuthClient>,
  token: string,
): Promise<VerifiedAuthClaims> {
  const key = claimsCacheKey(token);
  const now = Date.now();
  const cached = verifiedClaimsCache.get(key);
  if (cached && cached.expiresAt > now && tokenClaimsAreFresh(cached.claims, now)) {
    return cached.claims;
  }
  if (cached) verifiedClaimsCache.delete(key);
  const inflight = pendingClaimsChecks.get(key);
  if (inflight) return inflight;

  const operation = (async () => {
    const { data, error } = await withAuthUpstreamDeadline(
      "supabase.getClaims", authClient.auth.getClaims(token), AUTH_CLAIMS_TIMEOUT_MS,
    );
    if (error) {
      if (isDefinitiveSupabaseAccessTokenRejection(error)) {
        throw ForbiddenError("Invalid Supabase access token");
      }
      throw Object.assign(new Error("Supabase Auth is temporarily unavailable"), {
        authStage: "supabase.getClaims",
      });
    }
    const claims = data?.claims as VerifiedAuthClaims | undefined;
    if (!claims || !tokenClaimsAreFresh(claims)) {
      throw ForbiddenError("Invalid Supabase access token");
    }
    const expiresAt = Math.min(Date.now() + VERIFIED_CLAIMS_TTL_MS, claims.exp as number * 1000);
    verifiedClaimsCache.set(key, { expiresAt, claims });
    if (verifiedClaimsCache.size > VERIFIED_CLAIMS_MAX_ENTRIES) {
      for (const [cachedKey, item] of verifiedClaimsCache) {
        if (item.expiresAt <= Date.now() || verifiedClaimsCache.size > VERIFIED_CLAIMS_MAX_ENTRIES) {
          verifiedClaimsCache.delete(cachedKey);
        }
        if (verifiedClaimsCache.size <= VERIFIED_CLAIMS_MAX_ENTRIES) break;
      }
    }
    return claims;
  })();

  pendingClaimsChecks.set(key, operation);
  try { return await operation; } finally {
    if (pendingClaimsChecks.get(key) === operation) pendingClaimsChecks.delete(key);
  }
}

async function withAuthUpstreamDeadline<T>(stage: string, operation: Promise<T>, timeoutMs = AUTH_UPSTREAM_TIMEOUT_MS): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      const error = Object.assign(new Error(`PowerHub auth upstream stage timed out: ${stage}`), {
        name: "PowerHubAuthUpstreamTimeoutError",
        authStage: stage,
      });
      console.warn("[PowerHub auth upstream timeout]", { stage, timeoutMs });
      reject(error);
    }, timeoutMs);
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
export async function authenticateSupabaseRequest(
  req: Pick<Request, "headers">,
  options: { bootstrap?: boolean } = {},
): Promise<SupabaseProfileUser> {
  const startedAt = performance.now();
  const authHeader = req.headers.authorization;
  if (typeof authHeader !== "string" || !authHeader.startsWith("Bearer ")) {
    throw ForbiddenError("Missing Supabase access token");
  }

  const { url, publishableKey } = getSupabasePublicConfig();
  const supabase = getSupabaseAuthClient(url, publishableKey);
  const authStartedAt = performance.now();
  // getClaims verifies the token's signature and expiry. In legacy HS256
  // projects the SDK calls /auth/v1/user; coalesce concurrent checks and reuse
  // successful verifications for 10 seconds to avoid an Auth request storm.
  // Authoritative database access and device checks are never memoized.
  let claims: VerifiedAuthClaims;
  try {
    claims = await measureB5Stage("jwtVerify", () => getVerifiedSupabaseClaims(supabase, authHeader.slice(7)));
  } catch (error) {
    const authMs = Math.round(performance.now() - authStartedAt);
    if (authMs >= 500) {
      console.warn("[PowerHub auth latency]", {
        stage: "supabase.getClaims", durationMs: authMs,
        errorName: error instanceof Error ? error.name : undefined,
      });
    }
    throw error;
  }
  const authMs = Math.round(performance.now() - authStartedAt);

  if (typeof claims.sub !== "string" || !claims.sub ||
      typeof claims.email !== "string" || !claims.email ||
      claims.role !== "authenticated") {
    throw ForbiddenError("Invalid Supabase access token");
  }
  // Capture validated scalar claims before passing them into an async callback;
  // TypeScript cannot preserve property narrowing through a deferred closure.
  const verifiedSubject = claims.sub;
  const verifiedEmail = claims.email;
  const metadata = claims.user_metadata;
  const metadataName = metadata && typeof metadata === "object" && "name" in metadata &&
    typeof metadata.name === "string" ? metadata.name : undefined;

  const profileStartedAt = performance.now();
  const user = await measureB5Stage("profileRead", () => withAuthUpstreamDeadline("auth.profileSync", syncSupabaseProfile({
    id: verifiedSubject,
    email: verifiedEmail,
    name: metadataName ?? verifiedEmail.split("@")[0],
  }, options)));
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
