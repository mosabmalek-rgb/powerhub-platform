import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  isSupabaseSessionUsable,
  resolveOfflineAuthTransition,
  selectAuthSnapshot,
  shouldClearQueryCacheForAuthTransition,
  isOfflineCacheWriteCurrent,
  shouldRefreshSupabaseSession,
  SUPABASE_BROWSER_AUTH_OPTIONS,
} from "./offline-auth-state";

describe("offline authentication state transitions", () => {
  it("preserves the offline lease when the initial session is absent", () => {
    expect(resolveOfflineAuthTransition("INITIAL_SESSION", null, false)).toBe("recover-offline-session");
  });

  it("does not interpret a non-explicit missing session as a deliberate logout", () => {
    expect(resolveOfflineAuthTransition("SIGNED_OUT", null, false)).toBe("recover-offline-session");
  });

  it("clears offline access after an explicit logout", () => {
    expect(resolveOfflineAuthTransition("SIGNED_OUT", null, true)).toBe("explicit-sign-out");
  });

  it("does not restore an offline lease while an explicit logout is still being finalized", () => {
    expect(resolveOfflineAuthTransition("INITIAL_SESSION", null, true)).toBe("explicit-sign-out");
  });

  it("prefers a real online session when one is present", () => {
    expect(resolveOfflineAuthTransition("SIGNED_IN", "user-123", false)).toBe("online-session");
  });
});

describe("query-cache lifecycle across auth transitions", () => {
  it("preserves in-memory queries on a non-explicit transient sign-out", () => {
    expect(shouldClearQueryCacheForAuthTransition("SIGNED_OUT", false, true, null)).toBe(false);
  });

  it("clears queries after explicit logout", () => {
    expect(shouldClearQueryCacheForAuthTransition("SIGNED_OUT", true, true, null)).toBe(true);
  });

  it("clears queries when a different signed-in identity replaces the current user", () => {
    expect(shouldClearQueryCacheForAuthTransition("SIGNED_IN", false, true, "user-b")).toBe(true);
  });

  it("does not clear queries for a refresh event belonging to the same identity", () => {
    expect(shouldClearQueryCacheForAuthTransition("TOKEN_REFRESHED", false, false, "user-a")).toBe(false);
  });

  it("rejects a late cache write from the previous user generation", () => {
    expect(isOfflineCacheWriteCurrent("user-a", 4, "user-b", 5)).toBe(false);
  });

  it("allows cache writes only while both user identity and generation match", () => {
    expect(isOfflineCacheWriteCurrent("user-a", 4, "user-a", 4)).toBe(true);
    expect(isOfflineCacheWriteCurrent("user-a", 3, "user-a", 4)).toBe(false);
    expect(isOfflineCacheWriteCurrent("user-a", 4, null, 4)).toBe(false);
  });

  it("renders the app without waiting for offline bootstrap and does not overwrite live query data", () => {
    const main = readFileSync(new URL("../main.tsx", import.meta.url), "utf8");
    const cache = readFileSync(new URL("./offline-query-cache.ts", import.meta.url), "utf8");
    expect(main).toContain("renderApp();");
    expect(main).toContain("void bootstrapOfflineState();");
    expect(main).not.toContain("bootstrapOfflineState().finally(renderApp)");
    expect(main).toContain("isOfflineCacheWriteCurrent(");
    expect(cache).toContain("queryClient.getQueryData(queryKey) !== undefined");
    expect(cache).toContain("isStillCurrent: () => boolean = () => true");
  });
});

describe("auth session snapshot ordering", () => {
  it("does not let an older empty session snapshot erase a newer sign-in event", () => {
    expect(selectAuthSnapshot(null, "fresh-session", 4, 5)).toBe("fresh-session");
  });

  it("does not let an older session snapshot undo a newer sign-out event", () => {
    expect(selectAuthSnapshot("stale-session", null, 4, 5)).toBeNull();
  });

  it("accepts a session snapshot when no newer auth event occurred", () => {
    expect(selectAuthSnapshot(null, "old-session", 4, 4)).toBeNull();
  });
});


describe("Supabase browser session refresh policy", () => {
  it("keeps automatic refresh enabled with persisted sessions", () => {
    expect(SUPABASE_BROWSER_AUTH_OPTIONS).toEqual({
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    });
  });

  it("does not refresh a comfortably unexpired access token", () => {
    expect(shouldRefreshSupabaseSession(1_800, 1_000)).toBe(false);
  });

  it("refreshes an access token inside the 60-second safety window", () => {
    expect(shouldRefreshSupabaseSession(1_060, 1_000)).toBe(true);
    expect(shouldRefreshSupabaseSession(1_059, 1_000)).toBe(true);
  });

  it("refreshes expired or unbounded sessions instead of returning stale credentials", () => {
    expect(shouldRefreshSupabaseSession(999, 1_000)).toBe(true);
    expect(shouldRefreshSupabaseSession(undefined, 1_000)).toBe(true);
    expect(shouldRefreshSupabaseSession(null, 1_000)).toBe(true);
  });

  it("only treats a session as usable while its access token is unexpired", () => {
    expect(isSupabaseSessionUsable({ expires_at: 1_001 }, 1_000)).toBe(true);
    expect(isSupabaseSessionUsable({ expires_at: 1_000 }, 1_000)).toBe(false);
    expect(isSupabaseSessionUsable({ expires_at: 999 }, 1_000)).toBe(false);
    expect(isSupabaseSessionUsable({ expires_at: Number.NaN }, 1_000)).toBe(false);
    expect(isSupabaseSessionUsable(null, 1_000)).toBe(false);
  });
});


describe("Supabase browser refresh wiring", () => {
  it("uses the supported automatic refresh lifecycle in the actual browser client", () => {
    const source = readFileSync(new URL("./supabase.ts", import.meta.url), "utf8");
    expect(source).toContain("auth: { ...SUPABASE_BROWSER_AUTH_OPTIONS }");
    expect(source).not.toContain("autoRefreshToken: false");
    expect(source).not.toContain("scheduleSessionRefresh");
    expect(source).not.toContain("shouldRefreshSupabaseSession");
    expect(source).toContain("refreshExpiredSupabaseSession");
    expect(source).toContain("if (sessionInitialized && isSupabaseSessionUsable(currentSession, nowSeconds))");
    expect(source).toContain("if (!session || !isSupabaseSessionUsable(session)) return null;");
  });
});
