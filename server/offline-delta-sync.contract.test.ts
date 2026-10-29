import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migration = readFileSync(resolve(process.cwd(), "supabase/migrations/20261024140000_powerhub_delta_sync_engine.sql"), "utf8");
const invoiceMigration = readFileSync(resolve(process.cwd(), "supabase/migrations/20261027110000_powerhub_delta_invoice_history.sql"), "utf8");
const paymentMigration = readFileSync(resolve(process.cwd(), "supabase/migrations/20261027130000_powerhub_delta_payment_history.sql"), "utf8");
const expenseMigration = readFileSync(resolve(process.cwd(), "supabase/migrations/20261027140000_powerhub_delta_expense_history.sql"), "utf8");
const inventoryMigration = readFileSync(resolve(process.cwd(), "supabase/migrations/20261029000000_powerhub_delta_inventory_catalog.sql"), "utf8");
const stocktakeMigration = readFileSync(resolve(process.cwd(), "supabase/migrations/20261029100000_powerhub_delta_inventory_stocktakes.sql"), "utf8");
const purchaseHeaderMigration = readFileSync(resolve(process.cwd(), "supabase/migrations/20261029110000_powerhub_delta_purchase_headers.sql"), "utf8");
const receiptReturnMigration = readFileSync(resolve(process.cwd(), "supabase/migrations/20261029120000_powerhub_delta_receipt_return_headers.sql"), "utf8");
const operationalMigration = readFileSync(resolve(process.cwd(), "supabase/migrations/20261029130000_powerhub_delta_fuel_maintenance_read_models.sql"), "utf8");
const fuelMaintenanceMigration = readFileSync(resolve(process.cwd(), "supabase/migrations/20261029140000_powerhub_delta_fuel_events_maintenance_orders_parts.sql"), "utf8");
const hrOfflineMigration = readFileSync(resolve(process.cwd(), "supabase/migrations/20261029160000_powerhub_hr_offline_operation_idempotency.sql"), "utf8");
const maintenanceGuardSource = readFileSync(resolve(process.cwd(), "server/powerhub-maintenance-router.ts"), "utf8");
const inventoryRouter = readFileSync(resolve(process.cwd(), "server/powerhub-inventory-router.ts"), "utf8");
const purchaseHeaderProjection = purchaseHeaderMigration.slice(
  purchaseHeaderMigration.indexOf("create or replace function public.powerhub_delta_sync_project_purchase_header_row"),
  purchaseHeaderMigration.indexOf("create or replace function public.powerhub_delta_sync_project_inventory_row"),
);
const router = readFileSync(resolve(process.cwd(), "server/powerhub.ts"), "utf8");
const client = readFileSync(resolve(process.cwd(), "client/src/lib/offline-delta-sync.ts"), "utf8");

