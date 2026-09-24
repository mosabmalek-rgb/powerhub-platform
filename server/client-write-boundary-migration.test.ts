import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = resolve(
  process.cwd(),
  "supabase/migrations/20260924110000_powerhub_client_write_boundary_reconciled.sql",
);

const migration = readFileSync(migrationPath, "utf8");

const protectedTables = [
  "collector_sessions",
  "complaints",
  "custom_permission_roles",
  "employee_adjustments",
  "employee_attendance",
  "employees",
  "generators",
  "meter_readings",
  "meters",
  "sites",
  "staff_profiles",
  "subscribers",
  "tenant_branch_settings",
  "tenant_invoice_message_templates",
  "tenant_messaging_configurations",
  "tenant_owner_profiles",
  "tenant_payment_receipt_message_templates",
  "tenant_subscriptions",
  "tenants",
  "access_invitations",
  "access_recovery_requests",
  "audit_logs",
  "company_account_sites",
  "invoice_share_links",
  "messaging_schedule_runs",
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
  "sms_package_requests",
  "subscription_upgrade_requests",
  "tariffs",
  "tenant_members",
  "tenant_tweetsms_accounts",
  "user_quick_action_preferences",
];

describe("client write-boundary reconciliation migration", () => {
  it("revokes browser DML from every protected application table", () => {
    const revokeBlock = migration
      .split(/\n\n/)
      .filter((block) => /^revoke insert, update, delete, truncate on table/m.test(block))
      .join("\n");

    expect(revokeBlock).toContain("from public, anon, authenticated");
    for (const table of protectedTables) {
      expect(revokeBlock).toContain(`public.${table}`);
    }
  });

  it("removes the authority-bearing users self-update policy", () => {
    expect(migration).toContain("drop policy if exists users_self_update on public.users;");
    expect(migration).toContain(
      "revoke insert, update, delete, truncate on table public.users",
    );
  });

  it("does not revoke service_role", () => {
    expect(migration).not.toMatch(/from[^;]*service_role/i);
    expect(migration).not.toMatch(/revoke[^;]*service_role/i);
  });
});
