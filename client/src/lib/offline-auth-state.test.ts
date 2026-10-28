import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  isSupabaseSessionUsable,
  getSupabaseSessionExpirySeconds,
  isNonAuthoritativeInitialNullSessionEvent,
  isSessionReadBackoffActive,
  SUPABASE_SESSION_READ_ERROR_BACKOFF_MS,
  SUPABASE_SESSION_READ_TIMEOUT_MS,
  resolveOfflineAuthTransition,
  selectAuthSnapshot,
  shouldClearQueryCacheForAuthTransition,
  isOfflineCacheWriteCurrent,
  shouldRefreshSupabaseSession,
  SUPABASE_BROWSER_AUTH_OPTIONS,
  shouldValidateOnlineSession,
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

  it("restores the local query cache before mounting protected routes with a bounded startup gate", () => {
    const main = readFileSync(new URL("../main.tsx", import.meta.url), "utf8");
    const cache = readFileSync(new URL("./offline-query-cache.ts", import.meta.url), "utf8");
    expect(main).toContain("renderApp();");
    expect(main).toContain("Promise.race([bootstrapOfflineState(), deadline])");
    expect(main.indexOf("Promise.race([bootstrapOfflineState(), deadline])")).toBeLessThan(main.indexOf("<AuthProvider>"));
    expect(main).toContain("if (standalonePublicInvoice) return;");
    expect(main).not.toContain("bootstrapOfflineState().finally(renderApp)");
    expect(main).toContain("isOfflineCacheWriteCurrent(");
    expect(main).toContain("if (!token)");
    expect(main).toContain("if (getPowerHubConnectivitySnapshot() === false)");
    expect(main).toContain('event === "TOKEN_REFRESHED" && nextUserId');
    expect(main).toContain('query.state.status === "error"');
    expect(main).toContain('if (event === "INITIAL_SESSION")');
    expect(main).toContain("query.state.fetchStatus === \"fetching\"");
    expect(cache).toContain("queryClient.getQueryData(queryKey) !== undefined");
    expect(cache).toContain("isStillCurrent: () => boolean = () => true");
  });
});

