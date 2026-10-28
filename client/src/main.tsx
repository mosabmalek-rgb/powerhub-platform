import { trpc } from "@/lib/trpc";
import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import { getOfflineQueryStaleTime, isDeltaSyncBackedQueryKey } from "./lib/offline-query-policy";
import { isNonAuthoritativeInitialNullSessionEvent } from "./lib/offline-auth-state";
import { httpBatchLink, httpLink, splitLink } from "@trpc/client";
import { createRoot } from "react-dom/client";
import { lazy, Suspense, useEffect, useState } from "react";
import superjson from "superjson";
const App = lazy(() => import("./App"));
import "./index.css";

const AuthProvider = lazy(() => import("@/_core/hooks/useAuth").then((module) => ({ default: module.AuthProvider })));
const OfflineDeltaSyncRuntime = lazy(() => import("./components/OfflineDeltaSyncRuntime").then((module) => ({ default: module.OfflineDeltaSyncRuntime })));
const OfflineDeviceBootstrapRuntime = lazy(() => import("./components/OfflineDeviceBootstrapRuntime").then((module) => ({ default: module.OfflineDeviceBootstrapRuntime })));

function isStandalonePublicInvoiceRoute(): boolean {
  return typeof window !== "undefined" && /^\/invoice\/[^/]+\/?$/.test(window.location.pathname);
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      networkMode: "offlineFirst",
      // Keep recently used tab data warm in memory to avoid a refetch on every route switch.
      // Mutations must invalidate the affected keys; sensitive access checks can opt out per query.
      // Delta-backed queries are reconciled by the shared Delta runtime, not by re-fetching full pages.
      staleTime: (query) => getOfflineQueryStaleTime(query.queryKey),
      refetchOnReconnect: (query) => !isDeltaSyncBackedQueryKey(query.queryKey),
      refetchOnWindowFocus: (query) => !isDeltaSyncBackedQueryKey(query.queryKey),
    },
  },
});

onlineManager.setEventListener((setOnline) => {
  if (typeof window === "undefined") return () => undefined;
  // The online manager must reflect the browser's actual network hint, not a
  // single health-endpoint request. A cold start or a temporary /api/health
  // failure must not pause every query and mutation indefinitely.
  if (isStandalonePublicInvoiceRoute()) {
    setOnline(true);
    return () => undefined;
  }
  let disposed = false;
  const syncBrowserNetwork = () => {
    if (!disposed) setOnline(typeof navigator === "undefined" || navigator.onLine !== false);
  };
  window.addEventListener("online", syncBrowserNetwork);
  window.addEventListener("offline", syncBrowserNetwork);
  syncBrowserNetwork();
  return () => {
    disposed = true;
    window.removeEventListener("online", syncBrowserNetwork);
    window.removeEventListener("offline", syncBrowserNetwork);
  };
});

queryClient.getQueryCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.query.state.error;
    console.error("[API Query Error]", error);
  }
});

queryClient.getMutationCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.mutation.state.error;
    console.error("[API Mutation Error]", error);
  }
});

