import { Card, CardContent } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import { useBranchFilter } from "@/hooks/useBranchFilter";
import { CheckCircle2, ClipboardList, Gauge, TriangleAlert } from "lucide-react";
import { useMemo } from "react";

type Props = { siteId?: number | null; enabled?: boolean; from?: string; to?: string };

const number = (value: number, fractionDigits = 0) => new Intl.NumberFormat("ar", { maximumFractionDigits: fractionDigits }).format(value);

export default function ConsumptionKpiSection({ siteId, enabled = true, from, to }: Props) {
  const sitesQuery = trpc.powerhub.sites.list.useQuery(undefined, { enabled: enabled && !siteId });
  const { branchId } = useBranchFilter(sitesQuery.data ?? []);
  const resolvedSiteId = siteId ?? branchId ?? 0;
  const readingsQuery = trpc.powerhub.readings.list.useQuery(
    { siteId: resolvedSiteId },
    { enabled: enabled && Boolean(resolvedSiteId), staleTime: 30_000 },
  );

  const metrics = useMemo(() => {
    const rows = readingsQuery.data ?? [];
    const inPeriod = (value: string | Date | null | undefined) => {
      if (!value) return false;
      const date = new Date(value).toISOString().slice(0, 10);
      return (!from || date >= from) && (!to || date <= to);
    };
    const approved = rows.filter((row) => row.reading.status === "approved");
    const pending = rows.filter((row) => row.reading.status === "pending_review" && inPeriod(row.reading.readingAt));
    const recent = approved.filter((row) => inPeriod(row.reading.readingAt));
    const consumption = recent.reduce((sum, row) => sum + Number(row.reading.consumptionKwh ?? 0), 0);
    const average = recent.length ? consumption / recent.length : 0;
    const latestReading = [...recent].sort((a, b) => new Date(b.reading.readingAt).getTime() - new Date(a.reading.readingAt).getTime())[0];
    return {
      consumption,
      average,
      approvedCount: recent.length,
      pendingCount: pending.length,
      latestReadingAt: latestReading?.reading.readingAt ?? null,
    };
  }, [from, readingsQuery.data, to]);

  if (!enabled || !resolvedSiteId) return null;

  if (readingsQuery.isLoading) {
    return (
      <Card className="border-white/8 bg-[#111823] shadow-panel">
        <CardContent className="grid gap-4 p-5 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => <div key={index} className="h-24 animate-pulse rounded-xl bg-white/[.03]" />)}
        </CardContent>
      </Card>
    );
  }

  if (readingsQuery.isError) {
    return (
      <Card className="border-rose-400/20 bg-rose-400/[.04] shadow-panel">
        <CardContent className="p-5">
          <h2 className="font-bold text-white">تعذر تحميل مؤشرات الاستهلاك</h2>
          <p className="mt-1 text-sm text-slate-400">تعذر جلب قراءات الفرع حاليًا. ستعود المؤشرات تلقائيًا عند نجاح الاتصال.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <section aria-label="مؤشرات الاستهلاك والقراءات" className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="font-bold text-white">مؤشرات الاستهلاك والقراءات</h2>
          <p className="mt-1 text-sm text-slate-400">الفترة المحددة — مبنية على القراءات المعتمدة وسجل المراجعة.</p>
        </div>
        {metrics.latestReadingAt ? <span className="text-xs text-slate-500">آخر قراءة: {new Date(metrics.latestReadingAt).toLocaleDateString("ar")}</span> : null}
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Card className="border-sky-400/15 bg-[#111823] shadow-panel"><CardContent className="p-5"><div className="flex items-center gap-2 text-sm font-bold text-sky-200"><Gauge className="h-4 w-4" />الاستهلاك</div><p className="mt-4 font-display text-2xl font-extrabold text-white">{number(metrics.consumption, 2)} <span className="text-xs text-sky-200">kWh</span></p><p className="mt-1 text-xs text-slate-500">إجمالي الاستهلاك من القراءات المعتمدة.</p></CardContent></Card>
        <Card className="border-emerald-400/15 bg-[#111823] shadow-panel"><CardContent className="p-5"><div className="flex items-center gap-2 text-sm font-bold text-emerald-200"><CheckCircle2 className="h-4 w-4" />قراءات معتمدة</div><p className="mt-4 font-display text-2xl font-extrabold text-white">{number(metrics.approvedCount)}</p><p className="mt-1 text-xs text-slate-500">ضمن الفترة المحددة.</p></CardContent></Card>
        <Card className="border-amber-400/15 bg-[#111823] shadow-panel"><CardContent className="p-5"><div className="flex items-center gap-2 text-sm font-bold text-amber-200"><ClipboardList className="h-4 w-4" />بانتظار المراجعة</div><p className="mt-4 font-display text-2xl font-extrabold text-white">{number(metrics.pendingCount)}</p><p className="mt-1 text-xs text-slate-500">قراءات تحتاج اعتمادًا قبل الفوترة.</p></CardContent></Card>
        <Card className={`${metrics.average > 0 ? "border-[#F5B800]/20" : "border-white/8"} bg-[#111823] shadow-panel`}><CardContent className="p-5"><div className="flex items-center gap-2 text-sm font-bold text-[#F5B800]"><TriangleAlert className="h-4 w-4" />متوسط الاستهلاك</div><p className="mt-4 font-display text-2xl font-extrabold text-white">{number(metrics.average, 2)} <span className="text-xs text-[#F5B800]">kWh/قراءة</span></p><p className="mt-1 text-xs text-slate-500">متوسط الاستهلاك في الفترة المحددة.</p></CardContent></Card>
      </div>
    </section>
  );
}
