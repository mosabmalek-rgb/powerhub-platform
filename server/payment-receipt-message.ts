import { formatPolicyAwareMessageAmount } from "./decimal-money";

export type PaymentReceiptMessageInput = {
  subscriberName: string;
  paymentNo: string;
  paymentAmount: number;
  invoiceNo: string;
  balanceDue: number;
};

const amount = (value: number, settlementEnabled = false) => formatPolicyAwareMessageAmount(value, settlementEnabled);
export const defaultPaymentReceiptSmsTemplate = "مرحباً {{subscriber_name}}، تم استلام دفعة بقيمة {{payment_amount}} عن فاتورتك رقم {{invoice_no}}. رقم الإيصال: {{payment_no}}. الرصيد المتبقي: {{balance_due}}.";
export const paymentReceiptTemplateVariables = ["{{subscriber_name}}", "{{payment_no}}", "{{payment_amount}}", "{{invoice_no}}", "{{balance_due}}"]; 

export function paymentReceiptTemplateValues(input: PaymentReceiptMessageInput, settlementEnabled = false) {
  return { subscriber_name: input.subscriberName, payment_no: input.paymentNo, payment_amount: amount(input.paymentAmount, settlementEnabled), invoice_no: input.invoiceNo, balance_due: amount(input.balanceDue, settlementEnabled) };
}

export function renderPaymentReceiptTemplate(template: string, input: PaymentReceiptMessageInput, settlementEnabled = false) {
  const values = paymentReceiptTemplateValues(input, settlementEnabled);
  return template.replace(/{{\s*(subscriber_name|payment_no|payment_amount|invoice_no|balance_due)\s*}}/g, (_, key) => values[key as keyof typeof values] ?? "");
}

export function renderPaymentReceiptMessage(input: PaymentReceiptMessageInput, settlementEnabled = false) {
  return renderPaymentReceiptTemplate(defaultPaymentReceiptSmsTemplate, input, settlementEnabled);
}

export function paymentReceiptTemplateParameters(input: PaymentReceiptMessageInput, settlementEnabled = false) {
  return [input.subscriberName, input.paymentNo, amount(input.paymentAmount, settlementEnabled), input.invoiceNo, amount(input.balanceDue, settlementEnabled)];
}
