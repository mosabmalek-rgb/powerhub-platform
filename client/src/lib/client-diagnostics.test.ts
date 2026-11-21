// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectSafeClientDiagnostics } from "./client-diagnostics";

vi.mock("./supabase", () => ({
  getSupabaseSessionDiagnostics: () => ({
    sessionInitialized: true,
    hasCurrentSession: true,
    hasAccessToken: true,
    tokenExpirySource: "jwt_exp",
    tokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
    tokenUsable: true,
    readInFlight: false,
    readBackoffActive: false,
    lastReadErrorName: null,
    lastReadErrorMessage: "raw refresh detail must never be copied",
    refreshInFlight: false,
    tokenResolution: {
      resolutionInFlight: false,
      refreshBackoffActive: false,
      lastRefreshErrorName: null,
    },
    authStateRevision: 4,
  }),
}));

vi.mock("./offline-connectivity", () => ({
  getPowerHubConnectivitySnapshot: () => null,
  probePowerHubConnectivity: vi.fn(async () => true),
}));

afterEach(() => {
  localStorage.removeItem("powerhub:device-id");
  localStorage.removeItem("sb-vvcdiqcyhaloxesvpppc-auth-token");
});

describe("safe client diagnostics", () => {
  it("summarizes browser storage and session state without exposing identifiers or stored values", async () => {
    const deviceId = "123e4567-e89b-42d3-a456-426614174000";
    localStorage.setItem("powerhub:device-id", deviceId);
    localStorage.setItem("sb-vvcdiqcyhaloxesvpppc-auth-token", "private-token-payload");

    const report = await collectSafeClientDiagnostics();
    const serialized = JSON.stringify(report);

    expect(report.schemaVersion).toBe(1);
    expect(report.storage.hasValidPersistedDeviceId).toBe(true);
    expect(report.storage.supabaseAuthStorageKeyCount).toBe(1);
    expect(report.auth).toMatchObject({
      available: true,
      sessionInitialized: true,
      hasCurrentSession: true,
      hasAccessToken: true,
      tokenUsable: true,
    });
    expect(report.connectivity).toMatchObject({ healthProbe: "reachable" });
    expect(report.privacy).toEqual({
      includesTokens: false,
      includesUserProfile: false,
      includesEmail: false,
      includesDeviceId: false,
      includesCacheRowsOrOutbox: false,
    });
    expect(serialized).not.toContain(deviceId);
    expect(serialized).not.toContain("private-token-payload");
    expect(serialized).not.toContain("raw refresh detail must never be copied");
    expect(serialized).not.toContain("userId");
    expect(serialized).not.toContain("email");
    expect(serialized).not.toContain("serializedData");
  });
});
