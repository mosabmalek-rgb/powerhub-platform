import { trpc } from "@/lib/trpc";
import { UNAUTHED_ERR_MSG } from '@shared/const';
import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import { httpBatchLink, TRPCClientError } from "@trpc/client";
import { createRoot } from "react-dom/client";
import superjson from "superjson";
import App from "./App";
import { startLogin } from "./const";
import { getSupabaseAccessToken, getSupabaseSession, subscribeSupabaseAuthState } from "./lib/supabase";
import { clearOfflineQueryCacheForUser, hydrateOfflineQueryCache, persistOfflineQuery } from "./lib/offline-query-cache";
import { probePowerHubConnectivity } from "./lib/offline-connectivity";
import { getPowerHubDeviceId, getValidOfflineAuthLease } from "./lib/offline-auth";
import "./index.css";

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
  let disposed = false;
  const verify = () => {
    void probePowerHubConnectivity().then((reachable) => {
      if (!disposed) setOnline(reachable);
    });
  };
  const handleOnline = () => verify();
  // Browser offline hints can be false positives; probe the application origin
  // before React Query pauses queries and mutations.
  const handleOffline = () => verify();
  window.addEventListener("online", handleOnline);
  window.addEventListener("offline", handleOffline);
  verify();
  return () => {
    disposed = true;
    window.removeEventListener("online", handleOnline);
    window.removeEventListener("offline", handleOffline);
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
  void getSupabaseSession().then((session) => {
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
    const session = await getSupabaseSession();
    if (session?.user.id) {
      activeOfflineUserId = session.user.id;
    } else {
      const offlineLease = await getValidOfflineAuthLease();
      activeOfflineUserId = offlineLease?.userId ?? null;
    }
    if (activeOfflineUserId) await hydrateOfflineQueryCache(queryClient, activeOfflineUserId);
  } catch (error) {
    console.warn("[PowerHub] Offline cache bootstrap skipped", error);
  }

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
}

function renderApp() {
  createRoot(document.getElementById("root")!).render(
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </trpc.Provider>
  );
}

void bootstrapOfflineState().finally(renderApp);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    // Versioned URL forces an immediate Service Worker update after changing
    // cache semantics, even when a legacy worker had cached /sw.js itself.
    void navigator.serviceWorker.register("/sw.js?v=6").catch((error) => console.warn("[PowerHub] Service Worker registration failed", error));
  });
}
