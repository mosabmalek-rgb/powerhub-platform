import { AlertTriangle, CheckCircle2, UserRound, WalletCards } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";
import { useBranchFilter } from "@/hooks/useBranchFilter";

const number = (value: number, fractionDigits = 0) => new Intl.NumberFormat("ar", { maximumFractionDigits: fractionDigits }).format(value);

type Props = { siteId?: number | null; enabled?: boolean; from?: string; to?: string };

export default function CollectorPerformanceSection({ siteId, enabled = true, from, to }: Props) {
  const sitesQuery = trpc.powerhub.sites.list.useQuery(undefined, { enabled: enabled && !siteId });
  const { branchId } = useBranchFilter(sitesQuery.data ?? []);
  const resolvedSiteId = siteId ?? branchId ?? 0;
  const today = new Date().toISOString().slice(0, 10);
  const sessionsQuery = trpc.powerhub.performance.collectorPerformance.useQuery(
    { siteId: resolvedSiteId, from: from ?? today, to: to ?? today },
    { enabled: enabled && Boolean(resolvedSiteId), staleTime: 30_000, refetchOnWindowFocus: false },
  );

  const metrics = sessionsQuery.data
    ? {
        openCount: Number(sessionsQuery.data.openCount ?? 0),
        closedCount: Number(sessionsQuery.data.closedCount ?? 0),
        varianceCount: Number(sessionsQuery.data.varianceCount ?? 0),
        netVariance: Number(sessionsQuery.data.netVariance ?? 0),
        collectors: (sessionsQuery.data.collectors ?? []).map((collector) => ({
          name: collector.name,
          sessions: Number(collector.sessions ?? 0),
          variance: Number(collector.variance ?? 0),
        })),
      }
    : { openCount: 0, closedCount: 0, varianceCount: 0, netVariance: 0, collectors: [] };

  if (!enabled || !resolvedSiteId) return null;
  if (sessionsQuery.isLoading) {
    return (
      <Card className="border-white/8 bg-[#111823] shadow-panel">
        <CardContent className="grid gap-4 p-5 sm:grid-cols-3">
          {Array.from({ length: 3 }, (_, index) => <div key={index} className="h-20 animate-pulse rounded-xl bg-white/[.03]" />)}
        </CardContent>
      </Card>
    );
  }

  if (sessionsQuery.isError) {
    return (
      <Card className="border-rose-400/20 bg-rose-400/[.04] shadow-panel">
        <CardContent className="p-5">
          <h2 className="font-bold text-white">تعذر تحميل أداء المحصلين</h2>
          <p className="mt-1 text-sm text-slate-400">تعذر جلب مؤشرات جلسات التحصيل حاليًا. راجع الاتصال أو أعد فتح الصفحة لاحقًا.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <section aria-label="أداء المحصلين والتنبيهات التشغيلية" className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Card className="border-white/8 bg-[#111823] shadow-panel"><CardContent className="p-4"><div className="flex items-center gap-2 text-slate-400"><UserRound className="h-4 w-4" /><span className="text-xs font-bold">الجلسات المفتوحة</span></div><p className="mt-3 font-display text-2xl font-extrabold text-white">{number(metrics.openCount)}</p><p className="mt-1 text-xs text-slate-500">جلسات تحصيل لم تُغلق بعد.</p></CardContent></Card>
        <Card className="border-white/8 bg-[#111823] shadow-panel"><CardContent className="p-4"><div className="flex items-center gap-2 text-slate-400"><CheckCircle2 className="h-4 w-4" /><span className="text-xs font-bold">الجلسات المغلقة</span></div><p className="mt-3 font-display text-2xl font-extrabold text-white">{number(metrics.closedCount)}</p><p className="mt-1 text-xs text-slate-500">جلسات مكتملة ضمن الفترة المحددة.</p></CardContent></Card>
        <Card className={metrics.varianceCount ? "border-amber-400/25 bg-amber-400/[.05] shadow-panel" : "border-white/8 bg-[#111823] shadow-panel"}><CardContent className="p-4"><div className="flex items-center gap-2 text-slate-400"><AlertTriangle className="h-4 w-4" /><span className="text-xs font-bold">تنبيهات فروقات النقد</span></div><p className={`mt-3 font-display text-2xl font-extrabold ${metrics.varianceCount ? "text-amber-200" : "text-white"}`}>{number(metrics.varianceCount)}</p><p className="mt-1 text-xs text-slate-500">جلسات يظهر فيها فرق بين المتوقع والمصرّح.</p></CardContent></Card>
        <Card className="border-[#F5B800]/20 bg-[#111823] shadow-panel"><CardContent className="p-4"><div className="flex items-center gap-2 text-[#F5B800]"><WalletCards className="h-4 w-4" /><span className="text-xs font-bold">صافي فرق النقد</span></div><p className={`mt-3 font-display text-2xl font-extrabold ${Math.abs(metrics.netVariance) > 0.01 ? "text-amber-200" : "text-emerald-300"}`}>{number(metrics.netVariance, 2)}</p><p className="mt-1 text-xs text-slate-500">المصرّح به − المتوقع من الجلسات المغلقة.</p></CardContent></Card>
      </div>

      <Card className="border-white/8 bg-[#111823] shadow-panel">
        <CardContent className="p-0">
          <div className="flex items-center justify-between border-b border-white/8 px-5 py-4"><div><h2 className="font-bold text-white">أداء المحصلين</h2><p className="mt-1 text-xs text-slate-500">ملخص الجلسات والفروقات من الفترة المحددة — محسوب داخل قاعدة البيانات.</p></div><Badge className="bg-white/5 text-slate-300">أعلى 5 محصلين</Badge></div>
          <div className="overflow-x-auto p-5">
            {metrics.collectors.length ? <table className="w-full min-w-[520px] text-sm"><thead className="text-right text-xs text-slate-500"><tr><th className="pb-3">المحصل</th><th className="pb-3">الجلسات</th><th className="pb-3">فرق النقد</th><th className="pb-3">الحالة</th></tr></thead><tbody>{metrics.collectors.map((collector) => { const variance = collector.variance; return <tr key={collector.name} className="border-t border-white/7"><td className="py-3 font-bold text-white">{collector.name}</td><td className="py-3 text-slate-300">{number(collector.sessions)}</td><td className={`py-3 font-bold ${Math.abs(variance) > 0.01 ? "text-amber-200" : "text-emerald-300"}`}>{number(variance, 2)}</td><td className="py-3"><Badge className={Math.abs(variance) > 0.01 ? "bg-amber-400/10 text-amber-200" : "bg-emerald-400/10 text-emerald-300"}>{Math.abs(variance) > 0.01 ? "تحتاج مراجعة" : "مطابق"}</Badge></td></tr>; })}</tbody></table> : <div className="rounded-xl border border-dashed border-white/10 px-4 py-10 text-center text-sm text-slate-500">لا توجد جلسات تحصيل مسجلة ضمن الفترة المحددة والفرع الحالي.</div>}
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
