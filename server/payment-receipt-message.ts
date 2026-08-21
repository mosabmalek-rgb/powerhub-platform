export type PaymentReceiptMessageInput = {
  subscriberName: string;
  paymentNo: string;
  paymentAmount: number;
  invoiceNo: string;
  balanceDue: number;
};

const amount = (value: number) => new Intl.NumberFormat("ar", { maximumFractionDigits: 2 }).format(value);

export function renderPaymentReceiptMessage(input: PaymentReceiptMessageInput) {
  return `مرحباً ${input.subscriberName}، تم استلام دفعة بقيمة ${amount(input.paymentAmount)} عن فاتورتك رقم ${input.invoiceNo}. رقم الإيصال: ${input.paymentNo}. الرصيد المتبقي: ${amount(input.balanceDue)}.`;
}

export function paymentReceiptTemplateParameters(input: PaymentReceiptMessageInput) {
  return [input.subscriberName, input.paymentNo, amount(input.paymentAmount), input.invoiceNo, amount(input.balanceDue)];
}
