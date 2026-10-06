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
  const releaseDevice = trpc.auth.releaseDevice.useMutation();
  const [sessionReady, setSessionReady] = useState(false);
  const [hasSession, setHasSession] = useState(false);
  const [authDataRevision, setAuthDataRevision] = useState(0);
  const [isLoggingOut, setIsLoggingOut] = useState(false);

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
    setIsLoggingOut(true);
    setCachedUser(null);
    setOfflineLeaseUserId(null);
    if (typeof window !== "undefined") {
      window.localStorage.setItem("powerhub:explicit-logout", "1");
    }

    try {
      // Device release is best-effort. A stale/missing server lock must never
      // prevent Supabase from clearing the local session.
      await releaseDevice.mutateAsync().catch(() => undefined);
    } finally {
      await supabaseSignOutSafely().catch(() => undefined);
      setCachedUser(null);
      setOfflineLeaseUserId(null);
      await revokeOfflineAuthLease();
      utils.auth.me.setData(undefined, null);
      await utils.auth.me.invalidate();
    }
  }, [releaseDevice, utils]);

  // A cached user is useful for offline mode, but must never authorize the
  // online workspace before the current Supabase session has completed a live
  // auth.me check. This prevents protected tenant queries from racing the
  // login/session handshake and avoids transient 401/403 states in the UI.
  const isOnlineAuthenticated = Boolean(hasSession && (meQuery.isSuccess && meQuery.data || cachedUser));
  const offlineAuthenticated = Boolean(
    !hasSession &&
      offlineLeaseUserId &&
      cachedUser &&
      typeof navigator !== "undefined" &&
      navigator.onLine === false,
  );
  // Keep the last confirmed profile during a transient auth.me failure/refetch.
  // The server remains the authority for every protected operation; this prevents
  // a temporary profile/API error from looking like a real logout in the UI.
  const user = meQuery.data ?? cachedUser ?? (offlineAuthenticated ? cachedUser : null);
  const state = {
    user,
    loading: isLoggingOut || !sessionReady || Boolean(hasSession && meQuery.isPending),
    error: meQuery.error ?? null,
    isAuthenticated: !isLoggingOut && Boolean(isOnlineAuthenticated || offlineAuthenticated),
    isOnlineAuthenticated: !isLoggingOut && isOnlineAuthenticated,
    isLoggingOut,
  };

  useEffect(() => {
    if (!redirectOnUnauthenticated) return;
    if (!sessionReady || meQuery.isLoading) return;
    if (state.user) return;
    if (typeof window === "undefined") return;
    if (redirectPath && window.location.pathname === redirectPath) return;

    // Do not treat a transient auth.me/API failure as a logout. Confirm the
    // browser session itself is gone before starting a new login flow.
    void getSupabaseSession().then(async (session) => {
      if (session) return;
      const lease = await getValidOfflineAuthLease();
      if (lease || (typeof navigator !== "undefined" && navigator.onLine === false)) return;

      if (redirectPath) {
        window.location.href = redirectPath;
      } else {
        startLogin();
      }
    });
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
