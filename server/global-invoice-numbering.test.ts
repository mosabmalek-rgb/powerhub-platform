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
    expect(migration).toContain("invoice_no like 'INV-'||v_invoice_year||'-%'");
  });

  it("serializes allocation globally by invoice year", () => {
    expect(migration).toContain("pg_advisory_xact_lock(hashtext('powerhub-global-invoice:'||v_invoice_year))");
    expect(migration).not.toContain("where site_id=p_site_id");
  });

  it("keeps the database uniqueness guard and service-role RPC contract", () => {
    expect(migration).toContain("revoke execute on function public.powerhub_issue_invoice_from_reading");
    expect(migration).toContain("grant execute on function public.powerhub_issue_invoice_from_reading");
  });
});
