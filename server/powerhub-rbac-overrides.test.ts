import { describe, expect, it } from "vitest";
import { applyStaffCapabilityOverrides, defaultCapabilitiesForRole } from "../shared/powerhub-rbac";

describe("per-user PowerHub capability overrides", () => {
  it("inherits base role capabilities when no explicit overrides exist", () => {
    const base = defaultCapabilitiesForRole("technician");
    expect(applyStaffCapabilityOverrides(base, [])).toEqual(base);
  });

  it("grants a capability to one user without changing the role defaults", () => {
    const base = defaultCapabilitiesForRole("technician");
    const result = applyStaffCapabilityOverrides(base, [
      { capability: "manageSuppliers", is_allowed: true },
    ]);
    expect(result).toContain("manageSuppliers");
    expect(defaultCapabilitiesForRole("technician")).not.toContain("manageSuppliers");
  });

  it("denies a capability inherited from the base role", () => {
    const base = defaultCapabilitiesForRole("accountant");
    expect(base).toContain("createPurchases");
    const result = applyStaffCapabilityOverrides(base, [
      { capability: "createPurchases", is_allowed: false },
    ]);
    expect(result).not.toContain("createPurchases");
  });

  it("applies the last explicit row for a capability and ignores unknown values", () => {
    const result = applyStaffCapabilityOverrides(defaultCapabilitiesForRole("viewer"), [
      { capability: "viewInventory", is_allowed: false },
      { capability: "viewInventory", is_allowed: true },
      { capability: "not-a-capability", is_allowed: true },
    ]);
    expect(result).toContain("viewInventory");
    expect(result).not.toContain("not-a-capability");
  });
});
