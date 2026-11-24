import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
const migrationDir = "supabase/migrations";
const migrations = readdirSync(resolve(process.cwd(), migrationDir))
  .filter((name) => /^\d+_.*\.sql$/.test(name)).sort()
  .map((name) => ({ name, sql: read(migrationDir + "/" + name) }));

// Lexical source contract, NOT a SQL parser, live catalog or complete call graph.
// Inspect all chronological CREATE definitions, including files with unrelated names.
function latestBody(name: string) {
  const header = new RegExp("\\bcreate\\s+(?:or\\s+replace\\s+)?function\\s+public\\." + name + "\\s*\\(", "gi");
  let latest: { name: string; body: string } | undefined;
  for (const migration of migrations) {
    for (const match of migration.sql.matchAll(header)) {
      const rest = migration.sql.slice(match.index! + match[0].length);
      const delimiter = /\bas\s+(\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$)/i.exec(rest);
      expect(delimiter, migration.name + ": unsupported function body for " + name).not.toBeNull();
      const start = delimiter!.index + delimiter![0].length;
      const end = rest.indexOf(delimiter![1], start);
      expect(end, migration.name + ": missing body terminator").toBeGreaterThan(start);
      latest = { name: migration.name, body: rest.slice(start, end) };
    }
  }
  expect(latest, "missing definition: " + name).toBeDefined();
  return latest!;
}

const writers = [
  ["recordFuelFill", "inventory", "powerhub_inventory_record_fuel_fill", "manageFuelAndConsumption", ["insert into public.generator_fuel_events"]],
  ["createWorkOrder", "maintenance", "powerhub_maintenance_create_work_order", "manageMaintenance", ["insert into public.generator_maintenance_work_orders"]],
  ["assignSupplier", "maintenance", "powerhub_maintenance_assign_supplier", "manageMaintenance", ["update public.generator_maintenance_work_orders"]],
  ["addPart", "maintenance", "powerhub_maintenance_add_part", "requireMaintenanceManageAccess", ["insert into public.generator_maintenance_work_order_parts", "update public.generator_maintenance_work_orders"]],
  ["reopenCompletedWorkOrder", "maintenance", "powerhub_maintenance_reopen_completed_work_order", "manageMaintenance", ["insert into public.generator_maintenance_work_orders"]],
  ["transitionWorkOrder", "maintenance", "powerhub_maintenance_transition_work_order", "requireMaintenanceManageAccess", ["update public.generator_maintenance_work_orders"]],
] as const;

describe("CB-A fuel and maintenance known writer source contracts", () => {
  for (const [mutation, router, rpc, capability, writes] of writers) {
    it("retains scoped " + mutation + " RPC and writes in latest lexical definition", () => {
      const source = read("server/powerhub-" + router + "-router.ts");
      const start = source.indexOf(mutation + ": protectedProcedure");
      expect(start).toBeGreaterThanOrEqual(0);
      const tail = source.slice(start + mutation.length);
      const next = /\n  \w+:\s*protectedProcedure/.exec(tail);
      const block = source.slice(start, next ? start + mutation.length + next.index : source.length);
      expect(block).toContain(".mutation(");
      expect(block).toContain(capability);
      expect(block).toContain('"' + rpc + '"');
      for (const binding of [
        /p_tenant_id:\s*access\.tenantId/, /p_site_id:\s*input\.siteId/,
        /p_user_id:\s*ctx\.user\.id/, /p_operation_key:\s*input\.operationKey/,
      ]) expect(block).toMatch(binding);
      if (mutation === "addPart") expect(block).toContain("issueInventory");
      const def = latestBody(rpc);
      const normalized = def.body.toLowerCase().replace(/\s+/g, " ");
      for (const write of writes) expect(normalized, def.name).toContain(write);
      expect(normalized).not.toMatch(/disable\s+trigger|session_replication_role/);
    });
  }
  for (const [table, trigger] of [
    ["generator_fuel_events", "powerhub_delta_fuel_events_operational"],
    ["generator_maintenance_work_orders", "powerhub_delta_maintenance_work_orders_operational"],
    ["generator_maintenance_work_order_parts", "powerhub_delta_maintenance_work_order_parts_operational"],
  ]) {
    it("retains the known direct trigger declaration for " + table, () => {
      const source = read("supabase/migrations/20261101083020_powerhub_delta_fuel_events_maintenance_orders_parts.sql")
        .toLowerCase().replace(/\s+/g, " ");
      expect(source).toContain("create trigger " + trigger + " after insert or update or delete on public." + table +
        " for each row execute function public.powerhub_capture_fuel_maintenance_delta_sync_change()");
    });
  }
});
