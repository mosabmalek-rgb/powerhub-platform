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
  "../supabase/migrations/20261025020000_powerhub_missing_schema_and_rpc_reconciliation.sql",
  import.meta.url,
);
const notificationTriggerMigrationUrl = new URL(
  "../supabase/migrations/20261024211000_powerhub_notification_trigger_rpc_hardening.sql",
  import.meta.url,
);
const readMigration = () => readFile(migrationUrl, "utf8");
const readDeviceLockMigration = () => readFile(deviceLockMigrationUrl, "utf8");
const readQuotaAclMigration = () => readFile(quotaAclMigrationUrl, "utf8");
const readSchemaReconciliationMigration = () => readFile(schemaReconciliationMigrationUrl, "utf8");
const readNotificationTriggerMigration = () => readFile(notificationTriggerMigrationUrl, "utf8");

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
});
