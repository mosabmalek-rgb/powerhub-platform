import { useMemo, useState } from "react";
import { FinancialTrendChart, type FinancialTrendPoint } from "@/components/FinancialTrendChart";
import { DashboardPeriodFilter } from "@/components/DashboardPeriodFilter";
import ConsumptionKpiSection from "@/components/ConsumptionKpiSection";
import CollectorPerformanceSection from "@/components/CollectorPerformanceSection";
import { resolveDashboardPeriod, type DashboardPeriodPreset } from "@/lib/dashboard-period";
import { Card, CardContent } from "@/components/ui/card";

export function FinancialTrendSection({ data = [], loading = false }: { data?: FinancialTrendPoint[]; loading?: boolean }) {
  const [preset, setPreset] = useState<Exclude<DashboardPeriodPreset, "custom">>("30d");
  const period = useMemo(() => resolveDashboardPeriod(preset), [preset]);
  const visibleData = useMemo(
    () => data.filter((point) => point.date >= period.from && point.date <= period.to),
    [data, period.from, period.to],
  );

  return (
    <section className="space-y-3" aria-label="الاتجاه المالي">
      <Card className="border-white/8 bg-[#111823] shadow-panel">
        <CardContent className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-bold text-white">الفترة الزمنية</p>
            <p className="mt-1 text-xs text-slate-500">تتحكم الفترة في الاتجاه المالي ومؤشرات الاستهلاك والتحصيل أدناه.</p>
          </div>
          <DashboardPeriodFilter value={preset} onChange={setPreset} />
        </CardContent>
      </Card>
      <FinancialTrendChart data={visibleData} loading={loading} />
      <ConsumptionKpiSection enabled={!loading} from={period.from} to={period.to} />
      <CollectorPerformanceSection enabled={!loading} from={period.from} to={period.to} />
    </section>
  );
}
