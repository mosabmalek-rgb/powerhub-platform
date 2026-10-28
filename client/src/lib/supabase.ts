import { createClient, type AuthChangeEvent, type Session } from "@supabase/supabase-js";
import { createSupabaseAccessTokenResolver } from "@/lib/supabase-token-resolution";
import {
  isSupabaseSessionUsable,
  getSupabaseSessionExpirySeconds,
  shouldRefreshSupabaseSession,
  isNonAuthoritativeInitialNullSessionEvent,
  selectAuthSnapshot,
  SUPABASE_BROWSER_AUTH_OPTIONS,
  SUPABASE_SESSION_READ_ERROR_BACKOFF_MS,
  SUPABASE_SESSION_READ_TIMEOUT_MS,
  isSessionReadBackoffActive,
} from "@/lib/offline-auth-state";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabasePublishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!supabaseUrl || !supabasePublishableKey) {
  throw new Error("Supabase Auth is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY.");
}

export const supabase = createClient(supabaseUrl, supabasePublishableKey, {
  auth: { ...SUPABASE_BROWSER_AUTH_OPTIONS },
});

let currentSession: Session | null = null;
let sessionInitialized = false;
let sessionReadInFlight: Promise<Session | null> | null = null;
let sessionReadRetryAfter = 0;
let lastSessionReadError: Error | null = null;
let authSubscriptionReady = false;
// Incremented for every accepted Supabase auth event. Async getSession/refresh
// snapshots must not overwrite a newer sign-in/sign-out event when they finish.
let authStateRevision = 0;
type AuthSubscriber = (event: AuthChangeEvent, session: Session | null) => void;
const authSubscribers = new Set<AuthSubscriber>();

function ensureAuthSubscription() {
  if (authSubscriptionReady) return;
  authSubscriptionReady = true;

  supabase.auth.onAuthStateChange((event, session) => {
    // INITIAL_SESSION(null) can arrive while getSession() is reading the
    // persisted session. It is not a sign-out: don't advance the revision or
    // overwrite the snapshot that the in-flight read may return.
    if (isNonAuthoritativeInitialNullSessionEvent(event, session)) {
      // Do not fan this initial empty snapshot out to consumers either: their
      // independent startup revisions would otherwise invalidate getSession().
      return;
    }

    authStateRevision += 1;
    currentSession = session;
    sessionInitialized = true;
    // Only a real, usable session proves recovery succeeded. Null events can
    // arrive during transient refresh failures; they must not bypass the retry
    // cooldown or erase the failure that the recovery UI needs to explain.
    if (isSupabaseSessionUsable(session)) {
      sessionReadRetryAfter = 0;
      lastSessionReadError = null;
    }

    // Keep the Supabase callback synchronous. Consumers may perform async work
    // after React schedules their state updates; this avoids re-entrancy inside
    // Supabase's auth state machinery.
    for (const subscriber of authSubscribers) subscriber(event, session);
  });
}

export function subscribeSupabaseAuthState(subscriber: AuthSubscriber) {
  ensureAuthSubscription();
  authSubscribers.add(subscriber);
  return () => authSubscribers.delete(subscriber);
}

/** Clear the bounded session-read cooldown for an explicit user-initiated retry. */
export function resetSupabaseSessionReadBackoff(): void {
  sessionReadRetryAfter = 0;
  lastSessionReadError = null;
}

export function getSupabaseSessionReadError(): Error | null {
  return lastSessionReadError;
}

/** Safe, token-free diagnostics for distinguishing absent storage from an unusable session. */
export function getSupabaseSessionDiagnostics() {
  const session = currentSession;
  const token = typeof session?.access_token === "string" ? session.access_token : "";
  const jwtExp = token ? (() => {
    const payload = token.split(".")[1];
    if (!payload) return null;
    try {
      const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
      const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
      const claims = JSON.parse(atob(padded)) as { exp?: unknown };
      return typeof claims.exp === "number" && Number.isFinite(claims.exp) ? claims.exp : null;
    } catch {
      return null;
    }
  })() : null;
  return {
    sessionInitialized,
    hasCurrentSession: Boolean(session),
    hasAccessToken: token.trim().length > 0,
    tokenExpirySource: typeof session?.expires_at === "number" ? "expires_at" : jwtExp !== null ? "jwt_exp" : "missing",
    tokenExpiresAt: typeof session?.expires_at === "number" ? session.expires_at : jwtExp,
    tokenUsable: isSupabaseSessionUsable(session),
    readInFlight: sessionReadInFlight !== null,
    readBackoffActive: isSessionReadBackoffActive(sessionReadRetryAfter),
    lastReadErrorName: lastSessionReadError?.name ?? null,
    lastReadErrorMessage: lastSessionReadError?.message ?? null,
    refreshInFlight: accessTokenRefreshInFlight !== null,
    tokenResolution: resolveSupabaseAccessToken.getDiagnostics(),
    authStateRevision,
  };
}

