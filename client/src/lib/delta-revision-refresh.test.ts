import { describe, expect, it } from "vitest";
import { changedOperationalDeltaEntities } from "./delta-revision-refresh";

describe("changed operational Delta entities", () => {
  it("returns only requested feeds whose server revisions changed", () => {
    const previous = { fuel_events: "a", fuel_readings: "b", maintenance_work_orders: "c" };
    const next = { fuel_events: "a", fuel_readings: "b2", maintenance_work_orders: "c2" };
    expect(changedOperationalDeltaEntities(
      previous, next, ["fuel_events", "fuel_readings", "maintenance_work_orders"],
    )).toEqual(["fuel_readings", "maintenance_work_orders"]);
  });

  it("ignores unrequested, missing and duplicate revisions", () => {
    expect(changedOperationalDeltaEntities(
      { fuel_events: "a" },
      { fuel_events: "b", fuel_readings: "new", inventory_items: "changed" },
      ["fuel_events", "fuel_events", "maintenance_work_orders"],
    )).toEqual(["fuel_events"]);
  });
});
