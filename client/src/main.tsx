import { trpc } from "@/lib/trpc";
import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import { createRoot } from "react-dom/client";
import { lazy, Suspense } from "react";
import superjson from "superjson";
const App = lazy(() => import("./App"));
import "./index.css";

const AuthProvider = lazy(() => import("@/_core/hooks/useAuth").then((module) => ({ default: module.AuthProvider })));
const OfflineDeltaSyncRuntime = lazy(() => import("./components/OfflineDeltaSyncRuntime").then((module) => ({ default: module.OfflineDeltaSyncRuntime })));

function isStandalonePublicInvoiceRoute(): boolean {
  return typeof window !== "undefined" && /^\/invoice\/[^/]+\/?$/.test(window.location.pathname);
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      networkMode: "offlineFirst",
      // Keep recently used tab data warm in memory to avoid a refetch on every route switch.
      // Mutations must invalidate the affected keys; sensitive access checks can opt out per query.
      staleTime: 30_000,
      refetchOnReconnect: true,
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

const trpcClient = trpc.createClient({
  links: [
    httpBatchLink({
      url: "/api/trpc",
      transformer: superjson,
      async headers() {
        // A public invoice lookup is authenticated by its unguessable share
        // token in PostgreSQL. Avoid unrelated session and device-ID reads for
        // this route; all protected pages keep their normal headers.
        if (isStandalonePublicInvoiceRoute()) return {};
        const [{ getSupabaseAccessToken }, { getPowerHubDeviceId }] = await Promise.all([
          import("./lib/supabase"),
          import("./lib/offline-auth"),
        ]);
        const token = await getSupabaseAccessToken();
        if (!token) {
          // Never turn a temporary token-refresh race into an unauthenticated
          // API request (which surfaces as Please login (10001) for every query).
          // Failed active queries are retried when the SDK confirms TOKEN_REFRESHED.
          throw new Error("PowerHub session is temporarily refreshing; request deferred.");
        }
        const deviceId = await getPowerHubDeviceId().catch(() => null);
        return {
          Authorization: `Bearer ${token}`,
          ...(deviceId ? { "x-powerhub-device-id": deviceId } : {}),
        };
      },
      fetch(input, init) {
        return globalThis.fetch(input, {
          ...(init ?? {}),
          credentials: "include",
        });
      },
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
    const [supabaseModule, offlineAuth, offlineCache, authState] = await Promise.all([
      import("./lib/supabase"),
      import("./lib/offline-auth"),
      import("./lib/offline-query-cache"),
      import("./lib/offline-auth-state"),
    ]);
    const { getSupabaseSession, subscribeSupabaseAuthState } = supabaseModule;
    const { getValidOfflineAuthLease } = offlineAuth;
    const { clearOfflineQueryCacheForUser, hydrateOfflineQueryCache, persistOfflineQuery } = offlineCache;
    const { isOfflineCacheWriteCurrent } = authState;

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

    // Subscribe before the initial read; a newer auth event always wins over
    // a delayed snapshot that might otherwise restore the wrong account.
    const initialRevision = authEventRevision;
    const session = await getSupabaseSession();
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
function renderApp() {
  const app = isStandalonePublicInvoiceRoute()
    ? <Suspense fallback={<div className="grid min-h-screen place-items-center bg-[#0D1117] text-slate-400">جارٍ تحميل الفاتورة…</div>}><App /></Suspense>
    : <Suspense fallback={<div className="grid min-h-screen place-items-center">جارٍ تهيئة الجلسة…</div>}><AuthProvider><Suspense fallback={null}><OfflineDeltaSyncRuntime /></Suspense><App /></AuthProvider></Suspense>;

  createRoot(document.getElementById("root")!).render(
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        {app}
      </QueryClientProvider>
    </trpc.Provider>
  );
}

// Render public invoice links immediately. Offline/auth cache bootstrap is
// unrelated to this public route and can wait several seconds on slow IndexedDB
// or Supabase session reads. Protected app routes preserve the existing order.
// Render immediately; cache/session hydration is an enhancement and must not
// hold the whole app behind a slow IndexedDB lock or Supabase session read.
renderApp();
if (!isStandalonePublicInvoiceRoute()) {
  void bootstrapOfflineState();
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    // Versioned URL forces an immediate Service Worker update after changing
    // cache semantics, even when a legacy worker had cached /sw.js itself.
    void navigator.serviceWorker.register("/sw.js?v=7").catch((error) => console.warn("[PowerHub] Service Worker registration failed", error));
  });
}