export async function getSupabaseSession(): Promise<Session | null> {
  ensureAuthSubscription();

  const nowSeconds = Math.floor(Date.now() / 1000);
  // Supabase's browser client owns token rotation (autoRefreshToken=true).
  // Do not call refreshSession from this per-request accessor: concurrent API
  // headers, startup bootstrap, and the SDK timer can otherwise compete to
  // rotate the same one-time refresh token. A still-valid access token remains
  // usable inside the safety window; the SDK refreshes it in the background.
  if (sessionInitialized && isSupabaseSessionUsable(currentSession, nowSeconds)) {
    return currentSession;
  }

  if (sessionReadInFlight) return sessionReadInFlight;

  // Avoid having every concurrent tRPC batch immediately repeat a failed SDK
  // storage/refresh read. A valid cached access token is still returned above;
  // otherwise the next SDK auth event or cooldown expiry can resume recovery.
  if (isSessionReadBackoffActive(sessionReadRetryAfter)) return null;

  const requestRevision = authStateRevision;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const sdkRead = supabase.auth.getSession();
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      const error = new Error("Supabase session storage/refresh read did not settle before the deadline.");
      error.name = "PowerHubSessionReadTimeoutError";
      reject(error);
    }, SUPABASE_SESSION_READ_TIMEOUT_MS);
  });
  sessionReadInFlight = Promise.race([sdkRead, timeout])
    .then(({ data, error }) => {
      // Supabase's own initialize/refresh lifecycle may have updated the
      // auth listener while this read was waiting for its storage lock.
      if (error) {
        // A newer valid session event wins over the failed/stale read. If there
        // is no usable session, record the failure and throttle retries even if
        // an unrelated null auth event advanced the revision while it waited.
        if (isSupabaseSessionUsable(currentSession)) {
          if (requestRevision === authStateRevision) {
            lastSessionReadError = null;
            sessionReadRetryAfter = 0;
          }
          return currentSession;
        }
        lastSessionReadError = error instanceof Error ? error : new Error("Supabase session read failed.");
        sessionReadRetryAfter = Date.now() + SUPABASE_SESSION_READ_ERROR_BACKOFF_MS;
        return null;
      }

      lastSessionReadError = null;
      sessionReadRetryAfter = 0;

      // The SDK's getSession() owns refresh-token rotation and returns the
      // winning stored session if another tab completed rotation first. Never
      // call refreshSession() here: doing so races the SDK auto-refresh ticker.
      currentSession = selectAuthSnapshot(data.session ?? null, currentSession, requestRevision, authStateRevision);
      sessionInitialized = true;
      return isSupabaseSessionUsable(currentSession) ? currentSession : null;
    })
    .catch((error: unknown) => {
      // Keep a newer usable session; never allow a late failed snapshot to
      // replace it. Otherwise retain the concrete cause and apply cooldown
      // regardless of revision changes (e.g. a concurrent null INITIAL_SESSION).
      if (isSupabaseSessionUsable(currentSession)) {
        if (requestRevision === authStateRevision) {
          lastSessionReadError = null;
          sessionReadRetryAfter = 0;
        }
        return currentSession;
      }
      lastSessionReadError = error instanceof Error ? error : new Error("Supabase session read failed.");
      sessionReadRetryAfter = Date.now() + SUPABASE_SESSION_READ_ERROR_BACKOFF_MS;
      sessionInitialized = true;
      return null;
    })
    .finally(() => {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      sessionReadInFlight = null;
    });

  return sessionReadInFlight;
}

let accessTokenRefreshInFlight: Promise<Session | null> | null = null;

