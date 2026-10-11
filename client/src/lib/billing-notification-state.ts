export type InvoiceSmsNotificationRow = {
  notification: {
    invoiceId: number | null;
    status: string;
    scheduledAt?: Date | null;
  };
};

export type InvoiceSmsQueryState = "loading" | "error" | "ready";

export function groupInvoiceSmsStatuses(rows: InvoiceSmsNotificationRow[]) {
  const grouped = new Map<number, string[]>();
  for (const row of rows) {
    const invoiceId = row.notification.invoiceId;
    if (typeof invoiceId !== "number") continue;
    grouped.set(invoiceId, [...(grouped.get(invoiceId) ?? []), row.notification.status]);
  }
  return grouped;
}

export function isInvoiceSmsEligibleForNewQueue(statuses: readonly string[], queryState: InvoiceSmsQueryState) {
  return queryState === "ready" && statuses.length === 0;
}

export function invoiceSmsStatusLabel(statuses: readonly string[], queryState: InvoiceSmsQueryState) {
  if (queryState === "loading") return "جارٍ التحقق";
  if (queryState === "error") return "تعذر التحقق";
  if (statuses.includes("needs_review")) return "تحتاج مراجعة";
  if (statuses.includes("failed")) return "فشل";
  if (statuses.includes("pending")) return "في قائمة الانتظار";
  if (statuses.includes("processing")) return "قيد الإرسال";
  if (statuses.some((status) => ["sent", "submitted", "delivered", "read"].includes(status))) return "مرسل";
  return "غير مُجهّز";
}
