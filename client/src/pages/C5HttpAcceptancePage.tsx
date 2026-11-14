import { useAuth } from "@/_core/hooks/useAuth";
import { getPowerHubDeviceId } from "@/lib/offline-auth";
import { getSupabaseAccessToken } from "@/lib/supabase";
import { c5Quantile, validateC5HttpResponse, type C5Decision } from "@/lib/c5-close-readiness-proof";
import { useState } from "react";

// Internal preview-only test using the same authorized browser session and device lease.
// No credentials, financial values, or review evidence are displayed or persisted.
type Errors={http500:number;http502:number;http503:number;http504:number;timeout:number;other:number};
type Result={phase:string;attempted:number;valid:number;p50:number|null;p95:number|null;p99:number|null;max:number|null;errors:Errors;status:"COMPLETE"|"FAIL";decision:string};
const errorCounts=():Errors=>({http500:0,http502:0,http503:0,http504:0,timeout:0,other:0});
const EXPECTED_STATUS:C5Decision="BLOCKED";
const SCOPE={tenantId:1,siteId:1,period:"2026-11"};
const STATUS_LABELS:Record<C5Decision,string>={
  BLOCKED:"معطّل بسبب موانع إقفال",
  REVIEW_REQUIRED:"يتطلب مراجعة ومستندات",
  READY_FOR_INDEPENDENT_REVIEW:"جاهز للمراجعة المستقلة فقط",
  LOCKED_NOT_CERTIFIED:"مراجعة مقفلة وليست مصدّقة",
};

