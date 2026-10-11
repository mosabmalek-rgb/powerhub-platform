import { LucideIcon } from "lucide-react";

export function MetricCard({
  label,
  value,
  unit,
  description,
  icon: Icon,
  accent = "gold",
  periodLabel = "هذا الشهر",
}: {
  label: string;
  value: string;
  unit?: string;
  description: string;
  icon: LucideIcon;
  accent?: "gold" | "emerald" | "blue" | "rose";
  periodLabel?: string;
}) {
  const accents = {
    gold: "bg-[#F5B800]/10 text-[#F5B800]",
    emerald: "bg-emerald-400/10 text-emerald-400",
    blue: "bg-sky-400/10 text-sky-400",
    rose: "bg-rose-400/10 text-rose-400",
  };

  return (
    <article className="group rounded-2xl border border-white/8 bg-[#111823] p-5 shadow-panel transition hover:-translate-y-0.5 hover:border-white/15">
      <div className="flex items-start justify-between gap-3">
        <div className={`grid h-10 w-10 place-items-center rounded-xl ${accents[accent]}`}><Icon className="h-5 w-5" /></div>
        <span className="rounded-full border border-white/7 bg-white/[0.025] px-2.5 py-1 text-[11px] font-medium text-slate-500">{periodLabel}</span>
      </div>
      <p className="mt-6 text-sm font-medium text-slate-400">{label}</p>
      <div className="mt-2 flex items-end gap-2">
        <span className="font-display text-3xl font-extrabold tracking-tight text-white" dir="ltr">{value}</span>
        {unit && <span className="mb-1 text-xs font-bold text-slate-500">{unit}</span>}
      </div>
      <p className="mt-3 text-xs leading-5 text-slate-500">{description}</p>
    </article>
  );
}
