/**
 * Phase A1: deterministic Gaza-calendar service allocation for already issued invoices.
 *
 * This is a supporting schedule, NOT final recognized revenue:
 * unbilled service, prepayments, credits, tax reconciliation and GL posting
 * are separate blocking acceptance gates.
 *
 * The existing billing cycle timestamps are inclusive; convert each endpoint
 * to its Gaza-local calendar day before counting inclusive service days.
 * This daily policy is versioned and must not silently change after closing.
 */
export const SERVICE_RECOGNITION_POLICY_VERSION =
  "gaza-invoice-service-calendar-days-v1" as const;

export type ServiceAllocationMonth = {
  period: string;
  serviceDays: number;
  allocatedExTaxMinor: bigint;
};
export class InvalidServiceAllocation extends Error {
  constructor(message: string) { super(message); this.name = "InvalidServiceAllocation"; }
}
const gazaDay = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Gaza", year: "numeric", month: "2-digit", day: "2-digit",
});
function dayKey(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
    throw new InvalidServiceAllocation("INVALID_SERVICE_TIMESTAMP");
  const parts = gazaDay.formatToParts(value);
  const field = (t: string) => parts.find(p => p.type === t)?.value ?? "";
  const key = `${field("year")}-${field("month")}-${field("day")}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key))
    throw new InvalidServiceAllocation("INVALID_GAZA_DAY");
  return key;
}
function dayIndex(key: string): number {
  const t = Date.parse(`${key}T00:00:00.000Z`);
  if (!Number.isFinite(t) || new Date(t).toISOString().slice(0,10) !== key)
    throw new InvalidServiceAllocation("INVALID_GAZA_CALENDAR");
  return t / 86400000;
}
export function allocateBilledServiceByGazaMonth(input: {
  cycleStartAt: Date;
  cycleEndAt: Date;
  billedGrossMinor: bigint;
  billedTaxMinor: bigint;
}): {
  policyVersion: typeof SERVICE_RECOGNITION_POLICY_VERSION;
  totalServiceDays: number;
  totalExTaxMinor: bigint;
  months: ServiceAllocationMonth[];
  isRecognizedRevenue: false;
  isCompleteAccrualStatement: false;
} {
  const { cycleStartAt, cycleEndAt, billedGrossMinor, billedTaxMinor } = input;
  if (!(cycleStartAt instanceof Date) || !(cycleEndAt instanceof Date) ||
      !Number.isFinite(cycleStartAt.getTime()) || !Number.isFinite(cycleEndAt.getTime()) ||
      cycleEndAt.getTime() < cycleStartAt.getTime())
    throw new InvalidServiceAllocation("INVALID_CYCLE_ORDER");
  if (typeof billedGrossMinor !== "bigint" || typeof billedTaxMinor !== "bigint" ||
      billedGrossMinor < 0n || billedTaxMinor < 0n || billedTaxMinor > billedGrossMinor)
    throw new InvalidServiceAllocation("INVALID_BILLING_OR_TAX");
  const start = dayIndex(dayKey(cycleStartAt));
  const end = dayIndex(dayKey(cycleEndAt));
  const days = end - start + 1;
  // Explicit error, never silent truncation or partial totals.
  if (!Number.isSafeInteger(days) || days < 1 || days > 3660)
    throw new InvalidServiceAllocation("UNSUPPORTED_CYCLE_LENGTH");
  const byMonth = new Map<string, number>();
  for (let d = start; d <= end; d++) {
    const period = new Date(d * 86400000).toISOString().slice(0,7);
    byMonth.set(period, (byMonth.get(period) ?? 0) + 1);
  }
  const exTax = billedGrossMinor - billedTaxMinor;
  let cumulativeDays = 0n;
  let previouslyAllocated = 0n;
  const months: ServiceAllocationMonth[] = [];
  for (const [period, serviceDays] of byMonth) {
    cumulativeDays += BigInt(serviceDays);
    // Cumulative quotient allocates the remainder exactly once, deterministically.
    const through = exTax * cumulativeDays / BigInt(days);
    months.push({
      period, serviceDays,
      allocatedExTaxMinor: through - previouslyAllocated,
    });
    previouslyAllocated = through;
  }
  if (previouslyAllocated !== exTax || cumulativeDays !== BigInt(days))
    throw new InvalidServiceAllocation("SERVICE_ALLOCATION_RECONCILIATION_FAILED");
  return {
    policyVersion: SERVICE_RECOGNITION_POLICY_VERSION,
    totalServiceDays: days,
    totalExTaxMinor: exTax,
    months,
    isRecognizedRevenue: false,
    isCompleteAccrualStatement: false,
  };
}
