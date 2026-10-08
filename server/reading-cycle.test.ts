import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const migration = fs.readFileSync(
  path.resolve(process.cwd(), "supabase/migrations/20261008100000_powerhub_reading_cycle_authority.sql"),
  "utf8",
);
const invoiceMigration = fs.readFileSync(
  path.resolve(process.cwd(), "supabase/migrations/20261008103000_powerhub_invoice_cycle_assignment.sql"),
  "utf8",
);

describe("PowerHub canonical reading/billing cycles", () => {
  it("supports the four requested cycle modes", () => {
    expect(migration).toContain("'WEEKLY','EVERY_10_DAYS','EVERY_15_DAYS','MONTHLY'");
  });

  it("supports weekly start days using Android-compatible Sunday=1 through Saturday=7", () => {
    expect(migration).toContain("weekly_start_day integer not null default 7");
    expect(migration).toContain("case when c.weekly_start_day=7 then 6 else c.weekly_start_day-1 end");
  });

  it("supports monthly day 1 or 30 and forces February 30-cycle start to February 28", () => {
    expect(migration).toContain("monthly_start_day integer not null default 1");
    expect(migration).toContain("monthly_start_day in (1,30)");
    expect(migration).toContain("when c.monthly_start_day=30 and extract(month from local_at)::integer=2 then 28");
  });

  it("makes invoice identity cycle-based so 10/15-day cycles can coexist in one month", () => {
    expect(migration).toContain("invoices_subscriber_cycle_unique");
    expect(invoiceMigration).toContain("powerhub_assign_invoice_cycle");
    expect(invoiceMigration).toContain("new.cycle_key := v_cycle.cycle_key");
  });

  it("carries cycle identity into invoice notifications", () => {
    expect(invoiceMigration).toContain("cycleKey");
    expect(invoiceMigration).toContain("cycleStartAt");
    expect(invoiceMigration).toContain("cycleEndAt");
  });
});
