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

  it("keeps the existing RPC signature and service-role execution contract", () => {
    const migration = readFileSync(
      resolve(process.cwd(), "supabase/migrations/0010_fix_subscriber_create_rpc_ambiguity.sql"),
      "utf8",
    );

    expect(migration).toContain("returns table (subscriber_id bigint, subscriber_no text, replayed boolean)");
    expect(migration).toContain("grant execute on function public.powerhub_create_subscriber(bigint, bigint, bigint, text, text, text, text, text, text, uuid, integer) to service_role;");
  });

  it("locks the global subscriber reference contract", () => {
    const migration = readFileSync(
      resolve(process.cwd(), "supabase/migrations/20260914160000_powerhub_global_subscriber_numbers.sql"),
      "utf8",
    );

    expect(migration).toContain("create sequence if not exists public.powerhub_subscriber_no_seq");
    expect(migration).toContain("create unique index if not exists subscribers_subscriber_no_global_uidx");
    expect(migration).toContain("check (subscriber_no ~ '^SUB-[0-9]{6}$')");
    expect(migration).toContain("v_subscriber_no := 'SUB-' || lpad(v_sequence::text, 6, '0')");
    expect(migration).toContain("if p_phone is null or btrim(p_phone)='' then");
    expect(migration).not.toContain("generateSubscriberReference(site.code)");
  });
});