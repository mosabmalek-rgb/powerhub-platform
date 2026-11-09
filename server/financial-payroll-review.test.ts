import {describe,it,expect} from "vitest";
import {reviewFinancialPayrollMonth,InvalidPayrollReview} from "./financial-payroll-review";
const run=(id:number,status:string,gross="5550.00",deductions="125.00",net="5425.00")=>({
  id,period:"2026-10",status,total_gross:gross,total_deductions:deductions,total_net:net
});
describe("financial payroll accrual readiness",()=>{
 it("excludes drafts from recognized gross and reports their pending amounts",()=>{
   const r=reviewFinancialPayrollMonth("2026-10",[run(1,"draft")],[]);
   expect(r.draftGross).toBe(5550);
   expect(r.approvedAndPaidGross).toBe(0);
   expect(r.readyForProfitStatement).toBe(false);
 });
 it("tracks approved gross and net payable without posting a paid expense",()=>{
   const r=reviewFinancialPayrollMonth("2026-10",[run(1,"approved")],[]);
   expect(r.approvedGross).toBe(5550);
   expect(r.approvedNet).toBe(5425);
   expect(r.reconciliationIssues).toEqual([]);
 });
 it("matches paid gross with the separate net cash expense exactly once",()=>{
   const r=reviewFinancialPayrollMonth("2026-10",[run(1,"paid")],[{reference_no:"PAYROLL-1",amount:"5425.00"}]);
   expect(r.paidGross).toBe(5550);
   expect(r.paidDeductions).toBe(125);
   expect(r.matchedNetExpense).toBe(5425);
   expect(r.approvedAndPaidGross).toBe(5550);
 });
 it("flags missing, mismatched and premature expense entries",()=>{
   expect(reviewFinancialPayrollMonth("2026-10",[run(1,"paid")],[]).reconciliationIssues).toContain("MISSING_NET_PAYROLL_EXPENSE");
   expect(reviewFinancialPayrollMonth("2026-10",[run(1,"paid")],[{reference_no:"PAYROLL-1",amount:2}]).reconciliationIssues).toContain("NET_PAYROLL_EXPENSE_MISMATCH");
   expect(reviewFinancialPayrollMonth("2026-10",[run(1,"draft")],[{reference_no:"PAYROLL-1",amount:5425}]).reconciliationIssues).toContain("EXPENSE_FOR_UNPAID_OR_CANCELLED_PAYROLL");
 });
 it("rejects duplicate IDs and duplicate expense records",()=>{
   expect(()=>reviewFinancialPayrollMonth("2026-10",[run(1,"paid"),run(1,"paid")],[])).toThrow(InvalidPayrollReview);
   expect(()=>reviewFinancialPayrollMonth("2026-10",[run(1,"paid")],[{reference_no:"PAYROLL-1",amount:5425},{reference_no:"PAYROLL-1",amount:5425}])).toThrow(InvalidPayrollReview);
 });
 it("rejects negative amounts and inconsistent gross/net deduction",()=>{
   expect(()=>reviewFinancialPayrollMonth("2026-10",[run(1,"approved","5550","125","5420")],[])).toThrow(InvalidPayrollReview);
   expect(()=>reviewFinancialPayrollMonth("2026-10",[run(1,"approved","-1","0","0")],[])).toThrow(InvalidPayrollReview);
 });
 it("rejects unrelated payroll expense and out-of-scope month",()=>{
   expect(()=>reviewFinancialPayrollMonth("2026-10",[run(1,"paid")],[{reference_no:"PAYROLL-2",amount:1}])).toThrow();
   expect(()=>reviewFinancialPayrollMonth("2026-11",[run(1,"paid")],[])).toThrow();
 });
});
