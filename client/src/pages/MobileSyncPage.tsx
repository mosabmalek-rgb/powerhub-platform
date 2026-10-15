import { useAuth } from "@/_core/hooks/useAuth";
import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useBranchFilter } from "@/hooks/useBranchFilter";
import { trpc } from "@/lib/trpc";
import { Activity, AlertTriangle, CheckCircle2, Clock3, ExternalLink, Loader2, RefreshCw, Smartphone, UsersRound, WifiOff } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

type SyncStatus = "all" | "success" | "partial" | "retryable" | "needs_review" | "failed";

const statusLabel: Record<Exclude<SyncStatus, "all">, string> = { success: "مكتملة", partial: "جزئية", retryable: "إعادة تلقائية", needs_review: "تحتاج مراجعة", failed: "فشلت" };
const statusClass: Record<Exclude<SyncStatus, "all">, string> = { success: "bg-emerald-500/15 text-emerald-300", partial: "bg-amber-500/15 text-amber-300", retryable: "bg-sky-500/15 text-sky-300", needs_review: "bg-orange-500/15 text-orange-300", failed: "bg-rose-500/15 text-rose-300" };

function isoAtStart(value: string) { return value ? new Date(`${value}T00:00:00`).toISOString() : undefined; }
function isoAtEnd(value: string) { return value ? new Date(`${value}T23:59:59.999`).toISOString() : undefined; }

