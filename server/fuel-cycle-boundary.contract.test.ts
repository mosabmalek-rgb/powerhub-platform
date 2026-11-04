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
const initialInventoryCostMigration = readFileSync(
  resolve(root, "supabase/migrations/20261104155320_powerhub_inventory_fuel_consumption_cost_report.sql"),
  "utf8",
);
const inventoryCostBoundaryMigration = readFileSync(
  resolve(root, "supabase/migrations/20261104164300_powerhub_inventory_fuel_cost_cycle_boundary_precision.sql"),
  "utf8",
);
const inventoryCostAlignmentMigration = readFileSync(
  resolve(root, "supabase/migrations/20261104201500_powerhub_fuel_consumption_cost_cycle_microsecond_alignment.sql"),
  "utf8",
);
const legacyFuelCostMigration = readFileSync(
  resolve(root, "supabase/migrations/20261105010000_powerhub_fuel_cost_report_include_legacy_fills.sql"),
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

  it("keeps the generator cost report upper bound aligned with the inclusive microsecond cycle resolver", () => {
    const signature = "create or replace function public.powerhub_inventory_fuel_consumption_cost_report_period(";
    const initialFunction = extractFunction(initialInventoryCostMigration, signature);
    const reconciledFunction = extractFunction(inventoryCostBoundaryMigration, signature);
    expect(reconciledFunction).toBe(initialFunction);
    expect(reconciledFunction).toContain(
      "v_end_at:=v_cycle.cycle_end_at+interval '1 microsecond';",
    );
    expect(reconciledFunction).not.toContain(
      "v_end_at:=v_cycle.cycle_end_at+interval '1 millisecond';",
    );
  });

  it("re-applies the microsecond-aligned cost report after the Staging precision correction", () => {
    const signature = "create or replace function public.powerhub_inventory_fuel_consumption_cost_report_period(";
    const expectedFunction = extractFunction(inventoryCostBoundaryMigration, signature);
    const alignedFunction = extractFunction(inventoryCostAlignmentMigration, signature);
    expect(alignedFunction).toBe(expectedFunction);
    expect(alignedFunction).toContain("v_end_at:=v_cycle.cycle_end_at+interval '1 microsecond';");
    expect(alignedFunction).not.toContain("interval '1 millisecond'");
  });

  it("includes legacy transfer-backed fills once beside direct fuel issues and aggregates repeated fills", () => {
    const signature = "create or replace function public.powerhub_inventory_fuel_consumption_cost_report_period(";
    const updatedFunction = extractFunction(legacyFuelCostMigration, signature);
    expect(updatedFunction).toContain("from public.generator_fuel_events e");
    expect(updatedFunction).toContain("e.stock_transfer_id is not null");
    expect(updatedFunction).toContain("source.movement_type='issue'");
    expect(workflowTest).toContain("PHASE_B_LEGACY_FILL_COST_REPORT_FAILED");
    expect(workflowTest).toContain("'PHASE-B-FILL-2'");
    expect(workflowTest).toContain("recorded_consumption_liters<>11");
    expect(workflowTest).toContain("recorded_consumption_cost<>104.50");
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
