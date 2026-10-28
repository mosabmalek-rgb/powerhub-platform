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

/**
 * Adopt the authoritative session returned by signInWithPassword immediately.
 * The SDK event remains enabled; this synchronous handoff prevents tRPC headers
 * and AuthProvider from racing browser storage/event propagation after sign-in.
 */
export function acceptSupabaseSignInSession(session: Session): void {
  ensureAuthSubscription();
  if (!session?.user?.id || !isSupabaseSessionUsable(session)) {
    throw new Error("Supabase returned no usable session after sign-in.");
  }

  authStateRevision += 1;
  currentSession = session;
  sessionInitialized = true;
  sessionReadRetryAfter = 0;
  lastSessionReadError = null;

  // Route gates and AuthProvider share the same transition. Protected content
  // still requires the online auth.me validation performed by RouteAccessGate.
  for (const subscriber of authSubscribers) subscriber("SIGNED_IN", session);
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
    refreshInFlight: sessionReadInFlight !== null,
    tokenResolution: resolveSupabaseAccessToken.getDiagnostics(),
    authStateRevision,
  };
}

function awaitSupabaseSessionRead(
  operation: Promise<Session | null>,
  timeoutMs: number,
  timeoutName: "PowerHubSessionReadTimeoutError" | "PowerHubSessionRefreshTimeoutError",
): Promise<Session | null> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(Object.assign(new Error("Supabase session storage/refresh read did not settle before the deadline."), {
        name: timeoutName,
      }));
    }, timeoutMs);
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  });
}

/**
 * The only place allowed to call supabase.auth.getSession().
 * The lock holds the underlying SDK promise, not any caller's timeout wrapper.
 */
function startOrJoinSupabaseSdkSessionRead(): Promise<Session | null> {
  if (sessionReadInFlight) return sessionReadInFlight;

  const requestRevision = authStateRevision;
  const previousSession = currentSession;
  const sdkRead = supabase.auth.getSession().then(({ data, error }) => {
    if (error) throw error;

    const sdkSession = data.session ?? null;
    const selected = selectAuthSnapshot(sdkSession, currentSession, requestRevision, authStateRevision);
    if (requestRevision !== authStateRevision) {
      currentSession = selected;
    } else if (sdkSession) {
      currentSession = selected;
    } else {
      // A transient empty result after another tab wins a refresh must not erase
      // a still-valid session, but a real sign-out/account switch remains final.
      currentSession = isSupabaseSessionUsable(currentSession)
        ? currentSession
        : isSupabaseSessionUsable(previousSession)
          ? previousSession
          : null;
    }

    sessionInitialized = true;
    lastSessionReadError = null;
    sessionReadRetryAfter = 0;
    return isSupabaseSessionUsable(currentSession) ? currentSession : null;
  }).catch((error: unknown) => {
    const cause = error instanceof Error ? error : new Error("Supabase session read failed.");
    const fallback = requestRevision === authStateRevision
      ? (isSupabaseSessionUsable(currentSession) ? currentSession : previousSession)
      : currentSession;
    if (isSupabaseSessionUsable(fallback)) {
      currentSession = fallback;
      sessionInitialized = true;
      if (requestRevision === authStateRevision) {
        lastSessionReadError = null;
        sessionReadRetryAfter = 0;
      }
      return currentSession;
    }
    lastSessionReadError = cause;
    sessionReadRetryAfter = Date.now() + SUPABASE_SESSION_READ_ERROR_BACKOFF_MS;
    sessionInitialized = true;
    throw cause;
  });

  let pending!: Promise<Session | null>;
  pending = sdkRead.finally(() => {
    // Caller timeout does not release the lock while auth-js still owns its
    // storage/refresh operation. Every access path joins this same promise.
    if (sessionReadInFlight === pending) sessionReadInFlight = null;
  });
  sessionReadInFlight = pending;
  return pending;
}

export async function getSupabaseSession(): Promise<Session | null> {
  ensureAuthSubscription();
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (sessionInitialized && isSupabaseSessionUsable(currentSession, nowSeconds)) {
    return currentSession;
  }

  // Existing SDK work wins over cooldown so all callers join it.
  const operation = sessionReadInFlight ??
    (isSessionReadBackoffActive(sessionReadRetryAfter) ? null : startOrJoinSupabaseSdkSessionRead());
  if (!operation) return null;
  try {
    return await awaitSupabaseSessionRead(
      operation,
      SUPABASE_SESSION_READ_TIMEOUT_MS,
      "PowerHubSessionReadTimeoutError",
    );
  } catch (error) {
    const cause = error instanceof Error ? error : new Error("Supabase session read failed.");
    if (isSupabaseSessionUsable(currentSession)) return currentSession;
    lastSessionReadError = cause;
    sessionReadRetryAfter = Date.now() + SUPABASE_SESSION_READ_ERROR_BACKOFF_MS;
    sessionInitialized = true;
    return null;
  }
}

/** The recovery path joins the same SDK read, bypassing only the retry cooldown. */
function resolveLatestSupabaseSessionForAccessToken(timeoutMs: number): Promise<Session | null> {
  ensureAuthSubscription();
  const operation = startOrJoinSupabaseSdkSessionRead();
  return awaitSupabaseSessionRead(
    operation,
    timeoutMs,
    "PowerHubSessionRefreshTimeoutError",
  ).catch((error: unknown) => {
    const cause = error instanceof Error ? error : new Error("Supabase session resolution failed.");
    if (isSupabaseSessionUsable(currentSession)) return currentSession;
    lastSessionReadError = cause;
    sessionReadRetryAfter = Date.now() + SUPABASE_SESSION_READ_ERROR_BACKOFF_MS;
    throw cause;
  });
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
