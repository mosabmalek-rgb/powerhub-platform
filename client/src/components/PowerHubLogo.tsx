import { useOptionalTheme } from "@/contexts/ThemeContext";
import { cn } from "@/lib/utils";

const LIGHT_LOGO_SRC = "/manus-storage/powerhub-official-logo_0bcbb9c6.png";
const DARK_POWER_OUTLINE_LOGO_SRC = "/manus-storage/powerhub-logo-dark-transparent-clean_7dab96ea.png";

export function PowerHubLogo({ compact = false, header = false, className }: { compact?: boolean; header?: boolean; className?: string }) {
  const theme = useOptionalTheme()?.theme;
  const sizeClasses = compact ? "h-9 max-w-[76px]" : header ? "h-[62px] max-w-[200px] sm:h-[73px] sm:max-w-[239px]" : "h-12 max-w-[154px] sm:h-14 sm:max-w-[184px]";

  return (
    <div className={cn("relative flex items-center", className)}>
      <img
        src={LIGHT_LOGO_SRC}
        alt="PowerHub — منصة إدارة مولدات الكهرباء"
        className={cn("w-auto object-contain object-right", sizeClasses, theme === "dark" && "opacity-0")}
      />
      <img
        src={DARK_POWER_OUTLINE_LOGO_SRC}
        alt=""
        aria-hidden="true"
        className={cn("pointer-events-none absolute right-0 top-0 h-auto w-auto object-contain object-right", sizeClasses, theme === "dark" ? "opacity-100" : "opacity-0")}
      />
    </div>
  );
}
