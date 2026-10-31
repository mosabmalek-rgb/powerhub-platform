import { useAuth } from "@/_core/hooks/useAuth";
import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useBranchFilter } from "@/hooks/useBranchFilter";
import { trpc } from "@/lib/trpc";
import { Activity, AlertTriangle, CheckCircle2, Clock3, ExternalLink, Loader2, RefreshCw, Smartphone, UsersRound, WifiOff } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { usePowerHubConnectivity } from "@/lib/offline-connectivity";
import { isExplicitAuthorizationDenial } from "@/lib/offline-query-errors";

type SyncStatus = "all" | "success" | "partial" | "retryable" | "needs_review" | "failed";

const statusLabel: Record<Exclude<SyncStatus, "all">, string> = { success: "مكتملة", partial: "جزئية", retryable: "إعادة تلقائية", needs_review: "تحتاج مراجعة", failed: "فشلت" };
const statusClass: Record<Exclude<SyncStatus, "all">, string> = { success: "bg-emerald-500/15 text-emerald-300", partial: "bg-amber-500/15 text-amber-300", retryable: "bg-sky-500/15 text-sky-300", needs_review: "bg-orange-500/15 text-orange-300", failed: "bg-rose-500/15 text-rose-300" };

function isoAtStart(value: string) { return value ? new Date(`${value}T00:00:00`).toISOString() : undefined; }
function isoAtEnd(value: string) { return value ? new Date(`${value}T23:59:59.999`).toISOString() : undefined; }

