import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
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

  const options = trpc.powerhub.inventory.fuelWorkspaceOptions.useQuery(
    { siteId },
    { enabled: Boolean(siteId && isAuthenticated && (canManageFuelAndConsumption || canViewInventoryReports)), staleTime: 20_000 },
  );
  const generators = (options.data?.generators ?? []) as FuelGenerator[];
  const activeGeneratorId = generatorId || String(generators[0]?.id ?? "");
  const activeReadingGeneratorId = readingGeneratorId || String(generators[0]?.id ?? "");
  const activeReportGeneratorId = reportGeneratorId || "";
  const tanks = options.data?.generatorTanks ?? [];
  const generatorTanks = tanks.filter((tank) => tank.generatorId === Number(activeGeneratorId));
  const readingTanks = tanks.filter((tank) => tank.generatorId === Number(activeReadingGeneratorId));

  const events = trpc.powerhub.inventory.listFuelEvents.useQuery(
    { siteId, fromDate: fromDate || undefined, toDate: toDate || undefined,
      generatorId: activeReportGeneratorId ? Number(activeReportGeneratorId) : undefined, limit: 100 },
    { enabled: Boolean(siteId && isAuthenticated && (canManageFuelAndConsumption || canViewInventoryReports)), staleTime: 10_000 },
  );
  const readings = trpc.powerhub.inventory.listFuelReadings.useQuery(
    { siteId, generatorId: activeReportGeneratorId ? Number(activeReportGeneratorId) : undefined, limit: 100 },
    { enabled: Boolean(siteId && isAuthenticated && (canManageFuelAndConsumption || canViewInventoryReports)), staleTime: 10_000 },
  );
  const report = trpc.powerhub.inventory.fuelConsumptionReport.useQuery(
    { siteId, fromDate, toDate, generatorId: activeReportGeneratorId ? Number(activeReportGeneratorId) : undefined },
    { enabled: Boolean(siteId && isAuthenticated && canViewInventoryReports && fromDate && toDate && fromDate <= toDate), staleTime: 15_000 },
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
    const sources = options.data?.sourceLocations ?? [];
    if (!sources.some((row) => String(row.id) === sourceWarehouseId)) setSourceWarehouseId(String(sources[0]?.id ?? ""));
  }, [options.data?.sourceLocations, sourceWarehouseId]);
  useEffect(() => {
    const items = options.data?.fuelItems ?? [];
    if (!items.some((row) => String(row.id) === fuelItemId)) setFuelItemId(String(items[0]?.id ?? ""));
  }, [options.data?.fuelItems, fuelItemId]);

  const fillMutation = trpc.powerhub.inventory.recordFuelFill.useMutation({
    onSuccess: async (result) => {
      toast.success(result.replayed ? "تم تأكيد التعبئة السابقة دون تكرار حركة المخزون." : `تم تسجيل التعبئة ${qty(result.litres)} لتر وترحيلها إلى خزان المولد.`);
      setLitres(""); setLevelBefore(""); setLevelAfter(""); setFillOperatingHours(""); setFillReference(""); setFillNotes("");
      setFillAt(nowLocalDateTime()); setFillKey(operationKey("fuel-fill"));
      await Promise.all([
        utils.powerhub.inventory.listFuelEvents.invalidate(),
        utils.powerhub.inventory.listFuelReadings.invalidate(),
        utils.powerhub.inventory.fuelConsumptionReport.invalidate(),
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
      ]);
    },
    onError: (error) => toast.error(error.message || "تعذر تسجيل القراءة."),
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

  const eventRows = (events.data ?? []) as FuelEvent[];
  const readingRows = (readings.data ?? []) as FuelReading[];
  const reportRows = (report.data ?? []) as FuelReportRow[];
  const selectedGenerator = generators.find((row) => row.id === Number(activeGeneratorId));

  if (!canManageFuelAndConsumption && !canViewInventoryReports) {
    return <Card><CardContent className="py-6 text-sm text-muted-foreground">لا تتوفر لديك صلاحية الوقود أو تقاريره.</CardContent></Card>;
  }

  return <div className="space-y-4">
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
                {(options.data?.fuelItems ?? []).map((item) => <option key={item.id} value={item.id}>{item.name}{item.sku ? ` (${item.sku})` : ""}</option>)}
              </select>
            </label>
            <label className="grid gap-1.5 text-sm">موقع المصدر *
              <select required className="h-10 rounded-md border border-input bg-background px-3 text-sm" value={sourceWarehouseId} onChange={(e) => setSourceWarehouseId(e.target.value)}>
                <option value="">اختر مصدر الوقود</option>
                {(options.data?.sourceLocations ?? []).map((w) => <option key={w.id} value={w.id}>{w.name} · {w.code}</option>)}
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
          <div className="overflow-x-auto rounded-md border"><table className="w-full text-sm">
            <thead><tr className="bg-muted/50 text-right"><th className="p-2">التاريخ</th><th className="p-2">المولد</th><th className="p-2">من المصدر إلى الخزان</th><th className="p-2">اللترات</th><th className="p-2">المستوى قبل ← بعد</th><th className="p-2">ساعات العداد</th><th className="p-2">المرجع</th></tr></thead>
            <tbody>{eventRows.map((row) => <tr key={row.event_id} className="border-t">
              <td className="p-2 whitespace-nowrap">{dateTime(row.occurred_at)}</td><td className="p-2">{row.generator_name}</td>
              <td className="p-2">{row.source_warehouse_name} ← {row.destination_warehouse_name}</td>
              <td className="p-2">{qty(row.litres)}</td><td className="p-2">{qty(row.level_before_liters)} ← {qty(row.level_after_liters)}</td>
              <td className="p-2">{qty(row.operating_hours)}</td><td className="p-2">{row.reference_no || "—"}</td>
            </tr>)}
            {eventRows.length === 0 ? <tr><td colSpan={7} className="p-4 text-center text-muted-foreground">لا توجد تعبئات في الفترة المحددة.</td></tr> : null}</tbody>
          </table></div>
        </div>

        <div>
          <h3 className="mb-2 font-medium">آخر القراءات</h3>
          <div className="overflow-x-auto rounded-md border"><table className="w-full text-sm">
            <thead><tr className="bg-muted/50 text-right"><th className="p-2">التاريخ</th><th className="p-2">المولد</th><th className="p-2">النوع</th><th className="p-2">الخزان</th><th className="p-2">القراءة</th><th className="p-2">تصحيح القراءة</th><th className="p-2">المرجع</th></tr></thead>
            <tbody>{readingRows.map((row) => <tr key={row.reading_id} className="border-t">
              <td className="p-2 whitespace-nowrap">{dateTime(row.recorded_at)}</td><td className="p-2">{row.generator_name}</td>
              <td className="p-2">{readingLabels[row.reading_type] ?? row.reading_type}</td><td className="p-2">{row.tank_name || "—"}</td>
              <td className="p-2">{qty(row.reading_value)}</td>
              <td className="p-2">{row.corrects_reading_id ? `تصحيح #${row.corrects_reading_id}: ${row.correction_reason || ""}` : "—"}</td><td className="p-2">{row.reference_no || "—"}</td>
            </tr>)}
            {readingRows.length === 0 ? <tr><td colSpan={7} className="p-4 text-center text-muted-foreground">لا توجد قراءات مسجلة.</td></tr> : null}</tbody>
          </table></div>
        </div>
      </CardContent>
    </Card>
  </div>;
}
