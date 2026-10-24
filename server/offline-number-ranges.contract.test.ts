import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20261024120000_powerhub_offline_number_range_foundation.sql"),
  "utf8",
);
const route = readFileSync(resolve(process.cwd(), "server/powerhub-offline-numbering.ts"), "utf8");
const client = readFileSync(resolve(process.cwd(), "client/src/lib/offline-number-ranges.ts"), "utf8");

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
    expect(route).toContain('supabaseAdmin().rpc("powerhub_reserve_offline_number_grant"');
  });

  it("uses stable local claims and rejects cross-user/site/device reuse", () => {
    expect(client).toContain('createIndex("byGrantNumber", ["grantId", "numberValue"], { unique: true })');
    expect(client).toContain('createIndex("byOperation", ["userId", "clientOperationId", "entityType"], { unique: true })');
    expect(client).toContain("GRANT_SCOPE_MISMATCH");
    expect(client).toContain("OPERATION_IDEMPOTENCY_MISMATCH");
    expect(client).toContain("GRANT_EXHAUSTED");
  });
});
