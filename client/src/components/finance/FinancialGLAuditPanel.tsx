import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Loader2, RefreshCw } from "lucide-react";
import FinancialOpeningEvidenceWorkspace from "./FinancialOpeningEvidenceWorkspace";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
const numeric = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
};
const numberText = (value: unknown) => {
  const n = numeric(value);
  return n === null ? "غير متاح" : n.toLocaleString("ar");
};
const accountingBlockers = (raw: unknown): string[] => {
  const coverage = object(raw);
  const opening = object(coverage.openingEvidenceAudit);
  const integrity = object(coverage.sourceIntegrity);
  const sources = object(coverage.sources);
  const historical = object(sources.priorOperationalSources);
  const problems: string[] = [];
  if (coverage.isOpeningStructurallyPosted !== true) {
    problems.push("لا توجد افتتاحية محاسبية منشورة ومتحقق من سلامتها البنيوية.");
  }
  if (coverage.isOpeningReconciled !== true ||
      opening.accountBalancesMatchedToOpening !== true ||
      opening.sourceSubledgersIndependentlyVerified !== true) {
    problems.push("لم تثبت مطابقة الافتتاحية مع الأرصدة والدفاتر المساعدة بأدلة مستقلة.");
  }
  const unresolved = numeric(coverage.unreconciledSourceCount);
  if (unresolved === null) {
    problems.push("تعذر قراءة إجمالي المصادر غير المسوّاة بدقة؛ لا يُعتمد التقرير.");
  } else if (unresolved > 0) {
    problems.push(`يوجد ${numberText(unresolved)} مصدر أو حركة غير مسوّاة في الفترة وتاريخها السابق.`);
  }
  if (integrity.isClean !== true) {
    problems.push("توجد قيود لا تجتاز تدقيق بصمة المصدر أو سطور القيد.");
  }
  const current = object(sources.companyAccountMovements);
  const tagged = (numeric(historical.performanceFixtureTagged) ?? 0)
    + (numeric(current.performanceFixtureTagged) ?? 0);
  const quarantined = (numeric(historical.quarantinedTestMovements) ?? 0)
    + (numeric(current.quarantinedTestMovements) ?? 0);
  const historicalAudit = object(historical.fixtureQuarantine);
  const currentAudit = object(current.fixtureQuarantine);
  const independentlyQualified = historicalAudit.verified === true || currentAudit.verified === true;
  if (tagged > 0 && (!independentlyQualified || tagged !== quarantined)) {
    problems.push(`يوجد ${numberText(tagged)} حركة موسومة لاختبارات الأداء دون فصل مكتمل ومتحقق؛ لا يجوز تجاهلها ضمن الأرباح.`);
  }
  if (coverage.accountingCertification !== "CERTIFIED") {
    problems.push("لم تصدر شهادة اعتماد محاسبي نهائي من النظام.");
  }
  return problems;
};

