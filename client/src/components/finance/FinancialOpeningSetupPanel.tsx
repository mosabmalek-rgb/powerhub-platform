import { useEffect, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";

type Line = {accountCode:string;side:"debit"|"credit";amount:string;evidenceReference:string};
const newLine=(side:Line["side"]):Line=>({accountCode:"",side,amount:"",evidenceReference:""});
const newKey=()=>"opening-ui-"+crypto.randomUUID();

export default function FinancialOpeningSetupPanel({siteId,active,onChanged}:{
  siteId:number;active:boolean;onChanged:()=>Promise<void>;
}){
  const [date,setDate]=useState("");
  const [reference,setReference]=useState("");
  const [description,setDescription]=useState("");
  const [lines,setLines]=useState<Line[]>([newLine("debit"),newLine("credit")]);
  const [key,setKey]=useState(newKey);
  const [voidReason,setVoidReason]=useState("");
  useEffect(()=>{setDate("");setReference("");setDescription("");
    setLines([newLine("debit"),newLine("credit")]);setKey(newKey());setVoidReason("");
  },[siteId]);
  const workspace=trpc.powerhub.reports.financialGLOpeningEvidenceWorkspace.useQuery({siteId},{
    enabled:active&&siteId>0,staleTime:0,refetchOnWindowFocus:false,
  });
  const chart=trpc.powerhub.reports.financialGLChartAccounts.useQuery({siteId},{
    enabled:active&&siteId>0&&workspace.data?.opening===null,staleTime:300000,
  });
  const chartInitialize=trpc.powerhub.reports.financialGLChartInitialize.useMutation({
    onSuccess:async()=>{await chart.refetch();},
  });
  const refreshed=async()=>{await workspace.refetch();await onChanged();};
  const create=trpc.powerhub.reports.financialGLOpeningCreate.useMutation({onSuccess:refreshed});
  const post=trpc.powerhub.reports.financialGLOpeningPost.useMutation({onSuccess:refreshed});
  const voidDraft=trpc.powerhub.reports.financialGLOpeningVoid.useMutation({
    onSuccess:async()=>{setKey(newKey());await refreshed();},
  });
  const busy=create.isPending||post.isPending||voidDraft.isPending;
  const amounts=lines.map(l=>Number(l.amount));
  const debit=lines.reduce((sum,l,i)=>sum+(l.side==="debit"?amounts[i]:0),0);
  const credit=lines.reduce((sum,l,i)=>sum+(l.side==="credit"?amounts[i]:0),0);
  const valid=Boolean(date&&/^\d{4}-\d{2}-\d{2}$/.test(date)&&
    reference.trim().length>=8&&description.trim().length>=10&&
    lines.length>=2&&debit>0&&credit>0&&Math.abs(debit-credit)<0.005&&
    lines.every((l,i)=>!!chart.data?.some(a=>a.code===l.accountCode)&&
      l.evidenceReference.trim().length>=3&&l.amount.trim()!==""&&
      Number.isFinite(amounts[i])&&amounts[i]>0&&amounts[i]<=100000000000&&
      Math.abs(amounts[i]*100-Math.round(amounts[i]*100))<0.000001));
  const edit=(i:number,patch:Partial<Line>)=>setLines(a=>a.map((x,j)=>i===j?{...x,...patch}:x));
  const opening=workspace.data?.opening;
  const error=create.error?.message||post.error?.message||voidDraft.error?.message;
  return <div className="mt-3 rounded-md border border-white/15 p-3 text-sm text-slate-200" dir="rtl">
    <h5 className="font-semibold">إعداد واعتماد الرصيد الافتتاحي</h5>
    <p className="mt-1 text-xs text-amber-200">اعتماد مُراجع مختلف شرط لترحيل القيد؛ وهو ليس شهادة مطابقة مستقلة للدفاتر المساعدة.</p>
    {workspace.isFetching?<p role="status" className="mt-2">جارٍ التحقق من الافتتاحية…</p>:null}
    {workspace.isError?<p role="alert" className="mt-2">تعذر تحديد حالة الافتتاحية؛ لا يمكن إنشاء مسودة جديدة.</p>:null}
    {workspace.data&&!workspace.isFetching&&!opening?<div className="mt-3 space-y-2">
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="text-xs">تاريخ الافتتاحية
          <input type="date" className="mt-1 w-full rounded border border-white/20 bg-[#1b2635] p-2"
            value={date} onChange={e=>setDate(e.target.value)}/></label>
        <label className="text-xs">مرجع الإثبات
          <input className="mt-1 w-full rounded border border-white/20 bg-[#1b2635] p-2"
            value={reference} maxLength={250} onChange={e=>setReference(e.target.value)}/></label>
      </div>
      <label className="block text-xs">وصف الافتتاحية ومصادرها
        <textarea className="mt-1 w-full rounded border border-white/20 bg-[#1b2635] p-2"
          value={description} maxLength={1000} onChange={e=>setDescription(e.target.value)}/></label>
      {lines.map((l,i)=><div key={i} className="grid gap-2 rounded border border-white/15 p-2 sm:grid-cols-4">
        <label className="text-xs">الحساب
          <select className="mt-1 w-full rounded border border-white/20 bg-[#1b2635] p-2"
            value={l.accountCode} onChange={e=>edit(i,{accountCode:e.target.value})}>
            <option value="">اختر حسابًا</option>
            {(chart.data??[]).map(a=><option key={a.code} value={a.code}>{a.code} — {a.name}</option>)}
          </select></label>
        <label className="text-xs">الطرف
          <select className="mt-1 w-full rounded border border-white/20 bg-[#1b2635] p-2"
            value={l.side} onChange={e=>edit(i,{side:e.target.value as Line["side"]})}>
            <option value="debit">مدين</option><option value="credit">دائن</option>
          </select></label>
        <label className="text-xs">المبلغ
          <input inputMode="decimal" className="mt-1 w-full rounded border border-white/20 bg-[#1b2635] p-2"
            value={l.amount} onChange={e=>edit(i,{amount:e.target.value})}/></label>
        <label className="text-xs">مرجع السطر
          <input className="mt-1 w-full rounded border border-white/20 bg-[#1b2635] p-2"
            value={l.evidenceReference} maxLength={250}
            onChange={e=>edit(i,{evidenceReference:e.target.value})}/></label>
        {lines.length>2?<Button variant="outline" size="sm" disabled={busy}
          onClick={()=>setLines(a=>a.filter((_,j)=>i!==j))}>حذف السطر</Button>:null}
      </div>)}
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <Button size="sm" variant="outline" disabled={busy||lines.length>=500}
          onClick={()=>setLines(a=>[...a,newLine("debit")])}>إضافة سطر</Button>
        <span>مدين: {debit.toFixed(2)}</span><span>دائن: {credit.toFixed(2)}</span>
        <span>الفرق: {(debit-credit).toFixed(2)}</span>
      </div>
      {chart.data?.length===0?<div className="mt-2 rounded border border-amber-400/20 p-2 text-xs">
        <p>دليل الحسابات لم يُهيأ بعد لهذا الاشتراك. يجب تهيئته قبل إدخال الافتتاحية.</p>
        <Button variant="outline" size="sm" className="mt-2"
          disabled={busy||chartInitialize.isPending}
          onClick={()=>chartInitialize.mutate({siteId})}>
          {chartInitialize.isPending?"جارٍ التهيئة…":"تهيئة دليل الحسابات"}
        </Button>
      </div>:null}
      {chartInitialize.isError?<p role="alert" className="text-rose-200">{chartInitialize.error.message}</p>:null}
      {chart.isError?<p role="alert">تعذر تحميل دليل الحسابات.</p>:null}
      <Button size="sm" variant="outline" disabled={!valid||busy||chart.isFetching}
        onClick={()=>create.mutate({siteId,asOfDate:date,evidenceReference:reference.trim(),
          description:description.trim(),operationKey:key,lines:lines.map((l,i)=>({
            accountCode:l.accountCode,side:l.side,amount:amounts[i],evidenceReference:l.evidenceReference.trim(),
          }))})}> {create.isPending?"جارٍ حفظ المسودة…":"إنشاء مسودة افتتاحية"} </Button>
    </div>:null}
    {opening?<div className="mt-2 space-y-2 text-xs">
      <p>افتتاحية #{opening.id} — {opening.asOfDate} — {opening.status==="draft"?"مسودة":"مرحلة إلى دفتر الأستاذ"}</p>
      {opening.status==="draft"&&opening.createdByCurrentUser?
        <p className="text-amber-200">أنت المُعد؛ يجب اعتماد المسودة من حساب مخوّل آخر.</p>:null}
      {opening.status==="draft"&&!opening.createdByCurrentUser?
        <Button size="sm" variant="outline" disabled={busy}
          onClick={()=>post.mutate({siteId,openingId:opening.id})}>
          {post.isPending?"جارٍ الترحيل…":"اعتماد المسودة وترحيلها"}</Button>:null}
      {opening.status==="draft"?<div className="space-y-2">
        <textarea className="w-full rounded border border-white/20 bg-[#1b2635] p-2"
          value={voidReason} placeholder="سبب الإلغاء (10 أحرف على الأقل)"
          onChange={e=>setVoidReason(e.target.value)}/>
        <Button size="sm" variant="outline" disabled={busy||voidReason.trim().length<10}
          onClick={()=>voidDraft.mutate({siteId,openingId:opening.id,reason:voidReason.trim()})}>
          إلغاء المسودة</Button>
      </div>:null}
    </div>:null}
    {error?<p role="alert" className="mt-2 text-xs text-rose-200">{error}</p>:null}
  </div>;
}
