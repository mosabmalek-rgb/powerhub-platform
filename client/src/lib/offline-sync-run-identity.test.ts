import { describe, expect, it } from "vitest";
import {
  advanceOfflineSyncRunIdentity,
  assertOfflineSyncRunCurrent,
  isOfflineSyncRunCurrent,
  type OfflineSyncRunIdentitySnapshot,
} from "./offline-sync-run-identity";

const authenticated: OfflineSyncRunIdentitySnapshot = {
  userId: 7,
  siteId: 3,
  authUserId: 7,
  isLoggingOut: false,
  isOnlineAuthenticated: true,
};

describe("Outbox run identity", () => {
  it("keeps the generation stable when an unauthenticated session is still unresolved", () => {
    const unauthenticated = { ...authenticated, authUserId: null, isOnlineAuthenticated: false };
    const first = advanceOfflineSyncRunIdentity(null, unauthenticated);
    const rerendered = advanceOfflineSyncRunIdentity(first, { ...unauthenticated });
    expect(rerendered).toBe(first);
    expect(rerendered.generation).toBe(0);
  });

  it.each([
    ["user", { ...authenticated, userId: 8, authUserId: 8 }],
    ["site", { ...authenticated, siteId: 4 }],
    ["auth user", { ...authenticated, authUserId: 8 }],
    ["logout", { ...authenticated, isLoggingOut: true }],
    ["authentication", { ...authenticated, isOnlineAuthenticated: false }],
    ["session cleared", { ...authenticated, authUserId: null }],
  ])("invalidates a captured run after %s changes", (_label, changed) => {
    const owner = advanceOfflineSyncRunIdentity(null, authenticated);
    const current = advanceOfflineSyncRunIdentity(owner, changed);
    expect(current.generation).toBe(owner.generation + 1);
    expect(isOfflineSyncRunCurrent(owner, current)).toBe(false);
    expect(() => assertOfflineSyncRunCurrent(owner, current)).toThrowError(
      expect.objectContaining({ name: "PowerHubOfflineSyncRunSupersededError" }),
    );
  });

  it("allows local cache reads without an online auth lease but never allows network replay", () => {
    const owner = advanceOfflineSyncRunIdentity(null, { ...authenticated, isOnlineAuthenticated: false });
    const localRead = isOfflineSyncRunCurrent(owner, owner, false);
    const networkReplay = isOfflineSyncRunCurrent(owner, owner, true);
    expect(localRead).toBe(true);
    expect(networkReplay).toBe(false);
  });

  it("does not invalidate a run for an unchanged identity snapshot", () => {
    const owner = advanceOfflineSyncRunIdentity(null, authenticated);
    const current = advanceOfflineSyncRunIdentity(owner, authenticated);
    expect(current).toBe(owner);
    expect(isOfflineSyncRunCurrent(owner, current)).toBe(true);
  });
});
