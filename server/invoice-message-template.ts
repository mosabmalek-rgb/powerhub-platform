import type { InvoiceNotificationChannel } from "./notification-channels";

export const invoiceTemplateVariables = ["subscriber_name", "invoice_no", "billing_period", "total_amount", "due_date", "invoice_link", "portal_link", "subscriber_no"] as const;

export const defaultInvoiceMessageTemplates: Record<InvoiceNotificationChannel, string> = {
  whatsapp: "مرحباً {{subscriber_name}}، صدرت فاتورتك رقم {{invoice_no}} عن فترة {{billing_period}} بإجمالي {{total_amount}}. تاريخ الاستحقاق: {{due_date}}.",
  sms: "PowerHub: {{subscriber_name}}، فاتورتك {{invoice_no}} للفترة {{billing_period}} بقيمة {{total_amount}}. الاستحقاق: {{due_date}}.",
};

export type InvoiceTemplateData = Record<(typeof invoiceTemplateVariables)[number], string>;

export function renderInvoiceMessageTemplate(template: string, values: InvoiceTemplateData) {
  return template.replace(/{{\s*([a-z_]+)\s*}}/g, (_, key: string) => Object.prototype.hasOwnProperty.call(values, key) ? values[key as keyof InvoiceTemplateData] ?? "" : "");
}
