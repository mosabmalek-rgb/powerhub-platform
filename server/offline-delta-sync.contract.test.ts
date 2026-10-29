import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migration = readFileSync(resolve(process.cwd(), "supabase/migrations/20261024140000_powerhub_delta_sync_engine.sql"), "utf8");
const invoiceMigration = readFileSync(resolve(process.cwd(), "supabase/migrations/20261027110000_powerhub_delta_invoice_history.sql"), "utf8");
const paymentMigration = readFileSync(resolve(process.cwd(), "supabase/migrations/20261027130000_powerhub_delta_payment_history.sql"), "utf8");
const expenseMigration = readFileSync(resolve(process.cwd(), "supabase/migrations/20261027140000_powerhub_delta_expense_history.sql"), "utf8");
const inventoryMigration = readFileSync(resolve(process.cwd(), "supabase/migrations/20261029000000_powerhub_delta_inventory_catalog.sql"), "utf8");
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
    expect(router).toContain('entityType: z.enum(["sites", "subscribers", "generators", "readings", "tariffs", "invoices", "payments", "expenses", "company_accounts", "company_accounts_all", "inventory_items", "inventory_item_units", "suppliers", "inventory_warehouses", "inventory_stock_movements"])');
    expect(router).toContain("requireSupabaseSiteRole(");
    expect(router).toContain('inventoryCatalogEntity ? "powerhub_pull_inventory_sync_delta" : "powerhub_pull_sync_delta"');
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
