export type FinancialOverviewInvoice = {
  siteId: number;
  subscriberId: number;
  subscriberName: string;
  subscriberNo: string;
  invoiceNo: string;
  issueDate: Date;
  dueDate: Date;
  totalAmount: number;
  paidAmount: number;
  balanceDue: number;
  status: string;
};

export type FinancialOverviewPayment = {
  siteId: number;
  subscriberId: number;
  amount: number;
  status: string;
  paidAt: Date;
};

export type FinancialOverviewExpense = {
  siteId: number;
  amount: number;
  occurredAt: Date;
};

export type FinancialOverviewBranch = { id: number; name: string; activeSubscribers: number };

export function periodBounds(now: Date) {
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const tomorrowStart = new Date(todayStart);
  tomorrowStart.setUTCDate(tomorrowStart.getUTCDate() + 1);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const nextMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { todayStart, tomorrowStart, monthStart, nextMonthStart };
}

const inRange = (date: Date, start: Date, endExclusive: Date) => date >= start && date < endExclusive;
const safeNumber = (value: number) => Number.isFinite(value) ? value : 0;

export function buildFinancialOverview(input: {
  branches: FinancialOverviewBranch[];
  invoices: FinancialOverviewInvoice[];
  payments: FinancialOverviewPayment[];
  expenses: FinancialOverviewExpense[];
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const { todayStart, tomorrowStart, monthStart, nextMonthStart } = periodBounds(now);
  const branchMap = new Map(input.branches.map((branch) => [branch.id, {
    ...branch,
    invoiced: 0,
    collected: 0,
    outstanding: 0,
    overdue: 0,
    partialInvoices: 0,
  }]));

  let todayInvoiced = 0;
  let todayCollected = 0;
  let monthInvoiced = 0;
  let monthCollected = 0;
  let monthExpenses = 0;
  let outstanding = 0;
  let overdue = 0;
  let partialInvoices = 0;
  const lastPaymentBySubscriber = new Map<string, Date>();
  const debtorMap = new Map<string, {
    siteId: number;
    subscriberId: number;
    subscriber: string;
    subscriberNo: string;
    outstanding: number;
    invoiceCount: number;
    partialInvoices: number;
    oldestDueDate: Date;
    isOverdue: boolean;
  }>();

  for (const invoice of input.invoices) {
    const validInvoice = invoice.status !== "cancelled" && invoice.status !== "draft";
    if (!validInvoice) continue;
    const branch = branchMap.get(invoice.siteId);
    const balance = Math.max(0, safeNumber(invoice.balanceDue));
    const invoiceTotal = safeNumber(invoice.totalAmount);
    const isOverdue = balance > 0 && invoice.dueDate < now;

    if (inRange(invoice.issueDate, todayStart, tomorrowStart)) todayInvoiced += invoiceTotal;
    if (inRange(invoice.issueDate, monthStart, nextMonthStart)) {
      monthInvoiced += invoiceTotal;
      if (branch) branch.invoiced += invoiceTotal;
    }
    if (balance > 0) {
      outstanding += balance;
      if (branch) branch.outstanding += balance;
      if (isOverdue) {
        overdue += balance;
        if (branch) branch.overdue += balance;
      }
      if (invoice.status === "partially_paid") {
        partialInvoices += 1;
        if (branch) branch.partialInvoices += 1;
      }
      const key = `${invoice.siteId}:${invoice.subscriberId}`;
      const debtor = debtorMap.get(key) ?? {
        siteId: invoice.siteId,
        subscriberId: invoice.subscriberId,
        subscriber: invoice.subscriberName,
        subscriberNo: invoice.subscriberNo,
        outstanding: 0,
        invoiceCount: 0,
        partialInvoices: 0,
        oldestDueDate: invoice.dueDate,
        isOverdue: false,
      };
      debtor.outstanding += balance;
      debtor.invoiceCount += 1;
      if (invoice.status === "partially_paid") debtor.partialInvoices += 1;
      if (invoice.dueDate < debtor.oldestDueDate) debtor.oldestDueDate = invoice.dueDate;
      debtor.isOverdue ||= isOverdue;
      debtorMap.set(key, debtor);
    }
  }

  for (const payment of input.payments) {
    if (payment.status !== "completed") continue;
    const amount = safeNumber(payment.amount);
    const branch = branchMap.get(payment.siteId);
    const paymentKey = `${payment.siteId}:${payment.subscriberId}`;
    const previousPayment = lastPaymentBySubscriber.get(paymentKey);
    if (!previousPayment || payment.paidAt > previousPayment) lastPaymentBySubscriber.set(paymentKey, payment.paidAt);
    if (inRange(payment.paidAt, todayStart, tomorrowStart)) todayCollected += amount;
    if (inRange(payment.paidAt, monthStart, nextMonthStart)) {
      monthCollected += amount;
      if (branch) branch.collected += amount;
    }
  }

  for (const expense of input.expenses) {
    if (inRange(expense.occurredAt, monthStart, nextMonthStart)) monthExpenses += safeNumber(expense.amount);
  }

  const collectionRate = monthInvoiced > 0 ? (monthCollected / monthInvoiced) * 100 : 0;
  const todayCollectionRate = todayInvoiced > 0 ? (todayCollected / todayInvoiced) * 100 : 0;
  const branchSummaries = Array.from(branchMap.values())
    .map((branch) => ({
      ...branch,
      collectionRate: branch.invoiced > 0 ? (branch.collected / branch.invoiced) * 100 : 0,
    }))
    .sort((a, b) => b.outstanding - a.outstanding || a.collectionRate - b.collectionRate);
  const topDebtors = Array.from(debtorMap.values())
    .map((debtor) => ({
      ...debtor,
      ageDays: debtor.isOverdue ? Math.max(1, Math.floor((now.getTime() - debtor.oldestDueDate.getTime()) / 86_400_000)) : 0,
      oldestDueDate: debtor.oldestDueDate.toISOString(),
      lastPaymentAt: lastPaymentBySubscriber.get(`${debtor.siteId}:${debtor.subscriberId}`)?.toISOString() ?? null,
      branchName: input.branches.find((branch) => branch.id === debtor.siteId)?.name ?? "فرع غير محدد",
    }))
    .sort((a, b) => Number(b.isOverdue) - Number(a.isOverdue) || b.outstanding - a.outstanding)
    .slice(0, 10);

  return {
    generatedAt: now.toISOString(),
    period: { today: todayStart.toISOString().slice(0, 10), month: monthStart.toISOString().slice(0, 7) },
    today: { invoiced: todayInvoiced, collected: todayCollected, collectionRate: todayCollectionRate },
    month: { invoiced: monthInvoiced, collected: monthCollected, expenses: monthExpenses, netCash: monthCollected - monthExpenses, collectionRate },
    outstanding: { total: outstanding, overdue, partialInvoices, accountCount: debtorMap.size },
    branchSummaries,
    topDebtors,
  };
}