export default function MobileSyncPage() {
  const { isAuthenticated } = useAuth();
  const sitesQuery = trpc.powerhub.sites.list.useQuery(undefined, { enabled: isAuthenticated });
  const { branchId: siteId, setBranchId: setSiteId } = useBranchFilter(sitesQuery.data);
  const [status, setStatus] = useState<SyncStatus>("all");
  const [userId, setUserId] = useState("all");
  const [fromDate, setFromDate] = useState(() => new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10));
  const [toDate, setToDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [page, setPage] = useState(1);
  const [readingPage, setReadingPage] = useState(1);
  const enabled = Boolean(isAuthenticated && siteId);
  const from = useMemo(() => isoAtStart(fromDate), [fromDate]);
  const to = useMemo(() => isoAtEnd(toDate), [toDate]);
  const summary = trpc.powerhub.mobileSync.summary.useQuery({ siteId: siteId ?? 0, from, to }, { enabled, staleTime: 30_000, refetchInterval: 30_000, refetchIntervalInBackground: false });
  const technicians = trpc.powerhub.mobileSync.technicians.useQuery({ siteId: siteId ?? 0 }, { enabled });
  // New field readings should appear promptly, but polling stops when this tab is hidden/unmounted.
  const events = trpc.powerhub.mobileSync.list.useQuery({ siteId: siteId ?? 0, status: status === "all" ? undefined : status, userId: userId === "all" ? undefined : Number(userId), from, to, page, pageSize: 25 }, { enabled, staleTime: 15_000, refetchInterval: 15_000, refetchIntervalInBackground: false });
  const readings = trpc.powerhub.mobileSync.readings.useQuery({ siteId: siteId ?? 0, userId: userId === "all" ? undefined : Number(userId), from, to, page: readingPage, pageSize: 20 }, { enabled, staleTime: 15_000, refetchInterval: 15_000, refetchIntervalInBackground: false });
  const refresh = () => { void summary.refetch(); void events.refetch(); void readings.refetch(); void technicians.refetch(); };  const utils = trpc.useUtils();
  const bulkApprove = trpc.powerhub.mobileSync.approveAllAndIssue.useMutation({
    onSuccess: async (result) => {
      await Promise.all([readings.refetch(), summary.refetch(), events.refetch(), utils.powerhub.invoices.list.invalidate({ siteId: siteId ?? 0 })]);
      const message = `تمت معالجة ${result.requested} قراءة: ${result.succeeded} ناجحة، ${result.replayed} معاد تشغيلها، ${result.failed} فاشلة.`;
      toast.success(message);
    },
  });
  const pendingReadingCount = readings.data?.filter((reading) => reading.status === "pending_review").length ?? 0;

  const cards = [
    { label: "قراءات مستلمة", value: summary.data?.syncedReadings ?? 0, icon: CheckCircle2, tone: "text-emerald-300" },
    { label: "تحتاج إعادة تلقائية", value: summary.data?.retryableReadings ?? 0, icon: WifiOff, tone: "text-sky-300" },
    { label: "تحتاج مراجعة", value: summary.data?.needsReviewReadings ?? 0, icon: AlertTriangle, tone: "text-orange-300" },
    { label: "فنيون نشطون", value: summary.data?.activeTechnicians ?? 0, icon: UsersRound, tone: "text-[#F5B800]" },
  ];

  return <DashboardLayout><main className="space-y-6 pb-12" dir="rtl">
    <header className="flex flex-col gap-4 rounded-[24px] border border-white/8 bg-[#111823] p-5 shadow-panel lg:flex-row lg:items-center lg:justify-between">
      <div><div className="flex items-center gap-2 text-sm font-bold text-[#F5B800]"><Activity className="h-4 w-4" />عمليات ميدانية</div><h1 className="mt-1 text-2xl font-extrabold text-white">الميدان والمزامنة</h1><p className="mt-2 text-sm text-slate-400">راقب دورات مزامنة الفنيين والقراءات الواردة والأخطاء حسب الفرع، مع تحديث تلقائي كل 30 ثانية.</p></div>
      <Button onClick={refresh} variant="outline" className="border-[#F5B800]/35 text-[#F5B800] hover:bg-[#F5B800]/10"><RefreshCw className="ml-2 h-4 w-4" />تحديث البيانات</Button>
    </header>

    <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{cards.map(({ label, value, icon: Icon, tone }) => <Card key={label} className="border-white/8 bg-[#111823] shadow-panel"><CardContent className="flex items-center justify-between p-5"><div><p className="text-xs text-slate-400">{label}</p><p className="mt-2 text-3xl font-extrabold text-white">{value.toLocaleString("ar-IQ")}</p></div><Icon className={`h-8 w-8 ${tone}`} /></CardContent></Card>)}</section>

    <Card className="border-white/8 bg-[#111823] shadow-panel"><CardContent className="grid gap-3 p-5 md:grid-cols-2 xl:grid-cols-5">
      <label className="text-xs text-slate-400">الفرع<select className="mt-1 h-10 w-full rounded-xl border border-white/10 bg-white/[0.025] px-3 text-sm text-white" value={siteId ?? ""} onChange={(event) => { setSiteId(Number(event.target.value)); setPage(1); setReadingPage(1); }}>{sitesQuery.data?.map(site => <option className="bg-[#111823]" key={site.id} value={site.id}>{site.name}</option>)}</select></label>
      <label className="text-xs text-slate-400">الفني<select className="mt-1 h-10 w-full rounded-xl border border-white/10 bg-white/[0.025] px-3 text-sm text-white" value={userId} onChange={(event) => { setUserId(event.target.value); setPage(1); setReadingPage(1); }}><option className="bg-[#111823]" value="all">كل الفنيين</option>{technicians.data?.map(user => <option className="bg-[#111823]" key={user.id} value={user.id}>{user.name ?? user.email ?? `مستخدم #${user.id}`}</option>)}</select></label>
      <label className="text-xs text-slate-400">الحالة<select className="mt-1 h-10 w-full rounded-xl border border-white/10 bg-white/[0.025] px-3 text-sm text-white" value={status} onChange={(event) => { setStatus(event.target.value as SyncStatus); setPage(1); }}><option className="bg-[#111823]" value="all">كل الحالات</option>{Object.entries(statusLabel).map(([key, label]) => <option className="bg-[#111823]" key={key} value={key}>{label}</option>)}</select></label>
      <label className="text-xs text-slate-400">من<input type="date" value={fromDate} onChange={(event) => { setFromDate(event.target.value); setPage(1); setReadingPage(1); }} className="mt-1 h-10 w-full rounded-xl border border-white/10 bg-white/[0.025] px-3 text-sm text-white" /></label>
      <label className="text-xs text-slate-400">إلى<input type="date" value={toDate} onChange={(event) => { setToDate(event.target.value); setPage(1); setReadingPage(1); }} className="mt-1 h-10 w-full rounded-xl border border-white/10 bg-white/[0.025] px-3 text-sm text-white" /></label>
    </CardContent></Card>

    <Card className="border-white/8 bg-[#111823] shadow-panel"><CardContent className="p-0">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/8 px-5 py-4"><div><h2 className="font-extrabold text-white">سجل أحداث المزامنة</h2><p className="mt-1 text-xs text-slate-500">دورات ناجحة وجزئية وأخطاء مرسلة من أجهزة الفنيين.</p></div><div className="flex items-center gap-2 text-xs text-slate-400"><Clock3 className="h-4 w-4" />آخر حدث: {summary.data?.lastEventAt ? new Date(summary.data.lastEventAt).toLocaleString("ar-IQ") : "لا يوجد"}</div></div>
      {events.isFetching && events.data ? <p role="status" aria-live="polite" className="flex items-center gap-2 px-5 pt-3 text-xs text-slate-400"><Loader2 className="h-3.5 w-3.5 animate-spin" /> جارٍ تحديث أحداث المزامنة في الخلفية؛ تبقى النتائج الحالية ظاهرة.</p> : null}
      {events.isLoading ? <div className="grid h-64 place-items-center"><Loader2 className="h-7 w-7 animate-spin text-[#F5B800]" /></div> : events.data?.length ? <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-right"><thead className="bg-white/[0.025] text-xs text-slate-400"><tr><th className="px-5 py-3">الفني والجهاز</th><th className="px-5 py-3">النتيجة</th><th className="px-5 py-3">القراءات</th><th className="px-5 py-3">الخطأ</th><th className="px-5 py-3">الوقت</th></tr></thead><tbody className="divide-y divide-white/7">{events.data.map(event => <tr key={event.id} className="transition-colors hover:bg-white/[0.025]"><td className="px-5 py-4"><div className="font-bold text-white">{event.userName ?? event.userEmail ?? `مستخدم #${event.userId}`}</div><div className="mt-1 flex items-center gap-1 text-xs text-slate-500"><Smartphone className="h-3.5 w-3.5" />{event.deviceLabel ?? "جهاز غير مسمى"}{event.appVersion ? ` · ${event.appVersion}` : ""}</div></td><td className="px-5 py-4"><Badge className={statusClass[event.status]}>{statusLabel[event.status]}</Badge><p className="mt-1 text-xs text-slate-500">{event.eventType === "sync_cycle" ? "دورة مزامنة" : "خطأ مزامنة"}</p></td><td className="px-5 py-4 text-sm text-slate-300"><span className="text-emerald-300">{event.syncedCount} ناجحة</span><span className="mx-1 text-slate-600">/</span><span className="text-sky-300">{event.retryableCount} تلقائية</span><span className="mx-1 text-slate-600">/</span><span className="text-orange-300">{event.needsReviewCount} مراجعة</span></td><td className="max-w-[280px] px-5 py-4"><p className="truncate text-xs text-rose-300" title={event.errorMessage ?? undefined}>{event.errorCode ? `${event.errorCode}: ` : ""}{event.errorMessage ?? "—"}</p></td><td className="px-5 py-4 text-xs text-slate-400">{new Date(event.occurredAt).toLocaleString("ar-IQ")}</td></tr>)}</tbody></table></div> : <div className="py-16 text-center text-sm text-slate-500">لا توجد أحداث مطابقة للفلاتر الحالية.</div>}
      <div className="flex items-center justify-between border-t border-white/8 px-5 py-4"><span className="text-xs text-slate-500">صفحة {page}</span><div className="flex gap-2"><Button size="sm" variant="outline" disabled={page === 1} onClick={() => setPage(p => p - 1)}>السابق</Button><Button size="sm" variant="outline" disabled={(events.data?.length ?? 0) < 25} onClick={() => setPage(p => p + 1)}>التالي</Button></div></div>
    </CardContent></Card>

    <Card className="border-white/8 bg-[#111823] shadow-panel"><CardContent className="p-0">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/8 px-5 py-4"><div><h2 className="font-extrabold text-white">تفاصيل القراءات المستلمة ميدانياً</h2><p className="mt-1 text-xs text-slate-500">تظهر فقط القراءات المسجلة من تطبيق الفني ضمن الفرع والفترة المختارين.</p></div><div className="flex max-w-xl flex-wrap items-center justify-end gap-2"><div className="rounded-xl border border-sky-400/25 bg-sky-400/10 px-3 py-2 text-right"><Badge className="bg-sky-400/15 text-sky-200">اعتماد جماعي آمن</Badge><p className="mt-1 text-xs leading-5 text-sky-100/85">كل قراءة تُعتمد وتُفوتر كمعاملة ذرية مستقلة؛ فشل قراءة لا يلغي نجاح البقية.</p></div><Button disabled={!pendingReadingCount || bulkApprove.isPending} onClick={() => bulkApprove.mutate({ siteId: siteId ?? 0, userId: userId === "all" ? undefined : Number(userId), from, to, limit: 100, sendNow: true })} className="bg-emerald-500 font-bold text-white hover:bg-emerald-400">{bulkApprove.isPending ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="ml-2 h-4 w-4" />}اعتماد وإصدار المعلّق (حتى 100) ({pendingReadingCount})</Button></div></div>
      {readings.isFetching && readings.data ? <p role="status" aria-live="polite" className="flex items-center gap-2 px-5 pt-3 text-xs text-slate-400"><Loader2 className="h-3.5 w-3.5 animate-spin" /> جارٍ تحديث القراءات المستلمة في الخلفية؛ تبقى النتائج الحالية ظاهرة.</p> : null}
      {readings.isLoading ? <div className="grid h-48 place-items-center"><Loader2 className="h-7 w-7 animate-spin text-[#F5B800]" /></div> : readings.data?.length ? <div className="overflow-x-auto"><table className="w-full min-w-[1080px] text-right"><thead className="bg-white/[0.025] text-xs text-slate-400"><tr><th className="px-5 py-3">المشترك</th><th className="px-5 py-3">الرقم المرجعي</th><th className="px-5 py-3">القراءة السابقة</th><th className="px-5 py-3">القراءة الحالية</th><th className="px-5 py-3">الحالة</th><th className="px-5 py-3">وقت القراءة</th><th className="px-5 py-3">وقت المزامنة</th><th className="px-5 py-3">التفاصيل</th></tr></thead><tbody className="divide-y divide-white/7">{readings.data.map(reading => <tr key={reading.id} className="transition-colors hover:bg-white/[0.025]"><td className="px-5 py-4 font-bold text-white">{reading.subscriberName}</td><td className="px-5 py-4 font-mono text-sm text-[#F5B800]">{reading.subscriberNo}</td><td className="px-5 py-4 text-sm text-slate-300">{reading.previousReading ?? "—"}</td><td className="px-5 py-4 text-sm font-bold text-emerald-300">{reading.currentReading}</td><td className="px-5 py-4"><Badge className={reading.status === "approved" ? "bg-emerald-500/15 text-emerald-300" : reading.status === "pending_review" ? "bg-sky-500/15 text-sky-300" : "bg-slate-500/15 text-slate-300"}>{reading.status === "approved" ? "معتمدة ومفوترة" : reading.status === "pending_review" ? "بانتظار الاعتماد" : reading.status}</Badge></td><td className="px-5 py-4 text-xs text-slate-400">{new Date(reading.readingAt).toLocaleString("ar-IQ")}</td><td className="px-5 py-4 text-xs text-slate-400">{new Date(reading.syncedAt).toLocaleString("ar-IQ")}</td><td className="px-5 py-4"><Button size="sm" variant="outline" onClick={() => window.open(`/mobile-sync/readings/${reading.id}?siteId=${siteId}`, "_blank", "noopener,noreferrer")} className="border-[#F5B800]/35 text-[#F5B800] hover:bg-[#F5B800]/10"><ExternalLink className="ml-1 h-3.5 w-3.5" />فتح</Button></td></tr>)}</tbody></table></div> : <div className="py-14 text-center text-sm text-slate-500">لا توجد قراءات ميدانية مستلمة ضمن الفلاتر الحالية.</div>}
      <div className="flex items-center justify-between border-t border-white/8 px-5 py-4"><span className="text-xs text-slate-500">صفحة {readingPage}</span><div className="flex gap-2"><Button size="sm" variant="outline" disabled={readingPage === 1} onClick={() => setReadingPage(p => p - 1)}>السابق</Button><Button size="sm" variant="outline" disabled={(readings.data?.length ?? 0) < 20} onClick={() => setReadingPage(p => p + 1)}>التالي</Button></div></div>
    </CardContent></Card>
  </main></DashboardLayout>;
}
