import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../supabase/migrations/20261024210000_powerhub_offline_write_acl_hardening.sql",
  import.meta.url,
);
const deviceLockMigrationUrl = new URL(
  "../supabase/migrations/20261024210500_powerhub_device_lock_schema_reconciliation.sql",
  import.meta.url,
);
const quotaAclMigrationUrl = new URL(
  "../supabase/migrations/20261025010000_powerhub_quota_alert_acl_hardening.sql",
  import.meta.url,
);
const schemaReconciliationMigrationUrl = new URL(
  "../supabase/migrations/20261025101753_powerhub_missing_schema_and_rpc_reconciliation.sql",
  import.meta.url,
);
const notificationTriggerMigrationUrl = new URL(
  "../supabase/migrations/20261024211000_powerhub_notification_trigger_rpc_hardening.sql",
  import.meta.url,
);
const browserDmlReconcileMigrationUrl = new URL(
  "../supabase/migrations/20261030200000_powerhub_browser_direct_dml_acl_reconcile.sql",
  import.meta.url,
);
const browserDmlReconcileTestUrl = new URL(
  "../supabase/tests/browser_direct_dml_acl_reconcile.sql",
  import.meta.url,
);
const canonicalRlsMigrationUrl = new URL(
  "../supabase/migrations/20261030210000_powerhub_canonical_tenant_rls_policy_reconcile.sql",
  import.meta.url,
);
const canonicalRlsTestUrl = new URL(
  "../supabase/tests/canonical_tenant_rls_policy_reconcile.sql",
  import.meta.url,
);
const idempotencySchemaMigrationUrl = new URL(
  "../supabase/migrations/20261030220000_powerhub_missing_idempotency_schema_reconcile.sql",
  import.meta.url,
);
const idempotencySchemaTestUrl = new URL(
  "../supabase/tests/missing_idempotency_schema_reconcile.sql",
  import.meta.url,
);
const readMigration = () => readFile(migrationUrl, "utf8");
const readDeviceLockMigration = () => readFile(deviceLockMigrationUrl, "utf8");
const readQuotaAclMigration = () => readFile(quotaAclMigrationUrl, "utf8");
const readSchemaReconciliationMigration = () => readFile(schemaReconciliationMigrationUrl, "utf8");
const readNotificationTriggerMigration = () => readFile(notificationTriggerMigrationUrl, "utf8");
const readBrowserDmlReconcileMigration = () => readFile(browserDmlReconcileMigrationUrl, "utf8");
const readBrowserDmlReconcileTest = () => readFile(browserDmlReconcileTestUrl, "utf8");
const readCanonicalRlsMigration = () => readFile(canonicalRlsMigrationUrl, "utf8");
const readCanonicalRlsTest = () => readFile(canonicalRlsTestUrl, "utf8");
const readIdempotencySchemaMigration = () => readFile(idempotencySchemaMigrationUrl, "utf8");
const readIdempotencySchemaTest = () => readFile(idempotencySchemaTestUrl, "utf8");

