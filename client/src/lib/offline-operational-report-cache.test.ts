import { describe, expect, it } from "vitest";
import {
  getUsableOperationalReportSnapshot,
  OFFLINE_OPERATIONAL_REPORT_TTL_MS,
  type OperationalReportSnapshot,
} from "./offline-operational-report-cache";

const input = {
  userId: 7,
  siteId: 10,
  reportType: "fuel-consumption" as const,
  filters: { periodType: "month", anchorDate: "2026-10-01", generatorId: 44, tankWarehouseId: null },
};
const snapshot = (overrides: Partial<OperationalReportSnapshot> = {}): OperationalReportSnapshot => ({
  key: JSON.stringify([input.userId, input.siteId, input.reportType, input.filters]),
  ...input,
  rows: [{
    generator_id: 44, generator_name: "G-44", fuel_filled_liters: "100.000",
    fuel_filled_cost: "800.00", measurement_status: "measured",
    notes: "must not persist", created_by_user_id: 99, secret: "drop",
  }],
  savedAt: 1000,
  ...overrides,
});

describe("offline operational report snapshots", () => {
  it("requires exact user, site, report and filter scope and an unexpired timestamp", () => {
    expect(getUsableOperationalReportSnapshot(snapshot(), input, { now: 1001 })).toBeDefined();
    expect(getUsableOperationalReportSnapshot(snapshot(), { ...input, userId: 8 }, { now: 1001 })).toBeUndefined();
    expect(getUsableOperationalReportSnapshot(snapshot(), { ...input, siteId: 11 }, { now: 1001 })).toBeUndefined();
    expect(getUsableOperationalReportSnapshot(snapshot(), { ...input, filters: { ...input.filters, generatorId: 45 } }, { now: 1001 })).toBeUndefined();
    expect(getUsableOperationalReportSnapshot(snapshot(), input, { now: 1001 + OFFLINE_OPERATIONAL_REPORT_TTL_MS })).toBeUndefined();
    expect(getUsableOperationalReportSnapshot(snapshot(), input, { now: 1001, authorizationDenied: true })).toBeUndefined();
    expect(getUsableOperationalReportSnapshot(snapshot(), input, { now: 1001, accessAllowed: false })).toBeUndefined();
  });

  it("persists only allowlisted aggregate fields, not arbitrary row details", () => {
    const usable = getUsableOperationalReportSnapshot(snapshot(), input, { now: 1001 });
    expect(usable?.rows[0]).toMatchObject({
      generator_id: 44, generator_name: "G-44", fuel_filled_liters: "100.000",
      fuel_filled_cost: "800.00", measurement_status: "measured",
    });
    expect(usable?.rows[0]).not.toHaveProperty("notes");
    expect(usable?.rows[0]).not.toHaveProperty("created_by_user_id");
    expect(usable?.rows[0]).not.toHaveProperty("secret");
  });

  it("supports maintenance report aggregates without caching work-order detail rows", () => {
    const maintenanceInput = {
      userId: 7, siteId: 10, reportType: "maintenance" as const,
      filters: { fromDate: "2026-10-01", toDate: "2026-10-29", generatorId: null },
    };
    const maintenanceSnapshot: OperationalReportSnapshot = {
      key: JSON.stringify([maintenanceInput.userId, maintenanceInput.siteId, maintenanceInput.reportType, maintenanceInput.filters]),
      ...maintenanceInput,
      rows: [{ generator_id: 44, generator_name: "G-44", fault_title: "Repair", work_order_count: 2, total_cost_amount: "75.00", description: "do not cache" }],
      savedAt: 1000,
    };
    const usable = getUsableOperationalReportSnapshot(maintenanceSnapshot, maintenanceInput, { now: 1001 });
    expect(usable?.rows[0]).toMatchObject({ generator_id: 44, work_order_count: 2, total_cost_amount: "75.00" });
    expect(usable?.rows[0]).not.toHaveProperty("description");
  });
});
