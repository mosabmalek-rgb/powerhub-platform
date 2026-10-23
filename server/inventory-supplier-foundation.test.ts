import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20261021085533_powerhub_inventory_supplier_foundation.sql"),
  "utf8",
);
const coreDmlAclMigration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20261023151939_powerhub_core_financial_direct_dml_hardening.sql"),
  "utf8",
);
const generatorReadingDmlAclMigration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20261023153000_powerhub_generator_reading_direct_dml_hardening.sql"),
  "utf8",
);
const membershipRlsMigration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20261023161000_powerhub_membership_rls_scope_alignment.sql"),
  "utf8",
);

describe("PowerHub inventory and supplier-ledger foundation", () => {
  it("creates tenant-scoped catalog, warehouses, suppliers, purchases, stock movements, and supplier ledger", () => {
    for (const table of [
      "inventory_items",
      "inventory_warehouses",
      "suppliers",
      "supplier_purchases",
      "supplier_purchase_lines",
      "inventory_stock_movements",
      "supplier_payments",
      "supplier_payment_allocations",
      "supplier_ledger_entries",
    ]) {
      expect(migration).toContain(`create table public.${table}`);
      expect(migration).toContain(`alter table public.%I enable row level security`);
    }
    expect(migration).toContain("foreign key (tenant_id, site_id) references public.sites (tenant_id, id)");
    expect(migration).toContain("foreign key (tenant_id, supplier_id) references public.suppliers (tenant_id, id)");
    expect(migration).toContain("foreign key (tenant_id, item_id) references public.inventory_items (tenant_id, id)");
  });

  it("makes purchase posting and stock movement operations idempotent", () => {
    expect(migration).toContain("unique (tenant_id, operation_key)");
    expect(migration).toContain("unique (tenant_id, purchase_number)");
    expect(migration).toContain("create index inventory_stock_movements_purchase_idx");
    expect(migration).toContain("supplier_ledger_purchase_entry_unique_idx");
    expect(migration).toContain("supplier_ledger_payment_entry_unique_idx");
  });

  it("supports split receipts, due dates, partial payments, and payment allocation", () => {
    expect(migration).toContain("partially_received");
    expect(migration).toContain("received_quantity numeric(14,3)");
    expect(migration).toContain("due_date date");
    expect(migration).toContain("create table public.supplier_payment_allocations");
    expect(migration).toContain("create table public.supplier_ledger_entries");
  });

  it("reuses company accounts and links supplier payments to the existing account ledger", () => {
    expect(migration).toContain("company_account_id bigint not null");
    expect(migration).toContain("references public.company_accounts (tenant_id, id)");
    expect(migration).toContain("related_supplier_payment_id");
    expect(migration).toContain("references public.supplier_payments (tenant_id, id)");
    expect(migration).not.toContain("create table public.supplier_company_accounts");
  });

  it("allows authenticated tenant reads only and blocks direct client mutations", () => {
    expect(migration).toContain("powerhub_private.current_tenant_ids()");
    expect(migration).toContain("powerhub_private.is_platform_user()");
    expect(migration).toContain("revoke insert, update, delete, truncate, references, trigger on table public.%I from authenticated");
    expect(migration).toContain("grant select on table public.%I to authenticated");
    expect(migration).toContain("revoke all on table public.%I from public, anon");
  });

  it("blocks direct client DML on account and financial ledgers without removing read grants", () => {
    expect(coreDmlAclMigration.toLowerCase()).toContain(
      "revoke insert, update, delete, truncate",
    );
    for (const table of ["account_transactions", "audit_logs", "company_accounts", "expenses"]) {
      expect(coreDmlAclMigration).toContain(`public.${table}`);
    }
    expect(coreDmlAclMigration).toContain("from anon, authenticated");
    expect(coreDmlAclMigration.toLowerCase()).not.toContain("revoke select");
    expect(coreDmlAclMigration.toLowerCase()).not.toContain("revoke all");
  });

  it("blocks direct client DML on generator and meter-reading tables", () => {
    expect(generatorReadingDmlAclMigration.toLowerCase()).toContain(
      "revoke insert, update, delete, truncate",
    );
    expect(generatorReadingDmlAclMigration).toContain("public.generators");
    expect(generatorReadingDmlAclMigration).toContain("public.meter_readings");
    expect(generatorReadingDmlAclMigration).toContain("from anon, authenticated");
    expect(generatorReadingDmlAclMigration.toLowerCase()).not.toContain("revoke select");
    expect(generatorReadingDmlAclMigration.toLowerCase()).not.toContain("revoke all");
  });

  it("aligns core tenant RLS with expiry-aware access and excludes support from admin bypass", () => {
    expect(membershipRlsMigration).toContain("tm.expires_at is null or tm.expires_at > now()");
    expect(membershipRlsMigration).toContain("revoke all on function powerhub_private.current_tenant_ids() from public, anon");
    expect(membershipRlsMigration).toContain("revoke all on function powerhub_private.is_platform_user() from public, anon");
    expect(membershipRlsMigration).toContain("create or replace function powerhub_private.has_tenant_access");
    expect(membershipRlsMigration).toContain("create or replace function powerhub_private.is_platform_admin");
    expect(membershipRlsMigration).toContain("'platform_owner', 'platform_admin', 'finance_admin'");
    expect(membershipRlsMigration).not.toContain("'platform_support'");
    expect(membershipRlsMigration).toContain("for all to authenticated");
    expect(membershipRlsMigration).toContain("drop policy if exists generator_tenant_access on public.generators");
    expect(membershipRlsMigration).toContain("drop policy if exists reading_tenant_access on public.meter_readings");
    expect(membershipRlsMigration).not.toContain("to public using");
  });

  it("does not change existing expense records or automatically apply migrations to a live database", () => {
    expect(migration).not.toContain("update public.expenses");
    expect(migration).not.toContain("delete from public.expenses");
    expect(migration).not.toContain("insert into public.expenses");
    expect(migration).not.toContain("drop table public.expenses");
  });
});
