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
// Same canonical status check is used in the period dashboard and the accrual bridge.
export function isIssuedFinancialInvoiceStatus(status:string):boolean {
  return recognizedBillingStatuses.has(status);
}
export function summarizeAccrualComponents(invoices:AccrualInvoice[],expenses:AccrualExpense[]){
  let issuedInvoiceCount=0, excludedDraftCount=0, excludedCancelledCount=0, unknownInvoiceCount=0;
  let invoiceGross=0, billedTax=0;
  let nonPayrollOperating=0, payrollCashOperating=0, nonOperating=0;
  let payrollCashExpenseCount=0;
  for(const invoice of invoices){
    if(invoice.status==="draft"){excludedDraftCount++;continue;}
    if(invoice.status==="cancelled"){excludedCancelledCount++;continue;}
    if(!isIssuedFinancialInvoiceStatus(invoice.status)){unknownInvoiceCount++;continue;}
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

/**
 * Diagnostic ONLY for invoices issued during the selected report window.
 * Service-cycle ownership is based on stored authoritative cycle timestamps,
 * rendered as local Gaza calendar days (UTC comparisons near month end are wrong).
 * This does not find invoices issued outside the reporting window and does not
 * allocate or recognize revenue across overlapping service periods.
 */
export type FinancialInvoiceCycle = {
  status:string; issueDate:Date; cycleStartAt:Date|null;
  cycleEndAt:Date|null; totalAmount:number;
};
const gazaCalendar=new Intl.DateTimeFormat("en-CA",{
  timeZone:"Asia/Gaza",year:"numeric",month:"2-digit",day:"2-digit",
});
const gazaDateKey=(date:Date)=>{
  if(!(date instanceof Date) || !Number.isFinite(date.getTime())){
    throw new InvalidAccrualComponents("Invalid invoice service timestamp");
  }
  const parts=gazaCalendar.formatToParts(date);
  const read=(type:string)=>parts.find(p=>p.type===type)?.value??"";
  const key=`${read("year")}-${read("month")}-${read("day")}`;
  if(!/^\\d{4}-\\d{2}-\\d{2}$/.test(key)){
    throw new InvalidAccrualComponents("Invalid Gaza calendar conversion");
  }
  return key;
};
const financialReportDay=(day:string)=>{
  if(!/^\\d{4}-\\d{2}-\\d{2}$/.test(day))throw new InvalidAccrualComponents("Invalid report date");
  const d=new Date(`${day}T12:00:00Z`);
  if(!Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==day){
    throw new InvalidAccrualComponents("Invalid calendar date");
  }
  return day;
};
export function summarizeInvoiceServiceCycleCoverage(
  startDate:string,endDate:string,invoices:FinancialInvoiceCycle[]
) {
  const start=financialReportDay(startDate),end=financialReportDay(endDate);
  if(start>end)throw new InvalidAccrualComponents("Reversed period");
  let reviewedInvoiceCount=0,withinPeriodCount=0,crossBoundaryCount=0;
  let outsidePeriodCount=0,missingCycleCount=0,issueDateOutsideCycleCount=0;
  let billedInOtherServiceMonthCount=0;
  let outsidePeriodCents=0,crossBoundaryCents=0;
  for(const invoice of invoices){
    if(!isIssuedFinancialInvoiceStatus(invoice.status))continue;
    reviewedInvoiceCount++;
    const amount=checkedCents(invoice.totalAmount,"invoice cycle amount");
    if(amount<0)throw new InvalidAccrualComponents("Negative invoice cycle amount");
    if(invoice.cycleStartAt===null||invoice.cycleEndAt===null){
      missingCycleCount++;
      continue;
    }
    if(!(invoice.cycleStartAt instanceof Date)||
       !(invoice.cycleEndAt instanceof Date)||
       invoice.cycleStartAt.getTime()>invoice.cycleEndAt.getTime()){
      throw new InvalidAccrualComponents("Invalid invoice service cycle");
    }
    const first=gazaDateKey(invoice.cycleStartAt);
    const last=gazaDateKey(invoice.cycleEndAt);
    const issued=gazaDateKey(invoice.issueDate);
    if(issued<first||issued>last)issueDateOutsideCycleCount++;
    if(issued.slice(0,7)!==last.slice(0,7))billedInOtherServiceMonthCount++;
    if(last<start||first>end){
      outsidePeriodCount++;
      outsidePeriodCents+=amount;
    }else if(first<start||last>end){
      crossBoundaryCount++;
      crossBoundaryCents+=amount;
    }else{
      withinPeriodCount++;
    }
  }
  if(![outsidePeriodCents,crossBoundaryCents].every(Number.isSafeInteger)){
    throw new InvalidAccrualComponents("Invoice service-cycle amount overflow");
  }
  return {
    reviewedInvoiceCount,withinPeriodCount,crossBoundaryCount,outsidePeriodCount,
    missingCycleCount,issueDateOutsideCycleCount,billedInOtherServiceMonthCount,
    outsidePeriodBilledGross:fromCents(outsidePeriodCents),
    crossBoundaryBilledGross:fromCents(crossBoundaryCents),
    isServicePeriodRevenueRecognized:false as const,
    coverageNotice:"issued_in_selected_date_range_only" as const,
  };
}
