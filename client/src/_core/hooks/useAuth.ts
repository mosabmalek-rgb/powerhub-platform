import { startLogin } from "@/const";
import { trpc } from "@/lib/trpc";
import { getOfflineAuthUser, persistOfflineAuthUser } from "@/lib/offline-query-cache";
import { getValidOfflineAuthLease, renewOfflineAuthLease, revokeOfflineAuthLease } from "@/lib/offline-auth";
import { resolveOfflineAuthTransition } from "@/lib/offline-auth-state";
import { getSupabaseSession, isSupabaseRefreshBackoffActive, subscribeSupabaseAuthState } from "@/lib/supabase";
import { createContext, createElement, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { onlineManager, useQueryClient } from "@tanstack/react-query";

type UseAuthOptions = {
  redirectOnUnauthenticated?: boolean;
  redirectPath?: string;
};

const AUTH_DATA_EVENTS = new Set(["INITIAL_SESSION", "SIGNED_IN", "SIGNED_OUT", "USER_UPDATED"]);

const OFFLINE_AUTH_BOOTSTRAP_TIMEOUT_MS = 1_500;
const SESSION_BOOTSTRAP_TIMEOUT_MS = 5_000;

function withTimeoutFallback<T>(promise: Promise<T>, fallback: T, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(fallback);
    }, timeoutMs);

    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

