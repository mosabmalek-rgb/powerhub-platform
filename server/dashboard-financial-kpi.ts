import { decimalAmountToMinorUnits, minorUnitsToAmountString } from "./decimal-money";

export type DashboardFinancialKpiMetric = "expenses" | "netCash" | "currentArrears";
type AmountRow = { amount: number | string | null | undefined };
type PaymentRow = AmountRow & { status?: string | null };
type ArrearsRow = {
  siteId: number | string;
  subscriberId: number | string;
  dueDate: string | Date;
  balanceDue: number | string | null | undefined;
  status: string;
};

const minor = (value: number | string | null | undefined) => decimalAmountToMinorUnits(value);
const amount = (value: bigint) => Number(minorUnitsToAmountString(value));

export function buildDashboardFinancialKpi(input: {
  metric: DashboardFinancialKpiMetric;
  expenses?: readonly AmountRow[];
  payments?: readonly PaymentRow[];
  arrears?: readonly ArrearsRow[];
  now?: Date;
}) {
  if (input.metric === "expenses" || input.metric === "netCash") {
    const expensesMinor = (input.expenses ?? []).reduce((sum, row) => sum + minor(row.amount), 0n);
    const collectedMinor = (input.payments ?? [])
      .filter((row) => row.status === "completed")
      .reduce((sum, row) => sum + minor(row.amount), 0n);
    return {
      metric: input.metric,
      expenses: amount(expensesMinor),
      collected: amount(collectedMinor),
      netCash: amount(collectedMinor - expensesMinor),
    };
  }

  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("Dashboard KPI clock is invalid.");
  let outstandingMinor = 0n;
  let overdueMinor = 0n;
  let partialInvoices = 0;
  const accounts = new Set<string>();
  for (const invoice of input.arrears ?? []) {
    const balance = minor(invoice.balanceDue);
    if (balance <= 0n) continue;
    outstandingMinor += balance;
    const dueDate = invoice.dueDate instanceof Date ? invoice.dueDate : new Date(invoice.dueDate);
    if (Number.isFinite(dueDate.getTime()) && dueDate.getTime() < now.getTime()) overdueMinor += balance;
    if (invoice.status === "partially_paid") partialInvoices += 1;
    accounts.add(`${String(invoice.siteId)}:${String(invoice.subscriberId)}`);
  }
  return {
    metric: "currentArrears" as const,
    outstanding: amount(outstandingMinor),
    overdue: amount(overdueMinor),
    partialInvoices,
    accountCount: accounts.size,
  };
}
