import { createClient, type AuthChangeEvent, type Session } from "@supabase/supabase-js";
import { selectAuthSnapshot } from "@/lib/offline-auth-state";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabasePublishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!supabaseUrl || !supabasePublishableKey) {
  throw new Error("Supabase Auth is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY.");
}

export const supabase = createClient(supabaseUrl, supabasePublishableKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: false,
    detectSessionInUrl: true,
  },
});

let currentSession: Session | null = null;
let sessionInitialized = false;
let sessionReadInFlight: Promise<Session | null> | null = null;
let authSubscriptionReady = false;
let refreshSessionInFlight: Promise<Session | null> | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
// Incremented for every accepted Supabase auth event. Async getSession/refresh
// snapshots must not overwrite a newer sign-in/sign-out event when they finish.
let authStateRevision = 0;

type AuthSubscriber = (event: AuthChangeEvent, session: Session | null) => void;
const authSubscribers = new Set<AuthSubscriber>();

function scheduleSessionRefresh(session: Session | null) {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  if (!session?.expires_at || typeof window === "undefined") return;
  const delay = Math.max(15_000, (session.expires_at * 1000) - Date.now() - 60_000);
  refreshTimer = setTimeout(() => { void refreshSupabaseSession(); }, delay);
}

async function refreshSupabaseSession(): Promise<Session | null> {
  if (refreshSessionInFlight) return refreshSessionInFlight;
  const requestRevision = authStateRevision;
  refreshSessionInFlight = supabase.auth.refreshSession()
    .then(({ data }) => {
      const nextSession = selectAuthSnapshot(data.session ?? null, currentSession, requestRevision, authStateRevision);
      currentSession = nextSession;
      sessionInitialized = true;
      scheduleSessionRefresh(currentSession);
      return currentSession;
    })
    .catch(() => currentSession)
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
    scheduleSessionRefresh(session);

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
  if (sessionInitialized && currentSession) {
    if (expiresAt > nowSeconds) {
      // Refresh is centrally scheduled; ordinary API calls must not trigger
      // their own refresh requests and create a refresh-token race.
      if (expiresAt <= nowSeconds + 60) void refreshSupabaseSession();
      return currentSession;
    }
    return refreshSupabaseSession();
  }

  if (sessionReadInFlight) return sessionReadInFlight;

  const requestRevision = authStateRevision;
  sessionReadInFlight = supabase.auth
    .getSession()
    .then(({ data }) => {
      // A newer SIGNED_IN / SIGNED_OUT / INITIAL_SESSION event is authoritative;
      // never let this possibly stale snapshot clobber it.
      currentSession = selectAuthSnapshot(data.session ?? null, currentSession, requestRevision, authStateRevision);
      sessionInitialized = true;
      scheduleSessionRefresh(currentSession);
      return currentSession;
    })
    .catch(() => {
      if (requestRevision !== authStateRevision) return currentSession;
      // Never manufacture a new session after a transient storage/network
      // failure. Keep a still-valid in-memory session if one exists.
      if (currentSession && (currentSession.expires_at ?? 0) > Math.floor(Date.now() / 1000)) return currentSession;
      currentSession = null;
      sessionInitialized = true;
      return null;
    })
    .finally(() => { sessionReadInFlight = null; });

  return sessionReadInFlight;
}

export async function getSupabaseAccessToken() {
  const session = await getSupabaseSession();
  return session?.access_token ?? null;
}
