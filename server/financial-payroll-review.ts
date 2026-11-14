/**
 * Financial payroll review — a disclosure/reconciliation aid, NOT a profit computation.
 * Source of wage expense is GROSS payroll for an approved/paid period.
 * The legacy payout procedure posts NET cash to expenses, so that row must not
 * be added again to gross payroll when building eventual accrual P&L.
 */
export type FinancialPayrollRun = {
  id: number; period: string; status: string;
  total_gross: string | number; total_deductions: string | number;
  total_net: string | number;
};
export type FinancialPayrollExpense = {
  id:number; reference_no: string | null; amount: string | number;
  company_account_id:number|null;
};
export type FinancialPayrollPayout = {
  id:number; reference_no:string|null; amount:string|number;
  account_id:number; related_expense_id:number|null;
  transaction_type:string;
};
export class InvalidPayrollReview extends Error {
  constructor(reason:string){super(reason);this.name="InvalidPayrollReview";}
}
const cents = (value:unknown, field:string) => {
  if (value===null || value===undefined || typeof value==="boolean" || value==="") {
    throw new InvalidPayrollReview(`Missing ${field}`);
  }
  const numeric=Number(value);
  if (!Number.isFinite(numeric) || numeric<0 || numeric>1e11 ||
    Math.abs(numeric*100-Math.round(numeric*100))>0.0001) {
    throw new InvalidPayrollReview(`Invalid ${field}`);
  }
  return Math.round(numeric*100);
};
const toMoney=(amount:number)=>amount/100;
export function reviewFinancialPayrollMonth(
  period:string, runs:FinancialPayrollRun[],
  linkedExpenses:FinancialPayrollExpense[], linkedPayouts:FinancialPayrollPayout[]
) {
  if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(period) || runs.length>200 || linkedExpenses.length>200 || linkedPayouts.length>200){
    throw new InvalidPayrollReview("Invalid period or row bound");
  }
  const ids=new Set<number>(), expenses=new Map<string,{id:number;amount:number;accountId:number|null}>(), payouts=new Map<string,{amount:number;accountId:number;expenseId:number|null}>();
  // The payout is a NET cash movement and must never be recognized as
  // a second wage cost on top of approved/paid GROSS payroll.

  for (const expense of linkedExpenses) {
    if(typeof expense.reference_no!=="string" || !/^PAYROLL-\d+$/.test(expense.reference_no) ||
       expenses.has(expense.reference_no)){
      throw new InvalidPayrollReview("Unlinked or duplicate payroll expense");
    }
    if (!Number.isSafeInteger(expense.id) || expense.id<=0 || (expense.company_account_id!==null && (!Number.isSafeInteger(expense.company_account_id)||expense.company_account_id<=0))) {
      throw new InvalidPayrollReview("Invalid expense identity");
    }
    expenses.set(expense.reference_no,{
      id:expense.id,amount:cents(expense.amount,"expense amount"),accountId:expense.company_account_id
    });
  }
  for(const payout of linkedPayouts){
    if(typeof payout.reference_no!=="string" || !/^PAYROLL-\d+$/.test(payout.reference_no) ||
      payouts.has(payout.reference_no) || payout.transaction_type!=="withdrawal" ||
      !Number.isSafeInteger(payout.id) || payout.id<=0 ||
      !Number.isSafeInteger(payout.account_id) || payout.account_id<=0 ||
      (payout.related_expense_id!==null && (!Number.isSafeInteger(payout.related_expense_id)||payout.related_expense_id<=0))){
      throw new InvalidPayrollReview("Invalid or duplicate payroll cash movement");
    }
    payouts.set(payout.reference_no,{
      amount:cents(payout.amount,"payroll payout amount"),
      accountId:payout.account_id,expenseId:payout.related_expense_id
    });
  }
  const counts={draft:0,approved:0,paid:0,cancelled:0};
  const gross={draft:0,approved:0,paid:0};
  const net={draft:0,approved:0,paid:0};
  const deductions={draft:0,approved:0,paid:0};
  const reconciliationIssues:string[]=[];
  let matchingExpenseCents=0;
  const allowed=["draft","approved","paid","cancelled"] as const;
  for(const run of runs){
    if(!Number.isSafeInteger(run.id) || run.id<=0 || ids.has(run.id) || run.period!==period){
      throw new InvalidPayrollReview("Duplicate or out-of-period payroll run");
    }
    ids.add(run.id);
    if(!allowed.includes(run.status as typeof allowed[number])){
      throw new InvalidPayrollReview("Unrecognized payroll status");
    }
    const status=run.status as typeof allowed[number];
    const totalGross=cents(run.total_gross,"gross payroll");
    const totalNet=cents(run.total_net,"net payroll");
    const totalDeductions=cents(run.total_deductions,"payroll deductions");
    if(Math.abs(totalGross-totalNet-totalDeductions)>1){
      throw new InvalidPayrollReview("Gross/net/deduction reconciliation failed");
    }
    counts[status]++;
    if(status!=="cancelled"){
      gross[status]+=totalGross;
      net[status]+=totalNet;
      deductions[status]+=totalDeductions;
    }
    const reference=`PAYROLL-${run.id}`;
    const actualExpense=expenses.get(reference);
    const payout=payouts.get(reference);
    if(status==="paid"){
      if(actualExpense===undefined){
        reconciliationIssues.push("MISSING_NET_PAYROLL_EXPENSE");
      } else if(Math.abs(actualExpense.amount-totalNet)>1){
        reconciliationIssues.push("NET_PAYROLL_EXPENSE_MISMATCH");
      }
      if(payout===undefined){
        reconciliationIssues.push("MISSING_PAYROLL_CASH_MOVEMENT");
      } else if(
        Math.abs(payout.amount-totalNet)>1 ||
        payout.expenseId!==actualExpense?.id ||
        payout.accountId!==actualExpense?.accountId
      ){
        reconciliationIssues.push("PAYROLL_CASH_MOVEMENT_MISMATCH");
      }
      if(actualExpense && payout &&
        Math.abs(actualExpense.amount-totalNet)<=1 &&
        Math.abs(payout.amount-totalNet)<=1 &&
        payout.expenseId===actualExpense.id &&
        payout.accountId===actualExpense.accountId){
        matchingExpenseCents+=actualExpense.amount;
      }
    } else if(actualExpense!==undefined || payout!==undefined){
      reconciliationIssues.push("PAYROLL_POSTING_BEFORE_PAYMENT");
    }
  }
  for(const ref of [...expenses.keys(),...payouts.keys()]){
    if(!ids.has(Number(ref.slice("PAYROLL-".length)))){
      throw new InvalidPayrollReview("Payroll posting outside scoped month");
    }
  }
  const draftGross=toMoney(gross.draft);
  const approvedGross=toMoney(gross.approved);
  const paidGross=toMoney(gross.paid);
  return {
    period,counts,
    draftGross,
    approvedGross,
    approvedNet:toMoney(net.approved),
    paidGross,
    paidNet:toMoney(net.paid),
    paidDeductions:toMoney(deductions.paid),
    approvedAndPaidGross:toMoney(gross.approved+gross.paid),
    matchedNetExpense:toMoney(matchingExpenseCents),
    reconciliationIssues,
    readyForProfitStatement:false as const,
    accountingNotice:"Payroll payout expenses represent net cash paid, not gross accrued wages; do not sum both.",
  };
}
