// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { readCachedTenantAccess, writeCachedTenantAccess } from "./tenant-access-cache";

afterEach(() => window.sessionStorage.clear());

describe("tenant access session bootstrap", () => {
  it("round-trips an exact user and site scoped visual snapshot", () => {
    const snapshot = {
      role: "owner" as const,
      permissions: ["manageSubscribers", "viewInventoryReports"] as const,
      tenantId: 5,
      usesPermissionOverride: false,
    };
    writeCachedTenantAccess(10, 7, snapshot as any);
    expect(readCachedTenantAccess(10, 7)).toEqual(snapshot);
    expect(readCachedTenantAccess(11, 7)).toBeNull();
    expect(readCachedTenantAccess(10, 8)).toBeNull();
  });

  it("rejects malformed snapshots and unknown roles", () => {
    window.sessionStorage.setItem("powerhub.tenant-access.v1:10:7", JSON.stringify({
      role: "platform_admin", permissions: [], tenantId: 5, usesPermissionOverride: false,
    }));
    expect(readCachedTenantAccess(10, 7)).toBeNull();
    window.sessionStorage.setItem("powerhub.tenant-access.v1:10:7", "{");
    expect(readCachedTenantAccess(10, 7)).toBeNull();
  });
});
