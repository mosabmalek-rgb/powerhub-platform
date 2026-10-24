import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20261024120000_powerhub_offline_number_range_foundation.sql"),
  "utf8",
);
const route = readFileSync(resolve(process.cwd(), "server/powerhub-offline-numbering.ts"), "utf8");
const powerhubRouter = readFileSync(resolve(process.cwd(), "server/powerhub.ts"), "utf8");
const client = readFileSync(resolve(process.cwd(), "client/src/lib/offline-number-ranges.ts"), "utf8");
const queue = readFileSync(resolve(process.cwd(), "client/src/lib/offline-work-queue.ts"), "utf8");
const fieldQueue = readFileSync(resolve(process.cwd(), "client/src/lib/offline-reading-queue.ts"), "utf8");
const workspace = readFileSync(resolve(process.cwd(), "client/src/lib/offline-workspace-db.ts"), "utf8");
const directory = readFileSync(resolve(process.cwd(), "client/src/pages/NetworkDirectoryPage.tsx"), "utf8");
const syncPanel = readFileSync(resolve(process.cwd(), "client/src/components/OfflineWorkSyncPanel.tsx"), "utf8");
const invoiceReadingMigration = readFileSync(resolve(process.cwd(), "supabase/migrations/20261024160000_powerhub_offline_invoice_number_claim.sql"), "utf8");
const readingsPage = readFileSync(resolve(process.cwd(), "client/src/pages/MeterReadingsPage.tsx"), "utf8");

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

  it("rejects subscriber operation replays across tenant/site scopes", () => {
    expect(migration).toContain("v_operation_tenant_id is distinct from p_tenant_id");
    expect(migration).toContain("v_operation_site_id is distinct from p_site_id");
    expect(migration).toContain("v_existing_tenant_id is distinct from p_tenant_id");
    expect(powerhubRouter).toContain('select("tenant_id, site_id, entity_type, operation_type, response")');
    expect(powerhubRouter).toContain("Number(applied.tenant_id) !== access.tenantId");
    expect(powerhubRouter).toContain("Number(applied.site_id) !== input.siteId");
  });

  it("atomically binds a locally claimed subscriber number to the shared Outbox and server transaction", () => {
    expect(queue).toContain("enqueueOfflineSubscriberCreateWithNumber");
    expect(queue).toContain('database.transaction([storeName, grantsStoreName, claimsStoreName], "readwrite")');
    expect(directory).toContain("enqueueOfflineSubscriberCreateWithNumber");
    expect(directory).toContain("hasAvailableOfflineNumberGrant");
    expect(syncPanel).toContain("offlineNumberClaim");
    expect(powerhubRouter).toContain('admin.rpc("powerhub_create_subscriber_with_offline_number"');
    expect(migration).toContain("create or replace function public.powerhub_create_subscriber_with_offline_number");
  });

  it("atomically binds an offline invoice claim to platform reading and invoice issuance", () => {
    expect(invoiceReadingMigration).toContain("powerhub_create_reading_and_issue_invoice_with_offline_number");
    expect(invoiceReadingMigration).toContain("powerhub_claim_offline_number");
    expect(invoiceReadingMigration).toContain("powerhub.offline_invoice_claim");
    expect(powerhubRouter).toContain('"powerhub_create_reading_and_issue_invoice_with_offline_number"');
    expect(readingsPage).toContain("enqueueReadingWithInvoiceNumber");
    expect(readingsPage).toContain("hasAvailableOfflineNumberGrant");
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
    expect(fieldQueue).toContain("enqueueOfflineWork");
    expect(fieldQueue).toContain("listOfflineWork");
    expect(fieldQueue).toContain('kind: "reading_create"');
    expect(workspace).toContain("ensureLegacyFieldReadingsMigrated");
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
