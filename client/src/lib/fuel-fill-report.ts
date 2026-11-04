export type FuelFillReportRow = {
  generator_id: number;
  generator_name: string;
  fuel_filled_liters: number | string | null;
  fuel_filled_cost: number | string | null;
};

export type FuelFillGeneratorSummary = {
  generator_id: number;
  generator_name: string;
  fuel_filled_liters: number;
  fuel_filled_cost: number;
  average_cost_per_liter: number | null;
};

type FuelFillAccumulator = {
  generator_id: number;
  generator_name: string;
  filledLitersMilli: number;
  filledCostCents: number;
};

function scaledInteger(value: number | string | null, scale: number): number {
  const amount = Number(value ?? 0);
  return Number.isFinite(amount) ? Math.round(amount * scale) : 0;
}

/**
 * Collapse tank-level fuel-fill report rows into one weighted summary per generator.
 * Quantities are accumulated in thousandths of a litre and costs in cents to avoid
 * floating-point drift when a generator has more than one fuel tank.
 */
export function aggregateFuelFillReportByGenerator(
  rows: readonly FuelFillReportRow[],
): FuelFillGeneratorSummary[] {
  const totals = new Map<number, FuelFillAccumulator>();

  for (const row of rows) {
    const generatorId = Number(row.generator_id);
    if (!Number.isSafeInteger(generatorId) || generatorId <= 0) continue;

    const current = totals.get(generatorId) ?? {
      generator_id: generatorId,
      generator_name: row.generator_name || `مولد #${generatorId}`,
      filledLitersMilli: 0,
      filledCostCents: 0,
    };
    current.filledLitersMilli += scaledInteger(row.fuel_filled_liters, 1000);
    current.filledCostCents += scaledInteger(row.fuel_filled_cost, 100);
    totals.set(generatorId, current);
  }

  return Array.from(totals.values(), (total) => {
    const filledLiters = total.filledLitersMilli / 1000;
    const filledCost = total.filledCostCents / 100;
    return {
      generator_id: total.generator_id,
      generator_name: total.generator_name,
      fuel_filled_liters: filledLiters,
      fuel_filled_cost: filledCost,
      average_cost_per_liter: total.filledLitersMilli > 0
        ? Number(((total.filledCostCents * 10) / total.filledLitersMilli).toFixed(4))
        : null,
    };
  });
}
export type FuelConsumptionReportRow = FuelFillReportRow & {
  tank_warehouse_id?: number | null;
  tank_name?: string | null;
  recorded_consumption_liters?: number | string | null;
  actual_consumption_liters?: number | string | null;
  operating_hours_delta?: number | string | null;
  litres_per_hour?: number | string | null;
  measurement_status?: string | null;
};

export type FuelConsumptionGeneratorSummary = {
  generator_id: number;
  generator_name: string;
  tank_count: number;
  recorded_consumption_liters: number;
  actual_consumption_liters: number | null;
  operating_hours_delta: number | null;
  litres_per_hour: number | null;
  measurement_status: "measured" | "measured_without_hour_rate" | "insufficient_level_readings" | "reconciliation_anomaly";
};

/**
 * Aggregate tank-level operational measurements to generator scope without
 * presenting partial tank readings as a complete generator consumption total.
 */
export function aggregateFuelConsumptionReportByGenerator(
  rows: readonly FuelConsumptionReportRow[],
): FuelConsumptionGeneratorSummary[] {
  const groups = new Map<number, FuelConsumptionReportRow[]>();
  for (const row of rows) {
    const id = Number(row.generator_id);
    if (!Number.isSafeInteger(id) || id <= 0) continue;
    const current = groups.get(id) ?? [];
    current.push(row);
    groups.set(id, current);
  }

  return Array.from(groups.entries(), ([generatorId, generatorRows]) => {
    const recordedMilli = generatorRows.reduce(
      (sum, row) => sum + scaledInteger(row.recorded_consumption_liters ?? 0, 1000), 0,
    );
    const actualValues = generatorRows.map((row) =>
      row.actual_consumption_liters == null ? null : Number(row.actual_consumption_liters),
    );
    const actualComplete = actualValues.every((value) => value !== null && Number.isFinite(value) && value >= 0);
    const actualMilli = actualComplete
      ? actualValues.reduce<number>((sum, value) => sum + Math.round((value ?? 0) * 1000), 0)
      : 0;

    const hoursValues = generatorRows.map((row) =>
      row.operating_hours_delta == null ? null : Number(row.operating_hours_delta),
    );
    const hoursComplete = hoursValues.every((value) => value !== null && Number.isFinite(value) && value > 0);
    const distinctHours = new Set(hoursValues.map((value) =>
      value == null || !Number.isFinite(value) ? "missing" : value.toFixed(3),
    ));
    const hoursDelta = hoursComplete && distinctHours.size === 1
      ? Number(hoursValues[0]?.toFixed(3))
      : null;

    const statusValues = generatorRows.map((row) => row.measurement_status);
    const measurementStatus: FuelConsumptionGeneratorSummary["measurement_status"] =
      statusValues.includes("reconciliation_anomaly")
        ? "reconciliation_anomaly"
        : !actualComplete || statusValues.includes("insufficient_level_readings")
          ? "insufficient_level_readings"
          : !hoursDelta || statusValues.includes("measured_without_hour_rate")
            ? "measured_without_hour_rate"
            : "measured";

    const actual = actualComplete && measurementStatus !== "reconciliation_anomaly"
      ? actualMilli / 1000
      : null;
    const litresPerHour = actual !== null && hoursDelta !== null
      ? Number((actual / hoursDelta).toFixed(3))
      : null;

    return {
      generator_id: generatorId,
      generator_name: generatorRows[0]?.generator_name || `مولد #${generatorId}`,
      tank_count: generatorRows.length,
      recorded_consumption_liters: recordedMilli / 1000,
      actual_consumption_liters: actual,
      operating_hours_delta: hoursDelta,
      litres_per_hour: litresPerHour,
      measurement_status: measurementStatus,
    };
  }).sort((a, b) => a.generator_name.localeCompare(b.generator_name, "ar"));
}