describe("PowerHub delta sync contract", () => {
  it("keeps the change journal private and callable only through the server role", () => {
    expect(migration).toContain("alter table public.powerhub_sync_changes enable row level security");
    expect(migration).toContain("revoke all on table public.powerhub_sync_changes from public, anon, authenticated");
    expect(migration).toContain("grant execute on function public.powerhub_pull_sync_delta");
    expect(migration).toContain("to service_role");
    expect(migration).toContain("revoke all on function public.powerhub_pull_sync_delta");
  });

  it("uses a per-scope transactional cursor rather than a global identity sequence", () => {
    expect(migration).toContain("primary key (tenant_id, site_id, entity_type)");
    expect(migration).toContain("last_cursor = public.powerhub_sync_scope_state.last_cursor + 1");
    expect(migration).toContain("retained_from_cursor");
    expect(migration).toContain("'reset_required'");
    expect(migration).not.toMatch(/create\s+sequence\s+public\.powerhub_sync/i);
  });

  it("records insert, update, delete and archive events for supported operational entities", () => {
    for (const table of ["sites", "subscribers", "generators", "meter_readings", "tariffs"]) {
      expect(migration).toContain(`on public.${table}`);
    }
    expect(migration).toContain("after insert or update or delete on public.subscribers");
    expect(migration).toContain("coalesce(v_new ->> 'archived_at', '') <> ''");
    expect(migration).toContain("'delete', null");
  });

  it("checks authenticated site scope and a per-entity capability before calling the private RPC", () => {
    expect(router).toContain("deltaSync: router({");
    expect(router).toContain("entityType: deltaEntityTypeSchema");
    expect(router).toContain("requireSupabaseSiteRole(");
    // Assert routing choices independently of source-line wrapping.
    expect(router).toContain('operationalDeltaEntity ? "powerhub_pull_operational_sync_delta"');
    expect(router).toContain('inventoryCatalogEntity ? "powerhub_pull_inventory_sync_delta"');
    expect(router).toContain('"powerhub_pull_sync_delta"');
    expect(router).toContain('operationalDeltaEntity ? "powerhub_get_operational_sync_snapshot"');
    expect(router).toContain('inventoryCatalogEntity ? "powerhub_get_inventory_sync_snapshot"');
    expect(router).toContain('"powerhub_get_sync_snapshot"');
    expect(router).toContain('inventory_stock_movements: ["owner", "manager", "accountant", "collector", "technician", "viewer"]');
    expect(router).toContain('"inventory_stock_movements"].includes(input.entityType) ? "viewInventory" : undefined');
    expect(inventoryMigration).toContain("create trigger powerhub_delta_sync_inventory_stock_movements after insert on public.inventory_stock_movements");
    expect(inventoryMigration).toContain("'movement_id',p_row->'id'");
    expect(inventoryMigration).not.toContain("'unit_cost',p_row->'unit_cost'");

    expect(router).toContain("input.pageSize");
  });

  it("uses read access roles for delta refresh rather than write capabilities", () => {
    expect(router).toContain('subscribers: ["owner", "manager", "accountant", "collector", "viewer"]');
    expect(router).toContain('generators: ["owner", "manager", "technician", "viewer"]');
    expect(router).toContain('tariffs: ["owner", "manager", "accountant", "viewer"]');
    expect(router).not.toContain('capabilityByEntity[input.entityType]');
  });

  it("uses string cursors and fixed page boundaries and refuses unordered or mismatched changes", () => {
    expect(client).toContain("BigInt(assertCursor(a))");
    expect(client).toContain("throughCursor: through");
    expect(client).toContain("change.row_data[idKey]");
    expect(client).toContain("page.through_cursor");
    expect(client).toContain("setDeltaCursor");
  });
});


describe("HR offline operation replay contract", () => {
  it("uses transaction-bound idempotency, optimistic versions and service-role-only execution", () => {
    expect(hrOfflineMigration).toContain("powerhub_hr_replay_offline_operation");
    expect(hrOfflineMigration).toContain("powerhub_hr_offline_operation_results");
    expect(hrOfflineMigration).toContain("EMPLOYEE_VERSION_CONFLICT");
    expect(hrOfflineMigration).toContain("ATTENDANCE_VERSION_CONFLICT");
    expect(hrOfflineMigration).toContain("IDEMPOTENCY_KEY_REUSED");
    expect(hrOfflineMigration).toContain("revoke all on function public.powerhub_hr_replay_offline_operation");
    expect(hrOfflineMigration).toContain("grant execute on function public.powerhub_hr_replay_offline_operation");
    expect(hrOfflineMigration).toContain("to service_role");
    expect(hrOfflineMigration).toContain("'version_no',e.hr_sync_version");
    expect(hrOfflineMigration).toContain("'version_no',a.hr_sync_version");
    const replayStart = hrOfflineMigration.indexOf("create or replace function public.powerhub_hr_replay_offline_operation");
    const replayEnd = hrOfflineMigration.indexOf("alter function public.powerhub_hr_replay_offline_operation", replayStart);
    const replay = hrOfflineMigration.slice(replayStart, replayEnd);
    const attendanceStart = replay.indexOf("elsif p_operation_type='attendance_upsert' then");
    const attendanceEnd = replay.indexOf("elsif p_operation_type='payroll_draft' then", attendanceStart);
    const attendanceBranch = replay.slice(attendanceStart, attendanceEnd);
    expect(attendanceBranch).toContain("hashtext('attendance:' || p_tenant_id::text || ':' || v_entity_id::text || ':' ||");
    expect(attendanceBranch).toContain("(p_payload->>'workDate')::date::text)::bigint");
    expect(attendanceBranch.indexOf("perform pg_advisory_xact_lock")).toBeGreaterThanOrEqual(0);
    expect(attendanceBranch.indexOf("perform pg_advisory_xact_lock")).toBeLessThan(attendanceBranch.indexOf("select a.id,a.hr_sync_version"));
    const snapshotStart = hrOfflineMigration.indexOf("create or replace function public.powerhub_get_hr_sync_snapshot");
    const snapshotEnd = hrOfflineMigration.indexOf("alter function public.powerhub_get_hr_sync_snapshot", snapshotStart);
    const snapshot = hrOfflineMigration.slice(snapshotStart, snapshotEnd);
    expect(snapshot).toContain("insert into public.powerhub_sync_scope_state");
    expect(snapshot).toContain("for update");
    expect(snapshot.indexOf("for update")).toBeLessThan(snapshot.indexOf("from public.employees"));
    expect(snapshot.indexOf("for update")).toBeLessThan(snapshot.indexOf("from public.employee_attendance"));
    expect(router).toContain("replayOfflineOperation: protectedProcedure");
    expect(router).toContain("powerhub_hr_replay_offline_operation");
  });
});

