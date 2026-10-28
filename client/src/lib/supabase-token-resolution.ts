export type SupabaseTokenSession = {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_at?: number;
  user?: { id?: string | null } | null;
};

export type SupabaseTokenResolutionDependencies<TSession extends SupabaseTokenSession> = {
  getCurrentSession: () => TSession | null;
  getSupabaseSession: () => Promise<TSession | null>;
  refreshSession: (session: TSession, timeoutMs: number) => Promise<TSession | null>;
  waitForAuthStateChange: (timeoutMs: number) => Promise<boolean>;
  isUsable: (session: TSession | null) => boolean;
  shouldRefresh: (session: TSession) => boolean;
  getLastSessionReadError: () => Error | null;
  now?: () => number;
};

export const SUPABASE_ACCESS_TOKEN_RESOLUTION_TIMEOUT_MS = 7_500;
export const SUPABASE_SESSION_REFRESH_TIMEOUT_MS = 6_000;
const TRANSIENT_REFRESH_RETRY_BACKOFF_MS = 2_000;
const RATE_LIMIT_REFRESH_RETRY_BACKOFF_MS = 15_000;

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error("Supabase session resolution failed.");
}

function errorDetails(error: unknown): { status?: number; statusCode?: number; code?: string; name?: string } {
  if (!error || typeof error !== "object") return {};
  const value = error as { status?: unknown; statusCode?: unknown; code?: unknown; name?: unknown };
  return {
    status: typeof value.status === "number" ? value.status : undefined,
    statusCode: typeof value.statusCode === "number" ? value.statusCode : undefined,
    code: typeof value.code === "string" ? value.code : undefined,
    name: typeof value.name === "string" ? value.name : undefined,
  };
}

function isRateLimited(error: unknown): boolean {
  const value = errorDetails(error);
  return value.status === 429 || value.statusCode === 429 ||
    value.code === "over_request_rate_limit" || value.name === "PowerHubSupabaseRateLimitError";
}

function userSafeError(name: string, message: string, cause: unknown): Error {
  return Object.assign(new Error(message), { name, cause });
}

function normalizeRefreshError(error: unknown): Error {
  if (isRateLimited(error)) {
    return userSafeError("PowerHubSupabaseRateLimitError", "Supabase temporarily rate-limited session refresh.", error);
  }
  if (errorDetails(error).name === "PowerHubSessionRefreshTimeoutError") {
    return userSafeError("PowerHubSessionRefreshTimeoutError", "Supabase session refresh exceeded its bounded deadline.", error);
  }
  return userSafeError("PowerHubSessionRefreshFailedError", "Supabase could not refresh the current session before a usable access token was available.", error);
}

function normalizeReadError(error: unknown): Error {
  if (isRateLimited(error)) {
    return userSafeError("PowerHubSupabaseRateLimitError", "Supabase temporarily rate-limited session restoration.", error);
  }
  if (errorDetails(error).name === "PowerHubSessionReadTimeoutError") {
    return userSafeError("PowerHubSessionReadTimeoutError", "Supabase session restoration exceeded its bounded deadline.", error);
  }
  return userSafeError("PowerHubSessionReadFailedError", "Supabase could not restore the persisted session.", error);
}

/**
 * Resolves the bearer token used by protected API requests.
 *
 * Near-expiry tokens wait for Supabase refresh instead of relying on the
 * background auto-refresh timer. Concurrent callers share one promise, and a
 * still-valid token is only a fallback after a transient refresh failure.
 * Expired tokens are never returned.
 */
