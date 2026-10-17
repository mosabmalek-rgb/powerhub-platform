import { startLogin } from "@/const";
import { trpc } from "@/lib/trpc";
import { getOfflineAuthUser, persistOfflineAuthUser } from "@/lib/offline-query-cache";
import { getValidOfflineAuthLease, renewOfflineAuthLease, revokeOfflineAuthLease } from "@/lib/offline-auth";
import { resolveOfflineAuthTransition } from "@/lib/offline-auth-state";
import { getSupabaseSession, subscribeSupabaseAuthState } from "@/lib/supabase";
import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

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
  const queryClient = useQueryClient();
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
    let observedUserId: string | null = null;
    let transitionRevision = 0;

    const restoreOfflineUser = async (expectedRevision: number) => {
      const lease = await getValidOfflineAuthLease();
      if (!lease) {
        if (active && transitionRevision === expectedRevision) {
          setCachedUser(null);
          setOfflineLeaseUserId(null);
          setSessionReady(true);
        }
        return;
      }
      const cached = await getOfflineAuthUser<CachedAuthUser>(lease.userId);
      if (!active || transitionRevision !== expectedRevision) return;
      if (cached) {
        setCachedUser(cached);
        setOfflineLeaseUserId(lease.userId);
      } else {
        setCachedUser(null);
        setOfflineLeaseUserId(null);
      }
      // Do not set hasSession=true here: the lease is local-only and must not
      // enable protected server queries without a real Supabase session.
      setSessionReady(true);
    };

    const unsubscribe = subscribeSupabaseAuthState((event, session) => {
      const revision = ++transitionRevision;
      const nextUserId = session?.user.id ?? null;
      let explicitLogoutRequested = false;
      try {
        explicitLogoutRequested = window.localStorage.getItem("powerhub:explicit-logout") === "1";
      } catch {
        // Storage may be unavailable in private browsing; event alone is not enough
        // to distinguish a deliberate logout from startup/session restoration.
      }

      const transition = resolveOfflineAuthTransition(event, nextUserId, explicitLogoutRequested);
      const identityChanged = observedUserId !== nextUserId;
      if (event === "SIGNED_OUT" || (identityChanged && nextUserId !== null)) queryClient.clear();
      observedUserId = nextUserId;
      setHasSession(Boolean(session));

      if (transition === "explicit-sign-out") {
        setCachedUser(null);
        setOfflineLeaseUserId(null);
        void revokeOfflineAuthLease();
        try { window.localStorage.removeItem("powerhub:explicit-logout"); } catch { /* best effort */ }
        setSessionReady(true);
      } else if (transition === "online-session" && session) {
        if (identityChanged) {
          setCachedUser(null);
          setOfflineLeaseUserId(null);
        }
        setOfflineLeaseUserId(session.user.id);
        void getOfflineAuthUser<CachedAuthUser>(session.user.id).then((cached) => {
          if (!active || transitionRevision !== revision) return;
          if (cached) setCachedUser(cached);
          setSessionReady(true);
        });
      } else {
        // INITIAL_SESSION(null), token/session recovery failures, and non-explicit
        // SIGNED_OUT must try the local lease before the route gate decides to redirect.
        setHasSession(false);
        void restoreOfflineUser(revision);
      }

      if (AUTH_DATA_EVENTS.has(event)) setAuthDataRevision((value) => value + 1);
    });

    // Subscribe first to avoid a session event racing the initial snapshot.
    void getSupabaseSession().then(async (session) => {
      if (!active) return;
      const revision = ++transitionRevision;
      observedUserId = session?.user.id ?? null;
      setHasSession(Boolean(session));
      if (session) {
        const cached = await getOfflineAuthUser<CachedAuthUser>(session.user.id);
        if (!active || transitionRevision !== revision) return;
        if (cached) setCachedUser(cached);
        setOfflineLeaseUserId(session.user.id);
        setSessionReady(true);
      } else {
        await restoreOfflineUser(revision);
      }
    }).catch(async () => {
      if (!active) return;
      const revision = ++transitionRevision;
      setHasSession(false);
      await restoreOfflineUser(revision);
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [queryClient]);

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
    queryClient.clear();
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
      try { window.localStorage.removeItem("powerhub:explicit-logout"); } catch { /* best effort */ }
      utils.auth.me.setData(undefined, null);
      await utils.auth.me.invalidate();
    }
  }, [releaseDevice, utils, queryClient]);

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