describe("fuel and maintenance Delta boundaries", () => {
  it("caps maintenance snapshots at 500 rows on the database side and preserves due-plan priority", () => {
    const snapshot = operationalMigration.slice(
      operationalMigration.indexOf("create or replace function public.powerhub_get_operational_sync_snapshot"),
      operationalMigration.indexOf("alter function public.powerhub_get_operational_sync_snapshot"),
    );
    expect(snapshot).toContain("limit 500");
    expect(snapshot).toContain("when plan_row.alert_type='overdue' then 0");
    expect(snapshot).toContain("when plan_row.alert_type='due_soon' then 1");
    expect(snapshot).toContain("coalesce(plan.next_due_at,'infinity'::timestamptz)");
    const alertRefresh = operationalMigration.slice(
      operationalMigration.indexOf("create or replace function public.powerhub_refresh_maintenance_plan_delta_scope"),
      operationalMigration.indexOf("alter function public.powerhub_refresh_maintenance_plan_delta_scope"),
    );
    expect(alertRefresh).toContain("limit 500");
    expect(alertRefresh).toContain("powerhub_emit_operational_delta_sync_change");
    expect(operationalMigration).toContain("perform public.powerhub_refresh_maintenance_plan_delta_scope(NEW.tenant_id,NEW.site_id)");
    expect(operationalMigration).toContain("perform public.powerhub_refresh_maintenance_plan_delta_scope(OLD.tenant_id,OLD.site_id)");
  });

  it("uses the same maintenance-specific read capability as the maintenance list endpoint", () => {
    const maintenanceReadGuard = router.slice(
      router.indexOf("async function requireDeltaOperationalReadAccess"),
      router.indexOf("async function requireDeltaPurchaseChildHistoryReadAccess"),
    );
    expect(maintenanceReadGuard).toContain('requireSupabaseSiteRole(userId, siteId, ["owner", "manager", "technician"], "manageMaintenance")');
    expect(maintenanceGuardSource).toContain('requireSupabaseSiteRole(userId, siteId, [...maintenanceRoles], "manageMaintenance")');
  });
});

describe("inventory catalog Delta extension", () => {
  it("keeps tenant-wide catalogs and branch warehouses on explicit private feeds", () => {
    expect(inventoryMigration).toContain("'inventory_items','inventory_item_units','suppliers','inventory_warehouses','inventory_stock_movements'");
    expect(inventoryMigration).toContain("powerhub_get_inventory_sync_snapshot");
    expect(inventoryMigration).toContain("powerhub_pull_inventory_sync_delta");
    expect(inventoryMigration).toContain("after insert on public.inventory_stock_movements");
    expect(inventoryMigration).not.toContain("'total_cost_amount',p_row->'total_cost_amount'");
    expect(inventoryMigration).toContain("after insert or update or delete on public.inventory_items");
    expect(inventoryMigration).toContain("after insert or update or delete on public.inventory_item_units");
    expect(inventoryMigration).toContain("after insert or update or delete on public.suppliers");
    expect(inventoryMigration).toContain("after insert or update or delete on public.inventory_warehouses");
    expect(inventoryMigration).toContain("revoke all on function public.powerhub_pull_inventory_sync_delta");
    expect(router).toContain('input.entityType === "suppliers" ? "viewSuppliers"');
    expect(router).toContain('? "viewInventory" : undefined');
    expect(client).toContain('"inventory_item_units"');
    expect(stocktakeMigration).toContain("after insert or update or delete on public.inventory_stocktakes");
    expect(stocktakeMigration).toContain("after insert or update or delete on public.inventory_stocktake_lines");
    expect(stocktakeMigration).toContain("'variance_quantity',counts.variance_quantity");
    expect(stocktakeMigration).not.toContain("'system_value'");
    expect(stocktakeMigration).not.toContain("'system_unit_cost'");
    expect(router).toContain('inventory_stocktakes: ["owner", "manager", "accountant", "collector", "technician", "viewer"]');
    expect(client).toContain('"inventory_stocktakes"');
    expect(purchaseHeaderMigration).toContain("after insert or update or delete on public.supplier_purchases");
    expect(purchaseHeaderMigration).toContain("after insert or update or delete on public.supplier_purchase_lines");
    expect(purchaseHeaderProjection).toContain("'received_line_count',line_summary.received_line_count");
    expect(purchaseHeaderProjection).not.toContain("'total_amount'");
    expect(purchaseHeaderProjection).not.toContain("'supplier_invoice_no'");
    expect(purchaseHeaderProjection).not.toContain("'due_date'");
    expect(purchaseHeaderProjection).not.toContain("'payment_terms_days'");
    expect(purchaseHeaderProjection).not.toContain("'reference_no'");
    expect(purchaseHeaderProjection).not.toContain("'notes'");
    expect(router).toContain("requireDeltaPurchaseHeaderReadAccess");
    expect(router).toContain('"inventory_purchase_headers", "inventory_purchase_receipt_headers", "inventory_supplier_return_headers"].includes(input.entityType)');
    expect(router).toContain("requireDeltaPurchaseChildHistoryReadAccess");
    expect(inventoryRouter).toContain("listPurchaseReceiptHeaders");
    expect(inventoryRouter).toContain("listSupplierReturnHeaders");
    expect(receiptReturnMigration).toContain("after insert or update or delete on public.supplier_purchase_receipts");
    expect(receiptReturnMigration).toContain("after insert or update or delete on public.supplier_purchase_returns");
    expect(receiptReturnMigration).toContain("'received_quantity',line_summary.received_quantity");
    expect(receiptReturnMigration).toContain("'returned_quantity',line_summary.returned_quantity");
    expect(receiptReturnMigration).not.toContain("'refund_amount'");
    expect(receiptReturnMigration).not.toContain("'supplier_credit_amount'");
    expect(receiptReturnMigration).not.toContain("'inventory_unit_cost'");
    expect(client).toContain('"inventory_purchase_receipt_headers"');
    expect(client).toContain('"inventory_supplier_return_headers"');
  });
});

