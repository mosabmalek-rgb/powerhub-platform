import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const router = readFileSync(resolve(process.cwd(), "server/powerhub.ts"), "utf8");

describe("operational Delta revision contract", () => {
  const start = router.indexOf("revisions: protectedProcedure", router.indexOf("deltaSync: router"));
  const end = router.indexOf("pull: protectedProcedure", start);
  const procedure = router.slice(start, end);

  it("authorizes every requested feed before observing its revision", () => {
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(procedure).toContain("requireDeltaFuelMaintenanceReadAccess");
    expect(procedure).toContain("requireDeltaOperationalReadAccess");
    expect(procedure).toContain("Promise.all(input.entityTypes.map");
    expect(procedure).toContain("accesses.some((access) => access.tenantId !== tenantId)");
  });

  it("reads only cursor metadata for the authorized tenant and branch", () => {
    expect(procedure).toContain('.select("entity_type,last_cursor,retained_from_cursor")');
    expect(procedure).toContain('.eq("tenant_id", tenantId)');
    expect(procedure).toContain('.eq("site_id", input.siteId)');
    expect(procedure).toContain('.in("entity_type", input.entityTypes)');
    expect(procedure).toContain('createHash("sha256")');
    expect(procedure).toContain("return { siteId: input.siteId, revisions, observedAt:");
    expect(procedure).not.toContain('.select("*")');
    expect(procedure).not.toContain("row_data");
    expect(procedure).not.toContain("changes:");
  });

  it("accepts only the four bounded operational feed names and rejects duplicates", () => {
    for (const entity of ["fuel_events", "fuel_readings", "maintenance_preventive_plans", "maintenance_work_orders"]) {
      expect(procedure).toContain('"' + entity + '"');
    }
    expect(procedure).toContain(".min(1).max(4)");
    expect(procedure).toContain("new Set(values).size === values.length");
  });

  it("allows report-only roles to observe the maintenance revision without broadening work-order Delta row access", () => {
    expect(procedure).toContain('if (entityType === "maintenance_work_orders")');
    expect(procedure).toContain('"viewInventoryReports"');
    const workOrderGuardStart = router.indexOf("async function requireDeltaFuelMaintenanceReadAccess");
    const workOrderGuardEnd = router.indexOf("export const powerhubRouter", workOrderGuardStart);
    const workOrderGuard = router.slice(workOrderGuardStart, workOrderGuardEnd);
    const workOrderDetailGuardStart = workOrderGuard.indexOf("  try {");
    expect(workOrderDetailGuardStart).toBeGreaterThan(0);
    const workOrderDetailGuard = workOrderGuard.slice(workOrderDetailGuardStart);
    expect(workOrderDetailGuard).not.toContain("viewInventoryReports");
    expect(workOrderDetailGuard).toContain('requireSupabaseSiteRole(userId, siteId, ["owner", "manager", "accountant", "collector", "technician", "viewer"], "viewInventory")');
    expect(workOrderDetailGuard).toContain('requireSupabaseSiteRole(userId, siteId, ["owner", "manager", "technician"], "manageMaintenance")');
    expect(procedure).toContain('["owner", "manager", "technician", "accountant", "viewer"]');
    expect(procedure).toContain('"viewInventoryReports"');

  });
});
