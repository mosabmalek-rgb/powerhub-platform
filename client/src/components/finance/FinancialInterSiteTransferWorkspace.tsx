import { useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";

type Evidence = Record<string, unknown>;
const object = (v: unknown): Evidence =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v as Evidence : {};
const validId = (v: unknown): number => {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
};
const amountText = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString("ar", {
    minimumFractionDigits: 0, maximumFractionDigits: 2,
  }) : "غير متاح";
};

/** B3.10 source creation and B3.8 independent GL review are separate actions. */
export default function FinancialInterSiteTransferWorkspace({
  siteId, period, active,
}: { siteId: number; period: string; active: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [toSiteId, setToSiteId] = useState(0);
  const [fromAccountId, setFromAccountId] = useState(0);
  const [toAccountId, setToAccountId] = useState(0);
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [reviewSourceId, setReviewSourceId] = useState(0);
  const [reviewConfirmed, setReviewConfirmed] = useState(false);
  const [notice, setNotice] = useState("");
  const [evidenceReference, setEvidenceReference] = useState("");
  const [draftSourceId, setDraftSourceId] = useState(0);
  const [draftConfirmed, setDraftConfirmed] = useState(false);
  const [approveEliminationId, setApproveEliminationId] = useState(0);
  const [approveConfirmed, setApproveConfirmed] = useState(false);
  const eliminationKey = useRef<string | null>(null);
  const operationKey = useRef<string | null>(null);
  const utils = trpc.useUtils();
  const enabled = active && expanded && siteId > 0;
  const sites = trpc.powerhub.sites.list.useQuery(undefined, {
    enabled, staleTime: 60_000, refetchOnWindowFocus: false,
  });
  const fromAccounts = trpc.powerhub.companyAccounts.list.useQuery({
    siteId, branchId: siteId,
  }, { enabled, staleTime: 30_000, refetchOnWindowFocus: false });
  const toAccounts = trpc.powerhub.companyAccounts.list.useQuery({
    siteId: toSiteId, branchId: toSiteId,
  }, { enabled: enabled && toSiteId > 0, staleTime: 30_000, refetchOnWindowFocus: false });
  const rollup = trpc.powerhub.reports.financialGLTenantRollup.useQuery({
    siteId, period,
  }, { enabled, staleTime: 0, refetchOnWindowFocus: false });
  const origin = sites.data?.find(x => x.id === siteId);
  const destinationOptions = (sites.data ?? []).filter(x =>
    x.id !== siteId && x.status === "active" && x.tenantId === origin?.tenantId);
  const exclusive = (accounts: typeof fromAccounts.data, targetId: number) =>
    (accounts ?? []).filter(x => x.linkedSites.length === 1
      && x.linkedSites[0]?.siteId === targetId && x.isActive);
  const sendableAccounts = exclusive(fromAccounts.data, siteId);
  const receivingAccounts = exclusive(toAccounts.data, toSiteId);
  const amountValue = Number(amount);
  const canCreate = enabled && !sites.isLoading && !sites.isError
    && !fromAccounts.isLoading && !fromAccounts.isFetching && !fromAccounts.isError
    && !toAccounts.isLoading && !toAccounts.isFetching && !toAccounts.isError
    && destinationOptions.some(x => x.id === toSiteId)
    && sendableAccounts.some(x => x.id === fromAccountId)
    && receivingAccounts.some(x => x.id === toAccountId)
    && fromAccountId !== toAccountId && amount.trim() !== ""
    && Number.isFinite(amountValue) && amountValue > 0 && amountValue <= 100_000_000
    && Math.round(amountValue * 100) / 100 === amountValue
    && description.trim().length >= 2 && description.trim().length <= 255
    && confirmed;
  const invalidate = async () => {
    await Promise.all([
      utils.powerhub.reports.financialGLTenantRollup.invalidate(),
      utils.powerhub.companyAccounts.list.invalidate(),
      utils.powerhub.reports.financialGLSubledgerReconciliation.invalidate(),
    ]);
  };
  const create = trpc.powerhub.reports.financialGLCreateInterSiteTransfer.useMutation({
    onSuccess: async (data) => {
      const item = object(data);
      setNotice(`تم حفظ مصدر التحويل رقم ${String(item.sourceId ?? "")}، وهو بانتظار مراجع مستقل لترحيل قيدي GL.`);
      setConfirmed(false);
      operationKey.current = null;
      await invalidate();
    },
    onError: () => setNotice(""),
  });
  const post = trpc.powerhub.reports.financialGLPostInterSiteTransfer.useMutation({
    onSuccess: async (data) => {
      const item = object(data);
      setReviewSourceId(0);setReviewConfirmed(false);
      setNotice(item.alreadyPosted === true
        ? "القيدان موجودان مسبقًا وتطابقا؛ لم يُنشأ قيد مكرر."
        : "تم ترحيل قيدين متقابلين إلى GL. ما زال اعتماد الاستبعاد النهائي مستقلًا.");
      await invalidate();
    },
    onError: () => setNotice(""),
  });
  const prepareElimination = trpc.powerhub.reports.financialGLPrepareInterSiteElimination.useMutation({
    onSuccess: async (result) => {
      const v = object(result);
      setNotice(`تم حفظ مسودة الاستبعاد رقم ${String(v.eliminationId ?? "")}. يتطلب اعتمادها مستخدمًا آخر.`);
      setDraftConfirmed(false);
      setDraftSourceId(0);
      eliminationKey.current = null;
      await invalidate();
    },
    onError: () => setNotice(""),
  });
  const approveElimination = trpc.powerhub.reports.financialGLApproveInterSiteElimination.useMutation({
    onSuccess: async (result) => {
      const v = object(result);
      setNotice(v.alreadyApproved === true
        ? "التسوية معتمدة مسبقًا، ولم تُكرر قيود الاستبعاد."
        : "تم اعتماد قيدَي الاستبعاد خارج دفاتر الفروع. القوائم المالية ما زالت غير مصدقة.");
      setApproveEliminationId(0);
      setApproveConfirmed(false);
      await invalidate();
    },
    onError: () => setNotice(""),
  });
  const proof = object(object(rollup.data).interSiteGLProof);
  const ready = enabled && !rollup.isLoading && !rollup.isFetching
    && !rollup.isError && object(rollup.data).accountingCertification === "NOT_CERTIFIED"
    && proof.accountingCertification === "NOT_CERTIFIED"
    && proof.isConsolidatedFinancialStatements === false;
  const candidates = ready && Array.isArray(proof.mismatchExamples)
    ? proof.mismatchExamples.map(object).filter(x =>
       x.reason === "SOURCE_UNPOSTED_GL"
       && validId(x.fromSiteId) === siteId && validId(x.sourceId) > 0)
    : [];
  const matched = ready && Array.isArray(proof.matchedSources)
    ? proof.matchedSources.map(object).filter(x =>
      validId(x.fromSiteId)===siteId && validId(x.sourceId)>0)
    : [];
  const inputStyle = "w-full rounded border border-white/25 bg-slate-900 px-2 py-2 text-sm text-white";
  const resetSelection = () => { setConfirmed(false);operationKey.current=null;setNotice(""); };
  return <section dir="rtl" className="mt-3 rounded-md border border-white/15 p-3 text-sm text-slate-200">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div>
        <h4 className="font-semibold text-white">B3 — تحويل الحسابات بين فرعين والمراجعة المستقلة</h4>
        <p className="mt-1 text-xs text-slate-400">
          ينشئ المُعدّ حركتَي التحويل من مصدر موثق، ثم يرحّل مراجع آخر قيدي GL.
          لا ينتج اعتمادًا ماليًا أو قيد استبعاد تلقائيًا.
        </p>
      </div>
      <Button type="button" size="sm" variant="outline"
        onClick={() => {setExpanded(v=>!v);setNotice("");setReviewSourceId(0);setReviewConfirmed(false);}}>
        {expanded ? "إخفاء" : "عرض تحويلات الفروع"}
      </Button>
    </div>
    {expanded ? <div className="mt-3 space-y-3">
      {sites.isLoading || fromAccounts.isLoading
        ? <p role="status">جارٍ التحقق من الفروع والحسابات المتاحة...</p> : null}
      {sites.isError || fromAccounts.isError || toAccounts.isError
        ? <p role="alert" className="text-rose-200">تعذر التحقق من الحسابات والصلاحيات؛ لن يُسمح بالتحويل.</p> : null}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <label>الفرع المستفيد
          <select className={inputStyle} value={toSiteId} onChange={e=>{
            setToSiteId(Number(e.target.value));setToAccountId(0);resetSelection();
          }}>
            <option value={0}>اختر الفرع الآخر</option>
            {destinationOptions.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </label>
        <label>حساب الإرسال في الفرع الحالي
          <select className={inputStyle} value={fromAccountId} onChange={e=>{
            setFromAccountId(Number(e.target.value));resetSelection();
          }}>
            <option value={0}>اختر الحساب</option>
            {sendableAccounts.map(x=><option key={x.id} value={x.id}>{x.name} — الرصيد {amountText(x.balance)}</option>)}
          </select>
        </label>
        <label>حساب الاستقبال في الفرع المستفيد
          <select className={inputStyle} value={toAccountId} onChange={e=>{
            setToAccountId(Number(e.target.value));resetSelection();
          }}>
            <option value={0}>اختر الحساب</option>
            {receivingAccounts.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </label>
        <label>المبلغ (شيكل)
          <input className={inputStyle} inputMode="decimal" type="number" min="0.01" step="0.01"
            value={amount} onChange={e=>{setAmount(e.target.value);resetSelection();}} />
        </label>
        <label className="md:col-span-2">وصف/سبب التحويل
          <input className={inputStyle} maxLength={255} value={description}
            onChange={e=>{setDescription(e.target.value);resetSelection();}}
            placeholder="مرجع التحويل وسببه" />
        </label>
      </div>
      <label className="flex items-start gap-2 text-xs">
        <input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)} />
        تحققت من حسابَي الفرعين والرصيد والمبلغ. أفهم أن العملية تحفظ حركات مالية أصلية
        وتتطلب مراجعة GL مستقلة، ولا تنشئ تسوية موحدة معتمدة.
      </label>
      <Button size="sm" disabled={!canCreate || create.isPending || post.isPending}
        onClick={() => {
          const key=operationKey.current ?? crypto.randomUUID();
          operationKey.current=key;
          create.mutate({fromSiteId:siteId,toSiteId,fromAccountId,toAccountId,
            amount:amountValue,description:description.trim(),operationKey:key,
            confirmTransfer:true});
        }}>{create.isPending ? "جارٍ حفظ التحويل…" : "حفظ التحويل للمراجعة"}</Button>
      {create.isError ? <p role="alert" className="text-rose-200">
        لم يؤكد الخادم إنشاء التحويل. أعد المحاولة بالمفتاح نفسه دون إنشاء عملية جديدة.
      </p> : null}
      <div className="border-t border-white/15 pt-3 space-y-2">
        <h5 className="font-semibold text-white">تحويلات تنتظر مراجعة قيدي GL</h5>
        {rollup.isFetching ? <p role="status">جارٍ تحديث تدقيق مصادر الفروع…</p> : null}
        {rollup.isError ? <p role="alert" className="text-rose-200">
          فشل التدقيق. حُجبت إجراءات الترحيل على النتائج غير المؤكدة.
        </p> : null}
        {ready && candidates.length===0 ? <p className="text-xs">لا توجد تحويلات معلقة لهذا الفرع ضمن أول 20 حالة معلّقة/غير صالحة.</p> : null}
        {ready ? candidates.map(item=><div key={validId(item.sourceId)}
          className="rounded border border-white/10 p-2 space-y-2">
          <p>مصدر رقم {validId(item.sourceId)}، إلى فرع {validId(item.toSiteId)}، المبلغ {amountText(item.amount)} شيكل</p>
          {reviewSourceId===validId(item.sourceId) ? <>
            <label className="flex items-start gap-2 text-xs">
              <input type="checkbox" checked={reviewConfirmed} onChange={e=>setReviewConfirmed(e.target.checked)} />
              راجعت مصدر التحويل وحسابَي الفرعين وأوافق على ترحيل قيدين غير قابلين للحذف
              دون اعتماد قيد الاستبعاد أو القوائم المالية.
            </label>
            <Button size="sm" disabled={!reviewConfirmed||post.isPending||create.isPending}
              onClick={()=>post.mutate({fromSiteId:siteId,sourceId:validId(item.sourceId),
                confirmSourceReview:true})}>
              {post.isPending ? "جارٍ الترحيل…" : "اعتماد الترحيل المزدوج"}
            </Button>
          </> : <Button size="sm" variant="outline" disabled={post.isPending||create.isPending}
            onClick={()=>{setReviewSourceId(validId(item.sourceId));setReviewConfirmed(false);setNotice("");}}>
            مراجعة التحويل وترحيله
          </Button>}
        </div>) : null}
        {post.isError ? <p role="alert" className="text-rose-200">
          رفض الخادم ترحيل GL؛ تحقق من المراجع المستقل وصلاحيات الفرعين وبصمة المصدر.
        </p> : null}
      </div>
      <div className="border-t border-white/15 pt-3 space-y-3">
        <h5 className="font-semibold text-white">B3.11 — إعداد واعتماد الاستبعاد بين الفروع</h5>
        <p className="text-xs text-amber-200">
          تظهر القيود المزدوجة المتطابقة هنا. يُنشئ المُعدّ مسودة استبعاد متوازنة
          ويعتمدها مستخدم آخر مخوّل في الفرعين. لا تُعد قوائم موحدة نهائية.
        </p>
        {ready ? matched.map(x=><div key={validId(x.sourceId)}
          className="rounded border border-white/10 p-2 space-y-2">
          <p>تحويل رقم {validId(x.sourceId)} — {amountText(x.amount)} شيكل
            — حالة الاستبعاد: {String(x.eliminationStatus ?? "غير مُعدّ")}</p>
          {x.eliminationStatus==="not_prepared" ? <>
            {draftSourceId===validId(x.sourceId) ? <>
              <label>مرجع المستند
                <input className={inputStyle} value={evidenceReference}
                  maxLength={250} onChange={e=>{
                    setEvidenceReference(e.target.value);eliminationKey.current=null;
                    setDraftConfirmed(false);
                  }} placeholder="مرجع دليل التسوية المستقل" />
              </label>
              <label className="flex items-start gap-2 text-xs">
                <input type="checkbox" checked={draftConfirmed}
                  onChange={e=>setDraftConfirmed(e.target.checked)} />
                تحققت من طرفَي GL ومرجع التسوية. المسودة لا تعتمد القوائم المالية.
              </label>
              <Button size="sm" disabled={!draftConfirmed
                ||evidenceReference.trim().length<8||prepareElimination.isPending}
                onClick={()=>{
                  const key=eliminationKey.current??crypto.randomUUID();
                  eliminationKey.current=key;
                  prepareElimination.mutate({
                    fromSiteId:siteId,sourceId:validId(x.sourceId),
                    evidenceReference:evidenceReference.trim(),
                    operationKey:key,confirmEvidence:true,
                  });
                }}>حفظ مسودة الاستبعاد</Button>
            </> : <Button size="sm" variant="outline"
              disabled={prepareElimination.isPending}
              onClick={()=>{setDraftSourceId(validId(x.sourceId));
                setDraftConfirmed(false);setNotice("");}}>
              إعداد تسوية</Button>}
          </> : null}
          {x.eliminationStatus==="draft" && validId(x.eliminationId)>0 ? <>
            {approveEliminationId===validId(x.eliminationId) ? <>
              <label className="flex items-start gap-2 text-xs">
                <input type="checkbox" checked={approveConfirmed}
                  onChange={e=>setApproveConfirmed(e.target.checked)} />
                راجعت قيدَي الاستبعاد ومصدرهما كمستخدم مستقل عن مُعدّ المسودة.
              </label>
              <Button size="sm" disabled={!approveConfirmed||approveElimination.isPending}
                onClick={()=>approveElimination.mutate({
                  fromSiteId:siteId,eliminationId:validId(x.eliminationId),
                  confirmIndependentReview:true,
                })}>اعتماد تسوية الاستبعاد</Button>
            </> : <Button size="sm" variant="outline"
              onClick={()=>{setApproveEliminationId(validId(x.eliminationId));
                setApproveConfirmed(false);setNotice("");}}>
              مراجعة واعتماد</Button>}
          </> : null}
          {x.eliminationStatus==="approved" ? <p className="text-xs text-amber-200">
            تمت مراجعة الاستبعاد. لا يزال اعتماد القوائم الموحدة منفصلًا.
          </p> : null}
        </div>) : null}
        {prepareElimination.isError||approveElimination.isError
          ? <p role="alert" className="text-rose-200">
            رفض الخادم إعداد التسوية أو اعتمادها. لن تُعرض نتيجة نجاح غير مؤكدة.
          </p> : null}
      </div>
      {notice ? <p role="status" className="text-amber-200">{notice}</p> : null}
      <p className="text-xs text-amber-200">
        هذا مسار ما قبل الإطلاق. تطابق قيدي مستحق من/مستحق لفرع لا يعني
        إصدار قوائم موحدة، أو اكتمال قيد الاستبعاد المحاسبي المستقل.
      </p>
    </div> : null}
  </section>;
}
