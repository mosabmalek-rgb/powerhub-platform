import { describe, expect, it } from "vitest";
import { can, platformAccessRole, powerRoleLabels, powerRoleScopes } from "./powerhub-rbac";

describe("PowerHub role capabilities", () => {
  it("keeps financial, collection, and technical capabilities separate", () => {
    expect(can("collector", "collectPayments")).toBe(true);
    expect(can("collector", "recordReadings")).toBe(false);
    expect(can("technician", "recordReadings")).toBe(true);
    expect(can("technician", "collectPayments")).toBe(false);
    expect(can("accountant", "issueInvoices")).toBe(true);
    expect(can("viewer", "issueInvoices")).toBe(false);
  });

  it("reserves team and messaging administration for the owner", () => {
    expect(can("owner", "manageTeam")).toBe(true);
    expect(can("manager", "manageTeam")).toBe(false);
    expect(can("owner", "manageMessaging")).toBe(true);
    expect(can("accountant", "manageMessaging")).toBe(false);
  });

  it("uses direct permissions when an account has a custom permission set", () => {
    expect(can("viewer", "collectPayments", ["collectPayments"])).toBe(true);
    expect(can("collector", "recordReadings", ["collectPayments"])).toBe(false);
    expect(can("viewer", "viewAudit", ["viewAudit"])).toBe(true);
  });

  it("maps the proposed platform administrator and generator-owner labels to their real scopes", () => {
    expect(platformAccessRole).toMatchObject({ key: "super_admin", displayName: "مدير المنصة", scope: "platform", implementationRole: "admin" });
    expect(powerRoleLabels.owner).toBe("صاحب مولد");
    expect(powerRoleLabels.accountant).toBe("محاسب");
    expect(powerRoleScopes.owner).toBe("tenant");
    expect(powerRoleScopes.manager).toBe("site");
    expect(powerRoleScopes.accountant).toBe("site");
  });
});