function useAuthController() {
  // This controller is mounted once by AuthProvider. Every route guard, page,
  // and layout consumes the same auth/session snapshot through useAuth().
  const utils = trpc.useUtils();
  const queryClient = useQueryClient();
  const releaseDevice = trpc.auth.releaseDevice.useMutation();
  const [sessionReady, setSessionReady] = useState(false);
  const [hasSession, setHasSession] = useState(false);
  const [authDataRevision, setAuthDataRevision] = useState(0);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [powerHubReachable, setPowerHubReachable] = useState(() => onlineManager.isOnline());
  const explicitLogoutInProgress = useRef(false);

  const meQuery = trpc.auth.me.useQuery(undefined, {
    enabled: hasSession,
    // Retry transient server/network failures, but do not retry definitive
    // authorization failures as if they were connectivity problems.
    retry: (failureCount, error) => {
      const code = (error as { data?: { code?: string } } | null)?.data?.code;
      return failureCount < 2 && code !== "UNAUTHORIZED" && code !== "FORBIDDEN";
    },
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchInterval: (query) => query.state.status === "error" ? 15_000 : false,
  });
  type CachedAuthUser = Exclude<typeof meQuery.data, undefined>;
  const [cachedUser, setCachedUser] = useState<CachedAuthUser | null>(null);
  const [offlineLeaseUserId, setOfflineLeaseUserId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let observedUserId: string | null = null;
    let transitionRevision = 0;

    const restoreOfflineUser = async (expectedRevision: number) => {
      // IndexedDB is only a best-effort offline enhancement. It must not keep
      // the route gate in "loading" forever when browser storage stalls.
      const lease = await withTimeoutFallback(
        getValidOfflineAuthLease(),
        null,
        OFFLINE_AUTH_BOOTSTRAP_TIMEOUT_MS,
      );
      if (!active || transitionRevision !== expectedRevision) return;
      if (!lease) {
        setCachedUser(null);
        setOfflineLeaseUserId(null);
        setSessionReady(true);
        return;
      }

      const cached = await withTimeoutFallback(
        getOfflineAuthUser<CachedAuthUser>(lease.userId),
        null,
        OFFLINE_AUTH_BOOTSTRAP_TIMEOUT_MS,
      );
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
      let explicitLogoutRequested = explicitLogoutInProgress.current;
      try {
        explicitLogoutRequested = explicitLogoutRequested || window.localStorage.getItem("powerhub:explicit-logout") === "1";
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
        // A real Supabase session is enough to finish the bootstrap phase.
        // Do not wait for IndexedDB profile-cache reads to settle before letting
        // auth.me validate the session and the protected route proceed.
        setSessionReady(true);
        void getOfflineAuthUser<CachedAuthUser>(session.user.id).then((cached) => {
          if (!active || transitionRevision !== revision) return;
          if (cached) setCachedUser(cached);
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
    // Bound session-storage initialization as well: a stalled browser auth lock
    // should show the login route rather than an endless "redirecting" spinner.
    // If an auth event arrives while this read is pending, it is newer and wins;
    // a timeout fallback of null must never undo a successful SIGNED_IN event.
    const initialReadRevision = transitionRevision;
    void withTimeoutFallback(
      getSupabaseSession(),
      null,
      SESSION_BOOTSTRAP_TIMEOUT_MS,
    ).then((session) => {
      if (!active || transitionRevision !== initialReadRevision) return;
      const revision = ++transitionRevision;
      observedUserId = session?.user.id ?? null;
      setHasSession(Boolean(session));
      if (session) {
        setOfflineLeaseUserId(session.user.id);
        setSessionReady(true);
        void getOfflineAuthUser<CachedAuthUser>(session.user.id).then((cached) => {
          if (!active || transitionRevision !== revision) return;
          if (cached) setCachedUser(cached);
        });
      } else {
        void restoreOfflineUser(revision);
      }
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [queryClient]);

  useEffect(() => {
    const syncReachability = () => setPowerHubReachable(onlineManager.isOnline());
    syncReachability();
    return onlineManager.subscribe(syncReachability);
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
    explicitLogoutInProgress.current = true;
    setIsLoggingOut(true);
    queryClient.clear();
    setCachedUser(null);
    setOfflineLeaseUserId(null);
    try {
      window.localStorage.setItem("powerhub:explicit-logout", "1");
    } catch {
      // The in-memory flag still protects this logout when localStorage is blocked.
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
      explicitLogoutInProgress.current = false;
    }
  }, [releaseDevice, utils, queryClient]);

  // A cached user is useful for offline mode, but must never authorize the
  // online workspace before the current Supabase session has completed a live
  // auth.me check. This prevents protected tenant queries from racing the
  // login/session handshake and avoids transient 401/403 states in the UI.
  const meQueryErrorCode = (meQuery.error as { data?: { code?: string } } | null)?.data?.code;
  const meQueryAuthorizationDenied = meQueryErrorCode === "FORBIDDEN" ||
    (meQueryErrorCode === "UNAUTHORIZED" && !isSupabaseRefreshBackoffActive());
  const meQueryTemporarilyUnavailable = Boolean(meQuery.error && !meQueryAuthorizationDenied);
  const isOnlineAuthenticated = Boolean(
    hasSession &&
      !meQueryAuthorizationDenied &&
      (meQuery.isSuccess && meQuery.data || cachedUser || meQueryTemporarilyUnavailable),
  );
  const offlineAuthenticated = Boolean(
    !hasSession &&
      offlineLeaseUserId &&
      cachedUser &&
      !powerHubReachable,
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

  return {
    ...state,
    powerHubReachable,
    refresh: () => meQuery.refetch(),
    logout,
  };
}

type AuthContextValue = ReturnType<typeof useAuthController>;
const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const auth = useAuthController();
  return createElement(AuthContext.Provider, { value: auth }, children);
}

/**
 * All UI consumers share a single auth bootstrap and auth.me query. Optional
 * redirects stay local to the consumer, but never create another session state.
 */
export function useAuth(options?: UseAuthOptions): AuthContextValue {
  const auth = useContext(AuthContext);
  const { redirectOnUnauthenticated = false, redirectPath } = options ?? {};

  useEffect(() => {
    if (!auth || !redirectOnUnauthenticated) return;
    if (auth.loading || auth.user) return;
    if (typeof window === "undefined") return;
    if (redirectPath && window.location.pathname === redirectPath) return;

    // Do not treat transient API failures as logout. Confirm whether a valid
    // Supabase session remains before starting a new login flow.
    void getSupabaseSession().then(async (session) => {
      if (session) return;
      const lease = await getValidOfflineAuthLease();
      if (lease || !auth.powerHubReachable) return;

      if (redirectPath) window.location.href = redirectPath;
      else startLogin();
    });
  }, [
    auth?.loading,
    auth?.user,
    auth?.powerHubReachable,
    redirectOnUnauthenticated,
    redirectPath,
  ]);

  if (!auth) {
    throw new Error("useAuth must be used within AuthProvider.");
  }
  return auth;
}

async function supabaseSignOutSafely() {
  const { supabase } = await import("@/lib/supabase");
  // Logout is device-local by design: remove the current browser session
  // deterministically, without terminating other active devices.
  await supabase.auth.signOut({ scope: "local" });
}
