import { Card, CardContent } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import { CheckCircle2, ClipboardList, Gauge } from "lucide-react";

type Props = { siteId?: number | null; scope?: "branch" | "all"; enabled?: boolean; from?: string; to?: string };

const number = (value: number, fractionDigits = 0) => new Intl.NumberFormat("ar", { maximumFractionDigits: fractionDigits }).format(value);

export default function ConsumptionKpiSection({ siteId, scope = "branch", enabled = true, from, to }: Props) {
  const today = new Date().toISOString().slice(0, 10);
  const periodInput = { siteId: siteId ?? 0, from: from ?? today, to: to ?? today };
  const branchReadingsQuery = trpc.powerhub.performance.readingKpis.useQuery(
    periodInput,
    { enabled: enabled && scope === "branch" && Boolean(siteId), staleTime: 30_000, refetchOnWindowFocus: false },
  );
  const allBranchesReadingsQuery = trpc.powerhub.performance.allBranchesReadingKpis.useQuery(
    periodInput,
    { enabled: enabled && scope === "all" && Boolean(siteId), staleTime: 30_000, refetchOnWindowFocus: false },
  );
  const readingsQuery = scope === "all" ? allBranchesReadingsQuery : branchReadingsQuery;

  const metrics = readingsQuery.data
    ? {
        consumption: Number(readingsQuery.data.consumption ?? 0),
        approvedCount: Number(readingsQuery.data.approvedCount ?? 0),
        pendingCount: Number(readingsQuery.data.pendingCount ?? 0),
        latestReadingAt: readingsQuery.data.latestReadingAt,
      }
    : { consumption: 0, approvedCount: 0, pendingCount: 0, latestReadingAt: null };

  if (!enabled || !siteId) return null;

  if (readingsQuery.isLoading) {
    return (
      <Card className="border-white/8 bg-[#111823] shadow-panel">
        <CardContent className="grid gap-4 p-5 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }, (_, index) => <div key={index} className="h-24 animate-pulse rounded-xl bg-white/[.03]" />)}
        </CardContent>
      </Card>
    );
  }

  if (readingsQuery.isError) {
    return (
      <Card className="border-rose-400/20 bg-rose-400/[.04] shadow-panel">
        <CardContent className="p-5">
          <h2 className="font-bold text-white">تعذر تحميل مؤشرات الاستهلاك</h2>
          <p className="mt-1 text-sm text-slate-400">تعذر جلب مؤشرات القراءات حاليًا. ستعود المؤشرات تلقائيًا عند نجاح الاتصال.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <section aria-label="مؤشرات الاستهلاك والقراءات" className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="font-bold text-white">مؤشرات الاستهلاك والقراءات</h2>
          <p className="mt-1 text-sm text-slate-400">{scope === "all" ? "جميع الأفرع غير المؤرشفة" : "الفرع المحدد"} · الفترة المحددة · تُحسب داخل قاعدة البيانات.</p>
        </div>
        {metrics.latestReadingAt ? <span className="text-xs text-slate-500">آخر قراءة معتمدة ضمن الفترة: {new Date(metrics.latestReadingAt).toLocaleDateString("ar")}</span> : null}
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <Card className="border-sky-400/15 bg-[#111823] shadow-panel"><CardContent className="p-5"><div className="flex items-center gap-2 text-sm font-bold text-sky-200"><Gauge className="h-4 w-4" />إجمالي الاستهلاك المعتمد</div><p className="mt-4 font-display text-2xl font-extrabold text-white">{number(metrics.consumption, 2)} <span className="text-xs text-sky-200">kWh</span></p><p className="mt-1 text-xs text-slate-500">مجموع الاستهلاك في القراءات المعتمدة فقط.</p></CardContent></Card>
        <Card className="border-emerald-400/15 bg-[#111823] shadow-panel"><CardContent className="p-5"><div className="flex items-center gap-2 text-sm font-bold text-emerald-200"><CheckCircle2 className="h-4 w-4" />القراءات المعتمدة</div><p className="mt-4 font-display text-2xl font-extrabold text-white">{number(metrics.approvedCount)}</p><p className="mt-1 text-xs text-slate-500">عدد القراءات المعتمدة ضمن الفترة.</p></CardContent></Card>
        <Card className="border-amber-400/15 bg-[#111823] shadow-panel"><CardContent className="p-5"><div className="flex items-center gap-2 text-sm font-bold text-amber-200"><ClipboardList className="h-4 w-4" />بانتظار المراجعة</div><p className="mt-4 font-display text-2xl font-extrabold text-white">{number(metrics.pendingCount)}</p><p className="mt-1 text-xs text-slate-500">قراءات تحتاج اعتمادًا قبل الفوترة.</p></CardContent></Card>
      </div>
    </section>
  );
}
