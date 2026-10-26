import { createClient, type AuthChangeEvent, type Session } from "@supabase/supabase-js";
import {
  isSupabaseSessionUsable,
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
    // Supabase can deliver INITIAL_SESSION asynchronously. If a login has
    // already established a session, do not let a stale null initialization
    // event briefly erase it and make protected routes redirect to /login.
    if (event === "INITIAL_SESSION" && session === null && currentSession !== null) {
      sessionInitialized = true;
      return;
    }

    authStateRevision += 1;
    currentSession = session;
    sessionInitialized = true;
    // A fresh SDK auth event supersedes cooldown from an earlier failed read.
    sessionReadRetryAfter = 0;
    lastSessionReadError = null;

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
        if (requestRevision === authStateRevision) {
          lastSessionReadError = error instanceof Error ? error : new Error("Supabase session read failed.");
          sessionReadRetryAfter = Date.now() + SUPABASE_SESSION_READ_ERROR_BACKOFF_MS;
        }
        return isSupabaseSessionUsable(currentSession) ? currentSession : null;
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
      if (requestRevision !== authStateRevision) {
        return isSupabaseSessionUsable(currentSession) ? currentSession : null;
      }
      lastSessionReadError = error instanceof Error ? error : new Error("Supabase session read failed.");
      sessionReadRetryAfter = Date.now() + SUPABASE_SESSION_READ_ERROR_BACKOFF_MS;
      // Never send an expired bearer token. A subsequent SDK auth event or
      // focus/reconnect-triggered query can recover without forcing a logout.
      if (isSupabaseSessionUsable(currentSession)) return currentSession;
      sessionInitialized = true;
      return null;
    })
    .finally(() => {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      sessionReadInFlight = null;
    });

  return sessionReadInFlight;
}

export async function getSupabaseAccessToken() {
  const session = await getSupabaseSession();
  if (!session || !isSupabaseSessionUsable(session)) {
    if (lastSessionReadError?.name === "PowerHubSessionReadTimeoutError") {
      const error = new Error("Supabase session restoration timed out before a usable access token was available.");
      error.name = "PowerHubSessionReadTimeoutError";
      throw error;
    }
    return null;
  }
  return session.access_token;
}
