import { cn } from "@/lib/utils";
import { useOptionalTheme } from "@/contexts/ThemeContext";

export const LIGHT_LOGO_URL = "/api/brand-assets/powerhub-logo-light.png?v=20260904";
export const DARK_LOGO_URL = "/api/brand-assets/powerhub-logo-dark.png?v=20260904";
const LIGHT_LOGO_FALLBACK_URL = "/api/brand-assets/powerhub-logo-light.png";
const DARK_LOGO_FALLBACK_URL = "/api/brand-assets/powerhub-logo-dark.png";

export function PowerHubLogo({ compact = false, header = false, size = "default", className }: { compact?: boolean; header?: boolean; size?: "default" | "invoice"; className?: string }) {
  const theme = useOptionalTheme();
  const isDark = theme?.theme === "dark";
  const logoUrl = isDark ? DARK_LOGO_URL : LIGHT_LOGO_URL;
  const fallbackUrl = isDark ? DARK_LOGO_FALLBACK_URL : LIGHT_LOGO_FALLBACK_URL;
  const imageSize = size === "invoice"
    ? "h-[6.75rem] w-[21.6rem] max-w-full sm:h-[8.1rem] sm:w-[26.1rem]"
    : compact
      ? "h-9 w-[9.5rem]"
      : header
        ? "h-[3.5rem] w-[11rem] md:h-[4.25rem] md:w-[13.5rem] xl:h-24 xl:w-[18rem]"
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
        onError={(event) => {
          const image = event.currentTarget;
          if (!image.dataset.fallbackApplied) {
            image.dataset.fallbackApplied = "true";
            image.src = fallbackUrl;
          }
        }}
        className={cn("block object-contain object-center", imageSize)}
      />
    </div>
  );
}
