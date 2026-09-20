export const REPORT_LOCALE = "ar";

export const REPORT_CURRENCY = "شيكل";

export const REPORT_PAYMENT_METHOD_LABELS: Record<string, string> = {
  cash: "نقدًا",
  jawwal_pay: "Jawwal Pay",
  palpay: "PalPay",
  bank_of_palestine: "بنك فلسطين",
  wallet: "محفظة إلكترونية",
  bank_transfer: "تحويل بنكي",
  card: "بطاقة",
};

export const REPORT_PAYMENT_METHOD_OPTIONS = [
  { value: "all", label: "كل طرق الدفع" },
  ...Object.entries(REPORT_PAYMENT_METHOD_LABELS).map(([value, label]) => ({ value, label })),
] as const;

export const REPORT_METRICS = [
  { key: "invoiced", label: "إجمالي الفوترة" },
  { key: "collected", label: "إجمالي التحصيل" },
  { key: "outstanding", label: "الأرصدة المستحقة" },
  { key: "expenseTotal", label: "إجمالي المصروفات" },
  { key: "operatingProfit", label: "صافي التدفق التشغيلي" },
] as const;

export function formatReportDate(value: string | number | Date | null | undefined): string {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(REPORT_LOCALE, {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
}

export function formatReportDateTime(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(REPORT_LOCALE, {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function formatReportNumber(value: unknown, digits = 2): string {
  return new Intl.NumberFormat(REPORT_LOCALE, {
    maximumFractionDigits: digits,
  }).format(Number(value ?? 0));
}

export function formatReportMoney(value: unknown, digits = 2): string {
  return `${formatReportNumber(value, digits)} ${REPORT_CURRENCY}`;
}

export function formatReportPeriod(startDate: string, endDate: string): string {
  return `${formatReportDate(startDate)} — ${formatReportDate(endDate)}`;
}