export default function FinancialGLAuditPanel({
  siteId, period, active,
}: { siteId: number; period: string; active: boolean }) {
  const [showTrial, setShowTrial] = useState(false);
  const [reviewAcknowledged, setReviewAcknowledged] = useState(false);
  const fixtureEnabled = active && siteId === 1
    && import.meta.env.VITE_SUPABASE_URL?.replace(/\/$/,"") === "https://iyuryuhaylhisjfcrwkz.supabase.co";
  const fixture = trpc.powerhub.reports.financialGLFixtureStatus.useQuery({siteId}, {
    enabled:fixtureEnabled, staleTime:0, refetchOnWindowFocus:false,
  });
  const utils=trpc.useUtils();
  const prepareFixture = trpc.powerhub.reports.financialGLFixturePrepare.useMutation({
    onSuccess:async()=>{await fixture.refetch();await utils.powerhub.reports.financialGLSourceCoverage.invalidate();}
  });
  const reviewFixture = trpc.powerhub.reports.financialGLFixtureReview.useMutation({
    onSuccess:async()=>{
      setReviewAcknowledged(false);
      await fixture.refetch();
      await utils.powerhub.reports.financialGLSourceCoverage.invalidate();
      await utils.powerhub.reports.cashFlow.invalidate();
      await utils.powerhub.reports.cashFlowTrend.invalidate();
    },
  });
  const enabled = active && siteId > 0 && /^\d{4}-(0[1-9]|1[0-2])$/.test(period);
  const coverage = trpc.powerhub.reports.financialGLSourceCoverage.useQuery({ siteId, period }, {
    enabled, staleTime: 60_000, refetchOnWindowFocus: false, refetchOnReconnect: true,
  });
  // Even the trial balance is requested only on demand, not with every
  // navigation to the dashboard. Both queries fail closed on errors.
  const trial = trpc.powerhub.reports.financialGLTrialBalance.useQuery({ siteId, period }, {
    enabled: enabled && showTrial, staleTime: 60_000,
    refetchOnWindowFocus: false, refetchOnReconnect: true,
  });
  const [showB1, setShowB1] = useState(false);
  const statements = trpc.powerhub.reports.financialGLSiteStatements.useQuery({siteId,period},{
    enabled:enabled && showB1,staleTime:60_000,
    refetchOnWindowFocus:false,refetchOnReconnect:true,
  });
  const b1Visible = showB1 && !statements.isFetching && !statements.isLoading
    && !statements.isError && Boolean(statements.data);
  const b1 = b1Visible ? object(statements.data) : {};
  const b1Income = object(b1.incomeStatement);
  const b1Position = object(b1.balanceSheet);
  const b1Branch = object(b1.branchProfitability);
  const b1Amount = (value:unknown) => {
    const n = typeof value==="number" ? value : Number(value);
    return Number.isFinite(n) ? n.toLocaleString("ar",{minimumFractionDigits:2,maximumFractionDigits:2}) : "غير متاح";
  };
  const canShowCoverage = Boolean(coverage.data && !coverage.isError && !coverage.isFetching && !coverage.isLoading);
  const report = canShowCoverage ? object(coverage.data) : {};
  const integrity = object(report.sourceIntegrity);
  const sources = object(report.sources);
  const prior = object(sources.priorOperationalSources);
  const currentCash = object(sources.companyAccountMovements);
  const taggedFixtures = (numeric(prior.performanceFixtureTagged) ?? 0)
    + (numeric(currentCash.performanceFixtureTagged) ?? 0);
  const quarantinedFixtures = (numeric(prior.quarantinedTestMovements) ?? 0)
    + (numeric(currentCash.quarantinedTestMovements) ?? 0);
  const verifiedFixtureQuarantine = object(prior.fixtureQuarantine).verified === true
    || object(currentCash.fixtureQuarantine).verified === true;
  const opening = object(report.openingEvidenceAudit);
  const evidenceReview = object(opening.evidenceReview);
  const technicalAcceptance = object(report.technicalAcceptance);
  const engineeringAccepted = technicalAcceptance.status === "PASS_PRELAUNCH_ENGINEERING_ONLY"
    && technicalAcceptance.isEngineeringAccepted === true
    && technicalAcceptance.humanApproved === false
    && technicalAcceptance.accountingCertification === "NOT_CERTIFIED"
    && technicalAcceptance.isFinalFinancialAcceptance === false;
  const blockers = canShowCoverage ? accountingBlockers(report) : [];
  const canShowTrial = Boolean(trial.data && showTrial && !trial.isError && !trial.isFetching && !trial.isLoading);
  const trialData = canShowTrial ? object(trial.data) : {};

  return <section aria-label="تدقيق دفتر الأستاذ والتغطية المحاسبية" className="rounded-xl border border-white/10 bg-[#111823] p-4 sm:p-5" dir="rtl">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h3 className="font-bold text-white">تدقيق مصادر دفتر الأستاذ وميزان المراجعة</h3>
        <p className="mt-1 text-xs text-slate-400">الفرع {siteId} · الشهر {period} · يشمل المصادر التاريخية غير المرحلة. ليس تقرير أرباح نهائيًا.</p>
      </div>
      <Button size="sm" variant="outline" disabled={!enabled || coverage.isFetching}
        className="border-white/20 text-white" onClick={() => void coverage.refetch()}>
        <RefreshCw className="ml-1 h-4 w-4" /> تحديث التدقيق
      </Button>
    </div>
    {coverage.isFetching || coverage.isLoading
      ? <p role="status" className="mt-4 flex items-center gap-2 text-sm text-slate-300"><Loader2 className="h-4 w-4 animate-spin" /> جارٍ فحص جميع مصادر الفترة...</p> : null}
    {coverage.isError
      ? <p role="alert" className="mt-4 text-sm text-rose-200">تعذر إكمال تدقيق المصادر. لن تُعرض نتيجة مخزنة أو جزئية كأنها مقبولة.</p> : null}
    {canShowCoverage ? <>
      <div role="status" className="mt-4 rounded-md border border-amber-400/30 p-3 text-sm text-amber-100">
        <strong>الحالة: غير معتمدة محاسبيًا.</strong> توازن القيود لا يثبت مطابقة الافتتاحية ولا اكتمال المصادر.
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {([
          {label:"مصادر وحركات غير مسوّاة",value:report.unreconciledSourceCount},
          {label:"قيود دُققت بصماتها",value:integrity.checkedEntries},
          {label:"قيود بمصادر أو بصمات غير صحيحة",value:(numeric(integrity.invalidSources) ?? 0)+(numeric(integrity.driftedEntries) ?? 0)+(numeric(integrity.unauditedEntries) ?? 0)},
          {label:"حركات أداء اختبارية محددة",value:taggedFixtures},
        ] as const).map(item => <div key={item.label} className="rounded-md border border-white/10 p-3">
          <p className="text-xs text-slate-300">{item.label}</p>
          <strong className="mt-1 block text-xl text-white">{numberText(item.value)}</strong>
        </div>)}
      </div>
      {engineeringAccepted ? <div role="status" className="mt-3 rounded-md border border-white/20 p-3 text-sm text-slate-200">
        <h4 className="font-semibold text-white">القبول الهندسي لبيانات ما قبل الإطلاق — Staging</h4>
        <p className="mt-2 text-xs">
          تم حفظ {numberText(technicalAcceptance.postedGL)} قيد GL:
          {" "}{numberText(technicalAcceptance.operationalSources)} مصدرًا تشغيليًا،
          {" "}{numberText(technicalAcceptance.serviceRecognitionEntries)} اعترافات إيراد،
          مع فرق ميزان {String(technicalAcceptance.balanceDifference ?? "غير متاح")} وصفر فجوات.
        </p>
        <p className="mt-2 text-xs text-amber-200">
          نجاح تقني على بيانات وهمية، وليس افتتاحية معتمدة ولا مراجعة بشرية
          ولا شهادة حسابات أو أرباح نهائية. ستظل موانع الاعتماد المحاسبي ظاهرة أدناه.
        </p>
      </div> : null}
      {engineeringAccepted ? <p className="mt-3 text-xs text-slate-300">
        صلاحية الترحيل التقني الجديد: {technicalAcceptance.technicalBootstrapActive === true
          ? "فعالة مؤقتًا" : "منتهية أو غير متاحة"}.
        {" "}تنتهي صلاحيتها: {technicalAcceptance.technicalBootstrapExpiresAt
          ? String(technicalAcceptance.technicalBootstrapExpiresAt) : "لا يوجد تاريخ"}.
        {technicalAcceptance.newPostingRequiresDocumentaryOpening === true
          ? " يلزم اعتماد افتتاحية موثقة قبل أي ترحيل جديد." : ""}
      </p> : null}
      {taggedFixtures > 0 ? <p className="mt-3 text-xs text-slate-300">
        حالة الحركات الاصطناعية: {verifiedFixtureQuarantine && taggedFixtures === quarantinedFixtures
          ? `تم إثبات وعزل ${numberText(quarantinedFixtures)} حركة في فحص الأستاذ مع الاحتفاظ بالسجلات الأصلية وبصمتها، دون شهادة أرباح نهائية.`
          : `يوجد ${numberText(taggedFixtures)} حركة تتطلب توثيق العزل ومراجعته قبل الاعتماد.`}
      </p> : null}
      <p className="mt-3 text-xs text-slate-300">
        الافتتاحية: {report.isOpeningStructurallyPosted === true ? "منشورة بنيويًا" : "غير منشورة بنيويًا"}؛
        {" "}المطابقة المستقلة: {report.isOpeningReconciled === true && opening.accountBalancesMatchedToOpening === true ? "مثبتة" : "غير مثبتة"}؛
        {" "}تغطية المصادر: {report.isSourceCoverageComplete === true ? "مكتملة ضمن نطاق الفحص" : "غير مكتملة"}.
      </p>
      {fixtureEnabled ? <div className="mt-3 rounded-md border border-white/10 p-3 text-sm text-slate-200">
        <h4 className="font-semibold text-white">فصل حركات الأداء التجريبية — Staging فقط</h4>
        <p className="mt-2 text-xs text-slate-400">
          لا تُحذف الحركات الأصلية. يتطلب الفصل مراجعة مستقلة من حساب آخر مخوّل، وهو لا يمثل اعتمادًا محاسبيًا نهائيًا.
        </p>
        {fixture.isLoading || fixture.isFetching ? <p role="status" className="mt-2">جارٍ التحقق من سجل الفصل…</p> : null}
        {fixture.isError ? <p role="alert" className="mt-2 text-rose-200">
          تعذر الوصول إلى حالة فصل حركات الأداء؛ لا يمكن إظهار نتيجة معتمدة.
          <Button size="sm" variant="outline" className="mr-2" onClick={()=>void fixture.refetch()}>إعادة المحاولة</Button>
        </p> : null}
        {fixture.data && !fixture.isFetching && !fixture.isError ? <>
          {fixture.data.manifestSha256 ? <p className="mt-2 break-all font-mono text-xs text-slate-300" dir="ltr">
            SHA-256: {fixture.data.manifestSha256}
          </p> : null}
          <p className="mt-2">
            الحالة: {fixture.data.verified && fixture.data.verificationMode === "technical"
              ? "تم التحقق تقنيًا من عزل بيانات الأداء الاختبارية، دون اعتماد بشري"
              : fixture.data.verified ? "تم التحقق من العزل المستقل والبصمة"
              : fixture.data.status === "not_prepared" ? "لم يُعدّ السجل"
              : fixture.data.status === "pending" ? "بانتظار مراجع مستقل"
              : "فشل التحقق من البصمة أو الروابط"}.
          </p>
          {fixture.data.status === "not_prepared" ? <Button size="sm" variant="outline"
            className="mt-2" disabled={prepareFixture.isPending}
            onClick={()=>prepareFixture.mutate({siteId})}>
            {prepareFixture.isPending ? "جارٍ إعداد السجل…" : "إعداد سجل فصل الأداء"}
          </Button> : null}
          {fixture.data.status === "pending" && fixture.data.preparerIsCurrentUser
            ? <p className="mt-2 text-amber-200">أعددتَ السجل. يجب أن يسجل مراجع آخر دخوله لاعتماده.</p> : null}
          {fixture.data.status === "pending" && fixture.data.canReview ? <div className="mt-3 space-y-2">
            <label className="flex items-start gap-2 text-xs">
              <input type="checkbox" checked={reviewAcknowledged}
                onChange={(e)=>setReviewAcknowledged(e.target.checked)} />
              <span>راجعتُ مصدر مجموعة الأداء وبصمتها واستقلالية هذا الاعتماد؛ أفهم أن ذلك لا يصدّق الأرصدة الافتتاحية أو الأرباح.</span>
            </label>
            <Button size="sm" variant="outline" disabled={!reviewAcknowledged || reviewFixture.isPending
              || !fixture.data.manifestId}
              onClick={()=>reviewFixture.mutate({siteId,manifestId:fixture.data!.manifestId!,
                acknowledgedIndependentReview:true})}>
              {reviewFixture.isPending ? "جارٍ إعادة التحقق من البصمة…" : "اعتماد فصل المجموعة كمراجع مستقل"}
            </Button>
          </div> : null}
          {fixture.data.verified ? <p role="status" className="mt-2 text-emerald-200">
            تم التحقق من {numberText(fixture.data.fixtureCount)} حركة؛ لم تُحذف أي حركة، ولا تزال القوائم المالية غير معتمدة.
            {fixture.data.verificationMode === "technical" ? " هذا فحص تقني لبيانات وهمية قبل الإطلاق، وليس موافقة مراجع بشري." : ""}
          </p> : null}
        </> : null}
        {prepareFixture.isError ? <p role="alert" className="mt-2 text-rose-200">{prepareFixture.error.message}</p> : null}
        {reviewFixture.isError ? <p role="alert" className="mt-2 text-rose-200">{reviewFixture.error.message}</p> : null}
      </div> : null}
      {Object.keys(evidenceReview).length > 0 ? <div className="mt-3 rounded-md border border-white/10 p-3 text-xs text-slate-200">
        <h4 className="font-semibold text-white">مستندات إثبات الافتتاحية والمراجعة المستقلة</h4>
        <p className="mt-2">حالة الإثبات: {String(evidenceReview.status ?? "غير محددة")}</p>
        <p>سطور بلا مستندات مراجعة مطابقة: {numberText(evidenceReview.linesWithoutMatchedReviewedEvidence)}</p>
        <p>سطور تحتوي على أدلة بانتظار المراجعة: {numberText(evidenceReview.linesWithUnreviewedEvidence)}</p>
        <p className="mt-1 text-amber-200">
          مراجعة المستندات وإجمالياتها لا تكفي وحدها للتصديق؛ يتطلب إثباتًا مستقلًا لمصدر المستند وتاريخه وصحته.
        </p>
      </div> : null}
      <FinancialOpeningEvidenceWorkspace siteId={siteId} active={active} />
      <div className="mt-3 rounded-md border border-rose-400/20 p-3 text-sm text-rose-100">
        <h4 className="font-semibold">موانع الاعتماد المثبتة</h4>
        <ul className="mt-2 list-disc space-y-1 pr-5">
          {blockers.map((issue, index) => <li key={index}>{issue}</li>)}
        </ul>
      </div>
      <div className="mt-3 rounded-md border border-white/10 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h4 className="text-sm font-semibold text-white">B1 — قائمة الدخل والمركز المالي الأوليان</h4>
            <p className="mt-1 text-xs text-slate-400">من قيود GL فقط، للفترة والفرع المحددين. لا يشمل توزيع المصروف المركزي أو دمج الحسابات المشتركة.</p>
          </div>
          <Button size="sm" variant="outline" onClick={()=>setShowB1(v=>!v)}>
            {showB1 ? "إخفاء القوائم" : "عرض القوائم الأولية"}
          </Button>
        </div>
        {showB1 && (statements.isFetching || statements.isLoading) ?
          <p role="status" className="mt-3 text-sm text-slate-300">جارٍ احتساب القوائم من القيود المحاسبية...</p> : null}
        {showB1 && statements.isError ?
          <p role="alert" className="mt-3 text-sm text-rose-200">تعذر إعداد القوائم. لا تُعرض أرقام مخزنة أو ناقصة بدل النتائج الحالية.</p> : null}
        {b1Visible ? <div className="mt-3 space-y-3 text-sm text-slate-200">
          <p className="text-amber-200">بيان أولي غير معتمد محاسبيًا (NOT_CERTIFIED)، وليس صافي ربح نهائيًا.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-md border border-white/10 p-3">
              <h5 className="font-semibold text-white">قائمة الدخل — {period}</h5>
              <p className="mt-2">إيراد الخدمة: {b1Amount(b1Income.serviceRevenue)}</p>
              <p>التكلفة المباشرة: {b1Amount(b1Income.directServiceCost)}</p>
              <p>مجمل النتيجة: {b1Amount(b1Income.grossResult)}</p>
              <p>الأجور: {b1Amount(b1Income.wages)}</p>
              <p>الإهلاك والمخصصات: {b1Amount((Number(b1Income.depreciation)||0)+(Number(b1Income.provisions)||0))}</p>
              <p>المصروفات غير التشغيلية: {b1Amount(b1Income.nonOperatingExpenses)}</p>
              <p className="mt-2 font-semibold">النتيجة الأولية: {b1Amount(b1Income.provisionalNetResult)}</p>
            </div>
            <div className="rounded-md border border-white/10 p-3">
              <h5 className="font-semibold text-white">المركز المالي حتى نهاية الفترة</h5>
              <p className="mt-2">صافي الأصول: {b1Amount(b1Position.netAssets)}</p>
              <p>الالتزامات: {b1Amount(b1Position.liabilities)}</p>
              <p>حقوق الملكية المسجلة: {b1Amount(b1Position.postedEquity)}</p>
              <p>النتيجة المتراكمة غير المقفلة: {b1Amount(b1Position.unclosedAccumulatedResult)}</p>
              <p className="mt-2 font-semibold">فرق المعادلة: {b1Amount(b1Position.equationDifference)}</p>
            </div>
          </div>
          <p className="text-xs text-amber-200">ربحية الفرع قبل توزيع المصروفات المركزية: {b1Amount(b1Branch.siteResultBeforeCentralAllocation)}.
          التكاليف المركزية غير الموزعة غير محددة، وليست صفرًا مثبتًا. لا توجد قوائم موحدة للاشتراك بعد.</p>
        </div> : null}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button size="sm" variant="outline" className="border-white/20 text-white"
          onClick={() => setShowTrial(v => !v)}>
          {showTrial ? "إخفاء ميزان المراجعة" : "فحص ميزان المراجعة حتى نهاية الشهر"}
        </Button>
        <p className="text-xs text-slate-400">التحقق اختياري ولا يجري عند فتح اللوحة تلقائيًا.</p>
      </div>
      {showTrial && (trial.isFetching || trial.isLoading)
        ? <p role="status" className="mt-3 text-xs text-slate-300">جارٍ التحقق من الميزان التراكمي...</p> : null}
      {showTrial && trial.isError
        ? <p role="alert" className="mt-3 text-sm text-rose-200">تعذر مطابقة ميزان المراجعة، ولا تُعرض بيانات قديمة.</p> : null}
      {canShowTrial ? <div className="mt-3 rounded-md border border-white/10 p-3 text-sm text-white">
        <p>عدد القيود المنشورة حتى الشهر: {numberText(trialData.postedEntryCount)}</p>
        <p>فرق المدين والدائن: {String(trialData.difference ?? "غير متاح")} شيكل</p>
        <p className="mt-1 text-amber-200">هذا فحص اتزان فقط؛ المركز المالي والربح النهائي غير معتمدين.</p>
      </div> : null}
    </> : null}
  </section>;
}
