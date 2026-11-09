import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";

type AccountPair = { label:string; debit:string; credit:string; description:string };
const pairs:AccountPair[]=[
  {label:"إثبات إيراد خدمة مستحق",debit:"1100",credit:"4100",description:"مدين: إيراد غير مفوتر، دائن: إيرادات الخدمة"},
  {label:"إلغاء إيراد غير مكتسب",debit:"4100",credit:"2200",description:"مدين: إيرادات الخدمة، دائن: الإيراد المؤجل"},
  {label:"تحميل إيراد مؤجل مكتسب",debit:"2200",credit:"4100",description:"مدين: إيراد مؤجل، دائن: إيراد خدمة"},
  {label:"تسوية مصروف تشغيلي مستحق",debit:"5100",credit:"2100",description:"مدين: مصروف تشغيلي، دائن: التزامات مستحقة"},
  {label:"إهلاك أصل ثابت",debit:"5300",credit:"1500",description:"مدين: مصروف إهلاك، دائن: مجمع الإهلاك"},
  {label:"مخصص ديون مشكوك في تحصيلها",debit:"5400",credit:"1190",description:"مدين: مصروف مخصص، دائن: مخصص ديون"},
  {label:"مصروف غير تشغيلي مستحق",debit:"6100",credit:"2100",description:"مدين: مصروف غير تشغيلي، دائن: التزامات مستحقة"},
];
const evidenceLabels=[
  {key:"unbilled_service",label:"تسوية الخدمات المستحقة غير المفوترة"},
  {key:"invoice_cutoff",label:"مطابقة الفواتير مع فترات تقديم الخدمة"},
  {key:"supplier_reconciliation",label:"مطابقة ذمم ومشتريات الموردين"},
  {key:"inventory_reconciliation",label:"تسوية المخزون والمستهلك"},
  {key:"payroll_reconciliation",label:"مطابقة الأجور والسلف والخصومات"},
  {key:"depreciation_register",label:"سجل الأصول والإهلاك"},
  {key:"provision_assessment",label:"مراجعة المخصصات"},
  {key:"tax_reconciliation",label:"مطابقة الضريبة والتسويات"},
] as const;
type EvidenceKey=typeof evidenceLabels[number]["key"];
const emptyEvidence:Record<EvidenceKey,string>={
  unbilled_service:"",invoice_cutoff:"",supplier_reconciliation:"",
  inventory_reconciliation:"",payroll_reconciliation:"",
  depreciation_register:"",provision_assessment:"",tax_reconciliation:"",
};
const n=(v:number)=>v.toLocaleString("ar",{minimumFractionDigits:0,maximumFractionDigits:2});
export default function AccrualAccountingPanel({siteId,period,active}:{
  siteId:number;period:string;active:boolean;
}){
  const utils=trpc.useUtils();
  const statement=trpc.powerhub.reports.accrualMonthStatement.useQuery({siteId,period},{
    enabled:active,staleTime:60000,refetchOnWindowFocus:false
  });
  const journals=trpc.powerhub.reports.accrualJournalList.useQuery({siteId,period},{
    enabled:active,staleTime:60000,refetchOnWindowFocus:false
  });
  const review=trpc.powerhub.reports.accrualPeriodReviewStatus.useQuery({siteId,period},{
    enabled:active,staleTime:60000,refetchOnWindowFocus:false,
  });
  const saveReview=trpc.powerhub.reports.accrualPeriodReviewSave.useMutation();
  const lockReview=trpc.powerhub.reports.accrualPeriodReviewLock.useMutation();
  const create=trpc.powerhub.reports.accrualJournalCreate.useMutation();
  const post=trpc.powerhub.reports.accrualJournalPost.useMutation();
  const reverse=trpc.powerhub.reports.accrualJournalReverse.useMutation();
  const voidDraft=trpc.powerhub.reports.accrualJournalVoid.useMutation();
  const [selectedPair,setSelectedPair]=useState("0");
  const [amount,setAmount]=useState("");
  const [reason,setReason]=useState("");
  const [reversalReason,setReversalReason]=useState("");
  const [reversalPeriod,setReversalPeriod]=useState(period);
  const [voidReason,setVoidReason]=useState("");
  const [voidTargetId,setVoidTargetId]=useState<number|null>(null);
  const [reversalTargetId,setReversalTargetId]=useState<number|null>(null);
  const [requestKey,setRequestKey]=useState<string|null>(null);
  const [evidence,setEvidence]=useState<Record<EvidenceKey,string>>(emptyEvidence);
  const [showEvidence,setShowEvidence]=useState(false);
  const [showNew,setShowNew]=useState(false);
  const refresh=async()=>{
    await Promise.all([
      utils.powerhub.reports.accrualMonthStatement.invalidate({siteId,period}),
      utils.powerhub.reports.accrualJournalList.invalidate({siteId,period}),
      utils.powerhub.reports.accrualPeriodReviewStatus.invalidate({siteId,period}),
    ]);
  };
  const submitEvidence=async()=>{
    const values={...evidence};
    if(evidenceLabels.some(({key})=>values[key].trim().length<8)){
      toast.error("أدخل مرجعاً أو نتيجة مراجعة واضحة لكل بند (ثمانية أحرف على الأقل).");
      return;
    }
    try{
      await saveReview.mutateAsync({siteId,period,evidence:values});
      toast.success("حُفظت أدلة الإقفال كمسودة، وتتطلب مراجعة مستخدم مخوّل آخر.");
      setShowEvidence(false);
      await refresh();
    }catch{toast.error("تعذر حفظ أدلة الإقفال؛ تحقق من صلاحياتك أو حالة الشهر.");}
  };
  const signoff=async()=>{
    try{
      await lockReview.mutateAsync({siteId,period});
      toast.success("أُقفلت المراجعة الشهرية وحُفظت اللقطة؛ الربح يظل أولياً لحين اكتمال دفاتر الحسابات.");
      await refresh();
    }catch{toast.error("تعذر إقفال الشهر؛ راجع المسودات والذمم والدورات والصلاحيات وفصل مهام المراجعة.");}
  };
  const submit=async()=>{
    const choice=pairs[Number(selectedPair)];
    const value=Number(amount);
    // Validate decimal input as text: 0.29 * 100 is not exactly 29 in IEEE-754.
    if(!choice || !/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(amount.trim()) ||
      !Number.isFinite(value) || value<=0 || value>100000000000 ||
      reason.trim().length<10){
      toast.error("أدخل مبلغاً موجباً بمنزلتين عشريتين على الأكثر وسبباً واضحاً (10 أحرف على الأقل).");
      return;
    }
    const operationKey=requestKey??`accrual-${crypto.randomUUID()}`;
    setRequestKey(operationKey);
    try{
      const result=await create.mutateAsync({siteId,period,amount:value,reason:reason.trim(),
        debitAccount:choice.debit as "1100"|"4100"|"2200"|"5100"|"2100"|"5300"|"1500"|"5400"|"1190"|"6100",
        creditAccount:choice.credit as "1100"|"4100"|"2200"|"5100"|"2100"|"5300"|"1500"|"5400"|"1190"|"6100",
        operationKey});
      setRequestKey(null);setAmount("");setReason("");setShowNew(false);
      toast.success(result.status==="posted"
        ? "القيد موجود ومعتمد بالفعل؛ لم يُنشأ قيد مكرر."
        : "حُفظ القيد مسودة؛ لن يؤثر في الأرصدة قبل اعتماد مستخدم مخوّل آخر.");
      await refresh();
    }catch{toast.error("تعذر حفظ القيد. سيُستخدم مفتاح العملية نفسه عند إعادة المحاولة.");}
  };
  const approve=async(id:number)=>{
    try{
      await post.mutateAsync({siteId,journalId:id});
      toast.success("اعتُمد قيد التسوية وأُدرج في ملخص الاستحقاق.");
      await refresh();
    }catch{toast.error("لم يُعتمد القيد. لا يجوز لمنشئ القيد اعتماده بنفسه.");}
  };
  const voidJournal=async(id:number)=>{
    if(voidReason.trim().length<10){toast.error("أدخل سبب إلغاء واضحاً لا يقل عن 10 أحرف.");return;}
    try{
      await voidDraft.mutateAsync({siteId,journalId:id,reason:voidReason.trim()});
      toast.success("أُلغيت المسودة وسُجّل سبب الإلغاء دون حذف السجل.");
      setVoidReason("");setVoidTargetId(null);await refresh();
    }catch{toast.error("تعذر إلغاء المسودة؛ لا يمكن إلغاء قيد معتمد دون قيد عكس.");}
  };
  const createReversal=async(id:number)=>{
    if(reversalReason.trim().length<10 || !/^\d{4}-(0[1-9]|1[0-2])$/.test(reversalPeriod) ||
      reversalPeriod<period){
      toast.error("أدخل سبب عكس واضحاً وشهراً صحيحاً لا يسبق الشهر الأصلي.");return;
    }
    try{
      await reverse.mutateAsync({siteId,journalId:id,period:reversalPeriod,
        reason:reversalReason.trim(),operationKey:`accrual-reverse-${id}-${reversalPeriod}`});
      toast.success(`أُنشئت مسودة العكس في ${reversalPeriod}؛ انتقل إلى ذلك الشهر لاعتمادها.`);
      setReversalReason("");setReversalTargetId(null);await refresh();
    }catch{toast.error("تعذر إنشاء قيد عكس. تحقق من أن القيد معتمد ولم يُعكس سابقاً.");}
  };
  const loading=statement.isLoading||journals.isLoading;
  const busy=create.isPending||post.isPending||reverse.isPending||voidDraft.isPending||saveReview.isPending||lockReview.isPending;
  const locked=review.data?.status==="locked";
  return <section aria-labelledby="monthly-accrual-review" className="rounded-xl border border-white/10 bg-[#111823] p-4 sm:p-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 id="monthly-accrual-review" className="text-lg font-bold text-white">الاستحقاق المحاسبي وتسويات الإقفال</h2>
        <p className="mt-1 text-xs text-slate-300">الشهر {period} · تقرير اختياري، لا يؤثر في سرعة فتح اللوحة</p>
      </div>
      <Button size="sm" variant="outline" className="border-white/20 text-white"
        onClick={()=>{void refresh();}} disabled={busy || !active}>تحديث المطابقة</Button>
    </div>
    {loading?<p role="status" className="mt-4 text-sm text-slate-300">جارٍ مراجعة مصادر الإيرادات والمصروفات والقيود…</p>:null}
    {(statement.isError||journals.isError)?<p role="alert" className="mt-4 text-sm text-rose-200">
      تعذر تحميل كامل مصادر الاستحقاق أو القيود. لا تُعرض نتائج قديمة باعتبارها مكتملة.
    </p>:null}
    {statement.data&&!statement.isError?<div className="mt-4 space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {([
          {label:"فوترة الخدمة المكتملة دون الضريبة",v:statement.data.serviceBillingExTax},
          {label:"تعديل الإيرادات المعتمد",v:statement.data.journalAdjustments.revenue},
          {label:"الإيرادات الأولية بعد التعديلات",v:statement.data.revenueAfterAdjustments},
          {label:"تكلفة التشغيل بعد التعديلات",v:statement.data.operatingCostsAfterAdjustments},
          {label:"التكاليف غير التشغيلية",v:statement.data.nonOperatingCostsAfterAdjustments},
          {label:"الرصيد الأولي بعد القيود",v:statement.data.provisionalNetAfterAdjustments},
          {label:"مشتريات لا تُحمل تلقائياً كمصروف",v:statement.data.purchaseGrossNotExpensed},
        ] as const).map(item=><div key={item.label} className="rounded-lg border border-white/10 bg-[#0D1117] p-3">
          <p className="text-xs text-slate-300">{item.label}</p>
          <strong className="mt-2 block text-lg text-white">{n(item.v)} شيكل</strong>
        </div>)}
      </div>
      <p className="rounded-lg border border-amber-400/20 p-3 text-xs text-amber-200">
        هذا رصيد أولي غير معتمد كصافي ربح. يتطلب الإقفال التحقق من الخدمات غير المفوترة،
        وفترات الاعتراف، والمخصصات، والإهلاك، والذمم، وكامل قيود اليومية.
        لا تُحتسب المشتريات والسداد النقدي للرواتب كمصروف إضافي فوق الاستهلاك والأجور المعتمدة.
      </p>
      <div className="grid grid-cols-2 gap-3 text-xs text-slate-300 sm:grid-cols-4">
        <p>مسودات الرواتب: {n(statement.data.draftPayrollCount)}</p>
        <p className={statement.data.unreconciledPayrollPayoutCount>0?"text-rose-300":""}>
          عمليات رواتب غير متطابقة: {n(statement.data.unreconciledPayrollPayoutCount)}
        </p>
        <p>فواتير دورات غير مكتملة: {n(statement.data.uncompletedInvoiceCount)}</p>
        <p>فواتير تفتقر للدورة: {n(statement.data.missingCycleCount)}</p>
        <p>حركات مخزون غير مصنفة: {n(statement.data.unclassifiedInventoryIssueCount)}</p>
        <p>قيود تسوية معتمدة: {n(statement.data.journalAdjustments.postedCount)}</p>
        <p>قيود تسوية مسودة: {n(statement.data.journalAdjustments.draftCount)}</p>
      </div>
    </div>:null}
    <div className="mt-5 border-t border-white/10 pt-4">
      <h3 className="text-sm font-bold text-white">أدلة المراجعة والإقفال الشهري</h3>
      <p className="mt-1 text-xs text-slate-400">
        لا يكتمل الإقفال دون أدلة لكل مصدر محاسبي، وتوقيع مستخدم ثانٍ،
        وتصفير المسودات والفواتير غير المكتملة. الإقفال لا يساوي شهادة تدقيق خارجي.
      </p>
      {review.isError?<p role="alert" className="mt-2 text-xs text-rose-200">
        تعذر التحقق من حالة الإقفال؛ لا تسمح بإجراءات تعتمد على نتيجة غير مكتملة.
      </p>:null}
      {review.data&&!review.isError?<div className="mt-3 rounded-lg border border-white/10 p-3">
        <p className="text-sm font-semibold text-white">
          الحالة: {review.data.status==="locked"?"مقفلة":review.data.status==="draft"?"مراجعة مسودة":"لم تُجهز المراجعة"}
        </p>
        {review.data.driftDetected?<p role="alert" className="mt-2 text-xs text-rose-200">
          تغيّرت مصادر البيانات بعد الإقفال، ويجب معالجة الانحراف قبل الاعتماد على اللقطة.
        </p>:null}
        {review.data.status==="draft"?<p className="mt-1 text-xs text-amber-200">
          أعد المراجعة مستخدم #{review.data.preparedByUserId}، ويلزم اعتماد مستخدم آخر.
        </p>:null}
      </div>:null}
      {!locked&&!review.isError?<div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={busy} className="text-white"
          onClick={()=>{
            if(!showEvidence && review.data?.evidence){
              setEvidence({...emptyEvidence,...review.data.evidence});
            }
            setShowEvidence(v=>!v);
          }}>
          {showEvidence?"إخفاء مستندات المراجعة":"إعداد مستندات الإقفال"}
        </Button>
        <Button size="sm" variant="outline" disabled={busy || review.data?.status!=="draft"} className="text-white"
          onClick={()=>void signoff()}>اعتماد وإقفال المراجعة</Button>
      </div>:null}
      {showEvidence&&!locked?<div className="mt-3 grid gap-3 rounded-lg border border-white/10 p-3">
        {evidenceLabels.map(({key,label})=><label className="text-xs text-slate-300" key={key}>
          {label}
          <Input className="mt-1 border-white/20 bg-[#0D1117] text-white"
            placeholder="ملخص الفحص ورقم المستند أو مرجع التسوية"
            maxLength={1000} value={evidence[key]}
            onChange={e=>setEvidence(current=>({...current,[key]:e.target.value}))}/>
        </label>)}
        <Button size="sm" disabled={busy} onClick={()=>void submitEvidence()}>
          حفظ أدلة المراجعة
        </Button>
      </div>:null}
    </div>
    <div className="mt-5 border-t border-white/10 pt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-bold text-white">سجل قيود التسوية</h3>
        <Button size="sm" variant="outline" className="border-white/20 text-white"
          disabled={busy || locked || review.isError} onClick={()=>setShowNew(v=>!v)}>
          {showNew?"إخفاء نموذج القيد":"إنشاء قيد تسوية"}
        </Button>
      </div>
      {showNew?<div className="mt-3 grid gap-3 rounded-lg border border-white/10 p-3">
        <label className="text-xs text-slate-300">نوع القيد
          <select className="mt-1 w-full rounded-md border border-white/20 bg-[#0D1117] p-2 text-white"
            value={selectedPair} onChange={e=>{setSelectedPair(e.target.value);setRequestKey(null);}}>
            {pairs.map((v,i)=><option key={v.label} value={String(i)}>{v.label}</option>)}
          </select>
        </label>
        <p className="text-xs text-slate-400">{pairs[Number(selectedPair)]?.description}</p>
        <label className="text-xs text-slate-300">المبلغ بالشيكل
          <Input type="number" min="0.01" step="0.01" value={amount}
            onChange={e=>{setAmount(e.target.value);setRequestKey(null);}}
            className="mt-1 border-white/20 bg-[#0D1117] text-white" placeholder="0.00"/>
        </label>
        <label className="text-xs text-slate-300">سبب القيد والمستند المرجعي
          <Input value={reason} maxLength={1000}
            onChange={e=>{setReason(e.target.value);setRequestKey(null);}}
            className="mt-1 border-white/20 bg-[#0D1117] text-white" placeholder="وصف التسوية ورقم المستند"/>
        </label>
        <p className="text-xs text-amber-200">كل قيد متوازن تلقائياً (مدين = دائن) ويُحفظ مسودة. لا يمكن لمُنشئه اعتماده.</p>
        <Button disabled={busy || locked || review.isError} size="sm" onClick={()=>void submit()}>حفظ مسودة القيد</Button>
      </div>:null}
      {journals.data&&!journals.isError?<div className="mt-3 space-y-2">
        {journals.data.map(item=><div key={item.id} className="rounded-lg border border-white/10 bg-[#0D1117] p-3">
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-white">
            <span>#{item.id} · {item.status==="posted"?"معتمد":item.status==="void"?"ملغى":"مسودة"} · {n(item.amount)} شيكل</span>
            <span>مدين {item.debitAccount} / دائن {item.creditAccount}</span>
          </div>
          <p className="mt-1 text-xs text-slate-300">{item.reason}</p>
          {item.reversal?<p className="mt-1 text-xs text-amber-200">
            قيد العكس #{item.reversal.id} في {item.reversal.period} ·
            {item.reversal.status==="posted"?" معتمد":item.reversal.status==="void"?" مسودة عكس ملغاة":" ينتظر الاعتماد"}
          </p>:null}
          {item.status==="void"?<p className="mt-1 text-xs text-rose-200">
            سبب الإلغاء: {item.voidReason??"غير متاح"}
          </p>:null}
          <p className="mt-1 text-xs text-slate-500">أنشأه مستخدم #{item.createdByUserId} ·
            {item.approvedByUserId===null?" ينتظر اعتماد مستخدم آخر":` اعتمده مستخدم #${item.approvedByUserId}`}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {item.status==="draft"?<Button size="sm" variant="outline" className="text-white"
              disabled={busy || locked || review.isError} onClick={()=>void approve(item.id)}>اعتماد القيد</Button>:null}
            {item.status==="draft"?<Button size="sm" variant="outline"
              className="text-rose-200" disabled={busy || locked || review.isError}
              onClick={()=>{
                setVoidTargetId(item.id);setReversalTargetId(null);setVoidReason("");
              }}>إلغاء المسودة</Button>:null}
            {item.status==="posted"&&!item.reversesJournalId&&!item.reversal?<Button size="sm" variant="outline"
              className="text-white" disabled={busy || review.isError} onClick={()=>{
                setReversalTargetId(item.id);setVoidTargetId(null);
                setReversalPeriod(period);setReversalReason("");
              }}>
              إعداد قيد عكس
            </Button>:null}
          </div>
          {voidTargetId===item.id?<div className="mt-3 rounded-lg border border-rose-400/30 p-3">
            <p className="text-xs text-rose-200">إلغاء مسودة القيد #{item.id} لا يحذف سجلها؛ يلزم ذكر السبب.</p>
            <label className="mt-2 block text-xs text-slate-300">سبب الإلغاء
              <Input value={voidReason} maxLength={1000}
                onChange={e=>setVoidReason(e.target.value)}
                className="mt-1 border-white/20 bg-[#0D1117] text-white"
                placeholder="سبب إلغاء المسودة ورقم المستند"/>
            </label>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" variant="outline" className="text-rose-200"
                disabled={busy || locked || review.isError}
                onClick={()=>void voidJournal(item.id)}>تأكيد إلغاء هذه المسودة</Button>
              <Button size="sm" variant="ghost" disabled={busy}
                onClick={()=>setVoidTargetId(null)}>تراجع</Button>
            </div>
          </div>:null}
          {reversalTargetId===item.id?<div className="mt-3 rounded-lg border border-amber-400/30 p-3">
            <p className="text-xs text-amber-200">
              سيُنشأ قيد مدين/دائن معاكس للقيد #{item.id} بقيمة {n(item.amount)} شيكل.
              يبقى مسودة حتى يعتمده مستخدم مخوّل آخر.
            </p>
            <label className="mt-2 block text-xs text-slate-300">شهر قيد العكس
              <Input type="month" value={reversalPeriod}
                onChange={e=>setReversalPeriod(e.target.value)}
                className="mt-1 border-white/20 bg-[#0D1117] text-white"/>
            </label>
            <label className="mt-2 block text-xs text-slate-300">سبب العكس والمستند
              <Input value={reversalReason} maxLength={1000}
                onChange={e=>setReversalReason(e.target.value)}
                className="mt-1 border-white/20 bg-[#0D1117] text-white"
                placeholder="مرجع التسوية وسبب تصحيح القيد"/>
            </label>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" variant="outline" className="text-white"
                disabled={busy || review.isError || (locked && reversalPeriod<=period)}
                onClick={()=>void createReversal(item.id)}>تأكيد إنشاء مسودة العكس</Button>
              <Button size="sm" variant="ghost" disabled={busy}
                onClick={()=>setReversalTargetId(null)}>تراجع</Button>
            </div>
          </div>:null}
        </div>)}
        {journals.data.length===0?<p className="text-xs text-slate-400">لا توجد قيود تسوية لهذا الشهر.</p>:null}
      </div>:null}
    </div>
  </section>;
}
