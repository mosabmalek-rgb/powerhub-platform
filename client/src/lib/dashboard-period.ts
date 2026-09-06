export type DashboardPeriodPreset = "today" | "7d" | "30d" | "month" | "custom";

export type DashboardPeriod = {
  preset: DashboardPeriodPreset;
  from: string;
  to: string;
};

const pad = (value: number) => String(value).padStart(2, "0");

export function formatDateInput(date: Date) {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

export function resolveDashboardPeriod(preset: Exclude<DashboardPeriodPreset, "custom">, now = new Date()): DashboardPeriod {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  let start: Date;
  if (preset === "today") start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  else if (preset === "7d") start = new Date(end); else if (preset === "30d") start = new Date(end); else start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  if (preset === "7d") start.setUTCDate(start.getUTCDate() - 7);
  if (preset === "30d") start.setUTCDate(start.getUTCDate() - 30);
  return { preset, from: formatDateInput(start), to: formatDateInput(new Date(end.getTime() - 1)) };
}

export function buildCustomDashboardPeriod(from: string, to: string): DashboardPeriod {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) {
    throw new Error("الفترة الزمنية غير صالحة.");
  }
  return { preset: "custom", from, to };
}

export const dashboardPeriodLabels: Record<DashboardPeriodPreset, string> = {
  today: "اليوم",
  "7d": "آخر 7 أيام",
  "30d": "آخر 30 يومًا",
  month: "هذا الشهر",
  custom: "مخصص",
};
