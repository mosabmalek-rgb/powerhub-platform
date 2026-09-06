import { Activity, Cog, UsersRound, Wrench } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

function formatNumber(value: number) {
  return new Intl.NumberFormat("ar", { maximumFractionDigits: 0 }).format(value);
}

type OperationalStatusDashboardCardProps = {
  subscribers: number;
  generators?: { active?: number; maintenance?: number };
  loading?: boolean;
  scopeLabel?: string;
};

export function OperationalStatusDashboardCard({ subscribers, generators, loading = false, scopeLabel = "الفرع المحدد" }: OperationalStatusDashboardCardProps) {
  if (loading) {
    return (
      <Card aria-label="ملخص الحالة التشغيلية" className="border-white/8 bg-[#111823] shadow-panel">
        <CardContent className="grid gap-4 p-5 sm:grid-cols-3">
          {["w-36", "w-24", "w-24"].map((width, index) => <div key={`${width}-${index}`} className="h-20 animate-pulse rounded-2xl bg-white/[.05]"><div className={`m-4 h-3 rounded bg-white/10 ${width}`} /></div>)}
        </CardContent>
      </Card>
    );
  }

  const active = Number(generators?.active ?? 0);
  const maintenance = Number(generators?.maintenance ?? 0);
  const total = active + maintenance;

  return (
    <Card className="border-sky-400/20 bg-[#111823] shadow-panel">
      <CardContent className="p-5 sm:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-2 text-sm font-bold text-sky-200"><Activity className="h-4 w-4" /> الحالة التشغيلية السريعة</div>
            <h2 className="mt-1 text-lg font-extrabold text-white">المشتركون والمولدات</h2>
            <p className="mt-1 text-sm text-slate-400">مؤشر مختصر لنطاق {scopeLabel} مع فصل واضح بين التشغيل والصيانة.</p>
          </div>
          <Badge className={maintenance > 0 ? "bg-amber-400/10 text-amber-200" : "bg-emerald-400/10 text-emerald-300"}>{maintenance > 0 ? "توجد صيانة" : "التشغيل مستقر"}</Badge>
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-3">
          <div className="rounded-2xl border border-blue-400/15 bg-blue-400/[.05] p-4">
            <div className="flex items-center justify-between gap-3"><span className="text-xs font-bold text-blue-200">مشتركون نشطون</span><UsersRound className="h-4 w-4 text-blue-300" /></div>
            <p className="mt-3 font-display text-3xl font-extrabold text-white">{formatNumber(Number(subscribers) || 0)}</p>
            <p className="mt-1 text-xs text-slate-500">خدمة فعالة ضمن النطاق</p>
          </div>
          <div className="rounded-2xl border border-emerald-400/15 bg-emerald-400/[.05] p-4">
            <div className="flex items-center justify-between gap-3"><span className="text-xs font-bold text-emerald-200">مولدات نشطة</span><Cog className="h-4 w-4 text-emerald-300" /></div>
            <p className="mt-3 font-display text-3xl font-extrabold text-white">{formatNumber(active)}</p>
            <p className="mt-1 text-xs text-slate-500">تعمل حالياً</p>
          </div>
          <div className="rounded-2xl border border-amber-400/15 bg-amber-400/[.05] p-4">
            <div className="flex items-center justify-between gap-3"><span className="text-xs font-bold text-amber-200">قيد الصيانة</span><Wrench className="h-4 w-4 text-amber-300" /></div>
            <p className="mt-3 font-display text-3xl font-extrabold text-white">{formatNumber(maintenance)}</p>
            <p className="mt-1 text-xs text-slate-500">من أصل {formatNumber(total)} مولد</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
