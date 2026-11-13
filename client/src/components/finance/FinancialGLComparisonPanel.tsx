import {useEffect,useState} from "react";
import {Button} from "@/components/ui/button";
import {trpc} from "@/lib/trpc";
import {downloadGLComparisonPaginatedPdf} from "@/lib/financial-gl-pdf-renderer";
import {buildGLExportRows,serializeGLCsv,glMetricLabels,glFormat,glPercent,type GLExportData} from "@/lib/financial-gl-comparison-export";
import {toast} from "sonner";
import {isEarlierGLPeriod,previousGLPeriodOptions} from "@/lib/financial-gl-comparison-periods";

type Report=GLExportData;
const metricLabels=glMetricLabels;
const num=glFormat;
const pct=glPercent;
const blockerLabels:Record<string,string>={
 RECOGNITION_POLICY_NOT_PROVEN:"لم تثبت نسخة سياسة الاعتراف بالإيراد في الفترتين",
 RECOGNITION_POLICY_MISMATCH:"اختلاف نسخة سياسة الاعتراف بين الفترتين",
 CURRENT_PERIOD_NOT_ENDED_GAZA:"الفترة الحالية لم تنته بعد وفق توقيت غزة",
 NO_POSTED_GL_IN_ONE_PERIOD:"لا توجد قيود أستاذ منشورة لإحدى الفترتين",
 UNVERIFIED_SOURCE_COVERAGE:"تغطية المصادر المحاسبية غير مكتملة",
 UNRECONCILED_GL_SOURCE:"توجد مصادر محاسبية غير مسوّاة",
};
function save(blob:Blob,name:string){
 const url=URL.createObjectURL(blob);
 const a=document.createElement("a");a.href=url;a.download=name;document.body.appendChild(a);
 try{a.click();}finally{a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
}
export default function FinancialGLComparisonPanel({siteId,period,active}:{
 siteId:number;period:string;active:boolean;
}){
 const [open,setOpen]=useState(false);
 const [previous,setPrevious]=useState("");
 const [manualPrevious,setManualPrevious]=useState(false);
 const monthChoices=previousGLPeriodOptions(period,36);
 const [requested,setRequested]=useState<{siteId:number;currentPeriod:string;previousPeriod:string}|null>(null);
 const [exporting,setExporting]=useState(false);
 const [exportType,setExportType]=useState<"csv"|"xlsx"|"pdf"|null>(null);
 const [startFingerprint,setStartFingerprint]=useState("");
 useEffect(()=>{
   setOpen(false);setRequested(null);setPrevious(previousGLPeriodOptions(period,1)[0]??"");
   setManualPrevious(false);setStartFingerprint("");
 },[siteId,period]);
 const compare=trpc.powerhub.reports.financialGLMonthlyComparison.useQuery(
  requested??{siteId,currentPeriod:period,previousPeriod:period},
  {enabled:active&&open&&requested!==null&&siteId===requested?.siteId&&period===requested?.currentPeriod,
   staleTime:0,refetchOnWindowFocus:false,refetchOnReconnect:false});
 const exportFresh=trpc.powerhub.reports.financialGLMonthlyComparisonExport.useMutation();
 const data=!compare.isFetching&&!compare.isError&&compare.isSuccess&&requested?.siteId===siteId&&
   requested?.currentPeriod===period?compare.data as Report:undefined;
 const allowed=Boolean(data?.canExport&&data?.status==="COMPARABLE_PRELIMINARY"&&!exporting);
 const begin=()=>{
  if(!isEarlierGLPeriod(previous,period)){
   toast.error("اختر شهرًا سابقًا صالحًا للمقارنة.");return;
  }
  // Never re-use a prior result after an input change.
  setStartFingerprint("");setRequested({siteId,currentPeriod:period,previousPeriod:previous});

 };
 const exportReport=async(type:"csv"|"xlsx"|"pdf")=>{
  if(!requested||!allowed||!data)return;
  setExporting(true);setExportType(type);
  try{
   const result=await exportFresh.mutateAsync({...requested,
    expectedFingerprint:data.snapshotFingerprint});
   if(!result.canExport||result.status!=="COMPARABLE_PRELIMINARY")
    throw new Error("تقرير غير مكتمل؛ لا يمكن تصديره.");
   const fresh=result as Report;
   if(fresh.snapshotFingerprint!==data.snapshotFingerprint)
    throw new Error("تغيرت بصمة التقرير.");
   const rows=buildGLExportRows(fresh);
   const stem="مقارنة-دفتر-الأستاذ-"+siteId+"-"+period+"-"+requested.previousPeriod;
   if(type==="csv"){
    save(new Blob([serializeGLCsv(rows)],
      {type:"text/csv;charset=utf-8"}),stem+".csv");
   }else if(type==="xlsx"){
    const {default:ExcelJS}=await import("exceljs");
    const workbook=new ExcelJS.Workbook();workbook.creator="PowerHub";
    const sheet=workbook.addWorksheet("مقارنة المحاسبة",{views:[{rightToLeft:true}]});
    rows.forEach(r=>sheet.addRow(r.map(v=>typeof v==="number"?v:String(v??""))));
    sheet.columns=[{width:42},{width:32},{width:19},{width:19},{width:22}];
    sheet.getRow(18).font={bold:true};sheet.getRow(30).font={bold:true};
    const buffer=await workbook.xlsx.writeBuffer();
    save(new Blob([buffer],{type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}),
      stem+".xlsx");
   }else{
    await downloadGLComparisonPaginatedPdf(fresh,stem+".pdf");
   }
   setStartFingerprint(fresh.snapshotFingerprint);
   toast.success("اكتمل التصدير من لقطة GL مُعاد التحقق منها.");
  }catch(error){
   toast.error(error instanceof Error?error.message:"تعذر تصدير التقرير.");
   setRequested(null);setStartFingerprint("");
  }finally{setExporting(false);setExportType(null);}
 };
 return <section className="mt-3 rounded-md border border-white/10 p-3" dir="rtl" aria-label="المرحلة C المقارنات والتصدير">
  <div className="flex flex-wrap items-center justify-between gap-2">
   <div><h4 className="font-semibold text-white">C — مقارنة المحاسبة بين الفترات</h4>
    <p className="text-xs text-slate-400">من دفتر الأستاذ GL، عند الطلب. ليست مقارنة التحصيل النقدي ولا اعتماد أرباح.</p></div>
   <Button size="sm" variant="outline" onClick={()=>setOpen(v=>!v)}>
    {open?"إخفاء المقارنة":"مقارنة الفترات"}</Button>
  </div>
  {open?<div className="mt-3 space-y-3">
   <div className="flex flex-wrap items-center gap-2">
    <label htmlFor="gl-compare-previous" className="text-sm text-white">الفترة السابقة</label>
    <select id="gl-compare-previous" value={manualPrevious?"__custom":previous}
      onChange={e=>{
       const next=e.target.value;
       setManualPrevious(next==="__custom");
       setPrevious(next==="__custom"?"":next);
       setRequested(null);setStartFingerprint("");
      }}
      className="rounded border border-white/20 bg-[#111823] p-2 text-sm text-white">
      <option value="">اختر الشهر السابق</option>
      {monthChoices.map(month=><option key={month} value={month}>{month}</option>)}
      <option value="__custom">إدخال شهر أقدم يدويًا</option>
    </select>
    {manualPrevious?<input
      aria-label="شهر أقدم بصيغة YYYY-MM"
      id="gl-compare-previous-manual" type="text" dir="ltr" inputMode="numeric"
      placeholder="YYYY-MM" autoComplete="off" value={previous} maxLength={7}
      onChange={e=>{setPrevious(e.target.value.trim());setRequested(null);setStartFingerprint("");}}
      className="rounded border border-white/20 bg-[#111823] p-2 text-sm text-white"
    />:null}
    <Button size="sm" onClick={begin} disabled={!active||compare.isFetching}>عرض المقارنة</Button>
   </div>
   {compare.isFetching?<p role="status">جارٍ تجميع الأستاذ العام والتحقق من السياسة...</p>:null}
   {compare.isError?<p role="alert" className="text-rose-200">
    تعذر التحقق من بيانات المقارنة. أُخفيت النتائج ولا يُسمح بالتصدير.</p>:null}
   {data?<div className="space-y-3 text-sm text-slate-200">
    <p className="text-amber-200">مقارنة أولية غير معتمدة — NOT_CERTIFIED · حالة: {data.status}</p>
    <p>{data.tenantName} · {data.siteName} · {data.previousPeriod} مقابل {data.currentPeriod} · {data.currency}</p>
    <p>السياسة: {data.recognitionPolicyVersion??"غير مثبتة"} · حالة المراجعة:
     {data.previousReviewStatus} / {data.currentReviewStatus}</p>
    {data.blockers.length?<div role="alert" className="rounded border border-amber-400/30 p-2">
     التصدير محجوب لعدم اكتمال دليل المصدر:
     <ul className="list-disc pr-5">{data.blockers.map((b,i)=><li key={i}>{blockerLabels[b]??b}</li>)}</ul>
    </div>:null}
    <div className="overflow-x-auto"><table className="w-full text-right text-xs">
     <thead><tr><th>المؤشر</th><th>الحالي</th><th>السابق</th><th>الفرق</th><th>النسبة</th></tr></thead>
     <tbody>{data.metrics.map(m=><tr key={m.key} className="border-b border-white/10">
      <td className="p-2">{metricLabels[m.key]??m.key}</td><td>{num(m.current)}</td>
      <td>{num(m.previous)}</td><td>{num(m.delta)}</td><td>{pct(m.percentage)}</td>
     </tr>)}</tbody></table></div>
    <p className="break-all font-mono text-xs text-slate-400" dir="ltr">Snapshot: {data.snapshotFingerprint}</p>
    <p className="text-xs text-slate-400">وقت الاستخراج: {data.generatedAt} · حسابات: {data.accountRows.length} · لا يُحتسب المصروف المركزي غير الموزّع صفرًا.</p>
    <div className="flex flex-wrap gap-2">
     {(["csv","xlsx","pdf"] as const).map(t=><Button key={t} size="sm"
      variant="outline" disabled={!allowed} onClick={()=>void exportReport(t)}>
      {exporting&&exportType===t?"جارٍ التصدير…":"تصدير "+t.toUpperCase()}</Button>)}
    </div>
    {startFingerprint?<p className="text-xs text-slate-400">آخر بصمة تم تصديرها: {startFingerprint}</p>:null}
   </div>:null}
  </div>:null}
 </section>;
}
