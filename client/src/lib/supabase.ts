import { createClient, type AuthChangeEvent, type Session } from "@supabase/supabase-js";
import {
  isSupabaseSessionUsable,
  selectAuthSnapshot,
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
// Incremented for every accepted Supabase auth event. Async getSession/refresh
// snapshots must not overwrite a newer sign-in/sign-out event when they finish.
let authStateRevision = 0;
let expiredSessionRefreshInFlight: Promise<Session | null> | null = null;
let expiredRefreshFailureCount = 0;
let expiredRefreshRetryAfter = 0;

async function refreshExpiredSupabaseSession(): Promise<Session | null> {
  if (expiredSessionRefreshInFlight) return expiredSessionRefreshInFlight;
  if (Date.now() < expiredRefreshRetryAfter) {
    return isSupabaseSessionUsable(currentSession) ? currentSession : null;
  }
  const requestRevision = authStateRevision;
  expiredSessionRefreshInFlight = supabase.auth.refreshSession()
    .then(({ data, error }) => {
      // A newer auth event wins over this asynchronous response. In particular,
      // never resurrect a session if the user explicitly signed out mid-refresh.
      if (requestRevision !== authStateRevision) {
        return isSupabaseSessionUsable(currentSession) ? currentSession : null;
      }
      if (error || !data.session) {
        expiredRefreshFailureCount += 1;
        expiredRefreshRetryAfter = Date.now() + Math.min(60_000, 5_000 * 2 ** Math.min(expiredRefreshFailureCount - 1, 4));
        return isSupabaseSessionUsable(currentSession) ? currentSession : null;
      }
      expiredRefreshFailureCount = 0;
      expiredRefreshRetryAfter = 0;
      currentSession = data.session;
      sessionInitialized = true;
      return isSupabaseSessionUsable(currentSession) ? currentSession : null;
    })
    .catch(() => {
      if (requestRevision !== authStateRevision) {
        return isSupabaseSessionUsable(currentSession) ? currentSession : null;
      }
      expiredRefreshFailureCount += 1;
      expiredRefreshRetryAfter = Date.now() + Math.min(60_000, 5_000 * 2 ** Math.min(expiredRefreshFailureCount - 1, 4));
      return isSupabaseSessionUsable(currentSession) ? currentSession : null;
    })
    .finally(() => { expiredSessionRefreshInFlight = null; });
  return expiredSessionRefreshInFlight;
}

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
  // Supabase's browser client owns token rotation (autoRefreshToken=true).
  // Do not call refreshSession from this per-request accessor: concurrent API
  // headers, startup bootstrap, and the SDK timer can otherwise compete to
  // rotate the same one-time refresh token. A still-valid access token remains
  // usable inside the safety window; the SDK refreshes it in the background.
  if (sessionInitialized && isSupabaseSessionUsable(currentSession, nowSeconds)) {
    return currentSession;
  }

  // A manual refresh is permitted only after the access token has expired.
  // Near-expiry tokens are returned while Supabase's built-in timer owns
  // rotation; this avoids racing the SDK's one-time refresh-token lifecycle.
  if (sessionInitialized && currentSession && !isSupabaseSessionUsable(currentSession, nowSeconds)) {
    return refreshExpiredSupabaseSession();
  }

  if (sessionReadInFlight) return sessionReadInFlight;

  const requestRevision = authStateRevision;
  sessionReadInFlight = supabase.auth
    .getSession()
    .then(({ data, error }) => {
      // Supabase's own initialize/refresh lifecycle may have updated the
      // auth listener while this read was waiting for its storage lock.
      if (error) {
        return isSupabaseSessionUsable(currentSession) ? currentSession : null;
      }

      currentSession = selectAuthSnapshot(data.session ?? null, currentSession, requestRevision, authStateRevision);
      sessionInitialized = true;
      if (currentSession && !isSupabaseSessionUsable(currentSession)) {
        return refreshExpiredSupabaseSession();
      }
      return isSupabaseSessionUsable(currentSession) ? currentSession : null;
    })
    .catch(() => {
      if (requestRevision !== authStateRevision) {
        return isSupabaseSessionUsable(currentSession) ? currentSession : null;
      }
      // Never send an expired bearer token. A subsequent SDK auth event or
      // focus/reconnect-triggered query can recover without forcing a logout.
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
