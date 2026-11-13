import {escapeHtml} from "@/lib/report-pdf";

/** Phase C: identical, snapshot-verified rows across all three export formats. */
export type GLExportData={
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
 accountRows:{code:string;name:string;accountClass:string;current:number;previous:number;delta:number;percentage:number|null}[];
};
export const glMetricLabels:Record<string,string>={
 serviceRevenue:"إيراد خدمة الكهرباء",directServiceCost:"التكلفة المباشرة",
 grossResult:"مجمل النتيجة",wages:"الأجور والرواتب",depreciation:"الإهلاك",
 provisions:"المخصصات",otherOperatingExpenses:"مصروفات تشغيلية أخرى",
 operatingResult:"نتيجة التشغيل",nonOperatingExpenses:"مصروفات غير تشغيلية",
 provisionalNetResult:"النتيجة المحاسبية الأولية",
};
const requireComplete=(data:GLExportData)=>{
 if(data.accountingCertification!=="NOT_CERTIFIED"||data.isFinalFinancialStatement!==false||
   data.status!=="COMPARABLE_PRELIMINARY"||data.canExport!==true||
   data.blockers.length>0||!data.recognitionPolicyVersion||
   !/^[0-9a-f]{32}$/.test(data.snapshotFingerprint)||
   !Number.isSafeInteger(data.siteId)||data.siteId<=0||
   !Number.isSafeInteger(data.tenantId)||data.tenantId<=0||
   !/^\d{4}-(0[1-9]|1[0-2])$/.test(data.currentPeriod)||
   !/^\d{4}-(0[1-9]|1[0-2])$/.test(data.previousPeriod)||
   data.previousPeriod>=data.currentPeriod||
   data.currency!=="ILS"||data.periodTimeZone!=="Asia/Gaza"||
   !Number.isFinite(Date.parse(data.generatedAt)))
  throw new Error("GL_EXPORT_UNVERIFIED_SNAPSHOT");
};
export const glFormat=(x:number)=>x.toLocaleString("ar",{
 minimumFractionDigits:2,maximumFractionDigits:2});
export const glPercent=(x:number|null)=>x===null?
 "غير قابل للحساب (المقام صفر)":x.toLocaleString("ar")+"%";
export type GLExportCell=number|string;
export type GLExportRow=GLExportCell[];
export function buildGLExportRows(data:GLExportData):GLExportRow[]{
 requireComplete(data);
 return [
  ["تقرير مقارنة دفتر الأستاذ الأولي","PowerHub"],
  ["المولد / الاشتراك",data.tenantName],
  ["رقم الاشتراك",data.tenantId],
  ["الفرع",data.siteName],
  ["رقم الفرع",data.siteId],
  ["الفترة الحالية",data.currentPeriodStart+" — "+data.currentPeriodEnd],
  ["الفترة السابقة",data.previousPeriodStart+" — "+data.previousPeriodEnd],
  ["حالة المراجعة الحالية",data.currentReviewStatus],
  ["حالة المراجعة السابقة",data.previousReviewStatus],
  ["نسخة سياسة الاعتراف",data.recognitionPolicyVersion!],
  ["العملة",data.currency],["المنطقة الزمنية",data.periodTimeZone],
  ["حالة الاعتماد","NOT_CERTIFIED — غير نهائي"],
  ["وقت التوليد",data.generatedAt],["معرّف لقطة المصدر",data.snapshotFingerprint],
  ["عدد قيود الفترة الحالية",data.currentGLEntryCount],
  ["عدد قيود الفترة السابقة",data.previousGLEntryCount],
  [],
  ["المؤشر","الحالي","السابق","الفرق","النسبة (%)"],
  ...data.metrics.map(m=>[glMetricLabels[m.key]??m.key,m.current,m.previous,m.delta,
   m.percentage===null?"غير قابل للحساب":m.percentage]),
  [],
  ["رمز الحساب","اسم الحساب","التصنيف","الحالي","السابق","الفرق","النسبة (%)"],
  ...data.accountRows.map(a=>[a.code,a.name,a.accountClass,a.current,a.previous,a.delta,
   a.percentage===null?"غير قابل للحساب":a.percentage]),
 ];
}
export function serializeGLCsv(rows:GLExportRow[]):string{
 const cell=(v:GLExportCell)=>{
  if(typeof v==="number"){
   if(!Number.isFinite(v))throw new Error("GL_EXPORT_NON_FINITE_AMOUNT");
   return String(v);
  }
  // CSV spreadsheet apps interpret initial =+-@ and some leading whitespace as formulas.
  const safe=/^\s*[=+@\-]/.test(v)||/^[\t\r]/.test(v)?"'"+v:v;
  return '"'+safe.replaceAll('"','""')+'"';
 };
 return "\ufeff"+rows.map(row=>row.map(cell).join(",")).join("\r\n");
}
/** HTML used by the existing paginated jsPDF renderer; never interpolates raw text. */
export function buildGLPdfHtml(data:GLExportData):string{
 const rows=buildGLExportRows(data);
 const t=(head:string[],records:GLExportRow[])=>"<table style='border-collapse:collapse;width:100%;margin-bottom:12px'>"+
  "<thead><tr>"+head.map(x=>"<th>"+escapeHtml(x)+"</th>").join("")+"</tr></thead><tbody>"+
  records.map(r=>"<tr>"+r.map(v=>"<td>"+escapeHtml(v)+"</td>").join("")+"</tr>").join("")+
  "</tbody></table>";
 const metadata=t(["البند","القيمة"],rows.slice(0,17));
 const metrics=t(["المؤشر","الحالي","السابق","الفرق","النسبة (%)"],
  data.metrics.map(m=>[glMetricLabels[m.key]??m.key,
   glFormat(m.current),glFormat(m.previous),glFormat(m.delta),glPercent(m.percentage)]));
 const accounts=t(["رمز الحساب","اسم الحساب","التصنيف","الحالي","السابق","الفرق","النسبة (%)"],
  data.accountRows.map(a=>[a.code,a.name,a.accountClass,
   glFormat(a.current),glFormat(a.previous),glFormat(a.delta),glPercent(a.percentage)]));
 return "<main dir='rtl' lang='ar'><h1>PowerHub — مقارنة دفتر الأستاذ الأولية</h1>"+
  "<p><b>NOT_CERTIFIED — أرقام أولية غير معتمدة محاسبيًا، وليست أرباحًا نهائية</b></p>"+
  metadata+"<h2>مقارنة نتائج الفترة</h2>"+metrics+"<h2>جميع حسابات دفتر الأستاذ</h2>"+accounts+
  "<p>المبالغ بالشيكل؛ لا تشمل التكاليف المركزية غير الموزعة ولا تصديق الافتتاحية.</p></main>";
}