/**
 * Resolve Supabase's authoritative stored session for a protected API request.
 * Avoid refreshSession(oldSession): the old refresh token can already have been
 * rotated by Supabase auto-refresh or another tab. getSession() uses auth-js'
 * own single-flight refresh and the stored-winner recovery added in 2.117.1.
 *
 * A null result without a newer auth event is not enough to discard a still
 * valid session snapshot. A real sign-out/account switch increments revision
 * and remains authoritative.
 */
function resolveLatestSupabaseSessionForAccessToken(timeoutMs: number): Promise<Session | null> {
  if (accessTokenRefreshInFlight) return accessTokenRefreshInFlight;
  const requestRevision = authStateRevision;
  const previousSession = currentSession;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(Object.assign(new Error("Supabase session resolution did not settle before the bounded deadline."), {
        name: "PowerHubSessionRefreshTimeoutError",
      }));
    }, timeoutMs);
  });

  const sdkRead = supabase.auth.getSession().then(({ data, error }) => {
    if (error) throw error;
    const sdkSession = data.session ?? null;
    const selected = selectAuthSnapshot(sdkSession, currentSession, requestRevision, authStateRevision);

    if (requestRevision !== authStateRevision) {
      // A newer auth event (including SIGNED_OUT) wins over this SDK read.
      currentSession = selected;
    } else if (sdkSession) {
      currentSession = selected;
    } else {
      // Never allow one inconclusive empty snapshot to erase a valid stored
      // winner after concurrent token rotation.
      currentSession = isSupabaseSessionUsable(currentSession)
        ? currentSession
        : isSupabaseSessionUsable(previousSession)
          ? previousSession
          : null;
    }

    sessionInitialized = true;
    lastSessionReadError = null;
    sessionReadRetryAfter = 0;
    return currentSession;
  });

  let pending!: Promise<Session | null>;
  pending = Promise.race([sdkRead, timeout])
    .catch((error: unknown) => {
      const cause = error instanceof Error ? error : new Error("Supabase session resolution failed.");
      lastSessionReadError = cause;
      sessionReadRetryAfter = Date.now() + SUPABASE_SESSION_READ_ERROR_BACKOFF_MS;

      // A transient read/refresh timeout cannot force a redirect while the
      // previous user's access token remains valid. Never fall back after a
      // newer auth event because that may represent logout/account switching.
      const fallback = requestRevision === authStateRevision
        ? (isSupabaseSessionUsable(currentSession) ? currentSession : previousSession)
        : currentSession;
      if (isSupabaseSessionUsable(fallback)) {
        currentSession = fallback;
        return currentSession;
      }
      throw cause;
    })
    .finally(() => {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    });

  accessTokenRefreshInFlight = pending;
  // Keep the single-flight gate held if the caller deadline expires before the
  // underlying SDK operation settles; otherwise each new tRPC batch could
  // stack a new session read on a still-running refresh.
  void sdkRead.then(
    () => {
      if (accessTokenRefreshInFlight === pending) accessTokenRefreshInFlight = null;
    },
    () => {
      if (accessTokenRefreshInFlight === pending) accessTokenRefreshInFlight = null;
    },
  );
  return pending;
}

function waitForAuthStateChange(timeoutMs: number): Promise<boolean> {
  ensureAuthSubscription();
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (changed: boolean) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      authSubscribers.delete(subscriber);
      resolve(changed);
    };
    const subscriber: AuthSubscriber = (event, session) => {
      if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED" ||
          event === "USER_UPDATED" || event === "SIGNED_OUT" ||
          isSupabaseSessionUsable(session)) finish(true);
    };
    authSubscribers.add(subscriber);
    timer = setTimeout(() => finish(false), timeoutMs);
    if (isSupabaseSessionUsable(currentSession)) finish(true);
  });
}

const resolveSupabaseAccessToken = createSupabaseAccessTokenResolver<Session>({
  getCurrentSession: () => currentSession,
  getSupabaseSession,
  resolveLatestSession: resolveLatestSupabaseSessionForAccessToken,
  waitForAuthStateChange,
  isUsable: (session) => isSupabaseSessionUsable(session),
  shouldRefresh: (session) => shouldRefreshSupabaseSession(getSupabaseSessionExpirySeconds(session)),
  getLastSessionReadError: () => lastSessionReadError,
});

export function getSupabaseAccessToken(): Promise<string | null> {
  return resolveSupabaseAccessToken();
}
