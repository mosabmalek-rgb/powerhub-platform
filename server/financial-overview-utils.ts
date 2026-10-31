import { decimalAmountToMinorUnits, minorUnitsToAmountString } from "./decimal-money";

export type FinancialOverviewInvoice = {
  id: number;
  siteId: number;
  subscriberId: number;
  subscriberName: string;
  subscriberNo: string;
  invoiceNo: string;
  issueDate: Date;
  dueDate: Date;
  totalAmount: number | string;
  paidAmount: number | string;
  balanceDue: number | string;
  status: string;
};
export type FinancialOverviewPayment = { siteId: number; subscriberId: number; amount: number | string; status: string; paidAt: Date };
export type FinancialOverviewExpense = { siteId: number; amount: number | string; occurredAt: Date };
export type FinancialOverviewBranch = { id: number; name: string; activeSubscribers: number };

const minor = (value: number | string | null | undefined) => decimalAmountToMinorUnits(value);
const amount = (value: bigint) => Number(minorUnitsToAmountString(value));
const rate = (numerator: bigint, denominator: bigint) => denominator > 0n ? Number(numerator) / Number(denominator) * 100 : 0;

export function periodBounds(now: Date) {
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const tomorrowStart = new Date(todayStart); tomorrowStart.setUTCDate(tomorrowStart.getUTCDate() + 1);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const nextMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { todayStart, tomorrowStart, monthStart, nextMonthStart };
}
const inRange = (date: Date, start: Date, endExclusive: Date) => date >= start && date < endExclusive;
const dayKey = (date: Date) => date.toISOString().slice(0, 10);

export function buildFinancialTrendSeries(input: {
  invoices: FinancialOverviewInvoice[];
  payments: FinancialOverviewPayment[];
  expenses: FinancialOverviewExpense[];
  from: Date;
  to: Date;
}) {
  if (!(input.from < input.to)) throw new Error("الفترة الزمنية غير صالحة.");
  const buckets = new Map<string, { date: string; invoiced: bigint; collected: bigint; expenses: bigint }>();
  for (let cursor = new Date(Date.UTC(input.from.getUTCFullYear(), input.from.getUTCMonth(), input.from.getUTCDate())); cursor < input.to; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const key = dayKey(cursor);
    buckets.set(key, { date: key, invoiced: 0n, collected: 0n, expenses: 0n });
  }
  for (const invoice of input.invoices) {
    if (invoice.status === "cancelled" || invoice.status === "draft") continue;
    const bucket = buckets.get(dayKey(invoice.issueDate));
    if (bucket) bucket.invoiced += minor(invoice.totalAmount);
  }
  for (const payment of input.payments) {
    if (payment.status !== "completed") continue;
    const bucket = buckets.get(dayKey(payment.paidAt));
    if (bucket) bucket.collected += minor(payment.amount);
  }
  for (const expense of input.expenses) {
    const bucket = buckets.get(dayKey(expense.occurredAt));
    if (bucket) bucket.expenses += minor(expense.amount);
  }
  return Array.from(buckets.values()).map((bucket) => ({
    date: bucket.date,
    invoiced: amount(bucket.invoiced),
    collected: amount(bucket.collected),
    expenses: amount(bucket.expenses),
    netCash: amount(bucket.collected - bucket.expenses),
  }));
}