describe("invoice Delta extension", () => {
  it("keeps invoice snapshots scoped and projects only the explicit invoice fields", () => {
    expect(invoiceMigration).toContain("check (entity_type in ('sites','subscribers','generators','readings','tariffs','invoices'))");
    expect(invoiceMigration).toContain("when 'invoices' then jsonb_build_object(");
    expect(invoiceMigration).toContain("'balance_due',p_row->'balance_due'");
    expect(invoiceMigration).toContain("where i.tenant_id=p_tenant_id and i.site_id=p_site_id");
    expect(invoiceMigration).toContain("after insert or update or delete on public.invoices");
    expect(invoiceMigration).toContain("grant execute on function public.powerhub_pull_sync_delta");
    expect(router).toContain('invoices: ["owner", "manager", "accountant", "collector", "viewer"]');
    expect(client).toContain('"invoices"');
  });
});

describe("payment Delta extension", () => {
  it("uses scoped joined payment projections and excludes receipt-storage secrets", () => {
    expect(paymentMigration).toContain("check (entity_type in ('sites','subscribers','generators','readings','tariffs','invoices','payments'))");
    expect(paymentMigration).toContain("powerhub_delta_sync_project_payment(p_tenant_id,p_site_id,p.id)");
    expect(paymentMigration).toContain("'has_receipt_image'");
    expect(paymentMigration).not.toContain("'receipt_image_key',p_row->'receipt_image_key'");
    expect(paymentMigration).toContain("after insert or update or delete on public.payments");
    expect(paymentMigration).toContain("revoke all on function public.powerhub_delta_sync_project_payment");
    expect(router).toContain('payments: ["owner", "manager", "accountant", "collector", "viewer"]');
    expect(client).toContain('"payments"');
  });
});


describe("expense Delta extension", () => {
 it("keeps expense history scoped and journal writes private", () => {
  expect(expenseMigration).toContain("when 'expenses' then jsonb_build_object(");
  expect(expenseMigration).toContain("after insert or update or delete on public.expenses");
  expect(expenseMigration).toContain("where e.tenant_id=p_tenant_id and e.site_id=p_site_id");
  expect(router).toContain('expenses: ["owner", "manager", "accountant", "viewer"]');
  expect(client).toContain('"expenses"');
 });
});


