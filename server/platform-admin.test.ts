import { describe, expect, it } from "vitest";
import { isActivePlatformAdmin, isPlatformRole } from "./platform-admin";

describe("active platform admin identity", () => {
  it.each(["platform_admin", "platform_owner", "finance_admin"])('accepts active admin with %s', (platformRole) => {
    expect(isActivePlatformAdmin({ role: "admin", accountStatus: "active", platformRole })).toBe(true);
  });

  it.each([
    { role: "admin", accountStatus: "suspended", platformRole: "platform_admin" },
    { role: "admin", accountStatus: "inactive", platformRole: "platform_owner" },
    { role: "admin", accountStatus: "active", platformRole: null },
    { role: "admin", accountStatus: "active", platformRole: "invalid" },
    { role: "user", accountStatus: "active", platformRole: "platform_admin" },
  ])("rejects an identity that is not an active platform admin: $role/$accountStatus/$platformRole", (identity) => {
    expect(isActivePlatformAdmin(identity)).toBe(false);
  });

  it("limits platform procedures to the requested valid platform roles", () => {
    expect(isPlatformRole({ role: "admin", accountStatus: "active", platformRole: "finance_admin" }, ["platform_owner", "platform_admin"])).toBe(false);
    expect(isPlatformRole({ role: "admin", accountStatus: "active", platformRole: "finance_admin" }, ["finance_admin"])).toBe(true);
  });
});
