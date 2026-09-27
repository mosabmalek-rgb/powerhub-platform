import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("global invoice numbering contract", () => {
  const migration = readFileSync(resolve(process.cwd(), "supabase/migrations/20260926190000_powerhub_bigint_invoice_allocator.sql"), "utf8");

  it("uses the global annual INV-YYYY-NNNNNNNN format without a 9,999 ceiling", () => {
    expect(migration).toContain("v_invoice_no:=format('INV-%s-%s',v_invoice_year,lpad(v_sequence::text,8,'0'))");
    expect(migration).toContain("v_invoice_year:=left(p_billing_period,4)::integer");
    expect(migration).toContain("alter column next_sequence type bigint");
    expect(migration).not.toContain("9999");
  });

  it("uses a persistent per-year allocator instead of counting invoices", () => {
    expect(migration).toMatch(/insert into public\.powerhub_invoice_sequences\s*\(invoice_year,next_sequence\)/);
    expect(migration).toContain("on conflict (invoice_year) do update");
    expect(migration).toMatch(/set next_sequence=public\.powerhub_invoice_sequences\.next_sequence\+1/);
    expect(migration).not.toMatch(/select\s+count\(\*\).*into\s+v_sequence/i);
    expect(migration).not.toContain("pg_advisory_xact_lock(hashtext('powerhub-global-invoice:'||v_invoice_year))");
  });

  it("uses one allocator contract for direct and mobile approval issuance", () => {
    expect(migration).toContain("create or replace function public.powerhub_issue_invoice_from_reading");
    expect(migration).toContain("create or replace function public.powerhub_approve_and_issue_mobile_reading");
    expect(migration).toContain("on conflict (invoice_year) do update");
    expect(migration).not.toMatch(/\bCOUNT\(\*\)/);
  });

  it("keeps the sequence allocator server-internal", () => {
    expect(migration).toContain("alter table public.powerhub_invoice_sequences enable row level security");
    expect(migration).toMatch(/revoke all on table public\.powerhub_invoice_sequences from public,\s*anon,\s*authenticated/);
    expect(migration).toMatch(/grant select,\s*insert,\s*update on table public\.powerhub_invoice_sequences to service_role/);
  });

  it("keeps the database uniqueness guard and service-role RPC contract", () => {
    expect(migration).toContain("revoke execute on function public.powerhub_issue_invoice_from_reading");
    expect(migration).toContain("grant execute on function public.powerhub_issue_invoice_from_reading");
  });
});
