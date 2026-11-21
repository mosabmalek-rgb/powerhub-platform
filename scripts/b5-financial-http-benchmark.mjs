// B5 financial HTTP benchmark; read-only, authenticated, Staging preview only.
// Never print access tokens or financial records. All rejected/slow samples count.
import {fileURLToPath} from "node:url";
import {resolve} from "node:path";
export const ROUTES=["financialGLSubledgerReconciliation","financialGLCompanyMovementAudit","financialGLSiteStatements"];
export function origin(value){
  let u;try{u=new URL(value)}catch{throw Error("INVALID_PREVIEW_URL")}
  if(u.protocol!=="https:"||!/^powerhub-platform-[a-z0-9]+-mosabmalek-rgb\.vercel\.app$/.test(u.hostname)
    ||u.username||u.password||u.port||u.pathname!=="/"||u.search||u.hash)
    throw Error("REFUSED_NON_PREVIEW_DESTINATION");
  return u.origin;
}
export function quantile(items,q){
  if(!items.length||!Number.isFinite(q)||q<0||q>1)throw Error("INVALID_QUANTILE");
  const sorted=[...items].sort((a,b)=>a-b);return +sorted[Math.max(0,Math.ceil(q*sorted.length)-1)].toFixed(2);
}
export function config(x){
  const dest=origin(x.preview);
  if(typeof x.token!=="string"||x.token.length<20)throw Error("NO_AUTHORIZED_STAGING_TEST_SESSION");
  if(!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(x.device??""))throw Error("NO_VALID_TEST_DEVICE_LEASE");
  const tenant=Number(x.tenant??1),site=Number(x.site??1),budget=Number(x.budget),sampleCount=Number(x.samples??100),concurrency=Number(x.concurrency??4),period=x.period??"2026-11";
  if(!Number.isSafeInteger(tenant)||tenant<1||!Number.isSafeInteger(site)||site<1||!Number.isFinite(budget)||budget<=0
    ||!Number.isSafeInteger(sampleCount)||sampleCount<100||sampleCount>400
    ||!Number.isSafeInteger(concurrency)||concurrency<1||concurrency>4
    ||!/^\d{4}-(0[1-9]|1[0-2])$/.test(period))throw Error("INVALID_SCOPE_BUDGET_OR_SAMPLE_SIZE");
  return {dest,token:x.token,device:x.device,tenant,site,budget,sampleCount,concurrency,period};
}
export function checkFinancial(status,raw,name,tenant,site,period){
  if(status!==200)throw Error("HTTP_"+status);
  let out;try{out=JSON.parse(raw)?.result?.data?.json}catch{throw Error("INVALID_RESPONSE_JSON")}
  if(!out||out.tenantId!==tenant||out.siteId!==site||out.period!==period||out.accountingCertification!=="NOT_CERTIFIED"||out.isFinalBalanceSheet!==false)
    throw Error("FINANCIAL_RESPONSE_SCOPE_OR_CERTIFICATION_DRIFT");
  if(name==="financialGLSubledgerReconciliation"&&(!Array.isArray(out.checks)||out.checks.length!==5||out.isApproved!==false))
    throw Error("INVALID_SUBLEDGER_PROOF");
  if(name==="financialGLCompanyMovementAudit"&&(!Array.isArray(out.accountBalancesLinkedOnly)||out.isApproved!==false
    ||!["LINKED_ACCOUNT_MOVEMENTS_MATCH_NOT_CERTIFIED","BLOCKED_ACCOUNT_MOVEMENT_AUDIT"].includes(out.status)))
    throw Error("INVALID_CASH_AUDIT_PROOF");
  if(name==="financialGLSiteStatements"&&(!Array.isArray(out.accounts)||out.siteScope!=="SITE_ONLY"
    ||out.isFinalProfit!==false||out.isCompleteAccrualStatement!==false))throw Error("INVALID_SITE_STATEMENTS_PROOF");
  return out;
}
export async function run(x,{request=fetch,now=()=>performance.now()}={}){
  const c=config(x);
  const health=await request(c.dest+"/api/ready",{method:"GET",redirect:"manual",signal:AbortSignal.timeout(15000)});
  let ready;try{ready=await health.json()}catch{throw Error("INVALID_READY_RESPONSE")}
  if(health.status!==200||ready?.status!=="ok"||ready?.checks?.application!==true||ready?.checks?.supabaseConnectivity!==true||ready?.checks?.supabaseConfig!==true)throw Error("STAGING_NOT_READY");
  const headers={authorization:"Bearer "+c.token,"x-powerhub-device-id":c.device,accept:"application/json","cache-control":"no-store"};
  const measurements=[];
  for(const name of ROUTES){
    const url=c.dest+"/api/trpc/powerhub.reports."+name+"?input="+encodeURIComponent(JSON.stringify({json:{siteId:c.site,period:c.period}}));
    const measure=async()=>{
      const start=now();const response=await request(url,{method:"GET",headers,redirect:"manual",signal:AbortSignal.timeout(8000)});
      checkFinancial(response.status,await response.text(),name,c.tenant,c.site,c.period);
      const ms=now()-start;if(!Number.isFinite(ms)||ms<0)throw Error("INVALID_LATENCY_CLOCK");return ms;
    };
    for(let i=0;i<2;i++)await measure();
    const durations=[],errors={http500:0,http502:0,http503:0,http504:0,timeout:0,other:0};
    let attempted=0;
    for(let i=0;i<c.sampleCount;i+=c.concurrency){
      const batch=await Promise.allSettled(Array.from({length:Math.min(c.concurrency,c.sampleCount-i)},measure));
      attempted+=batch.length;
      for(const sample of batch){
        if(sample.status==="fulfilled")durations.push(sample.value);
        else{
          const reason=sample.reason;
          const code=reason instanceof Error ? reason.message : "";
          if(/^HTTP_50[0234]$/.test(code))errors["http"+code.slice(5)]++;
          else if(reason?.name==="TimeoutError"||reason?.name==="AbortError")errors.timeout++;
          else errors.other++;
        }
      }
      // A failed batch is diagnostic evidence, not a reason to add more load.
      if(attempted!==durations.length)break;
    }
    const stats={route:name,method:"GET",samples:durations.length,attempted,concurrency:c.concurrency,errors,
      p50_ms:durations.length?quantile(durations,.50):null,
      p95_ms:durations.length?quantile(durations,.95):null,
      p99_ms:durations.length?quantile(durations,.99):null,
      max_ms:durations.length?quantile(durations,1):null,
      approved_p95_budget_ms:c.budget};
    stats.pass=durations.length===c.sampleCount && Object.values(errors).every(x=>x===0)
      && stats.p95_ms<=c.budget;
    measurements.push(stats);
    if(!stats.pass)break;
  }
  return {status:measurements.every(m=>m.pass)?"PASS":"FAIL",
    scope:"AUTHENTICATED_STAGING_FINANCIAL_READ_ONLY_HTTP",tenant:c.tenant,site:c.site,period:c.period,
    results:measurements,financialWrites:0,accountingCertification:"NOT_CERTIFIED"};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const result=await run({preview:process.env.POWERHUB_B5_PREVIEW_URL,
      token:process.env.POWERHUB_B5_ACCESS_TOKEN,device:process.env.POWERHUB_B5_DEVICE_ID,
      tenant:process.env.POWERHUB_B5_TENANT_ID,site:process.env.POWERHUB_B5_SITE_ID,period:process.env.POWERHUB_B5_PERIOD,
      budget:process.env.POWERHUB_B5_P95_BUDGET_MS,
      samples:process.env.POWERHUB_B5_SAMPLES,concurrency:process.env.POWERHUB_B5_CONCURRENCY});
    console.log(JSON.stringify(result,null,2));if(result.status!=="PASS")process.exitCode=1;
  }catch(e){console.error(JSON.stringify({status:"NOT_ACCEPTED",errorCode:e instanceof Error?e.message.split(":")[0]:"UNKNOWN"}));process.exitCode=1}
}
