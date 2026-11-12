import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Loader2, RefreshCw } from "lucide-react";
import FinancialOpeningEvidenceWorkspace from "./FinancialOpeningEvidenceWorkspace";
import FinancialCentralAllocationWorkspace from "./FinancialCentralAllocationWorkspace";
import FinancialCashTransferPostingWorkspace from "./FinancialCashTransferPostingWorkspace";
import FinancialInterSiteTransferWorkspace from "./FinancialInterSiteTransferWorkspace";

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
  const [showB4, setShowB4] = useState(false);
  const b4Result = trpc.powerhub.reports.financialGLSubledgerReconciliation.useQuery(
    {siteId,period},{
      enabled:enabled && showB4,staleTime:60_000,
      refetchOnWindowFocus:false,refetchOnReconnect:true,
    });
  const b4Data = showB4 && !b4Result.isFetching && !b4Result.isLoading
    && !b4Result.isError ? object(b4Result.data) : {};
  const b4Checks = Array.isArray(b4Data.checks) ? b4Data.checks : [];
  const [showB4Documents,setShowB4Documents] = useState(false);
  const b4Documents = trpc.powerhub.reports.financialGLSubledgerDocumentAudit.useQuery({siteId,period},{
    enabled:enabled && showB4Documents,
    staleTime:60_000,refetchOnWindowFocus:false,refetchOnReconnect:true,
  });
  const b4DocumentData = showB4Documents && !b4Documents.isLoading &&
    !b4Documents.isFetching && !b4Documents.isError ? object(b4Documents.data) : {};
  const b4DocumentSamples = Array.isArray(b4DocumentData.mismatchExamples)
    ? b4DocumentData.mismatchExamples : [];
  const [showB4Cash,setShowB4Cash] = useState(false);
  const b4Cash = trpc.powerhub.reports.financialGLCompanyMovementAudit.useQuery({siteId,period},{
    enabled:enabled && showB4Cash,
    staleTime:60_000,refetchOnWindowFocus:false,refetchOnReconnect:true,
  });
  const b4CashData = showB4Cash && !b4Cash.isLoading &&
    !b4Cash.isFetching && !b4Cash.isError ? object(b4Cash.data) : {};
  const b4CashExamples = Array.isArray(b4CashData.mismatchExamples) ? b4CashData.mismatchExamples : [];
  const b4CashAccounts = Array.isArray(b4CashData.accountBalancesLinkedOnly)
    ? b4CashData.accountBalancesLinkedOnly : [];
  const [showB3, setShowB3] = useState(false);
  const rollup = trpc.powerhub.reports.financialGLTenantRollup.useQuery({siteId,period},{
    enabled:enabled && showB3,staleTime:60_000,
    refetchOnWindowFocus:false,refetchOnReconnect:true,
  });
  const b3Visible = showB3 && !rollup.isFetching && !rollup.isLoading
    && !rollup.isError && rollup.data?.status === "PRELIMINARY_MULTI_SITE_ROLLUP"
    && rollup.data?.accountingCertification === "NOT_CERTIFIED"
    && rollup.data?.isConsolidatedFinancialStatements === false;
  const b3 = b3Visible ? object(rollup.data) : {};
  const b3Income = object(b3.incomeStatement);
  const b3Position = object(b3.positionBeforeEliminations);
  const b3InterSiteProof = object(b3.interSiteGLProof);
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
    return Number.isFinite(n) ? n.toLocaleString("ar",{minimumFractionDigits:0,maximumFractionDigits:2}) : "غير متاح";
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
      <FinancialOpeningEvidenceWorkspace key={siteId} siteId={siteId} active={active} />
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
      <div className="mt-3 rounded-md border border-white/10 p-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h4 className="text-sm font-semibold text-white">B4 — مطابقة الدفاتر المساعدة</h4>
            <p className="mt-1 text-xs text-slate-400">فحص اختياري للأرصدة حتى نهاية الفترة؛ لا يصدر اعتمادًا ماليًا ولا ينشئ قيودًا.</p>
          </div>
          <Button size="sm" variant="outline" onClick={()=>setShowB4(v=>!v)}>
            {showB4 ? "إخفاء المطابقة" : "مطابقة الأرصدة"}
          </Button>
        </div>
        {showB4 && (b4Result.isFetching || b4Result.isLoading)
          ? <p role="status" className="mt-3 text-sm text-slate-300">جارٍ فحص الدفاتر المساعدة...</p> : null}
        {showB4 && b4Result.isError
          ? <p role="alert" className="mt-3 text-sm text-rose-200">فشل فحص المطابقة، ولا تُعرض أرصدة قديمة أو نتائج جزئية.</p> : null}
        {b4Checks.length === 5 ? <div className="mt-3 space-y-2 text-sm text-white">
          <p className="text-amber-200">النتيجة: {b4Data.status === "MATCHED_NUMERICALLY_NOT_CERTIFIED"
            ? "تطابق حسابي أولي غير معتمد" : "توجد فروقات أو مصادر تحتاج مراجعة"} — NOT_CERTIFIED.</p>
          <div className="overflow-x-auto"><table className="w-full text-right text-xs">
            <thead><tr className="border-b border-white/20">
              <th className="p-2">الحساب</th><th className="p-2">GL</th>
              <th className="p-2">المساعد</th><th className="p-2">الفرق</th><th className="p-2">الحالة</th>
            </tr></thead>
            <tbody>{b4Checks.map((raw:unknown)=>{
              const check=object(raw);
              return <tr key={String(check.code)} className="border-b border-white/10">
                <td className="p-2">{String(check.label ?? check.code)}</td>
                <td className="p-2">{String(check.glBalance ?? "غير متاح")}</td>
                <td className="p-2">{String(check.subledgerBalance ?? "غير متاح")}</td>
                <td className="p-2">{String(check.difference ?? "غير متاح")}</td>
                <td className="p-2">{check.status === "MATCHED" ? "مطابق" : "تحتاج مراجعة"}</td>
              </tr>;
            })}</tbody>
          </table></div>
          <p className="text-xs text-amber-200">المطابقة إجمالية، وليست مراجعة مستقلة لكل مستند. الحسابات المشتركة والائتمانات التاريخية والتغييرات اللاحقة تحتاج تدقيقًا منفصلًا قبل الاعتماد.</p>
        </div> : null}
      </div>
      <div className="mt-3 rounded-md border border-white/10 p-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h4 className="text-sm font-semibold text-white">B4 — تدقيق مصادر القيود والمستندات</h4>
            <p className="mt-1 text-xs text-slate-400">مطابقة الفواتير والتحصيلات والموردين واستهلاك المخزون مع GL؛ فحص اختياري وغير معتمد.</p>
          </div>
          <Button size="sm" variant="outline" onClick={()=>setShowB4Documents(v=>!v)}>
            {showB4Documents ? "إخفاء فحص المصادر" : "تدقيق مصادر المستندات"}
          </Button>
        </div>
        {showB4Documents && (b4Documents.isLoading || b4Documents.isFetching)
          ? <p role="status" className="mt-3 text-sm text-slate-300">جارٍ التحقق من مصادر القيود...</p> : null}
        {showB4Documents && b4Documents.isError
          ? <p role="alert" className="mt-3 text-sm text-rose-200">تعذر تدقيق المستندات؛ لن تُعرض نتيجة قديمة أو جزئية.</p> : null}
        {showB4Documents && b4DocumentData.status ? <div className="mt-3 space-y-2 text-sm text-white">
          <p className="text-amber-200">{b4DocumentData.status === "DOCUMENT_SOURCES_MATCHED_NOT_CERTIFIED"
            ? "المصادر المشمولة متطابقة حسابيًا دون اعتماد مالي"
            : "المطابقة محجوبة؛ توجد فروقات أو مصادر غير مكتملة"}</p>
          <p>عدد المصادر المدققة: {numberText(b4DocumentData.sourceCount)}،
            فروقات المصادر: {numberText(b4DocumentData.mismatchCount)}،
            قيود بلا مصدر مطابق: {numberText(b4DocumentData.orphanGLEntryCount)}.</p>
          <p>حركات التحويل المخزني: {numberText(b4DocumentData.transferMovementCount)}،
            صافي تكلفتها: {String(b4DocumentData.transferCostNet ?? "غير متاح")} شيكل.</p>
          {b4DocumentSamples.length ? <div className="overflow-x-auto">
            <table className="w-full text-right text-xs">
              <thead><tr className="border-b border-white/20">
                <th className="p-2">نوع المصدر</th><th className="p-2">رقم المصدر</th>
                <th className="p-2">المبلغ</th><th className="p-2">سبب الاختلاف</th>
              </tr></thead>
              <tbody>{b4DocumentSamples.map((raw:unknown,index:number)=>{
                const d=object(raw);
                return <tr key={String(d.sourceType)+":"+String(d.sourceId)+":"+index}
                  className="border-b border-white/10">
                  <td className="p-2">{String(d.sourceType ?? "—")}</td>
                  <td className="p-2">{String(d.sourceId ?? "—")}</td>
                  <td className="p-2">{String(d.expectedAmount ?? "—")}</td>
                  <td className="p-2">{String(d.reason ?? "غير محدد")}</td>
                </tr>;
              })}</tbody>
            </table>
          </div> : null}
          {b4DocumentData.examplesTruncated === true
            ? <p className="text-xs text-amber-200">توجد فروقات إضافية؛ عُرضت أول 20 حالة فقط.</p> : null}
          <p className="text-xs text-amber-200">هذا تدقيق مصادر جزئي لا يشمل جميع أنواع القيود ولا يغني عن أدلة الافتتاحية أو مراجعة الحسابات النقدية لكل مستند. التصديق المالي غير متاح.</p>
        </div> : null}
      </div>
      <div className="mt-3 rounded-md border border-white/10 p-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h4 className="text-sm font-semibold text-white">B4 — مطابقة حركات حسابات الشركة ومستنداتها</h4>
            <p className="mt-1 text-xs text-slate-400">تدقيق الحركات الموثقة مع التحصيلات والموردين والمصروفات وقيود GL، عند الطلب فقط.</p>
          </div>
          <Button size="sm" variant="outline" onClick={()=>setShowB4Cash(v=>!v)}>
            {showB4Cash ? "إخفاء مطابقة الحسابات" : "تدقيق حسابات الشركة"}
          </Button>
        </div>
        {showB4Cash && (b4Cash.isLoading || b4Cash.isFetching)
          ? <p role="status" className="mt-3 text-sm text-slate-300">جارٍ مطابقة حركات الحسابات بمستنداتها...</p> : null}
        {showB4Cash && b4Cash.isError
          ? <p role="alert" className="mt-3 text-sm text-rose-200">تعذرت مطابقة حركات الحسابات؛ لن تُعرض نتائج جزئية أو قديمة.</p> : null}
        {showB4Cash && b4CashData.status ? <div className="mt-3 space-y-2 text-sm text-white">
          <p className="text-amber-200">{b4CashData.status === "LINKED_ACCOUNT_MOVEMENTS_MATCH_NOT_CERTIFIED"
            ? "الحركات المشمولة مطابقة حسابيًا دون اعتماد مالي"
            : "المطابقة محجوبة لوجود نقص أو فروقات يجب مراجعتها"} — NOT_CERTIFIED.</p>
          <p>حركات مرتبطة مدققة: {numberText(b4CashData.linkedMovementCount)}،
            فروقات: {numberText(b4CashData.mismatchCount)}،
            مصادر بلا حركة مقابلة: {numberText(b4CashData.orphanOperationalSourceCount)}،
            حركات غير مرتبطة: {numberText(b4CashData.unlinkedNonFixtureMovementCount)}.</p>
          <p>حركات أداء مستبعدة بعد التحقق: {numberText(b4CashData.fixtureExcludedCount)}؛
            حالة التحقق: {String(b4CashData.fixtureVerificationStatus ?? "غير متاح")}.</p>
          {b4CashAccounts.length ? <div className="overflow-x-auto"><table className="w-full text-right text-xs">
            <thead><tr className="border-b border-white/20">
              <th className="p-2">الحساب</th><th className="p-2">النوع</th>
              <th className="p-2">الحركات المرتبطة</th><th className="p-2">صافي الحركات المرتبطة</th>
            </tr></thead>
            <tbody>{b4CashAccounts.map((raw:unknown,index:number)=>{
              const d=object(raw);return <tr key={String(d.accountId)+":"+index} className="border-b border-white/10">
                <td className="p-2">{String(d.accountId ?? "—")}</td>
                <td className="p-2">{String(d.accountType ?? "—")}</td>
                <td className="p-2">{numberText(d.linkedMovementCount)}</td>
                <td className="p-2">{String(d.netLinkedAmount ?? "غير متاح")}</td>
              </tr>;
            })}</tbody>
          </table></div> : null}
          {b4CashExamples.length ? <div className="space-y-1">
            <p className="text-xs font-semibold text-rose-200">الحركات غير المطابقة:</p>
            {b4CashExamples.map((raw:unknown,index:number)=>{
              const d=object(raw);return <p key={String(d.transactionId)+":"+index} className="text-xs text-rose-200">
                الحركة {String(d.transactionId ?? "—")} — {String(d.reason ?? "غير معروف")}
              </p>;
            })}
          </div> : null}
          {b4CashData.examplesTruncated===true ? <p className="text-xs text-amber-200">أُظهرت أول 20 حالة فقط؛ بقية الفروقات بحاجة تدقيق.</p> : null}
          <p className="text-xs text-amber-200">GL لا يميز كل محفظة على حدة؛ المطابقة تغطي الحركات المرتبطة بالمصادر ولا تغني عن أدلة الافتتاحية أو الاعتماد المالي المستقل.</p>
        </div> : null}
      </div>
      <FinancialCashTransferPostingWorkspace key={`transfer:${siteId}:${period}`}
        siteId={siteId} period={period} active={active} />
      <FinancialCentralAllocationWorkspace key={`${siteId}:${period}`} siteId={siteId} period={period} active={active} />
      <FinancialInterSiteTransferWorkspace key={`${siteId}:${period}`} siteId={siteId} period={period} active={active} />
      <div className="mt-3 rounded-md border border-white/10 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h4 className="text-sm font-semibold text-white">B3 — إجمالي الفروع الأولي قبل التسويات</h4>
            <p className="mt-1 text-xs text-slate-400">لا يُعاد احتساب أرصدة حسابات الشركة المشتركة. لا يشمل إلغاء التحويلات الداخلية أو اعتماد القوائم الموحدة.</p>
          </div>
          <Button size="sm" variant="outline" onClick={()=>setShowB3(v=>!v)}>
            {showB3 ? "إخفاء تجميع الفروع" : "عرض تجميع الفروع"}
          </Button>
        </div>
        {showB3 && (rollup.isLoading || rollup.isFetching)
          ? <p role="status" className="mt-3 text-sm text-slate-300">جارٍ احتساب تجميع الفروع المصرح بها...</p> : null}
        {showB3 && rollup.isError
          ? <p role="alert" className="mt-3 text-sm text-rose-200">تعذر التحقق من صلاحيات جميع الفروع أو إتمام التجميع؛ لا تُعرض أرقام قديمة أو جزئية.</p> : null}
        {b3Visible ? <div className="mt-3 space-y-2 text-sm text-slate-200">
          <p className="text-amber-200">تجميع أولي غير معتمد (NOT_CERTIFIED)، وليس قائمة مالية موحدة نهائية.</p>
          <p>عدد الفروع المشمولة: {numberText(b3.siteCount)}، قيود GL: {numberText(b3.glEntryCount)}.</p>
          <p>الإيراد: {b1Amount(b3Income.serviceRevenue)}؛ التكلفة المباشرة: {b1Amount(b3Income.directServiceCost)}.</p>
          <p>النتيجة الأولية قبل التسويات: {b1Amount(b3Income.provisionalNetResultBeforeEliminations)}.</p>
          <p>صافي الأصول: {b1Amount(b3Position.netAssets)}؛ الالتزامات: {b1Amount(b3Position.liabilities)}.</p>
          <p>حقوق الملكية: {b1Amount(b3Position.postedEquity)}؛ النتيجة المتراكمة غير المقفلة: {b1Amount(b3Position.unclosedAccumulatedResult)}.</p>
          <p>فرق المعادلة: {b1Amount(b3Position.equationDifference)}.</p>
          <p>تحويلات المخزون داخل الفرع: {numberText(b3.intraSiteWarehouseTransferCount)}،
            بقيمة {b1Amount(b3.intraSiteWarehouseTransferValue)} شيكل،
            فروقات اقتران الخروج/الدخول: {numberText(b3.intraSiteWarehouseTransferMismatchCount)}.</p>
          <p>حالات تحويل بين الفروع مرشحة من GL: {numberText(b3.interSiteTransferCandidateCount)}.
            عدم وجود مرشحات لا يُثبت إجراء تسويات مستقلة أو اكتمال القوائم الموحدة.</p>
          <p>عمليات تحويل حسابات الشركة الموثقة: {numberText(b3.companyTransferSourceOperationCount)}؛
            منها تحويلات تشغيلية بين فرعين: {numberText(b3.crossSiteOperationalTransferCount)}؛
            بقيمة {b1Amount(b3.crossSiteOperationalTransferAmount)} شيكل؛
            أزواج غير متطابقة: {numberText(b3.invalidOperationalTransferPairCount)}.</p>
          {numeric(b3.invalidOperationalTransferPairCount)!==0 ||
           numeric(b3.crossSiteOperationalTransferCount)!==0
            ? <p role="alert" className="text-rose-200">توجد تحويلات تحتاج مطابقة مستقلة من المصدرين مع قيود GL قبل أي اعتماد.</p>
            : <p className="text-xs text-amber-200">لا توجد تحويلات بين فروع مثبتة في مصادر التشغيل الاختبارية الحالية؛ هذا لا يعني اعتماد التسويات.</p>}
          {numeric(b3.intraSiteWarehouseTransferMismatchCount)!==0
            ? <p role="alert" className="text-rose-200">توجد تحويلات مخزنية تحتاج تدقيقًا مستقلًا قبل أي اعتماد.</p> : null}
          <div className="rounded-md border border-white/15 p-3 space-y-1" aria-label="تدقيق قيود التحويلات بين الفروع">
            <p className="font-medium text-white">B3.9 — إثبات مستحق من/مستحق لفرع (معاينة استبعاد فقط)</p>
            <p>عمليات المصدر: {numberText(b3InterSiteProof.sourceCount)}؛
              زوجا القيد المتطابقان: {numberText(b3InterSiteProof.matchedPairCount)}؛
              قيود معلقة: {numberText(b3InterSiteProof.pendingPairCount)}؛
              أزواج غير صالحة: {numberText(b3InterSiteProof.invalidPairCount)}؛
              قيود يتيمة: {numberText(b3InterSiteProof.orphanGLEntryCount)}.</p>
            <p>مستحق من فرع مطابق: {b1Amount(b3InterSiteProof.matchedDueFrom)} شيكل؛
              مستحق لفرع مطابق: {b1Amount(b3InterSiteProof.matchedDueTo)} شيكل.</p>
            <p>تخفيض الأصول في الاستبعاد التجريبي: {b1Amount(b3InterSiteProof.eliminationPreviewAssetReduction)}؛
              تخفيض الالتزامات: {b1Amount(b3InterSiteProof.eliminationPreviewLiabilityReduction)}.</p>
            {b3InterSiteProof.status==="BLOCKED_INTEGRITY"
              || b3InterSiteProof.status==="SOURCE_AWAITS_DUAL_SITE_GL"
              ? <p role="alert" className="text-rose-200">توجد مصادر أو قيود لم تكتمل مطابقتها؛ لا يمكن اعتماد التجميع.</p>
              : <p className="text-amber-200">تطابق القيود لا يغني عن قيد استبعاد مستقل ومراجعة الضرائب والاعتماد المالي النهائي.</p>}
          </div>
          <p className="text-xs text-amber-200">التحويلات بين الفروع والحسابات المشتركة لم تُطابق مستقلاً. التوزيع المركزي والضرائب والاعتماد النهائي غير مكتمل.</p>
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
