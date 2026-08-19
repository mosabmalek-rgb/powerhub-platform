import { describe, expect, it } from "vitest";
import { can } from "./powerhub-rbac";

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
});
