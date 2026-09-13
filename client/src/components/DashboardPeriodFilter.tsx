import { dashboardPeriodLabels, type DashboardPeriodPreset } from "@/lib/dashboard-period";
import { cn } from "@/lib/utils";

const presets: Exclude<DashboardPeriodPreset, "custom">[] = ["today", "7d", "30d", "month"];

export function DashboardPeriodFilter({ value, onChange, className }: { value: Exclude<DashboardPeriodPreset, "custom">; onChange: (value: Exclude<DashboardPeriodPreset, "custom">) => void; className?: string }) {
  return (
    <div className={cn("flex flex-wrap gap-2", className)} role="group" aria-label="الفترة الزمنية للوحة المعلومات">
      {presets.map((preset) => (
        <button key={preset} type="button" aria-pressed={value === preset} onClick={() => onChange(preset)} className={cn("rounded-xl border px-3 py-2 text-xs font-bold transition", value === preset ? "border-[#F5B800]/60 bg-[#F5B800]/10 text-[#F5B800]" : "border-white/10 bg-white/[.02] text-slate-400 hover:border-white/20 hover:text-white")}>
          {dashboardPeriodLabels[preset]}
        </button>
      ))}
    </div>
  );
}
