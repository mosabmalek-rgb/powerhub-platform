import { startLogin } from "@/const";
import { trpc } from "@/lib/trpc";
import { getOfflineAuthUser, persistOfflineAuthUser } from "@/lib/offline-query-cache";
import { getSupabaseSession, subscribeSupabaseAuthState } from "@/lib/supabase";
import { useCallback, useEffect, useState } from "react";

type UseAuthOptions = {
  redirectOnUnauthenticated?: boolean;
  redirectPath?: string;
};

const AUTH_DATA_EVENTS = new Set(["INITIAL_SESSION", "SIGNED_IN", "SIGNED_OUT", "USER_UPDATED"]);

export function useAuth(options?: UseAuthOptions) {
  // Login is started via startLogin() in the effect below, only when we actually
  // navigate — never during render. startLogin() mints a one-time nonce + writes
  // the state cookie, so calling it per render would overwrite the cookie and
  // desync it from an in-flight login's `state`.
  const { redirectOnUnauthenticated = false, redirectPath } = options ?? {};
  const utils = trpc.useUtils();
  const [sessionReady, setSessionReady] = useState(false);
  const [hasSession, setHasSession] = useState(false);
  const [authDataRevision, setAuthDataRevision] = useState(0);

  const meQuery = trpc.auth.me.useQuery(undefined, {
    enabled: hasSession,
    retry: false,
    refetchOnWindowFocus: false,
  });
  type CachedAuthUser = Exclude<typeof meQuery.data, undefined>;
  const [cachedUser, setCachedUser] = useState<CachedAuthUser | null>(null);

  useEffect(() => {
    let active = true;
    void getSupabaseSession().then(async (session) => {
      if (!active) return;
      setHasSession(Boolean(session));
      setSessionReady(true);
      if (!session) return;
      const cached = await getOfflineAuthUser<CachedAuthUser>(session.user.id);
      if (active && cached) setCachedUser(cached);
    });

    return subscribeSupabaseAuthState((event, session) => {
      setHasSession(Boolean(session));
      setSessionReady(true);
      if (!session) {
        setCachedUser(null);
      } else {
        void getOfflineAuthUser<CachedAuthUser>(session.user.id).then((cached) => {
          if (cached) setCachedUser(cached);
        });
      }

      // TOKEN_REFRESHED only replaces credentials. It must not invalidate every
      // auth.me query instance across the application, otherwise a routine token
      // renewal can fan out into a request storm. Identity/profile changes do.
      if (AUTH_DATA_EVENTS.has(event)) setAuthDataRevision((value) => value + 1);
    });
  }, []);

  useEffect(() => {
    if (authDataRevision === 0) return;
    void utils.auth.me.invalidate();
  }, [authDataRevision, utils.auth.me]);

  useEffect(() => {
    if (!meQuery.data) return;
    setCachedUser(meQuery.data);
    void getSupabaseSession().then((session) => {
      const userId = session?.user.id;
      if (userId) void persistOfflineAuthUser(userId, meQuery.data);
    });
  }, [meQuery.data]);

  const logout = useCallback(async () => {
    await supabaseSignOutSafely();
    setCachedUser(null);
    utils.auth.me.setData(undefined, null);
    await utils.auth.me.invalidate();
  }, [utils]);

  const user = meQuery.data ?? cachedUser;
  const state = {
    user,
    loading: !sessionReady || (hasSession && meQuery.isLoading && !cachedUser),
    error: meQuery.error ?? null,
    isAuthenticated: Boolean(hasSession && user),
  };

  useEffect(() => {
    if (!redirectOnUnauthenticated) return;
    if (!sessionReady || meQuery.isLoading) return;
    if (state.user) return;
    if (typeof window === "undefined") return;
    if (redirectPath && window.location.pathname === redirectPath) return;

    // Navigate at this moment only. startLogin() mints the nonce + cookie itself.
    if (redirectPath) {
      window.location.href = redirectPath;
    } else {
      startLogin();
    }
  }, [
    redirectOnUnauthenticated,
    redirectPath,
    meQuery.isLoading,
    sessionReady,
    state.user,
  ]);

  return {
    ...state,
    refresh: () => meQuery.refetch(),
    logout,
  };
}

async function supabaseSignOutSafely() {
  const { supabase } = await import("@/lib/supabase");
  await supabase.auth.signOut();
}
