import {useEffect,useState} from "react";
import {trpc} from "@/lib/trpc";
import {Button} from "@/components/ui/button";

const display=(n:number|null|undefined)=>{
 if(n===null||n===undefined||!Number.isFinite(n))return "غير متاح";
 return n.toLocaleString("ar",{minimumFractionDigits:2,maximumFractionDigits:2});
};
const policyLabel:Record<string,string>={
 SINGLE_VERSION:"نسخة واحدة مسجلة",
 MIXED_POLICY:"سياسة غير متجانسة",
 UNPROVEN:"سياسة غير مثبتة",
};
export default function FinancialGLTrendPanel({
 siteId,period,active,hasMultipleSites,
}:{siteId:number;period:string;active:boolean;hasMultipleSites:boolean}){
 const [expanded,setExpanded]=useState(false);
 const [allSites,setAllSites]=useState(false);
 const [months,setMonths]=useState(6);
 const [requested,setRequested]=useState<{
  siteId:number;endPeriod:string;months:number;allSites:boolean;
 }|null>(null);
 useEffect(()=>{
   setExpanded(false);setAllSites(false);setRequested(null);
 },[siteId,period]);
 useEffect(()=>{
   if(!hasMultipleSites){setAllSites(false);setRequested(null);}
 },[hasMultipleSites]);
 const q=trpc.powerhub.reports.financialGLMonthlyTrend.useQuery(
  requested??{siteId,endPeriod:period,months,allSites:false},{
   enabled:Boolean(active&&expanded&&requested&&requested.siteId===siteId&&
     requested.endPeriod===period&&(!requested.allSites||hasMultipleSites)),
   staleTime:0,refetchOnWindowFocus:false,refetchOnReconnect:false,
  });
 const visible=Boolean(requested&&requested.siteId===siteId&&
   requested.endPeriod===period&&(!requested.allSites||hasMultipleSites)&&
   q.isSuccess&&!q.isFetching&&!q.isError);
 const trend=visible?q.data:null;
 const rows=trend?.rows??[];
 const grouped=trend?trend.siteIds.map(id=>({
   id,rows:rows.filter(r=>r.siteId===id),name:rows.find(r=>r.siteId===id)?.siteName??"فرع",
 })): [];
 return <div className="mt-3 rounded-md border border-white/10 p-3" dir="rtl">
   <div className="flex flex-wrap items-center justify-between gap-3">
    <div>
     <h4 className="font-semibold text-white">C — الاتجاهات المحاسبية الشهرية</h4>
     <p className="text-xs text-slate-400">من جميع قيود GL المنشورة · تحميل اختياري · لا تعتمد بيانات التدفق النقدي</p>
    </div>
    <Button size="sm" variant="outline" onClick={()=>setExpanded(v=>!v)}>
     {expanded?"إخفاء الاتجاهات":"عرض الاتجاهات"}
    </Button>
   </div>
   {expanded?<div className="mt-3 space-y-3 text-sm text-slate-200">
    <div className="flex flex-wrap items-center gap-3">
     <label htmlFor="gl-trend-months">عدد الأشهر</label>
     <select id="gl-trend-months" value={months}
      className="rounded border border-white/20 bg-[#111823] p-2 text-white"
      onChange={e=>{setMonths(Number(e.target.value));setRequested(null);}}>
      {[3,6,9,12].map(n=><option key={n} value={n}>{n}</option>)}
     </select>
     {hasMultipleSites?<label className="flex items-center gap-2">
      <input type="checkbox" checked={allSites}
       onChange={e=>{setAllSites(e.target.checked);setRequested(null);}}/>
      مقارنة الفروع المصرح بها في الاشتراك
     </label>:null}
     <Button size="sm" disabled={!active||q.isFetching||
       (allSites&&!hasMultipleSites)}
      onClick={()=>setRequested({siteId,endPeriod:period,months,
       allSites:allSites&&hasMultipleSites})}>احتساب الاتجاهات</Button>
    </div>
    {q.isFetching?<p role="status">جارٍ تجميع الفترات من PostgreSQL...</p>:null}
    {q.isError?<p role="alert" className="text-rose-200">
      تعذر التأكد من نتائج الاتجاهات أو الصلاحيات؛ لن نعرض نتائج مخزنة.
    </p>:null}
    {trend?<div className="space-y-4">
     <p className="text-amber-200">الاتجاهات أولية وغير معتمدة محاسبيًا (NOT_CERTIFIED).
      لم تثبت تغطية المصادر لهذا التقرير، ولا يتضمن توزيع المصروف المركزي أو قوائم موحدة.</p>
     <p>الفترة: {trend.startPeriod} إلى {trend.endPeriod} · الفروع: {trend.siteCount} · العملة: {trend.currency}</p>
     {grouped.map(group=><div key={group.id} className="space-y-2">
      <h5 className="font-semibold text-white">{group.name}</h5>
      <div className="overflow-x-auto"><table className="w-full text-right text-xs">
       <thead><tr className="border-b border-white/20">
        <th className="p-2">الشهر</th><th>إيراد الخدمة</th><th>التكلفة المباشرة</th>
        <th>نتيجة أولية</th><th>سياسة الاعتراف</th><th>المصدر</th>
       </tr></thead>
       <tbody>{group.rows.map(r=><tr key={group.id+":"+r.period}
         className="border-b border-white/10">
        <td className="p-2">{r.period}</td>
        <td>{r.hasPostedData?display(r.serviceRevenue):"لا توجد قيود منشورة"}</td>
        <td>{r.hasPostedData?display(r.directServiceCost):"—"}</td>
        <td>{r.hasPostedData?display(r.provisionalNetResult):"—"}</td>
        <td>{policyLabel[r.recognitionPolicyStatus]??"غير متاح"}</td>
        <td>{r.glEntryCount} قيد</td>
       </tr>)}</tbody>
      </table></div>
     </div>)}
     <p className="text-xs text-slate-400">لا تُعتبر الأشهر الخالية من القيود أشهرًا ذات ربح صفري. لا يُسمح بتصدير الاتجاهات على أنها قوائم معتمدة.</p>
    </div>:null}
   </div>:null}
 </div>;
}
