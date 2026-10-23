import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import { ArrowLeftRight, Boxes, CircleDollarSign, ClipboardList, Fuel, Gauge, RefreshCw, Store, Warehouse, Wrench } from "lucide-react";

type StockRow = {
  warehouse_id: number | string;
  warehouse_name: string;
  item_id: number | string;
  sku: string | null;
  item_name: string;
  category: string;
  on_hand_quantity: number | string;
  reorder_point: number | string;
  stock_value?: number | string | null;
  below_reorder_point: boolean;
};

type AgingSummary = {
  totals?: { total_outstanding?: number | string | null };
  as_of_date?: string;
};

type FuelReportRow = {
  generator_id: number | string;
  generator_name: string;
  tank_warehouse_id: number | string;
  tank_name: string;
  fuel_filled_liters: number | string;
  fuel_filled_cost: number | string;
  recorded_consumption_liters: number | string;
  actual_consumption_liters: number | string | null;
  litres_per_hour: number | string | null;
  measurement_status: string;
};

type PhaseDFinancialSummary = {
  purchaseInvoiceCount: number | null;
  purchaseInvoiceAmount: number | null;
  supplierPaymentCount: number | null;
  supplierPaymentAmount: number | null;
  supplierReturnCount: number | null;
  supplierReturnCreditAmount: number | null;
};

type MaintenanceReportRow = {
  generator_id: number | string;
  generator_name: string;
  fault_title: string;
  work_order_count: number | string;
  breakdown_count: number | string;
  completed_count: number | string;
  open_count: number | string;
  downtime_minutes: number | string;
  parts_cost: number | string;
  labor_cost: number | string;
  external_service_cost: number | string;
  total_cost_amount: number | string;
};

type Props = {
  siteId: number;
  isAuthenticated: boolean;
  canViewInventory: boolean;
  canViewInventoryReports: boolean;
  canViewSupplierLedger: boolean;
  canReadPurchases: boolean;
  canAccessStocktakes: boolean;
  canManageFuelAndConsumption: boolean;
  onNavigate: (tab: string) => void;
};

type ReportPeriod = "day" | "cycle" | "month" | "custom";
const categoryLabels: Record<string, string> = {
  fuel: "وقود", oil: "زيوت", filter: "فلاتر", spare_part: "قطع غيار",
  maintenance_supply: "مستلزمات صيانة", other: "أخرى",
};
const numberOf = (value: unknown) => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};
function amount(value: number) {
  return "₪" + new Intl.NumberFormat("ar-PS", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number.isFinite(value) ? value : 0);
}
function quantity(value: number) {
  return new Intl.NumberFormat("ar-PS", { maximumFractionDigits: 3 }).format(Number.isFinite(value) ? value : 0);
}
function gazaDateKey(value: string | Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Gaza", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(value));
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}
function monthRange(anchorDate: string) {
  const [year, month] = anchorDate.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { fromDate: `${year}-${String(month).padStart(2, "0")}-01`, toDate: `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}` };
}
function Metric({ label, value, description, icon: Icon }: {
  label: string;
  value: string;
  description: string;
  icon: typeof Boxes;
}) {
  return <Card><CardContent className="flex h-full gap-3 p-4">
    <div className="rounded-md bg-muted p-2"><Icon className="h-5 w-5 text-primary" /></div>
    <div className="min-w-0 flex-1"><p className="text-sm text-muted-foreground">{label}</p><p className="mt-1 break-words text-2xl font-bold tabular-nums">{value}</p><p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p></div>
  </CardContent></Card>;
}

