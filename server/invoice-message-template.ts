import type { InvoiceNotificationChannel } from "./notification-channels";
import { formatPolicyAwareMessageAmount } from "./decimal-money";

export const invoiceTemplateVariables = ["subscriber_name", "subscriber_no", "invoice_no", "billing_period", "total_amount", "balance_due", "previous_reading", "current_reading", "consumption_kwh", "total_balance", "due_date", "invoice_link", "portal_link"] as const;

export const defaultPaymentReminderSmsTemplate = "PowerHub: {{subscriber_name}}، تذكير بالسداد للفاتورة {{invoice_no}}. المبلغ المتبقي: {{balance_due}} شيكل. تاريخ الاستحقاق: {{due_date}}. {{invoice_link}}";

export const defaultInvoiceMessageTemplates: Record<InvoiceNotificationChannel, string> = {
  whatsapp: "مرحباً {{subscriber_name}}، صدرت فاتورتك رقم {{invoice_no}} عن فترة {{billing_period}} بإجمالي {{total_amount}}. تاريخ الاستحقاق: {{due_date}}.",
  sms: "PowerHub: {{subscriber_name}}، فاتورتك {{invoice_no}} للفترة {{billing_period}} بقيمة {{total_amount}}. الاستحقاق: {{due_date}}.",
};

export type InvoiceTemplateData = Partial<Record<(typeof invoiceTemplateVariables)[number], string>>;

const monetaryTemplateVariables = ["total_amount", "balance_due", "total_balance"] as const;

export function renderInvoiceMessageTemplate(template: string, values: InvoiceTemplateData, settlementEnabled = false) {
  const displayValues = { ...values };
  for (const key of monetaryTemplateVariables) {
    const value = displayValues[key];
    if (value != null && value !== "") displayValues[key] = formatPolicyAwareMessageAmount(value, settlementEnabled);
  }
  return invoiceTemplateVariables.reduce(
    (message, key) => message.replace(new RegExp("\\{\\{\\s*" + key + "\\s*\\}\\}", "g"), displayValues[key] ?? ""),
    template,
  );
}