async function resolvePowerHubTRPCHeaders() {
  if (isStandalonePublicInvoiceRoute()) return {};
  const [{ getSupabaseAccessToken, getSupabaseSessionDiagnostics }, { getPowerHubDeviceId }, { getPowerHubConnectivitySnapshot, getPowerHubClockDiagnostics, POWERHUB_DEVICE_CLOCK_SKEW_USER_MESSAGE }] = await Promise.all([
    import("./lib/supabase"),
    import("./lib/offline-auth"),
    import("./lib/offline-connectivity"),
  ]);
  const clock = getPowerHubClockDiagnostics();
  if (clock.skewDetected) {
    const error = new Error(POWERHUB_DEVICE_CLOCK_SKEW_USER_MESSAGE);
    error.name = "PowerHubDeviceClockSkewError";
    Object.assign(error, { deviceClockSkewMs: clock.localMinusServerMs, deviceClockSkewThresholdMs: clock.thresholdMs });
    throw error;
  }
  if (getPowerHubConnectivitySnapshot() === false) {
    const error = new Error("The PowerHub origin is repeatedly unreachable.");
    error.name = "PowerHubConnectivityUnresolvedError";
    throw error;
  }
  let deviceId: string;
  try {
    deviceId = await getPowerHubDeviceId();
  } catch {
    const error = new Error("PowerHub could not resolve the current device identity.");
    error.name = "PowerHubDeviceIdentityUnavailableError";
    throw error;
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deviceId)) {
    const error = new Error("PowerHub produced an invalid device identity.");
    error.name = "PowerHubDeviceIdentityUnavailableError";
    throw error;
  }
  let token: string | null;
  const tokenResolutionStartedAt = performance.now();
  try {
    token = await getSupabaseAccessToken();
  } catch (cause) {
    const diagnostics = getSupabaseSessionDiagnostics();
    const safeDiagnostics = {
      sessionInitialized: diagnostics.sessionInitialized,
      hasCurrentSession: diagnostics.hasCurrentSession,
      hasAccessToken: diagnostics.hasAccessToken,
      tokenExpirySource: diagnostics.tokenExpirySource,
      tokenUsable: diagnostics.tokenUsable,
      readInFlight: diagnostics.readInFlight,
      readBackoffActive: diagnostics.readBackoffActive,
      lastReadErrorName: diagnostics.lastReadErrorName,
      refreshInFlight: diagnostics.refreshInFlight,
      tokenResolution: diagnostics.tokenResolution,
      authStateRevision: diagnostics.authStateRevision,
    };
    console.warn("[PowerHub client auth bootstrap failure]", {
      stage: "access-token-resolution",
      elapsedMs: Math.round(performance.now() - tokenResolutionStartedAt),
      errorName: cause instanceof Error ? cause.name : "UnknownError",
      ...safeDiagnostics,
    });
    const error = new Error("PowerHub could not finish Supabase access-token resolution.");
    error.name = cause instanceof Error ? cause.name : "PowerHubSessionTokenUnavailableError";
    Object.assign(error, { cause, tokenResolution: safeDiagnostics });
    throw error;
  }
  if (!token) {
    const diagnostics = getSupabaseSessionDiagnostics();
    const error = new Error("PowerHub could not obtain a usable Supabase access token.");
    error.name = "PowerHubSessionTokenUnavailableError";
    Object.assign(error, {
      authStage: !diagnostics.hasCurrentSession ? "session_absent"
        : !diagnostics.hasAccessToken ? "access_token_absent"
          : !diagnostics.tokenUsable ? "access_token_expired_or_unreadable"
            : "session_unresolved",
      sessionInitialized: diagnostics.sessionInitialized,
      tokenExpirySource: diagnostics.tokenExpirySource,
      tokenExpiresAt: diagnostics.tokenExpiresAt,
      tokenUsable: diagnostics.tokenUsable,
      readInFlight: diagnostics.readInFlight,
      readBackoffActive: diagnostics.readBackoffActive,
      lastReadErrorName: diagnostics.lastReadErrorName,
      refreshInFlight: diagnostics.refreshInFlight,
      tokenResolution: diagnostics.tokenResolution,
      authStateRevision: diagnostics.authStateRevision,
    });
    throw error;
  }
  return {
    Authorization: `Bearer ${token}`,
    "x-powerhub-device-id": deviceId,
  };
}

async function powerHubTRPCFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const isAuthMe = requestUrl.includes("/api/trpc/auth.me");
  const startedAt = performance.now();
  try {
    const response = await globalThis.fetch(input, { ...(init ?? {}), credentials: "include" });
    const elapsedMs = Math.round(performance.now() - startedAt);
    if (isAuthMe && (!response.ok || elapsedMs >= 1_000)) {
      console.warn("[PowerHub auth.me transport]", {
        stage: "http-response",
        status: response.status,
        elapsedMs,
      });
    }
    return response;
  } catch (cause) {
    if (isAuthMe) {
      console.warn("[PowerHub auth.me transport]", {
        stage: "network-failure",
        elapsedMs: Math.round(performance.now() - startedAt),
        errorName: cause instanceof Error ? cause.name : "UnknownError",
      });
    }
    throw cause;
  }
}

const trpcClient = trpc.createClient({
  links: [
    splitLink({
      // auth.me is the bootstrap gate: never let an unrelated data query in the
      // initial batch delay session validation.
      condition: (op) => op.path === "auth.me",
      true: httpLink({
        url: "/api/trpc",
        transformer: superjson,
        headers: resolvePowerHubTRPCHeaders,
        fetch: powerHubTRPCFetch,
      }),
      false: httpBatchLink({
        url: "/api/trpc",
        transformer: superjson,
        headers: resolvePowerHubTRPCHeaders,
        fetch: powerHubTRPCFetch,
      }),
    }),
  ],
});

let activeOfflineUserId: string | null = null;
let activeOfflineGeneration = 0;
const offlineQueryOwners = new WeakMap<object, { userId: string; generation: number }>();