export default function InventoryDashboardPanel({
  siteId, isAuthenticated, canViewInventory, canViewInventoryReports, canViewSupplierLedger,
  canReadPurchases, canAccessStocktakes, canManageFuelAndConsumption, onNavigate,
}: Props) {
  const enabled = Boolean(siteId && isAuthenticated);
  const today = useMemo(() => gazaDateKey(new Date()), []);
  const [period, setPeriod] = useState<ReportPeriod>("cycle");
  const [anchorDate, setAnchorDate] = useState(today);
  const [customFrom, setCustomFrom] = useState(today);
  const [customTo, setCustomTo] = useState(today);
  const [generatorId, setGeneratorId] = useState("");
  const [category, setCategory] = useState("all");
  const [itemSearch, setItemSearch] = useState("");

  const stock = trpc.powerhub.inventory.stockOverview.useQuery(
    { siteId },
    { enabled: enabled && (canViewInventory || canViewInventoryReports), staleTime: 10_000, retry: 1 },
  );
  const cycleReferenceAt = useMemo(() => {
    const parsed = new Date(`${anchorDate}T12:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : new Date().toISOString();
  }, [anchorDate]);
  const cycleBounds = trpc.powerhub.readingCycle.boundsAt.useQuery(
    { siteId, referenceAt: cycleReferenceAt },
    { enabled: enabled && canViewInventoryReports && period === "cycle" && Boolean(anchorDate), staleTime: 60_000, retry: 1 },
  );
  const fuelOptions = trpc.powerhub.inventory.fuelWorkspaceOptions.useQuery(
    { siteId },
    { enabled: enabled && canViewInventoryReports, staleTime: 30_000, retry: 1 },
  );

  const stockRows = (stock.data ?? []) as StockRow[];
  const filteredStockRows = useMemo(() => {
    const query = itemSearch.trim().toLocaleLowerCase();
    return stockRows.filter((row) =>
      (category === "all" || row.category === category) &&
      (!query || [row.item_name, row.sku ?? "", row.warehouse_name].some((value) => value.toLocaleLowerCase().includes(query))),
    );
  }, [stockRows, category, itemSearch]);
  const totals = useMemo(() => {
    const itemIds = new Set(filteredStockRows.map((row) => Number(row.item_id)));
    const lowLocations = filteredStockRows.filter((row) => row.below_reorder_point);
    const lowItems = new Set(lowLocations.map((row) => Number(row.item_id)));
    const stockValue = filteredStockRows.reduce((sum, row) => sum + numberOf(row.stock_value), 0);
    return {
      itemCount: itemIds.size,
      locationsWithStock: new Set(filteredStockRows.filter((row) => numberOf(row.on_hand_quantity) > 0).map((row) => Number(row.warehouse_id))).size,
      lowLocations: lowLocations.length,
      lowItems: lowItems.size,
      stockValue,
    };
  }, [filteredStockRows]);

  const dateRange = useMemo(() => {
    if (period === "custom") {
      if (!customFrom || !customTo || customFrom > customTo) return null;
      const spanDays = (Date.parse(customTo + "T00:00:00.000Z") - Date.parse(customFrom + "T00:00:00.000Z")) / 86_400_000;
      return spanDays <= 365 ? { fromDate: customFrom, toDate: customTo } : null;
    }
    if (period === "day") return anchorDate ? { fromDate: anchorDate, toDate: anchorDate } : null;
    if (period === "month") return anchorDate ? monthRange(anchorDate) : null;
    if (!cycleBounds.data?.startAt || !cycleBounds.data?.endAt) return null;
    const fromDate = gazaDateKey(cycleBounds.data.startAt);
    const toDate = gazaDateKey(cycleBounds.data.endAt);
    return fromDate && toDate && fromDate <= toDate ? { fromDate, toDate } : null;
  }, [period, anchorDate, customFrom, customTo, cycleBounds.data?.startAt, cycleBounds.data?.endAt]);
  const payables = trpc.powerhub.inventory.supplierPayablesAging.useQuery(
    { siteId, asOfDate: dateRange?.toDate },
    { enabled: enabled && canViewSupplierLedger, staleTime: 15_000, retry: 1 },
  );
  const phaseDFinancialSummary = trpc.powerhub.inventory.phaseDFinancialSummary.useQuery(
    { siteId, fromDate: dateRange?.fromDate ?? today, toDate: dateRange?.toDate ?? today },
    { enabled: enabled && canViewInventoryReports && Boolean(dateRange), staleTime: 15_000, retry: 1 },
  );

  const fuelReport = trpc.powerhub.inventory.fuelConsumptionReportPeriod.useQuery(
    {
      siteId, periodType: period, anchorDate: period === "custom" ? undefined : anchorDate,
      fromDate: period === "custom" ? customFrom : undefined,
      toDate: period === "custom" ? customTo : undefined,
      generatorId: generatorId ? Number(generatorId) : undefined,
    },
    {
      enabled: enabled && canViewInventoryReports && Boolean(dateRange) &&
        (period !== "custom" || Boolean(customFrom && customTo && customFrom <= customTo)),
      staleTime: 15_000, retry: 1,
    },
  );
  const maintenanceReport = trpc.powerhub.maintenance.reportByGenerator.useQuery(
    {
      siteId, fromDate: dateRange?.fromDate ?? today, toDate: dateRange?.toDate ?? today,
      generatorId: generatorId ? Number(generatorId) : undefined,
    },
    { enabled: enabled && canViewInventoryReports && Boolean(dateRange), staleTime: 15_000, retry: 1 },
  );

  const fuelRows = (fuelReport.data ?? []) as FuelReportRow[];
  const fuelTotals = useMemo(() => {
    const measuredRows = fuelRows.filter((row) => row.actual_consumption_liters !== null && row.actual_consumption_liters !== undefined);
    const anomalies = fuelRows.filter((row) => row.measurement_status === "reconciliation_anomaly");
    return {
      tanks: fuelRows.length,
      measuredTanks: measuredRows.length,
      anomalies: anomalies.length,
      filledLiters: fuelRows.reduce((sum, row) => sum + numberOf(row.fuel_filled_liters), 0),
      filledCost: fuelRows.reduce((sum, row) => sum + numberOf(row.fuel_filled_cost), 0),
      recordedConsumption: fuelRows.reduce((sum, row) => sum + numberOf(row.recorded_consumption_liters), 0),
      actualConsumption: measuredRows.length ? measuredRows.reduce((sum, row) => sum + numberOf(row.actual_consumption_liters), 0) : null,
    };
  }, [fuelRows]);
  const maintenanceRows = (maintenanceReport.data ?? []) as MaintenanceReportRow[];
  const maintenanceTotals = useMemo(() => ({
    orders: maintenanceRows.reduce((sum, row) => sum + numberOf(row.work_order_count), 0),
    breakdowns: maintenanceRows.reduce((sum, row) => sum + numberOf(row.breakdown_count), 0),
    open: maintenanceRows.reduce((sum, row) => sum + numberOf(row.open_count), 0),
    downtime: maintenanceRows.reduce((sum, row) => sum + numberOf(row.downtime_minutes), 0),
    recordedCost: maintenanceRows.reduce((sum, row) => sum + numberOf(row.total_cost_amount), 0),
  }), [maintenanceRows]);
  const debt = payables.data as unknown as AgingSummary | undefined;
  const reportLoading = canViewInventoryReports && (
    fuelReport.isLoading || maintenanceReport.isLoading || phaseDFinancialSummary.isLoading ||
    (period === "cycle" && cycleBounds.isLoading)
  );
  const reportError = canViewInventoryReports && (
    fuelReport.isError || maintenanceReport.isError || phaseDFinancialSummary.isError ||
    (period === "cycle" && cycleBounds.isError)
  );
  const financialTotals = phaseDFinancialSummary.data as PhaseDFinancialSummary | undefined;

  const refresh = async () => {
    const work: Promise<unknown>[] = [];
    if (canViewInventory || canViewInventoryReports) work.push(stock.refetch());
    if (canViewSupplierLedger) work.push(payables.refetch());
    if (canViewInventoryReports) {
      work.push(fuelReport.refetch());
      work.push(maintenanceReport.refetch());
      work.push(phaseDFinancialSummary.refetch());
      if (period === "cycle") work.push(cycleBounds.refetch());
    }
    await Promise.all(work);
  };
  const isLoading = ((canViewInventory || canViewInventoryReports) && stock.isLoading) ||
    (canViewSupplierLedger && payables.isLoading) || reportLoading;
  const hasError = ((canViewInventory || canViewInventoryReports) && stock.isError) ||
    (canViewSupplierLedger && payables.isError) || reportError;
  const generators = (fuelOptions.data?.generators ?? []) as { id: number; name: string; code?: string | null }[];
  const periodLabel = period === "day" ? "اليوم المحدد" : period === "cycle" ? (cycleBounds.data?.cycleLabel || "الدورة المحددة") : period === "month" ? "الشهر المحدد" : "النطاق المخصص";

  return <div className="space-y-4">
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div><CardTitle>لوحة المؤشرات التشغيلية</CardTitle><p className="mt-1 text-sm text-muted-foreground">مؤشرات الفرع المحدد من سجلات النظام الفعلية. تُطبّق مرشحات الصنف والتصنيف على أرصدة المخزون، والفترة والمولد على تقارير الوقود والصيانة.</p></div>
        <Button type="button" variant="outline" disabled={isLoading} onClick={() => void refresh()}><RefreshCw className={"ml-2 h-4 w-4" + (isLoading ? " animate-spin" : "")} /> تحديث المؤشرات</Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 rounded-md border p-3 sm:grid-cols-2 xl:grid-cols-4">
          <label className="grid gap-1.5 text-sm">الفترة التشغيلية
            <select className="h-10 rounded-md border border-input bg-background px-3 text-sm" value={period} onChange={(event) => setPeriod(event.target.value as ReportPeriod)}>
              <option value="day">يوم</option><option value="cycle">دورة القراءات المعتمدة</option><option value="month">شهر تقويمي</option><option value="custom">نطاق مخصص</option>
            </select>
          </label>
          {period !== "custom" ? <label className="grid gap-1.5 text-sm">التاريخ المرجعي
            <Input type="date" value={anchorDate} onChange={(event) => setAnchorDate(event.target.value)} />
          </label> : <>
            <label className="grid gap-1.5 text-sm">من تاريخ
              <Input type="date" value={customFrom} onChange={(event) => setCustomFrom(event.target.value)} />
            </label>
            <label className="grid gap-1.5 text-sm">إلى تاريخ
              <Input type="date" value={customTo} onChange={(event) => setCustomTo(event.target.value)} />
            </label>
          </>}
          <label className="grid gap-1.5 text-sm">المولد
            <select className="h-10 rounded-md border border-input bg-background px-3 text-sm" value={generatorId} onChange={(event) => setGeneratorId(event.target.value)}>
              <option value="">جميع المولدات</option>{generators.map((generator) => <option key={generator.id} value={generator.id}>{generator.name}{generator.code ? ` — ${generator.code}` : ""}</option>)}
            </select>
          </label>
          <label className="grid gap-1.5 text-sm">تصنيف الصنف
            <select className="h-10 rounded-md border border-input bg-background px-3 text-sm" value={category} onChange={(event) => setCategory(event.target.value)}>
              <option value="all">كل التصنيفات</option>{Object.entries(categoryLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label className="grid gap-1.5 text-sm sm:col-span-2 xl:col-span-3">بحث الصنف أو الرمز أو المخزن
            <Input value={itemSearch} onChange={(event) => setItemSearch(event.target.value)} placeholder="اكتب اسم الصنف أو رمزه أو المخزن…" />
          </label>
          {period === "cycle" ? <p className="text-xs leading-5 text-muted-foreground sm:col-span-2 xl:col-span-4">تُحسب حدود الدورة من إعدادات الفوترة المركزية للفرع وتوقيته المحلي؛ لا تُستبدل الدورة بشهر تقويمي.</p> : null}
        </div>
        {hasError ? <div className="rounded-md border border-destructive/30 p-3 text-sm text-destructive">تعذر تحديث بعض المؤشرات. لم نستبدل البيانات المفقودة بأرقام تقديرية؛ راجع صلاحيات التقارير أو أعد المحاولة.</div> : null}
        {period === "custom" && customFrom > customTo ? <p className="text-sm text-destructive">تاريخ البداية يجب ألا يتجاوز تاريخ النهاية.</p> : null}
        {period === "custom" && customFrom <= customTo && !dateRange ? <p className="text-sm text-destructive">لا يمكن أن يتجاوز نطاق التقرير 366 يومًا؛ اختر فترة أقصر.</p> : null}
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {(canViewInventory || canViewInventoryReports) ? <>
            <Metric label="الأصناف المطابقة" value={stock.isLoading || stock.isError ? "—" : totals.itemCount.toLocaleString("ar-PS")} description="أصناف مميزة ضمن التصنيف والبحث المحددين." icon={Boxes} />
            <Metric label="مواقع التخزين المطابقة" value={stock.isLoading || stock.isError ? "—" : totals.locationsWithStock.toLocaleString("ar-PS")} description="مواقع لديها رصيد موجب بعد تطبيق مرشحات الصنف." icon={Warehouse} />
            <Metric label="مواقع تحتاج إعادة طلب" value={stock.isLoading || stock.isError ? "—" : totals.lowLocations.toLocaleString("ar-PS")} description={totals.lowLocations === 0 ? "لا توجد مواقع مطابقة أسفل حد إعادة الطلب." : `تشمل ${totals.lowItems.toLocaleString("ar-PS")} صنفًا.`} icon={ArrowLeftRight} />
          </> : null}
          {canViewInventoryReports ? <Metric label="القيمة الدفترية للمخزون" value={stock.isLoading || stock.isError ? "—" : amount(totals.stockValue)} description="القيمة الحالية وفق متوسط التكلفة، وليست مصروفًا نقديًا جديدًا." icon={CircleDollarSign} /> : null}
          {canViewSupplierLedger ? <Metric label="الذمم المستحقة للموردين" value={payables.isLoading || payables.isError ? "—" : debt ? amount(numberOf(debt.totals?.total_outstanding)) : "—"} description={debt?.as_of_date ? `حتى ${debt.as_of_date}، حسب الذمم المرحلة.` : "من تقرير أعمار الذمم في الفرع المحدد."} icon={Store} /> : null}
          {canViewInventoryReports && financialTotals?.purchaseInvoiceAmount !== null && financialTotals?.purchaseInvoiceAmount !== undefined ? <Metric label="المشتريات المعتمدة" value={phaseDFinancialSummary.isLoading || phaseDFinancialSummary.isError ? "—" : amount(numberOf(financialTotals.purchaseInvoiceAmount))} description={`${numberOf(financialTotals.purchaseInvoiceCount).toLocaleString("ar-PS")} فاتورة مؤكدة/مستلمة ضمن الفترة؛ ليست مصروف تشغيل جديدًا.`} icon={ClipboardList} /> : null}
          {canViewInventoryReports && financialTotals?.supplierPaymentAmount !== null && financialTotals?.supplierPaymentAmount !== undefined ? <Metric label="دفعات الموردين المرحلة" value={phaseDFinancialSummary.isLoading || phaseDFinancialSummary.isError ? "—" : amount(numberOf(financialTotals.supplierPaymentAmount))} description={`${numberOf(financialTotals.supplierPaymentCount).toLocaleString("ar-PS")} دفعة غير معكوسة ضمن الفترة؛ تمثل التسوية النقدية لا قيمة مشتريات إضافية.`} icon={CircleDollarSign} /> : null}
          {canViewInventoryReports && financialTotals?.supplierReturnCreditAmount !== null && financialTotals?.supplierReturnCreditAmount !== undefined ? <Metric label="ائتمانات مرتجعات الموردين" value={phaseDFinancialSummary.isLoading || phaseDFinancialSummary.isError ? "—" : amount(numberOf(financialTotals.supplierReturnCreditAmount))} description={`${numberOf(financialTotals.supplierReturnCount).toLocaleString("ar-PS")} مرتجعًا مرحلًا؛ يُعرض كائتمان منفصل عن الدفعات النقدية.`} icon={ArrowLeftRight} /> : null}
        </div>
      </CardContent>
    </Card>

    {canViewInventoryReports ? <Card>
      <CardHeader><CardTitle>الوقود والصيانة — {periodLabel}</CardTitle><p className="text-sm text-muted-foreground">تُعرض بيانات الوقود والصيانة وفق الفترة والمولد المحددين. تكلفة الصيانة هنا تكلفة مسجلة على أوامر العمل وليست ترحيلًا محاسبيًا.</p></CardHeader>
      <CardContent>
        {reportLoading ? <p className="mb-3 text-sm text-muted-foreground">جارٍ احتساب مؤشرات الوقود والصيانة…</p> : null}
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Metric label="الوقود المعبأ" value={fuelReport.isLoading || fuelReport.isError ? "—" : `${quantity(fuelTotals.filledLiters)} لتر`} description={`كمية التعبئة في ${periodLabel}؛ لا تعادل بالضرورة الاستهلاك الفعلي.`} icon={Fuel} />
          <Metric label="تكلفة التعبئة" value={fuelReport.isLoading || fuelReport.isError ? "—" : amount(fuelTotals.filledCost)} description="تكلفة التعبئات المسجلة في الفترة، منفصلة عن تكلفة الاستهلاك المحسوب." icon={CircleDollarSign} />
          <Metric label="الاستهلاك المقاس" value={fuelReport.isLoading || fuelReport.isError || fuelTotals.actualConsumption === null ? "—" : `${quantity(fuelTotals.actualConsumption)} لتر`} description={fuelTotals.tanks === 0 ? "لا توجد خزانات ضمن المرشحات." : `قياس صالح لـ${fuelTotals.measuredTanks} من ${fuelTotals.tanks} خزانًا؛ الشذوذ أو نقص القراءة لا يُحوّل إلى صفر.`} icon={Gauge} />
          <Metric label="أوامر الصيانة" value={maintenanceReport.isLoading || maintenanceReport.isError ? "—" : maintenanceTotals.orders.toLocaleString("ar-PS")} description={`${maintenanceTotals.open.toLocaleString("ar-PS")} مفتوح · ${maintenanceTotals.breakdowns.toLocaleString("ar-PS")} بلاغ عطل`} icon={Wrench} />
          <Metric label="توقف المولدات" value={maintenanceReport.isLoading || maintenanceReport.isError ? "—" : `${maintenanceTotals.downtime.toLocaleString("ar-PS")} دقيقة`} description="إجمالي مدة التوقف المسجلة في أوامر الصيانة ضمن النطاق." icon={Gauge} />
          <Metric label="تكلفة الصيانة المسجلة" value={maintenanceReport.isLoading || maintenanceReport.isError ? "—" : amount(maintenanceTotals.recordedCost)} description="القطع والعمالة والخدمات المسجلة؛ لا تُجمع مع المشتريات بوصفها مصروفًا جديدًا." icon={CircleDollarSign} />
        </div>
        {!reportLoading && (fuelReport.isError || maintenanceReport.isError) ? <p className="mt-3 rounded-md border border-destructive/30 p-3 text-sm text-destructive">تعذر تحميل تقرير الوقود أو الصيانة لهذا النطاق. بقيت بيانات المصدر الفاشل غير معروضة بدل إظهار أرقام صفرية.</p> : null}
      </CardContent>
    </Card> : <Card><CardContent className="p-4 text-sm text-muted-foreground">مؤشرات الوقود والصيانة والتكاليف التشغيلية لا تظهر إلا لصلاحية تقارير المخزون.</CardContent></Card>}

    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      {[
        { title: "دليل الأصناف", description: "تعريف الأصناف ووحدات الشراء وحدود إعادة الطلب.", tab: "catalog", icon: Boxes, show: canViewInventory || canViewInventoryReports },
        { title: "المشتريات والاستلام", description: "المسودات والاستلام الجزئي والكامل وحالة السداد.", tab: "purchases", icon: ClipboardList, show: canReadPurchases },
        { title: "المخزون والحركات", description: "الأرصدة والتحويلات والصرف والجرد الفعلي.", tab: "stock", icon: ArrowLeftRight, show: canViewInventory || canAccessStocktakes },
        { title: "الوقود والاستهلاك", description: "التعبئات والقراءات والاستهلاك المقاس والتنبيهات.", tab: "fuel", icon: Fuel, show: canManageFuelAndConsumption || canViewInventoryReports },
        { title: "التقارير والتصدير", description: "الأرصدة والتكلفة وسجل الحركات الكامل.", tab: "reports", icon: CircleDollarSign, show: canViewInventoryReports },
      ].filter((entry) => entry.show).map(({ title, description, tab, icon: Icon }) => <Card key={tab}><CardContent className="flex h-full flex-col gap-3 p-4"><Icon className="h-5 w-5 text-primary" /><div className="font-semibold">{title}</div><p className="flex-1 text-sm leading-6 text-muted-foreground">{description}</p><Button type="button" variant="outline" className="w-full" onClick={() => onNavigate(tab)}>فتح المساحة</Button></CardContent></Card>)}
    </div>
  </div>;
}