export function createSupabaseAccessTokenResolver<TSession extends SupabaseTokenSession>(
  dependencies: SupabaseTokenResolutionDependencies<TSession>,
): () => Promise<string | null> {
  const now = dependencies.now ?? Date.now;
  let tokenResolutionInFlight: Promise<string | null> | null = null;
  let refreshRetryAfter = 0;
  let lastRefreshError: Error | null = null;

  const readAccessToken = async (): Promise<string | null> => {
    const deadline = now() + SUPABASE_ACCESS_TOKEN_RESOLUTION_TIMEOUT_MS;
    let session = dependencies.getCurrentSession();
    let sessionReadError = dependencies.getLastSessionReadError();

    if (!session) {
      if (deadline <= now()) {
        throw normalizeReadError(userSafeError("PowerHubSessionReadTimeoutError", "No time remained to restore the session.", sessionReadError));
      }
      try {
        session = await dependencies.getSupabaseSession();
      } catch (error) {
        sessionReadError = asError(error);
      }
      session = session ?? dependencies.getCurrentSession();
      sessionReadError = dependencies.getLastSessionReadError() ?? sessionReadError;
    }

    const usableToken = (candidate: TSession | null): string | null => {
      if (!candidate || !dependencies.isUsable(candidate)) return null;
      return typeof candidate.access_token === "string" && candidate.access_token.trim().length > 0
        ? candidate.access_token
        : null;
    };
    const expectedUserId = session?.user?.id ?? null;
    const currentSessionForExpectedUser = (): TSession | null => {
      const latest = dependencies.getCurrentSession();
      if (expectedUserId && latest?.user?.id !== expectedUserId) return null;
      return latest;
    };

    const existingToken = usableToken(session);
    if (existingToken && session && !dependencies.shouldRefresh(session)) {
      refreshRetryAfter = 0;
      lastRefreshError = null;
      return existingToken;
    }

    const canRefresh = typeof session?.refresh_token === "string" && session.refresh_token.trim().length > 0;
    if (existingToken && !canRefresh) return existingToken;

    let refreshError: Error | null = null;
    if (session && canRefresh) {
      if (refreshRetryAfter > now()) {
        // Avoid repeating a failed/429 refresh for every query. A token can be
        // reused only if it has not actually expired.
        if (existingToken) return existingToken;
        const waitMs = Math.min(Math.max(0, deadline - now()), refreshRetryAfter - now());
        if (waitMs > 0) await dependencies.waitForAuthStateChange(waitMs);
        const recovered = usableToken(currentSessionForExpectedUser());
        if (recovered) return recovered;
        if (refreshRetryAfter > now()) throw normalizeRefreshError(lastRefreshError);
      }

      const remaining = deadline - now();
      if (remaining <= 0) {
        throw normalizeRefreshError(userSafeError("PowerHubSessionRefreshTimeoutError", "No time remained for Supabase token refresh.", lastRefreshError));
      }

      try {
        const refreshed = await dependencies.refreshSession(
          session,
          Math.min(SUPABASE_SESSION_REFRESH_TIMEOUT_MS, remaining),
        );
        const resolved = refreshed ?? currentSessionForExpectedUser();
        const refreshedToken = usableToken(resolved);
        if (refreshedToken) {
          refreshRetryAfter = 0;
          lastRefreshError = null;
          return refreshedToken;
        }
        refreshError = new Error("Supabase refresh completed without returning a usable session.");
      } catch (error) {
        refreshError = asError(error);
      }

      lastRefreshError = refreshError;
      refreshRetryAfter = now() + (isRateLimited(refreshError)
        ? RATE_LIMIT_REFRESH_RETRY_BACKOFF_MS
        : TRANSIENT_REFRESH_RETRY_BACKOFF_MS);

      const stillValid = usableToken(currentSessionForExpectedUser());
      if (stillValid) return stillValid;
    }

    const remaining = Math.max(0, deadline - now());
    if (remaining > 0 && (sessionReadError || refreshError)) {
      await dependencies.waitForAuthStateChange(remaining);
      const recovered = usableToken(currentSessionForExpectedUser());
      if (recovered) {
        refreshRetryAfter = 0;
        lastRefreshError = null;
        return recovered;
      }
    }

    if (refreshError) throw normalizeRefreshError(refreshError);
    if (sessionReadError) throw normalizeReadError(sessionReadError);
    return null;
  };

  const resolve = (): Promise<string | null> => {
    if (tokenResolutionInFlight) return tokenResolutionInFlight;
    const pending = readAccessToken().finally(() => {
      if (tokenResolutionInFlight === pending) tokenResolutionInFlight = null;
    });
    tokenResolutionInFlight = pending;
    return pending;
  };
  return Object.assign(resolve, {
    getDiagnostics: () => ({
      resolutionInFlight: tokenResolutionInFlight !== null,
      refreshBackoffActive: refreshRetryAfter > now(),
      lastRefreshErrorName: lastRefreshError?.name ?? null,
    }),
  });
}
