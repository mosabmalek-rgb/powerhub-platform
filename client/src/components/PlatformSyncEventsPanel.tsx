import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import { Activity, AlertTriangle, CheckCircle2, Clock3, Loader2, RefreshCw, Smartphone, WifiOff } from "lucide-react";
import { useMemo, useState } from "react";

type SyncStatus = "all" | "success" | "partial" | "retryable" | "needs_review" | "failed";
const statusLabel: Record<Exclude<SyncStatus, "all">, string> = { success: "مكتملة", partial: "جزئية", retryable: "إعادة تلقائية", needs_review: "تحتاج مراجعة", failed: "فاشلة" };
const statusClass: Record<Exclude<SyncStatus, "all">, string> = { success: "bg-emerald-500/15 text-emerald-300", partial: "bg-amber-500/15 text-amber-300", retryable: "bg-sky-500/15 text-sky-300", needs_review: "bg-orange-500/15 text-orange-300", failed: "bg-rose-500/15 text-rose-300" };

function isoAtStart(value: string) { return value ? new Date(`${value}T00:00:00`).toISOString() : undefined; }
function isoAtEnd(value: string) { return value ? new Date(`${value}T23:59:59.999`).toISOString() : undefined; }

export default function PlatformSyncEventsPanel() {
  const [status, setStatus] = useState<SyncStatus>("all");
  const [fromDate, setFromDate] = useState(() => new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10));
  const [toDate, setToDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [page, setPage] = useState(1);
  const from = useMemo(() => isoAtStart(fromDate), [fromDate]);
  const to = useMemo(() => isoAtEnd(toDate), [toDate]);
  const query = trpc.admin.listSyncEvents.useQuery({ status: status === "all" ? undefined : status, from, to, page, pageSize: 25 }, { refetchInterval: 30_000 });
  const rows = query.data ?? [];
  const reviewCount = rows.filter((row) => row.status === "needs_review" || row.status === "failed").length;
  const retryCount = rows.reduce((total, row) => total + row.retryableCount, 0);
  const syncedCount = rows.reduce((total, row) => total + row.syncedCount, 0);
  const refresh = () => { void query.refetch(); };

  return <section className="space-y-6" dir="rtl">
    <header className="rounded-[26px] border border-[#F5B800]/20 bg-[#111823]/85 p-6 shadow-panel"><div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-center"><div><div className="flex items-center gap-2 text-sm font-bold text-[#F5B800]"><Activity className="h-4 w-4" />الرقابة التشغيلية</div><h2 className="mt-2 text-2xl font-extrabold text-white">سجل المزامنة والتعارضات</h2><p className="mt-2 max-w-3xl text-sm leading-7 text-slate-400">عرض مركزي لأحداث مزامنة الفنيين عبر مساحات المنصة، مع تحديد الحالات التي تحتاج إعادة تلقائية أو مراجعة يدوية دون كشف بيانات خارج صلاحيات آدمن المنصة.</p></div><Button onClick={refresh} variant="outline" className="border-[#F5B800]/35 text-[#F5B800] hover:bg-[#F5B800]/10"><RefreshCw className={`ml-2 h-4 w-4 ${query.isFetching ? "animate-spin" : ""}`} />تحديث السجل</Button></div></header>

    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><Metric label="أحداث الصفحة" value={rows.length} icon={Clock3} tone="text-[#F5B800]" /><Metric label="عمليات ناجحة" value={syncedCount} icon={CheckCircle2} tone="text-emerald-300" /><Metric label="إعادة تلقائية" value={retryCount} icon={WifiOff} tone="text-sky-300" /><Metric label="تحتاج مراجعة" value={reviewCount} icon={AlertTriangle} tone="text-orange-300" /></div>

    <Card className="border-white/8 bg-[#111823] shadow-panel"><CardContent className="grid gap-3 p-5 md:grid-cols-3"><label className="text-xs text-slate-400">الحالة<select className="mt-1 h-10 w-full rounded-xl border border-white/10 bg-white/[0.025] px-3 text-sm text-white" value={status} onChange={(event) => { setStatus(event.target.value as SyncStatus); setPage(1); }}><option className="bg-[#111823]" value="all">كل الحالات</option>{Object.entries(statusLabel).map(([key, label]) => <option className="bg-[#111823]" key={key} value={key}>{label}</option>)}</select></label><label className="text-xs text-slate-400">من<input type="date" value={fromDate} onChange={(event) => { setFromDate(event.target.value); setPage(1); }} className="mt-1 h-10 w-full rounded-xl border border-white/10 bg-white/[0.025] px-3 text-sm text-white" /></label><label className="text-xs text-slate-400">إلى<input type="date" value={toDate} onChange={(event) => { setToDate(event.target.value); setPage(1); }} className="mt-1 h-10 w-full rounded-xl border border-white/10 bg-white/[0.025] px-3 text-sm text-white" /></label></CardContent></Card>

    <Card className="border-white/8 bg-[#111823] shadow-panel"><CardContent className="p-0"><div className="flex items-center justify-between gap-3 border-b border-white/8 px-5 py-4"><div><h3 className="font-extrabold text-white">الأحداث الأخيرة</h3><p className="mt-1 text-xs text-slate-500">تتجدد البيانات تلقائياً كل 30 ثانية.</p></div>{query.isFetching && <Loader2 className="h-5 w-5 animate-spin text-[#F5B800]" />}</div>{query.isLoading ? <div className="grid h-64 place-items-center"><Loader2 className="h-7 w-7 animate-spin text-[#F5B800]" /></div> : rows.length ? <div className="overflow-x-auto"><table className="w-full min-w-[1120px] text-right"><thead className="bg-white/[0.025] text-xs text-slate-400"><tr><th className="px-5 py-3">المساحة والفرع</th><th className="px-5 py-3">الفني والجهاز</th><th className="px-5 py-3">الحالة</th><th className="px-5 py-3">النتيجة</th><th className="px-5 py-3">الخطأ أو التعارض</th><th className="px-5 py-3">الوقت</th></tr></thead><tbody className="divide-y divide-white/7">{rows.map((row) => <tr key={row.id} className="transition-colors hover:bg-white/[0.025]"><td className="px-5 py-4"><div className="font-bold text-white">{row.tenantName}</div><div className="mt-1 text-xs text-slate-500">{row.siteName}</div></td><td className="px-5 py-4"><div className="font-bold text-slate-200">{row.userName ?? row.userEmail ?? `مستخدم #${row.userId}`}</div><div className="mt-1 flex items-center gap-1 text-xs text-slate-500"><Smartphone className="h-3.5 w-3.5" />{row.deviceLabel ?? "جهاز غير مسمى"}{row.appVersion ? ` · ${row.appVersion}` : ""}</div></td><td className="px-5 py-4"><Badge className={statusClass[row.status as Exclude<SyncStatus, "all">]}>{statusLabel[row.status as Exclude<SyncStatus, "all">] ?? row.status}</Badge><p className="mt-1 text-xs text-slate-500">{row.eventType === "sync_cycle" ? "دورة مزامنة" : "خطأ مزامنة"}</p></td><td className="px-5 py-4 text-sm"><span className="text-emerald-300">{row.syncedCount} ناجحة</span><span className="mx-1 text-slate-600">/</span><span className="text-sky-300">{row.retryableCount} إعادة</span><span className="mx-1 text-slate-600">/</span><span className="text-orange-300">{row.needsReviewCount} مراجعة</span></td><td className="max-w-[280px] px-5 py-4"><p className="truncate text-xs text-rose-300" title={row.errorMessage ?? undefined}>{row.errorCode ? `${row.errorCode}: ` : ""}{row.errorMessage ?? "—"}</p></td><td className="px-5 py-4 text-xs text-slate-400">{new Date(row.occurredAt).toLocaleString("ar-IQ")}</td></tr>)}</tbody></table></div> : <div className="py-16 text-center text-sm text-slate-500">لا توجد أحداث مطابقة للفلاتر الحالية.</div>}<div className="flex items-center justify-between border-t border-white/8 px-5 py-4"><span className="text-xs text-slate-500">صفحة {page}</span><div className="flex gap-2"><Button size="sm" variant="outline" disabled={page === 1} onClick={() => setPage((value) => value - 1)}>السابق</Button><Button size="sm" variant="outline" disabled={rows.length < 25} onClick={() => setPage((value) => value + 1)}>التالي</Button></div></div></CardContent></Card>
  </section>;
}

function Metric({ label, value, icon: Icon, tone }: { label: string; value: number; icon: typeof Activity; tone: string }) {
  return <Card className="border-white/8 bg-[#111823] shadow-panel"><CardContent className="flex items-center justify-between p-5"><div><p className="text-xs text-slate-400">{label}</p><p className="mt-2 text-3xl font-extrabold text-white">{value.toLocaleString("ar-IQ")}</p></div><Icon className={`h-8 w-8 ${tone}`} /></CardContent></Card>;
}
