import {describe,it,expect} from "vitest";
import {reviewFinancialPayrollMonth,InvalidPayrollReview} from "./financial-payroll-review";

const run=(id:number,status:string,gross="5550.00",deductions="125.00",net="5425.00")=>({
 id,period:"2026-10",status,total_gross:gross,total_deductions:deductions,total_net:net
});
const expense=(runId=1,amount:string|number="5425.00",accountId:number|null=5)=>({
 id:10,reference_no:`PAYROLL-${runId}`,amount,company_account_id:accountId
});
const withdrawal=(runId=1,amount:string|number="5425.00",expenseId:number|null=10,accountId=5)=>({
 id:20,reference_no:`PAYROLL-${runId}`,amount,account_id:accountId,
 related_expense_id:expenseId,transaction_type:"withdrawal",
});
describe("financial payroll accrual and payout reconciliation",()=>{
 it("excludes drafts from approved wage cost",()=>{
  const r=reviewFinancialPayrollMonth("2026-10",[run(1,"draft")],[],[]);
  expect(r.draftGross).toBe(5550);
  expect(r.approvedAndPaidGross).toBe(0);
  expect(r.readyForProfitStatement).toBe(false);
 });
 it("recognizes approved wage cost without recording a cash expense",()=>{
  const r=reviewFinancialPayrollMonth("2026-10",[run(1,"approved")],[],[]);
  expect(r.approvedGross).toBe(5550);
  expect(r.approvedNet).toBe(5425);
  expect(r.reconciliationIssues).toEqual([]);
 });
 it("matches paid gross once to net cash expense and linked withdrawal",()=>{
  const r=reviewFinancialPayrollMonth("2026-10",[run(1,"paid")],[expense()],[withdrawal()]);
  expect(r.paidGross).toBe(5550);
  expect(r.paidDeductions).toBe(125);
  expect(r.paidNet).toBe(5425);
  expect(r.matchedNetExpense).toBe(5425);
  expect(r.reconciliationIssues).toEqual([]);
 });
 it("reports missing and mismatched expense, withdrawal or linkage",()=>{
  expect(reviewFinancialPayrollMonth("2026-10",[run(1,"paid")],[],[]).reconciliationIssues)
   .toContain("MISSING_NET_PAYROLL_EXPENSE");
  expect(reviewFinancialPayrollMonth("2026-10",[run(1,"paid")],[expense()],[]).reconciliationIssues)
   .toContain("MISSING_PAYROLL_CASH_MOVEMENT");
  expect(reviewFinancialPayrollMonth("2026-10",[run(1,"paid")],[expense()],[withdrawal(1,5425,999)]).reconciliationIssues)
   .toContain("PAYROLL_CASH_MOVEMENT_MISMATCH");
  expect(reviewFinancialPayrollMonth("2026-10",[run(1,"paid")],[expense()],[withdrawal(1,5425,10,6)]).reconciliationIssues)
   .toContain("PAYROLL_CASH_MOVEMENT_MISMATCH");
  expect(reviewFinancialPayrollMonth("2026-10",[run(1,"paid")],[expense(1,2)],[withdrawal()]).reconciliationIssues)
   .toContain("NET_PAYROLL_EXPENSE_MISMATCH");
 });
 it("detects posting before payment and multiple movements",()=>{
  expect(reviewFinancialPayrollMonth("2026-10",[run(1,"approved")],[expense()],[withdrawal()]).reconciliationIssues)
   .toContain("PAYROLL_POSTING_BEFORE_PAYMENT");
  expect(()=>reviewFinancialPayrollMonth("2026-10",[run(1,"paid")],[expense()],[withdrawal(),withdrawal()]))
   .toThrow(InvalidPayrollReview);
 });
 it("rejects duplicate payroll IDs and expense references",()=>{
  expect(()=>reviewFinancialPayrollMonth("2026-10",[run(1,"paid"),run(1,"paid")],[],[])).toThrow();
  expect(()=>reviewFinancialPayrollMonth("2026-10",[run(1,"paid")],[expense(),expense()],[])).toThrow();
 });
 it("rejects broken gross/net/deductions and negative financial amounts",()=>{
  expect(()=>reviewFinancialPayrollMonth("2026-10",[run(1,"approved","5550","125","5420")],[],[])).toThrow();
  expect(()=>reviewFinancialPayrollMonth("2026-10",[run(1,"approved","-1","0","0")],[],[])).toThrow();
 });
 it("rejects out-of-period and unrelated payroll-linked postings",()=>{
  expect(()=>reviewFinancialPayrollMonth("2026-11",[run(1,"paid")],[],[])).toThrow();
  expect(()=>reviewFinancialPayrollMonth("2026-10",[run(1,"paid")],[expense(2)],[])).toThrow();
  expect(()=>reviewFinancialPayrollMonth("2026-10",[run(1,"paid")],[],[withdrawal(2)])).toThrow();
 });
});