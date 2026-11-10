import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";

const sourceKinds = [
  ["company_account_statement","كشف حساب نقدي / محفظة"],
  ["subscriber_receivable_statement","كشف ذمم المشتركين"],
  ["inventory_valuation_statement","تقييم المخزون"],
  ["supplier_statement","كشف ذمم الموردين"],
  ["payroll_liability_statement","التزامات الرواتب"],
  ["tax_statement","كشف الضرائب"],
  ["equity_confirmation","إثبات حقوق الملكية"],
  ["fixed_asset_register","سجل الأصول الثابتة"],
  ["other_external_statement","مستند خارجي آخر"],
] as const;
type SourceKind = typeof sourceKinds[number][0];
function suggestedKind(code:string):SourceKind {
  if(["1010","1020"].includes(code))return "company_account_statement";
  if(code==="1200")return "subscriber_receivable_statement";
  if(code==="1300")return "inventory_valuation_statement";
  if(code==="2300")return "supplier_statement";
  if(code==="2400")return "payroll_liability_statement";
  return "other_external_statement";
}

function readBase64(file:File):Promise<string>{
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onerror=()=>reject(new Error("تعذر قراءة الملف المحدد."));
    reader.onload=()=>{
      const result=reader.result;
      if(typeof result!=="string" || !result.includes(","))
        return reject(new Error("الملف غير قابل للقراءة."));
      resolve(result.slice(result.indexOf(",")+1));
    };
    reader.readAsDataURL(file);
  });
}

