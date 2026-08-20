import { cn } from "@/lib/utils";

export function PowerHubLogo({ compact = false, header = false, className }: { compact?: boolean; header?: boolean; className?: string }) {
  return (
    <div className={cn("flex items-center", className)}>
      <img
        src="/manus-storage/powerhub-official-logo_0bcbb9c6.png"
        alt="PowerHub — منصة إدارة مولدات الكهرباء"
        className={cn("w-auto object-contain object-right", compact ? "h-9 max-w-[76px]" : header ? "h-[62px] max-w-[200px] sm:h-[73px] sm:max-w-[239px]" : "h-12 max-w-[154px] sm:h-14 sm:max-w-[184px]")}
      />
    </div>
  );
}
