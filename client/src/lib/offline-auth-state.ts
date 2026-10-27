/**
 * Only validate the online profile once the first PowerHub origin probe has
 * succeeded. Offline lease/cache restoration is a separate local path.
 */
export function shouldValidateOnlineSession(
  hasSession: boolean,
  powerHubReachable: boolean,
  connectivityChecking: boolean,
): boolean {
  return hasSession && powerHubReachable && !connectivityChecking;
}

export type OfflineAuthTransition =
  | "online-session"
  | "recover-offline-session"
  | "explicit-sign-out";

/**
 * A missing Supabase session is not itself proof that the user explicitly
 * signed out. Only the logout action initiated in this browser revokes the
 * offline lease; startup/refresh failures must attempt the local lease instead.
 */
export function resolveOfflineAuthTransition(
  event: string,
  sessionUserId: string | null,
  explicitLogoutRequested: boolean,
): OfflineAuthTransition {
  if (explicitLogoutRequested && !sessionUserId) return "explicit-sign-out";
  if (sessionUserId) return "online-session";
  return "recover-offline-session";
}

/** Do not erase useful cached queries for a transient SDK sign-out event. */
export function shouldClearQueryCacheForAuthTransition(
  _event: string,
  explicitLogoutRequested: boolean,
  identityChanged: boolean,
  nextUserId: string | null,
): boolean {
  if (explicitLogoutRequested && !nextUserId) return true;
  return identityChanged && nextUserId !== null;
}

/** A query may be persisted only for the identity/generation that started it. */
export function isOfflineCacheWriteCurrent(
  ownerUserId: string,
  ownerGeneration: number,
  activeUserId: string | null,
  activeGeneration: number,
): boolean {
  return Boolean(
    ownerUserId &&
    activeUserId &&
    ownerUserId === activeUserId &&
    ownerGeneration === activeGeneration,
  );
}

/**
 * A getSession/refreshSession snapshot may finish after a newer auth event.
 * In that case, the session updated by the event must win over the stale
 * async response, especially when that response contains null.
 */
/** INITIAL_SESSION(null) is only an initial SDK snapshot, not a sign-out.
 * It must not invalidate a persisted-session read still in progress.
 */
export function isNonAuthoritativeInitialNullSessionEvent(event: string, session: unknown): boolean {
  return event === "INITIAL_SESSION" && session === null;
}

export function selectAuthSnapshot<T>(
  snapshot: T | null,
  current: T | null,
  requestRevision: number,
  currentRevision: number,
): T | null {
  return requestRevision === currentRevision ? snapshot : current;
}


/** Keep the browser client on Supabase's supported refresh-token lifecycle. */
export const SUPABASE_BROWSER_AUTH_OPTIONS = {
  persistSession: true,
  autoRefreshToken: true,
  detectSessionInUrl: true,
} as const;

export const SUPABASE_SESSION_REFRESH_LEEWAY_SECONDS = 60;

/** Cool down repeated getSession reads after a failed storage/refresh operation. */
export const SUPABASE_SESSION_READ_TIMEOUT_MS = 5_000;
export const SUPABASE_SESSION_READ_ERROR_BACKOFF_MS = 15_000;

export function isSessionReadBackoffActive(retryAfterMs: number, nowMs = Date.now()): boolean {
  return retryAfterMs > nowMs;
}

/** Read exp from a JWT only as a client-side expiry hint; APIs must still verify the token. */
function getJwtExpirationSeconds(accessToken: string): number | null {
  const payload = accessToken.split(".")[1];
  if (!payload) return null;

  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const claims = JSON.parse(atob(padded)) as { exp?: unknown };
    return typeof claims.exp === "number" && Number.isFinite(claims.exp)
      ? claims.exp
      : null;
  } catch {
    return null;
  }
}

/**
 * Supabase Session.expires_at is optional in the SDK contract. Prefer it when
 * present; otherwise read the JWT exp claim so a valid persisted session is not
 * misclassified as a missing token. This never replaces server-side validation.
 */
export function isSupabaseSessionUsable(
  session: { access_token?: unknown; expires_at?: number } | null | undefined,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  if (
    !session ||
    typeof session.access_token !== "string" ||
    session.access_token.trim().length === 0
  ) return false;

  const explicitExpiry = session.expires_at;
  const expiresAt = typeof explicitExpiry === "number" && Number.isFinite(explicitExpiry)
    ? explicitExpiry
    : getJwtExpirationSeconds(session.access_token);

  return typeof expiresAt === "number" && expiresAt > nowSeconds;
}

/** Refresh before expiry so requests never deliberately reuse a near-expiry token. */
export function shouldRefreshSupabaseSession(
  expiresAt: number | undefined | null,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  return typeof expiresAt !== "number" ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= nowSeconds + SUPABASE_SESSION_REFRESH_LEEWAY_SECONDS;
}


