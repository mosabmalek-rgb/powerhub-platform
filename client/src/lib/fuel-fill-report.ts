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
