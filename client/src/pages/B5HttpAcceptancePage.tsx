import { useAuth } from "@/_core/hooks/useAuth";
import { getPowerHubDeviceId } from "@/lib/offline-auth";
import { getSupabaseAccessToken } from "@/lib/supabase";
import { useState } from "react";

// Hidden, preview-only engineering runner. It uses the already authenticated
// browser and its current device lease; credentials and identifiers never leave
// the normal same-origin request headers or enter the displayed result.
const ROUTES = [
  "financialGLSubledgerReconciliation",
  "financialGLCompanyMovementAudit",
  "financialGLSiteStatements",
] as const;
type RouteName = typeof ROUTES[number];
type Errors = { http500:number; http502:number; http503:number; http504:number; timeout:number; other:number };
type Result = { route:RouteName; attempted:number; http200:number; p50:number|null; p95:number|null; p99:number|null; max:number|null; errors:Errors; status:"COMPLETE"|"FAIL" };
const emptyErrors = ():Errors => ({http500:0,http502:0,http503:0,http504:0,timeout:0,other:0});
const percentile = (numbers:number[],p:number) => {
  const sorted=[...numbers].sort((a,b)=>a-b);
  return sorted.length?Math.round(sorted[Math.ceil(sorted.length*p)-1]*100)/100:null;
};

function validate(status:number,body:string,name:RouteName):void {
  if(status!==200)throw new Error(`HTTP_${status}`);
  let data:Record<string,unknown>|undefined;
  try { data=JSON.parse(body)?.result?.data?.json; } catch { throw new Error("INVALID_JSON"); }
  if(!data || data.tenantId!==1 || data.siteId!==1 || data.period!=="2026-11"
    || data.accountingCertification!=="NOT_CERTIFIED" || data.isFinalBalanceSheet!==false)
    throw new Error("SCOPE_OR_CERTIFICATION_MISMATCH");
  if(name==="financialGLSubledgerReconciliation" &&
    (!Array.isArray(data.checks) || data.checks.length!==5 || data.isApproved!==false))
    throw new Error("INVALID_SUBLEDGER_PROOF");
  if(name==="financialGLCompanyMovementAudit" &&
    (!Array.isArray(data.accountBalancesLinkedOnly) || data.isApproved!==false ||
      !["LINKED_ACCOUNT_MOVEMENTS_MATCH_NOT_CERTIFIED","BLOCKED_ACCOUNT_MOVEMENT_AUDIT"].includes(String(data.status))))
    throw new Error("INVALID_CASH_AUDIT_PROOF");
  if(name==="financialGLSiteStatements" &&
    (!Array.isArray(data.accounts) || data.siteScope!=="SITE_ONLY" ||
      data.isFinalProfit!==false || data.isCompleteAccrualStatement!==false))
    throw new Error("INVALID_SITE_STATEMENTS_PROOF");
}

function classify(error:unknown,counts:Errors) {
  const message=error instanceof Error?error.message:"";
  if(/^HTTP_50[0234]$/.test(message)) counts[`http${message.slice(5)}` as keyof Errors]++;
  else if(error instanceof Error && ["TimeoutError","AbortError"].includes(error.name))counts.timeout++;
  else counts.other++;
  return message.startsWith("HTTP_")?message:
    error instanceof Error && ["TimeoutError","AbortError"].includes(error.name)?"TIMEOUT":"INVALID_RESPONSE_OR_TRANSPORT";
}

