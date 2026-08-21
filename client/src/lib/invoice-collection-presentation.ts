export type InvoicePresentation = {
  id: number;
  status: string;
  totalAmount: string | number;
  paidAmount: string | number;
  balanceDue: string | number;
};

export const invoiceStatusPresentation: Record<string, { label: string; tone: "emerald" | "amber" | "rose" | "slate" | "sky" }> = {
  paid: { label: "مدفوعة بالكامل", tone: "emerald" },
  partially_paid: { label: "مدفوعة جزئياً", tone: "amber" },
  issued: { label: "غير مسددة", tone: "rose" },
  overdue: { label: "متأخرة", tone: "rose" },
  draft: { label: "مسودة", tone: "slate" },
  cancelled: { label: "ملغاة", tone: "slate" },
};

export function invoiceStatusMeta(status: string) {
  return invoiceStatusPresentation[status] ?? { label: status, tone: "sky" as const };
}

export function outstandingInvoices<T extends InvoicePresentation>(invoices: T[]) {
  return invoices.filter((invoice) => !["cancelled", "draft", "paid"].includes(invoice.status) && Number(invoice.balanceDue) > 0);
}

export function summarizeOutstandingInvoices(invoices: InvoicePresentation[]) {
  const open = outstandingInvoices(invoices);
  return {
    count: open.length,
    outstanding: open.reduce((sum, invoice) => sum + Number(invoice.balanceDue), 0),
    partiallyPaidCount: open.filter((invoice) => invoice.status === "partially_paid").length,
    unpaidCount: open.filter((invoice) => ["issued", "overdue"].includes(invoice.status)).length,
  };
}
