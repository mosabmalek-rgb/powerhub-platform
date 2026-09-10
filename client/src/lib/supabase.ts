import { createClient, type Session } from "@supabase/supabase-js";

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

// Keep one in-memory session snapshot for the app. Supabase remains responsible
// for automatic refresh, while callers avoid starting concurrent getSession()
// operations during the same refresh window.
supabase.auth.onAuthStateChange((_event, session) => {
  currentSession = session;
  sessionInitialized = true;
});

export async function getSupabaseSession(): Promise<Session | null> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const expiresAt = currentSession?.expires_at ?? 0;
  const hasRefreshWindow = expiresAt > nowSeconds + 30;

  if (sessionInitialized && (currentSession === null || hasRefreshWindow)) {
    return currentSession;
  }

  if (sessionReadInFlight) return sessionReadInFlight;

  sessionReadInFlight = supabase.auth
    .getSession()
    .then(({ data }) => {
      currentSession = data.session;
      sessionInitialized = true;
      return currentSession;
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
