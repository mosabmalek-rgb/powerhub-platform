import { describe, expect, it } from "vitest";

const SUPPORTED_ROLES = ["platform_owner", "platform_admin", "finance_admin"] as const;
const CAPABILITY = "manageSupportChat";

function decide(input: {
  accountStatus: string;
  platformRole: string | null;
  capability: string;
  policyAllowed: boolean;
  tenantRole?: string | null;
  tenantManageMessaging?: boolean;
}) {
  if (input.accountStatus !== "active") return false;
  if (input.capability !== CAPABILITY) return false;
  if (!SUPPORTED_ROLES.includes(input.platformRole as (typeof SUPPORTED_ROLES)[number])) return false;
  return input.policyAllowed === true;
}

describe("platform support authorization matrix", () => {
  it("allows only an explicit platform policy grant", () => {
    expect(decide({ accountStatus: "active", platformRole: "platform_admin", capability: CAPABILITY, policyAllowed: true })).toBe(true);
  });

  it("denies every supported platform role without an explicit grant", () => {
    for (const platformRole of SUPPORTED_ROLES) {
      expect(decide({ accountStatus: "active", platformRole, capability: CAPABILITY, policyAllowed: false })).toBe(false);
    }
  });

  it("denies inactive accounts even when a policy exists", () => {
    expect(decide({ accountStatus: "disabled", platformRole: "platform_admin", capability: CAPABILITY, policyAllowed: true })).toBe(false);
  });

  it("does not translate tenant manageMessaging into support access", () => {
    expect(decide({ accountStatus: "active", platformRole: null, capability: CAPABILITY, policyAllowed: true, tenantRole: "owner", tenantManageMessaging: true })).toBe(false);
  });

  it("denies unknown capabilities", () => {
    expect(decide({ accountStatus: "active", platformRole: "platform_admin", capability: "manageMessaging", policyAllowed: true })).toBe(false);
  });
});
