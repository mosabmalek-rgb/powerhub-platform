import { startLogin } from "@/const";
import { trpc } from "@/lib/trpc";
import { getOfflineAuthUser, persistOfflineAuthUser } from "@/lib/offline-query-cache";
import { getSupabaseSession, supabase } from "@/lib/supabase";
import { useCallback, useEffect, useState } from "react";

type UseAuthOptions = {
  redirectOnUnauthenticated?: boolean;
  redirectPath?: string;
};

export function useAuth(options?: UseAuthOptions) {
  // Login is started via startLogin() in the effect below, only when we actually
  // navigate — never during render. startLogin() mints a one-time nonce + writes
  // the state cookie, so calling it per render would overwrite the cookie and
  // desync it from an in-flight login's `state`.
  const { redirectOnUnauthenticated = false, redirectPath } = options ?? {};
  const utils = trpc.useUtils();
  const [sessionReady, setSessionReady] = useState(false);
  const [hasSession, setHasSession] = useState(false);

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
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setHasSession(Boolean(session));
      setSessionReady(true);
      if (!session) {
        setCachedUser(null);
      } else {
        void getOfflineAuthUser<CachedAuthUser>(session.user.id).then((cached) => {
          if (cached) setCachedUser(cached);
        });
      }
      void utils.auth.me.invalidate();
    });
    return () => { active = false; listener.subscription.unsubscribe(); };
  }, [utils.auth.me]);

  useEffect(() => {
    if (!meQuery.data) return;
    setCachedUser(meQuery.data);
    void getSupabaseSession().then((session) => {
      const userId = session?.user.id;
      if (userId) void persistOfflineAuthUser(userId, meQuery.data);
    });
  }, [meQuery.data]);

  const logout = useCallback(async () => {
    await supabase.auth.signOut();
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
