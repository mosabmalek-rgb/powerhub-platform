import { createClient, type AuthChangeEvent, type Session } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabasePublishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!supabaseUrl || !supabasePublishableKey) {
  throw new Error("Supabase Auth is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY.");
}

export const supabase = createClient(supabaseUrl, supabasePublishableKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});

let currentSession: Session | null = null;
let sessionInitialized = false;
let sessionReadInFlight: Promise<Session | null> | null = null;
let authSubscriptionReady = false;

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
  const expiresAt = currentSession?.expires_at ?? 0;
  const hasRefreshWindow = expiresAt > nowSeconds + 30;

  if (sessionInitialized && (currentSession === null || hasRefreshWindow)) {
    return currentSession;
  }

  if (sessionReadInFlight) return sessionReadInFlight;

  sessionReadInFlight = supabase.auth
    .getSession()
    .then(({ data, error }) => {
      if (data.session) {
        currentSession = data.session;
        sessionInitialized = true;
        return currentSession;
      }

      // Supabase may attempt a network refresh when the access token is close
      // to expiry. If that refresh fails because the device is temporarily
      // offline, keep using the currently valid access token until its actual
      // expiry. Never revive an already-expired session offline.
      const currentExpiresAt = currentSession?.expires_at ?? 0;
      const nowSeconds = Math.floor(Date.now() / 1000);
      if (error && currentSession && currentExpiresAt > nowSeconds) {
        sessionInitialized = true;
        return currentSession;
      }

      currentSession = null;
      sessionInitialized = true;
      return null;
    })
    .catch(() => {
      const currentExpiresAt = currentSession?.expires_at ?? 0;
      const nowSeconds = Math.floor(Date.now() / 1000);
      if (currentSession && currentExpiresAt > nowSeconds) {
        sessionInitialized = true;
        return currentSession;
      }

      currentSession = null;
      sessionInitialized = true;
      return null;
    })
    .finally(() => {
      sessionReadInFlight = null;
    });

  return sessionReadInFlight;
}

export async function getSupabaseAccessToken() {
  const session = await getSupabaseSession();
  return session?.access_token ?? null;
}
