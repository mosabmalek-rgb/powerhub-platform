import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Loader2, RefreshCw } from "lucide-react";

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
  const tagged = numeric(historical.performanceFixtureTagged);
  if (tagged !== null && tagged > 0) {
    problems.push(`يوجد ${numberText(tagged)} حركة موسومة لاختبارات الأداء. لا يجوز تجاهلها أو إدخالها في أرباح معتمدة دون فصل موثق.`);
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
  const canShowCoverage = Boolean(coverage.data && !coverage.isError && !coverage.isFetching && !coverage.isLoading);
  const report = canShowCoverage ? object(coverage.data) : {};
  const integrity = object(report.sourceIntegrity);
  const sources = object(report.sources);
  const prior = object(sources.priorOperationalSources);
  const opening = object(report.openingEvidenceAudit);
  const evidenceReview = object(opening.evidenceReview);
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
          {label:"حركات أداء اختبارية تاريخية",value:prior.performanceFixtureTagged},
        ] as const).map(item => <div key={item.label} className="rounded-md border border-white/10 p-3">
          <p className="text-xs text-slate-300">{item.label}</p>
          <strong className="mt-1 block text-xl text-white">{numberText(item.value)}</strong>
        </div>)}
      </div>
      <p className="mt-3 text-xs text-slate-300">
        الافتتاحية: {report.isOpeningStructurallyPosted === true ? "منشورة بنيويًا" : "غير منشورة بنيويًا"}؛
        {" "}المطابقة المستقلة: {report.isOpeningReconciled === true && opening.accountBalancesMatchedToOpening === true ? "مثبتة" : "غير مثبتة"}؛
        {" "}تغطية المصادر: {report.isSourceCoverageComplete === true ? "مكتملة ضمن نطاق الفحص" : "غير مكتملة"}.
      </p>
      {Object.keys(evidenceReview).length > 0 ? <div className="mt-3 rounded-md border border-white/10 p-3 text-xs text-slate-200">
        <h4 className="font-semibold text-white">مستندات إثبات الافتتاحية والمراجعة المستقلة</h4>
        <p className="mt-2">حالة الإثبات: {String(evidenceReview.status ?? "غير محددة")}</p>
        <p>سطور بلا مستندات مراجعة مطابقة: {numberText(evidenceReview.linesWithoutMatchedReviewedEvidence)}</p>
        <p>سطور تحتوي على أدلة بانتظار المراجعة: {numberText(evidenceReview.linesWithUnreviewedEvidence)}</p>
        <p className="mt-1 text-amber-200">
          مراجعة المستندات وإجمالياتها لا تكفي وحدها للتصديق؛ يتطلب إثباتًا مستقلًا لمصدر المستند وتاريخه وصحته.
        </p>
      </div> : null}
      <div className="mt-3 rounded-md border border-rose-400/20 p-3 text-sm text-rose-100">
        <h4 className="font-semibold">موانع الاعتماد المثبتة</h4>
        <ul className="mt-2 list-disc space-y-1 pr-5">
          {blockers.map((issue, index) => <li key={index}>{issue}</li>)}
        </ul>
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
