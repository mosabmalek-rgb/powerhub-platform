import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";

const STATUS_AR: Record<string,string> = {
  ALREADY_REVERSED: "تم تسجيل عكس مستقل لهذا القيد",
  REVERSAL_ENTRY_IMMUTABLE: "هذا القيد هو قيد عكس، وليس مصدرًا لعكس جديد",
  ACCRUAL_SOURCE_REVERSAL_AVAILABLE: "يمكن إنشاء مسودة عكس من مصدر الاستحقاق",
  ACCRUAL_SOURCE_REVERSAL_PENDING: "يوجد عكس للمصدر؛ تحقق من الموافقة والترحيل",
  ACCRUAL_SOURCE_OR_GL_INTEGRITY_BLOCKED: "عدم تطابق مصدر الاستحقاق مع القيد — محجوب",
  OPENING_DOCUMENTARY_EVIDENCE_REQUIRED: "الافتتاحية تحتاج أدلة مستقلة",
  CORRECTION_REVIEW_REQUIRED: "التصحيح يتطلب مراجعة مستقلة؛ لا يوجد عكس عام",
  REQUIRES_SOURCE_SPECIFIC_CORRECTION: "يتطلب تصحيح المصدر التشغيلي أولًا",
};

export default function FinancialGLCorrectionReadinessWorkspace({
  siteId,period,active,
}: {siteId:number;period:string;active:boolean}) {
  const [open,setOpen]=useState(false);
  const [cursor,setCursor]=useState<number|undefined>();
  const [history,setHistory]=useState<Array<number|undefined>>([]);
  const report=trpc.powerhub.reports.financialGLCorrectionReadiness.useQuery({
    siteId,period,limit:25,...(cursor ? {beforeEntryId:cursor}:{}),
  },{enabled:active&&open&&siteId>0,staleTime:0,refetchOnWindowFocus:false});
  const rows=report.data?.items??[];
  const safe=report.data?.glOnlyReversalAllowed===false
    &&report.data?.accountingCertification==="NOT_CERTIFIED"
    &&report.data?.isFinalFinancialAcceptance===false;
  const goBack=()=>{
    if(!history.length)return;
    const prev=history[history.length-1];
    setHistory(v=>v.slice(0,-1));setCursor(prev);
  };
  return <section dir="rtl" className="mt-3 rounded-md border border-white/15 p-3 text-sm text-slate-200">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div>
        <h4 className="font-semibold text-white">B4.11 — حالة التصحيح والعكس المحاسبي</h4>
        <p className="mt-1 text-xs text-slate-400">
          فحص مستقل للقيود. لا يغيّر دفتر الأستاذ، ولا يسمح بعكس القيود مباشرة.
          تصحيح المصادر التشغيلية يسبق أي ترحيل معتمد.
        </p>
      </div>
      <Button size="sm" variant="outline" onClick={()=>{
        setOpen(v=>!v);setCursor(undefined);setHistory([]);
      }}>{open?"إخفاء فحص التصحيحات":"عرض فحص التصحيحات"}</Button>
    </div>
    {open ? <div className="mt-3 space-y-2">
      {(report.isLoading||report.isFetching) ? <p role="status">جارٍ فحص مصادر القيود…</p>:null}
      {report.isError || (report.data&&!safe) ? <p role="alert" className="text-rose-200">
        تعذر التحقق من سلامة تقرير التصحيحات؛ حُجبت النتائج.
      </p>:null}
      {safe&&!report.isFetching ? <>
        {rows.length===0 ? <p className="text-xs text-slate-400">لا توجد قيود في هذه الصفحة.</p> : null}
        <div className="space-y-2">
          {rows.map(row=><div key={row.entryId} className="rounded border border-white/10 p-2">
            <p className="font-medium">GL #{row.entryId} — {row.sourceType} / {row.sourceId}</p>
            <p className="mt-1 text-xs">{STATUS_AR[row.status]??"حالة غير مصنفة؛ تحتاج مراجعة"}</p>
            {row.existingReversalEntryId ? <p className="text-xs">
              القيد العكسي الموجود: #{row.existingReversalEntryId}
            </p>:null}
            {row.canPrepareAccrualSourceReversal ? <p className="text-xs text-amber-200">
              استخدم مسار عكس الاستحقاقات الأصلي، ثم موافقة مستخدم مستقل.
            </p>:null}
          </div>)}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={!history.length}
            onClick={goBack}>السابق</Button>
          <Button size="sm" variant="outline"
            disabled={!report.data?.hasMore||!report.data?.nextBeforeEntryId}
            onClick={()=>{
              const next=report.data?.nextBeforeEntryId;
              if(!next)return;
              setHistory(v=>[...v,cursor]);setCursor(next);
            }}>التالي</Button>
          <Button size="sm" variant="outline" onClick={()=>report.refetch()}>
            تحديث التحقق
          </Button>
        </div>
        <p className="text-xs text-amber-200">
          التقرير رقابي فقط؛ لا يُنشئ قيودًا أو موافقات أو اعتمادًا ماليًا.
        </p>
      </>:null}
    </div>:null}
  </section>;
}
