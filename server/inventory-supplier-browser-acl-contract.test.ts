import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Release regression: supplier browser SELECT is revoked only when inventory
// UI stays behind server-side capability checks and the admin Supabase client.
const read = (file: string) => readFileSync(resolve(process.cwd(), file), "utf8");

const supplierTables = [
  "suppliers",
  "supplier_purchases",
  "supplier_purchase_lines",
  "supplier_purchase_receipts",
  "supplier_purchase_receipt_lines",
  "supplier_payments",
  "supplier_payment_allocations",
  "supplier_ledger_entries",
  "supplier_purchase_returns",
  "supplier_purchase_return_lines",
] as const;

const inventoryClients = [
  "client/src/pages/InventoryWorkspacePage.tsx",
  "client/src/components/InventoryDashboardPanel.tsx",
  "client/src/components/InventoryPurchasesPanel.tsx",
  "client/src/components/InventorySupplierPaymentsPanel.tsx",
  "client/src/components/InventorySupplierPayablesAgingPanel.tsx",
  "client/src/components/InventoryReportsPanel.tsx",
  "client/src/components/InventoryStockOperationsPanel.tsx",
];

describe("supplier browser SELECT revoke release contract", () => {
  it("keeps inventory supplier consumers on tRPC instead of direct browser PostgREST", () => {
    for (const file of inventoryClients) {
      const source = read(file);
      expect(source, file).toContain("trpc.powerhub.inventory.");
      for (const table of supplierTables) {
        expect(source, file + ": browser read of " + table)
          .not.toContain('.from("' + table + '")');
        expect(source, file + ": browser read of " + table)
          .not.toContain(".from('" + table + "')");
      }
    }
  });

  it("requires capabilities and tenant/site scopes on server supplier paths", () => {
    const server = read("server/powerhub-inventory-router.ts");
    expect(server).toContain('requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "viewSuppliers")');
    expect(server).toContain('requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "viewSupplierLedger")');
    expect(server).toContain('requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "manageSupplierPayments")');
    expect(server).toContain('supabaseAdmin().from("suppliers")');
    expect(server).toContain('supabaseAdmin().from("supplier_payments")');
    expect(server).toContain('.eq("tenant_id", access.tenantId)');
    expect(server).toContain('.eq("site_id", input.siteId)');
    expect(server).toContain('supabaseAdmin().rpc("powerhub_inventory_supplier_payables_aging"');
    expect(server).toContain('supabaseAdmin().rpc("powerhub_inventory_supplier_ledger_statement"');
  });

  it("revokes table and per-column browser grants for all ten supplier tables", () => {
    const migration = read("supabase/migrations/20261107150000_powerhub_supplier_browser_read_acl_revoke.sql");
    for (const table of supplierTables) expect(migration).toContain("'" + table + "'");
    expect(migration).toContain("REVOKE ALL PRIVILEGES ON TABLE public.%I FROM PUBLIC, anon, authenticated");
    expect(migration).toContain("REVOKE SELECT (%I) ON TABLE public.%I FROM PUBLIC, anon, authenticated");
    expect(migration).toContain("has_any_column_privilege('authenticated', target_oid, 'SELECT')");
    expect(migration).toContain("has_table_privilege('service_role', target_oid, 'SELECT')");
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'");
  });
});
