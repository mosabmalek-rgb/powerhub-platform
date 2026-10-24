import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20261024120000_powerhub_offline_number_range_foundation.sql"),
  "utf8",
);
const route = readFileSync(resolve(process.cwd(), "server/powerhub-offline-numbering.ts"), "utf8");
const client = readFileSync(resolve(process.cwd(), "client/src/lib/offline-number-ranges.ts"), "utf8");
const queue = readFileSync(resolve(process.cwd(), "client/src/lib/offline-work-queue.ts"), "utf8");
const fieldQueue = readFileSync(resolve(process.cwd(), "client/src/lib/offline-reading-queue.ts"), "utf8");
const workspace = readFileSync(resolve(process.cwd(), "client/src/lib/offline-workspace-db.ts"), "utf8");

describe("PowerHub offline number range foundation contract", () => {
  it("keeps grant and claim records private and enables RLS", () => {
    expect(migration).toContain("alter table public.powerhub_offline_number_grants enable row level security");
    expect(migration).toContain("alter table public.powerhub_offline_number_claims enable row level security");
    expect(migration).toContain("revoke all on table public.powerhub_offline_number_grants from public, anon, authenticated");
    expect(migration).toContain("revoke all on table public.powerhub_offline_number_claims from public, anon, authenticated");
    expect(migration).toContain("grant select, insert, update, delete on table public.powerhub_offline_number_grants to service_role");
  });

  it("allocates from the canonical subscriber sequence without rewriting existing references", () => {
    expect(migration).toContain("public.subscriber_global_number_seq");
    expect(migration).toContain("alter sequence public.subscriber_global_number_seq maxvalue 999999 no cycle");
    expect(migration).toContain("SUBSCRIBER_NUMBER_RECONCILIATION_REQUIRED");
    expect(migration).not.toContain("update public.subscribers s");
  });

  it("keeps number reservation RPCs server-only and locks claimed values idempotently", () => {
    expect(migration).toContain("revoke all on function public.powerhub_reserve_offline_number_grant");
    expect(migration).toContain("grant execute on function public.powerhub_reserve_offline_number_grant");
    expect(migration).toContain("revoke all on function public.powerhub_claim_offline_number");
    expect(migration).toContain("unique (number_kind, partition_key, number_value)");
    expect(migration).toContain("unique (user_id, client_operation_id, entity_type)");
    expect(migration).toContain("OFFLINE_NUMBER_IDEMPOTENCY_MISMATCH");
  });

  it("authorizes each reservation by current site capability and derives device identity from request headers", () => {
    expect(route).toContain('input.numberKind === "subscriber" ? "manageSubscribers" : "issueInvoices"');
    expect(route).toContain("requireSupabaseSiteRole(ctx.user.id, input.siteId");
    expect(route).toContain('ctx.req?.headers?.["x-powerhub-device-id"]');
    expect(route).toContain('supabaseAdmin().rpc("powerhub_claim_user_device"');
    expect(route).toContain("OFFLINE_NUMBER_RANGE_STILL_AVAILABLE");
    expect(route).toContain('supabaseAdmin().rpc("powerhub_reserve_offline_number_grant"');
  });

  it("keeps the outbox, number ranges, delta state, and conflicts in one versioned operational IndexedDB", () => {
    expect(workspace).toContain('OFFLINE_WORKSPACE_DATABASE_NAME = "powerhub-offline-workspace"');
    expect(workspace).toContain("OFFLINE_WORKSPACE_DATABASE_VERSION = 4");
    expect(workspace).toContain('ensureStore(db, tx, "operations", "id")');
    expect(workspace).toContain('ensureStore(db, tx, "grants", "id"');
    expect(workspace).toContain('ensureStore(db, tx, "claims", "id"');
    expect(workspace).toContain('ensureStore(db, tx, "cursors", ["userId", "tenantId", "siteId", "entityType"])');
    expect(workspace).toContain('ensureStore(db, tx, "entities", ["scopeKey", "entityId"]');
    expect(workspace).toContain('ensureStore(db, tx, "syncState"');
    expect(workspace).toContain('ensureStore(db, tx, "conflicts"');
    expect(workspace).toContain('ensureStore(db, tx, "syncMetadata"');
    expect(workspace).toContain('ensureStore(db, tx, "fieldReadings"');
    expect(workspace).toContain('ensureStore(db, tx, "orphanedFieldReadings"');
    expect(fieldQueue).toContain("openOfflineWorkspaceDatabase()");
    expect(fieldQueue).toContain('openLegacyOfflineDatabaseIfPresent(legacyDatabaseName, [legacyStoreName])');
    expect(fieldQueue).toContain('"missing-user-scope"');
    expect(fieldQueue).toContain('"missing-site-scope"');
    expect(queue).toContain("openOfflineWorkspaceDatabase()");
    expect(client).toContain("openOfflineWorkspaceDatabase()");
  });

  it("uses stable local claims and rejects cross-user/site/device reuse", () => {
    expect(workspace).toContain('{ name: "byGrantNumber", keyPath: ["grantId", "numberValue"], unique: true }');
    expect(workspace).toContain('{ name: "byOperation", keyPath: ["userId", "clientOperationId", "entityType"], unique: true }');
    expect(client).toContain("GRANT_SCOPE_MISMATCH");
    expect(client).toContain("OPERATION_IDEMPOTENCY_MISMATCH");
    expect(client).toContain("GRANT_EXHAUSTED");
  });
});