describe("Supabase initial session event ordering", () => {
  it("ignores INITIAL_SESSION(null) as an authoritative sign-out", () => {
    expect(isNonAuthoritativeInitialNullSessionEvent("INITIAL_SESSION", null)).toBe(true);
    expect(isNonAuthoritativeInitialNullSessionEvent("SIGNED_OUT", null)).toBe(false);
    expect(isNonAuthoritativeInitialNullSessionEvent("INITIAL_SESSION", { user: { id: "user-a" } })).toBe(false);
  });

  it("filters the initial null before every auth consumer advances its startup revision", () => {
    const supabase = readFileSync(new URL("./supabase.ts", import.meta.url), "utf8");
    const main = readFileSync(new URL("../main.tsx", import.meta.url), "utf8");
    const auth = readFileSync(new URL("../_core/hooks/useAuth.ts", import.meta.url), "utf8");
    const cases = [
      { source: supabase, revision: "authStateRevision += 1;" },
      { source: main, revision: "authEventRevision += 1;" },
      { source: auth, revision: "const revision = ++transitionRevision;" },
    ];
    for (const item of cases) {
      const guard = item.source.indexOf("if (isNonAuthoritativeInitialNullSessionEvent(event, session))");
      expect(guard, "missing INITIAL_SESSION(null) guard").toBeGreaterThanOrEqual(0);
      expect(guard).toBeLessThan(item.source.indexOf(item.revision));
      expect(item.source.slice(guard, item.source.indexOf(item.revision))).toContain("return;");
    }
    expect(supabase.slice(supabase.indexOf("if (isNonAuthoritativeInitialNullSessionEvent(event, session))"), supabase.indexOf("authStateRevision += 1;"))).not.toContain("subscriber(event, session)");
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
  it("bounds repeated failed session reads with a deterministic cooldown", () => {
    expect(SUPABASE_SESSION_READ_TIMEOUT_MS).toBe(5_000);
    expect(SUPABASE_SESSION_READ_ERROR_BACKOFF_MS).toBe(15_000);
    expect(isSessionReadBackoffActive(20_000, 19_999)).toBe(true);
    expect(isSessionReadBackoffActive(20_000, 20_000)).toBe(false);
  });

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

  it("requires a non-empty access token and a future expiry", () => {
    expect(isSupabaseSessionUsable({ access_token: "valid.jwt.token", expires_at: 1_001 }, 1_000)).toBe(true);
    expect(isSupabaseSessionUsable({ access_token: "valid.jwt.token", expires_at: 1_000 }, 1_000)).toBe(false);
    expect(isSupabaseSessionUsable({ access_token: "valid.jwt.token", expires_at: 999 }, 1_000)).toBe(false);
    expect(isSupabaseSessionUsable({ access_token: "valid.jwt.token", expires_at: Number.NaN }, 1_000)).toBe(false);
    expect(isSupabaseSessionUsable({ expires_at: 1_001 }, 1_000)).toBe(false);
    expect(isSupabaseSessionUsable({ access_token: "", expires_at: 1_001 }, 1_000)).toBe(false);
    expect(isSupabaseSessionUsable(null, 1_000)).toBe(false);
  });

  it("uses one expiry source for explicit expires_at and JWT exp fallback", () => {
    const payload = btoa(JSON.stringify({ exp: 1_001 }));
    const session = { access_token: `header.${payload}.signature` };
    expect(getSupabaseSessionExpirySeconds({ access_token: "token", expires_at: 2_000 })).toBe(2_000);
    expect(getSupabaseSessionExpirySeconds(session)).toBe(1_001);
    expect(getSupabaseSessionExpirySeconds({ access_token: "opaque-token" })).toBeNull();
    expect(isSupabaseSessionUsable(session, 1_000)).toBe(true);
    expect(isSupabaseSessionUsable(session, 1_001)).toBe(false);
    expect(isSupabaseSessionUsable({ access_token: "opaque-token" }, 1_000)).toBe(false);
  });
});


describe("Supabase browser refresh wiring", () => {
  it("uses an awaited, single-flight refresh-aware token resolver in the actual browser client", () => {
    const source = readFileSync(new URL("./supabase.ts", import.meta.url), "utf8");
    const resolver = readFileSync(new URL("./supabase-token-resolution.ts", import.meta.url), "utf8");
    const main = readFileSync(new URL("../main.tsx", import.meta.url), "utf8");
    expect(source).toContain("auth: { ...SUPABASE_BROWSER_AUTH_OPTIONS }");
    expect(source).not.toContain("autoRefreshToken: false");
    expect(source).toContain("shouldRefreshSupabaseSession(getSupabaseSessionExpirySeconds(session))");
    expect(source).toContain("supabase.auth.getSession()");
    expect(source).not.toContain("supabase.auth.refreshSession(session)");
    expect(source).toContain("resolveLatestSupabaseSessionForAccessToken");
    expect(source).toContain("accessTokenRefreshInFlight");
    expect(source).toContain("previousSession");
    expect(source).toContain("accessTokenRefreshInFlight");
    expect(source).toContain("selectAuthSnapshot(sdkSession, currentSession, requestRevision, authStateRevision)");
    expect(source).toContain("function awaitSessionResolution(");
    expect(source).toContain("pending = sdkRead.finally(");
    expect(source).toContain("awaitSessionResolution(accessTokenRefreshInFlight, timeoutMs)");
    expect(source).not.toContain("supabase.auth.refreshSession(session)");
    expect(source).toContain("sessionReadInFlight = null;");
    expect(source).toContain("getSupabaseAccessToken(): Promise<string | null>");
    expect(source).toContain("createSupabaseAccessTokenResolver<Session>");
    expect(resolver).toContain("SUPABASE_ACCESS_TOKEN_RESOLUTION_TIMEOUT_MS = 7_500");
    expect(resolver).toContain("SUPABASE_SESSION_REFRESH_TIMEOUT_MS = 6_000");
    expect(resolver).toContain("if (refreshRetryAfter > now())");
    expect(resolver).toContain("if (stillValid) return stillValid");
    expect(resolver).toContain("expectedUserId && resolved?.user?.id !== expectedUserId");
    expect(resolver).toContain("PowerHubSessionIdentityChangedError");
    expect(resolver).toContain("PowerHubSessionRefreshTimeoutError");
    expect(main).toContain("await getSupabaseAccessToken()");
    expect(main.indexOf("deviceId = await getPowerHubDeviceId()")).toBeLessThan(main.indexOf("await getSupabaseAccessToken()"));
    const packageJson = readFileSync(new URL("../../../package.json", import.meta.url), "utf8");
    const lockfile = readFileSync(new URL("../../../pnpm-lock.yaml", import.meta.url), "utf8");
    expect(packageJson).toContain('"@supabase/supabase-js": "^2.117.2"');
    expect(lockfile).toContain("'@supabase/auth-js@2.117.2':");
    expect(lockfile).toContain("'@supabase/supabase-js@2.117.2':");
    expect(lockfile).not.toContain("'@supabase/auth-js@2.112.3':");
  });
});


describe("online auth validation readiness", () => {
  it("waits for the first reachability probe before starting auth.me", () => {
    expect(shouldValidateOnlineSession(true, true, true)).toBe(false);
    expect(shouldValidateOnlineSession(true, false, false)).toBe(false);
    expect(shouldValidateOnlineSession(false, true, false)).toBe(false);
    expect(shouldValidateOnlineSession(true, true, false)).toBe(true);
  });
});
