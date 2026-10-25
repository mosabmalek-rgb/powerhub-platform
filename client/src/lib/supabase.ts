import { createClient, type AuthChangeEvent, type Session } from "@supabase/supabase-js";
import {
  isSupabaseSessionUsable,
  selectAuthSnapshot,
  shouldRefreshSupabaseSession,
  SUPABASE_BROWSER_AUTH_OPTIONS,
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
let authSubscriptionReady = false;
let refreshSessionInFlight: Promise<Session | null> | null = null;
let refreshFailureCount = 0;
let refreshRetryAfter = 0;
const REFRESH_BACKOFF_BASE_MS = 5_000;
const REFRESH_BACKOFF_MAX_MS = 60_000;

export function isSupabaseRefreshBackoffActive() {
  return Date.now() < refreshRetryAfter;
}

function recordRefreshFailure() {
  refreshFailureCount += 1;
  const delay = Math.min(
    REFRESH_BACKOFF_MAX_MS,
    REFRESH_BACKOFF_BASE_MS * 2 ** Math.min(refreshFailureCount - 1, 4),
  );
  refreshRetryAfter = Date.now() + delay;
}

function clearRefreshBackoff() {
  refreshFailureCount = 0;
  refreshRetryAfter = 0;
}
// Incremented for every accepted Supabase auth event. Async getSession/refresh
// snapshots must not overwrite a newer sign-in/sign-out event when they finish.
let authStateRevision = 0;

type AuthSubscriber = (event: AuthChangeEvent, session: Session | null) => void;
const authSubscribers = new Set<AuthSubscriber>();

async function refreshSupabaseSession(): Promise<Session | null> {
  if (refreshSessionInFlight) return refreshSessionInFlight;
  // Several queries can ask for a session at once. After Supabase rate-limits a
  // refresh, avoid retrying the same refresh token on every request; use bounded
  // exponential backoff while still returning a token only if it is unexpired.
  if (isSupabaseRefreshBackoffActive()) {
    return isSupabaseSessionUsable(currentSession) ? currentSession : null;
  }
  const requestRevision = authStateRevision;
  refreshSessionInFlight = supabase.auth.refreshSession()
    .then(({ data, error }) => {
      // A failed refresh must never make an expired token appear usable.
      // Any newer auth event, including SIGNED_OUT/TOKEN_REFRESHED, remains authoritative.
      if (error || !data.session) {
        recordRefreshFailure();
        return isSupabaseSessionUsable(currentSession) ? currentSession : null;
      }

      clearRefreshBackoff();
      currentSession = selectAuthSnapshot(data.session, currentSession, requestRevision, authStateRevision);
      sessionInitialized = true;
      return isSupabaseSessionUsable(currentSession) ? currentSession : null;
    })
    .catch(() => {
      // Network/auth-lock failures can be transient. Preserve a live in-memory
      // session, but never return an access token that has already expired.
      recordRefreshFailure();
      return isSupabaseSessionUsable(currentSession) ? currentSession : null;
    })
    .finally(() => { refreshSessionInFlight = null; });
  return refreshSessionInFlight;
}

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
    if (session) clearRefreshBackoff();

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

export async function getSupabaseSession(): Promise<Session | null> {
  ensureAuthSubscription();

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (sessionInitialized && currentSession) {
    if (
      isSupabaseSessionUsable(currentSession, nowSeconds) &&
      !shouldRefreshSupabaseSession(currentSession.expires_at, nowSeconds)
    ) {
      return currentSession;
    }

    // Do not race a protected request using the old access token against an
    // async refresh. Await refresh whenever expiry is near or has passed.
    return refreshSupabaseSession();
  }

  if (sessionReadInFlight) return sessionReadInFlight;

  const requestRevision = authStateRevision;
  sessionReadInFlight = supabase.auth
    .getSession()
    .then(async ({ data, error }) => {
      // A storage/auth-lock error must not erase a newer event or hand out an
      // expired snapshot. The Supabase auth listener remains authoritative.
      if (error) {
        return isSupabaseSessionUsable(currentSession) ? currentSession : null;
      }

      currentSession = selectAuthSnapshot(data.session ?? null, currentSession, requestRevision, authStateRevision);
      sessionInitialized = true;
      if (!currentSession) return null;

      if (shouldRefreshSupabaseSession(currentSession.expires_at, Math.floor(Date.now() / 1000))) {
        return refreshSupabaseSession();
      }
      return isSupabaseSessionUsable(currentSession) ? currentSession : null;
    })
    .catch(() => {
      if (requestRevision !== authStateRevision) {
        return isSupabaseSessionUsable(currentSession) ? currentSession : null;
      }
      // Do not manufacture a session after a failed read; only preserve an
      // in-memory session if its current access token is still valid.
      if (isSupabaseSessionUsable(currentSession)) return currentSession;
      sessionInitialized = true;
      return null;
    })
    .finally(() => { sessionReadInFlight = null; });

  return sessionReadInFlight;
}

export async function getSupabaseAccessToken() {
  const session = await getSupabaseSession();
  if (!session || !isSupabaseSessionUsable(session)) return null;
  return session.access_token;
}
