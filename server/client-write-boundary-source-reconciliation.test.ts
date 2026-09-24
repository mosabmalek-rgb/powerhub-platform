import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = resolve(
  process.cwd(),
  "supabase/migrations/20260924130000_powerhub_client_write_boundary_source_reconciliation.sql",
);

const migration = readFileSync(migrationPath, "utf8");

const protectedTables = [
  "access_invitations",
  "access_recovery_requests",
  "audit_logs",
  "collector_sessions",
  "company_account_sites",
  "complaints",
  "custom_permission_roles",
  "employee_adjustments",
  "employee_attendance",
  "employees",
  "generators",
  "invoice_share_links",
  "messaging_schedule_runs",
  "meter_readings",
  "meters",
  "mobile_api_sessions",
  "mobile_sync_events",
  "notification_messages",
  "offline_sync_operations",
  "platform_access_invitations",
  "platform_role_policies",
  "platform_security_events",
  "platform_security_settings",
  "platform_settings",
  "platform_sms_fallback_providers",
  "platform_sms_plans",
  "platform_tariff_policies",
  "platform_tweetsms_accounts",
  "platform_tweetsms_balance_alerts",
  "site_portal_settings",
  "sites",
  "sms_package_requests",
  "staff_profiles",
  "subscribers",
  "subscription_upgrade_requests",
  "tariffs",
  "tenant_branch_settings",
  "tenant_invoice_message_templates",
  "tenant_members",
  "tenant_messaging_configurations",
  "tenant_owner_profiles",
  "tenant_payment_receipt_message_templates",
  "tenant_subscriptions",
  "tenant_tweetsms_accounts",
  "tenants",
  "user_quick_action_preferences",
  "users",
];

describe("client write boundary source reconciliation", () => {
  it("covers every protected table", () => {
    for (const table of protectedTables) {
      expect(migration).toContain(`public.${table}`);
    }
  });

  it("revokes all browser DML verbs from the client roles", () => {
    expect(migration.match(/revoke insert, update, delete, truncate on table/g)?.length).toBe(3);
    expect(migration.match(/from public, anon, authenticated/g)?.length).toBe(2);
    expect(migration).toContain(
      "revoke insert, update, delete, truncate on table public.users",
    );
  });

  it("does not revoke service_role", () => {
    expect(migration).not.toMatch(/revoke[^;]*service_role/i);
    expect(migration).not.toMatch(/from[^;]*service_role/i);
  });

  it("removes the legacy authority-bearing self-update policy", () => {
    expect(migration).toContain(
      "drop policy if exists users_self_update on public.users;",
    );
  });
});
