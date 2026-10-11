import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const migration = fs.readFileSync(
  path.resolve(process.cwd(), "supabase/migrations/20261011110000_powerhub_reading_cycle_anchor_modes.sql"),
  "utf8",
);

describe("reading cycle anchor modes", () => {
  it("supports both 10-day patterns and clamps the alternate day 30 anchor to February's final day", () => {
    expect(migration).toContain("if c.monthly_start_day = 1 then");
    expect(migration).toContain("Alternate 10/20/30 anchor");
    expect(migration).toContain("least(30, last_day)");
    expect(migration).toContain("start_day = 10");
    expect(migration).toContain("start_day = 20");
  });

  it("supports both 15-day patterns and keeps the next cycle boundary contiguous", () => {
    expect(migration).toContain("Alternate 15/30 anchor");
    expect(migration).toContain("start_day = null or start_day = 30");
    expect(migration).toContain("start_day = 16");
    expect(migration).toContain("start_day = 21");
  });

  it("preserves timezone-aware cycle keys and restricts execution to service_role", () => {
    expect(migration).toContain("local_at := p_reading_at at time zone c.timezone");
    expect(migration).toContain("cycle_key := c.cycle_type || ':'");
    expect(migration).toContain("revoke execute on function public.powerhub_cycle_for_reading(bigint,bigint,timestamptz) from public, anon, authenticated");
    expect(migration).toContain("grant execute on function public.powerhub_cycle_for_reading(bigint,bigint,timestamptz) to service_role");
  });
});