export default function MobileSyncPage() {
  const { isAuthenticated } = useAuth();
  const { isOnline, isChecking } = usePowerHubConnectivity();
  const sitesQuery = trpc.powerhub.sites.list.useQuery(undefined, { enabled: Boolean(isAuthenticated && isOnline && !isChecking), refetchOnReconnect: true });
  const { branchId: siteId, setBranchId: setSiteId } = useBranchFilter(sitesQuery.data);
  const [status, setStatus] = useState<SyncStatus>("all");
  const [userId, setUserId] = useState("all");
  const [fromDate, setFromDate] = useState(() => new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10));
  const [toDate, setToDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [page, setPage] = useState(1);
  const [readingPage, setReadingPage] = useState(1);
  const [bulkTarget, setBulkTarget] = useState(500);
  const [bulkProgress, setBulkProgress] = useState<{ processed: number; target: number } | null>(null);
  const serverQueriesEnabled = Boolean(isAuthenticated && siteId && isOnline && !isChecking);
  const from = useMemo(() => isoAtStart(fromDate), [fromDate]);
  const to = useMemo(() => isoAtEnd(toDate), [toDate]);
  const summary = trpc.powerhub.mobileSync.summary.useQuery({ siteId: siteId ?? 0, userId: userId === "all" ? undefined : Number(userId), from, to }, { enabled: serverQueriesEnabled, staleTime: 30_000, refetchOnMount: "always", refetchInterval: serverQueriesEnabled ? 30_000 : false, refetchIntervalInBackground: false, refetchOnReconnect: true });
  const technicians = trpc.powerhub.mobileSync.technicians.useQuery({ siteId: siteId ?? 0 }, { enabled: serverQueriesEnabled, refetchOnReconnect: true });
  // New field readings should appear promptly, but polling stops when this tab is hidden/unmounted.
  const events = trpc.powerhub.mobileSync.list.useQuery({ siteId: siteId ?? 0, status: status === "all" ? undefined : status, userId: userId === "all" ? undefined : Number(userId), from, to, page, pageSize: 25 }, { enabled: serverQueriesEnabled, staleTime: 15_000, refetchOnMount: "always", refetchInterval: serverQueriesEnabled ? 15_000 : false, refetchIntervalInBackground: false, refetchOnReconnect: true });
  const readings = trpc.powerhub.mobileSync.readings.useQuery({ siteId: siteId ?? 0, userId: userId === "all" ? undefined : Number(userId), from, to, page: readingPage, pageSize: 20 }, { enabled: serverQueriesEnabled, staleTime: 15_000, refetchOnMount: "always", refetchInterval: serverQueriesEnabled ? 15_000 : false, refetchIntervalInBackground: false, refetchOnReconnect: true });

  const summaryDenied = isExplicitAuthorizationDenial(summary.error);
  const techniciansDenied = isExplicitAuthorizationDenial(technicians.error);
  const eventsDenied = isExplicitAuthorizationDenial(events.error);
  const readingsDenied = isExplicitAuthorizationDenial(readings.error);
  const summaryData = summaryDenied ? undefined : summary.data;
  const techniciansData = techniciansDenied ? undefined : technicians.data;
  const eventsData = eventsDenied ? undefined : events.data;
  const readingsData = readingsDenied ? undefined : readings.data;
  const hasVisibleSessionSnapshot = summaryData !== undefined || eventsData !== undefined || readingsData !== undefined;

  useEffect(() => {
    const params = new URLSearchParams(typeof window === "undefined" ? "" : window.location.search);
    if (params.get("focus") !== "pending") return;
    window.requestAnimationFrame(() => document.getElementById("field-reading-details")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }, []);

  const refresh = () => {
    if (!isOnline || isChecking) {
      toast.info("تعرض هذه الصفحة بيانات الخادم فقط؛ أعد التحديث بعد عودة الاتصال.");
      return;
    }
    void Promise.all([summary.refetch(), events.refetch(), readings.refetch(), technicians.refetch()]);
  };
  const utils = trpc.useUtils();
  const bulkApprove = trpc.powerhub.mobileSync.approveAllAndIssue.useMutation();
  const approvePendingInBatches = async () => {
    if (!siteId || bulkApprove.isPending) return;
    if (!isOnline || isChecking) { toast.error("اعتماد القراءات وإصدار الفواتير يتطلب اتصالاً بالخادم؛ لم تُرسل أي عملية."); return; }
    const attemptedIds = new Set<number>();
    let requested = 0;
    let succeeded = 0;
    let replayed = 0;
    let failed = 0;
    let safetyBatches = 0;
    setBulkProgress({ processed: 0, target: bulkTarget });
    try {
      while (requested < bulkTarget && safetyBatches < Math.ceil(bulkTarget / 100)) {
        const batchLimit = Math.min(100, bulkTarget - requested);
        const result = await bulkApprove.mutateAsync({
          siteId,
          userId: userId === "all" ? undefined : Number(userId),
          from,
          to,
          limit: batchLimit,
          excludeReadingIds: Array.from(attemptedIds).slice(-500),
          sendNow: true,
        });
        if (result.requested === 0) break;
        requested += result.requested;
        succeeded += result.succeeded;
        replayed += result.replayed;
        failed += result.failed;
        result.results.forEach((item) => attemptedIds.add(item.readingId));
        safetyBatches += 1;
        setBulkProgress({ processed: requested, target: bulkTarget });
        if (result.requested < batchLimit) break;
      }
      if (isOnline && !isChecking) await Promise.all([
        readings.refetch(),
        summary.refetch(),
        events.refetch(),
        utils.powerhub.invoices.list.invalidate({ siteId }),
      ]);
      const resultMessage = `اكتملت المعالجة: ${requested} قراءة، ${succeeded} ناجحة، ${replayed} معاد تشغيلها، ${failed} فاشلة.${requested >= bulkTarget ? " تم بلوغ الحد المختار؛ أعد التشغيل لمعالجة المزيد." : ""}`;
      if (failed > 0) toast.error(resultMessage);
      else toast.success(resultMessage);
    } catch (error) {
      if (isOnline && !isChecking) await Promise.all([readings.refetch(), summary.refetch(), events.refetch()]);
      toast.error(error instanceof Error ? `توقفت المعالجة بعد ${requested} قراءة: ${error.message}` : `توقفت المعالجة بعد ${requested} قراءة بسبب خطأ غير متوقع.`);
    } finally {
      setBulkProgress(null);
    }
  };

  const cards = [
    { label: "قراءات مستلمة", value: summaryData ? (summaryData.syncedReadings ?? 0) : null, icon: CheckCircle2, tone: "text-emerald-300" },
    { label: "تحتاج إعادة تلقائية", value: summaryData ? (summaryData.retryableReadings ?? 0) : null, icon: WifiOff, tone: "text-sky-300" },
    { label: "تحتاج مراجعة", value: summaryData ? (summaryData.needsReviewReadings ?? 0) : null, icon: AlertTriangle, tone: "text-orange-300" },
    { label: "فنيون نشطون", value: summaryData ? (summaryData.activeTechnicians ?? 0) : null, icon: UsersRound, tone: "text-[#F5B800]" },
  ];

  return <DashboardLayout><main className="space-y-6 pb-12" dir="rtl">
    <header className="flex flex-col gap-4 rounded-[24px] border border-white/8 bg-[#111823] p-5 shadow-panel lg:flex-row lg:items-center lg:justify-between">
      <div><div className="flex items-center gap-2 text-sm font-bold text-[#F5B800]"><Activity className="h-4 w-4" />عمليات ميدانية</div><h1 className="mt-1 text-2xl font-extrabold text-white">الميدان والمزامنة</h1><p className="mt-2 text-sm text-slate-400">راقب دورات مزامنة الفنيين والقراءات الواردة والأخطاء حسب الفرع، مع تحديث تلقائي كل 30 ثانية.</p></div>
      <Button onClick={refresh} disabled={!isOnline || isChecking} variant="outline" className="border-[#F5B800]/35 text-[#F5B800] hover:bg-[#F5B800]/10"><RefreshCw className="ml-2 h-4 w-4" />تحديث البيانات</Button>
    </header>

    {isChecking ? <div role="status" className="rounded-xl border border-sky-400/25 bg-sky-400/[.05] p-4 text-sm text-sky-100">نتحقق من اتصال خادم PowerHub قبل تحميل بيانات الميدان.</div> : !isOnline ? <Card role="status" className="border-amber-300/25 bg-amber-300/[.04] shadow-panel"><CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="font-bold text-amber-100">المراقبة الميدانية غير متاحة مباشرة دون اتصال</h2><p className="mt-1 text-sm leading-6 text-slate-300">{hasVisibleSessionSnapshot ? "البيانات الظاهرة آخر استجابة ناجحة في هذه الجلسة وليست تحديثاً حياً؛ لم نعد احتسابها أو اعتبارها مكتملة." : "لا توجد لقطة جلسة متاحة، لذلك لن نعرض أصفاراً أو نعتبر السجل خالياً دون دليل من الخادم."} تبقى المسودات المحلية في مركز المزامنة، ولا يمكن اعتماد قراءة أو إصدار فاتورة من هذه الصفحة دون الخادم.</p></div><a href="/offline-sync" className="inline-flex shrink-0 items-center justify-center rounded-xl border border-[#F5B800]/35 px-4 py-2 text-sm font-bold text-[#F5B800] hover:bg-[#F5B800]/10">فتح مركز المسودات</a></CardContent></Card> : null}

    {summaryDenied ? <div role="alert" className="rounded-xl border border-rose-400/25 bg-rose-400/[.05] p-4 text-sm text-rose-200">رفض الخادم الوصول إلى ملخص الميدان؛ أُخفيت القيم السابقة لهذا الطلب.</div> : summary.isError && !summaryData ? <div role="alert" className="rounded-xl border border-rose-400/25 bg-rose-400/[.05] p-4 text-sm text-rose-200">تعذر تحميل ملخص الميدان. عدم وجود استجابة لا يعني أن أعداد القراءات أو الفنيين تساوي صفراً.</div> : summary.isError ? <p role="status" className="text-xs text-amber-200">تعذر تحديث ملخص الميدان؛ الأرقام الظاهرة آخر نتيجة ناجحة في الجلسة.</p> : null}
    {techniciansDenied ? <div role="alert" className="rounded-xl border border-rose-400/25 bg-rose-400/[.05] p-4 text-sm text-rose-200">رفض الخادم الوصول إلى قائمة الفنيين؛ أُخفيت القائمة السابقة.</div> : null}

    <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{cards.map(({ label, value, icon: Icon, tone }) => <Card key={label} className="border-white/8 bg-[#111823] shadow-panel"><CardContent className="flex items-center justify-between p-5"><div><p className="text-xs text-slate-400">{label}</p><p className="mt-2 text-3xl font-extrabold text-white">{value === null ? "—" : value.toLocaleString("ar-IQ")}</p></div><Icon className={`h-8 w-8 ${tone}`} /></CardContent></Card>)}</section>

    <Card className="border-white/8 bg-[#111823] shadow-panel"><CardContent className="grid gap-3 p-5 md:grid-cols-2 xl:grid-cols-5">
      <label className="text-xs text-slate-400">الفرع<select className="mt-1 h-10 w-full rounded-xl border border-white/10 bg-white/[0.025] px-3 text-sm text-white" value={siteId ?? ""} disabled={bulkProgress !== null} onChange={(event) => { setSiteId(Number(event.target.value)); setPage(1); setReadingPage(1); }}>{sitesQuery.data?.map(site => <option className="bg-[#111823]" key={site.id} value={site.id}>{site.name}</option>)}</select></label>
      <label className="text-xs text-slate-400">الفني<select className="mt-1 h-10 w-full rounded-xl border border-white/10 bg-white/[0.025] px-3 text-sm text-white" value={userId} disabled={bulkProgress !== null} onChange={(event) => { setUserId(event.target.value); setPage(1); setReadingPage(1); }}><option className="bg-[#111823]" value="all">كل الفنيين</option>{techniciansData?.map(user => <option className="bg-[#111823]" key={user.id} value={user.id}>{user.name ?? user.email ?? `مستخدم #${user.id}`}</option>)}</select></label>
      <label className="text-xs text-slate-400">الحالة<select className="mt-1 h-10 w-full rounded-xl border border-white/10 bg-white/[0.025] px-3 text-sm text-white" value={status} disabled={bulkProgress !== null} onChange={(event) => { setStatus(event.target.value as SyncStatus); setPage(1); }}><option className="bg-[#111823]" value="all">كل الحالات</option>{Object.entries(statusLabel).map(([key, label]) => <option className="bg-[#111823]" key={key} value={key}>{label}</option>)}</select></label>
      <label className="text-xs text-slate-400">من<input type="date" value={fromDate} disabled={bulkProgress !== null} onChange={(event) => { setFromDate(event.target.value); setPage(1); setReadingPage(1); }} className="mt-1 h-10 w-full rounded-xl border border-white/10 bg-white/[0.025] px-3 text-sm text-white" /></label>
      <label className="text-xs text-slate-400">إلى<input type="date" value={toDate} disabled={bulkProgress !== null} onChange={(event) => { setToDate(event.target.value); setPage(1); setReadingPage(1); }} className="mt-1 h-10 w-full rounded-xl border border-white/10 bg-white/[0.025] px-3 text-sm text-white" /></label>
    </CardContent></Card>

    <Card className="border-white/8 bg-[#111823] shadow-panel"><CardContent className="p-0">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/8 px-5 py-4"><div><h2 className="font-extrabold text-white">سجل أحداث المزامنة</h2><p className="mt-1 text-xs text-slate-500">دورات ناجحة وجزئية وأخطاء مرسلة من أجهزة الفنيين.</p></div><div className="flex items-center gap-2 text-xs text-slate-400"><Clock3 className="h-4 w-4" />آخر حدث: {summaryData?.lastEventAt ? new Date(summaryData.lastEventAt).toLocaleString("ar-IQ") : "لا يوجد"}</div></div>
      {events.isFetching && eventsData ? <p role="status" aria-live="polite" className="flex items-center gap-2 px-5 pt-3 text-xs text-slate-400"><Loader2 className="h-3.5 w-3.5 animate-spin" /> جارٍ تحديث أحداث المزامنة في الخلفية؛ تبقى النتائج الحالية ظاهرة.</p> : null}
      {eventsDenied ? <div role="alert" className="px-5 py-8 text-center text-sm text-rose-200">رفض الخادم الوصول إلى سجل أحداث المزامنة؛ أُخفيت النتائج السابقة لهذا الطلب.</div> : events.isError && !eventsData ? <div role="alert" className="px-5 py-8 text-center text-sm text-rose-200">تعذر تحميل سجل أحداث المزامنة؛ لا يعني ذلك خلو السجل من الأحداث.</div> : events.isError ? <p role="status" className="px-5 pt-3 text-xs text-amber-200">تعذر تحديث سجل الأحداث؛ تبقى آخر نتائج ناجحة ظاهرة.</p> : events.isLoading && !eventsData ? <div className="grid h-64 place-items-center"><Loader2 className="h-7 w-7 animate-spin text-[#F5B800]" /></div> : eventsData?.length ? <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-right"><thead className="bg-white/[0.025] text-xs text-slate-400"><tr><th className="px-5 py-3">الفني والجهاز</th><th className="px-5 py-3">النتيجة</th><th className="px-5 py-3">القراءات</th><th className="px-5 py-3">الخطأ</th><th className="px-5 py-3">الوقت</th></tr></thead><tbody className="divide-y divide-white/7">{eventsData.map(event => <tr key={event.id} className="transition-colors hover:bg-white/[0.025]"><td className="px-5 py-4"><div className="font-bold text-white">{event.userName ?? event.userEmail ?? `مستخدم #${event.userId}`}</div><div className="mt-1 flex items-center gap-1 text-xs text-slate-500"><Smartphone className="h-3.5 w-3.5" />{event.deviceLabel ?? "جهاز غير مسمى"}{event.appVersion ? ` · ${event.appVersion}` : ""}</div></td><td className="px-5 py-4"><Badge className={statusClass[event.status]}>{statusLabel[event.status]}</Badge><p className="mt-1 text-xs text-slate-500">{event.eventType === "sync_cycle" ? "دورة مزامنة" : "خطأ مزامنة"}</p></td><td className="px-5 py-4 text-sm text-slate-300"><span className="text-emerald-300">{event.syncedCount} ناجحة</span><span className="mx-1 text-slate-600">/</span><span className="text-sky-300">{event.retryableCount} تلقائية</span><span className="mx-1 text-slate-600">/</span><span className="text-orange-300">{event.needsReviewCount} مراجعة</span></td><td className="max-w-[280px] px-5 py-4"><p className="truncate text-xs text-rose-300" title={event.errorMessage ?? undefined}>{event.errorCode ? `${event.errorCode}: ` : ""}{event.errorMessage ?? "—"}</p></td><td className="px-5 py-4 text-xs text-slate-400">{new Date(event.occurredAt).toLocaleString("ar-IQ")}</td></tr>)}</tbody></table></div> : eventsData === undefined && (!isOnline || isChecking) ? <div role="status" className="py-12 text-center text-sm text-slate-400">لا توجد لقطة جلسة لسجل الأحداث. تتطلب المراقبة الحية اتصالاً بالخادم.</div> : <div className="py-16 text-center text-sm text-slate-500">لا توجد أحداث مطابقة للفلاتر الحالية في آخر استجابة ناجحة.</div>}
      <div className="flex items-center justify-between border-t border-white/8 px-5 py-4"><span className="text-xs text-slate-500">صفحة {page}</span><div className="flex gap-2"><Button size="sm" variant="outline" disabled={page === 1} onClick={() => setPage(p => p - 1)}>السابق</Button><Button size="sm" variant="outline" disabled={(eventsData?.length ?? 0) < 25} onClick={() => setPage(p => p + 1)}>التالي</Button></div></div>
    </CardContent></Card>

    <Card id="field-reading-details" className="scroll-mt-6 border-white/8 bg-[#111823] shadow-panel"><CardContent className="p-0">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/8 px-5 py-4"><div><h2 className="font-extrabold text-white">تفاصيل القراءات المستلمة ميدانياً</h2><p className="mt-1 text-xs text-slate-500">تظهر فقط القراءات المسجلة من تطبيق الفني ضمن الفرع والفترة المختارين.</p></div><div className="flex max-w-xl flex-wrap items-center justify-end gap-2"><div className="rounded-xl border border-sky-400/25 bg-sky-400/10 px-3 py-2 text-right"><Badge className="bg-sky-400/15 text-sky-200">اعتماد جماعي آمن</Badge><p className="mt-1 text-xs leading-5 text-sky-100/85">تُعالج القراءات على دفعات متتابعة من 100 كحد أقصى لكل طلب؛ فشل قراءة لا يلغي نجاح البقية.</p></div><label className="text-xs text-slate-400">الحد الإجمالي<select aria-label="الحد الإجمالي للاعتماد" className="mt-1 h-10 rounded-xl border border-white/10 bg-[#111823] px-3 text-sm text-white" value={bulkTarget} disabled={bulkApprove.isPending || bulkProgress !== null} onChange={(event) => setBulkTarget(Number(event.target.value))}><option value={100}>100 قراءة</option><option value={250}>250 قراءة</option><option value={500}>500 قراءة</option></select></label><Button disabled={!isOnline || isChecking || readingsDenied || !(readingsData?.length) || bulkApprove.isPending || bulkProgress !== null} onClick={() => void approvePendingInBatches()} className="bg-emerald-500 font-bold text-white hover:bg-emerald-400">{bulkApprove.isPending ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="ml-2 h-4 w-4" />}{bulkProgress ? `جارٍ معالجة ${bulkProgress.processed} من ${bulkProgress.target}` : `اعتماد وإصدار المعلّق (حتى ${bulkTarget})`}</Button></div></div>
      {readingsDenied ? <div role="alert" className="mx-5 my-4 rounded-xl border border-rose-400/25 bg-rose-400/5 p-4 text-sm text-rose-200">رفض الخادم الوصول إلى تفاصيل القراءات؛ أُخفيت أي نتائج سابقة لهذا الطلب.</div> : readings.isError && !readingsData ? <div role="alert" className="mx-5 my-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-rose-400/25 bg-rose-400/5 p-4 text-sm text-rose-200"><span>تعذر تحميل تفاصيل القراءات من الخادم. لا يعني ذلك أن القراءات غير موجودة؛ أعد المحاولة بعد التحقق من الاتصال.</span><Button size="sm" variant="outline" disabled={!isOnline || isChecking} onClick={() => void readings.refetch()} className="border-rose-300/30 text-rose-100">إعادة تحميل التفاصيل</Button></div> : readings.isError ? <p role="status" className="mx-5 my-3 text-xs text-amber-200">تعذر تحديث القراءات؛ تبقى آخر نتائج ناجحة ظاهرة في الجلسة.</p> : null}
      {readings.isFetching && readingsData ? <p role="status" aria-live="polite" className="flex items-center gap-2 px-5 pt-3 text-xs text-slate-400"><Loader2 className="h-3.5 w-3.5 animate-spin" /> جارٍ تحديث القراءات المستلمة في الخلفية؛ تبقى النتائج الحالية ظاهرة.</p> : null}
      {readings.isLoading && !readingsData ? <div className="grid h-48 place-items-center"><Loader2 className="h-7 w-7 animate-spin text-[#F5B800]" /></div> : readingsData?.length ? <div className="overflow-x-auto"><table className="w-full min-w-[1080px] text-right"><thead className="bg-white/[0.025] text-xs text-slate-400"><tr><th className="px-5 py-3">المشترك</th><th className="px-5 py-3">الرقم المرجعي</th><th className="px-5 py-3">القراءة السابقة</th><th className="px-5 py-3">القراءة الحالية</th><th className="px-5 py-3">الحالة</th><th className="px-5 py-3">وقت القراءة</th><th className="px-5 py-3">وقت المزامنة</th><th className="px-5 py-3">التفاصيل</th></tr></thead><tbody className="divide-y divide-white/7">{readingsData.map(reading => <tr key={reading.id} className="transition-colors hover:bg-white/[0.025]"><td className="px-5 py-4 font-bold text-white">{reading.subscriberName}</td><td className="px-5 py-4 font-mono text-sm text-[#F5B800]">{reading.subscriberNo}</td><td className="px-5 py-4 text-sm text-slate-300">{reading.previousReading ?? "—"}</td><td className="px-5 py-4 text-sm font-bold text-emerald-300">{reading.currentReading}</td><td className="px-5 py-4"><Badge className={reading.status === "approved" ? "bg-emerald-500/15 text-emerald-300" : reading.status === "pending_review" ? "bg-sky-500/15 text-sky-300" : "bg-slate-500/15 text-slate-300"}>{reading.status === "approved" ? "معتمدة ومفوترة" : reading.status === "pending_review" ? "بانتظار الاعتماد" : reading.status}</Badge></td><td className="px-5 py-4 text-xs text-slate-400">{new Date(reading.readingAt).toLocaleString("ar-IQ")}</td><td className="px-5 py-4 text-xs text-slate-400">{new Date(reading.syncedAt).toLocaleString("ar-IQ")}</td><td className="px-5 py-4"><Button size="sm" variant="outline" onClick={() => window.open(`/mobile-sync/readings/${reading.id}?siteId=${siteId}`, "_blank", "noopener,noreferrer")} className="border-[#F5B800]/35 text-[#F5B800] hover:bg-[#F5B800]/10"><ExternalLink className="ml-1 h-3.5 w-3.5" />فتح</Button></td></tr>)}</tbody></table></div> : readings.isError ? null : readingsData === undefined && (!isOnline || isChecking) ? <div role="status" className="py-12 text-center text-sm text-slate-400">لا توجد لقطة جلسة لتفاصيل القراءات. تتطلب القراءة المعتمدة اتصالاً بالخادم.</div> : <div className="py-14 text-center text-sm text-slate-500">لا توجد قراءات ميدانية مستلمة ضمن الفلاتر الحالية في آخر استجابة ناجحة.</div>}
      <div className="flex items-center justify-between border-t border-white/8 px-5 py-4"><span className="text-xs text-slate-500">صفحة {readingPage}</span><div className="flex gap-2"><Button size="sm" variant="outline" disabled={readingPage === 1} onClick={() => setReadingPage(p => p - 1)}>السابق</Button><Button size="sm" variant="outline" disabled={(readingsData?.length ?? 0) < 20} onClick={() => setReadingPage(p => p + 1)}>التالي</Button></div></div>
    </CardContent></Card>
  </main></DashboardLayout>;
}
