import {describe,expect,it} from "vitest";
import {glTrendPeriods,validateGLTrend,InvalidGLTrend} from "./financial-gl-trend";
const scope={tenantId:1,siteIds:[5,7],endPeriod:"2026-11",months:3,allSites:true};
function example(){
 const rows=scope.siteIds.flatMap(siteId=>glTrendPeriods(scope.endPeriod,scope.months).map(period=>({
  siteId,siteName:"فرع "+siteId,period,glEntryCount:2,hasPostedData:true,
  serviceRevenue:100,directServiceCost:20,grossResult:80,wages:10,
  depreciation:5,provisions:5,nonOperatingExpenses:10,
  operatingResult:60,provisionalNetResult:50,
  recognitionPolicyVersion:"gaza-invoice-service-calendar-days-v1",
  recognitionPolicyStatus:"SINGLE_VERSION",
  isFinalProfit:false,isCompleteAccrualStatement:false
 })));
 return {
  tenantId:1,tenantName:"اختباري",siteIds:[5,7],siteCount:2,months:3,
  endPeriod:"2026-11",startPeriod:"2026-09",rows,
  status:"PRELIMINARY_GL_TREND_UNVERIFIED_SOURCES",
  source:"POSTED_GL_FULL_PERIOD_AGGREGATES",
  sourceCoverageVerified:false,centralCostAllocationIncluded:false,
  isConsolidatedFinancialStatement:false,accountingCertification:"NOT_CERTIFIED",
  isFinalProfit:false,periodTimeZone:"Asia/Gaza",currency:"ILS",
  sourceSnapshotAtomic:true,generatedAt:"2026-11-13T20:00:00Z"
 };
}
describe("Phase C full PostgreSQL monthly trend contract",()=>{
 it("returns the full site/month matrix with no page-one total assumption",()=>{
  const result=validateGLTrend(example(),scope);
  expect(result.rows).toHaveLength(6);
  expect(result.rows[0]).toMatchObject({period:"2026-09",siteId:5,provisionalNetResult:50});
  expect(result.accountingCertification).toBe("NOT_CERTIFIED");
  expect(result.sourceCoverageVerified).toBe(false);
 });
 it("preserves months across year and leap February",()=>{
  expect(glTrendPeriods("2024-03",4)).toEqual(["2023-12","2024-01","2024-02","2024-03"]);
  expect(glTrendPeriods("2026-01",3)).toEqual(["2025-11","2025-12","2026-01"]);
  expect(()=>glTrendPeriods("2026-13",6)).toThrow();
  expect(()=>glTrendPeriods("2026-10",13)).toThrow();
 });
 it("rejects omitted months, duplicate rows, foreign site, and inconsistent scope",()=>{
  const omitted=example();omitted.rows.pop();
  expect(()=>validateGLTrend(omitted,scope)).toThrow();
  const duplicated=example();duplicated.rows[1]=duplicated.rows[0];
  expect(()=>validateGLTrend(duplicated,scope)).toThrow();
  const foreign=example();foreign.rows[0].siteId=99;
  expect(()=>validateGLTrend(foreign,scope)).toThrow();
  expect(()=>validateGLTrend(example(),{...scope,siteIds:[5,5]})).toThrow();
  expect(()=>validateGLTrend(example(),{...scope,siteIds:[5],allSites:true})).toThrow();
 });
 it("forbids false certified profit, forged policy provenance and bad totals",()=>{
  const certified=example() as Record<string,any>;certified.accountingCertification="CERTIFIED";
  expect(()=>validateGLTrend(certified,scope)).toThrow(InvalidGLTrend);
  const wrong=example();wrong.rows[0].provisionalNetResult=999;
  expect(()=>validateGLTrend(wrong,scope)).toThrow("UNBALANCED_TREND_PROVENANCE");
  const policy=example();policy.rows[0].recognitionPolicyVersion=null as unknown as string;
  expect(()=>validateGLTrend(policy,scope)).toThrow("INVALID_RECOGNITION_PROVENANCE");
  const missing=example();missing.rows[0].serviceRevenue=null as unknown as number;
  expect(()=>validateGLTrend(missing,scope)).toThrow("MISSING_AMOUNT");
 });
 it("keeps empty periods visibly unproven instead of treating them as profit",()=>{
  const d=example();d.rows[0].glEntryCount=0;d.rows[0].hasPostedData=false;
  d.rows[0].recognitionPolicyVersion=null as unknown as string;
  d.rows[0].recognitionPolicyStatus="UNPROVEN";
  const r=validateGLTrend(d,scope);
  expect(r.rows[0].hasPostedData).toBe(false);
  expect(r.rows[0].recognitionPolicyStatus).toBe("UNPROVEN");
 });
});
