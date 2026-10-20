import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";

export type DashboardKpiPeriodPreset = "current_cycle" | "previous_cycle" | "last_month" | "custom";

export const dashboardKpiPeriodLabels: Record<DashboardKpiPeriodPreset, string> = {
  current_cycle: "الدورة الحالية",
  previous_cycle: "الدورة السابقة",
  last_month: "آخر شهر",
  custom: "مخصص",
};

function gazaDateKey(date: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Gaza",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function dashboardDateKey(value: unknown): string {
  if (typeof value === "string" && /^\\d{4}-\\d{2}-\\d{2}$/.test(value)) {
    return isValidDashboardDateInput(value) ? value : "";
  }
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? gazaDateKey(date) : "";
}

export function isValidDashboardDateInput(value: string): boolean {
  if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function previousMonthRange(now = new Date()) {
  const today = gazaDateKey(now);
  const [year, month] = today.split("-").map(Number);
  const start = new Date(Date.UTC(year, month - 2, 1));
  const end = new Date(Date.UTC(year, month - 1, 0));
  return { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) };
}

export type DashboardKpiPeriodInitial = {
  preset?: DashboardKpiPeriodPreset;
  startDate?: string;
  endDate?: string;
};

export function parseDashboardKpiPeriod(search: string): DashboardKpiPeriodInitial {
  const params = new URLSearchParams(search);
  const rawPreset = params.get("debtorPeriod") ?? params.get("kpiPeriod");
  const preset: DashboardKpiPeriodPreset =
    rawPreset === "previous_cycle" || rawPreset === "last_month" || rawPreset === "custom" || rawPreset === "current_cycle"
      ? rawPreset
      : "current_cycle";
  const startDate = params.get("startDate") ?? undefined;
  const endDate = params.get("endDate") ?? undefined;
  return {
    preset,
    ...(startDate && isValidDashboardDateInput(startDate) ? { startDate } : {}),
    ...(endDate && isValidDashboardDateInput(endDate) ? { endDate } : {}),
  };
}

export function useDashboardKpiPeriod(siteId?: number | null, initial?: DashboardKpiPeriodInitial) {
  const [preset, setPresetState] = useState<DashboardKpiPeriodPreset>(initial?.preset ?? "current_cycle");
  const fallbackToday = () => gazaDateKey(new Date());
  const [customStartDate, setCustomStartDate] = useState(initial?.startDate && isValidDashboardDateInput(initial.startDate) ? initial.startDate : fallbackToday());
  const [customEndDate, setCustomEndDate] = useState(initial?.endDate && isValidDashboardDateInput(initial.endDate) ? initial.endDate : fallbackToday());

  // The cycle boundaries are cached because they rarely change. Derive the effective
  // range directly from the query data, rather than updating two React states in an
  // effect and forcing a second render before the KPI query can start.
  const currentBoundsQuery = trpc.powerhub.readingCycle.currentBounds.useQuery(
    { siteId: siteId ?? 1 },
    { enabled: Boolean(siteId), staleTime: 60_000 },
  );
  const previousReferenceAt = useMemo(() => {
    const startAt = currentBoundsQuery.data?.startAt;
    if (!startAt) return new Date().toISOString();
    const startTime = new Date(startAt).getTime();
    return Number.isFinite(startTime) ? new Date(startTime - 1).toISOString() : new Date().toISOString();
  }, [currentBoundsQuery.data?.startAt]);
  const previousBoundsQuery = trpc.powerhub.readingCycle.boundsAt.useQuery(
    { siteId: siteId ?? 1, referenceAt: previousReferenceAt },
    {
      enabled: Boolean(siteId && preset === "previous_cycle" && currentBoundsQuery.data?.startAt),
      staleTime: 60_000,
    },
  );
  const lastMonth = useMemo(() => previousMonthRange(), [siteId]);

  const currentCycleRange = currentBoundsQuery.data
    ? { startDate: dashboardDateKey(currentBoundsQuery.data.startAt), endDate: dashboardDateKey(currentBoundsQuery.data.endAt) }
    : null;
  const previousCycleRange = previousBoundsQuery.data
    ? { startDate: dashboardDateKey(previousBoundsQuery.data.startAt), endDate: dashboardDateKey(previousBoundsQuery.data.endAt) }
    : null;
  const effectiveRange = preset === "current_cycle" && currentCycleRange?.startDate && currentCycleRange.endDate
    ? currentCycleRange
    : preset === "previous_cycle" && previousCycleRange?.startDate && previousCycleRange.endDate
      ? previousCycleRange
      : preset === "last_month"
        ? lastMonth
        : { startDate: customStartDate, endDate: customEndDate };

  const datesValid = isValidDashboardDateInput(effectiveRange.startDate) &&
    isValidDashboardDateInput(effectiveRange.endDate) &&
    effectiveRange.startDate <= effectiveRange.endDate;
  const rangeReady = preset === "current_cycle"
    ? Boolean(currentCycleRange?.startDate && currentCycleRange.endDate)
    : preset === "previous_cycle"
      ? Boolean(currentCycleRange?.startDate && currentCycleRange.endDate && previousCycleRange?.startDate && previousCycleRange.endDate)
      : preset === "last_month"
        ? datesValid
        : datesValid;
  const isLoading = Boolean(siteId && (
    (preset === "current_cycle" && currentBoundsQuery.isLoading) ||
    (preset === "previous_cycle" && (currentBoundsQuery.isLoading || (Boolean(currentBoundsQuery.data?.startAt) && previousBoundsQuery.isLoading)))
  ));
  const isError = Boolean(siteId && (
    (preset === "current_cycle" && currentBoundsQuery.isError) ||
    (preset === "previous_cycle" && (currentBoundsQuery.isError || previousBoundsQuery.isError))
  ));

  const setPreset = (next: DashboardKpiPeriodPreset) => {
    setPresetState(next);
  };

  const retry = () => {
    void currentBoundsQuery.refetch();
    if (preset === "previous_cycle" && currentBoundsQuery.data?.startAt) void previousBoundsQuery.refetch();
  };

  return {
    preset,
    setPreset,
    startDate: effectiveRange.startDate,
    endDate: effectiveRange.endDate,
    setStartDate: setCustomStartDate,
    setEndDate: setCustomEndDate,
    isReady: Boolean(siteId && datesValid && rangeReady && !isError),
    isLoading,
    isError,
    retry,
    label: dashboardKpiPeriodLabels[preset],
  };
}
