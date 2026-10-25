import { trpc } from "@/lib/trpc";
import { UNAUTHED_ERR_MSG } from '@shared/const';
import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import { httpBatchLink, TRPCClientError } from "@trpc/client";
import { createRoot } from "react-dom/client";
import { lazy, Suspense } from "react";
import superjson from "superjson";
const App = lazy(() => import("./App"));
import { startLogin } from "./const";
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

const redirectToLoginIfUnauthorized = (error: unknown) => {
  if (!(error instanceof TRPCClientError)) return;
  if (typeof window === "undefined") return;

  const isUnauthorized = error.message === UNAUTHED_ERR_MSG;
  if (!isUnauthorized) return;

  // A request can race the first Supabase auth event immediately after login.
  // Do not redirect on that transient 401; only redirect after a fresh session
  // read confirms that the browser is genuinely unauthenticated.
  void import("./lib/supabase").then(({ getSupabaseSession }) => getSupabaseSession()).then((session) => {
    if (session) return;
    if (window.location.pathname !== "/login") window.location.assign("/login");
  });
};

queryClient.getQueryCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.query.state.error;
    redirectToLoginIfUnauthorized(error);
    console.error("[API Query Error]", error);
  }
});

queryClient.getMutationCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.mutation.state.error;
    redirectToLoginIfUnauthorized(error);
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
        const deviceId = await getPowerHubDeviceId().catch(() => null);
        return {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
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

async function bootstrapOfflineState() {
  try {
    // Keep offline-cache and auth-storage code out of the initial public-invoice
    // JavaScript bundle; only protected app routes need this module graph.
    const [supabaseModule, offlineAuth, offlineCache] = await Promise.all([
      import("./lib/supabase"),
      import("./lib/offline-auth"),
      import("./lib/offline-query-cache"),
    ]);
    const { getSupabaseSession, subscribeSupabaseAuthState } = supabaseModule;
    const { getValidOfflineAuthLease } = offlineAuth;
    const { clearOfflineQueryCacheForUser, hydrateOfflineQueryCache, persistOfflineQuery } = offlineCache;

    const session = await getSupabaseSession();
    if (session?.user.id) {
      activeOfflineUserId = session.user.id;
    } else {
      const offlineLease = await getValidOfflineAuthLease();
      activeOfflineUserId = offlineLease?.userId ?? null;
    }
    if (activeOfflineUserId) await hydrateOfflineQueryCache(queryClient, activeOfflineUserId);

    subscribeSupabaseAuthState((event, session) => {
      const previousUserId = activeOfflineUserId;
      const nextUserId = session?.user.id ?? null;

      if (event === "SIGNED_OUT") {
        let explicitLogout = false;
        try {
          explicitLogout = window.localStorage.getItem("powerhub:explicit-logout") === "1";
        } catch {
          // If storage is blocked, preserve the local cache; useAuth still revokes the lease.
        }

        if (explicitLogout) {
          queryClient.clear();
          if (previousUserId) void clearOfflineQueryCacheForUser(previousUserId);
          activeOfflineUserId = null;
          return;
        }

        // Supabase can emit SIGNED_OUT after a transient session loss. Preserve the
        // lease-scoped cache and restore it instead of treating that event as user intent.
        void getValidOfflineAuthLease().then(async (lease) => {
          if (!lease) {
            activeOfflineUserId = null;
            return;
          }
          activeOfflineUserId = lease.userId;
          await hydrateOfflineQueryCache(queryClient, lease.userId);
        });
        return;
      }

      // An initial null session can occur while offline. Keep the lease-scoped
      // cache in that case; only switch/clear when a real account is established.
      if (!nextUserId || nextUserId === previousUserId) return;

      queryClient.clear();
      if (previousUserId) void clearOfflineQueryCacheForUser(previousUserId);
      activeOfflineUserId = nextUserId;
      void hydrateOfflineQueryCache(queryClient, nextUserId);
    });

    queryClient.getQueryCache().subscribe((event) => {
      if (!activeOfflineUserId) return;
      if (event.type !== "updated" || event.action.type !== "success") return;
      void persistOfflineQuery(event.query, activeOfflineUserId);
    });
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
if (isStandalonePublicInvoiceRoute()) {
  renderApp();
} else {
  void bootstrapOfflineState().finally(renderApp);
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    // Versioned URL forces an immediate Service Worker update after changing
    // cache semantics, even when a legacy worker had cached /sw.js itself.
    void navigator.serviceWorker.register("/sw.js?v=7").catch((error) => console.warn("[PowerHub] Service Worker registration failed", error));
  });
}