describe("offline server-write ACL hardening migration", () => {
  it("revokes direct write privileges from public browser roles on core records", async () => {
    const migration = await readMigration();
    expect(migration).toMatch(
      /revoke\s+insert,\s*update,\s*delete,\s*truncate,\s*references,\s*trigger,\s*maintain\s+on table\s+public\.invoices,\s*public\.offline_sync_operations,\s*public\.payments,\s*public\.subscribers\s+from\s+public,\s*anon,\s*authenticated\s*;/i,
    );
  });

  it("revokes direct execution of subscriber update and payment approval RPCs", async () => {
    const migration = await readMigration();
    expect(migration).toMatch(
      /revoke\s+execute\s+on function\s+public\.powerhub_update_subscriber\s*\(\s*bigint,\s*bigint,\s*bigint,\s*bigint,\s*text,\s*text,\s*text,\s*text,\s*text,\s*timestamptz,\s*uuid\s*\)\s+from\s+public,\s*anon,\s*authenticated\s*;/i,
    );
    expect(migration).toMatch(
      /revoke\s+execute\s+on function\s+public\.powerhub_approve_payment_documentation\s*\(\s*bigint,\s*bigint,\s*bigint,\s*bigint\s*\)\s+from\s+public,\s*anon,\s*authenticated\s*;/i,
    );
  });

  it("does not replace the audited server path with browser-role write grants", async () => {
    const migration = await readMigration();
    expect(migration).not.toMatch(/grant\s+(?:insert|update|delete|truncate|all)\b/i);
    expect(migration).not.toMatch(/grant\s+execute\s+on function\b/i);
  });
  
  it("reconciles the device-lock schema and preserves cross-tab login serialization", async () => {
    const migration = await readDeviceLockMigration();
    expect(migration).toMatch(/create table if not exists public\.powerhub_user_device_locks/i);
    expect(migration).toMatch(/references auth\.users\(id\) on delete cascade/i);
    expect(migration).toMatch(/pg_advisory_xact_lock\([\s\S]*hashtextextended\(p_user_id::text, 0\)/i);
    expect(migration).toMatch(/revoke all on function public\.powerhub_claim_user_device\(uuid, uuid, timestamptz\)[\s\S]*from public, anon, authenticated/i);
    expect(migration).toMatch(/grant execute on function public\.powerhub_claim_user_device\(uuid, uuid, timestamptz\)[\s\S]*to service_role/i);
    expect(migration).toMatch(/create or replace function public\.powerhub_release_user_device/i);
  });
  
  it("revokes direct execution of notification trigger functions without dropping their trigger wiring", async () => {
    const migration = await readNotificationTriggerMigration();
    expect(migration).toMatch(/revoke execute on function public\.powerhub_notify_admin_pending_request\(\)\s+from public, anon, authenticated/i);
    expect(migration).toMatch(/revoke execute on function public\.powerhub_notify_field_sync_received\(\)\s+from public, anon, authenticated/i);
    expect(migration).toMatch(/revoke execute on function public\.powerhub_notify_payment_documentation_request\(\)\s+from public, anon, authenticated/i);
    expect(migration).not.toMatch(/drop trigger|drop function|create or replace function/i);
  });
  
  it("locks quota alert table access to the trusted server role", async () => {
    const migration = await readQuotaAclMigration();
    expect(migration).toMatch(/alter table public\.powerhub_quota_alerts enable row level security/i);
    expect(migration).toMatch(/revoke all on table public\.powerhub_quota_alerts from public, anon, authenticated/i);
    expect(migration).toMatch(/grant all on table public\.powerhub_quota_alerts to service_role/i);
    expect(migration).not.toMatch(/grant\s+(?:select|insert|update|delete|all)\b[^;]*\bto\s+(?:public|anon|authenticated)\b/i);
  });
  
  it("reconciles missing production tables and restores current server-only RPC signatures without data backfills", async () => {
    const migration = await readSchemaReconciliationMigration();
    for (const table of [
      "access_recovery_requests", "complaints", "feature_global_control_audit",
      "generator_owner_provisioning_operations", "meters", "password_reset_intents",
      "platform_tariff_policies", "subscription_renewal_operations",
      "tenant_addon_renewal_decisions", "tenant_owner_alerts", "user_quick_action_preferences",
    ]) {
      expect(migration.toLowerCase()).toContain("create table if not exists public." + table);
      expect(migration.toLowerCase()).toContain("alter table public." + table + " enable row level security");
    }
    const normalizedMigration = migration.toLowerCase().replace(/\s+/g, " ");
    expect(normalizedMigration).toContain("grant execute on function public.powerhub_admin_request_owner_access_recovery(bigint, bigint, text, text, text) to service_role");
    expect(normalizedMigration).toContain("grant execute on function public.powerhub_admin_renew_subscription_with_addons(bigint, bigint, timestamp with time zone, text, jsonb, uuid) to service_role");
    expect(normalizedMigration).toContain("revoke all on table public.generator_owner_provisioning_operations from public, anon, authenticated, service_role");
    expect(normalizedMigration).toContain("grant all on table public.generator_owner_provisioning_operations to service_role");
    expect(normalizedMigration).toContain("alter table public.offline_sync_operations add column if not exists request_fingerprint text;");
    expect(normalizedMigration).toContain("alter table public.notification_messages alter column scheduled_at set default now();");
    expect(normalizedMigration).toContain("alter table public.notification_messages alter column scheduled_at set not null;");
    expect(normalizedMigration).toContain("where scheduled_at is null");
    expect(normalizedMigration).toContain("drop function if exists public.powerhub_admin_request_owner_access_recovery(bigint,bigint,text)");
    expect(normalizedMigration).toContain("drop function if exists public.powerhub_admin_renew_subscription_with_addons(bigint,bigint,timestamptz,jsonb,uuid)");
  });

  it("reconciles every staging-only browser DML grant without changing reads, RLS or service-role writes", async () => {
    const migration = (await readBrowserDmlReconcileMigration()).toLowerCase().replace(/\s+/g, " ");
    const integration = (await readBrowserDmlReconcileTest()).toLowerCase();
    const expectedTables = [
      "access_invitations", "collector_sessions", "company_account_sites", "custom_permission_roles",
      "emergency_requests", "employee_adjustments", "employee_attendance", "employees",
      "financial_settlements", "invoice_lines", "mobile_api_sessions", "mobile_sync_events",
      "payroll_items", "payroll_runs", "platform_access_invitations", "platform_role_policies",
      "platform_sms_plans", "site_portal_settings", "sms_dispatch_queue", "sms_package_requests",
      "staff_profiles", "subscription_upgrade_requests", "tariffs", "tenant_branch_settings",
      "tenant_messaging_configurations", "tenant_owner_profiles", "tenant_subscriptions", "tenants",
      "tweet_sms_report_snapshots", "users",
    ];
    expect(migration).toContain("revoke insert, update, delete, truncate on table public.%i from public, anon, authenticated");
    expect(migration).toContain("to_regclass(format('public.%i', v_table)) is not null");
    for (const table of expectedTables) {
      expect(migration).toContain("'" + table + "'");
      expect(integration).toContain("create table public." + table);
      expect(integration).toContain("public." + table);
    }
    expect(integration).toContain("re-run the forward-only reconciliation to assert idempotency");
    expect(integration).toContain("service_role");
    expect(integration).toContain("anon_select_removed_on_%");
    expect(integration).toContain("authenticated_select_removed_on_%");
    expect(integration).toContain("test_tenant_access");
  });
  it("restores the production idempotency columns and unique replay indexes", async () => {
    const migration = (await readIdempotencySchemaMigration()).toLowerCase();
    const integration = (await readIdempotencySchemaTest()).toLowerCase();
    for (const table of ["access_invitations", "custom_permission_roles", "platform_access_invitations"]) {
      expect(migration).toContain("alter table public." + table);
      expect(migration).toContain("add column if not exists client_operation_id text");
      expect(migration).toContain("add column if not exists request_fingerprint text");
      expect(integration).toContain("public." + table);
    }
    expect(migration).toContain("access_invitations_client_operation_id_uidx");
    expect(migration).toContain("custom_permission_roles_operation_uidx");
    expect(migration).toContain("platform_access_invitations_client_operation_id_uidx");
    expect(integration).toContain("access_invitation_operation_duplicate_allowed");
    expect(integration).toContain("custom_role_operation_duplicate_allowed");
    expect(integration).toContain("platform_invitation_operation_duplicate_allowed");
    expect(integration).toContain("existing_rows_changed_during_idempotency_reconcile");
  });

  it("keeps the canonical RLS integration fixture aligned with live tenant behavior", async () => {
    const integration = (await readCanonicalRlsTest()).toLowerCase();
    expect(integration).toContain("grant usage on schema auth to authenticated");
    expect(integration).toContain("current_setting('test.tenant_id', true)");
    expect(integration).toContain("current_setting('test.platform_admin', true)");
    expect(integration).toContain("cross_tenant_employee_insert_was_allowed");
    expect(integration).toContain("cross_tenant_payroll_item_insert_was_allowed");
    expect(integration).toContain("platform_admin_policy_scope_mismatch");
    expect(integration).toContain("legacy_browser_privilege_remains");
  });

  it("reconciles canonical tenant and platform RLS boundaries without leaving permissive drift", async () => {
    const migration = (await readCanonicalRlsMigration()).toLowerCase().replace(/\\s+/g, " ");
    const integration = (await readCanonicalRlsTest()).toLowerCase();
    const expectedTables = [
      "access_invitations", "collector_sessions", "company_account_sites", "custom_permission_roles",
      "employee_adjustments", "employee_attendance", "employees", "financial_settlements", "invoice_lines",
      "invoices", "invoice_share_links", "messaging_schedule_runs", "mobile_api_sessions", "mobile_sync_events",
      "notification_messages", "offline_sync_operations", "payments", "payroll_runs", "site_portal_settings",
      "sms_package_requests", "staff_profiles", "subscribers", "subscription_upgrade_requests", "tariffs",
      "tenant_branch_settings", "tenant_messaging_configurations", "tenant_owner_profiles", "tenant_subscriptions",
      "tenant_invoice_message_templates", "tenant_payment_receipt_message_templates", "tenant_tweetsms_accounts",
      "sites", "inventory_items", "inventory_stock_movements", "inventory_warehouses", "suppliers",
      "supplier_purchases", "supplier_purchase_lines", "supplier_payments", "supplier_payment_allocations",
      "supplier_ledger_entries", "supplier_purchase_receipts", "supplier_purchase_receipt_lines", "tenant_members",
      "platform_access_invitations", "platform_role_policies", "platform_settings", "platform_sms_fallback_providers",
      "platform_sms_plans", "platform_tweetsms_accounts", "platform_tweetsms_balance_alerts", "payroll_items",
      "payroll_adjustment_allocations", "tenants", "users",
    ];
    expect(migration).toContain("for all to authenticated using");
    expect(migration).toContain("private.powerhub_has_tenant_access(tenant_id)");
    expect(migration).toContain("private.powerhub_is_platform_admin()");
    expect(migration).toContain("auth.uid()");
    expect(migration).toContain("drop policy %i on public.%i");
    expect(migration).toContain("c.relrowsecurity = true");
    expect(migration).toContain("powerhub_canonical_rls_disabled");
    for (const table of expectedTables) {
      expect(migration).toContain("'" + table + "'");
      expect(integration).toContain("create table public." + table);
    }
    expect(integration).toContain("cross_tenant_employee_insert_was_allowed");
    expect(integration).toContain("cross_tenant_payroll_item_insert_was_allowed");
    expect(integration).toContain("platform_admin_policy_scope_mismatch");
    expect(integration).toContain("set role authenticated");
    expect(integration).toContain("reset role");
  });
});
