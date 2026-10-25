// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "./useAuth";

const mocks = vi.hoisted(() => ({
  useQuery: vi.fn(),
  invalidate: vi.fn(),
  setData: vi.fn(),
  getSession: vi.fn(),
  isRefreshBackoffActive: vi.fn(() => false),
  subscribe: vi.fn(),
  getLease: vi.fn(),
  getOfflineUser: vi.fn(),
  persistOfflineUser: vi.fn(),
  renewLease: vi.fn(),
  revokeLease: vi.fn(),
  releaseDevice: vi.fn(),
}));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ auth: { me: { invalidate: mocks.invalidate, setData: mocks.setData } } }),
    auth: {
      releaseDevice: { useMutation: () => ({ mutateAsync: mocks.releaseDevice }) },
      me: { useQuery: mocks.useQuery },
    },
  },
}));
vi.mock("@/lib/supabase", () => ({
  getSupabaseSession: mocks.getSession,
  isSupabaseRefreshBackoffActive: mocks.isRefreshBackoffActive,
  subscribeSupabaseAuthState: mocks.subscribe,
}));
vi.mock("@/lib/offline-auth", () => ({
  getValidOfflineAuthLease: mocks.getLease,
  renewOfflineAuthLease: mocks.renewLease,
  revokeOfflineAuthLease: mocks.revokeLease,
}));
vi.mock("@/lib/offline-query-cache", () => ({
  getOfflineAuthUser: mocks.getOfflineUser,
  persistOfflineAuthUser: mocks.persistOfflineUser,
}));

function Consumer({ label }: { label: string }) {
  const auth = useAuth();
  return <p>{label}: {auth.loading ? "checking" : auth.isAuthenticated ? "authenticated" : "anonymous"}</p>;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  onlineManager.setOnline(true);
});

describe("shared AuthProvider", () => {
  it("mounts one shared auth subscription for multiple page/layout consumers", async () => {
    mocks.useQuery.mockReturnValue({
      data: undefined,
      isPending: false,
      isSuccess: false,
      error: null,
      refetch: vi.fn(),
    });
    mocks.getSession.mockResolvedValue(null);
    mocks.subscribe.mockReturnValue(vi.fn());
    mocks.getLease.mockResolvedValue(null);
    mocks.getOfflineUser.mockResolvedValue(null);

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <Consumer label="workspace" />
          <Consumer label="dashboard-layout" />
          <Consumer label="route-gate" />
        </AuthProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText("workspace: anonymous")).toBeInTheDocument();
      expect(screen.getByText("dashboard-layout: anonymous")).toBeInTheDocument();
      expect(screen.getByText("route-gate: anonymous")).toBeInTheDocument();
    });
    // React may invoke a query hook again on rerender. The invariant is that
    // consumers do not mount additional independent Supabase auth subscriptions.
    expect(mocks.useQuery).toHaveBeenCalled();
    expect(mocks.subscribe).toHaveBeenCalledTimes(1);
    queryClient.clear();
  });

  it("updates all consumers together when a real session sign-in event arrives", async () => {
    let authListener: ((event: string, session: { user: { id: string } } | null) => void) | undefined;
    let queryData: { id: string; role: string } | undefined;
    mocks.useQuery.mockImplementation(() => ({
      data: queryData,
      isPending: false,
      isSuccess: Boolean(queryData),
      error: null,
      refetch: vi.fn(),
    }));
    mocks.getSession.mockResolvedValue(null);
    mocks.subscribe.mockImplementation((listener: typeof authListener) => {
      authListener = listener;
      return vi.fn();
    });
    mocks.getLease.mockResolvedValue(null);
    mocks.getOfflineUser.mockResolvedValue(null);

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <Consumer label="workspace" />
          <Consumer label="dashboard-layout" />
        </AuthProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText("workspace: anonymous")).toBeInTheDocument();
      expect(screen.getByText("dashboard-layout: anonymous")).toBeInTheDocument();
      expect(mocks.subscribe).toHaveBeenCalledTimes(1);
    });
    queryData = { id: "user-1", role: "user" };
    authListener?.("SIGNED_IN", { user: { id: "user-1" } });
    await waitFor(() => {
      expect(screen.getByText("workspace: authenticated")).toBeInTheDocument();
      expect(screen.getByText("dashboard-layout: authenticated")).toBeInTheDocument();
    });
    expect(mocks.useQuery).toHaveBeenCalled();
    expect(mocks.subscribe).toHaveBeenCalledTimes(1);
    queryClient.clear();
  });
  it("does not treat a transient auth.me network error as a signed-out session", async () => {
    mocks.useQuery.mockReturnValue({
      data: undefined,
      isPending: false,
      isSuccess: false,
      error: new Error("Failed to fetch"),
      refetch: vi.fn(),
    });
    mocks.getSession.mockResolvedValue({ user: { id: "user-1" } });
    mocks.subscribe.mockReturnValue(vi.fn());
    mocks.getLease.mockResolvedValue(null);
    mocks.getOfflineUser.mockResolvedValue(null);

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <Consumer label="workspace" />
        </AuthProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText("workspace: authenticated")).toBeInTheDocument();
    });
    queryClient.clear();
  });

  it("does not treat an unauthorized profile response as logout while a live session exists", async () => {
    const unauthorized = Object.assign(new Error("Unauthorized"), {
      data: { code: "UNAUTHORIZED" },
    });
    mocks.useQuery.mockReturnValue({
      data: undefined,
      isPending: false,
      isSuccess: false,
      isError: true,
      error: unauthorized,
      refetch: vi.fn(),
    });
    mocks.getSession.mockResolvedValue({ user: { id: "user-1" }, expires_at: Math.floor(Date.now() / 1000) + 300 });
    mocks.subscribe.mockReturnValue(vi.fn());
    mocks.getLease.mockResolvedValue(null);
    mocks.getOfflineUser.mockResolvedValue(null);

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <Consumer label="workspace" />
        </AuthProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText("workspace: checking")).toBeInTheDocument();
      expect(screen.queryByText("workspace: anonymous")).not.toBeInTheDocument();
    });
    queryClient.clear();
  });

});
