import { cn } from "@/lib/utils";
import { useOptionalTheme } from "@/contexts/ThemeContext";

export const LIGHT_LOGO_URL = "/brand-v1/powerhub-logo-light.webp?v=lossless-20261014";
export const DARK_LOGO_URL = "/brand-v1/powerhub-logo-dark.webp?v=lossless-20261014";
const LIGHT_LOGO_FALLBACK_URL = "/api/brand-assets/powerhub-logo-light.png";
const DARK_LOGO_FALLBACK_URL = "/api/brand-assets/powerhub-logo-dark.png";

export function PowerHubLogo({ compact = false, header = false, marketing = false, size = "default", className }: { compact?: boolean; header?: boolean; marketing?: boolean; size?: "default" | "invoice"; className?: string }) {
  const theme = useOptionalTheme();
  const isDark = theme?.theme === "dark";
  const logoUrl = isDark ? DARK_LOGO_URL : LIGHT_LOGO_URL;
  const fallbackUrl = isDark ? DARK_LOGO_FALLBACK_URL : LIGHT_LOGO_FALLBACK_URL;
  const imageSize = size === "invoice"
    ? "h-[6.75rem] w-[21.6rem] max-w-full sm:h-[8.1rem] sm:w-[26.1rem]"
    : compact
      ? "h-9 w-[9.5rem]"
      : marketing && header
        ? "h-[4.55rem] w-[15.4rem] min-[400px]:h-[4.9rem] min-[400px]:w-[16.1rem] sm:h-[5.25rem] sm:w-[17.5rem] md:h-[5.6rem] md:w-[18.9rem] xl:h-[5.95rem] xl:w-[20.3rem]"
        : marketing
          ? "h-[4.25rem] w-[13.5rem] sm:h-[5rem] sm:w-[16.5rem]"
          : header
            ? "h-[3rem] w-[10rem] min-[400px]:h-[3.25rem] min-[400px]:w-[10.5rem] sm:h-[3.5rem] sm:w-[11.5rem] md:h-[3.75rem] md:w-[12rem] xl:h-[4rem] xl:w-[13rem]"
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
        className={cn("block shrink-0 object-contain object-center", imageSize)}
      />
    </div>
  );
}
