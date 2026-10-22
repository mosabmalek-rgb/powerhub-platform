import { describe, expect, it } from "vitest";
import { can } from "./powerhub-rbac";

describe("maintenance read and management capabilities", () => {
  it("allows the documented read-only roles to view inventory without granting maintenance mutation", () => {
    expect(can("accountant", "viewInventory")).toBe(true);
    expect(can("viewer", "viewInventory")).toBe(true);
    expect(can("accountant", "manageMaintenance")).toBe(false);
    expect(can("viewer", "manageMaintenance")).toBe(false);
    expect(can("technician", "manageMaintenance")).toBe(true);
  });
});

describe("payment documentation approval capability", () => {
  it("does not grant approval by role alone", () => {
    expect(can("manager", "approvePaymentDocumentation")).toBe(false);
    expect(can("accountant", "approvePaymentDocumentation")).toBe(false);
    expect(can("collector", "approvePaymentDocumentation")).toBe(false);
  });

  it("allows explicit grants and only explicit grants", () => {
    expect(can("accountant", "approvePaymentDocumentation", ["approvePaymentDocumentation"])).toBe(true);
    expect(can("manager", "approvePaymentDocumentation", [])).toBe(false);
    expect(can("accountant", "approvePaymentDocumentation", ["collectPayments"])).toBe(false);
  });

  it("treats an explicit empty permission list as deny-by-default", () => {
    expect(can("accountant", "approvePaymentDocumentation", [])).toBe(false);
    expect(can("accountant", "collectPayments", [])).toBe(false);
  });

  it("uses role defaults only when custom permissions are absent", () => {
    expect(can("accountant", "collectPayments", null)).toBe(true);
    expect(can("accountant", "approvePaymentDocumentation", null)).toBe(false);
    expect(can("collector", "collectPayments", undefined)).toBe(true);
    expect(can("collector", "approvePaymentDocumentation", undefined)).toBe(false);
  });
});