export function buildFinancialOverview(input: {
  branches: FinancialOverviewBranch[];
  invoices: FinancialOverviewInvoice[];
  payments: FinancialOverviewPayment[];
  expenses: FinancialOverviewExpense[];
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const { todayStart, tomorrowStart, monthStart, nextMonthStart } = periodBounds(now);
  const trendFrom = new Date(tomorrowStart);
  trendFrom.setUTCDate(trendFrom.getUTCDate() - 31);

  const branchMap = new Map(input.branches.map((branch) => [branch.id, {
    ...branch, invoicedMinor: 0n, collectedMinor: 0n, outstandingMinor: 0n, overdueMinor: 0n, partialInvoices: 0,
  }]));
  let todayInvoiced = 0n, todayCollected = 0n, monthInvoiced = 0n, monthCollected = 0n;
  let monthExpenses = 0n, outstanding = 0n, overdue = 0n, partialInvoices = 0;

  const lastPaymentBySubscriber = new Map<string, Date>();
  const outstandingInvoices: Array<{
    siteId: number; subscriberId: number; subscriber: string; subscriberNo: string;
    invoiceId: number; invoiceNo: string; outstanding: number; dueDate: string;
    isOverdue: boolean; ageDays: number; partialInvoices: number; status: string;
  }> = [];
  const debtorMap = new Map<string, {
    siteId: number; subscriberId: number; subscriber: string; subscriberNo: string;
    outstandingMinor: bigint; invoiceCount: number; partialInvoices: number;
    invoiceId: number; invoiceNo: string; oldestDueDate: Date; isOverdue: boolean;
  }>();

  for (const invoice of input.invoices) {
    if (invoice.status === "cancelled" || invoice.status === "draft") continue;
    const balance = minor(invoice.balanceDue);
    const total = minor(invoice.totalAmount);
    const branch = branchMap.get(invoice.siteId);
    const isOverdue = balance > 0n && invoice.dueDate < now;

    if (inRange(invoice.issueDate, todayStart, tomorrowStart)) todayInvoiced += total;
    if (inRange(invoice.issueDate, monthStart, nextMonthStart)) {
      monthInvoiced += total;
      if (branch) branch.invoicedMinor += total;
    }
    if (balance > 0n) {
      outstandingInvoices.push({
        siteId: invoice.siteId, subscriberId: invoice.subscriberId,
        subscriber: invoice.subscriberName, subscriberNo: invoice.subscriberNo,
        invoiceId: invoice.id, invoiceNo: invoice.invoiceNo, outstanding: amount(balance),
        dueDate: invoice.dueDate.toISOString(), isOverdue,
        ageDays: isOverdue ? Math.max(1, Math.floor((now.getTime() - invoice.dueDate.getTime()) / 86400000)) : 0,
        partialInvoices: invoice.status === "partially_paid" ? 1 : 0, status: invoice.status,
      });
      outstanding += balance;
      if (branch) branch.outstandingMinor += balance;
      if (isOverdue) {
        overdue += balance;
        if (branch) branch.overdueMinor += balance;
      }
      if (invoice.status === "partially_paid") {
        partialInvoices += 1;
        if (branch) branch.partialInvoices += 1;
      }

      const key = `${invoice.siteId}:${invoice.subscriberId}`;
      const debtor = debtorMap.get(key) ?? {
        siteId: invoice.siteId, subscriberId: invoice.subscriberId,
        subscriber: invoice.subscriberName, subscriberNo: invoice.subscriberNo,
        outstandingMinor: 0n, invoiceCount: 0, partialInvoices: 0,
        invoiceId: invoice.id, invoiceNo: invoice.invoiceNo, oldestDueDate: invoice.dueDate, isOverdue: false,
      };
      debtor.outstandingMinor += balance;
      debtor.invoiceCount += 1;
      if (invoice.status === "partially_paid") debtor.partialInvoices += 1;
      if (invoice.dueDate < debtor.oldestDueDate) {
        debtor.oldestDueDate = invoice.dueDate;
        debtor.invoiceId = invoice.id;
        debtor.invoiceNo = invoice.invoiceNo;
      }
      debtor.isOverdue ||= isOverdue;
      debtorMap.set(key, debtor);
    }
  }

  for (const payment of input.payments) {
    if (payment.status !== "completed") continue;
    const value = minor(payment.amount);
    const branch = branchMap.get(payment.siteId);
    const key = `${payment.siteId}:${payment.subscriberId}`;
    const previous = lastPaymentBySubscriber.get(key);
    if (!previous || payment.paidAt > previous) lastPaymentBySubscriber.set(key, payment.paidAt);
    if (inRange(payment.paidAt, todayStart, tomorrowStart)) todayCollected += value;
    if (inRange(payment.paidAt, monthStart, nextMonthStart)) {
      monthCollected += value;
      if (branch) branch.collectedMinor += value;
    }
  }
  for (const expense of input.expenses) {
    if (inRange(expense.occurredAt, monthStart, nextMonthStart)) monthExpenses += minor(expense.amount);
  }

  const branchSummaries = Array.from(branchMap.values())
    .map(({ invoicedMinor, collectedMinor, outstandingMinor, overdueMinor, ...branch }) => ({
      ...branch,
      invoiced: amount(invoicedMinor),
      collected: amount(collectedMinor),
      outstanding: amount(outstandingMinor),
      overdue: amount(overdueMinor),
      collectionRate: rate(collectedMinor, invoicedMinor),
    }))
    .sort((a, b) => b.outstanding - a.outstanding || a.collectionRate - b.collectionRate);

  const topDebtors = Array.from(debtorMap.values())
    .map(({ outstandingMinor, ...debtor }) => ({
      ...debtor,
      outstanding: amount(outstandingMinor),
      ageDays: debtor.isOverdue ? Math.max(1, Math.floor((now.getTime() - debtor.oldestDueDate.getTime()) / 86400000)) : 0,
      oldestDueDate: debtor.oldestDueDate.toISOString(),
      lastPaymentAt: lastPaymentBySubscriber.get(`${debtor.siteId}:${debtor.subscriberId}`)?.toISOString() ?? null,
      branchName: input.branches.find((branch) => branch.id === debtor.siteId)?.name ?? "فرع غير محدد",
    }))
    .sort((a, b) => Number(b.isOverdue) - Number(a.isOverdue) || b.outstanding - a.outstanding)
    .slice(0, 10);

  return {
    generatedAt: now.toISOString(),
    period: { today: todayStart.toISOString().slice(0, 10), month: monthStart.toISOString().slice(0, 7) },
    today: { invoiced: amount(todayInvoiced), collected: amount(todayCollected), collectionRate: rate(todayCollected, todayInvoiced) },
    month: {
      invoiced: amount(monthInvoiced), collected: amount(monthCollected), expenses: amount(monthExpenses),
      // Cash collected minus expenses is net cash flow, not accounting profit.
      netCash: amount(monthCollected - monthExpenses),
      collectionRate: rate(monthCollected, monthInvoiced),
    },
    outstanding: { total: amount(outstanding), overdue: amount(overdue), partialInvoices, accountCount: debtorMap.size },
    branchSummaries,
    topDebtors,
    outstandingInvoices: outstandingInvoices.sort((a, b) => Number(b.isOverdue) - Number(a.isOverdue) || b.outstanding - a.outstanding || b.ageDays - a.ageDays),
    trend: buildFinancialTrendSeries({ invoices: input.invoices, payments: input.payments, expenses: input.expenses, from: trendFrom, to: tomorrowStart }),
  };
}
