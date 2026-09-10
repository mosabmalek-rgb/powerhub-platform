import { trpc } from "@/lib/trpc";
import { UNAUTHED_ERR_MSG } from '@shared/const';
import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import { httpBatchLink, TRPCClientError } from "@trpc/client";
import { createRoot } from "react-dom/client";
import superjson from "superjson";
import App from "./App";
import { startLogin } from "./const";
import { getSupabaseAccessToken, getSupabaseSession, supabase } from "./lib/supabase";
import { hydrateOfflineQueryCache, persistOfflineQuery } from "./lib/offline-query-cache";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      networkMode: "offlineFirst",
      refetchOnReconnect: true,
    },
  },
});

onlineManager.setEventListener((setOnline) => {
  if (typeof window === "undefined") return () => undefined;
  const handleOnline = () => setOnline(true);
  const handleOffline = () => setOnline(false);
  window.addEventListener("online", handleOnline);
  window.addEventListener("offline", handleOffline);
  return () => {
    window.removeEventListener("online", handleOnline);
    window.removeEventListener("offline", handleOffline);
  };
});

const redirectToLoginIfUnauthorized = (error: unknown) => {
  if (!(error instanceof TRPCClientError)) return;
  if (typeof window === "undefined") return;

  const isUnauthorized = error.message === UNAUTHED_ERR_MSG;

  if (!isUnauthorized) return;

  startLogin();
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
        return token ? { Authorization: `Bearer ${token}` } : {};
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
    activeOfflineUserId = session?.user.id ?? null;
    if (activeOfflineUserId) await hydrateOfflineQueryCache(queryClient, activeOfflineUserId);
  } catch (error) {
    console.warn("[PowerHub] Offline cache bootstrap skipped", error);
  }

  supabase.auth.onAuthStateChange((event, session) => {
    const nextUserId = session?.user.id ?? null;
    if (nextUserId === activeOfflineUserId) return;

    queryClient.clear();
    activeOfflineUserId = nextUserId;
    if (activeOfflineUserId) void hydrateOfflineQueryCache(queryClient, activeOfflineUserId);

    if (event === "SIGNED_OUT") activeOfflineUserId = null;
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
    void navigator.serviceWorker.register("/sw.js?v=3").catch((error) => console.warn("[PowerHub] Service Worker registration failed", error));
  });
}
