import { describe, expect, it } from "vitest";
import { defaultCapabilitiesForRole } from "../shared/powerhub-rbac";

describe("staff effective permission model", () => {
  it("derives default capabilities from the base role", () => {
    expect(defaultCapabilitiesForRole("collector")).toContain("collectPayments");
    expect(defaultCapabilitiesForRole("collector")).not.toContain("manageTeam");
  });

  it("keeps explicit deny-all distinct from inherited role permissions", () => {
    expect(defaultCapabilitiesForRole("accountant")).toContain("issueInvoices");
    expect([]).not.toContain("issueInvoices");
  });
});
