import { isIssuedFinancialInvoiceStatus } from "./financial-accrual-components";

/** A bounded, read-only billing diagnostic. Never equate service-cycle billing with earned revenue. */
export type ServiceCycleBillingInvoice = {
  id: number;
  status: string;
  totalAmount: number;
  taxAmount: number;
  issueDate: Date;
  cycleStartAt: Date | null;
  cycleEndAt: Date | null;
};

export class InvalidServiceCycleBilling extends Error {
  constructor(reason: string) { super(reason); this.name = "InvalidServiceCycleBilling"; }
}
const gazaDayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Gaza", year: "numeric", month: "2-digit", day: "2-digit",
});
const checkedDate = (value: Date) => {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new InvalidServiceCycleBilling("Invalid service-cycle timestamp");
  }
  return value;
};
function gazaDay(value: Date) {
  const parts = gazaDayFormatter.formatToParts(checkedDate(value));
  const get = (type: string) => parts.find(part => part.type === type)?.value ?? "";
  const day = `${get("year")}-${get("month")}-${get("day")}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new InvalidServiceCycleBilling("Invalid Gaza day");
  return day;
}
const validDay = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new InvalidServiceCycleBilling("Invalid report day");
  const date = new Date(`${value}T12:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new InvalidServiceCycleBilling("Invalid calendar day");
  }
  return value;
};
function moneyCents(raw: number, name: string) {
  if (!Number.isFinite(raw) || raw < 0 || raw > 100000000000) {
    throw new InvalidServiceCycleBilling("Invalid " + name);
  }
  const cents = Math.round(raw * 100);
  if (!Number.isSafeInteger(cents)) throw new InvalidServiceCycleBilling("Unsafe money amount");
  return cents;
}
const money = (cents: number) => cents / 100;

export function summarizeServiceCycleBilling(
  startDate: string, endDate: string, asOf: Date, invoices: ServiceCycleBillingInvoice[],
) {
  const start = validDay(startDate), end = validDay(endDate);
  checkedDate(asOf);
  if (start > end || invoices.length > 5000) throw new InvalidServiceCycleBilling("Invalid or oversized review");
  const seen = new Set<number>();
  let issuedInvoiceCount = 0, fullyInsideCount = 0, crossBoundaryCount = 0;
  let completedCount = 0, inProgressCount = 0, futureCount = 0;
  let issuedOutsideRangeCount = 0, ignoredStatusesCount = 0;
  let billedGrossCents = 0, billedTaxCents = 0;
  let completedGrossCents = 0, ongoingGrossCents = 0, futureGrossCents = 0;
  let invoiceIssuedOutsideGrossCents = 0;
  for (const invoice of invoices) {
    if (!Number.isSafeInteger(invoice.id) || invoice.id < 1 || seen.has(invoice.id)) {
      throw new InvalidServiceCycleBilling("Invalid or duplicate invoice ID");
    }
    seen.add(invoice.id);
    if (!isIssuedFinancialInvoiceStatus(invoice.status)) { ignoredStatusesCount++; continue; }
    if (!invoice.cycleStartAt || !invoice.cycleEndAt) {
      throw new InvalidServiceCycleBilling("Missing authoritative service-cycle bounds");
    }
    const first = checkedDate(invoice.cycleStartAt);
    const last = checkedDate(invoice.cycleEndAt);
    if (first.getTime() > last.getTime()) throw new InvalidServiceCycleBilling("Reversed cycle");
    const cycleFirstDay = gazaDay(first), cycleLastDay = gazaDay(last);
    // The server queries an intentionally broad UTC range to cover Gaza's DST.
    // Filter exact local calendar boundaries again before counting.
    if (cycleLastDay < start || cycleFirstDay > end) continue;
    const gross = moneyCents(invoice.totalAmount, "invoice gross");
    const tax = moneyCents(invoice.taxAmount, "invoice tax");
    if (tax > gross) throw new InvalidServiceCycleBilling("Tax exceeds gross invoice");
    billedGrossCents += gross;
    billedTaxCents += tax;
    issuedInvoiceCount++;
    if (cycleFirstDay < start || cycleLastDay > end) crossBoundaryCount++;
    else fullyInsideCount++;
    if (last.getTime() < asOf.getTime()) {
      completedCount++;
      completedGrossCents += gross;
    } else if (first.getTime() > asOf.getTime()) {
      futureCount++;
      futureGrossCents += gross;
    } else {
      inProgressCount++;
      ongoingGrossCents += gross;
    }
    const issueDay = gazaDay(invoice.issueDate);
    if (issueDay < start || issueDay > end) {
      issuedOutsideRangeCount++;
      invoiceIssuedOutsideGrossCents += gross;
    }
  }
  if (![billedGrossCents,billedTaxCents,completedGrossCents,ongoingGrossCents,
        futureGrossCents,invoiceIssuedOutsideGrossCents].every(Number.isSafeInteger)) {
    throw new InvalidServiceCycleBilling("Service-cycle amount overflow");
  }
  return {
    range: {startDate, endDate}, asOf: asOf.toISOString(),
    issuedInvoiceCount,fullyInsideCount,crossBoundaryCount,
    completedCount,inProgressCount,futureCount,
    issuedOutsideRangeCount,ignoredStatusesCount,
    billedGross:money(billedGrossCents),
    billedTax:money(billedTaxCents),
    billedExTax:money(billedGrossCents-billedTaxCents),
    completedCycleBilledGross:money(completedGrossCents),
    ongoingCycleBilledGross:money(ongoingGrossCents),
    futureCycleBilledGross:money(futureGrossCents),
    issuedOutsideRangeBilledGross:money(invoiceIssuedOutsideGrossCents),
    isRecognizedRevenue:false as const,
    coverage:"invoices_with_service_cycles_intersecting_range" as const,
  };
}
