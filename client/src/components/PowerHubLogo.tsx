import { cn } from "@/lib/utils";

export function PowerHubLogo({ compact = false, className }: { compact?: boolean; className?: string }) {
  return (
    <div className={cn("flex items-center", className)}>
      <img
        src="/manus-storage/powerhub-official-logo_0bcbb9c6.png"
        alt="PowerHub — منصة إدارة مولدات الكهرباء"
        className={cn("w-auto object-contain object-right", compact ? "h-9 max-w-[76px]" : "h-12 max-w-[154px] sm:h-14 sm:max-w-[184px]")}
      />
    </div>
  );
}
