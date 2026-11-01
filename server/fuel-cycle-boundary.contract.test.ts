import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const cycleMigration = readFileSync(
  resolve(root, "supabase/migrations/20261011110000_powerhub_reading_cycle_anchor_modes.sql"),
  "utf8",
);
const fuelReportMigration = readFileSync(
  resolve(root, "supabase/migrations/20261022220000_powerhub_fuel_report_windows.sql"),
  "utf8",
);
const boundaryMigration = readFileSync(
  resolve(root, "supabase/migrations/20261101084225_powerhub_fuel_cycle_boundary_precision.sql"),
  "utf8",
);
const workflowTest = readFileSync(
  resolve(root, "supabase/tests/inventory_purchase_receiving_workflow.sql"),
  "utf8",
);

function extractFunction(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`Missing SQL function: ${signature}`);
  const endMarker = "$function$;";
  const end = source.indexOf(endMarker, start);
  if (end < 0) throw new Error(`Unterminated SQL function: ${signature}`);
  return source.slice(start, end + endMarker.length).trim();
}

describe("Fuel cycle report boundary contract", () => {
  it("keeps the disposable integration fixture identical to the production cycle resolver", () => {
    const signature = "create or replace function public.powerhub_cycle_for_reading(";
    expect(extractFunction(workflowTest, signature)).toBe(extractFunction(cycleMigration, signature));
  });

  it("converts inclusive microsecond cycle ends to the exact exclusive next boundary", () => {
    const signature = "create or replace function public.powerhub_inventory_fuel_consumption_report_period(";
    expect(extractFunction(boundaryMigration, signature)).toContain(
      "v_end_at:=v_cycle.cycle_end_at+interval '1 microsecond';",
    );
    expect(extractFunction(boundaryMigration, signature)).not.toContain(
      "v_end_at:=v_cycle.cycle_end_at+interval '1 millisecond';",
    );
    expect(fuelReportMigration).toContain("v_end_at:=v_cycle.cycle_end_at+interval '1 millisecond';");
  });

  it("covers 31-day month end, leap February, 15-day and weekly boundaries, and cycle non-overlap", () => {
    expect(workflowTest).toContain("CYCLE_EVERY_10_DAYS_OCTOBER_31_BOUNDARY_FAILED");
    expect(workflowTest).toContain("CYCLE_EVERY_10_DAYS_LEAP_FEBRUARY_BOUNDARY_FAILED");
    expect(workflowTest).toContain("CYCLE_EVERY_15_DAYS_OCTOBER_31_BOUNDARY_FAILED");
    expect(workflowTest).toContain("CYCLE_WEEKLY_MICROSECOND_BOUNDARY_FAILED");
    expect(workflowTest).toContain("PHASE_B_NEXT_CYCLE_CONTAINS_PREVIOUS_CYCLE_FILL");
    expect(workflowTest).toContain("20261101084225_powerhub_fuel_cycle_boundary_precision.sql");
  });
});
