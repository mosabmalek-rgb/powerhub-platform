import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("optional generator capacity contract", () => {
  it("does not require capacity in the owner API", () => {
    const source = readFileSync("server/powerhub.ts", "utf8");
    expect(source).toContain("ratedCapacityKw: z.string().trim().regex(/^\\d+(\\.\\d{1,3})?$/).optional()");
    expect(source).toContain("rated_capacity_kw: input.ratedCapacityKw?.trim() || null");
  });

  it("keeps missing capacity as null instead of converting it to zero", () => {
    const source = readFileSync("server/powerhub-supabase.ts", "utf8");
    expect(source).toContain("ratedCapacityKw: row.rated_capacity_kw == null ? null : String(row.rated_capacity_kw)");
  });

  it("allows the database column to be nullable", () => {
    const migration = readFileSync("supabase/migrations/20260926150000_powerhub_optional_generator_capacity.sql", "utf8");
    expect(migration).toContain("alter column rated_capacity_kw drop not null");
    expect(migration).toContain("rated_capacity_kw is null or rated_capacity_kw >= 0");
  });

  it("does not make the operations form require capacity", () => {
    const source = readFileSync("client/src/pages/OperationsPage.tsx", "utf8");
    expect(source).toContain('<Field label="القدرة بالكيلوواط (اختياري)">');
    expect(source).not.toContain('<Field label="القدرة بالكيلوواط"><input required name="capacity"');
  });
});
