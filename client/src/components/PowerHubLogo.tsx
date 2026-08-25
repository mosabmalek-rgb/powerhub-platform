import { Zap } from "lucide-react";
import { cn } from "@/lib/utils";

export function PowerHubLogo({ compact = false, header = false, className }: { compact?: boolean; header?: boolean; className?: string }) {
  const iconSize = compact ? "size-7" : header ? "size-11 sm:size-[52px]" : "size-9 sm:size-10";
  const wordSize = compact ? "text-lg" : header ? "text-3xl sm:text-4xl" : "text-2xl sm:text-3xl";

  return (
    <div className={cn("flex items-center gap-2.5 text-foreground", className)} aria-label="PowerHub — منصة إدارة مولدات الكهرباء">
      <span className={cn("grid shrink-0 place-items-center rounded-xl bg-[#F5B800] text-[#10151e] shadow-[0_0_0_1px_rgba(245,184,0,.35)]", iconSize)} aria-hidden="true">
        <Zap className={compact ? "size-4" : header ? "size-6 sm:size-7" : "size-5"} strokeWidth={2.6} />
      </span>
      <span className={cn("font-display font-black tracking-[-0.06em] leading-none", wordSize)} dir="ltr">
        <span className="text-[#E5A900]">Power</span><span className="text-foreground">Hub</span>
      </span>
    </div>
  );
}
