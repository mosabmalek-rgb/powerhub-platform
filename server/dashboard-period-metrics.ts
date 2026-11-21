import { decimalAmountToMinorUnits, minorUnitsToAmountString } from "./decimal-money";

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
  totalAmount: number | string;
  paidAmount: number | string;
  balanceDue: number | string;
  status: string;
};
export type DashboardPeriodPayment = { status: string; amount: number | string };

const minor = (value: number | string | null | undefined) => decimalAmountToMinorUnits(value);
const amount = (value: bigint) => Number(minorUnitsToAmountString(value));
const rate = (numerator: bigint, denominator: bigint) => denominator > 0n ? Number(numerator) / Number(denominator) * 100 : 0;

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
  const openInvoices = invoices.filter((invoice) => minor(invoice.balanceDue) > 0n);
  const overdueInvoices = openInvoices.filter((invoice) => invoice.dueDate < now);

  const invoiced = invoices.reduce((sum, invoice) => sum + minor(invoice.totalAmount), 0n);
  const collected = payments.reduce((sum, payment) => sum + minor(payment.amount), 0n);
  const outstanding = openInvoices.reduce((sum, invoice) => sum + minor(invoice.balanceDue), 0n);
  const overdue = overdueInvoices.reduce((sum, invoice) => sum + minor(invoice.balanceDue), 0n);

  const outstandingInvoices = input.includeDetails === false ? [] : openInvoices.map((invoice) => {
    const balance = minor(invoice.balanceDue);
    const isOverdue = invoice.dueDate < now;
    return {
      siteId: invoice.siteId, siteName: invoice.siteName, subscriberId: invoice.subscriberId,
      subscriber: invoice.subscriberName || "مشترك غير محدد", subscriberNo: invoice.subscriberNo || "—",
      invoiceId: invoice.id, invoiceNo: invoice.invoiceNo || "—", issueDate: invoice.issueDate.toISOString(),
      outstanding: amount(balance), dueDate: invoice.dueDate.toISOString(), isOverdue,
      ageDays: isOverdue ? Math.max(1, Math.floor((now.getTime() - invoice.dueDate.getTime()) / 86400000)) : 0,
      partialInvoices: invoice.status === "partially_paid" ? 1 : 0, status: invoice.status,
    };
  }).sort((a, b) => Number(b.isOverdue) - Number(a.isOverdue) || b.outstanding - a.outstanding || b.ageDays - a.ageDays);

  return {
    range: { startDate: input.startDate, endDate: input.endDate },
    scope: input.scope,
    summary: {
      invoiced: amount(invoiced), collected: amount(collected), collectionRate: rate(collected, invoiced),
      outstanding: amount(outstanding), overdue: amount(overdue),
      overdueInvoiceCount: overdueInvoices.length,
      overdueSubscriberCount: new Set(overdueInvoices.map((invoice) => `${invoice.siteId}:${invoice.subscriberId}`)).size,
    },
    outstandingInvoices,
  };
}
