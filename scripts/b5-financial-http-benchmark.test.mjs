import {test} from "node:test";
import assert from "node:assert/strict";
import {config,origin,quantile,checkFinancial,run} from "./b5-financial-http-benchmark.mjs";
const valid={preview:"https://powerhub-platform-5x55dj0iv-mosabmalek-rgb.vercel.app",
 token:"not-a-real-test-token-or-password",device:"e877b0a0-f005-4875-9a35-f3d4e12d458c",
 tenant:1,site:1,period:"2026-11",budget:3000,samples:100,concurrency:4};
function json(name,override={}){
  const base={tenantId:1,siteId:1,period:"2026-11",accountingCertification:"NOT_CERTIFIED",isFinalBalanceSheet:false};
  const extra=name==="financialGLSubledgerReconciliation"?{isApproved:false,checks:[{},{},{},{},{}]}:
    name==="financialGLCompanyMovementAudit"?{isApproved:false,status:"LINKED_ACCOUNT_MOVEMENTS_MATCH_NOT_CERTIFIED",accountBalancesLinkedOnly:[]}:
      {siteScope:"SITE_ONLY",isFinalProfit:false,isCompleteAccrualStatement:false,accounts:[]};
  return JSON.stringify({result:{data:{json:{...base,...extra,...override}}}});
}
function server(status=200,override={}){
  const calls=[];
  const request=async(url,options)=>{
    calls.push({method:options.method,authorization:options.headers?.authorization});
    if(url.endsWith("/api/ready"))return {status:200,json:async()=>({status:"ok",checks:{application:true,supabaseConnectivity:true,supabaseConfig:true}})};
    const name=url.split("?")[0].split(".").at(-1);
    return {status,text:async()=>json(name,override)};
  };
  return {request,calls};
}
test("only exact HTTPS Preview origin is accepted",()=>{
  assert.equal(origin(valid.preview),valid.preview);
  for(const v of ["http://"+new URL(valid.preview).host,valid.preview+".attacker.example",
    valid.preview+"/invoice","https://powerhub-platform-production.vercel.app"])assert.throws(()=>origin(v));
});
test("authentication, device, p95 budget and concurrency are required",()=>{
  assert.throws(()=>config({...valid,token:""}),/NO_AUTHORIZED_STAGING/);
  assert.throws(()=>config({...valid,device:"fake"}),/NO_VALID_TEST_DEVICE/);
  assert.throws(()=>config({...valid,tenant:0}),/INVALID_SCOPE/);
  assert.throws(()=>config({...valid,budget:undefined}),/INVALID_SCOPE/);
  assert.throws(()=>config({...valid,concurrency:5}),/INVALID_SCOPE/);
  assert.throws(()=>config({...valid,samples:20}),/INVALID_SCOPE/);
});
test("empirical nearest-rank percentiles",()=>{
  assert.equal(quantile([5,1,8,3],.5),3);
  assert.equal(quantile([5,1,8,3],.99),8);
  assert.throws(()=>quantile([],.5));
});
test("rejects 401, wrong site, fabricated certification and missing financial proof",()=>{
  assert.throws(()=>checkFinancial(401,"{}","financialGLCompanyMovementAudit",1,1,"2026-11"),/HTTP_401/);
  assert.throws(()=>checkFinancial(200,json("financialGLCompanyMovementAudit",{tenantId:2}),"financialGLCompanyMovementAudit",1,1,"2026-11"),/SCOPE/);
  assert.throws(()=>checkFinancial(200,json("financialGLCompanyMovementAudit",{siteId:2}),"financialGLCompanyMovementAudit",1,1,"2026-11"),/SCOPE/);
  assert.throws(()=>checkFinancial(200,json("financialGLCompanyMovementAudit",{accountingCertification:"CERTIFIED"}),"financialGLCompanyMovementAudit",1,1,"2026-11"),/SCOPE/);
  assert.throws(()=>checkFinancial(200,json("financialGLSubledgerReconciliation",{checks:[]}),"financialGLSubledgerReconciliation",1,1,"2026-11"),/INVALID_SUBLEDGER/);
});
test("runs only read-only finance GET requests; cannot leak token into results",async()=>{
  const s=server();let t=0;
  const out=await run(valid,{request:s.request,now:()=>{t+=1;return t}});
  assert.equal(out.status,"PASS");assert.equal(out.financialWrites,0);
  assert.equal(out.results.length,3);assert.ok(out.results.every(x=>x.samples===100));
  assert.equal(out.tenant,1);
  assert.equal(s.calls.length,307);assert.ok(s.calls.every(x=>x.method==="GET"));
  assert.equal(s.calls.filter(x=>x.authorization==="Bearer "+valid.token).length,306);
  assert.ok(!JSON.stringify(out).includes(valid.token));
});
test("uses nested live readiness checks and an 8000ms report deadline",async()=>{
  const seen=[],deadlines=[];const s=server();const originalTimeout=AbortSignal.timeout;
  AbortSignal.timeout=(ms)=>{deadlines.push(ms);return originalTimeout(ms)};
  try{
    await run(valid,{request:async(url,opts)=>{seen.push({ready:url.endsWith("/api/ready"),signal:opts.signal});return s.request(url,opts)}});
  }finally{AbortSignal.timeout=originalTimeout}
  assert.equal(seen.length,307);
  assert.equal(seen[0].ready,true);
  assert.ok(seen.every(x=>x.signal instanceof AbortSignal));
  assert.deepEqual(deadlines,[15000,...Array(306).fill(8000)]);
  assert.throws(()=>checkFinancial(200,json("financialGLSiteStatements",{tenantId:2}),"financialGLSiteStatements",1,1,"2026-11"),/SCOPE/);
});
test("fails closed when the Staging readiness check omits connectivity",async()=>{
  const s=server();
  await assert.rejects(()=>run(valid,{request:(url,opts)=>url.endsWith("/api/ready")
    ? Promise.resolve({status:200,json:async()=>({status:"ok",checks:{application:true,supabaseConfig:true}})})
    : s.request(url,opts)}),/STAGING_NOT_READY/);
  assert.equal(s.calls.length,0);
});
test("fails closed on unauthorized financial HTTP response",async()=>{
  await assert.rejects(()=>run(valid,{request:server(401).request}),/HTTP_401/);
});
test("fails policy when sample p95 exceeds threshold",async()=>{
  const s=server();let t=0;
  const out=await run({...valid,budget:1},{request:s.request,now:()=>{t+=2;return t}});
  assert.equal(out.status,"FAIL");assert.equal(out.results.length,1);
  assert.equal(out.results[0].attempted,100);
  assert.equal(out.results[0].pass,false);
});
test("counts failed HTTPS samples separately and stops after the failed batch",async()=>{
  const s=server();let reportCalls=0;
  const out=await run(valid,{request:async(url,opts)=>{
    if(url.endsWith("/api/ready"))return s.request(url,opts);
    reportCalls++;
    if(reportCalls===3)return {status:504,text:async()=>"{}"};
    return s.request(url,opts);
  }});
  assert.equal(out.status,"FAIL");assert.equal(out.results.length,1);
  assert.equal(out.results[0].attempted,4);
  assert.equal(out.results[0].samples,3);
  assert.deepEqual(out.results[0].errors,{http500:0,http502:0,http503:0,http504:1,timeout:0,other:0});
  assert.equal(reportCalls,6);
});
