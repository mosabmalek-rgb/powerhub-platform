import {test} from "node:test";
import assert from "node:assert/strict";
import {config,check,run} from "./c5-close-readiness-http-benchmark.mjs";

const accepted={
 preview:"https://powerhub-platform-5x55dj0iv-mosabmalek-rgb.vercel.app",
 token:"synthetic-token-never-use-in-staging",
 device:"e877b0a0-f005-4875-9a35-f3d4e12d458c",
 tenant:1,site:1,period:"2026-11",budget:3000,
 samples:100,concurrency:4,expectedStatus:"BLOCKED",
};
const good=(changes={})=>JSON.stringify({result:{data:{json:{
 tenantId:1,siteId:1,period:"2026-11",status:"BLOCKED",
 accountingCertification:"NOT_CERTIFIED",
 isFinalFinancialStatement:false,canAutomaticallyLock:false,
 needsIndependentReviewer:true,sourceSnapshotAtomic:false,
 requiresLiveRevalidationAtLock:true,reviewStatus:"unprepared",
 blockers:[{code:"PERIOD_NOT_ENDED",label:"لم تنتهِ الفترة",count:null}],
 reviewRequirements:[{code:"REVIEW_NOT_PREPARED",label:"لم تجهز المراجعة"}],
 sourceLimitations:["Financial reporting not independently certified"],
 sourceAsOf:"2026-11-13T17:20:00Z",...changes,
 }}}});
function mock({status=200,changeAt=0,changed={}}={}){
 const calls=[];let financeCalls=0;
 const request=async(url,opts)=>{
  calls.push({url,method:opts.method,authorization:opts.headers?.authorization});
  if(url.endsWith("/api/ready"))
   return {status:200,json:async()=>({status:"ok",checks:{
    application:true,supabaseConnectivity:true,supabaseConfig:true,
   }})};
  financeCalls++;
  return {status,text:async()=>good(financeCalls>=changeAt&&changeAt>0?changed:{})};
 };
 return {request,calls};
}
test("requires a real restricted HTTPS preview, authorized device, budget and sample size",()=>{
 for(const value of [
  {...accepted,preview:"http://powerhub-platform-5x55dj0iv-mosabmalek-rgb.vercel.app"},
  {...accepted,preview:"https://powerhub-platform-5x55dj0iv-mosabmalek-rgb.vercel.app/finance"},
  {...accepted,token:""},
  {...accepted,device:"invalid"},
  {...accepted,budget:undefined},
  {...accepted,site:0},
  {...accepted,samples:20},
  {...accepted,concurrency:7},
 ])assert.throws(()=>config(value));
});
test("rejects wrong scope, false certification, missing integrity and fake readiness",()=>{
 for(const changes of [
  {tenantId:2},{siteId:9},{period:"2026-10"},
  {accountingCertification:"CERTIFIED"},{canAutomaticallyLock:true},
  {isFinalFinancialStatement:true},{needsIndependentReviewer:false},
  {sourceSnapshotAtomic:true},{requiresLiveRevalidationAtLock:false},
  {blockers:[]},
 ])assert.throws(()=>check(200,good(changes),1,1,"2026-11","BLOCKED"));
 assert.throws(()=>check(401,good(),1,1,"2026-11","BLOCKED"),/HTTP_401/);
 assert.throws(()=>check(200,good({status:"READY_FOR_INDEPENDENT_REVIEW"}),1,1,"2026-11","BLOCKED"));
});
test("reads precisely one route without posting, and never discloses the token",async()=>{
 const fake=mock();let clock=0;
 const result=await run(accepted,{request:fake.request,now:()=>++clock});
 assert.equal(result.status,"PASS");
 assert.equal(result.results.attempted,100);
 assert.equal(result.results.valid,100);
 assert.equal(result.financialWrites,0);
 assert.equal(result.accountingCertification,"NOT_CERTIFIED");
 assert.equal(fake.calls.length,103);
 assert.ok(fake.calls.every(x=>x.method==="GET"));
 assert.ok(fake.calls.slice(1).every(x=>x.authorization==="Bearer "+accepted.token));
 assert.ok(fake.calls.slice(1).every(x=>x.url.includes("accrualCloseReadiness")));
 assert.ok(!JSON.stringify(result).includes(accepted.token));
});
test("treats changing source blockers mid-run as acceptance failure",async()=>{
 const fake=mock({changeAt:9,changed:{
  blockers:[{code:"UNCLASSIFIED_STOCK_ISSUE",label:"غير مصنفة",count:1}],
 }});
 const result=await run(accepted,{request:fake.request,now:()=>performance.now()});
 assert.equal(result.status,"FAIL");
 assert.ok(result.results.errors.other>0);
 assert.ok(result.results.attempted<100);
});
test("returns failed acceptance on 504, never a fabricated pass",async()=>{
 const fake=mock({status:504});
 await assert.rejects(()=>run(accepted,{request:fake.request}),/HTTP_504/);
});
