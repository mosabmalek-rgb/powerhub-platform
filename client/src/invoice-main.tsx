import { trpc } from "@/lib/trpc";
import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import { createRoot } from "react-dom/client";
import superjson from "superjson";
import PublicInvoiceApp from "./PublicInvoiceApp";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      networkMode: "offlineFirst",
      staleTime: 30_000,
      retry: false,
      refetchOnReconnect: false,
    },
  },
});

// Public invoice access is authorized by the opaque share token in PostgreSQL,
// not by the viewer's authenticated/offline session state.
onlineManager.setEventListener((setOnline) => {
  setOnline(true);
  return () => undefined;
});

const trpcClient = trpc.createClient({
  links: [
    httpBatchLink({
      url: "/api/trpc",
      transformer: superjson,
      async headers() {
        return {};
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

createRoot(document.getElementById("root")!).render(
  <trpc.Provider client={trpcClient} queryClient={queryClient}>
    <QueryClientProvider client={queryClient}>
      <PublicInvoiceApp />
    </QueryClientProvider>
  </trpc.Provider>,
);
