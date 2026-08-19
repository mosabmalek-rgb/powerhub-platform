import { Zap } from "lucide-react";
import { cn } from "@/lib/utils";

export function PowerHubLogo({ compact = false, className }: { compact?: boolean; className?: string }) {
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <div className="relative grid h-9 w-9 place-items-center rounded-xl bg-[#F5B800] text-[#0D1117] shadow-[0_0_0_4px_rgba(245,184,0,0.12)]">
        <Zap className="h-5 w-5 fill-current stroke-[2.4]" />
        <span className="absolute -bottom-1 -right-1 h-2.5 w-2.5 rounded-full border-2 border-[#0D1117] bg-emerald-400" />
      </div>
      {!compact && (
        <div className="min-w-0 leading-none">
          <div className="font-display text-xl font-extrabold tracking-[-0.04em] text-white" dir="ltr">
            Power<span className="text-[#F5B800]">Hub</span>
          </div>
          <div className="mt-1 text-[10px] font-medium tracking-wide text-slate-400">منصة إدارة مولدات الكهرباء</div>
        </div>
      )}
    </div>
  );
}
