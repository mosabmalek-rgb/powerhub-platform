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
const generatorReadingIndexMigration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20261023162500_powerhub_generator_reading_index_reconciliation.sql"),
  "utf8",
);
const financialIndexMigration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20261023170000_powerhub_financial_index_trigger_reconciliation.sql"),
  "utf8",
);
const auditEntityContractMigration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20261023171000_powerhub_audit_entity_id_not_null.sql"),
  "utf8",
);
const siteMembershipInventoryReadScopeMigration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20261023175417_powerhub_site_membership_inventory_read_scope.sql"),
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

  it("restores production-proven reading indexes and the generator updated-at trigger", () => {
    for (const index of [
      "generators_created_at_idx",
      "meter_readings_approval_operation_uidx",
      "meter_readings_opening_baseline_idx",
      "meter_readings_status_idx",
      "meter_readings_status_reading_at_idx",
      "meter_readings_subscriber_date_idx",
      "meter_readings_subscriber_id_idx",
      "meter_readings_tenant_reading_at_id_desc_idx",
    ]) {
      expect(generatorReadingIndexMigration).toContain(index);
    }
    expect(generatorReadingIndexMigration).toContain("where approval_client_operation_id is not null");
    expect(generatorReadingIndexMigration).toContain("create trigger generators_set_updated_at");
    expect(generatorReadingIndexMigration).toContain("execute function public.powerhub_set_updated_at()");
  });

  it("restores financial/report indexes and company-account updated-at trigger", () => {
    for (const index of [
      "account_transactions_account_id_idx",
      "account_transactions_payment_id_idx",
      "account_transactions_tenant_account_date_idx",
      "audit_logs_site_id_idx",
      "audit_logs_tenant_site_date_idx",
      "audit_logs_user_id_idx",
      "company_accounts_tenant_idx",
      "expenses_site_created_at_idx",
      "expenses_site_date_idx",
      "expenses_site_occurred_at_id_desc_idx",
      "expenses_tenant_site_idx",
      "expenses_tenant_site_occurred_at_id_idx",
    ]) {
      expect(financialIndexMigration).toContain(index);
    }
    expect(financialIndexMigration).toContain("create trigger company_accounts_set_updated_at");
    expect(financialIndexMigration).toContain("execute function public.powerhub_set_updated_at()");
    expect(financialIndexMigration).not.toContain("create table public.expenses");
    expect(financialIndexMigration).not.toContain("alter table public.expenses add column");
  });

  it("requires audit_logs.entity_id without rewriting existing events", () => {
    expect(auditEntityContractMigration).toContain("AUDIT_LOG_ENTITY_ID_NULL_ROWS_EXIST");
    expect(auditEntityContractMigration).toContain("alter table public.audit_logs");
    expect(auditEntityContractMigration).toContain("alter column entity_id set not null");
    expect(auditEntityContractMigration.toLowerCase()).not.toContain("update public.audit_logs");
    expect(auditEntityContractMigration.toLowerCase()).not.toContain("delete from public.audit_logs");
  });

  it("reconciles site and membership DML and narrows inventory/supplier reads to tenant members and platform admins", () => {
    expect(siteMembershipInventoryReadScopeMigration.toLowerCase()).toContain(
      "revoke insert, update, delete, truncate",
    );
    expect(siteMembershipInventoryReadScopeMigration).toContain("public.sites, public.tenant_members");
    expect(siteMembershipInventoryReadScopeMigration).toContain("private.powerhub_has_tenant_access(bigint)");
    expect(siteMembershipInventoryReadScopeMigration).toContain("private.powerhub_is_platform_admin()");
    for (const table of [
      "inventory_items",
      "inventory_stock_movements",
      "inventory_warehouses",
      "supplier_ledger_entries",
      "supplier_payment_allocations",
      "supplier_payments",
      "supplier_purchase_lines",
      "supplier_purchase_receipt_lines",
      "supplier_purchase_receipts",
      "supplier_purchases",
      "suppliers",
    ]) {
      expect(siteMembershipInventoryReadScopeMigration).toContain(table);
    }
    expect(siteMembershipInventoryReadScopeMigration).toContain("create index if not exists sites_tenant_id_idx");
    expect(siteMembershipInventoryReadScopeMigration).toContain("create index if not exists tenant_members_user_active_idx");
    expect(siteMembershipInventoryReadScopeMigration).toContain("sites_set_updated_at");
    expect(siteMembershipInventoryReadScopeMigration).toContain("tenant_members_set_updated_at");
    expect(siteMembershipInventoryReadScopeMigration).toContain("public.powerhub_set_updated_at()");
    expect(siteMembershipInventoryReadScopeMigration).toContain("for select to authenticated");
    expect(siteMembershipInventoryReadScopeMigration).not.toContain("powerhub_private.is_platform_user()");
  });

  it("does not change existing expense records or automatically apply migrations to a live database", () => {
    expect(migration).not.toContain("update public.expenses");
    expect(migration).not.toContain("delete from public.expenses");
    expect(migration).not.toContain("insert into public.expenses");
    expect(migration).not.toContain("drop table public.expenses");
  });
});
