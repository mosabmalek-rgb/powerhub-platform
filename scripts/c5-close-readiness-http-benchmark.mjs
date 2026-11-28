// C5 read-only authenticated month-end readiness HTTPS acceptance harness.
// Reuses B5 strict HTTPS Preview origin and nearest-rank quantiles.
// Never writes finance data; never logs credentials or source financial records.
import {origin,quantile} from "./b5-financial-http-benchmark.mjs";
import {fileURLToPath} from "node:url";
import {resolve} from "node:path";

export function config(x){
 const dest=origin(x.preview);
 if(typeof x.token!=="string"||x.token.length<20)
  throw Error("NO_AUTHORIZED_STAGING_TEST_SESSION");
 if(!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(x.device??""))
  throw Error("NO_VALID_TEST_DEVICE_LEASE");
 const tenant=Number(x.tenant??1),site=Number(x.site??1),
  samples=Number(x.samples??100),concurrency=Number(x.concurrency??4),
  budget=Number(x.budget),period=x.period??"2026-11",
  expectedStatus=x.expectedStatus;
 if(!Number.isSafeInteger(tenant)||tenant<1
   ||!Number.isSafeInteger(site)||site<1
   ||!Number.isSafeInteger(samples)||samples<100||samples>400
   ||!Number.isSafeInteger(concurrency)||concurrency<1||concurrency>4
   ||!Number.isFinite(budget)||budget<=0
   ||!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)
   ||(expectedStatus!==undefined&&!["BLOCKED","REVIEW_REQUIRED",
       "READY_FOR_INDEPENDENT_REVIEW","LOCKED_NOT_CERTIFIED"].includes(expectedStatus)))
  throw Error("INVALID_SCOPE_OR_ACCEPTANCE_BUDGET");
 return {dest,token:x.token,device:x.device,tenant,site,samples,
  concurrency,budget,period,expectedStatus};
}

export function check(status,raw,tenant,site,period,expectedStatus){
 if(status!==200)throw Error("HTTP_"+status);
 let value;
 try{value=JSON.parse(raw)?.result?.data?.json}
 catch{throw Error("INVALID_RESPONSE_JSON")}
 if(!value||typeof value!=="object"
    ||value.tenantId!==tenant||value.siteId!==site||value.period!==period
    ||value.accountingCertification!=="NOT_CERTIFIED"
    ||value.isFinalFinancialStatement!==false
    ||value.canAutomaticallyLock!==false
    ||value.needsIndependentReviewer!==true
    ||value.sourceSnapshotAtomic!==false
    ||value.requiresLiveRevalidationAtLock!==true)
  throw Error("C5_FALSE_SCOPE_OR_CERTIFICATION");
 if(!["BLOCKED","REVIEW_REQUIRED","READY_FOR_INDEPENDENT_REVIEW",
      "LOCKED_NOT_CERTIFIED"].includes(value.status)
   ||(expectedStatus!==undefined&&value.status!==expectedStatus)
   ||!Array.isArray(value.blockers)
   ||!Array.isArray(value.reviewRequirements)
   ||!Array.isArray(value.sourceLimitations)||value.sourceLimitations.length<1
   ||typeof value.sourceAsOf!=="string"
   ||!Number.isFinite(Date.parse(value.sourceAsOf)))
  throw Error("C5_INVALID_SOURCE_PROOF");
 for(const b of value.blockers){
  if(!b||typeof b.code!=="string"||!b.code||typeof b.label!=="string"
    ||!b.label||(b.count!==null&&(!Number.isSafeInteger(b.count)||b.count<0)))
   throw Error("C5_INVALID_BLOCKER");
 }
 for(const b of value.reviewRequirements){
  if(!b||typeof b.code!=="string"||!b.code||typeof b.label!=="string"||!b.label)
   throw Error("C5_INVALID_REVIEW_REQUIREMENT");
 }
 if(value.status==="BLOCKED"&&value.blockers.length===0)
  throw Error("C5_EMPTY_BLOCKED_RESULT");
 if(value.status==="READY_FOR_INDEPENDENT_REVIEW"
    &&(value.blockers.length||value.reviewRequirements.length
      ||value.reviewStatus!=="draft"))
  throw Error("C5_FALSE_APPROVAL_READINESS");
 // Exclude timestamps from the stability proof, but refuse changing blockers/status.
 const fingerprint=JSON.stringify({
  status:value.status,reviewStatus:value.reviewStatus,
  blockers:value.blockers,requirements:value.reviewRequirements,
 });
 return {fingerprint};
}

