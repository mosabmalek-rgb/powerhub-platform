import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migration = readFileSync(resolve(process.cwd(), "supabase/migrations/20261024140000_powerhub_delta_sync_engine.sql"), "utf8");
const router = readFileSync(resolve(process.cwd(), "server/powerhub.ts"), "utf8");
const client = readFileSync(resolve(process.cwd(), "client/src/lib/offline-delta-sync.ts"), "utf8");

describe("PowerHub delta sync contract", () => {
  it("keeps the change journal private and callable only through the server role", () => {
    expect(migration).toContain("alter table public.powerhub_sync_changes enable row level security");
    expect(migration).toContain("revoke all on table public.powerhub_sync_changes from public, anon, authenticated");
    expect(migration).toContain("grant execute on function public.powerhub_pull_sync_delta");
    expect(migration).toContain("to service_role");
    expect(migration).toContain("revoke all on function public.powerhub_pull_sync_delta");
  });

  it("uses a per-scope transactional cursor rather than a global identity sequence", () => {
    expect(migration).toContain("primary key (tenant_id, site_id, entity_type)");
    expect(migration).toContain("last_cursor = public.powerhub_sync_scope_state.last_cursor + 1");
    expect(migration).toContain("retained_from_cursor");
    expect(migration).toContain("'reset_required'");
    expect(migration).not.toMatch(/create\s+sequence\s+public\.powerhub_sync/i);
  });

  it("records insert, update, delete and archive events for supported operational entities", () => {
    for (const table of ["sites", "subscribers", "generators", "meter_readings", "tariffs"]) {
      expect(migration).toContain(`on public.${table}`);
    }
    expect(migration).toContain("after insert or update or delete on public.subscribers");
    expect(migration).toContain("coalesce(v_new ->> 'archived_at', '') <> ''");
    expect(migration).toContain("'delete', null");
  });

  it("checks authenticated site scope and a per-entity capability before calling the private RPC", () => {
    expect(router).toContain("deltaSync: router({");
    expect(router).toContain('entityType: z.enum(["sites", "subscribers", "generators", "readings", "tariffs"])');
    expect(router).toContain("requireSupabaseSiteRole(");
    expect(router).toContain('supabaseAdmin().rpc("powerhub_pull_sync_delta"');
    expect(router).toContain("input.pageSize");
  });

  it("uses string cursors and fixed page boundaries and refuses unordered or mismatched changes", () => {
    expect(client).toContain("BigInt(assertCursor(a))");
    expect(client).toContain("throughCursor: through");
    expect(client).toContain("change.row_data[idKey]");
    expect(client).toContain("page.through_cursor");
    expect(client).toContain("setDeltaCursor");
  });
});
