import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("subscriber create P1 regression", () => {
  it("qualifies subscriber columns in the RPC replay lookup and count", () => {
    const migration = readFileSync(
      resolve(process.cwd(), "supabase/migrations/0010_fix_subscriber_create_rpc_ambiguity.sql"),
      "utf8",
    );

    expect(migration).toContain("from public.subscribers as s");
    expect(migration).toContain("where s.client_operation_id = p_client_operation_id::text");
    expect(migration).toContain("where s.tenant_id = p_tenant_id");
    expect(migration).toContain("returning subscribers.id, subscribers.subscriber_no");
    expect(migration).not.toContain("from public.subscribers\n    where client_operation_id");
  });

  it("locks the current server-generated global subscriber-number contract", () => {
    const migration = readFileSync(
      resolve(process.cwd(), "supabase/migrations/20260916230000_powerhub_global_subscriber_number_source.sql"),
      "utf8",
    );

    expect(migration).toContain("create sequence if not exists public.subscriber_global_number_seq");
    expect(migration).toContain("create unique index if not exists subscribers_subscriber_no_global_uidx");
    expect(migration).toContain("format('SUB-%s', lpad(nextval('public.subscriber_global_number_seq')::text, 6, '0'))");
    expect(migration).toContain("p_full_name text,");
    expect(migration).toContain("p_phone text,");
    expect(migration).not.toContain("p_subscriber_no text");
    expect(migration).not.toContain("generateSubscriberReference(site.code)");
    expect(migration).toContain("revoke all on function public.powerhub_create_subscriber(bigint, bigint, bigint, text, text, text, text, text, uuid, integer) from public, anon, authenticated;");
    expect(migration).toContain("grant execute on function public.powerhub_create_subscriber(bigint, bigint, bigint, text, text, text, text, text, uuid, integer) to service_role;");
  });
});
