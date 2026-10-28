// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "./useAuth";

const mocks = vi.hoisted(() => ({
  useQuery: vi.fn(),
  powerHubReachable: true,
  powerHubConnectivityChecking: false,
  invalidate: vi.fn(),
  setData: vi.fn(),
  signOut: vi.fn(),
  clearOfflineQueryCache: vi.fn(),
  removeOfflineUser: vi.fn(),
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

vi.mock("@/lib/offline-connectivity", () => ({
  usePowerHubConnectivity: () => ({ isOnline: mocks.powerHubReachable, isChecking: mocks.powerHubConnectivityChecking }),
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
  supabase: { auth: { signOut: mocks.signOut } },
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
  clearOfflineQueryCacheForUser: mocks.clearOfflineQueryCache,
  getOfflineAuthUser: mocks.getOfflineUser,
  persistOfflineAuthUser: mocks.persistOfflineUser,
  removeOfflineAuthUser: mocks.removeOfflineUser,
}));

function Consumer({ label }: { label: string }) {
  const auth = useAuth();
  return <><p>{label}: {auth.loading ? "checking" : auth.isAuthenticated ? "authenticated" : "anonymous"}</p>{auth.error && <p>{label}: recoverable-auth-error</p>}<button type="button" onClick={() => void auth.refresh()}>retry authentication</button><button type="button" onClick={() => void auth.logout()}>logout authentication</button></>;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.signOut.mockReset();
  mocks.clearOfflineQueryCache.mockReset();
  mocks.removeOfflineUser.mockReset();
  mocks.powerHubReachable = true;
  mocks.powerHubConnectivityChecking = false;
  onlineManager.setOnline(true);
  vi.useRealTimers();
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

  it("keeps a known session stable across transient SIGNED_OUT and ends on a recovery screen", async () => {
    vi.useFakeTimers();
    let authListener: ((event: string, session: { user: { id: string } } | null) => void) | undefined;
    const liveSession = {
      user: { id: "user-1" },
      expires_at: Math.floor(Date.now() / 1000) + 300,
    };
    let sessionRead: typeof liveSession | null = liveSession;
    mocks.useQuery.mockReturnValue({
      data: { id: "user-1", role: "owner" },
      isPending: false,
      isSuccess: true,
      isError: false,
      error: null,
      refetch: vi.fn().mockResolvedValue({ data: { id: "user-1", role: "owner" } }),
    });
    mocks.getSession.mockImplementation(() => Promise.resolve(sessionRead));
    mocks.subscribe.mockImplementation((listener: typeof authListener) => {
      authListener = listener;
      return vi.fn();
    });
    mocks.getLease.mockResolvedValue(null);
    mocks.getOfflineUser.mockResolvedValue({ id: "user-1", role: "owner" });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <Consumer label="workspace" />
        </AuthProvider>
      </QueryClientProvider>,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("workspace: authenticated")).toBeInTheDocument();

    sessionRead = null;
    act(() => authListener?.("SIGNED_OUT", null));
    expect(screen.getByText("workspace: checking")).toBeInTheDocument();

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // A completed read returning null must finish recovery immediately rather
    // than leave the user on a spinner until the generic timeout.
    expect(screen.queryByText("workspace: checking")).not.toBeInTheDocument();
    expect(screen.getByText("workspace: recoverable-auth-error")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_001);
    });

    expect(screen.queryByText("workspace: checking")).not.toBeInTheDocument();
    expect(screen.getByText("workspace: anonymous")).toBeInTheDocument();
    expect(screen.getByText("workspace: recoverable-auth-error")).toBeInTheDocument();

    // Repeated SDK null events after the bounded recovery timeout must not restart
    // the checking/redirect loop.
    act(() => authListener?.("SIGNED_OUT", null));
    expect(screen.queryByText("workspace: checking")).not.toBeInTheDocument();
    expect(screen.getByText("workspace: recoverable-auth-error")).toBeInTheDocument();
    queryClient.clear();
  });

  it("allows an explicit retry to recover after a completed null-session failure", async () => {
    let authListener: ((event: string, session: { user: { id: string } } | null) => void) | undefined;
    const liveSession = {
      user: { id: "user-1" },
      expires_at: Math.floor(Date.now() / 1000) + 300,
    };
    let sessionRead: typeof liveSession | null = liveSession;
    mocks.useQuery.mockReturnValue({
      data: { id: "user-1", role: "owner" },
      isPending: false,
      isSuccess: true,
      isError: false,
      error: null,
      refetch: vi.fn().mockResolvedValue({ data: { id: "user-1", role: "owner" } }),
    });
    mocks.getSession.mockImplementation(() => Promise.resolve(sessionRead));
    mocks.subscribe.mockImplementation((listener: typeof authListener) => {
      authListener = listener;
      return vi.fn();
    });
    mocks.getLease.mockResolvedValue(null);
    mocks.getOfflineUser.mockResolvedValue({ id: "user-1", role: "owner" });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <Consumer label="workspace" />
        </AuthProvider>
      </QueryClientProvider>,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("workspace: authenticated")).toBeInTheDocument();

    sessionRead = null;
    act(() => authListener?.("SIGNED_OUT", null));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("workspace: recoverable-auth-error")).toBeInTheDocument();
    expect(screen.queryByText("workspace: checking")).not.toBeInTheDocument();
    const readsBeforeRetry = mocks.getSession.mock.calls.length;

    sessionRead = liveSession;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "retry authentication" }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.getSession.mock.calls.length).toBeGreaterThan(readsBeforeRetry);
    expect(screen.getByText("workspace: authenticated")).toBeInTheDocument();
    expect(screen.queryByText("workspace: recoverable-auth-error")).not.toBeInTheDocument();
    queryClient.clear();
  });

  it("waits for the first PowerHub connectivity result before deciding an offline lease is unauthenticated", async () => {
    mocks.powerHubReachable = true;
    mocks.powerHubConnectivityChecking = true;
    mocks.useQuery.mockReturnValue({
      data: undefined,
      isPending: false,
      isSuccess: false,
      isError: false,
      error: null,
      refetch: vi.fn().mockResolvedValue({ data: undefined }),
    });
    mocks.getSession.mockResolvedValue(null);
    mocks.subscribe.mockReturnValue(vi.fn());
    mocks.getLease.mockResolvedValue({
      userId: "user-1",
      issuedAt: Date.now() - 60_000,
      expiresAt: Date.now() + 60_000,
    });
    mocks.getOfflineUser.mockResolvedValue({ id: "user-1", role: "owner" });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <Consumer label="workspace" />
        </AuthProvider>
      </QueryClientProvider>,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("workspace: checking")).toBeInTheDocument();

    mocks.powerHubReachable = false;
    mocks.powerHubConnectivityChecking = false;
    await act(async () => {
      view.rerender(
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <Consumer label="workspace" />
          </AuthProvider>
        </QueryClientProvider>,
      );
      await Promise.resolve();
    });

    expect(screen.getByText("workspace: authenticated")).toBeInTheDocument();
    expect(screen.queryByText("workspace: anonymous")).not.toBeInTheDocument();
    queryClient.clear();
  });

  it("ends the local session and clears persisted user cache on explicit logout", async () => {
    let authListener: ((event: string, session: { user: { id: string } } | null) => void) | undefined;
    const liveSession = {
      user: { id: "user-1" },
      expires_at: Math.floor(Date.now() / 1000) + 300,
    };
    mocks.useQuery.mockReturnValue({
      data: { id: "user-1", role: "owner" },
      isPending: false,
      isSuccess: true,
      isError: false,
      error: null,
      refetch: vi.fn().mockResolvedValue({ data: null }),
    });
    mocks.getSession.mockResolvedValue(liveSession);
    mocks.subscribe.mockImplementation((listener: typeof authListener) => {
      authListener = listener;
      return vi.fn();
    });
    mocks.getLease.mockResolvedValue({ userId: "user-1", issuedAt: 1, expiresAt: Date.now() + 60_000 });
    mocks.getOfflineUser.mockResolvedValue({ id: "user-1", role: "owner" });
    mocks.releaseDevice.mockResolvedValue(undefined);
    mocks.signOut.mockImplementation(async () => {
      authListener?.("SIGNED_OUT", null);
      return { error: null };
    });
    mocks.revokeLease.mockResolvedValue(undefined);
    mocks.clearOfflineQueryCache.mockResolvedValue(undefined);
    mocks.removeOfflineUser.mockResolvedValue(undefined);

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <Consumer label="workspace" />
        </AuthProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText("workspace: authenticated")).toBeInTheDocument());

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "logout authentication" }));
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mocks.clearOfflineQueryCache).toHaveBeenCalledWith("user-1");
      expect(mocks.removeOfflineUser).toHaveBeenCalledWith("user-1");
    });

    expect(mocks.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(mocks.revokeLease).toHaveBeenCalled();
    expect(mocks.clearOfflineQueryCache).toHaveBeenCalledWith("user-1");
    expect(mocks.removeOfflineUser).toHaveBeenCalledWith("user-1");
    expect(screen.getByText("workspace: anonymous")).toBeInTheDocument();
    expect(window.localStorage.getItem("powerhub:explicit-logout")).toBeNull();
    queryClient.clear();
  });

  it("breaks the endless session-check loading state and offers recovery when auth.me never settles", async () => {
    vi.useFakeTimers();
    mocks.useQuery.mockReturnValue({
      data: undefined,
      isPending: true,
      isSuccess: false,
      isError: false,
      error: null,
      refetch: vi.fn().mockResolvedValue({ data: undefined }),
    });
    mocks.getSession.mockResolvedValue({
      user: { id: "user-1" },
      expires_at: Math.floor(Date.now() / 1000) + 300,
    });
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

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("workspace: checking")).toBeInTheDocument();

    await act(async () => {
      // Match the production auth.me deadline and advance beyond it.
      await vi.advanceTimersByTimeAsync(18_001);
    });

    expect(screen.getByText("workspace: authenticated")).toBeInTheDocument();
    expect(screen.getByText("workspace: recoverable-auth-error")).toBeInTheDocument();
    expect(screen.queryByText("workspace: checking")).not.toBeInTheDocument();
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
