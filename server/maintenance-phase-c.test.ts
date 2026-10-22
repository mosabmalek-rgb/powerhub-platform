import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("PowerHub Phase C maintenance integration", () => {
  it("wires the tenant-scoped router and workspace tab", () => {
    const runtime = read("server/powerhub-runtime-router.ts");
    const router = read("server/powerhub-maintenance-router.ts");
    const page = read("client/src/pages/InventoryWorkspacePage.tsx");
    const panel = read("client/src/components/InventoryMaintenancePanel.tsx");
    expect(runtime).toContain("maintenance: powerhubMaintenanceRouter");
    expect(router).toContain('requireSupabaseSiteRole(ctx.user.id, input.siteId, [...maintenanceRoles], "manageMaintenance")');
    expect(router).toContain('"issueInventory"');
    expect(router).toContain('"manageExpenses"');
    expect(page).toContain('TabsTrigger value="maintenance"');
    expect(page).toContain("InventoryMaintenancePanel");
    expect(panel).toContain("trpc.powerhub.maintenance.listWorkOrders.useQuery");
    expect(panel).toContain("trpc.powerhub.maintenance.createWorkOrder.useMutation");
    expect(panel).toContain("trpc.powerhub.maintenance.transitionWorkOrder.useMutation");
  });

  it("defines transactional stock-linked work orders, preventive plans, idempotency, audit and strict ACL", () => {
    const migration = read("supabase/migrations/20261023090000_powerhub_generator_maintenance.sql");
    const integration = read("supabase/tests/inventory_maintenance_phase_c.sql");
    expect(migration).toContain("powerhub_inventory_record_stock_movement");
    expect(migration).toContain("pg_advisory_xact_lock");
    expect(migration).toContain("MAINTENANCE_IDEMPOTENCY_KEY_REUSED");
    expect(migration).toContain("MAINTENANCE_INVALID_STATE_TRANSITION");
    expect(migration).toContain("MAINTENANCE_HOURS_BACKWARDS");
    expect(migration).toContain("generator_maintenance_preventive_plans");
    expect(migration).toContain("powerhub_maintenance_evaluate_due_plans");
    expect(migration).toContain("generator_maintenance_audit_events");
    expect(migration).toContain("enable row level security");
    expect(migration).toContain("from public,anon,authenticated");
    expect(integration).toContain("MAINTENANCE_PART_DUPLICATED_STOCK_ISSUE");
    expect(integration).toContain("MAINTENANCE_TRANSITION_IDEMPOTENCY_FAILED");
    expect(integration).toContain("MAINTENANCE_OVERDUE_ALERT_MISSING");
    expect(integration).toContain("MAINTENANCE_RPC_ACL_FAILED");
  });
});
