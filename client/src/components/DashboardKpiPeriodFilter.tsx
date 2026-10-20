import { CalendarDays } from "lucide-react";
import { dashboardKpiPeriodLabels, type DashboardKpiPeriodPreset, isValidDashboardDateInput } from "@/hooks/useDashboardKpiPeriod";
import { cn } from "@/lib/utils";

const presets: DashboardKpiPeriodPreset[] = ["current_cycle", "previous_cycle", "last_month", "custom"];

export function DashboardKpiPeriodFilter({
  value,
  onChange,
  startDate,
  endDate,
  onStartDateChange,
  onEndDateChange,
  disabled = false,
  error = false,
  onRetry,
  className,
}: {
  value: DashboardKpiPeriodPreset;
  onChange: (value: DashboardKpiPeriodPreset) => void;
  startDate: string;
  endDate: string;
  onStartDateChange: (value: string) => void;
  onEndDateChange: (value: string) => void;
  disabled?: boolean;
  error?: boolean;
  onRetry?: () => void;
  className?: string;
}) {
  const validRange = isValidDashboardDateInput(startDate) && isValidDashboardDateInput(endDate) && startDate <= endDate;
  return (
    <section className={cn("rounded-2xl border border-white/8 bg-[#111823] p-4 shadow-panel", className)} aria-label="فلتر فترة مؤشرات لوحة التحكم">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#F5B800]/10 text-[#F5B800]"><CalendarDays className="h-5 w-5" /></span>
          <div>
            <h2 className="font-bold text-white">فترة المؤشرات المالية</h2>
            <p className="mt-1 text-xs leading-5 text-slate-400">يُطبّق الفلتر نفسه على الفوترة والتحصيل ونسبة التحصيل والمتأخرات.</p>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {presets.map((preset) => (
            <button
              type="button"
              key={preset}
              disabled={disabled && preset !== value}
              aria-pressed={value === preset}
              onClick={() => onChange(preset)}
              className={cn(
                "min-h-10 rounded-xl border px-3 py-2 text-xs font-bold transition disabled:cursor-wait disabled:opacity-60",
                value === preset
                  ? "border-[#F5B800]/60 bg-[#F5B800]/10 text-[#F5B800]"
                  : "border-white/10 bg-white/[.02] text-slate-400 hover:border-white/20 hover:text-white",
              )}
            >
              {dashboardKpiPeriodLabels[preset]}
            </button>
          ))}
        </div>
      </div>
      {value === "custom" ? (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="block text-xs text-slate-400">
            <span className="mb-1.5 block">من تاريخ</span>
            <input aria-label="بداية فترة مؤشرات لوحة التحكم" type="date" value={startDate} max={endDate || undefined} onChange={(event) => onStartDateChange(event.target.value)} className="h-10 w-full rounded-xl border border-white/10 bg-[#0D1117] px-3 text-sm text-white outline-none focus:border-[#F5B800]/70" dir="ltr" />
          </label>
          <label className="block text-xs text-slate-400">
            <span className="mb-1.5 block">إلى تاريخ</span>
            <input aria-label="نهاية فترة مؤشرات لوحة التحكم" type="date" value={endDate} min={startDate || undefined} onChange={(event) => onEndDateChange(event.target.value)} className="h-10 w-full rounded-xl border border-white/10 bg-[#0D1117] px-3 text-sm text-white outline-none focus:border-[#F5B800]/70" dir="ltr" />
          </label>
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs">
        <p className={validRange ? "text-slate-500" : "font-bold text-rose-200"}>
          {validRange ? `الفترة: ${startDate} — ${endDate}` : "تحقق من تاريخ البداية والنهاية؛ يجب أن تكون البداية قبل النهاية أو مساوية لها."}
        </p>
        {error ? <span className="flex flex-wrap items-center gap-2 text-rose-200">تعذر تحديد حدود الدورة المطلوبة.{onRetry ? <button type="button" onClick={onRetry} className="font-bold underline underline-offset-2">إعادة المحاولة</button> : null}</span> : null}
        {!error && disabled ? <span className="text-[#F5B800]">جارٍ تحديد الفترة…</span> : null}
      </div>
    </section>
  );
}