export default function C5HttpAcceptancePage(){
  const {user,isAuthenticated,loading}=useAuth();
  const [running,setRunning]=useState(false);
  const [progress,setProgress]=useState("لم يبدأ الاختبار");
  const [results,setResults]=useState<Result[]>([]);
  const [failure,setFailure]=useState<string|null>(null);
  const [budget,setBudget]=useState("3000");
  const [mode,setMode]=useState<"diagnostic"|"acceptance"|null>(null);
  const allowed=!loading&&isAuthenticated
    &&user?.email==="owner.e2e@powerhub-staging.example.com"
    &&/^powerhub-platform-[a-z0-9]+-mosabmalek-rgb\.vercel\.app$/.test(window.location.hostname);

  const classify=(e:unknown,counts:Errors):string=>{
    const code=e instanceof Error?e.message:"";
    if(/^HTTP_50[0234]$/.test(code))
      counts[("http"+code.slice(5)) as keyof Errors]++;
    else if(e instanceof Error && ["TimeoutError","AbortError"].includes(e.name))
      counts.timeout++;
    else counts.other++;
    return code.startsWith("HTTP_")?code:
      e instanceof Error && ["TimeoutError","AbortError"].includes(e.name)
        ?"TIMEOUT":"INVALID_PROOF_OR_TRANSPORT";
  };

  async function run(selected:"diagnostic"|"acceptance"){
    if(!allowed||running)return;
    const approvedBudget=Number(budget);
    if(!Number.isFinite(approvedBudget)||approvedBudget<=0||approvedBudget>8000){
      setFailure("INVALID_C5_P95_BUDGET");return;
    }
    setMode(selected);setRunning(true);setResults([]);setFailure(null);
    setProgress("التحقق من جاهزية الخادم والجلسة");
    try{
      const health=await fetch("/api/ready",{
        method:"GET",cache:"no-store",redirect:"manual",signal:AbortSignal.timeout(8000),
      });
      const ready=await health.json();
      if(health.status!==200||ready?.status!=="ok"||ready?.checks?.application!==true
        ||ready?.checks?.supabaseConfig!==true
        ||ready?.checks?.supabaseConnectivity!==true)
        throw new Error("C5_PREVIEW_NOT_READY");
      const token=await getSupabaseAccessToken();
      const device=await getPowerHubDeviceId();
      if(!token||!device||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(device))
        throw new Error("C5_SESSION_OR_DEVICE_UNAVAILABLE");

      const url="/api/trpc/powerhub.reports.accrualCloseReadiness?input="
        +encodeURIComponent(JSON.stringify({json:{siteId:SCOPE.siteId,period:SCOPE.period}}));
      const headers={
        authorization:"Bearer "+token,"x-powerhub-device-id":device,
        accept:"application/json","cache-control":"no-store",
      };
      let baselineFingerprint:string|null=null;
      const call=async()=>{
        const start=performance.now();
        const response=await fetch(url,{
          method:"GET",headers,cache:"no-store",redirect:"manual",signal:AbortSignal.timeout(8000),
        });
        const proof=validateC5HttpResponse(
          response.status,await response.text(),SCOPE,EXPECTED_STATUS,
        );
        if(baselineFingerprint!==null&&baselineFingerprint!==proof.fingerprint)
          throw new Error("C5_SOURCES_CHANGED_DURING_ACCEPTANCE");
        baselineFingerprint=proof.fingerprint;
        const duration=performance.now()-start;
        if(!Number.isFinite(duration)||duration<0)throw new Error("C5_INVALID_DURATION");
        return duration;
      };
      await call();await call();
      const phases=selected==="diagnostic"
        ?[{label:"10 × 1",samples:10,concurrency:1},{label:"10 × 4",samples:10,concurrency:4}]
        :[{label:"100 × 4",samples:100,concurrency:4}];
      const complete:Result[]=[];
      for(const phase of phases){
        const samples:number[]=[],errors=errorCounts();
        let attempted=0;
        for(let offset=0;offset<phase.samples;offset+=phase.concurrency){
          setProgress(phase.label+" — "+offset+"/"+phase.samples);
          const batch=await Promise.allSettled(
            Array.from({length:Math.min(phase.concurrency,phase.samples-offset)},call),
          );
          attempted+=batch.length;
          for(const item of batch){
            if(item.status==="fulfilled")samples.push(item.value);
            else classify(item.reason,errors);
          }
          if(attempted!==samples.length)break;
        }
        const result:Result={
          phase:phase.label,attempted,valid:samples.length,
          p50:c5Quantile(samples,.5),p95:c5Quantile(samples,.95),
          p99:c5Quantile(samples,.99),max:c5Quantile(samples,1),
          errors,status:samples.length===phase.samples
            &&Object.values(errors).every(x=>x===0)?"COMPLETE":"FAIL",
          decision:EXPECTED_STATUS,
        };
        complete.push(result);setResults([...complete]);
        if(result.status==="FAIL")break;
      }
      const allComplete=complete.length===phases.length
        &&complete.every(x=>x.status==="COMPLETE");
      // The final performance decision is explicit, not hidden behind HTTP 200.
      setProgress(!allComplete?"C5 فشل: بعض الاستجابات لم تكن صحيحة":
        complete.every(x=>x.p95!==null&&x.p95<=approvedBudget)
          ?"C5 قياس ناجح ضمن الحد المختار؛ الاعتماد النهائي يتطلب توثيق SHA وحد الأداء"
          :"C5 لم يحقق حد p95 المختار؛ راجع القياسات ومراحل الخادم");
    }catch(e){
      const code=e instanceof Error?e.message:"UNKNOWN_C5_FAILURE";
      setFailure(code.startsWith("HTTP_")?code:code.slice(0,90));
      setProgress("فشل شرط التحقق أو الاستجابة؛ لا توجد نتيجة قبول.");
    }finally{setRunning(false);}
  }

  if(!allowed)return <main dir="rtl" className="p-8 text-white">
    هذه الصفحة مخصصة فقط للحساب التجريبي المصادق في معاينة Staging.
  </main>;
  return <main dir="rtl" className="min-h-screen bg-[#0D1117] p-6 text-white sm:p-8">
    <h1 className="text-xl font-bold">C5 — القبول المالي عبر HTTPS</h1>
    <p className="mt-2 text-sm text-slate-200">
      اشتراك 1 · فرع 1 · نوفمبر 2026 · طلبات GET فقط · جهاز مصادق واحد · مهلة 8000ms.
      لا كتابة مالية ولا اعتماد للإقفال.
    </p>
    <p className="mt-2 text-sm text-amber-200">
      الحالة المتوقعة: {STATUS_LABELS[EXPECTED_STATUS]}. تتوقف العينات إذا تغيرت الموانع أو النطاق أو التصديق.
      حد الأداء أدناه معيار قياس تجريبي حتى اعتماده ضمن سجل C.
    </p>
    <label className="mt-4 block text-sm" htmlFor="c5-budget">حد p95 المقترح بالمللي ثانية</label>
    <input id="c5-budget" type="number" min="1" max="8000" step="100"
      className="mt-1 w-36 rounded border border-white/30 bg-[#111823] px-3 py-2 text-white"
      value={budget} onChange={e=>setBudget(e.target.value)} disabled={running}/>
    <div className="mt-4 flex flex-wrap gap-3">
      <button disabled={running} onClick={()=>void run("diagnostic")}
        className="rounded bg-[#F5B800] px-4 py-2 font-semibold text-black disabled:opacity-50">
        تشخيص 10 × 1 ثم 10 × 4
      </button>
      <button disabled={running} onClick={()=>void run("acceptance")}
        className="rounded border border-white/50 px-4 py-2 font-semibold disabled:opacity-50">
        اختبار كامل 100 × 4
      </button>
    </div>
    {mode?<p className="mt-3 text-sm">النمط: {mode==="diagnostic"?"تشخيص":"قبول كامل"}</p>:null}
    <p role="status" className="mt-3 text-sm">{progress}</p>
    {failure?<p role="alert" className="mt-2 text-sm text-rose-200">رمز الفشل: {failure}</p>:null}
    <div className="mt-4 overflow-x-auto"><table className="w-full border-collapse text-left text-sm" dir="ltr">
      <thead><tr>{["Phase","Attempted","Valid","p50","p95","p99","Max","500","502","503","504","Timeout","Other","Result"].map(label=>
        <th key={label} className="border border-white/20 p-2">{label}</th>)}</tr></thead>
      <tbody>{results.map(item=><tr key={item.phase}>
        {[item.phase,item.attempted,item.valid,item.p50,item.p95,item.p99,item.max,
          item.errors.http500,item.errors.http502,item.errors.http503,item.errors.http504,
          item.errors.timeout,item.errors.other,item.status].map((value,i)=>
          <td key={i} className="border border-white/20 p-2">{value??"—"}</td>)}
      </tr>)}</tbody>
    </table></div>
    <p className="mt-4 text-xs text-slate-400">
      هذه الصفحة لا تعرض رموز الدخول أو محتوى المستندات أو الأرصدة؛ نتيجة القياس لا تعني التصديق المحاسبي.
    </p>
  </main>;
}
