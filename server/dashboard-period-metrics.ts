export type DashboardPeriodInvoice = {
  id: number;
  siteId: number;
  siteName: string;
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

export type DashboardPeriodPayment = {
  status: string;
  amount: number | string;
};

export function buildDashboardPeriodMetrics(input: {
  startDate: string;
  endDate: string;
  scope: "branch" | "all";
  invoices: DashboardPeriodInvoice[];
  payments: DashboardPeriodPayment[];
  now?: Date;
  includeDetails?: boolean;
}) {
  if (input.startDate > input.endDate) throw new Error("الفترة الزمنية غير صالحة.");
  const now = input.now ?? new Date();
  const invoices = input.invoices.filter((invoice) => invoice.status !== "cancelled" && invoice.status !== "draft");
  const payments = input.payments.filter((payment) => payment.status === "completed");
  const openInvoices = invoices.filter((invoice) => Number.isFinite(Number(invoice.balanceDue)) && Number(invoice.balanceDue) > 0);
  const overdueInvoices = openInvoices.filter((invoice) => invoice.dueDate < now);
  const invoiced = invoices.reduce((total, invoice) => total + finiteMoney(invoice.totalAmount), 0);
  const collected = payments.reduce((total, payment) => total + finiteMoney(payment.amount), 0);
  const outstanding = openInvoices.reduce((total, invoice) => total + finiteMoney(invoice.balanceDue), 0);
  const overdue = overdueInvoices.reduce((total, invoice) => total + finiteMoney(invoice.balanceDue), 0);
  const outstandingInvoices = input.includeDetails === false ? [] : openInvoices.map((invoice) => {
    const isOverdue = invoice.dueDate < now;
    return {
      siteId: invoice.siteId,
      siteName: invoice.siteName,
      subscriberId: invoice.subscriberId,
      subscriber: invoice.subscriberName || "مشترك غير محدد",
      subscriberNo: invoice.subscriberNo || "—",
      invoiceId: invoice.id,
      invoiceNo: invoice.invoiceNo || "—",
      issueDate: invoice.issueDate.toISOString(),
      outstanding: finiteMoney(invoice.balanceDue),
      dueDate: invoice.dueDate.toISOString(),
      isOverdue,
      ageDays: isOverdue ? Math.max(1, Math.floor((now.getTime() - invoice.dueDate.getTime()) / 86400000)) : 0,
      partialInvoices: invoice.status === "partially_paid" ? 1 : 0,
      status: invoice.status,
    };
  }).sort((a, b) => Number(b.isOverdue) - Number(a.isOverdue) || b.outstanding - a.outstanding || b.ageDays - a.ageDays);

  return {
    range: { startDate: input.startDate, endDate: input.endDate },
    scope: input.scope,
    summary: {
      invoiced,
      collected,
      collectionRate: invoiced > 0 ? collected / invoiced * 100 : 0,
      outstanding,
      overdue,
      overdueInvoiceCount: overdueInvoices.length,
      overdueSubscriberCount: new Set(overdueInvoices.map((invoice) => `${invoice.siteId}:${invoice.subscriberId}`)).size,
    },
    outstandingInvoices,
  };
}

function finiteMoney(value: number | string) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}
