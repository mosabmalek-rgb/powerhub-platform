import { startLogin } from "@/const";
import { trpc } from "@/lib/trpc";
import { getOfflineAuthUser, persistOfflineAuthUser } from "@/lib/offline-query-cache";
import { getValidOfflineAuthLease, renewOfflineAuthLease, revokeOfflineAuthLease } from "@/lib/offline-auth";
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
  const [offlineLeaseUserId, setOfflineLeaseUserId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void getSupabaseSession().then(async (session) => {
      if (!active) return;
      setHasSession(Boolean(session));
      setSessionReady(true);
      if (!session) {
        const offlineLease = await getValidOfflineAuthLease();
        if (offlineLease) {
          const cached = await getOfflineAuthUser<CachedAuthUser>(offlineLease.userId);
          if (active && cached) {
            setCachedUser(cached);
            setOfflineLeaseUserId(offlineLease.userId);
            setHasSession(true);
          }
        }
        return;
      }
      const cached = await getOfflineAuthUser<CachedAuthUser>(session.user.id);
      if (active && cached) setCachedUser(cached);
      if (active) setOfflineLeaseUserId(session.user.id);
    });

    const unsubscribe = subscribeSupabaseAuthState((event, session) => {
      setHasSession(Boolean(session));
      setSessionReady(true);
      if (!session) {
        setCachedUser(null);
        setOfflineLeaseUserId(null);
        void revokeOfflineAuthLease();
      } else {
        setOfflineLeaseUserId(session.user.id);
        void getOfflineAuthUser<CachedAuthUser>(session.user.id).then((cached) => {
          if (cached) setCachedUser(cached);
        });
      }

      // TOKEN_REFRESHED only replaces credentials. It must not invalidate every
      // auth.me query instance across the application, otherwise a routine token
      // renewal can fan out into a request storm. Identity/profile changes do.
      if (AUTH_DATA_EVENTS.has(event)) setAuthDataRevision((value) => value + 1);
    });

    return () => {
      unsubscribe();
      active = false;
    };
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
    // meQuery.data is returned by the authenticated PowerHub API, so this is
    // the point at which the browser has actually completed an online check.
    // Only this confirmed online response may renew the 48-hour offline lease.
    void getSupabaseSession().then((session) => {
      const userId = session?.user.id;
      if (userId && typeof navigator !== "undefined" && navigator.onLine) {
        void renewOfflineAuthLease(userId);
      }
    });
  }, [meQuery.data]);

  const logout = useCallback(async () => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("powerhub:explicit-logout", "1");
    }

    try {
      await utils.auth.releaseDevice.mutateAsync();
      await supabaseSignOutSafely();
    } finally {
      setCachedUser(null);
      setOfflineLeaseUserId(null);
      await revokeOfflineAuthLease();
      utils.auth.me.setData(undefined, null);
      await utils.auth.me.invalidate();
    }
  }, [utils]);

  const user = meQuery.data ?? cachedUser;
  const offlineAuthenticated = Boolean(offlineLeaseUserId && cachedUser);
  const effectiveHasSession = hasSession || offlineAuthenticated;
  const state = {
    user,
    loading: !sessionReady || (effectiveHasSession && meQuery.isLoading && !cachedUser),
    error: meQuery.error ?? null,
    isAuthenticated: Boolean(effectiveHasSession && user),
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
  // Logout is device-local by design: remove the current browser session
  // deterministically, without terminating other active devices.
  await supabase.auth.signOut({ scope: "local" });
}
