import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { loadOperationalReportSnapshot, saveOperationalReportSnapshot } from "@/lib/offline-operational-report-cache";
import { isExplicitAuthorizationDenial } from "@/lib/offline-query-errors";
import { Droplet, Gauge, Loader2, RefreshCw, Save } from "lucide-react";
import { toast } from "sonner";

type Props = {
  siteId: number;
  isAuthenticated: boolean;
  canManageFuelAndConsumption: boolean;
  canViewInventoryReports: boolean;
};

type FuelGenerator = { id: number; name: string; code?: string | null; fuelLevelLiters: number | string; operatingHours: number | string };
type FuelEvent = {
  event_id: number; generator_id: number; generator_name: string; fuel_item_name: string;
  source_warehouse_name: string; destination_warehouse_name: string; litres: number | string;
  unit_cost?: number | string; total_cost_amount?: number | string; occurred_at: string;
  level_before_liters: number | string | null; level_after_liters: number | string | null;
  operating_hours: number | string | null; reference_no: string | null; notes: string | null;
  stock_transfer_id: number; created_by_user_id: number | null;
};
type FuelReading = {
  reading_id: number; generator_id: number; generator_name: string; reading_type: "tank_level" | "operating_hours";
  tank_warehouse_id: number | null; tank_name: string | null; reading_value: number | string;
  recorded_at: string; reference_no: string | null; notes: string | null;
  corrects_reading_id: number | null; correction_reason: string | null;
};
type FuelAlertSetting = {
  setting_id: number; generator_id: number; generator_name: string; tank_warehouse_id: number; tank_name: string;
  low_level_threshold_liters: number | string | null; abnormal_litres_per_hour_threshold: number | string | null;
  minimum_hours_delta: number | string; is_enabled: boolean; updated_at: string;
  low_level_alert_active: boolean; low_level_last_triggered_at: string | null;
  abnormal_alert_active: boolean; abnormal_last_triggered_at: string | null;
};
type FuelAlertDispatch = {
  dispatch_id: number; setting_id: number; alert_type: "low_fuel_level" | "abnormal_consumption";
  episode_no: number; generator_id: number; generator_name: string; tank_warehouse_id: number; tank_name: string;
  signal_key: string; measured_value: number | string; threshold_value: number | string;
  recipient_count: number; created_at: string;
};
type FuelReportRow = {
  generator_id: number; generator_name: string; tank_warehouse_id: number; tank_name: string;
  fuel_filled_liters: number | string; fuel_filled_cost: number | string; recorded_consumption_liters: number | string;
  opening_level_liters: number | string | null; ending_level_liters: number | string | null;
  actual_consumption_liters: number | string | null;
  opening_operating_hours: number | string | null; ending_operating_hours: number | string | null;
  operating_hours_delta: number | string | null; litres_per_hour: number | string | null;
  measurement_status: "measured" | "insufficient_level_readings" | "reconciliation_anomaly" | "measured_without_hour_rate" | string;
};

