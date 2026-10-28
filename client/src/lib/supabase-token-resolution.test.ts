import { afterEach, describe, expect, it, vi } from "vitest";
import { createSupabaseAccessTokenResolver } from "./supabase-token-resolution";

type Session = {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  user: { id: string };
};

function session(token: string, expiry: number): Session {
  return { access_token: token, refresh_token: "test-refresh-token", expires_at: expiry, user: { id: "user-a" } };
}

function harness(initial: Session | null) {
  let current: Session | null = initial;
  let readError: Error | null = null;
  const now = vi.fn(() => 1_000_000); // 1,000 seconds.
  const getSupabaseSession = vi.fn(async () => current);
  const resolveLatestSession = vi.fn(async (_timeoutMs: number): Promise<Session | null> => current);
  const waitForAuthStateChange = vi.fn(async (_timeoutMs: number) => false);

  const getAccessToken = createSupabaseAccessTokenResolver<Session>({
    getCurrentSession: () => current,
    getSupabaseSession,
    resolveLatestSession: async (timeoutMs) => {
      const resolved = await resolveLatestSession(timeoutMs);
      if (resolved) current = resolved;
      return resolved;
    },
    waitForAuthStateChange,
    isUsable: (value) => Boolean(value && value.access_token && value.expires_at > Math.floor(now() / 1000)),
    shouldRefresh: (value) => value.expires_at <= Math.floor(now() / 1000) + 60,
    getLastSessionReadError: () => readError,
    now,
  });

  return {
    getAccessToken,
    getSupabaseSession,
    resolveLatestSession,
    waitForAuthStateChange,
    setCurrent: (value: Session | null) => { current = value; },
    getCurrent: () => current,
    setReadError: (value: Error | null) => { readError = value; },
  };
}

afterEach(() => vi.restoreAllMocks());

describe("refresh-aware async access-token resolution", () => {
  it("waits for a near-expiry session refresh instead of returning the old token", async () => {
    const oldSession = session("old-token", 1_059);
    const freshSession = session("fresh-token", 4_600);
    const h = harness(oldSession);
    h.resolveLatestSession.mockResolvedValueOnce(freshSession);

    await expect(h.getAccessToken()).resolves.toBe("fresh-token");
    expect(h.resolveLatestSession).toHaveBeenCalledTimes(1);
    expect(h.resolveLatestSession).toHaveBeenCalledWith(expect.any(Number));
  });

  it("deduplicates simultaneous header requests into one refresh operation", async () => {
    const oldSession = session("old-token", 1_059);
    const freshSession = session("fresh-token", 4_600);
    const h = harness(oldSession);
    let resolveRefresh!: (value: Session) => void;
    h.resolveLatestSession.mockImplementationOnce(() => new Promise<Session>((resolve) => { resolveRefresh = resolve; }));

    const first = h.getAccessToken();
    const second = h.getAccessToken();
    expect(second).toBe(first);
    expect(h.resolveLatestSession).toHaveBeenCalledTimes(1);
    resolveRefresh(freshSession);
    await expect(first).resolves.toBe("fresh-token");
  });

  it("falls back only to a token that is still valid and throttles repeated failed refreshes", async () => {
    const stillValid = session("still-valid-token", 1_030);
    const h = harness(stillValid);
    h.resolveLatestSession.mockRejectedValueOnce(new TypeError("temporary network failure"));

    await expect(h.getAccessToken()).resolves.toBe("still-valid-token");
    await expect(h.getAccessToken()).resolves.toBe("still-valid-token");
    expect(h.resolveLatestSession).toHaveBeenCalledTimes(1);
  });

  it("uses the stored still-valid session when a competing refresh produces an empty result", async () => {
    const winningSession = session("stored-winner-token", 1_030);
    const h = harness(winningSession);
    // auth-js' getSession path can return the still-valid stored session after
    // another tab wins a rotation; do not force another rotation from this tab.
    h.resolveLatestSession.mockResolvedValueOnce(winningSession);

    await expect(h.getAccessToken()).resolves.toBe("stored-winner-token");
    expect(h.resolveLatestSession).toHaveBeenCalledTimes(1);
    expect(h.getAccessToken.getDiagnostics().refreshBackoffActive).toBe(true);

    const [one, two, three] = await Promise.all([
      h.getAccessToken(),
      h.getAccessToken(),
      h.getAccessToken(),
    ]);
    expect([one, two, three]).toEqual([
      "stored-winner-token",
      "stored-winner-token",
      "stored-winner-token",
    ]);
    expect(h.resolveLatestSession).toHaveBeenCalledTimes(1);
  });

  it("never returns an expired token when refresh fails", async () => {
    const expired = session("expired-token", 999);
    const h = harness(expired);
    h.resolveLatestSession.mockRejectedValueOnce(Object.assign(new Error("deadline"), {
      name: "PowerHubSessionRefreshTimeoutError",
    }));

    await expect(h.getAccessToken()).rejects.toMatchObject({ name: "PowerHubSessionRefreshTimeoutError" });
  });

  it("uses a refreshed auth event published while the token refresh was failing", async () => {
    const expired = session("expired-token", 999);
    const fresh = session("refreshed-in-another-tab", 4_600);
    const h = harness(expired);
    h.resolveLatestSession.mockRejectedValueOnce(new TypeError("temporary transport failure"));
    h.waitForAuthStateChange.mockImplementationOnce(async () => {
      h.setCurrent(fresh);
      return true;
    });

    await expect(h.getAccessToken()).resolves.toBe("refreshed-in-another-tab");
  });

  it("returns null promptly when the SDK definitively confirms no session exists", async () => {
    const h = harness(null);

    await expect(h.getAccessToken()).resolves.toBeNull();
    expect(h.waitForAuthStateChange).not.toHaveBeenCalled();
    expect(h.resolveLatestSession).not.toHaveBeenCalled();
  });

  it("uses one bounded SDK refresh to restore a persisted session when memory is empty after an inconclusive read", async () => {
    const fresh = session("restored-from-storage-token", 4_600);
    const h = harness(null);
    h.getSupabaseSession.mockResolvedValueOnce(null); // The read cooldown is not proof that the user signed out.
    h.setReadError(Object.assign(new Error("previous storage read timed out"), { name: "PowerHubSessionReadTimeoutError" }));
    h.resolveLatestSession.mockImplementationOnce(async () => {
      h.setCurrent(fresh);
      return fresh;
    });

    await expect(h.getAccessToken()).resolves.toBe("restored-from-storage-token");
    expect(h.resolveLatestSession).toHaveBeenCalledTimes(1);
    expect(h.resolveLatestSession).toHaveBeenCalledWith(expect.any(Number));
  });

  it("waits for auth-state recovery after an inconclusive session-storage read", async () => {
    const fresh = session("restored-token", 4_600);
    const h = harness(null);
    h.getSupabaseSession.mockRejectedValueOnce(Object.assign(new Error("storage deadline"), {
      name: "PowerHubSessionReadTimeoutError",
    }));
    h.setReadError(Object.assign(new Error("storage deadline"), { name: "PowerHubSessionReadTimeoutError" }));
    h.waitForAuthStateChange.mockImplementationOnce(async () => {
      h.setCurrent(fresh);
      return true;
    });

    await expect(h.getAccessToken()).resolves.toBe("restored-token");
  });
});
