import {useEffect,useState} from "react";
import {Button} from "@/components/ui/button";
import {trpc} from "@/lib/trpc";
import {downloadReportHtmlAsPdf,escapeHtml} from "@/lib/report-pdf";
import {toast} from "sonner";

type Report = {
 tenantId:number;siteId:number;tenantName:string;siteName:string;
 currentPeriod:string;previousPeriod:string;currentPeriodStart:string;currentPeriodEnd:string;
 previousPeriodStart:string;previousPeriodEnd:string;
 currentReviewStatus:string;previousReviewStatus:string;
 recognitionPolicyVersion:string|null;currency:string;periodTimeZone:string;
 generatedAt:string;snapshotFingerprint:string;
 status:"BLOCKED"|"COMPARABLE_PRELIMINARY";canExport:boolean;
 blockers:string[];accountingCertification:"NOT_CERTIFIED";isFinalFinancialStatement:false;
 currentGLEntryCount:number;previousGLEntryCount:number;
 metrics:{key:string;current:number;previous:number;delta:number;percentage:number|null}[];
 accountRows:{code:string;name:string;accountClass:string;current:number;previous:number;
 delta:number;percentage:number|null}[];
};
const metricLabels:Record<string,string>={
 serviceRevenue:"إيراد خدمة الكهرباء",directServiceCost:"التكلفة المباشرة",
 grossResult:"مجمل النتيجة",wages:"الأجور والرواتب",depreciation:"الإهلاك",
 provisions:"المخصصات",otherOperatingExpenses:"مصروفات تشغيلية أخرى",
 operatingResult:"نتيجة التشغيل",nonOperatingExpenses:"مصروفات غير تشغيلية",
 provisionalNetResult:"النتيجة المحاسبية الأولية",
};
const blockerLabels:Record<string,string>={
 RECOGNITION_POLICY_NOT_PROVEN:"لم تثبت نسخة سياسة الاعتراف بالإيراد في الفترتين",
 RECOGNITION_POLICY_MISMATCH:"اختلاف نسخة سياسة الاعتراف بين الفترتين",
 NO_POSTED_GL_IN_ONE_PERIOD:"لا توجد قيود أستاذ منشورة لإحدى الفترتين",
 UNVERIFIED_SOURCE_COVERAGE:"تغطية المصادر المحاسبية غير مكتملة",
 UNRECONCILED_GL_SOURCE:"توجد مصادر محاسبية غير مسوّاة",
};
const num=(x:number)=>x.toLocaleString("ar",{minimumFractionDigits:2,maximumFractionDigits:2});
const pct=(x:number|null)=>x===null?"غير قابل للحساب (المقام صفر)":x.toLocaleString("ar")+"%";
const csvCell=(value:unknown)=>{
 if(typeof value==="number"&&Number.isFinite(value))return String(value);
 const text=String(value??"");
 // Guard against Excel/Sheets CSV formula injection while preserving Unicode labels.
 const safe=/^[\s]*[=+@\t\r-]/.test(text)?"'"+text:text;
 return '"'+safe.replaceAll('"','""')+'"';
};
function save(blob:Blob,name:string){
 const url=URL.createObjectURL(blob);
 const a=document.createElement("a");a.href=url;a.download=name;document.body.appendChild(a);
 try{a.click();}finally{a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
}
function reportRows(data:Report):unknown[][]{
 return [
  ["تقرير مقارنة GL أولي غير معتمد","PowerHub"],["المولد / الاشتراك",data.tenantName],
  ["الفرع",data.siteName],["رقم الفرع",data.siteId],
  ["الفترة الحالية",data.currentPeriodStart+" — "+data.currentPeriodEnd],
  ["الفترة السابقة",data.previousPeriodStart+" — "+data.previousPeriodEnd],
  ["حالة الفترة الحالية",data.currentReviewStatus],
  ["حالة الفترة السابقة",data.previousReviewStatus],
  ["السياسة المحاسبية",data.recognitionPolicyVersion],
  ["العملة",data.currency],["التوقيت",data.periodTimeZone],
  ["حالة الاعتماد","NOT_CERTIFIED / غير نهائي"],["وقت الاستخراج",data.generatedAt],
  ["بصمة المصدر",data.snapshotFingerprint],
  ["عدد قيود الفترة الحالية",data.currentGLEntryCount],
  ["عدد قيود الفترة السابقة",data.previousGLEntryCount],
  [],
  ["المؤشر","الحالي","السابق","الفرق","نسبة الفرق"],
  ...data.metrics.map(m=>[metricLabels[m.key]??m.key,m.current,m.previous,m.delta,
   m.percentage===null?"غير قابل للحساب":m.percentage/100]),
  [],
  ["الحساب","التصنيف","الحالي","السابق","الفرق","نسبة الفرق"],
  ...data.accountRows.map(a=>[a.code+" — "+a.name,a.accountClass,a.current,a.previous,a.delta,
   a.percentage===null?"غير قابل للحساب":a.percentage/100]),
 ];
}
function makePdfElement(data:Report){
 const div=document.createElement("div");
 div.dir="rtl";
 div.style.cssText="width:1050px;padding:32px;background:#fff;color:#111;font-family:Tahoma,Arial,sans-serif";
 const meta=reportRows(data).slice(0,16).map(r=>
   "<tr><th>"+escapeHtml(r[0])+"</th><td>"+escapeHtml(r[1])+"</td></tr>").join("");
 const table=(title:string,rows:Array<{name:string;current:number;previous:number;delta:number;percentage:number|null}>)=>
   "<section><h2>"+escapeHtml(title)+"</h2><table style='width:100%;border-collapse:collapse'><thead><tr><th>البند</th><th>الحالي</th><th>السابق</th><th>الفرق</th><th>النسبة</th></tr></thead><tbody>"+
   rows.map(r=>"<tr><td>"+escapeHtml(r.name)+"</td><td>"+num(r.current)+"</td><td>"+
     num(r.previous)+"</td><td>"+num(r.delta)+"</td><td>"+escapeHtml(pct(r.percentage))+"</td></tr>").join("")+
   "</tbody></table></section>";
 div.innerHTML="<h1>PowerHub — مقارنة محاسبية أولية بين الفترات</h1>"+
 "<p><b>غير معتمد محاسبيًا — NOT_CERTIFIED. لا يمثل قوائم مالية نهائية ولا أرباحًا معتمدة.</b></p>"+
 "<table style='width:100%;border-collapse:collapse'>"+meta+"</table>"+
 table("نتائج القوائم الأولية",data.metrics.map(m=>({...m,name:metricLabels[m.key]??m.key})))+
 table("تفاصيل حسابات الأستاذ",data.accountRows.map(a=>({...a,name:a.code+" — "+a.name})))+
 "<p>لا تشمل الأرقام اعتماد الافتتاحيات أو تسوية المصروف المركزي غير الموزع. المبالغ بالشيكل.</p>";
 return div;
}
export default function FinancialGLComparisonPanel({siteId,period,active}:{
 siteId:number;period:string;active:boolean;
}){
 const [open,setOpen]=useState(false);
 const [previous,setPrevious]=useState("");
 const [requested,setRequested]=useState<{siteId:number;currentPeriod:string;previousPeriod:string}|null>(null);
 const [exporting,setExporting]=useState(false);
 const [exportType,setExportType]=useState<"csv"|"xlsx"|"pdf"|null>(null);
 const [startFingerprint,setStartFingerprint]=useState("");
 useEffect(()=>{
   setOpen(false);setRequested(null);setPrevious("");setStartFingerprint("");
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
  if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(previous)||previous>=period){
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
   const rows=reportRows(fresh);
   const stem="مقارنة-دفتر-الأستاذ-"+siteId+"-"+period+"-"+requested.previousPeriod;
   if(type==="csv"){
    save(new Blob(["\ufeff"+rows.map(r=>r.map(csvCell).join(",")).join("\r\n")],
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
    const element=makePdfElement(fresh);document.body.appendChild(element);
    try{await downloadReportHtmlAsPdf(element,stem+".pdf",{
      landscape:true,title:"PowerHub — مقارنة GL أولية غير معتمدة"});}
    finally{element.remove();}
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
    <input id="gl-compare-previous" type="month" value={previous}
      max={period} onChange={e=>{setPrevious(e.target.value);setRequested(null);setStartFingerprint("");}}
      className="rounded border border-white/20 bg-[#111823] p-2 text-sm text-white"/>
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
