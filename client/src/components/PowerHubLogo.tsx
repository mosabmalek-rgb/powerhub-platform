import { cn } from "@/lib/utils";
import { useOptionalTheme } from "@/contexts/ThemeContext";

const LIGHT_LOGO_URL = "/manus-storage/powerhub-logo-light-final_50a6ca98.png";
const DARK_LOGO_URL = "/manus-storage/powerhub-logo-dark-final_e0d771c8.png";

export function PowerHubLogo({ compact = false, header = false, className }: { compact?: boolean; header?: boolean; className?: string }) {
  const theme = useOptionalTheme();
  const logoUrl = theme?.theme === "dark" ? DARK_LOGO_URL : LIGHT_LOGO_URL;
  const imageSize = compact
    ? "h-9 w-[9.5rem]"
    : header
      ? "h-[4.25rem] w-[13.5rem] sm:h-24 sm:w-[18rem]"
      : "h-[3.75rem] w-[12rem] sm:h-[4.5rem] sm:w-[14.5rem]";

  return (
    <div
      role="img"
      aria-label="PowerHub — منصة إدارة مولدات الكهرباء"
      data-logo-theme={theme?.theme ?? "light"}
      className={cn("flex shrink-0 items-center overflow-hidden", className)}
    >
      <img
        src={logoUrl}
        alt=""
        aria-hidden="true"
        draggable={false}
        className={cn("block object-contain object-center", imageSize)}
      />
    </div>
  );
}

export { LIGHT_LOGO_URL, DARK_LOGO_URL };
