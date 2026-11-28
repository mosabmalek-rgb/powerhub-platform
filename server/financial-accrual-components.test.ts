import {describe,it,expect} from "vitest";
import {summarizeAccrualComponents,summarizeInvoiceServiceCycleCoverage,isIssuedFinancialInvoiceStatus,InvalidAccrualComponents} from "./financial-accrual-components";
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

describe("Gaza-local service-cycle coverage for issued invoices",()=>{
 const dt=(s:string)=>new Date(s);
 it("identifies an invoice issued in November for the October service cycle",()=>{
  const r=summarizeInvoiceServiceCycleCoverage("2026-11-01","2026-11-30",[{
   status:"partially_paid",issueDate:dt("2026-11-01T12:07:25Z"),
   cycleStartAt:dt("2026-09-30T21:00:00Z"),
   cycleEndAt:dt("2026-10-31T21:59:59.999Z"),totalAmount:2471.50
  }]);
  expect(r.reviewedInvoiceCount).toBe(1);
  expect(r.outsidePeriodCount).toBe(1);
  expect(r.outsidePeriodBilledGross).toBe(2471.5);
  expect(r.issueDateOutsideCycleCount).toBe(1);
  expect(r.isServicePeriodRevenueRecognized).toBe(false);
 });
 it("uses Gaza local midnight rather than UTC day when classifying cycles",()=>{
  const r=summarizeInvoiceServiceCycleCoverage("2026-11-01","2026-11-30",[{
   status:"paid",issueDate:dt("2026-11-01T13:04:02Z"),
   cycleStartAt:dt("2026-10-31T22:00:00Z"),
   cycleEndAt:dt("2026-11-30T21:59:59.999Z"),totalAmount:51,
  }]);
  expect(r.withinPeriodCount).toBe(1);
  expect(r.outsidePeriodCount).toBe(0);
  expect(r.issueDateOutsideCycleCount).toBe(0);
 });
 it("shows crossing periods without proration or false revenue recognition",()=>{
  const r=summarizeInvoiceServiceCycleCoverage("2026-11-05","2026-11-15",[{
   status:"issued",issueDate:dt("2026-11-10T12:00:00Z"),
   cycleStartAt:dt("2026-10-31T22:00:00Z"),
   cycleEndAt:dt("2026-11-30T21:59:59Z"),totalAmount:100,
  }]);
  expect(r.crossBoundaryCount).toBe(1);
  expect(r.crossBoundaryBilledGross).toBe(100);
  expect(r.isServicePeriodRevenueRecognized).toBe(false);
 });
 it("marks missing cycle separately and excludes draft and cancelled invoices",()=>{
  const r=summarizeInvoiceServiceCycleCoverage("2026-11-01","2026-11-30",[
   {status:"issued",issueDate:dt("2026-11-04T12:00:00Z"),cycleStartAt:null,cycleEndAt:null,totalAmount:25},
   {status:"draft",issueDate:dt("2026-11-04T12:00:00Z"),cycleStartAt:null,cycleEndAt:null,totalAmount:800}
  ]);
  expect(r.missingCycleCount).toBe(1);
  expect(r.reviewedInvoiceCount).toBe(1);
  expect(isIssuedFinancialInvoiceStatus("draft")).toBe(false);
  expect(isIssuedFinancialInvoiceStatus("paid")).toBe(true);
 });
 it("rejects reversed cycle or invalid report dates",()=>{
  expect(()=>summarizeInvoiceServiceCycleCoverage("2026-02-30","2026-03-01",[])).toThrow(InvalidAccrualComponents);
  expect(()=>summarizeInvoiceServiceCycleCoverage("2026-11-30","2026-11-01",[])).toThrow();
  expect(()=>summarizeInvoiceServiceCycleCoverage("2026-11-01","2026-11-30",[{
   status:"paid",issueDate:dt("2026-11-03T12:00:00Z"),
   cycleStartAt:dt("2026-11-30T21:00:00Z"),
   cycleEndAt:dt("2026-11-01T21:00:00Z"),totalAmount:15
  }])).toThrow();
 });
});
