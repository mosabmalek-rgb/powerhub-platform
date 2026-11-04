import { describe, expect, it } from "vitest";
import { aggregateFuelConsumptionReportByGenerator, aggregateFuelFillReportByGenerator } from "./fuel-fill-report";

describe("aggregateFuelFillReportByGenerator", () => {
  it("combines several tank rows into one weighted fill summary per generator", () => {
    const result = aggregateFuelFillReportByGenerator([
      { generator_id: 11, generator_name: "مولد الشاطئ", fuel_filled_liters: "10.000", fuel_filled_cost: "90.00" },
      { generator_id: 11, generator_name: "مولد الشاطئ", fuel_filled_liters: "5.000", fuel_filled_cost: "30.00" },
      { generator_id: 12, generator_name: "مولد السوق", fuel_filled_liters: "7.500", fuel_filled_cost: "60.00" },
    ]);

    expect(result).toEqual([
      {
        generator_id: 11,
        generator_name: "مولد الشاطئ",
        fuel_filled_liters: 15,
        fuel_filled_cost: 120,
        average_cost_per_liter: 8,
      },
      {
        generator_id: 12,
        generator_name: "مولد السوق",
        fuel_filled_liters: 7.5,
        fuel_filled_cost: 60,
        average_cost_per_liter: 8,
      },
    ]);
  });

  it("keeps a zero-fill generator visible without inventing an average price", () => {
    expect(aggregateFuelFillReportByGenerator([
      { generator_id: 13, generator_name: "مولد احتياطي", fuel_filled_liters: "0.000", fuel_filled_cost: "0.00" },
    ])).toEqual([{
      generator_id: 13,
      generator_name: "مولد احتياطي",
      fuel_filled_liters: 0,
      fuel_filled_cost: 0,
      average_cost_per_liter: null,
    }]);
  });

  it("returns an empty result when the selected period has no generator rows", () => {
    expect(aggregateFuelFillReportByGenerator([])).toEqual([]);
  });
});

describe("aggregateFuelConsumptionReportByGenerator", () => {
  it("aggregates recorded and fully measured tank consumption per generator", () => {
    expect(aggregateFuelConsumptionReportByGenerator([
      { generator_id: 11, generator_name: "مولد الشاطئ", fuel_filled_liters: "10", fuel_filled_cost: "90",
        recorded_consumption_liters: "2", actual_consumption_liters: "3", operating_hours_delta: "10",
        litres_per_hour: "0.300", measurement_status: "measured" },
      { generator_id: 11, generator_name: "مولد الشاطئ", fuel_filled_liters: "5", fuel_filled_cost: "30",
        recorded_consumption_liters: "1", actual_consumption_liters: "2", operating_hours_delta: "10",
        litres_per_hour: "0.200", measurement_status: "measured" },
    ])).toEqual([{
      generator_id: 11, generator_name: "مولد الشاطئ", tank_count: 2,
      recorded_consumption_liters: 3, actual_consumption_liters: 5,
      operating_hours_delta: 10, litres_per_hour: 0.5, measurement_status: "measured",
    }]);
  });

  it("does not report a partial actual-consumption total when any generator tank lacks a baseline", () => {
    const [summary] = aggregateFuelConsumptionReportByGenerator([
      { generator_id: 12, generator_name: "مولد السوق", fuel_filled_liters: 0, fuel_filled_cost: 0,
        recorded_consumption_liters: 4, actual_consumption_liters: 4, operating_hours_delta: 8,
        measurement_status: "measured" },
      { generator_id: 12, generator_name: "مولد السوق", fuel_filled_liters: 0, fuel_filled_cost: 0,
        recorded_consumption_liters: 1, actual_consumption_liters: null, operating_hours_delta: 8,
        measurement_status: "insufficient_level_readings" },
    ]);
    expect(summary).toMatchObject({
      recorded_consumption_liters: 5, actual_consumption_liters: null,
      litres_per_hour: null, measurement_status: "insufficient_level_readings",
    });
  });

  it("surfaces reconciliation anomalies and does not turn them into a measured total", () => {
    const [summary] = aggregateFuelConsumptionReportByGenerator([
      { generator_id: 13, generator_name: "مولد احتياطي", fuel_filled_liters: 0, fuel_filled_cost: 0,
        recorded_consumption_liters: 2, actual_consumption_liters: null, operating_hours_delta: null,
        measurement_status: "reconciliation_anomaly" },
    ]);
    expect(summary).toMatchObject({
      actual_consumption_liters: null, litres_per_hour: null,
      measurement_status: "reconciliation_anomaly",
    });
  });

  it("keeps a valid measured volume when no usable operating-hour rate exists", () => {
    const [summary] = aggregateFuelConsumptionReportByGenerator([
      { generator_id: 14, generator_name: "مولد مستقل", fuel_filled_liters: 0, fuel_filled_cost: 0,
        recorded_consumption_liters: 0, actual_consumption_liters: 6, operating_hours_delta: null,
        measurement_status: "measured_without_hour_rate" },
    ]);
    expect(summary).toMatchObject({
      actual_consumption_liters: 6, litres_per_hour: null,
      measurement_status: "measured_without_hour_rate",
    });
  });
});
