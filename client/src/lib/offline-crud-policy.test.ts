import { describe, expect, it } from "vitest";
import { assertOfflineCrudAllowed, isOfflineCrudAllowed, OFFLINE_CRUD_POLICY } from "./offline-crud-policy";

describe("offline CRUD policy", () => {
  it("allows only approved operational creates", () => {
    expect(isOfflineCrudAllowed("subscribers", "create")).toBe(true);
    expect(isOfflineCrudAllowed("generators", "create")).toBe(true);
    expect(isOfflineCrudAllowed("readings", "create")).toBe(true);
    expect(isOfflineCrudAllowed("payments", "create")).toBe(false);
    expect(isOfflineCrudAllowed("invoices", "create")).toBe(false);
  });

  it("allows operational updates but no offline deletes", () => {
    expect(isOfflineCrudAllowed("subscribers", "update")).toBe(true);
    expect(isOfflineCrudAllowed("generators", "update")).toBe(true);
    expect(isOfflineCrudAllowed("readings", "update")).toBe(true);
    expect(isOfflineCrudAllowed("tariffs", "update")).toBe(true);
    expect(isOfflineCrudAllowed("schedules", "update")).toBe(true);
    expect(isOfflineCrudAllowed("subscribers", "delete")).toBe(false);
  });

  it("fails closed for sensitive and administrative operations", () => {
    for (const entity of ["payments", "collections", "expenses", "payroll", "attendance", "audit", "admin", "messaging", "companyAccounts"]) {
      expect(OFFLINE_CRUD_POLICY.blockedByDefault).toContain(entity);
    }
    expect(() => assertOfflineCrudAllowed("payments", "create")).toThrow();
    expect(() => assertOfflineCrudAllowed("subscribers", "delete")).toThrow();
  });
});