function nowLocalDateTime() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
function todayLocalDate() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}
function operationKey(prefix: string) {
  const random = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}:${random}`;
}
function qty(value: number | string | null | undefined) {
  const amount = Number(value);
  return value == null || !Number.isFinite(amount) ? "—" : new Intl.NumberFormat("ar-PS", { maximumFractionDigits: 3 }).format(amount);
}
function money(value: number | string | null | undefined) {
  const amount = Number(value);
  return value == null || !Number.isFinite(amount) ? "—" : `₪${new Intl.NumberFormat("ar-PS", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount)}`;
}
function dateTime(value: string | null | undefined) {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("ar-PS");
}
const readingLabels: Record<string, string> = { tank_level: "مستوى الخزان", operating_hours: "ساعات التشغيل" };
const statusLabels: Record<string, string> = {
  measured: "استهلاك مقاس",
  insufficient_level_readings: "قراءات مستوى غير كافية",
  reconciliation_anomaly: "تعارض في التسوية",
  measured_without_hour_rate: "استهلاك مقاس دون معدل ساعات موثوق",
};

export default function InventoryFuelConsumptionPanel({
  siteId, isAuthenticated, canManageFuelAndConsumption, canViewInventoryReports,
}: Props) {
  const utils = trpc.useUtils();
  const auth = useAuth();
  const today = useMemo(() => todayLocalDate(), []);
  const [generatorId, setGeneratorId] = useState("");
  const [fuelItemId, setFuelItemId] = useState("");
  const [sourceWarehouseId, setSourceWarehouseId] = useState("");
  const [destinationWarehouseId, setDestinationWarehouseId] = useState("");
  const [litres, setLitres] = useState("");
  const [fillAt, setFillAt] = useState(nowLocalDateTime);
  const [levelBefore, setLevelBefore] = useState("");
  const [levelAfter, setLevelAfter] = useState("");
  const [fillOperatingHours, setFillOperatingHours] = useState("");
  const [fillReference, setFillReference] = useState("");
  const [fillNotes, setFillNotes] = useState("");
  const [fillKey, setFillKey] = useState(() => operationKey("fuel-fill"));

  const [readingGeneratorId, setReadingGeneratorId] = useState("");
  const [readingType, setReadingType] = useState<"tank_level" | "operating_hours">("tank_level");
  const [readingTankId, setReadingTankId] = useState("");
  const [readingValue, setReadingValue] = useState("");
  const [readingAt, setReadingAt] = useState(nowLocalDateTime);
  const [readingReference, setReadingReference] = useState("");
  const [readingNotes, setReadingNotes] = useState("");
  const [correctsReadingId, setCorrectsReadingId] = useState("");
  const [correctionReason, setCorrectionReason] = useState("");
  const [readingKey, setReadingKey] = useState(() => operationKey("fuel-reading"));

  const [fromDate, setFromDate] = useState(() => today);
  const [toDate, setToDate] = useState(() => today);
  const [reportGeneratorId, setReportGeneratorId] = useState("");
  const [reportPeriodType, setReportPeriodType] = useState<"day" | "cycle" | "month" | "custom">("day");
  const [reportAnchorDate, setReportAnchorDate] = useState(() => today);
  const [reportFromDate, setReportFromDate] = useState(() => today);
  const [reportToDate, setReportToDate] = useState(() => today);
  const [reportTankId, setReportTankId] = useState("");
  const [alertLowThreshold, setAlertLowThreshold] = useState("");
  const [alertRateThreshold, setAlertRateThreshold] = useState("");
  const [alertMinimumHours, setAlertMinimumHours] = useState("1");
  const [alertsEnabled, setAlertsEnabled] = useState(true);
  const [alertGeneratorId, setAlertGeneratorId] = useState("");
  const [alertTankId, setAlertTankId] = useState("");
  const [alertSettingKey, setAlertSettingKey] = useState(() => operationKey("fuel-alert-settings"));

  const options = trpc.powerhub.inventory.fuelWorkspaceOptions.useQuery(
    { siteId },
    { enabled: Boolean(siteId && isAuthenticated && (canManageFuelAndConsumption || canViewInventoryReports)), staleTime: 20_000 },
  );
  const optionsAuthorizationDenied = isExplicitAuthorizationDenial(options.error);
  const workspaceOptions = optionsAuthorizationDenied ? undefined : options.data;
  const generators = (workspaceOptions?.generators ?? []) as FuelGenerator[];
  const activeGeneratorId = generatorId || String(generators[0]?.id ?? "");
  const activeReadingGeneratorId = readingGeneratorId || String(generators[0]?.id ?? "");
  const activeReportGeneratorId = reportGeneratorId || "";
  const tanks = workspaceOptions?.generatorTanks ?? [];
  const generatorTanks = tanks.filter((tank) => tank.generatorId === Number(activeGeneratorId));
  const readingTanks = tanks.filter((tank) => tank.generatorId === Number(activeReadingGeneratorId));
  const activeAlertGeneratorId = alertGeneratorId || String(generators[0]?.id ?? "");
  const alertTanks = tanks.filter((tank) => tank.generatorId === Number(activeAlertGeneratorId));

  const events = trpc.powerhub.inventory.listFuelEvents.useQuery(
    { siteId, fromDate: fromDate || undefined, toDate: toDate || undefined,
      generatorId: activeReportGeneratorId ? Number(activeReportGeneratorId) : undefined, limit: 100 },
    { enabled: Boolean(siteId && isAuthenticated && (canManageFuelAndConsumption || canViewInventoryReports)), staleTime: 10_000 },
  );
  // This unfiltered latest-100 feed is the persisted Delta snapshot. Filtered
  // history remains server-authoritative and is never presented as complete offline.
  const recentEvents = trpc.powerhub.inventory.listFuelEvents.useQuery(
    { siteId, limit: 100 },
    { enabled: Boolean(siteId && isAuthenticated && (canManageFuelAndConsumption || canViewInventoryReports)) },
  );
  const readings = trpc.powerhub.inventory.listFuelReadings.useQuery(
    { siteId, generatorId: activeReportGeneratorId ? Number(activeReportGeneratorId) : undefined, limit: 100 },
    { enabled: Boolean(siteId && isAuthenticated && (canManageFuelAndConsumption || canViewInventoryReports)), staleTime: 10_000 },
  );
  // Only the unfiltered site-wide latest-100 reading list is Delta-backed.
  // It provides an honest offline fallback when the selected-generator query is unavailable.
  const recentReadings = trpc.powerhub.inventory.listFuelReadings.useQuery(
    { siteId, limit: 100 },
    { enabled: Boolean(siteId && isAuthenticated && (canManageFuelAndConsumption || canViewInventoryReports)) },
  );
  const eventsAuthorizationDenied = isExplicitAuthorizationDenial(events.error);
  const recentEventsAuthorizationDenied = isExplicitAuthorizationDenial(recentEvents.error);
  const readingsAuthorizationDenied = isExplicitAuthorizationDenial(readings.error);
  const recentReadingsAuthorizationDenied = isExplicitAuthorizationDenial(recentReadings.error);
  const report = trpc.powerhub.inventory.fuelConsumptionReportPeriod.useQuery(
    {
      siteId,
      periodType: reportPeriodType,
      anchorDate: reportPeriodType === "custom" ? undefined : reportAnchorDate,
      fromDate: reportPeriodType === "custom" ? reportFromDate : undefined,
      toDate: reportPeriodType === "custom" ? reportToDate : undefined,
      generatorId: activeReportGeneratorId ? Number(activeReportGeneratorId) : undefined,
      tankWarehouseId: reportTankId ? Number(reportTankId) : undefined,
    },
    { enabled: Boolean(siteId && isAuthenticated && canViewInventoryReports &&
      (reportPeriodType === "custom" ? reportFromDate && reportToDate && reportFromDate <= reportToDate : reportAnchorDate)), staleTime: 15_000 },
  );
  const reportAuthorizationDenied = isExplicitAuthorizationDenial(report.error);
  const fuelReportCacheInput = auth.user?.id ? {
    userId: auth.user.id,
    siteId,
    reportType: "fuel-consumption" as const,
    filters: {
      periodType: reportPeriodType,
      anchorDate: reportPeriodType === "custom" ? null : reportAnchorDate,
      fromDate: reportPeriodType === "custom" ? reportFromDate : null,
      toDate: reportPeriodType === "custom" ? reportToDate : null,
      generatorId: activeReportGeneratorId ? Number(activeReportGeneratorId) : null,
      tankWarehouseId: reportTankId ? Number(reportTankId) : null,
    },
  } : null;
  const fuelReportCacheKey = fuelReportCacheInput ? JSON.stringify([fuelReportCacheInput.userId, fuelReportCacheInput.siteId, fuelReportCacheInput.reportType, fuelReportCacheInput.filters]) : null;
  const [cachedFuelReport, setCachedFuelReport] = useState<{ key: string; rows: FuelReportRow[]; savedAt: number } | null>(null);
  const cachedFuelReportForCurrentScope = !reportAuthorizationDenied && cachedFuelReport && cachedFuelReport.key === fuelReportCacheKey ? cachedFuelReport : null;
  useEffect(() => {
    let current = true;
    setCachedFuelReport(null);
    if (!fuelReportCacheInput || !canViewInventoryReports) return () => { current = false; };
    void loadOperationalReportSnapshot(fuelReportCacheInput, { accessAllowed: canViewInventoryReports })
      .then((snapshot) => {
        if (current && snapshot) setCachedFuelReport({ key: snapshot.key, rows: snapshot.rows as FuelReportRow[], savedAt: snapshot.savedAt });
      })
      .catch(() => undefined);
    return () => { current = false; };
  }, [auth.user?.id, siteId, canViewInventoryReports, reportPeriodType, reportAnchorDate, reportFromDate, reportToDate, activeReportGeneratorId, reportTankId]);
  useEffect(() => {
    if (!fuelReportCacheInput || !canViewInventoryReports || !report.isSuccess || !report.isFetchedAfterMount || !Array.isArray(report.data)) return;
    void saveOperationalReportSnapshot({ ...fuelReportCacheInput, rows: report.data }).catch(() => undefined);
  }, [auth.user?.id, siteId, canViewInventoryReports, report.isSuccess, report.isFetchedAfterMount, report.data, reportPeriodType, reportAnchorDate, reportFromDate, reportToDate, activeReportGeneratorId, reportTankId]);
  const alertSettings = trpc.powerhub.inventory.listFuelAlertSettings.useQuery(
    { siteId },
    { enabled: Boolean(siteId && isAuthenticated && (canManageFuelAndConsumption || canViewInventoryReports)), staleTime: 15_000 },
  );
  const alertDispatches = trpc.powerhub.inventory.listFuelAlertDispatches.useQuery(
    {
      siteId,
      generatorId: activeReportGeneratorId ? Number(activeReportGeneratorId) : undefined,
      tankWarehouseId: reportTankId ? Number(reportTankId) : undefined,
      limit: 50,
    },
    { enabled: Boolean(siteId && isAuthenticated && (canManageFuelAndConsumption || canViewInventoryReports)), staleTime: 15_000 },
  );
  const alertSettingsAuthorizationDenied = isExplicitAuthorizationDenial(alertSettings.error);
  const alertDispatchesAuthorizationDenied = isExplicitAuthorizationDenial(alertDispatches.error);
  const selectedAlertSetting = ((alertSettingsAuthorizationDenied ? [] : alertSettings.data ?? []) as FuelAlertSetting[]).find((row) =>
    Number(row.generator_id) === Number(activeAlertGeneratorId) &&
    Number(row.tank_warehouse_id) === Number(alertTankId),
  );

  useEffect(() => {
    if (!generators.some((row) => String(row.id) === generatorId) && generators[0]) setGeneratorId(String(generators[0].id));
    if (!generators.some((row) => String(row.id) === readingGeneratorId) && generators[0]) setReadingGeneratorId(String(generators[0].id));
    if (!generators.some((row) => String(row.id) === reportGeneratorId) && reportGeneratorId) setReportGeneratorId("");
  }, [generators, generatorId, readingGeneratorId, reportGeneratorId]);

  useEffect(() => {
    if (!generatorTanks.some((tank) => String(tank.id) === destinationWarehouseId)) {
      setDestinationWarehouseId(String(generatorTanks[0]?.id ?? ""));
    }
  }, [generatorTanks, destinationWarehouseId]);
  useEffect(() => {
    if (!readingTanks.some((tank) => String(tank.id) === readingTankId)) {
      setReadingTankId(String(readingTanks[0]?.id ?? ""));
    }
  }, [readingTanks, readingTankId]);
  useEffect(() => {
    const sources = workspaceOptions?.sourceLocations ?? [];
    if (!sources.some((row) => String(row.id) === sourceWarehouseId)) setSourceWarehouseId(String(sources[0]?.id ?? ""));
  }, [workspaceOptions?.sourceLocations, sourceWarehouseId]);
  useEffect(() => {
    const items = workspaceOptions?.fuelItems ?? [];
    if (!items.some((row) => String(row.id) === fuelItemId)) setFuelItemId(String(items[0]?.id ?? ""));
  }, [workspaceOptions?.fuelItems, fuelItemId]);

  useEffect(() => {
    if (!generators.some((row) => String(row.id) === alertGeneratorId) && generators[0]) {
      setAlertGeneratorId(String(generators[0].id));
    }
  }, [generators, alertGeneratorId]);

  useEffect(() => {
    if (!alertTanks.some((tank) => String(tank.id) === alertTankId)) {
      setAlertTankId(String(alertTanks[0]?.id ?? ""));
    }
  }, [alertTanks, alertTankId]);

  useEffect(() => {
    setAlertLowThreshold(selectedAlertSetting?.low_level_threshold_liters == null ? "" : String(selectedAlertSetting.low_level_threshold_liters));
    setAlertRateThreshold(selectedAlertSetting?.abnormal_litres_per_hour_threshold == null ? "" : String(selectedAlertSetting.abnormal_litres_per_hour_threshold));
    setAlertMinimumHours(selectedAlertSetting ? String(selectedAlertSetting.minimum_hours_delta) : "1");
    setAlertsEnabled(selectedAlertSetting?.is_enabled ?? true);
  }, [
    activeAlertGeneratorId, alertTankId, selectedAlertSetting?.setting_id,
    selectedAlertSetting?.low_level_threshold_liters, selectedAlertSetting?.abnormal_litres_per_hour_threshold,
    selectedAlertSetting?.minimum_hours_delta, selectedAlertSetting?.is_enabled,
  ]);

  const fillMutation = trpc.powerhub.inventory.recordFuelFill.useMutation({
    onSuccess: async (result) => {
      toast.success(result.replayed ? "تم تأكيد التعبئة السابقة دون تكرار حركة المخزون." : `تم تسجيل التعبئة ${qty(result.litres)} لتر وترحيلها إلى خزان المولد.`);
      setLitres(""); setLevelBefore(""); setLevelAfter(""); setFillOperatingHours(""); setFillReference(""); setFillNotes("");
      setFillAt(nowLocalDateTime()); setFillKey(operationKey("fuel-fill"));
      await Promise.all([
        utils.powerhub.inventory.listFuelEvents.invalidate(),
        utils.powerhub.inventory.listFuelReadings.invalidate(),
        utils.powerhub.inventory.fuelConsumptionReport.invalidate(),
        utils.powerhub.inventory.fuelConsumptionReportPeriod.invalidate(),
        utils.powerhub.inventory.listFuelAlertSettings.invalidate(),
        utils.powerhub.inventory.listFuelAlertDispatches.invalidate(),
        utils.powerhub.inventory.stockOverview.invalidate({ siteId }),
        utils.powerhub.inventory.listStockMovements.invalidate({ siteId }),
      ]);
    },
    onError: (error) => toast.error(error.message || "تعذر تسجيل تعبئة الوقود."),
  });
  const readingMutation = trpc.powerhub.inventory.recordFuelReading.useMutation({
    onSuccess: async (result) => {
      toast.success(result.replayed ? "هذه القراءة مسجلة مسبقًا." : "تم حفظ القراءة كسجل تاريخي؛ لا تُعدّل القراءات السابقة.");
      setReadingValue(""); setReadingReference(""); setReadingNotes(""); setCorrectsReadingId(""); setCorrectionReason("");
      setReadingAt(nowLocalDateTime()); setReadingKey(operationKey("fuel-reading"));
      await Promise.all([
        utils.powerhub.inventory.listFuelReadings.invalidate(),
        utils.powerhub.inventory.fuelConsumptionReport.invalidate(),
        utils.powerhub.inventory.fuelConsumptionReportPeriod.invalidate(),
        utils.powerhub.inventory.listFuelAlertSettings.invalidate(),
        utils.powerhub.inventory.listFuelAlertDispatches.invalidate(),
      ]);
    },
    onError: (error) => toast.error(error.message || "تعذر تسجيل القراءة."),
  });
  const alertSettingsMutation = trpc.powerhub.inventory.upsertFuelAlertSettings.useMutation({
    onSuccess: async (result) => {
      toast.success(result.replayed ? "تم تأكيد إعدادات التنبيه السابقة دون إنشاء نسخة." : "تم حفظ إعدادات تنبيهات الوقود وتدقيق العملية.");
      setAlertSettingKey(operationKey("fuel-alert-settings"));
      await Promise.all([
        utils.powerhub.inventory.listFuelAlertSettings.invalidate(),
        utils.powerhub.inventory.listFuelAlertDispatches.invalidate(),
      ]);
    },
    onError: (error) => toast.error(error.message || "تعذر حفظ إعدادات تنبيهات الوقود."),
  });

  const submitFill = (event: FormEvent) => {
    event.preventDefault();
    const quantity = Number(litres);
    const before = levelBefore.trim() ? Number(levelBefore) : null;
    const after = levelAfter.trim() ? Number(levelAfter) : null;
    const hours = fillOperatingHours.trim() ? Number(fillOperatingHours) : null;
    if (!activeGeneratorId || !fuelItemId || !sourceWarehouseId || !destinationWarehouseId) {
      toast.error("اختر المولد وصنف الوقود وموقع المصدر وخزان المولد."); return;
    }
    if (!Number.isFinite(quantity) || quantity <= 0 || Math.abs(quantity * 1000 - Math.round(quantity * 1000)) > 1e-7) {
      toast.error("أدخل كمية موجبة لا تتجاوز ثلاث منازل عشرية."); return;
    }
    if ((before == null) !== (after == null) || (before != null && after != null && after < before)) {
      toast.error("أدخل مستوى الخزان قبل التعبئة وبعدها معًا، واجعل المستوى بعد التعبئة مساويًا أو أعلى."); return;
    }
    if ([before, after, hours].some((value) => value != null && (!Number.isFinite(value) || value < 0 || Math.abs(value * 1000 - Math.round(value * 1000)) > 1e-7))) {
      toast.error("المستويات وساعات التشغيل يجب أن تكون أرقامًا غير سالبة وبحد أقصى ثلاث منازل عشرية."); return;
    }
    fillMutation.mutate({
      siteId, generatorId: Number(activeGeneratorId), fuelItemId: Number(fuelItemId),
      sourceWarehouseId: Number(sourceWarehouseId), destinationWarehouseId: Number(destinationWarehouseId),
      litres: quantity, occurredAt: new Date(fillAt).toISOString(),
      levelBeforeLiters: before, levelAfterLiters: after, operatingHours: hours,
      referenceNo: fillReference.trim() || undefined, notes: fillNotes.trim() || undefined, operationKey: fillKey,
    });
  };

  const submitReading = (event: FormEvent) => {
    event.preventDefault();
    const parsedValue = Number(readingValue);
    if (!activeReadingGeneratorId || !Number.isFinite(parsedValue) || parsedValue < 0 ||
        Math.abs(parsedValue * 1000 - Math.round(parsedValue * 1000)) > 1e-7) {
      toast.error("أدخل المولد وقراءة غير سالبة حتى ثلاث منازل عشرية."); return;
    }
    if (readingType === "tank_level" && !readingTankId) { toast.error("اختر خزانًا مرتبطًا بالمولد."); return; }
    if (correctsReadingId.trim() && !correctionReason.trim()) { toast.error("أدخل سببًا موثقًا لتصحيح القراءة."); return; }
    readingMutation.mutate({
      siteId, generatorId: Number(activeReadingGeneratorId), readingType,
      tankWarehouseId: readingType === "tank_level" ? Number(readingTankId) : null,
      readingValue: parsedValue, recordedAt: new Date(readingAt).toISOString(),
      referenceNo: readingReference.trim() || undefined, notes: readingNotes.trim() || undefined,
      correctsReadingId: correctsReadingId.trim() ? Number(correctsReadingId) : null,
      correctionReason: correctionReason.trim() || undefined, operationKey: readingKey,
    });
  };

  const eventRows = (eventsAuthorizationDenied ? [] : events.data !== undefined ? events.data :
    recentEventsAuthorizationDenied ? [] : recentEvents.data ?? []) as FuelEvent[];
  const usingRecentOfflineEvents = !eventsAuthorizationDenied && !recentEventsAuthorizationDenied &&
    events.data === undefined && recentEvents.data !== undefined;
  const readingRows = (readingsAuthorizationDenied ? [] : readings.data !== undefined ? readings.data :
    recentReadingsAuthorizationDenied ? [] : recentReadings.data ?? []) as FuelReading[];
  const usingRecentOfflineReadings = !readingsAuthorizationDenied && !recentReadingsAuthorizationDenied &&
    readings.data === undefined && recentReadings.data !== undefined;
  const reportRows = (reportAuthorizationDenied ? [] : report.data ?? cachedFuelReportForCurrentScope?.rows ?? []) as FuelReportRow[];
  const usingCachedFuelReport = !reportAuthorizationDenied && report.data === undefined && cachedFuelReportForCurrentScope !== null;
  const hasAvailableFuelReport = !reportAuthorizationDenied && (report.data !== undefined || cachedFuelReportForCurrentScope !== null);
  const alertSettingRows = (alertSettingsAuthorizationDenied ? [] : alertSettings.data ?? []) as FuelAlertSetting[];
  const alertDispatchRows = (alertDispatchesAuthorizationDenied ? [] : alertDispatches.data ?? []) as FuelAlertDispatch[];
  const selectedGenerator = generators.find((row) => row.id === Number(activeGeneratorId));
  const reportTanks = reportGeneratorId
    ? tanks.filter((tank) => tank.generatorId === Number(reportGeneratorId))
    : tanks;

  if (!canManageFuelAndConsumption && !canViewInventoryReports) {
    return <Card><CardContent className="py-6 text-sm text-muted-foreground">لا تتوفر لديك صلاحية الوقود أو تقاريره.</CardContent></Card>;
  }

  return <div className="space-y-4">
    {optionsAuthorizationDenied ? <p role="alert" className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">رفض الخادم صلاحية الوصول إلى خيارات الوقود لهذا الفرع؛ أُخفيت الخيارات المحلية حتى لا تُستخدم بيانات قديمة.</p> : null}
    {canManageFuelAndConsumption ? <>
      <Card>
        <CardHeader className="flex flex-row items-center gap-3 space-y-0">
          <Droplet className="h-5 w-5" />
          <div><CardTitle>تسجيل تعبئة وقود</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">كل تعبئة تحرك رصيد الوقود وتكلفته ذريًا من المصدر إلى خزان المولد، وتحفظ المرجع والفاعل ووقت العملية.</p>
          </div>
        </CardHeader>
        <CardContent>
          <form onSubmit={submitFill} className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            <label className="grid gap-1.5 text-sm">المولد *
              <select required className="h-10 rounded-md border border-input bg-background px-3 text-sm" value={activeGeneratorId} onChange={(e) => setGeneratorId(e.target.value)}>
                <option value="">اختر المولد</option>
                {generators.map((g) => <option key={g.id} value={g.id}>{g.name} {g.code ? `(${g.code})` : ""}</option>)}
              </select>
            </label>
            <label className="grid gap-1.5 text-sm">صنف الوقود *
              <select required className="h-10 rounded-md border border-input bg-background px-3 text-sm" value={fuelItemId} onChange={(e) => setFuelItemId(e.target.value)}>
                <option value="">اختر صنفًا بوحدته الأساسية اللتر</option>
                {(workspaceOptions?.fuelItems ?? []).map((item) => <option key={item.id} value={item.id}>{item.name}{item.sku ? ` (${item.sku})` : ""}</option>)}
              </select>
            </label>
            <label className="grid gap-1.5 text-sm">موقع المصدر *
              <select required className="h-10 rounded-md border border-input bg-background px-3 text-sm" value={sourceWarehouseId} onChange={(e) => setSourceWarehouseId(e.target.value)}>
                <option value="">اختر مصدر الوقود</option>
                {(workspaceOptions?.sourceLocations ?? []).map((w) => <option key={w.id} value={w.id}>{w.name} · {w.code}</option>)}
              </select>
            </label>
            <label className="grid gap-1.5 text-sm">خزان المولد *
              <select required className="h-10 rounded-md border border-input bg-background px-3 text-sm" value={destinationWarehouseId} onChange={(e) => setDestinationWarehouseId(e.target.value)}>
                <option value="">اختر خزان المولد</option>
                {generatorTanks.map((w) => <option key={w.id} value={w.id}>{w.name} · {w.code}</option>)}
              </select>
            </label>
            <label className="grid gap-1.5 text-sm">الكمية (لتر) *
              <Input type="number" min="0.001" step="0.001" required value={litres} onChange={(e) => setLitres(e.target.value)} />
            </label>
            <label className="grid gap-1.5 text-sm">تاريخ ووقت التعبئة *
              <Input type="datetime-local" required value={fillAt} onChange={(e) => setFillAt(e.target.value)} />
            </label>
            <label className="grid gap-1.5 text-sm">مستوى قبل التعبئة (لتر، اختياري)
              <Input type="number" min="0" step="0.001" value={levelBefore} onChange={(e) => setLevelBefore(e.target.value)} />
            </label>
            <label className="grid gap-1.5 text-sm">مستوى بعد التعبئة (لتر، اختياري)
              <Input type="number" min="0" step="0.001" value={levelAfter} onChange={(e) => setLevelAfter(e.target.value)} />
            </label>
            <label className="grid gap-1.5 text-sm">ساعات التشغيل وقت التعبئة (اختياري)
              <Input type="number" min="0" step="0.001" value={fillOperatingHours} onChange={(e) => setFillOperatingHours(e.target.value)} />
            </label>
            <label className="grid gap-1.5 text-sm">رقم المرجع
              <Input maxLength={120} value={fillReference} onChange={(e) => setFillReference(e.target.value)} placeholder="سند التعبئة أو فاتورة المورد" />
            </label>
            <label className="grid gap-1.5 text-sm md:col-span-2">ملاحظات
              <Input maxLength={2000} value={fillNotes} onChange={(e) => setFillNotes(e.target.value)} />
            </label>
            <div className="md:col-span-2 xl:col-span-3 rounded-md bg-muted/40 p-3 text-sm text-muted-foreground">
              مفتاح العملية ثابت أثناء المحاولة لمنع التكرار. لا تُحتسب الكمية المعبأة تلقائيًا على أنها استهلاك فعلي؛ يتطلب الاستهلاك المقاس قراءات مستوى صالحة.
              {selectedGenerator ? <span className="block mt-1">آخر قيمة محفوظة للمولد: مستوى {qty(selectedGenerator.fuelLevelLiters)} لتر، وساعات تشغيل {qty(selectedGenerator.operatingHours)}.</span> : null}
            </div>
            <div><Button type="submit" disabled={fillMutation.isPending || options.isLoading || !fuelItemId || !sourceWarehouseId || !destinationWarehouseId}>
              {fillMutation.isPending ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Save className="ml-2 h-4 w-4" />} تسجيل التعبئة
            </Button></div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center gap-3 space-y-0">
          <Gauge className="h-5 w-5" />
          <div><CardTitle>تسجيل قراءة مؤرخة</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">القراءة الجديدة تضاف إلى السجل ولا تستبدل الماضي. أي تصحيح يتطلب رقم القراءة المستهدفة وسببًا موثقًا.</p>
          </div>
        </CardHeader>
        <CardContent>
          <form onSubmit={submitReading} className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            <label className="grid gap-1.5 text-sm">المولد *
              <select required className="h-10 rounded-md border border-input bg-background px-3 text-sm" value={activeReadingGeneratorId} onChange={(e) => setReadingGeneratorId(e.target.value)}>
                <option value="">اختر المولد</option>
                {generators.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </label>
            <label className="grid gap-1.5 text-sm">نوع القراءة *
              <select className="h-10 rounded-md border border-input bg-background px-3 text-sm" value={readingType} onChange={(e) => setReadingType(e.target.value as "tank_level" | "operating_hours")}>
                <option value="tank_level">مستوى الخزان (لتر)</option>
                <option value="operating_hours">ساعات التشغيل</option>
              </select>
            </label>
            {readingType === "tank_level" ? <label className="grid gap-1.5 text-sm">الخزان المرتبط *
              <select required className="h-10 rounded-md border border-input bg-background px-3 text-sm" value={readingTankId} onChange={(e) => setReadingTankId(e.target.value)}>
                <option value="">اختر خزانًا</option>
                {readingTanks.map((w) => <option key={w.id} value={w.id}>{w.name} · {w.code}</option>)}
              </select>
            </label> : null}
            <label className="grid gap-1.5 text-sm">{readingType === "tank_level" ? "مستوى الوقود (لتر) *" : "ساعات التشغيل *"}
              <Input type="number" min="0" step="0.001" required value={readingValue} onChange={(e) => setReadingValue(e.target.value)} />
            </label>
            <label className="grid gap-1.5 text-sm">تاريخ ووقت القراءة *
              <Input type="datetime-local" required value={readingAt} onChange={(e) => setReadingAt(e.target.value)} />
            </label>
            <label className="grid gap-1.5 text-sm">رقم المرجع
              <Input maxLength={120} value={readingReference} onChange={(e) => setReadingReference(e.target.value)} />
            </label>
            <label className="grid gap-1.5 text-sm">رقم القراءة التي يجري تصحيحها (اختياري)
              <Input type="number" min="1" step="1" value={correctsReadingId} onChange={(e) => setCorrectsReadingId(e.target.value)} placeholder="معرّف القراءة في السجل" />
            </label>
            <label className="grid gap-1.5 text-sm">سبب التصحيح
              <Input maxLength={500} value={correctionReason} onChange={(e) => setCorrectionReason(e.target.value)} placeholder="إلزامي عند التصحيح" />
            </label>
            <label className="grid gap-1.5 text-sm md:col-span-2">ملاحظات
              <Input maxLength={2000} value={readingNotes} onChange={(e) => setReadingNotes(e.target.value)} />
            </label>
            <div><Button type="submit" disabled={readingMutation.isPending || options.isLoading}>
              {readingMutation.isPending ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Save className="ml-2 h-4 w-4" />} حفظ القراءة
            </Button></div>
          </form>
        </CardContent>
      </Card>
    </> : null}

    {canManageFuelAndConsumption ? <Card>
      <CardHeader>
        <CardTitle>إعدادات تنبيهات الوقود</CardTitle>
        <p className="text-sm text-muted-foreground">يُرسل تنبيه داخل المنصة عند نزول المستوى عن الحد أو تجاوز معدل الاستهلاك المقاس. لا يُحتسب المعدل عند نقص القراءات أو تعارض التسوية.</p>
      </CardHeader>
      <CardContent className="space-y-4">
        {alertSettingsAuthorizationDenied ? <p role="alert" className="text-sm text-destructive">رفض الخادم صلاحية الوصول إلى إعدادات تنبيهات الوقود؛ أُخفيت البيانات المحلية لهذا الطلب.</p> : alertSettings.error && alertSettings.data !== undefined ? <p role="status" className="text-xs text-amber-700">تعذر تحديث إعدادات التنبيهات؛ تُعرض آخر نسخة ناجحة لهذه الجلسة.</p> : alertSettings.error ? <p role="alert" className="text-sm text-destructive">تعذر تحميل إعدادات التنبيهات ولا توجد نسخة متاحة.</p> : null}
        <form className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3" onSubmit={(event) => {
          event.preventDefault();
          const low = alertLowThreshold.trim() ? Number(alertLowThreshold) : null;
          const rate = alertRateThreshold.trim() ? Number(alertRateThreshold) : null;
          const hours = Number(alertMinimumHours);
          if ((low != null && (!Number.isFinite(low) || low < 0 || Math.abs(low * 1000 - Math.round(low * 1000)) > 1e-7)) ||
              (rate != null && (!Number.isFinite(rate) || rate <= 0 || Math.abs(rate * 1000 - Math.round(rate * 1000)) > 1e-7)) ||
              !Number.isFinite(hours) || hours <= 0) {
            toast.error("تحقق من حدود التنبيه؛ القيم حتى ثلاث منازل عشرية، والحد الأدنى للساعات أكبر من صفر."); return;
          }
          if (alertsEnabled && low == null && rate == null) {
            toast.error("أدخل حدًا واحدًا على الأقل قبل تفعيل التنبيهات."); return;
          }
          if (!activeAlertGeneratorId || !alertTankId) {
            toast.error("اختر المولد وخزان الوقود المرتبط به."); return;
          }
          alertSettingsMutation.mutate({
            siteId, generatorId: Number(activeAlertGeneratorId), tankWarehouseId: Number(alertTankId),
            lowLevelThresholdLiters: low, abnormalLitresPerHourThreshold: rate,
            minimumHoursDelta: hours, isEnabled: alertsEnabled, operationKey: alertSettingKey,
          });
        }}>
          <label className="grid gap-1.5 text-sm">المولد
            <select required className="h-10 rounded-md border border-input bg-background px-3 text-sm" value={activeAlertGeneratorId} onChange={(e) => setAlertGeneratorId(e.target.value)}>
              <option value="">اختر المولد</option>
              {generators.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </label>
          <label className="grid gap-1.5 text-sm">خزان المولد
            <select required className="h-10 rounded-md border border-input bg-background px-3 text-sm" value={alertTankId} onChange={(e) => setAlertTankId(e.target.value)}>
              <option value="">اختر خزانًا</option>
              {alertTanks.map((w) => <option key={w.id} value={w.id}>{w.name} · {w.code}</option>)}
            </select>
          </label>
          <label className="grid gap-1.5 text-sm">حد انخفاض المستوى (لتر)
            <Input type="number" min="0" step="0.001" value={alertLowThreshold} onChange={(e) => setAlertLowThreshold(e.target.value)} placeholder="اختياري" />
          </label>
          <label className="grid gap-1.5 text-sm">حد الاستهلاك غير الاعتيادي (لتر/ساعة)
            <Input type="number" min="0.001" step="0.001" value={alertRateThreshold} onChange={(e) => setAlertRateThreshold(e.target.value)} placeholder="اختياري" />
          </label>
          <label className="grid gap-1.5 text-sm">الحد الأدنى لساعات القياس
            <Input type="number" min="0.001" step="0.001" required value={alertMinimumHours} onChange={(e) => setAlertMinimumHours(e.target.value)} />
          </label>
          <label className="flex items-center gap-2 self-end pb-2 text-sm">
            <input type="checkbox" checked={alertsEnabled} onChange={(e) => setAlertsEnabled(e.target.checked)} />
            تفعيل تنبيهات هذا المولد والخزان
          </label>
          <div className="md:col-span-2 xl:col-span-3 flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={alertSettingsMutation.isPending || options.isLoading || !activeAlertGeneratorId || !alertTankId}>
              {alertSettingsMutation.isPending ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Save className="ml-2 h-4 w-4" />}
              حفظ إعدادات التنبيه
            </Button>
            {selectedAlertSetting ? <span className="text-xs text-muted-foreground">آخر تحديث: {dateTime(selectedAlertSetting.updated_at)}</span> : null}
          </div>
        </form>
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead><tr className="bg-muted/50 text-right">
              <th className="p-2">المولد / الخزان</th><th className="p-2">حد المستوى</th><th className="p-2">حد لتر/ساعة</th><th className="p-2">الحالة</th><th className="p-2">آخر تنبيه</th>
            </tr></thead>
            <tbody>{alertSettingRows.map((row) => <tr key={row.setting_id} className="border-t">
              <td className="p-2">{row.generator_name}<div className="text-xs text-muted-foreground">{row.tank_name}</div></td>
              <td className="p-2">{row.low_level_threshold_liters == null ? "—" : qty(row.low_level_threshold_liters) + " لتر"}</td>
              <td className="p-2">{row.abnormal_litres_per_hour_threshold == null ? "—" : qty(row.abnormal_litres_per_hour_threshold) + " لتر/ساعة"}</td>
              <td className="p-2"><div>{row.is_enabled ? "مفعّل" : "موقوف"}</div><div className="text-xs text-muted-foreground">{row.low_level_alert_active ? "مستوى منخفض نشط" : row.abnormal_alert_active ? "استهلاك غير اعتيادي نشط" : "لا يوجد تنبيه نشط"}</div></td>
              <td className="p-2">{dateTime(row.abnormal_last_triggered_at || row.low_level_last_triggered_at)}</td>
            </tr>)}
            {alertSettingRows.length === 0 ? <tr><td colSpan={5} className="p-4 text-center text-muted-foreground">{alertSettingsAuthorizationDenied ? "رفض الخادم الوصول إلى إعدادات التنبيهات." : alertSettings.error ? "تعذر تحميل إعدادات التنبيهات." : "لم تُضبط تنبيهات لهذا الفرع بعد."}</td></tr> : null}</tbody>
          </table>
        </div>
      </CardContent>
    </Card> : null}

    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <div><CardTitle>سجل التعبئات والقراءات</CardTitle><p className="mt-1 text-sm text-muted-foreground">السجلات مرتبة زمنيًا مع مرجع العملية؛ لا يُستبدل السجل القديم عند التصحيح.</p></div>
        <Button type="button" variant="outline" size="sm" onClick={() => { void events.refetch(); void readings.refetch(); }}>
          <RefreshCw className="ml-2 h-4 w-4" /> تحديث
        </Button>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-3 md:grid-cols-3">
          <label className="grid gap-1.5 text-sm">من تاريخ
            <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
          </label>
          <label className="grid gap-1.5 text-sm">إلى تاريخ
            <Input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
          </label>
          <label className="grid gap-1.5 text-sm">المولد
            <select className="h-10 rounded-md border border-input bg-background px-3 text-sm" value={reportGeneratorId} onChange={(e) => setReportGeneratorId(e.target.value)}>
              <option value="">جميع المولدات</option>
              {generators.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </label>
        </div>
        {canViewInventoryReports ? <div className="rounded-md border p-3 space-y-3">
          <h3 className="font-medium">تقرير الوقود حسب الفترة المحاسبية</h3>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <label className="grid gap-1.5 text-sm">الفترة
              <select className="h-10 rounded-md border border-input bg-background px-3 text-sm" value={reportPeriodType} onChange={(e) => setReportPeriodType(e.target.value as "day" | "cycle" | "month" | "custom")}>
                <option value="day">يوم</option><option value="cycle">دورة القراءات المعتمدة</option><option value="month">شهر تقويمي</option><option value="custom">نطاق مخصص</option>
              </select>
            </label>
            {reportPeriodType !== "custom" ? <label className="grid gap-1.5 text-sm">التاريخ المرجعي
              <Input type="date" required value={reportAnchorDate} onChange={(e) => setReportAnchorDate(e.target.value)} />
            </label> : <>
              <label className="grid gap-1.5 text-sm">من تاريخ
                <Input type="date" required value={reportFromDate} onChange={(e) => setReportFromDate(e.target.value)} />
              </label>
              <label className="grid gap-1.5 text-sm">إلى تاريخ
                <Input type="date" required value={reportToDate} onChange={(e) => setReportToDate(e.target.value)} />
              </label>
            </>}
            <label className="grid gap-1.5 text-sm">المولد
              <select className="h-10 rounded-md border border-input bg-background px-3 text-sm" value={reportGeneratorId} onChange={(e) => { setReportGeneratorId(e.target.value); setReportTankId(""); }}>
                <option value="">جميع المولدات</option>{generators.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </label>
            <label className="grid gap-1.5 text-sm">خزان الوقود
              <select className="h-10 rounded-md border border-input bg-background px-3 text-sm" value={reportTankId} onChange={(e) => setReportTankId(e.target.value)}>
                <option value="">جميع الخزانات</option>{reportTanks.map((tank) => <option key={tank.id} value={tank.id}>{tank.name}</option>)}
              </select>
            </label>
          </div>
          {reportPeriodType === "cycle" ? <p className="text-xs text-muted-foreground">يستخدم التقرير تعريف دورة القراءات والمنطقة الزمنية المحفوظين للفرع، بما في ذلك الدورات الأسبوعية و10 أيام و15 يومًا والشهرية.</p> : null}
          {usingCachedFuelReport ? <p role="status" className="text-xs text-amber-700">تُعرض نسخة محفوظة من التقرير بتاريخ {dateTime(new Date(cachedFuelReportForCurrentScope!.savedAt).toISOString())}. هذه لقطة تجميعية وليست إعادة احتساب حيّة؛ أعد الاتصال لتحديثها.</p> : null}
          {reportAuthorizationDenied ? <p role="alert" className="text-sm text-destructive">رفض الخادم صلاحية احتساب تقرير الوقود؛ أُخفيت أي نسخة محلية لهذا الطلب.</p> : report.isLoading && !hasAvailableFuelReport ? <p className="text-sm text-muted-foreground">جارٍ احتساب التقرير…</p> : report.error && !hasAvailableFuelReport ? <p role="alert" className="text-sm text-destructive">تعذر احتساب التقرير. تحقق من إعدادات الدورة والصلاحيات.</p> : report.error && hasAvailableFuelReport && !usingCachedFuelReport ? <p role="status" className="text-xs text-amber-700">تعذر تحديث التقرير؛ تُعرض آخر نتيجة ناجحة متاحة في الجلسة.</p> : null}
        </div> : null}
        {canViewInventoryReports ? <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead><tr className="bg-muted/50 text-right">
              <th className="p-2">المولد / الخزان</th><th className="p-2">المعبأ</th><th className="p-2">التكلفة</th>
              <th className="p-2">الاستهلاك المسجل</th><th className="p-2">الاستهلاك المقاس</th><th className="p-2">ساعات التشغيل</th><th className="p-2">لتر/ساعة</th><th className="p-2">حالة القياس</th>
            </tr></thead>
            <tbody>{reportRows.map((row) => <tr key={`${row.generator_id}:${row.tank_warehouse_id}`} className="border-t">
              <td className="p-2"><div>{row.generator_name}</div><div className="text-xs text-muted-foreground">{row.tank_name}</div></td>
              <td className="p-2">{qty(row.fuel_filled_liters)} لتر</td><td className="p-2">{money(row.fuel_filled_cost)}</td>
              <td className="p-2">{qty(row.recorded_consumption_liters)} لتر</td>
              <td className="p-2">{row.actual_consumption_liters == null ? "غير متاح" : `${qty(row.actual_consumption_liters)} لتر`}</td>
              <td className="p-2">{row.operating_hours_delta == null ? "—" : qty(row.operating_hours_delta)}</td>
              <td className="p-2">{row.litres_per_hour == null ? "—" : qty(row.litres_per_hour)}</td>
              <td className="p-2"><Badge variant="outline">{statusLabels[row.measurement_status] ?? row.measurement_status}</Badge></td>
            </tr>)}
            {reportRows.length === 0 ? <tr><td colSpan={8} className="p-4 text-center text-muted-foreground">لا توجد خزانات مولدات ضمن النطاق أو لا توجد بيانات للعرض.</td></tr> : null}
            </tbody>
          </table>
        </div> : <p className="rounded-md bg-muted/40 p-3 text-sm text-muted-foreground">يظهر تقرير التكلفة والاستهلاك المقاس لأصحاب صلاحية تقارير المخزون فقط.</p>}

        <div>
          <h3 className="mb-2 font-medium">آخر التعبئات</h3>
          {eventsAuthorizationDenied ? <p role="alert" className="mb-2 text-xs text-destructive">رفض الخادم صلاحية الوصول إلى سجل التعبئات؛ أُخفيت البيانات المحلية لهذا الطلب.</p> : recentEventsAuthorizationDenied && events.data === undefined ? <p role="alert" className="mb-2 text-xs text-destructive">رفض الخادم صلاحية الوصول إلى سجل التعبئات؛ لا يمكن استخدام النسخة المحلية الاحتياطية.</p> : events.error && events.data !== undefined ? <p role="status" className="mb-2 text-xs text-amber-700">تعذر تحديث سجل التعبئات؛ تُعرض آخر نتيجة ناجحة تطابق الفلاتر الحالية.</p> : usingRecentOfflineEvents ? <p role="status" className="mb-2 text-xs text-amber-700">تعذر تحميل السجل المفلتر؛ يعرض هذا الجدول آخر 100 تعبئة محفوظة محليًا، ولا تُطبّق عليها فلاتر التاريخ أو المولد حتى استعادة الاتصال.</p> : events.error && !recentEvents.data ? <p role="alert" className="mb-2 text-xs text-destructive">تعذر تحميل سجل التعبئات ولا توجد نسخة محلية متاحة.</p> : null}
          <div className="overflow-x-auto rounded-md border"><table className="w-full text-sm">
            <thead><tr className="bg-muted/50 text-right"><th className="p-2">التاريخ</th><th className="p-2">المولد</th><th className="p-2">من المصدر إلى الخزان</th><th className="p-2">اللترات</th><th className="p-2">المستوى قبل ← بعد</th><th className="p-2">ساعات العداد</th><th className="p-2">المرجع</th></tr></thead>
            <tbody>{eventRows.map((row) => <tr key={row.event_id} className="border-t">
              <td className="p-2 whitespace-nowrap">{dateTime(row.occurred_at)}</td><td className="p-2">{row.generator_name}</td>
              <td className="p-2">{row.source_warehouse_name} ← {row.destination_warehouse_name}</td>
              <td className="p-2">{qty(row.litres)}</td><td className="p-2">{qty(row.level_before_liters)} ← {qty(row.level_after_liters)}</td>
              <td className="p-2">{qty(row.operating_hours)}</td><td className="p-2">{row.reference_no || "—"}</td>
            </tr>)}
            {eventRows.length === 0 ? <tr><td colSpan={7} className="p-4 text-center text-muted-foreground">{events.error && !recentEvents.data ? "تعذر تحميل سجل التعبئات ولا توجد نسخة متاحة." : "لا توجد تعبئات في الفترة المحددة."}</td></tr> : null}</tbody>
          </table></div>
        </div>

        <div>
          <h3 className="mb-2 font-medium">آخر القراءات</h3>
          {readingsAuthorizationDenied ? <p role="alert" className="mb-2 text-xs text-destructive">رفض الخادم صلاحية الوصول إلى سجل القراءات؛ أُخفيت البيانات المحلية لهذا الطلب.</p> : recentReadingsAuthorizationDenied && readings.data === undefined ? <p role="alert" className="mb-2 text-xs text-destructive">رفض الخادم صلاحية الوصول إلى سجل القراءات؛ لا يمكن استخدام النسخة المحلية الاحتياطية.</p> : usingRecentOfflineReadings ? <p role="status" className="mb-2 text-xs text-amber-700">تعذر تحميل القراءات المفلترة؛ يعرض هذا الجدول آخر 100 قراءة محفوظة للفرع دون تطبيق فلتر المولد حتى استعادة الاتصال.</p> : readings.error && readings.data !== undefined ? <p role="status" className="mb-2 text-xs text-amber-700">تعذر تحديث سجل القراءات؛ تُعرض آخر نتيجة ناجحة لهذا الاستعلام.</p> : readings.error && !recentReadings.data ? <p role="alert" className="mb-2 text-xs text-destructive">تعذر تحميل سجل القراءات ولا توجد نسخة محلية متاحة لهذا النطاق.</p> : null}
          <div className="overflow-x-auto rounded-md border"><table className="w-full text-sm">
            <thead><tr className="bg-muted/50 text-right"><th className="p-2">التاريخ</th><th className="p-2">المولد</th><th className="p-2">النوع</th><th className="p-2">الخزان</th><th className="p-2">القراءة</th><th className="p-2">تصحيح القراءة</th><th className="p-2">المرجع</th></tr></thead>
            <tbody>{readingRows.map((row) => <tr key={row.reading_id} className="border-t">
              <td className="p-2 whitespace-nowrap">{dateTime(row.recorded_at)}</td><td className="p-2">{row.generator_name}</td>
              <td className="p-2">{readingLabels[row.reading_type] ?? row.reading_type}</td><td className="p-2">{row.tank_name || "—"}</td>
              <td className="p-2">{qty(row.reading_value)}</td>
              <td className="p-2">{row.corrects_reading_id ? `تصحيح #${row.corrects_reading_id}: ${row.correction_reason || ""}` : "—"}</td><td className="p-2">{row.reference_no || "—"}</td>
            </tr>)}
            {readingRows.length === 0 ? <tr><td colSpan={7} className="p-4 text-center text-muted-foreground">{readings.error && !recentReadings.data ? "تعذر تحميل القراءات ولا توجد نسخة متاحة." : "لا توجد قراءات مسجلة."}</td></tr> : null}</tbody>
          </table></div>
        </div>
      </CardContent>
    </Card>
    {(canManageFuelAndConsumption || canViewInventoryReports) ? <Card>
      <CardHeader>
        <CardTitle>سجل تنبيهات الوقود</CardTitle>
        <p className="text-sm text-muted-foreground">كل صف يمثل بداية حالة تنبيه جديدة؛ لا تكرر إعادة التقييم التنبيه ما دامت الحالة مستمرة.</p>
      </CardHeader>
      <CardContent>
        {alertDispatchesAuthorizationDenied ? <p role="alert" className="mb-2 text-sm text-destructive">رفض الخادم صلاحية الوصول إلى سجل إرسال التنبيهات؛ أُخفيت البيانات المحلية لهذا الطلب.</p> : alertDispatches.error && alertDispatches.data !== undefined ? <p role="status" className="mb-2 text-xs text-amber-700">تعذر تحديث سجل التنبيهات؛ تُعرض آخر نتيجة ناجحة.</p> : alertDispatches.error ? <p role="alert" className="mb-2 text-sm text-destructive">تعذر تحميل سجل التنبيهات ولا توجد نسخة متاحة.</p> : null}
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead><tr className="bg-muted/50 text-right">
              <th className="p-2">وقت التنبيه</th><th className="p-2">المولد / الخزان</th><th className="p-2">نوع التنبيه</th><th className="p-2">القراءة</th><th className="p-2">الحد</th><th className="p-2">الحالة</th>
            </tr></thead>
            <tbody>{alertDispatchRows.map((row) => <tr key={row.dispatch_id} className="border-t">
              <td className="p-2 whitespace-nowrap">{dateTime(row.created_at)}</td>
              <td className="p-2">{row.generator_name}<div className="text-xs text-muted-foreground">{row.tank_name}</div></td>
              <td className="p-2">{row.alert_type === "low_fuel_level" ? "مستوى وقود منخفض" : "استهلاك غير اعتيادي"}<div className="text-xs text-muted-foreground">حالة #{row.episode_no}</div></td>
              <td className="p-2">{qty(row.measured_value)} {row.alert_type === "low_fuel_level" ? "لتر" : "لتر/ساعة"}</td>
              <td className="p-2">{qty(row.threshold_value)} {row.alert_type === "low_fuel_level" ? "لتر" : "لتر/ساعة"}</td>
              <td className="p-2">{row.recipient_count > 0 ? "أُنشئ إشعار داخل المنصة" : "لم يوجد مستلم نشط وقت التقييم"}</td>
            </tr>)}
            {alertDispatchRows.length === 0 ? <tr><td colSpan={6} className="p-4 text-center text-muted-foreground">{alertDispatchesAuthorizationDenied ? "رفض الخادم الوصول إلى سجل التنبيهات." : alertDispatches.error ? "تعذر تحميل سجل التنبيهات." : "لا توجد تنبيهات مسجلة ضمن المرشحات."}</td></tr> : null}</tbody>
          </table>
        </div>
      </CardContent>
    </Card> : null}

  </div>;
}
