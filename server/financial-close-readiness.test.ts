import { describe, it, expect } from "vitest";
import { buildFinancialCloseReadiness } from "./financial-close-readiness";

const now=new Date("2026-11-13T17:20:00.000Z");
const evidence={
 unbilled_service:"DOCUMENT-001",invoice_cutoff:"DOCUMENT-002",
 supplier_reconciliation:"DOCUMENT-003",inventory_reconciliation:"DOCUMENT-004",
 payroll_reconciliation:"DOCUMENT-005",depreciation_register:"DOCUMENT-006",
 provision_assessment:"DOCUMENT-007",tax_reconciliation:"DOCUMENT-008",
};
function snapshot(overrides:Record<string,unknown>={}):Record<string,unknown>{
 return {
  scopeTenantId:1,scopeSiteId:1,period:"2026-10",asOf:now.toISOString(),
  isFinalProfit:false,isCompleteAccrualStatement:false,
  limitations:["Independent review and audited opening are still required"],
  journalAdjustments:{balancedDebits:0,balancedCredits:0,draftCount:0,postedCount:0},
  missingCycleCount:0,uncompletedInvoiceCount:0,draftPayrollCount:0,
  unreconciledPayrollPayoutCount:0,unclassifiedInventoryIssueCount:0,
  invalidInvoiceCount:0,invalidExpenseCount:0,invalidPayrollCount:0,
  invalidInventoryCount:0,crossPeriodInvoiceCount:0,issuedOutsideServiceMonthCount:0,
  ...overrides,
 };
}
function review(overrides:Record<string,unknown>={}):Record<string,unknown>{
 return {status:"draft",isCertifiedProfit:false,preparedByUserId:4,
  evidence:{...evidence},driftDetected:false,...overrides};
}
function run(s:unknown=snapshot(),r:unknown=review(),period="2026-10",date=now){
 return buildFinancialCloseReadiness({tenantId:1,siteId:1,period,now:date,
  statement:s,review:r});
}
describe("C2 financial close readiness remains advisory and non-certified",()=>{
 it("queues clean, ended periods only for independent review",()=>{
  const result=run();
  expect(result.status).toBe("READY_FOR_INDEPENDENT_REVIEW");
  expect(result.blockers).toEqual([]);
  expect(result.canAutomaticallyLock).toBe(false);
  expect(result.accountingCertification).toBe("NOT_CERTIFIED");
  expect(result.needsIndependentReviewer).toBe(true);
  expect(result.sourceSnapshotAtomic).toBe(false);
 });
 it("blocks unfinished month and independent operational blockers",()=>{
  const result=run(snapshot({period:"2026-11",uncompletedInvoiceCount:1,
   unclassifiedInventoryIssueCount:1}),review(),"2026-11");
  expect(result.status).toBe("BLOCKED");
  expect(result.blockers.map(b=>b.code)).toEqual(expect.arrayContaining([
   "PERIOD_NOT_ENDED","INCOMPLETE_SERVICE_CYCLE","UNCLASSIFIED_STOCK_ISSUE",
  ]));
 });
 it("blocks invalid source, cutoff, draft and unbalanced adjustments",()=>{
  const result=run(snapshot({invalidInvoiceCount:1,invalidExpenseCount:2,
   invalidPayrollCount:1,invalidInventoryCount:1,missingCycleCount:1,
   crossPeriodInvoiceCount:1,issuedOutsideServiceMonthCount:1,
   journalAdjustments:{balancedDebits:20,balancedCredits:19,postedCount:0,draftCount:1}}));
  expect(result.status).toBe("BLOCKED");
  expect(result.blockers.map(b=>b.code)).toEqual(expect.arrayContaining([
   "INVALID_INVOICE_SOURCE","INVALID_EXPENSE_SOURCE","INVALID_PAYROLL_SOURCE",
   "INVALID_INVENTORY_SOURCE","MISSING_SERVICE_CYCLE","CROSS_PERIOD_INVOICE",
   "SERVICE_CUTOFF_REVIEW","DRAFT_ADJUSTMENTS","UNBALANCED_ADJUSTMENTS",
  ]));
 });
 it("requires an actual drafted documentary review",()=>{
  const result=run(snapshot(),review({status:"unprepared",evidence:null}));
  expect(result.status).toBe("REVIEW_REQUIRED");
  expect(result.reviewRequirements[0].code).toBe("REVIEW_NOT_PREPARED");
 });
 it("blocks incomplete draft evidence",()=>{
  const result=run(snapshot(),review({evidence:{...evidence,invoice_cutoff:""}}));
  expect(result.status).toBe("REVIEW_REQUIRED");
  expect(result.reviewRequirements[0].code).toBe("INCOMPLETE_DOCUMENTARY_REVIEW");
 });
 it("never treats locked status as new approval",()=>{
  const result=run(snapshot(),review({status:"locked"}));
  expect(result.status).toBe("LOCKED_NOT_CERTIFIED");
  expect(result.canAutomaticallyLock).toBe(false);
 });
 it("flags changed sources in a locked review",()=>{
  const result=run(snapshot(),review({status:"locked",driftDetected:true}));
  expect(result.status).toBe("BLOCKED");
  expect(result.blockers.some(b=>b.code==="SOURCE_DRIFT_AFTER_REVIEW")).toBe(true);
 });
 it("rejects cross-tenant/site/period and finality substitutions",()=>{
  for(const altered of [
   {scopeTenantId:2},{scopeSiteId:9},{period:"2026-09"},
   {isFinalProfit:true},{isCompleteAccrualStatement:true},
  ]) expect(()=>run(snapshot(altered))).toThrow("C2_SCOPE_OR_CERTIFICATION_MISMATCH");
  expect(()=>run(snapshot(),review({isCertifiedProfit:true}))).toThrow();
  expect(()=>run(snapshot(),review({status:"approved"}))).toThrow();
 });
 it("rejects missing or malformed counters rather than coercing null to zero",()=>{
  for(const altered of [
   {invalidInvoiceCount:null},{uncompletedInvoiceCount:-1},
   {draftPayrollCount:"0"},{unclassifiedInventoryIssueCount:0.1},
  ]) expect(()=>run(snapshot(altered))).toThrow("C2_INVALID_SOURCE_COUNT");
 });
 it("denies stale/future source snapshots and missing limitations",()=>{
  expect(()=>run(snapshot({asOf:"2026-11-10T00:00:00Z"}))).toThrow("C2_STALE_OR_FUTURE_SOURCE");
  expect(()=>run(snapshot({asOf:"2026-11-14T00:00:00Z"}))).toThrow("C2_STALE_OR_FUTURE_SOURCE");
  expect(()=>run(snapshot({limitations:[]}))).toThrow("C2_MISSING_FINANCIAL_LIMITATIONS");
 });
 it("uses the Gaza month boundary rather than the server's local time zone",()=>{
  const timestamp=new Date("2026-10-31T22:30:00Z");
  const result=run(snapshot({asOf:timestamp.toISOString()}),review(),"2026-10",timestamp);
  expect(result.blockers.some(b=>b.code==="PERIOD_NOT_ENDED")).toBe(false);
 });
});
