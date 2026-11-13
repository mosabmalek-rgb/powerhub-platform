import {describe,expect,it} from "vitest";
import {InvalidGLComparison,previousGLMonth,validateGLMonthlyComparison} from "./financial-gl-comparison";
const scope={tenantId:1,siteId:7,currentPeriod:"2026-11",previousPeriod:"2026-10"};
function month(period:string,income:number){
  return {tenantId:1,siteId:7,period,periodStart:period+"-01",periodEnd:period==="2026-10"?"2026-10-31":"2026-11-30",
    siteScope:"SITE_ONLY",accountingBasis:"POSTED_GL_ACCRUAL",
    accountingCertification:"NOT_CERTIFIED",isFinalProfit:false,isFinalBalanceSheet:false,
    isCompleteAccrualStatement:false,isMathematicallyBalanced:true,glEntryCount:4,
    hasPostedData:true,isSourceCoverageComplete:true,unreconciledSourceCount:0,
    accounts:[{code:"4100",name:"إيراد الخدمة",class:"revenue",periodBalance:income}],
    incomeStatement:{serviceRevenue:income,directServiceCost:0,grossResult:income,wages:0,
      depreciation:0,provisions:0,otherOperatingExpenses:0,operatingResult:income,
      nonOperatingExpenses:0,provisionalNetResult:income,isFinalProfit:false},
    balanceSheet:{equationDifference:0,isFinalBalanceSheet:false}};
}
function report(overrides:Record<string,unknown>={}){
  return {tenantId:1,siteId:7,tenantName:"مشروع اختبار",siteName:"الفرع",
    currentPeriod:"2026-11",previousPeriod:"2026-10",current:month("2026-11",120),
    previous:month("2026-10",0),currentReviewStatus:"UNREVIEWED",
    previousReviewStatus:"locked",recognitionPolicyVersion:"gaza-invoice-service-calendar-days-v1",
    currentRecognitionPolicyVersion:"gaza-invoice-service-calendar-days-v1",
    previousRecognitionPolicyVersion:"gaza-invoice-service-calendar-days-v1",
    currency:"ILS",periodTimeZone:"Asia/Gaza",generatedAt:"2026-11-13T20:20:00Z",
    sourceSnapshotAtomic:true,snapshotFingerprint:"a".repeat(32),
    accountingBasis:"POSTED_GL_ACCRUAL",accountingCertification:"NOT_CERTIFIED",
    isFinalFinancialStatement:false,status:"COMPARABLE_PRELIMINARY",canExport:true,blockers:[],
    ...overrides};
}
describe("Master finance Phase C / GL monthly comparison",()=>{
 it("compares actual month units and preserves the zero-denominator as unavailable",()=>{
  const x=validateGLMonthlyComparison(report(),scope);
  expect(x.status).toBe("COMPARABLE_PRELIMINARY");
  expect(x.metrics.find(m=>m.key==="serviceRevenue")).toMatchObject({
    current:120,previous:0,delta:120,percentage:null});
  expect(x.accountRows).toHaveLength(1);
  expect(x.accountingCertification).toBe("NOT_CERTIFIED");
 });
 it("respects leap-year and year-boundary calendar months",()=>{
  expect(previousGLMonth("2024-03")).toBe("2024-02");
  expect(previousGLMonth("2026-01")).toBe("2025-12");
  expect(()=>previousGLMonth("2026-13")).toThrow(InvalidGLComparison);
 });
 it("refuses cross-tenant, stale snapshot, forged final status and altered policy",()=>{
  for(const v of [{tenantId:2},{siteId:8},{accountingCertification:"CERTIFIED"},
    {isFinalFinancialStatement:true},{sourceSnapshotAtomic:false},
    {previousRecognitionPolicyVersion:"v2"}]){
    expect(()=>validateGLMonthlyComparison(report(v),scope)).toThrow(InvalidGLComparison);
  }
  expect(()=>validateGLMonthlyComparison(report(),scope,"b".repeat(32)))
    .toThrow("GL_SOURCE_SNAPSHOT_CHANGED");
 });
 it("blocks absent recognition policy and incomplete GL coverage without fake zero",()=>{
  const current={...month("2026-11",120),isSourceCoverageComplete:false};
  const x=validateGLMonthlyComparison(report({current,recognitionPolicyVersion:null,
    currentRecognitionPolicyVersion:null,status:"BLOCKED",canExport:false,
    blockers:["RECOGNITION_POLICY_NOT_PROVEN","UNVERIFIED_SOURCE_COVERAGE"]}),scope);
  expect(x.status).toBe("BLOCKED");
  expect(x.canExport).toBe(false);
  expect(()=>validateGLMonthlyComparison(report({current}),scope)).toThrow();
 });
 it("rejects missing, duplicated or inconsistent GL lines and labels",()=>{
  const altered={...month("2026-11",120),accounts:[]};
  expect(()=>validateGLMonthlyComparison(report({current:altered}),scope))
    .toThrow("GL_REVENUE_SOURCE_MISMATCH");
  const duplicated={...month("2026-11",120),
    accounts:[...month("2026-11",120).accounts,...month("2026-11",120).accounts]};
  expect(()=>validateGLMonthlyComparison(report({current:duplicated}),scope))
    .toThrow("INVALID_OR_DUPLICATED_GL_ACCOUNT");
 });
});