async function bootstrapOfflineState() {
  try {
    // Storage hydration is deliberately non-blocking: the authenticated shell
    // and its live queries must render even if IndexedDB/Supabase initialization stalls.
    const [supabaseModule, offlineAuth, offlineCache, authState, connectivity] = await Promise.all([
      import("./lib/supabase"),
      import("./lib/offline-auth"),
      import("./lib/offline-query-cache"),
      import("./lib/offline-auth-state"),
      import("./lib/offline-connectivity"),
    ]);
    const { getSupabaseSession, subscribeSupabaseAuthState } = supabaseModule;
    const { getValidOfflineAuthLease } = offlineAuth;
    const { clearOfflineQueryCacheForUser, hydrateOfflineQueryCache, persistOfflineQuery } = offlineCache;
    const { isOfflineCacheWriteCurrent } = authState;
    const { probePowerHubConnectivity } = connectivity;

    const activateUser = async (nextUserId: string | null) => {
      if (nextUserId === activeOfflineUserId) return;
      const previousUserId = activeOfflineUserId;
      activeOfflineGeneration += 1;
      activeOfflineUserId = nextUserId;

      if (previousUserId && previousUserId !== nextUserId) {
        // Invalidate in-flight query ownership before cancellation/clearing. A
        // late response from the previous account must never be stored for the next.
        void queryClient.cancelQueries();
        queryClient.clear();
        void clearOfflineQueryCacheForUser(previousUserId);
      }
      if (nextUserId) {
        const hydrationGeneration = activeOfflineGeneration;
        await hydrateOfflineQueryCache(
          queryClient,
          nextUserId,
          Date.now(),
          () => activeOfflineUserId === nextUserId && activeOfflineGeneration === hydrationGeneration,
        );

        // Queries may finish before the asynchronous bootstrap subscription is
        // installed. Persist confirmed live results and attach ownership to any
        // still-fetching query so the first load also seeds the offline snapshot.
        const owner = { userId: nextUserId, generation: hydrationGeneration };
        for (const query of queryClient.getQueryCache().getAll()) {
          if (!isOfflineCacheWriteCurrent(
            owner.userId,
            owner.generation,
            activeOfflineUserId,
            activeOfflineGeneration,
          )) break;
          if (query.state.fetchStatus === "fetching") {
            offlineQueryOwners.set(query, owner);
          } else if (query.state.status === "success" && query.state.data !== undefined) {
            void persistOfflineQuery(query, nextUserId);
          }
        }
      }
    };

    // Bind each fetch to the identity that started it, not the identity active
    // when it eventually resolves. WeakMap keys use query objects, not query hashes,
    // because an old and a new account can issue the same query key concurrently.
    queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== "updated") return;
      const queryIdentity = event.query;
      if (event.action.type === "fetch") {
        if (activeOfflineUserId) {
          offlineQueryOwners.set(queryIdentity, {
            userId: activeOfflineUserId,
            generation: activeOfflineGeneration,
          });
        } else {
          offlineQueryOwners.delete(queryIdentity);
        }
        return;
      }
      if (event.action.type === "error") {
        offlineQueryOwners.delete(queryIdentity);
        return;
      }
      if (event.action.type !== "success") return;
      const owner = offlineQueryOwners.get(queryIdentity);
      offlineQueryOwners.delete(queryIdentity);
      if (!owner || !isOfflineCacheWriteCurrent(
        owner.userId,
        owner.generation,
        activeOfflineUserId,
        activeOfflineGeneration,
      )) return;
      void persistOfflineQuery(event.query, owner.userId);
    });

    let authEventRevision = 0;
    subscribeSupabaseAuthState((event, session) => {
      // INITIAL_SESSION(null) is not authoritative. Do not let it invalidate
      // the independent getSession() bootstrap revision below.
      if (isNonAuthoritativeInitialNullSessionEvent(event, session)) return;
      authEventRevision += 1;
      const eventRevision = authEventRevision;
      const previousUserId = activeOfflineUserId;
      const nextUserId = session?.user.id ?? null;

      if (event === "TOKEN_REFRESHED" && nextUserId) {
        // Requests that were deferred or failed during refresh must recover as
        // soon as Supabase confirms a fresh token; do not leave dashboard data
        // in an error state until a manual page reload.
        void queryClient.refetchQueries({
          type: "active",
          predicate: (query) => query.state.status === "error",
        });
      }

      if (event === "SIGNED_OUT") {
        let explicitLogout = false;
        try {
          explicitLogout = window.localStorage.getItem("powerhub:explicit-logout") === "1";
        } catch {
          // If storage is blocked, useAuth retains its in-memory logout intent.
        }

        if (explicitLogout) {
          activeOfflineGeneration += 1;
          activeOfflineUserId = null;
          queryClient.clear();
          if (previousUserId) void clearOfflineQueryCacheForUser(previousUserId);
          return;
        }

        // A transient SDK SIGNED_OUT is not proof of user intent. Preserve the
        // current cache while checking the signed local offline lease.
        void getValidOfflineAuthLease().then(async (lease) => {
          if (authEventRevision !== eventRevision) return;
          // No lease means there is no authorization to restore, but it does
          // not turn a transient SDK event into explicit logout. Keep the
          // existing in-memory snapshot; only a verified lease can switch scope.
          if (lease) await activateUser(lease.userId);
        });
        return;
      }

      if (!nextUserId) {
        // Supabase can emit INITIAL_SESSION(null) after this listener is
        // attached. If that races the initial getSession() read, this event
        // must still restore the valid offline lease rather than leaving the
        // local cache uninitialized forever.
        if (event === "INITIAL_SESSION") {
          void getValidOfflineAuthLease().then(async (lease) => {
            if (authEventRevision !== eventRevision) return;
            await activateUser(lease?.userId ?? null);
          });
        }
        return;
      }
      if (nextUserId === activeOfflineUserId) return;
      void activateUser(nextUserId);
    });

    // Subscribe before both reads so a newer auth event always wins. Race the
    // bounded SDK session read with origin reachability: an offline browser
    // should hydrate its lease/cache without waiting for session recovery.
    const initialRevision = authEventRevision;
    const sessionRead = getSupabaseSession();
    const reachabilityRead = probePowerHubConnectivity();
    const firstResult = await Promise.race([
      sessionRead.then((session) => ({ kind: "session" as const, session })),
      reachabilityRead.then((reachable) => ({ kind: "reachability" as const, reachable })),
    ]);

    if (firstResult.kind === "reachability" && !firstResult.reachable) {
      const offlineLease = await getValidOfflineAuthLease();
      if (initialRevision !== authEventRevision) return;
      await activateUser(offlineLease?.userId ?? null);
      // If an online session resolves later, reconcile it only if no newer auth
      // event has superseded this startup snapshot.
      void sessionRead.then((session) => {
        if (!session?.user.id || authEventRevision !== initialRevision) return;
        void activateUser(session.user.id);
      }).catch(() => undefined);
      return;
    }

    const session = firstResult.kind === "session" ? firstResult.session : await sessionRead;
    if (initialRevision !== authEventRevision) return;
    if (session?.user.id) {
      await activateUser(session.user.id);
      return;
    }
    const offlineLease = await getValidOfflineAuthLease();
    if (initialRevision !== authEventRevision) return;
    await activateUser(offlineLease?.userId ?? null);
  } catch (error) {
    console.warn("[PowerHub] Offline cache bootstrap skipped", error);
  }
}
const OFFLINE_BOOTSTRAP_DEADLINE_MS = 6_000;

