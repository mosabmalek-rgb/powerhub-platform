import { describe, expect, it } from "vitest";
import { isPlatformCapabilityAllowed } from "./platform-capability";

describe("platform capability authorization matrix", () => {
  it("allows an explicitly granted active platform role", () => {
    expect(
      isPlatformCapabilityAllowed({
        accountStatus: "active",
        platformRole: "platform_admin",
        capability: "manageSupportChat",
        policyAllowed: true,
      }),
    ).toBe(true);
  });

  it.each(["platform_owner", "platform_admin", "finance_admin"] as const)(
    "denies %s without an explicit policy",
    platformRole => {
      expect(
        isPlatformCapabilityAllowed({
          accountStatus: "active",
          platformRole,
          capability: "manageSupportChat",
          policyAllowed: false,
        }),
      ).toBe(false);
    },
  );

  it("denies an inactive account even when policy is allowed", () => {
    expect(
      isPlatformCapabilityAllowed({
        accountStatus: "disabled",
        platformRole: "platform_admin",
        capability: "manageSupportChat",
        policyAllowed: true,
      }),
    ).toBe(false);
  });

  it("denies unsupported capabilities", () => {
    expect(
      isPlatformCapabilityAllowed({
        accountStatus: "active",
        platformRole: "platform_admin",
        capability: "manageMessaging",
        policyAllowed: true,
      }),
    ).toBe(false);
  });

  it("does not infer support access from tenant roles or manageMessaging", () => {
    expect(
      isPlatformCapabilityAllowed({
        accountStatus: "active",
        platformRole: null,
        capability: "manageSupportChat",
        policyAllowed: true,
        tenantRole: "owner",
        tenantManageMessaging: true,
      }),
    ).toBe(false);
  });

  it("ignores a forged actor identifier because actor identity is not an input", () => {
    expect(
      isPlatformCapabilityAllowed({
        accountStatus: "active",
        platformRole: "platform_admin",
        capability: "manageSupportChat",
        policyAllowed: true,
        actorUserId: 999999,
        authenticatedUserId: 42,
      }),
    ).toBe(true);
  });
});
