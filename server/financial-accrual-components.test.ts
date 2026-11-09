import {describe,it,expect} from "vitest";
import {summarizeAccrualComponents,InvalidAccrualComponents} from "./financial-accrual-components";
describe("financial accrual bridge components",()=>{
 it("reports tax-separated issued billing but never claims recognized revenue",()=>{
  const x=summarizeAccrualComponents([
   {status:"issued",totalAmount:115,taxAmount:15},
   {status:"partially_paid",totalAmount:230,taxAmount:30},
   {status:"draft",totalAmount:800,taxAmount:0},
   {status:"cancelled",totalAmount:75,taxAmount:0},
  ],[]);
  expect(x.billedGross).toBe(345);
  expect(x.billedTax).toBe(45);
  expect(x.billedExTax).toBe(300);
  expect(x.issuedInvoiceCount).toBe(2);
  expect(x.excludedDraftCount).toBe(1);
  expect(x.excludedCancelledCount).toBe(1);
  expect(x.isRecognizedRevenue).toBe(false);
  expect(x.isCompleteProfitAndLoss).toBe(false);
 });
 it("removes payroll cash payment from direct operating costs to avoid double charge",()=>{
  const x=summarizeAccrualComponents([],[
   {category:"payroll",amount:5425,expenseClassification:"operating"},
   {category:"maintenance",amount:85,expenseClassification:"operating"},
   {category:"misc",amount:20,expenseClassification:"non_operating"}
  ]);
  expect(x.payrollCashOperatingExpenses).toBe(5425);
  expect(x.nonPayrollOperatingExpenses).toBe(85);
  expect(x.nonOperatingExpenses).toBe(20);
  expect(x.payrollCashExpenseCount).toBe(1);
 });
 it("does not silently treat unknown invoice statuses as issued",()=>{
  const x=summarizeAccrualComponents([{status:"new_state",totalAmount:200,taxAmount:0}],[]);
  expect(x.unknownInvoiceCount).toBe(1);
  expect(x.billedGross).toBe(0);
 });
 it("rejects invalid tax, negative expense and nonfinite values",()=>{
  expect(()=>summarizeAccrualComponents([{status:"issued",totalAmount:15,taxAmount:20}],[])).toThrow(InvalidAccrualComponents);
  expect(()=>summarizeAccrualComponents([],[{category:"payroll",amount:-1,expenseClassification:"operating"}])).toThrow();
  expect(()=>summarizeAccrualComponents([{status:"issued",totalAmount:Number.NaN,taxAmount:0}],[])).toThrow();
 });
 it("adds cents without silent floating-point drift",()=>{
  const x=summarizeAccrualComponents([
   {status:"paid",totalAmount:0.1,taxAmount:0},
   {status:"overdue",totalAmount:0.2,taxAmount:0},
  ],[{category:"operation",amount:0.1,expenseClassification:"operating"},{category:"operation",amount:0.2,expenseClassification:"operating"}]);
  expect(x.billedExTax).toBe(0.3);
  expect(x.nonPayrollOperatingExpenses).toBe(0.3);
 });
});