function AppBootstrapGate() {
  const standalonePublicInvoice = isStandalonePublicInvoiceRoute();
  const [localBootstrapReady, setLocalBootstrapReady] = useState(standalonePublicInvoice);

  useEffect(() => {
    if (standalonePublicInvoice) return;
    let active = true;
    let timeoutId: number | undefined;
    const deadline = new Promise<void>((resolve) => {
      timeoutId = window.setTimeout(resolve, OFFLINE_BOOTSTRAP_DEADLINE_MS);
    });

    void Promise.race([bootstrapOfflineState(), deadline]).finally(() => {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      if (active) setLocalBootstrapReady(true);
    });

    return () => {
      active = false;
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    };
  }, [standalonePublicInvoice]);

  if (!localBootstrapReady) {
    return <main className="grid min-h-screen place-items-center bg-[#0D1117] px-5 text-center" dir="rtl" role="status" aria-live="polite">
      <div><p className="text-sm font-bold text-[#F5B800]">PowerHub</p><p className="mt-3 text-sm text-slate-300">جارٍ استعادة جلسة العمل والبيانات المحفوظة…</p></div>
    </main>;
  }

  return standalonePublicInvoice
    ? <Suspense fallback={<div className="grid min-h-screen place-items-center bg-[#0D1117] text-slate-400">جارٍ تحميل الفاتورة…</div>}><App /></Suspense>
    : <Suspense fallback={<div className="grid min-h-screen place-items-center">جارٍ تهيئة الجلسة…</div>}><AuthProvider><Suspense fallback={null}><OfflineDeltaSyncRuntime /><OfflineDeviceBootstrapRuntime /></Suspense><App /></AuthProvider></Suspense>;
}

function renderApp() {
  createRoot(document.getElementById("root")!).render(
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <AppBootstrapGate />
      </QueryClientProvider>
    </trpc.Provider>
  );
}

// Public invoice links remain immediate. Protected application routes restore
// the local cache before mounting route-level queries, with a bounded fallback.
renderApp();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    // Versioned URL forces an immediate Service Worker update after changing
    // cache semantics, even when a legacy worker had cached /sw.js itself.
    void navigator.serviceWorker.register("/sw.js?v=8").catch((error) => console.warn("[PowerHub] Service Worker registration failed", error));
  });
}
