import {describe,expect,it} from "vitest";
import {c5Quantile,validateC5HttpResponse} from "./c5-close-readiness-proof";

const scope={tenantId:1,siteId:1,period:"2026-11"};
const fixture=(overrides:Record<string,unknown>={})=>JSON.stringify({
 result:{data:{json:{
  tenantId:1,siteId:1,period:"2026-11",status:"BLOCKED",
  accountingCertification:"NOT_CERTIFIED",isFinalFinancialStatement:false,
  canAutomaticallyLock:false,sourceSnapshotAtomic:false,
  needsIndependentReviewer:true,requiresLiveRevalidationAtLock:true,
  reviewStatus:"unprepared",sourceAsOf:"2026-11-13T18:00:00Z",
  sourceLimitations:["Not a final financial statement"],
  blockers:[{code:"PERIOD_NOT_ENDED",label:"الفترة لم تنتهِ",count:null},
    {code:"UNCLASSIFIED_STOCK_ISSUE",label:"مخزون غير مصنف",count:1}],
  reviewRequirements:[{code:"REVIEW_NOT_PREPARED",label:"لا توجد مراجعة"}],
  ...overrides,
 }}}});
const check=(raw:string=fixture())=>validateC5HttpResponse(200,raw,scope,"BLOCKED");
describe("C5 authenticated read response proof",()=>{
 it("validates a real blocked and not-certified scope",()=>{
  const proof=check();
  expect(proof.decision).toBe("BLOCKED");
  expect(proof.blockerCodes).toContain("UNCLASSIFIED_STOCK_ISSUE");
  expect(proof.fingerprint).not.toContain("الفترة لم تنتهِ");
 });
 it("refuses authentication/authorization failures",()=>{
  for(const status of [401,403,429,500,502,503,504])
   expect(()=>validateC5HttpResponse(status,"{}",scope,"BLOCKED")).toThrow("HTTP_"+status);
 });
 it("rejects mismatched tenant, site, period or asserted certification",()=>{
  for(const invalid of [
   {tenantId:9},{siteId:9},{period:"2026-10"},
   {accountingCertification:"CERTIFIED"},{isFinalFinancialStatement:true},
   {canAutomaticallyLock:true},{sourceSnapshotAtomic:true},
   {needsIndependentReviewer:false},{requiresLiveRevalidationAtLock:false},
  ]) expect(()=>check(fixture(invalid))).toThrow("C5_SCOPE_OR_CERTIFICATION_DRIFT");
 });
 it("rejects fake blocking/ready state and missing source metadata",()=>{
  for(const invalid of [
   {status:"READY_FOR_INDEPENDENT_REVIEW"},{blockers:[]},
   {reviewStatus:"fake"},{sourceLimitations:[]},{sourceAsOf:"bogus"},
  ]) expect(()=>check(fixture(invalid))).toThrow();
 });
 it("rejects invalid blocker counts, names and duplicated codes",()=>{
  for(const invalid of [
   {blockers:[{code:"PERIOD_NOT_ENDED",label:"date",count:-1}]},
   {blockers:[{code:"PERIOD_NOT_ENDED",label:"date",count:"0"}]},
   {blockers:[{code:"UNRECOGNIZED",label:"date",count:0}]},
   {blockers:[{code:"PERIOD_NOT_ENDED",label:"ok",count:null},
      {code:"PERIOD_NOT_ENDED",label:"ok",count:null}]},
  ]) expect(()=>check(fixture(invalid))).toThrow();
 });
 it("keeps a source fingerprint stable without timestamps and labels",()=>{
  const a=check().fingerprint;
  const b=check(fixture({sourceAsOf:"2026-11-13T18:00:03Z",
   blockers:[{code:"UNCLASSIFIED_STOCK_ISSUE",label:"modified",count:1},
     {code:"PERIOD_NOT_ENDED",label:"changed",count:null}]})).fingerprint;
  expect(a).toBe(b);
  expect(check(fixture({blockers:[{code:"PERIOD_NOT_ENDED",label:"date",count:null}]})).fingerprint)
    .not.toBe(a);
 });
 it("uses nearest-rank percentiles and fails on incorrect duration",()=>{
  expect(c5Quantile([8,1,3,5],.5)).toBe(3);
  expect(c5Quantile([8,1,3,5],.95)).toBe(8);
  expect(c5Quantile([],0.95)).toBeNull();
  expect(()=>c5Quantile([1,-1],.95)).toThrow();
 });
});