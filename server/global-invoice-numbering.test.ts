import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("global invoice numbering contract", () => {
  const migration = readFileSync(
    resolve(process.cwd(), "supabase/migrations/20260911170000_powerhub_global_invoice_numbers.sql"),
    "utf8",
  );

  it("uses the global annual INV-YYYY-NNNN format", () => {
    expect(migration).toContain("v_invoice_no:=format('INV-%s-%s',v_invoice_year,lpad(v_sequence::text,4,'0'))");
    expect(migration).toContain("v_invoice_year:=left(p_billing_period,4)::integer");
  });

  it("uses a persistent per-year allocator instead of counting invoices", () => {
    expect(migration).toContain("create table if not exists public.powerhub_invoice_sequences");
    expect(migration).toContain("insert into public.powerhub_invoice_sequences(invoice_year,next_sequence)");
    expect(migration).toContain("on conflict (invoice_year) do update");
    expect(migration).toContain("set next_sequence=public.powerhub_invoice_sequences.next_sequence+1");
    expect(migration).not.toContain("select count(*)::integer+1 into v_sequence");
    expect(migration).not.toContain("pg_advisory_xact_lock(hashtext('powerhub-global-invoice:'||v_invoice_year))");
  });

  it("seeds existing global invoice numbers without site-scoped allocation", () => {
    expect(migration).toContain("^INV-([0-9]{4})-([0-9]{4})$");
    expect(migration).toContain("greatest(max(years.sequence_no)+1,1)");
    expect(migration).not.toContain("where site_id=p_site_id");
  });

  it("keeps the database uniqueness guard and service-role RPC contract", () => {
    expect(migration).toContain("revoke execute on function public.powerhub_issue_invoice_from_reading");
    expect(migration).toContain("grant execute on function public.powerhub_issue_invoice_from_reading");
  });
});
