/**
 * Invoice-period billing and expense components for a NON-CERTIFIED accrual bridge.
 * It is intentionally not a P&L or recognized revenue calculation: invoices may
 * cover service periods that differ from issue date; depreciation, provisions,
 * payroll adjustments, and settlement accruals are not proven complete here.
 */
export type AccrualInvoice = {status:string;totalAmount:number;taxAmount:number};
export type AccrualExpense = {category:string;expenseClassification:"operating"|"non_operating";amount:number};
export class InvalidAccrualComponents extends Error {
  constructor(reason:string){super(reason);this.name="InvalidAccrualComponents";}
}
const checkedCents=(amount:number,field:string)=>{
  if(!Number.isFinite(amount) || Math.abs(amount)>1e12){
    throw new InvalidAccrualComponents("Invalid "+field);
  }
  return Math.round(amount*100);
};
const fromCents=(v:number)=>v/100;
const recognizedBillingStatuses=new Set(["issued","overdue","partially_paid","paid"]);
export function summarizeAccrualComponents(invoices:AccrualInvoice[],expenses:AccrualExpense[]){
  let issuedInvoiceCount=0, excludedDraftCount=0, excludedCancelledCount=0, unknownInvoiceCount=0;
  let invoiceGross=0, billedTax=0;
  let nonPayrollOperating=0, payrollCashOperating=0, nonOperating=0;
  let payrollCashExpenseCount=0;
  for(const invoice of invoices){
    if(invoice.status==="draft"){excludedDraftCount++;continue;}
    if(invoice.status==="cancelled"){excludedCancelledCount++;continue;}
    if(!recognizedBillingStatuses.has(invoice.status)){unknownInvoiceCount++;continue;}
    const gross=checkedCents(invoice.totalAmount,"invoice gross");
    const tax=checkedCents(invoice.taxAmount,"invoice tax");
    if(gross<0 || tax<0 || tax>gross){
      throw new InvalidAccrualComponents("Inconsistent invoice total and tax");
    }
    invoiceGross+=gross;
    billedTax+=tax;
    issuedInvoiceCount++;
  }
  for(const expense of expenses){
    const value=checkedCents(expense.amount,"expense amount");
    if(value<0) throw new InvalidAccrualComponents("Negative expense amount");
    if(expense.expenseClassification==="non_operating"){
      nonOperating+=value;
    }else if(expense.expenseClassification==="operating" && expense.category==="payroll"){
      payrollCashOperating+=value;
      payrollCashExpenseCount++;
    }else if(expense.expenseClassification==="operating"){
      nonPayrollOperating+=value;
    }else{
      throw new InvalidAccrualComponents("Unrecognized expense classification");
    }
  }
  if (![invoiceGross,billedTax,nonPayrollOperating,payrollCashOperating,nonOperating].every(Number.isSafeInteger)){
    throw new InvalidAccrualComponents("Financial totals out of range");
  }
  return {
    issuedInvoiceCount,excludedDraftCount,excludedCancelledCount,unknownInvoiceCount,
    billedGross:fromCents(invoiceGross),
    billedTax:fromCents(billedTax),
    billedExTax:fromCents(invoiceGross-billedTax),
    nonPayrollOperatingExpenses:fromCents(nonPayrollOperating),
    payrollCashOperatingExpenses:fromCents(payrollCashOperating),
    payrollCashExpenseCount,
    nonOperatingExpenses:fromCents(nonOperating),
    isRecognizedRevenue:false as const,
    isCompleteProfitAndLoss:false as const,
  };
}
