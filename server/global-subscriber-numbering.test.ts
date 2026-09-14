import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("global subscriber numbering contract", () => {
  const migration = readFileSync(
    resolve(process.cwd(), "supabase/migrations/20260914160000_powerhub_global_subscriber_numbers.sql"),
    "utf8",
  );

  it("uses the official SUB-000001 format", () => {
    expect(migration).toContain("create sequence if not exists public.powerhub_subscriber_no_seq");
    expect(migration).toContain("v_subscriber_no := 'SUB-' || lpad(v_sequence::text, 6, '0')");
    expect(migration).toContain("^SUB-[0-9]{6}$");
  });

  it("allocates globally from Supabase instead of accepting a browser reference", () => {
    expect(migration).toContain("v_sequence := nextval('public.powerhub_subscriber_no_seq')");
    expect(migration).toContain("p_subscriber_no text");
    expect(migration).not.toContain("p_subscriber_no, p_full_name");
  });

  it("makes subscriber references globally unique and immutable", () => {
    expect(migration).toContain("subscribers_subscriber_no_global_uidx");
    expect(migration).toContain("SUBSCRIBER_REFERENCE_IMMUTABLE");
    expect(migration).toContain("before update on public.subscribers");
  });

  it("does not expose the allocator sequence to browser roles", () => {
    expect(migration).toContain("revoke all on sequence public.powerhub_subscriber_no_seq from public, anon, authenticated");
    expect(migration).toContain("grant usage, select on sequence public.powerhub_subscriber_no_seq to service_role");
  });

  it("applies the same server-side allocation to bulk imports", () => {
    const allocations = migration.match(/nextval\('public\.powerhub_subscriber_no_seq'\)/g) ?? [];
    expect(allocations.length).toBeGreaterThanOrEqual(2);
    expect(migration).toContain("powerhub_bulk_upsert_subscribers");
  });
});
