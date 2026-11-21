import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  delegableCapabilitiesForOwner, defaultStaffPermissionSelection,
  permissionsAreDelegable, nonDelegableStaffCapabilities,
} from "./staff-permission-selection";
import { defaultCapabilitiesForRole, powerCapabilityLabels, type PowerCapability } from "./powerhub-rbac";

const owner = Object.keys(powerCapabilityLabels) as PowerCapability[];

describe("E47: owner-scoped defaults and selected staff capabilities", () => {
  it("provides the role defaults and allows removing any default permission", () => {
    const defaults = defaultStaffPermissionSelection("accountant", owner);
    expect(defaults).toContain("viewFinancialReports");
    expect(defaults).toContain("collectPayments");
    expect(defaults).not.toContain("manageTeam");
    expect(defaults).not.toContain("manageMessaging");
    expect(permissionsAreDelegable(defaults.filter((x) => x !== "collectPayments"), owner)).toBe(true);
  });
  it("allows granting an extra permission only within the owner's rights", () => {
    const limited = owner.filter(x => x !== "managePayroll");
    expect(permissionsAreDelegable(["recordReadings", "collectPayments"], limited)).toBe(true);
    expect(permissionsAreDelegable(["managePayroll"], limited)).toBe(false);
  });
  it("denies reserved owner-only operations and unknown capabilities", () => {
    expect(nonDelegableStaffCapabilities).toEqual(["manageTeam", "manageMessaging"]);
    expect(delegableCapabilitiesForOwner(owner)).not.toContain("manageTeam");
    expect(permissionsAreDelegable(["manageTeam"], owner)).toBe(false);
    expect(permissionsAreDelegable(["manageMessaging"], owner)).toBe(false);
    expect(permissionsAreDelegable(["__unrecognized" as PowerCapability], owner)).toBe(false);
  });
  it("treats empty explicit permissions as an intentionally restricted account", () => {
    expect(permissionsAreDelegable([], owner)).toBe(true);
    expect(defaultCapabilitiesForRole("viewer").length).toBeGreaterThan(0);
  });
  it("deduplicates available catalog and rejects duplicate requested grants", () => {
    expect(delegableCapabilitiesForOwner(["recordReadings", "recordReadings", "manageTeam"]))
      .toEqual(["recordReadings"]);
    expect(permissionsAreDelegable(["recordReadings", "recordReadings"], owner)).toBe(false);
  });
  it("uses the assigned branch and validates owner rights on the server, not only the browser", () => {
    const ui = readFileSync("client/src/components/CreateSubaccountForm.tsx","utf8");
    const route = readFileSync("server/powerhub.ts","utf8");
    expect(ui).toContain("defaultStaffPermissionSelection");
    expect(ui).toContain("allBranches: allBranchesPossible && allBranches, permissions");
    expect(route).toContain("permissionsAreDelegable(input.permissions, allowed)");
    expect(route).toContain("powerhub_assign_existing_staff_with_permissions");
    expect(route).toContain("permissions: input.permissions,");
    expect(route).toContain("p_permissions: input.permissions");
  });
  it("requires service-only execution and a single database transaction in the E47 migration", () => {
    const migration = readFileSync("supabase/migrations/20261116175000_powerhub_e47_atomic_staff_custom_permissions.sql","utf8");
    expect(migration).toContain("SECURITY INVOKER");
    expect(migration).toContain("public.powerhub_assign_existing_staff(");
    expect(migration).toContain("SET permissions=p_permissions, custom_role_id=NULL");
    expect(migration).toContain("'update_permissions'");
    expect(migration).toContain("FROM PUBLIC,anon,authenticated");
    expect(migration).toContain("TO service_role");
  });
});
