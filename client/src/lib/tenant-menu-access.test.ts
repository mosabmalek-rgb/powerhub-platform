import { describe, expect, it } from "vitest";
import { tenantMenuRouteAllowed } from "./tenant-menu-access";

describe("tenant sidebar access", () => {
  it("keeps limited roles away from owner-only and management routes", () => {
    expect(tenantMenuRouteAllowed("/staff", "collector")).toBe(false);
    expect(tenantMenuRouteAllowed("/portal-settings", "viewer")).toBe(false);
    expect(tenantMenuRouteAllowed("/notifications", "technician")).toBe(false);
    expect(tenantMenuRouteAllowed("/payroll", "manager")).toBe(true);
  });

  it("allows operational read routes only where the role has read access", () => {
    expect(tenantMenuRouteAllowed("/subscribers", "collector")).toBe(true);
    expect(tenantMenuRouteAllowed("/collections", "collector")).toBe(true);
    expect(tenantMenuRouteAllowed("/generators", "technician")).toBe(true);
    expect(tenantMenuRouteAllowed("/audit", "viewer")).toBe(true);
  });

  it("respects explicit delegated capabilities", () => {
    expect(tenantMenuRouteAllowed("/payment-documentation/review", "viewer", ["approvePaymentDocumentation"])).toBe(true);
    expect(tenantMenuRouteAllowed("/notifications", "viewer", ["manageMessaging"])).toBe(true);
    expect(tenantMenuRouteAllowed("/staff", "viewer", ["manageTeam"])).toBe(true);
  });

  it("honors explicit permission overrides even when the base role normally has read access", () => {
    expect(tenantMenuRouteAllowed("/subscribers", "collector", [], true)).toBe(false);
    expect(tenantMenuRouteAllowed("/subscribers", "collector", ["manageSubscribers"], true)).toBe(true);
  });

  it("allows report-only staff to reach the inventory workspace without granting stock operations", () => {
    expect(tenantMenuRouteAllowed("/inventory", "viewer", ["viewInventoryReports"], true)).toBe(true);
    expect(tenantMenuRouteAllowed("/inventory", "technician", [], true)).toBe(false);
    expect(tenantMenuRouteAllowed("/inventory", "manager", ["viewInventory"], true)).toBe(true);
  });

  it("does not expose unknown routes", () => {
    expect(tenantMenuRouteAllowed("/does-not-exist", "owner")).toBe(false);
  });

  it("allows supplier-payment-only overrides to reach the inventory workspace", () => {
    expect(tenantMenuRouteAllowed("/inventory", "viewer", ["manageSupplierPayments"], true)).toBe(true);
    expect(tenantMenuRouteAllowed("/inventory", "viewer", ["manageSuppliers"], true)).toBe(true);
    expect(tenantMenuRouteAllowed("/inventory", "technician", [], true)).toBe(false);
  });

  it("allows stocktake-only staff to reach the shared inventory workspace", () => {
    expect(tenantMenuRouteAllowed("/inventory", "viewer", ["viewStocktakes"], true)).toBe(true);
    expect(tenantMenuRouteAllowed("/inventory", "viewer", ["manageStocktakes"], true)).toBe(true);
    expect(tenantMenuRouteAllowed("/inventory", "viewer", ["approveStocktakes"], true)).toBe(true);
  });

});