export default function B5HttpAcceptancePage(){
  const {user,isAuthenticated,loading}=useAuth();
  const [running,setRunning]=useState(false);
  const [progress,setProgress]=useState("لم يبدأ الاختبار");
  const [results,setResults]=useState<Result[]>([]);
  const [failure,setFailure]=useState<string|null>(null);
  const allowed=!loading && isAuthenticated && user?.email==="owner.e2e@powerhub-staging.example.com"
    && /^powerhub-platform-[a-z0-9]+-mosabmalek-rgb\.vercel\.app$/.test(window.location.hostname);

  async function run(){
    if(!allowed || running)return;
    setRunning(true);setResults([]);setFailure(null);setProgress("فحص الجاهزية والجلسة");
    try{
      const readyResponse=await fetch("/api/ready",{method:"GET",cache:"no-store",signal:AbortSignal.timeout(8000)});
      const ready=await readyResponse.json();
      if(readyResponse.status!==200 || ready?.status!=="ok" || ready?.checks?.application!==true
        || ready?.checks?.supabaseConfig!==true || ready?.checks?.supabaseConnectivity!==true)
        throw new Error("STAGING_NOT_READY");
      const device=await getPowerHubDeviceId();
      const token=await getSupabaseAccessToken();
      if(!token || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(device))
        throw new Error("SESSION_OR_DEVICE_UNAVAILABLE");
      const headers={authorization:`Bearer ${token}`,"x-powerhub-device-id":device,accept:"application/json","cache-control":"no-store"};
      const call=async(name:RouteName) => {
        const url=`/api/trpc/powerhub.reports.${name}?input=${encodeURIComponent(JSON.stringify({json:{siteId:1,period:"2026-11"}}))}`;
        const started=performance.now();
        const response=await fetch(url,{method:"GET",headers,cache:"no-store",redirect:"manual",signal:AbortSignal.timeout(8000)});
        validate(response.status,await response.text(),name);
        return Math.round((performance.now()-started)*100)/100;
      };
      // Stop before load if even one report fails its individual HTTPS preflight.
      for(const name of ROUTES){
        setProgress(`الطلب الفردي: ${name}`);
        await call(name);
      }
      const collected:Result[]=[];
      for(const name of ROUTES){
        const durations:number[]=[],errors=emptyErrors();
        let attempted=0;
        for(let i=0;i<100;i+=4){
          setProgress(`${name}: ${i}/100`);
          const batch=await Promise.allSettled(Array.from({length:4},()=>call(name)));
          attempted+=batch.length;
          for(const item of batch){
            if(item.status==="fulfilled")durations.push(item.value);
            else classify(item.reason,errors);
          }
          if(attempted!==durations.length)break;
        }
        const result:Result={route:name,attempted,http200:durations.length,
          p50:percentile(durations,.5),p95:percentile(durations,.95),
          p99:percentile(durations,.99),max:percentile(durations,1),errors,
          status:durations.length===100?"COMPLETE":"FAIL"};
        collected.push(result);setResults([...collected]);
        if(result.status==="FAIL")break;
      }
      setProgress(collected.length===3 && collected.every(x=>x.status==="COMPLETE")
        ?"اكتمل القياس؛ قرار p95 بانتظار الحد المعتمد":"توقف القياس عند أول دفعة فاشلة");
    }catch(error){
      const code=classify(error,emptyErrors());
      setFailure(code);setProgress("فشل شرط التحقق المسبق؛ لم يبدأ الحمل أو توقف قبل استكماله");
    }finally{setRunning(false)}
  }

  if(!allowed)return <main dir="rtl" className="p-8 text-white">هذه الصفحة مخصصة لحساب اختبار Staging في معاينة Vercel.</main>;
  return <main dir="rtl" className="min-h-screen bg-[#0D1117] p-8 text-white">
    <h1 className="text-2xl font-bold">B5 — قياس HTTPS المصادق</h1>
    <p className="mt-3">اشتراك 1 · فرع 1 · 2026-11 · 100 طلب لكل تقرير · تزامن 4 · مهلة 8000ms · GET فقط.</p>
    <p className="mt-2 text-amber-300">القياس لا يقرر حد p95 أو التصديق المحاسبي. شغّله بعد التحقق من خط أساس GL.</p>
    <button type="button" disabled={running} onClick={()=>void run()}
      className="mt-5 rounded bg-[#F5B800] px-4 py-2 font-bold text-black disabled:opacity-50">{running?"جارٍ القياس...":"بدء قياس القراءة فقط"}</button>
    <p role="status" className="mt-4">{progress}</p>
    {failure?<p role="alert" className="mt-2 text-red-300">رمز الفشل: {failure}</p>:null}
    <div className="mt-6 overflow-x-auto"><table className="w-full border-collapse text-left" dir="ltr"><thead><tr>
      {["Route","Attempted","HTTP 200","p50 ms","p95 ms","p99 ms","Max ms","500","502","503","504","Timeout","Other","Status"].map(x=><th key={x} className="border p-2">{x}</th>)}
    </tr></thead><tbody>{results.map(x=><tr key={x.route}>
      {[x.route,x.attempted,x.http200,x.p50,x.p95,x.p99,x.max,x.errors.http500,x.errors.http502,x.errors.http503,x.errors.http504,x.errors.timeout,x.errors.other,x.status].map((v,i)=><td key={i} className="border p-2">{v??"—"}</td>)}
    </tr>)}</tbody></table></div>
  </main>;
}
