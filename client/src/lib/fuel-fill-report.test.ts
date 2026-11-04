import { describe, expect, it } from "vitest";
import { aggregateFuelFillReportByGenerator } from "./fuel-fill-report";

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
