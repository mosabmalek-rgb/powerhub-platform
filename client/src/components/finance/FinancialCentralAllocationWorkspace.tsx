import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";

// Convert percentages into exact basis points. No rounding of user input
// beyond two decimal digits, and no silent acceptance of 99.99%.
const toBasisPoints = (value: string): number | null => {
  const normalized = value.trim();
  if (!/^(?:100(?:\.0{1,2})?|(?:0|[1-9]\d?)(?:\.\d{1,2})?)$/.test(normalized)) return null;
  const points = Number(normalized) * 100;
  return Number.isSafeInteger(Math.round(points)) ? Math.round(points) : null;
};
const displayMoney = (value: unknown) => {
  if (value === null || value === undefined || value === "") return "غير متاح";
  const n = Number(value);
  return Number.isFinite(n)
    ? n.toLocaleString("ar", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : "غير متاح";
};
const newOperationKey = () =>
  `b2-central-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;

export default function FinancialCentralAllocationWorkspace({
  siteId, period, active,
}: { siteId: number; period: string; active: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [selectedSources, setSelectedSources] = useState<number[]>([]);
  const [percentages, setPercentages] = useState<Record<number, string>>({});
  const [evidence, setEvidence] = useState("");
  const [preparedAcknowledged, setPreparedAcknowledged] = useState(false);
  const [reviewAcknowledged, setReviewAcknowledged] = useState(false);
  // Stable across retries of a possibly committed request; the database
  // additionally enforces one immutable policy per tenant and period.
  const [operationKey] = useState(newOperationKey);
  const enabled = active && expanded && siteId > 0
    && /^\d{4}-(0[1-9]|1[0-2])$/.test(period);
  const utils = trpc.useUtils();
  const workspace = trpc.powerhub.reports.financialGLCentralPolicyWorkspace.useQuery(
    { centralSiteId: siteId, period }, {
      enabled, staleTime: 0, refetchOnWindowFocus: false,
      refetchOnReconnect: true,
    },
  );
  const policy = workspace.data?.policy ?? null;
  const approvalActive = policy?.status === "approved" && enabled;
  const preview = trpc.powerhub.reports.financialGLCentralPolicyPreview.useQuery(
    { siteId, centralSiteId: siteId, period }, {
      enabled: approvalActive, staleTime: 0,
      refetchOnWindowFocus: false, refetchOnReconnect: true,
    },
  );
  const refreshOnMutation = () => {
    setPreparedAcknowledged(false);
    setReviewAcknowledged(false);
    void workspace.refetch();
    void utils.powerhub.reports.financialGLCentralPolicyPreview.invalidate();
  };
  const prepare = trpc.powerhub.reports.financialGLCentralPolicyPrepare.useMutation({
    onSuccess: refreshOnMutation,
    // An ambiguous network failure may have committed; refetch first.
    onError: () => { void workspace.refetch(); },
  });
  const approve = trpc.powerhub.reports.financialGLCentralPolicyApprove.useMutation({
    onSuccess: refreshOnMutation,
    onError: () => { void workspace.refetch(); },
  });
  const sites = workspace.data?.sites ?? [];
  const selectedWeights = sites.flatMap((site) => {
    const raw = percentages[site.id] ?? "";
    const points = toBasisPoints(raw);
    return points !== null && points > 0 ? [{ siteId: site.id, basisPoints: points }] : [];
  });
  const totalPoints = selectedWeights.reduce((sum, item) => sum + item.basisPoints, 0);
  const invalidPercent = Object.values(percentages).some(
    (raw) => raw.trim() !== "" && toBasisPoints(raw) === null,
  );
  const isReady = Boolean(workspace.data && !workspace.isLoading && !workspace.isFetching && !workspace.isError);
  const mayPrepare = isReady && !policy && !workspace.data?.sourceCandidatesTruncated && !invalidPercent && totalPoints === 10000
    && selectedWeights.length >= 2 && selectedSources.length >= 1
    && evidence.trim().length >= 8 && evidence.trim().length <= 250
    && preparedAcknowledged && !prepare.isPending;
  const canApprove = isReady && policy?.status === "draft"
    && workspace.data?.canApprove === true && reviewAcknowledged && !approve.isPending;
  const onPrepare = () => {
    if (!mayPrepare) return;
    prepare.mutate({
      centralSiteId: siteId, period,
      sourceEntryIds: [...selectedSources].sort((a, b) => a - b),
      weights: selectedWeights.sort((a, b) => a.siteId - b.siteId),
      evidenceReference: evidence.trim(), operationKey,
    });
  };
  const onApprove = () => {
    if (!canApprove || !policy) return;
    approve.mutate({ centralSiteId: siteId, policyId: policy.id });
  };

  return <section className="mt-3 rounded-md border border-white/10 p-3 text-sm text-slate-200"
    aria-label="سياسة توزيع المصروفات المركزية" dir="rtl">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div>
        <h4 className="font-semibold text-white">B2 — توزيع المصروفات المركزية بين الفروع</h4>
        <p className="mt-1 text-xs text-slate-400">إجراء إداري بمستند ومراجعة مستقلة؛ لا ينشئ قيد GL ولا يعتمد الأرباح النهائية.</p>
      </div>
      <Button size="sm" variant="outline" disabled={!active || siteId <= 0}
        onClick={() => setExpanded(v => !v)}>
        {expanded ? "إخفاء إدارة التوزيع" : "إدارة سياسة التوزيع"}
      </Button>
    </div>
    {expanded ? <div className="mt-3 space-y-3">
      {workspace.isLoading || workspace.isFetching
        ? <p role="status">جارٍ التحقق من الصلاحيات والسياسة والمصروفات...</p> : null}
      {workspace.isError
        ? <div role="alert" className="space-y-2 text-rose-200">
            <p>لا يمكن فتح إدارة التوزيع: يلزم إذن إدارة المصروفات وعرض تقارير جميع الفروع المشمولة، أو قد تكون البيانات غير متاحة.</p>
            <Button size="sm" variant="outline" onClick={() => void workspace.refetch()}>إعادة التحقق</Button>
          </div> : null}
      {isReady && policy ? <div className="space-y-3 rounded-md border border-white/10 p-3">
        <p className="font-semibold">{policy.status === "draft"
          ? "مسودة توزيع — بانتظار مراجعة مستقلة" : "سياسة توزيع إدارية معتمدة"}</p>
        <p>رقم السياسة: {policy.id} · الفترة: {period} · مصدر التكلفة: الفرع {siteId}</p>
        <p>مرجع المستند: {policy.evidenceReference}</p>
        <p>القيود المختارة: {policy.sourceEntryIds.join("، ")}</p>
        <p>إجمالي المصروف المصدر: {displayMoney(policy.centralCostPool)}</p>
        <div className="space-y-1">
          <p className="font-semibold text-white">حصص الفروع</p>
          {policy.weights.map((weight) => <p key={weight.siteId}>
            {sites.find(s => s.id === weight.siteId)?.name ?? `الفرع ${weight.siteId}`}:
            {" "}{(weight.basisPoints / 100).toFixed(2)}%
          </p>)}
        </div>
        <p className="text-xs text-slate-400">المُعدّ: حساب {policy.preparedBy}.
          {policy.approvedBy ? ` المعتمد: حساب ${policy.approvedBy}.` : ""}
        </p>
        {policy.status === "draft" && workspace.data?.canApprove === false
          ? <p className="text-amber-200">يجب أن يراجع السياسة حساب مخوّل آخر؛ لا يُقبل اعتماد المُعدّ لنفسه.</p> : null}
        {policy.status === "draft" && workspace.data?.canApprove === true ? <>
          <label className="flex items-start gap-2 text-xs">
            <input type="checkbox" checked={reviewAcknowledged}
              onChange={e => setReviewAcknowledged(e.target.checked)} />
            <span>راجعتُ مستند التكلفة ومصادر GL وأوزان الفروع، وأفهم أن هذا اعتماد للتوزيع الإداري فقط، وليس اعتمادًا للأرباح أو القوائم المالية.</span>
          </label>
          <Button size="sm" variant="outline" disabled={!canApprove} onClick={onApprove}>
            {approve.isPending ? "جارٍ اعتماد السياسة والتحقق..." : "اعتماد سياسة التوزيع الإداري"}
          </Button>
        </> : null}
        {policy.status === "approved" ? <>
          {preview.isLoading || preview.isFetching
            ? <p role="status">جارٍ احتساب نتيجة السياسة المعتمدة...</p> : null}
          {preview.isError
            ? <p role="alert" className="text-rose-200">تعذر مطابقة السياسة مع قيود GL الحالية؛ لن تُعرض نتيجة متقادمة.</p> : null}
          {!preview.isLoading && !preview.isFetching && !preview.isError
            && preview.data?.status === "MANAGEMENT_ALLOCATION_APPROVED" ? <div className="rounded-md border border-white/10 p-3">
            <p>حصة هذا الفرع: {displayMoney(preview.data.allocatedCost)}</p>
            <p>النتيجة الإدارية بعد التوزيع: {displayMoney(preview.data.managerialResult)}</p>
            <p className="mt-1 text-xs text-amber-200">مؤشر إداري غير معتمد. لا تنشأ قيود جديدة أو ازدواج في المصروف.</p>
          </div> : null}
        </> : null}
      </div> : null}
      {isReady && !policy ? <div className="space-y-3">
        <p>لا توجد سياسة توزيع محفوظة لهذه الفترة. يمكن إعداد مسودة واحدة مع مستند مصدر واضح.</p>
        <div className="rounded-md border border-white/10 p-3">
          <p className="font-semibold text-white">1. اختيار قيود المصروف المركزي من GL</p>
          {workspace.data?.sourceCandidatesTruncated ? <p className="mt-1 text-amber-200">
            توجد أكثر من 100 حركة؛ المعروض أول 100 فقط. لا تعتمد توزيعًا قبل مراجعة المصادر الناقصة.
          </p> : null}
          {workspace.data?.sourceCandidates.length === 0
            ? <p className="mt-2 text-amber-200">لا توجد قيود مصروف مرشحة لهذه الفترة في الفرع المحدد.</p> : null}
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {workspace.data?.sourceCandidates.map(source => <label key={source.id}
              className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={selectedSources.includes(source.id)}
                onChange={e => {
                  setSelectedSources(current => e.target.checked
                    ? [...current, source.id] : current.filter(id => id !== source.id));
                  setPreparedAcknowledged(false);
                }} />
              <span>قيد GL رقم {source.id} · مصروف مصدر {source.sourceId}</span>
            </label>)}
          </div>
        </div>
        <div className="rounded-md border border-white/10 p-3">
          <p className="font-semibold text-white">2. نسب التوزيع لكل فرع</p>
          <p className="mt-1 text-xs text-slate-400">أدخل النسبة المئوية بحد أقصى منزلتين عشريتين. مجموع الفروع المختارة يجب أن يساوي 100%.</p>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {sites.map(site => <label key={site.id} className="block text-xs">
              <span className="mb-1 block">{site.name} (#{site.id})</span>
              <input type="text" inputMode="decimal" placeholder="0.00" dir="ltr"
                aria-label={`نسبة الفرع ${site.name}`}
                className="w-full rounded-md border border-white/20 bg-transparent px-2 py-2 text-white"
                value={percentages[site.id] ?? ""} onChange={e => {
                  setPercentages(current => ({ ...current, [site.id]: e.target.value }));
                  setPreparedAcknowledged(false);
                }} />
            </label>)}
          </div>
          <p className={invalidPercent || totalPoints !== 10000
            ? "mt-2 text-amber-200" : "mt-2 text-emerald-200"}>
            مجموع النسب المختارة: {(totalPoints / 100).toFixed(2)}%.
            {invalidPercent ? " توجد نسبة غير صالحة." : ""}
          </p>
        </div>
        <label className="block text-xs">
          <span className="mb-1 block">3. مرجع المستند الداعم للتوزيع</span>
          <input type="text" maxLength={250} value={evidence}
            onChange={e => { setEvidence(e.target.value); setPreparedAcknowledged(false); }}
            placeholder="رقم المستند أو رابط سجل التكلفة المعتمد للمراجعة"
            className="w-full rounded-md border border-white/20 bg-transparent px-2 py-2 text-white" />
        </label>
        <label className="flex items-start gap-2 text-xs">
          <input type="checkbox" checked={preparedAcknowledged}
            onChange={e => setPreparedAcknowledged(e.target.checked)} />
          <span>أقرّ أن المصادر المختارة مصروفات مركزية فعلية قابلة للتوزيع، وأن النسب ومرجع المستند صحيحان. أفهم أن الإعداد ينشئ مسودة فقط ولا يعتمدها.</span>
        </label>
        <Button size="sm" variant="outline" disabled={!mayPrepare}
          onClick={onPrepare}>
          {prepare.isPending ? "جارٍ حفظ المسودة والتحقق..." : "إعداد مسودة سياسة التوزيع"}
        </Button>
        <p className="text-xs text-slate-400">إذا انقطع الاتصال بعد الإرسال، أعد التحقق قبل تعديل المدخلات؛ تتم حماية العملية بمفتاح ثابت ومنع التكرار.</p>
      </div> : null}
      {prepare.isError ? <p role="alert" className="text-rose-200">
        تعذر تأكيد إعداد المسودة. قد يكون الطلب نُفذ قبل انقطاع الاتصال؛ تحقق من الحالة ثم أعد المحاولة بالبيانات نفسها.
      </p> : null}
      {approve.isError ? <p role="alert" className="text-rose-200">
        لم يتم تأكيد اعتماد السياسة. تحقّق من حالة المراجعة قبل إعادة المحاولة.
      </p> : null}
    </div> : null}
  </section>;
}
