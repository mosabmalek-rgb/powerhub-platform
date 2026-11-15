// D36: read-only authenticated financial isolation; rejects untrusted responses fail-closed.
import {fileURLToPath} from "node:url";
import {resolve} from "node:path";
export const ROUTES=["accrualCloseReadiness","financialGLTrialBalance","financialGLSiteStatements"];
export function config(x){
 let u;try{u=new URL(x.preview)}catch{throw Error("D36_INVALID_PREVIEW")}
 if(u.protocol!=="https:"||!/^powerhub-platform-[a-z0-9]+-mosabmalek-rgb\.vercel\.app$/.test(u.hostname)
 ||u.username||u.password||u.port||u.pathname!=="/"||u.search||u.hash)
 throw Error("D36_REFUSED_NON_PREVIEW_DESTINATION");
 if(typeof x.token!=="string"||x.token.length<20)throw Error("D36_NO_AUTHORIZED_SESSION");
 if(!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(x.device??""))
 throw Error("D36_NO_BOUND_DEVICE");
 const tenant=Number(x.tenant),site=Number(x.site),foreignSite=Number(x.foreignSite),period=x.period??"2026-11";
 if(![tenant,site,foreignSite].every(n=>Number.isSafeInteger(n)&&n>0)
 ||site===foreignSite||!/^\d{4}-(0[1-9]|1[0-2])$/.test(period))
 throw Error("D36_INVALID_TENANT_OR_SITE");
 return {origin:u.origin,token:x.token,device:x.device,tenant,site,foreignSite,period};
}
function parse(s){try{return JSON.parse(s)}catch{throw Error("D36_INVALID_JSON")}}
export function checkOwn(http,body,route,c){
 if(http!==200)throw Error("D36_AUTHORIZED_HTTP_"+http);
 const v=parse(body)?.result?.data?.json;
 if(!v||v.tenantId!==c.tenant||v.siteId!==c.site||v.accountingCertification!=="NOT_CERTIFIED")
 throw Error("D36_SCOPE_OR_CERTIFICATION_DRIFT");
 if(route==="accrualCloseReadiness"){
 if(v.period!==c.period||v.isFinalFinancialStatement!==false
 ||v.canAutomaticallyLock!==false||v.needsIndependentReviewer!==true
 ||!Array.isArray(v.blockers))throw Error("D36_CLOSE_READINESS_DRIFT");
 }else if(route==="financialGLTrialBalance"){
 if(v.throughPeriod!==c.period||v.isFinalBalanceSheet!==false
 ||v.isMathematicallyBalanced!==true||!Array.isArray(v.accounts))
 throw Error("D36_TRIAL_DRIFT");
 }else if(route==="financialGLSiteStatements"){
 if(v.period!==c.period||v.siteScope!=="SITE_ONLY"||v.isFinalBalanceSheet!==false
 ||v.isFinalProfit!==false||v.isCompleteAccrualStatement!==false||!Array.isArray(v.accounts))
 throw Error("D36_STATEMENTS_DRIFT");
 }else throw Error("D36_UNKNOWN_ROUTE");
}
export function checkForeign(http,body){
 if(![403,404].includes(http))throw Error("D36_FOREIGN_SITE_NOT_DENIED_"+http);
 const j=parse(body),code=j?.error?.json?.data?.code;
 if(!["FORBIDDEN","NOT_FOUND"].includes(code)||j.result||body.includes('"accounts"')
 ||body.includes('"incomeStatement"'))throw Error("D36_FOREIGN_DATA_OR_DENIAL_DRIFT");
}
export function checkAnonymous(http,body){
 if(http!==401||parse(body)?.error?.json?.data?.code!=="UNAUTHORIZED")
 throw Error("D36_ANONYMOUS_ACCESS_DRIFT");
}
export async function run(x,{request=fetch}={}){
 const c=config(x);
 const ready=await request(c.origin+"/api/ready",{method:"GET",redirect:"manual",signal:AbortSignal.timeout(15000)});
 const healthy=await ready.json();
 if(ready.status!==200||healthy?.status!=="ok"||healthy?.checks?.supabaseConnectivity!==true
 ||healthy?.checks?.application!==true||healthy?.checks?.supabaseConfig!==true)
 throw Error("D36_PREVIEW_NOT_READY");
 const headers={authorization:"Bearer "+c.token,"x-powerhub-device-id":c.device,
 accept:"application/json","cache-control":"no-store"};
 const url=(name,siteId)=>c.origin+"/api/trpc/powerhub.reports."+name+"?input="
 +encodeURIComponent(JSON.stringify({json:{siteId,period:c.period}}));
 for(const name of ROUTES){
 const own=await request(url(name,c.site),{method:"GET",headers,redirect:"manual",signal:AbortSignal.timeout(8000)});
 checkOwn(own.status,await own.text(),name,c);
 const forbidden=await request(url(name,c.foreignSite),{method:"GET",headers,redirect:"manual",signal:AbortSignal.timeout(8000)});
 checkForeign(forbidden.status,await forbidden.text());
 }
 const anonymous=await request(url(ROUTES[0],c.site),{method:"GET",
 headers:{accept:"application/json"},redirect:"manual",signal:AbortSignal.timeout(8000)});
 checkAnonymous(anonymous.status,await anonymous.text());
 return {status:"PASS",scope:"D36_AUTHENTICATED_FINANCIAL_SITE_ISOLATION_SCOPED",
 checks:7,tenant:c.tenant,site:c.site,foreignSite:c.foreignSite,period:c.period,
 financialWrites:0,accountingCertification:"NOT_CERTIFIED"};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
 console.log(JSON.stringify(await run({preview:process.env.POWERHUB_D36_PREVIEW_URL,
 token:process.env.POWERHUB_D36_ACCESS_TOKEN,device:process.env.POWERHUB_D36_DEVICE_ID,
 tenant:process.env.POWERHUB_D36_TENANT_ID,site:process.env.POWERHUB_D36_SITE_ID,
 foreignSite:process.env.POWERHUB_D36_FOREIGN_SITE_ID,
 period:process.env.POWERHUB_D36_PERIOD})));
 }catch(e){console.error(JSON.stringify({status:"NOT_ACCEPTED",code:e instanceof Error?e.message:"UNKNOWN"}));process.exitCode=1}
}