describe("fuel and preventive maintenance Delta extension", () => {
  it("uses allowlisted projections, private cursor feeds, scoped triggers and tombstones", () => {
    expect(operationalMigration).toContain("'fuel_readings','maintenance_preventive_plans'");
    expect(operationalMigration).toContain("powerhub_project_fuel_reading_delta_row");
    expect(operationalMigration).toContain("powerhub_project_maintenance_plan_delta_row");
    expect(operationalMigration).toContain("powerhub_get_operational_sync_snapshot");
    expect(operationalMigration).toContain("powerhub_pull_operational_sync_delta");
    const generatorRefresh = operationalMigration.slice(
      operationalMigration.indexOf("create or replace function public.powerhub_refresh_operational_delta_after_generator_update"),
      operationalMigration.indexOf("alter function public.powerhub_refresh_operational_delta_after_generator_update"),
    );
    const warehouseRefresh = operationalMigration.slice(
      operationalMigration.indexOf("create or replace function public.powerhub_refresh_fuel_reading_delta_after_warehouse_update"),
      operationalMigration.indexOf("alter function public.powerhub_refresh_fuel_reading_delta_after_warehouse_update"),
    );
    expect(generatorRefresh).toContain("limit 500");
    expect(generatorRefresh).toContain("order by r.recorded_at desc,r.id desc");
    expect(generatorRefresh).toContain("order by case when plan_row.alert_type='overdue' then 0");
    expect(warehouseRefresh).toContain("limit 500");
    expect(warehouseRefresh).toContain("order by r.recorded_at desc,r.id desc");
    expect(operationalMigration).toContain("after insert or update or delete on public.generator_fuel_readings");
    expect(operationalMigration).toContain("after insert or update or delete on public.generator_maintenance_preventive_plans");
    expect(operationalMigration).toContain("after insert or update or delete on public.generator_maintenance_alert_events");
    expect(operationalMigration).toContain("'reference_no',null");
    expect(operationalMigration).toContain("'correction_reason',null");
    expect(operationalMigration).not.toContain("'unit_cost'");
    expect(operationalMigration).not.toContain("'total_cost_amount'");
    expect(operationalMigration).not.toContain("'labor_cost'");
    expect(operationalMigration).not.toContain("'external_service_cost'");
    expect(operationalMigration).toContain("revoke all on function public.powerhub_pull_operational_sync_delta");
    expect(operationalMigration).toContain("to service_role");
    expect(router).toContain("requireDeltaOperationalReadAccess");
    expect(router).toContain("manageFuelAndConsumption");
    expect(router).toContain("maintenance_preventive_plans");
    expect(client).toContain('"fuel_readings"');
    expect(client).toContain('"maintenance_preventive_plans"');
  });
});


describe("fuel event, maintenance work-order and per-order parts Delta extension", () => {
  it("uses scoped bounded snapshots and a separate cursor for every work-order parts list", () => {
    expect(fuelMaintenanceMigration).toContain("powerhub_project_fuel_event_delta_row");
    expect(fuelMaintenanceMigration).toContain("powerhub_project_maintenance_work_order_delta_row");
    expect(fuelMaintenanceMigration).toContain("powerhub_project_maintenance_work_order_part_delta_row");
    expect(fuelMaintenanceMigration).toContain("powerhub_get_fuel_maintenance_sync_snapshot");
    expect(fuelMaintenanceMigration).toContain("powerhub_pull_fuel_maintenance_sync_delta");
    expect(fuelMaintenanceMigration).toContain("limit 500");
    expect(fuelMaintenanceMigration).toContain("limit 200");
    expect(fuelMaintenanceMigration).toContain("'maintenance_work_order_parts:'||p_work_order_id::text");
    expect(fuelMaintenanceMigration).toContain("POWERHUB_SYNC_WORK_ORDER_OUT_OF_SCOPE");
    expect(fuelMaintenanceMigration).toContain("after insert or update or delete on public.generator_fuel_events");
    expect(fuelMaintenanceMigration).toContain("after insert or update or delete on public.generator_maintenance_work_orders");
    expect(fuelMaintenanceMigration).toContain("after insert or update or delete on public.generator_maintenance_work_order_parts");
    expect(fuelMaintenanceMigration).toContain("revoke all on function public.powerhub_pull_fuel_maintenance_sync_delta");
    expect(fuelMaintenanceMigration).toContain("grant execute on function public.powerhub_pull_fuel_maintenance_sync_delta");
    expect(fuelMaintenanceMigration).not.toContain("'unit_cost',e.unit_cost");
    expect(fuelMaintenanceMigration).not.toContain("'total_cost_amount',e.total_cost_amount");
    expect(router).toContain("requireDeltaFuelMaintenanceReadAccess");
    expect(router).toContain("powerhub_pull_fuel_maintenance_sync_delta");
    expect(router).toContain("powerhub_get_fuel_maintenance_sync_snapshot");
    expect(client).toContain('"fuel_events"');
    expect(client).toContain('"maintenance_work_orders"');
    expect(client).toContain('`maintenance_work_order_parts:${number}`');
  });
});
