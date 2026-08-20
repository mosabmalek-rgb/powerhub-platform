import { useOptionalTheme } from "@/contexts/ThemeContext";
import { cn } from "@/lib/utils";

const LIGHT_LOGO_SRC = "/manus-storage/powerhub-official-logo_0bcbb9c6.png";
const DARK_POWER_OUTLINE_LOGO_SRC = "/manus-storage/powerhub-logo-dark-power-hollow-stroke_ed9d584d.png";

export function PowerHubLogo({ compact = false, header = false, className }: { compact?: boolean; header?: boolean; className?: string }) {
  const theme = useOptionalTheme()?.theme;
  const logoSource = theme === "dark" ? DARK_POWER_OUTLINE_LOGO_SRC : LIGHT_LOGO_SRC;

  return (
    <div className={cn("flex items-center", className)}>
      <img
        src={logoSource}
        alt="PowerHub — منصة إدارة مولدات الكهرباء"
        className={cn("w-auto object-contain object-right", compact ? "h-9 max-w-[76px]" : header ? "h-[62px] max-w-[200px] sm:h-[73px] sm:max-w-[239px]" : "h-12 max-w-[154px] sm:h-14 sm:max-w-[184px]")}
      />
    </div>
  );
}
