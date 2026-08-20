import { useOptionalTheme } from "@/contexts/ThemeContext";
import { Moon, Sun } from "lucide-react";

export function ThemeSelector({ compact = false }: { compact?: boolean }) {
  const themeContext = useOptionalTheme();
  if (!themeContext?.setTheme) return null;
  const { theme, setTheme } = themeContext;

  const buttonClass = (active: boolean) => `flex h-9 items-center justify-center gap-1.5 rounded-lg px-2.5 text-xs font-extrabold transition ${active ? "bg-[#F5B800] text-[#0D1117] shadow-sm" : "text-slate-500 hover:bg-white/70 hover:text-[#17212b]"}`;

  return (
    <div role="group" aria-label="اختيار الثيم" className="flex items-center rounded-xl border border-[#dbe3ec] bg-[#f8fafc] p-1 shadow-sm">
      <button type="button" aria-label="اختيار الثيم الفاتح" aria-pressed={theme === "light"} onClick={() => setTheme("light")} className={buttonClass(theme === "light")}><Sun className="h-3.5 w-3.5" /><span className={compact ? "hidden lg:inline" : "hidden sm:inline"}>فاتح</span></button>
      <button type="button" aria-label="اختيار الثيم الداكن" aria-pressed={theme === "dark"} onClick={() => setTheme("dark")} className={buttonClass(theme === "dark")}><Moon className="h-3.5 w-3.5" /><span className={compact ? "hidden lg:inline" : "hidden sm:inline"}>داكن</span></button>
    </div>
  );
}