export async function run(x,{request=fetch,now=()=>performance.now()}={}){
 const c=config(x);
 const readyResponse=await request(c.dest+"/api/ready",{
  method:"GET",redirect:"manual",signal:AbortSignal.timeout(15000),
 });
 let ready;
 try{ready=await readyResponse.json()}catch{throw Error("INVALID_READY_RESPONSE")}
 if(readyResponse.status!==200||ready?.status!=="ok"||
    ready?.checks?.application!==true||ready?.checks?.supabaseConnectivity!==true
    ||ready?.checks?.supabaseConfig!==true)throw Error("STAGING_NOT_READY");
 const headers={
  authorization:"Bearer "+c.token,"x-powerhub-device-id":c.device,
  accept:"application/json","cache-control":"no-store",
 };
 const url=c.dest+"/api/trpc/powerhub.reports.accrualCloseReadiness?input="
   +encodeURIComponent(JSON.stringify({json:{siteId:c.site,period:c.period}}));
 let stableFingerprint=null;
 const measure=async()=>{
  const t=now();
  const response=await request(url,{method:"GET",headers,redirect:"manual",
   signal:AbortSignal.timeout(8000)});
  const proof=check(response.status,await response.text(),
    c.tenant,c.site,c.period,c.expectedStatus);
  if(stableFingerprint!==null && stableFingerprint!==proof.fingerprint)
   throw Error("C5_SOURCE_CHANGED_DURING_ACCEPTANCE");
  stableFingerprint=proof.fingerprint;
  const ms=now()-t;
  if(!Number.isFinite(ms)||ms<0)throw Error("INVALID_LATENCY_CLOCK");
  return ms;
 };
 // Preflight not counted as acceptance samples.
 await measure();await measure();
 const durations=[],errors={http500:0,http502:0,http503:0,http504:0,timeout:0,other:0};
 let attempted=0;
 for(let offset=0;offset<c.samples;offset+=c.concurrency){
  const batch=await Promise.allSettled(Array.from({
   length:Math.min(c.concurrency,c.samples-offset),
  },measure));
  attempted+=batch.length;
  for(const result of batch){
   if(result.status==="fulfilled")durations.push(result.value);
   else{
    const reason=result.reason;
    const code=reason instanceof Error?reason.message:"";
    if(/^HTTP_50[0234]$/.test(code))errors["http"+code.slice(5)]++;
    else if(reason?.name==="TimeoutError"||reason?.name==="AbortError")errors.timeout++;
    else errors.other++;
   }
  }
  if(durations.length!==attempted)break;
 }
 const stats={
  attempted,valid:durations.length,concurrency:c.concurrency,
  p50_ms:durations.length?quantile(durations,.5):null,
  p95_ms:durations.length?quantile(durations,.95):null,
  p99_ms:durations.length?quantile(durations,.99):null,
  max_ms:durations.length?quantile(durations,1):null,
  errors,approved_p95_budget_ms:c.budget,
 };
 const pass=durations.length===c.samples
   &&Object.values(errors).every(n=>n===0)&&stats.p95_ms<=c.budget;
 return {
  status:pass?"PASS":"FAIL",
  scope:"C5_AUTHENTICATED_STAGING_CLOSE_READINESS_READ_ONLY_HTTP",
  tenant:c.tenant,site:c.site,period:c.period,
  results:stats,financialWrites:0,accountingCertification:"NOT_CERTIFIED",
 };
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const result=await run({
   preview:process.env.POWERHUB_C5_PREVIEW_URL,
   token:process.env.POWERHUB_C5_ACCESS_TOKEN,
   device:process.env.POWERHUB_C5_DEVICE_ID,
   tenant:process.env.POWERHUB_C5_TENANT_ID,
   site:process.env.POWERHUB_C5_SITE_ID,
   period:process.env.POWERHUB_C5_PERIOD,
   budget:process.env.POWERHUB_C5_P95_BUDGET_MS,
   samples:process.env.POWERHUB_C5_SAMPLES,
   concurrency:process.env.POWERHUB_C5_CONCURRENCY,
   expectedStatus:process.env.POWERHUB_C5_EXPECTED_STATUS,
  });
  console.log(JSON.stringify(result,null,2));
  if(result.status!=="PASS")process.exitCode=1;
 }catch(e){
  console.error(JSON.stringify({status:"NOT_ACCEPTED",
   errorCode:e instanceof Error?e.message.split(":")[0]:"UNKNOWN"}));
  process.exitCode=1;
 }
}
