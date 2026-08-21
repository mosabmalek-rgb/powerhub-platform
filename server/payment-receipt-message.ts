export type PaymentReceiptMessageInput = {
  subscriberName: string;
  paymentNo: string;
  paymentAmount: number;
  invoiceNo: string;
  balanceDue: number;
};

const amount = (value: number) => new Intl.NumberFormat("ar", { maximumFractionDigits: 2 }).format(value);
export const defaultPaymentReceiptSmsTemplate = "مرحباً {{subscriber_name}}، تم استلام دفعة بقيمة {{payment_amount}} عن فاتورتك رقم {{invoice_no}}. رقم الإيصال: {{payment_no}}. الرصيد المتبقي: {{balance_due}}.";
export const paymentReceiptTemplateVariables = ["{{subscriber_name}}", "{{payment_no}}", "{{payment_amount}}", "{{invoice_no}}", "{{balance_due}}"]; 

export function paymentReceiptTemplateValues(input: PaymentReceiptMessageInput) {
  return { subscriber_name: input.subscriberName, payment_no: input.paymentNo, payment_amount: amount(input.paymentAmount), invoice_no: input.invoiceNo, balance_due: amount(input.balanceDue) };
}

export function renderPaymentReceiptTemplate(template: string, input: PaymentReceiptMessageInput) {
  const values = paymentReceiptTemplateValues(input);
  return template.replace(/{{\s*(subscriber_name|payment_no|payment_amount|invoice_no|balance_due)\s*}}/g, (_, key) => values[key as keyof typeof values] ?? "");
}

export function renderPaymentReceiptMessage(input: PaymentReceiptMessageInput) {
  return renderPaymentReceiptTemplate(defaultPaymentReceiptSmsTemplate, input);
}

export function paymentReceiptTemplateParameters(input: PaymentReceiptMessageInput) {
  return [input.subscriberName, input.paymentNo, amount(input.paymentAmount), input.invoiceNo, amount(input.balanceDue)];
}
