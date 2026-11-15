import {test} from "node:test";
import assert from "node:assert/strict";
import {config,checkOwn,checkForeign,checkAnonymous,run,ROUTES} from "./d36-financial-tenant-isolation-http.mjs";
const cfg={preview:"https://powerhub-platform-a1b2c3-mosabmalek-rgb.vercel.app",
token:"synthetic-untrusted-long-token-for-unit-tests-only",
device:"11111111-1111-4111-8111-111111111111",tenant:1,site:1,
foreignSite:9000000000011,period:"2026-11"};
const wrap=(v)=>JSON.stringify({result:{data:{json:v}}});
const deny=(code)=>JSON.stringify({error:{json:{data:{code}}}});
const own=(name)=>({tenantId:1,siteId:1,accountingCertification:"NOT_CERTIFIED",
...(name==="accrualCloseReadiness"?{period:"2026-11",isFinalFinancialStatement:false,
canAutomaticallyLock:false,needsIndependentReviewer:true,blockers:[]}:
name==="financialGLTrialBalance"?{throughPeriod:"2026-11",isFinalBalanceSheet:false,
isMathematicallyBalanced:true,accounts:[]}:
{period:"2026-11",siteScope:"SITE_ONLY",isFinalBalanceSheet:false,
isFinalProfit:false,isCompleteAccrualStatement:false,accounts:[]})});
const res=(status,body)=>({status,async text(){return body},async json(){return JSON.parse(body)}});
test("refuses non-preview URLs and invalid scopes",()=>{
for(const preview of ["http://powerhub-platform-a1b2c3-mosabmalek-rgb.vercel.app",
"https://example.com","https://powerhub-platform-a1b2c3-mosabmalek-rgb.vercel.app/evil"])
assert.throws(()=>config({...cfg,preview}),/D36_/);
for(const change of [{token:""},{device:"wrong"},{tenant:0},{foreignSite:1},{period:"2026-99"}])
assert.throws(()=>config({...cfg,...change}),/D36_/);
});
test("checks tenant scope and never elevates certification",()=>{
const c=config(cfg);
for(const name of ROUTES){
assert.doesNotThrow(()=>checkOwn(200,wrap(own(name)),name,c));
assert.throws(()=>checkOwn(200,wrap({...own(name),tenantId:9000000000001}),name,c),/DRIFT/);
assert.throws(()=>checkOwn(200,wrap({...own(name),accountingCertification:"CERTIFIED"}),name,c),/DRIFT/);
}});
test("rejects foreign financial payloads and anonymous bypass",()=>{
assert.doesNotThrow(()=>checkForeign(403,deny("FORBIDDEN")));
assert.doesNotThrow(()=>checkForeign(404,deny("NOT_FOUND")));
assert.throws(()=>checkForeign(200,wrap(own(ROUTES[0]))),/NOT_DENIED/);
assert.throws(()=>checkForeign(403,JSON.stringify({result:{accounts:[1]},error:{json:{data:{code:"FORBIDDEN"}}}})),/DRIFT/);
assert.doesNotThrow(()=>checkAnonymous(401,deny("UNAUTHORIZED")));
assert.throws(()=>checkAnonymous(500,deny("INTERNAL_SERVER_ERROR")),/DRIFT/);
});
test("auth-isolation run uses GET only and refuses a false approval",async()=>{
let n=0;
const mock=async(url,opt)=>{
n++;assert.equal(opt.method,"GET");
if(url.endsWith("/api/ready"))return res(200,JSON.stringify({status:"ok",checks:{
supabaseConnectivity:true,application:true,supabaseConfig:true}}));
const name=url.match(/reports\.([^?]+)\?/)[1];
const site=JSON.parse(decodeURIComponent(url.split("input=")[1])).json.siteId;
if(!opt.headers?.authorization)return res(401,deny("UNAUTHORIZED"));
return site===cfg.foreignSite?res(403,deny("FORBIDDEN")):res(200,wrap(own(name)));
};
const result=await run(cfg,{request:mock});
assert.equal(result.status,"PASS");assert.equal(result.checks,7);assert.equal(n,8);
await assert.rejects(run(cfg,{request:async(url,opt)=>{
if(url.endsWith("/api/ready"))return res(200,JSON.stringify({status:"ok",checks:{
supabaseConnectivity:true,application:true,supabaseConfig:true}}));
return res(200,wrap(own(url.match(/reports\.([^?]+)\?/)[1])));
}}),/FOREIGN_SITE_NOT_DENIED/);
});