export default function FinancialOpeningEvidenceWorkspace({
  siteId,active,
}: {siteId:number;active:boolean}){
  const [lineId,setLineId]=useState<number|null>(null);
  const [sourceKind,setSourceKind]=useState<SourceKind>("other_external_statement");
  const [sourceReference,setSourceReference]=useState("");
  const [documentFile,setDocumentFile]=useState<File|null>(null);
  const [reviewNote,setReviewNote]=useState("");
  const [reviewEvidenceId,setReviewEvidenceId]=useState<number|null>(null);
  const [openedUrl,setOpenedUrl]=useState<{siteId:number;id:number;url:string}|null>(null);
  const [localError,setLocalError]=useState("");
  const workspace=trpc.powerhub.reports.financialGLOpeningEvidenceWorkspace.useQuery({siteId},{
    enabled:active && siteId>0,refetchOnWindowFocus:false,staleTime:0,
  });
  const utils=trpc.useUtils();
  const refresh=async()=>{
    await workspace.refetch();
    await utils.powerhub.reports.financialGLSourceCoverage.invalidate();
  };
  const upload=trpc.powerhub.reports.financialGLOpeningEvidenceUpload.useMutation({
    onSuccess:async()=>{setDocumentFile(null);setSourceReference("");await refresh();},
  });
  const review=trpc.powerhub.reports.financialGLOpeningEvidenceReview.useMutation({
    onSuccess:async()=>{setReviewEvidenceId(null);setReviewNote("");await refresh();},
  });
  const selected=workspace.data?.lines.find(l=>l.id===lineId);
  const evidence=workspace.data?.evidence??[];
  return <section aria-label="مستندات الافتتاحية" className="mt-4 rounded-lg border border-white/10 p-3 text-sm text-slate-200" dir="rtl">
    <h4 className="font-semibold text-white">مستندات الافتتاحية — الحيازة والمراجعة المستقلة</h4>
    <p className="mt-2 text-xs text-amber-200">رفع المستند والتحقق من SHA-256 وموافقة مراجع مستقل لا يصدّق وحده أرصدة الدفاتر المساعدة، ولا يحوّل القوائم إلى قوائم مالية معتمدة.</p>
    {workspace.isLoading || workspace.isFetching ? <p role="status" className="mt-2">جارٍ فحص الافتتاحية وأدلتها…</p> : null}
    {workspace.isError ? <p role="alert" className="mt-2 text-rose-200">تعذر جلب الأدلة بأمان؛ لا تُعرض قائمة جزئية.</p> : null}
    {workspace.data && !workspace.isFetching && !workspace.isError && !workspace.data.opening
      ? <p className="mt-2 text-amber-200">لا توجد افتتاحية منشورة لهذا الفرع؛ أنشئها واعتمدها أولًا من مسار الافتتاحيات.</p> : null}
    {workspace.data?.opening && !workspace.isFetching && !workspace.isError ? <>
      <p className="mt-2 text-xs">افتتاحية رقم {workspace.data.opening.id} بتاريخ {workspace.data.opening.asOfDate} — غير مصدّقة محاسبيًا.</p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <label className="text-xs">سطر الافتتاحية
          <select className="mt-1 w-full rounded border border-white/20 bg-[#1b2635] p-2 text-white"
            value={lineId??""} onChange={e=>{
              const id=Number(e.target.value);setLineId(id||null);
              const item=workspace.data?.lines.find(l=>l.id===id);
              if(item)setSourceKind(suggestedKind(item.accountCode));
            }}>
            <option value="">اختر السطر</option>
            {workspace.data.lines.map(l=><option key={l.id} value={l.id}>
              {l.accountCode} — {l.side==="debit"?"مدين":"دائن"} — {l.amount.toFixed(2)}
            </option>)}
          </select>
        </label>
        <label className="text-xs">نوع المصدر
          <select className="mt-1 w-full rounded border border-white/20 bg-[#1b2635] p-2 text-white"
            value={sourceKind} onChange={e=>setSourceKind(e.target.value as SourceKind)}>
            {sourceKinds.map(([id,title])=><option key={id} value={id}>{title}</option>)}
          </select>
        </label>
        <label className="text-xs">مرجع المصدر الأصلي
          <input className="mt-1 w-full rounded border border-white/20 bg-[#1b2635] p-2 text-white"
            value={sourceReference} maxLength={250}
            onChange={e=>setSourceReference(e.target.value)}
            placeholder="مرجع لا يقل عن 12 حرفًا" />
        </label>
        <label className="text-xs">ملف PDF أو صورة حتى 5 ميغابايت
          <input className="mt-1 block w-full text-white" type="file"
            accept=".pdf,.jpg,.jpeg,.png,.webp"
            onChange={e=>setDocumentFile(e.target.files?.[0]??null)} />
        </label>
      </div>
      <Button size="sm" variant="outline" className="mt-3" disabled={
        !selected || !documentFile || documentFile.size>5*1024*1024 ||
        sourceReference.trim().length<12 || upload.isPending
      } onClick={async()=>{
        if(!selected || !documentFile || !workspace.data?.opening)return;
        setLocalError("");
        try{
          const mime=documentFile.type;
          if(!["application/pdf","image/jpeg","image/png","image/webp"].includes(mime))
            throw new Error("نوع الملف غير مسموح.");
          const fileBase64=await readBase64(documentFile);
          await upload.mutateAsync({siteId,openingId:workspace.data.opening.id,
            lineId:selected.id,sourceKind,sourceReference:sourceReference.trim(),
            sourceAsOfDate:workspace.data.opening.asOfDate,
            side:selected.side as "debit"|"credit",amount:selected.amount,
            mimeType:mime as "application/pdf",fileBase64});
        }catch(error){setLocalError(error instanceof Error?error.message:"تعذر حفظ المستند.");}
      }}>{upload.isPending?"جارٍ حساب البصمة وحفظ الملف…":"حفظ المستند وربطه بسطر الافتتاحية"}</Button>
      {localError || upload.isError ? <p role="alert" className="mt-2 text-xs text-rose-200">
        {localError || upload.error?.message}</p> : null}
      <div className="mt-4 space-y-2">
        <h5 className="font-medium">الأدلة المسجلة ({evidence.length})</h5>
        {evidence.map(ev=><div key={ev.id} className="rounded border border-white/15 p-3 text-xs">
          <p>دليل {ev.id} — سطر {ev.openingLineId} — {ev.sourceReference}</p>
          <p>الحيازة: {ev.custodyRecorded?"مسجلة":"مفقودة"}؛ المراجعة: {ev.reviewStatus}</p>
          <p dir="ltr" className="mt-1 break-all text-slate-400">SHA-256: {ev.sha256}</p>
          {ev.custodyRecorded ? <Button size="sm" variant="outline" className="mt-2"
            onClick={async()=>{
              try{
                setLocalError("");
                const file=await utils.powerhub.reports.financialGLOpeningEvidenceFileUrl
                  .fetch({siteId,evidenceId:ev.id});
                setOpenedUrl({siteId,id:ev.id,url:file.url});
              }catch{setLocalError("تعذر فتح الملف المصرح به.");}
            }}>جلب رابط الاطلاع على المستند</Button> : null}
          {openedUrl?.siteId===siteId && openedUrl.id===ev.id ? <a className="mr-2 underline" target="_blank"
            rel="noopener noreferrer" href={openedUrl.url}>فتح المستند للمراجعة</a> : null}
          {ev.reviewStatus==="pending" && !ev.preparedByCurrentUser ? <div className="mt-2 space-y-2">
            <label className="flex items-start gap-2">
              <input type="checkbox" checked={reviewEvidenceId===ev.id}
                onChange={e=>setReviewEvidenceId(e.target.checked?ev.id:null)} />
              راجعت الملف ومصدره ومبلغ السطر بصورة مستقلة. لا أعتبره شهادة للقوائم المالية.
            </label>
            <textarea className="w-full rounded border border-white/20 bg-[#1b2635] p-2"
              value={reviewNote} onChange={e=>setReviewNote(e.target.value)}
              placeholder="ملاحظة المراجع، لا تقل عن 12 حرفًا" maxLength={1000} />
            <Button size="sm" variant="outline" disabled={reviewEvidenceId!==ev.id ||
              !ev.custodyRecorded || reviewNote.trim().length<12 || review.isPending}
              onClick={()=>review.mutate({siteId,evidenceId:ev.id,
                accept:true,note:reviewNote.trim()})}>
              {review.isPending?"جارٍ التحقق من الملف…":"اعتماد مراجعة المستند"}
            </Button>
          </div> : null}
          {ev.reviewStatus==="pending" && ev.preparedByCurrentUser
            ? <p className="mt-2 text-amber-200">يجب أن يراجعه مستخدم مخوّل آخر.</p> : null}
        </div>)}
      </div>
      {review.isError ? <p role="alert" className="mt-2 text-rose-200">{review.error.message}</p> : null}
    </> : null}
  </section>;
}
