import { createClient, type AuthChangeEvent, type Session } from "@supabase/supabase-js";
import {
  isSupabaseSessionUsable,
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

const TOKEN_AUTH_EVENT_WAIT_MS = 1_200;
let accessTokenReadInFlight: Promise<string | null> | null = null;

/**
 * A tRPC batch can start in the same turn as Supabase finishes restoring or
 * rotating a session. Give the SDK's authoritative auth event one short,
 * bounded opportunity to publish that session before declaring no token.
 * This is not an offline lease and never sends an anonymous protected request.
 */
function waitForAuthStateChange(timeoutMs = TOKEN_AUTH_EVENT_WAIT_MS): Promise<void> {
  ensureAuthSubscription();
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      authSubscribers.delete(subscriber);
      resolve();
    };
    const subscriber: AuthSubscriber = (event, session) => {
      if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED" ||
          event === "USER_UPDATED" || event === "SIGNED_OUT" ||
          isSupabaseSessionUsable(session)) finish();
    };
    authSubscribers.add(subscriber);
    timer = setTimeout(finish, timeoutMs);
    // Close the race where a usable event landed immediately before subscription.
    if (isSupabaseSessionUsable(currentSession)) finish();
  });
}

async function readSupabaseAccessToken(): Promise<string | null> {
  let session = await getSupabaseSession();
  if (!session || !isSupabaseSessionUsable(session)) {
    // A single bounded reconciliation handles startup/sign-in/token-refresh
    // ordering without a refreshSession storm across concurrent tRPC requests.
    await waitForAuthStateChange();
    session = await getSupabaseSession();
  }

  if (!session || !isSupabaseSessionUsable(session)) {
    const cause = lastSessionReadError as (Error & { code?: unknown; status?: unknown; statusCode?: unknown }) | null;
    if (cause && (cause.status === 429 || cause.statusCode === 429 || cause.code === "over_request_rate_limit")) {
      throw Object.assign(new Error("Supabase rate-limited the session refresh request."), {
        name: "PowerHubSupabaseRateLimitError",
        cause,
      });
    }
    if (cause?.name === "PowerHubSessionReadTimeoutError") {
      throw Object.assign(new Error("Supabase session restoration timed out before a usable access token was available."), {
        name: "PowerHubSessionReadTimeoutError",
        cause,
      });
    }
    if (cause) {
      throw Object.assign(new Error("Supabase could not read or restore a session before a usable access token was available."), {
        name: "PowerHubSessionReadFailedError",
        cause,
      });
    }
    return null;
  }
  return typeof session.access_token === "string" && session.access_token.trim().length > 0
    ? session.access_token
    : null;
}

/**
 * All simultaneous API batches share one bounded token acquisition/recovery
 * attempt. Do not trigger refreshSession here; Supabase owns token rotation.
 */
export function getSupabaseAccessToken(): Promise<string | null> {
  if (accessTokenReadInFlight) return accessTokenReadInFlight;
  accessTokenReadInFlight = readSupabaseAccessToken().finally(() => {
    accessTokenReadInFlight = null;
  });
  return accessTokenReadInFlight;
}
