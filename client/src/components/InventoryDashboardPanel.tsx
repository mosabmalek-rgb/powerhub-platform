import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import { ArrowLeftRight, Boxes, CircleDollarSign, ClipboardList, Fuel, Gauge, RefreshCw, Store, Warehouse, Wrench } from "lucide-react";

type StockRow = {
  warehouse_id: number | string;
  item_id: number | string;
  on_hand_quantity: number | string;
  reorder_point: number | string;
  stock_value?: number | string | null;
  below_reorder_point: boolean;
};

type AgingSummary = {
  totals?: { total_outstanding?: number | string | null };
  as_of_date?: string;
};

type Props = {
  siteId: number;
  isAuthenticated: boolean;
  canViewInventory: boolean;
  canViewInventoryReports: boolean;
  canViewSupplierLedger: boolean;
  onNavigate: (tab: string) => void;
};

function amount(value: number) {
  return "₪" + new Intl.NumberFormat("ar-PS", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number.isFinite(value) ? value : 0);
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
  siteId, isAuthenticated, canViewInventory, canViewInventoryReports, canViewSupplierLedger, onNavigate,
}: Props) {
  const enabled = Boolean(siteId && isAuthenticated);
  const stock = trpc.powerhub.inventory.stockOverview.useQuery(
    { siteId },
    { enabled: enabled && (canViewInventory || canViewInventoryReports), staleTime: 10_000, retry: 1 },
  );
  const payables = trpc.powerhub.inventory.supplierPayablesAging.useQuery(
    { siteId },
    { enabled: enabled && canViewSupplierLedger, staleTime: 15_000, retry: 1 },
  );
  const rows = (stock.data ?? []) as StockRow[];
  const totals = useMemo(() => {
    const itemIds = new Set(rows.map((row) => Number(row.item_id)));
    const lowLocations = rows.filter((row) => row.below_reorder_point);
    const lowItems = new Set(lowLocations.map((row) => Number(row.item_id)));
    const stockValue = rows.reduce((sum, row) => sum + Number(row.stock_value ?? 0), 0);
    return { itemCount: itemIds.size, locationsWithStock: new Set(rows.filter((row) => Number(row.on_hand_quantity) > 0).map((row) => Number(row.warehouse_id))).size, lowLocations: lowLocations.length, lowItems: lowItems.size, stockValue };
  }, [rows]);
  const debt = payables.data as unknown as AgingSummary | undefined;
  const refresh = async () => {
    const work: Promise<unknown>[] = [];
    if (canViewInventory || canViewInventoryReports) work.push(stock.refetch());
    if (canViewSupplierLedger) work.push(payables.refetch());
    await Promise.all(work);
  };
  const isLoading = ((canViewInventory || canViewInventoryReports) && stock.isLoading) || (canViewSupplierLedger && payables.isLoading);
  const hasError = ((canViewInventory || canViewInventoryReports) && stock.isError) || (canViewSupplierLedger && payables.isError);

  return <div className="space-y-4">
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div><CardTitle>ملخص المخزون والمشتريات</CardTitle><p className="mt-1 text-sm text-muted-foreground">الأرقام من سجلات النظام للفرع المحدد، وتُخفى القيم المالية عند غياب صلاحية عرض التقارير المالية للمخزون.</p></div>
        <Button type="button" variant="outline" disabled={isLoading} onClick={() => void refresh()}><RefreshCw className={"ml-2 h-4 w-4" + (isLoading ? " animate-spin" : "")} /> تحديث المؤشرات</Button>
      </CardHeader>
      <CardContent>
        {hasError ? <div className="mb-4 rounded-md border border-destructive/30 p-3 text-sm text-destructive">تعذر تحديث بعض المؤشرات. لم نستبدل البيانات المفقودة بأرقام تقديرية؛ استخدم زر التحديث لإعادة المحاولة.</div> : null}
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {(canViewInventory || canViewInventoryReports) ? <>
            <Metric label="الأصناف في المخزون" value={stock.isLoading || stock.isError ? "—" : totals.itemCount.toLocaleString("ar-PS")} description="عدد الأصناف المميزة في أرصدة مواقع التخزين." icon={Boxes} />
            <Metric label="مواقع التخزين المستخدمة" value={stock.isLoading || stock.isError ? "—" : totals.locationsWithStock.toLocaleString("ar-PS")} description="مواقع لديها كمية موجبة مسجلة حاليًا." icon={Warehouse} />
            <Metric label="مواقع تحتاج إعادة طلب" value={stock.isLoading || stock.isError ? "—" : totals.lowLocations.toLocaleString("ar-PS")} description={stock.isLoading || stock.isError ? "تُعرض بعد تحميل الأرصدة." : totals.lowLocations === 0 ? "لا توجد مواقع أسفل حد إعادة الطلب." : `تشمل ${totals.lowItems.toLocaleString("ar-PS")} صنفًا مميزًا.`} icon={ArrowLeftRight} />
          </> : null}
          {canViewInventoryReports ? <Metric label="القيمة الدفترية للمخزون" value={stock.isLoading || stock.isError ? "—" : amount(totals.stockValue)} description="القيمة الحالية المسجلة وفق متوسط التكلفة؛ لا تمثل مصروفًا نقديًا جديدًا." icon={CircleDollarSign} /> : null}
          {canViewSupplierLedger ? <Metric label="الذمم المستحقة للموردين" value={payables.isLoading || payables.isError ? "—" : amount(Number(debt?.totals?.total_outstanding ?? 0))} description={debt?.as_of_date ? `حتى ${debt.as_of_date}، حسب الدفعات والمرتجعات المرحلة.` : "من تقرير أعمار الذمم في الفرع الحالي."} icon={Store} /> : null}
        </div>
        {!canViewInventory && !canViewInventoryReports && !canViewSupplierLedger ? <p className="rounded-md border p-5 text-center text-sm text-muted-foreground">لا تملك صلاحية عرض مؤشرات المخزون أو ذمم الموردين.</p> : null}
      </CardContent>
    </Card>

    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      {[
        { title: "دليل الأصناف", description: "تعريف الأصناف ووحدات الشراء وحدود إعادة الطلب.", tab: "catalog", icon: Boxes, show: canViewInventory || canViewInventoryReports },
        { title: "المشتريات والاستلام", description: "المسودات والاستلام الجزئي والكامل وحالة السداد.", tab: "purchases", icon: ClipboardList, show: true },
        { title: "المخزون والحركات", description: "الأرصدة والتحويلات والصرف والجرد الفعلي.", tab: "stock", icon: ArrowLeftRight, show: canViewInventory },
        { title: "التقارير والتصدير", description: "الأرصدة والتكلفة وسجل الحركات الكامل.", tab: "reports", icon: CircleDollarSign, show: canViewInventoryReports },
      ].filter((entry) => entry.show).map(({ title, description, tab, icon: Icon }) => <Card key={tab}><CardContent className="flex h-full flex-col gap-3 p-4"><Icon className="h-5 w-5 text-primary" /><div className="font-semibold">{title}</div><p className="flex-1 text-sm leading-6 text-muted-foreground">{description}</p><Button type="button" variant="outline" className="w-full" onClick={() => onNavigate(tab)}>فتح المساحة</Button></CardContent></Card>)}
    </div>

    <Card><CardHeader><CardTitle>مؤشرات قيد الاستكمال</CardTitle><p className="text-sm text-muted-foreground">لا تظهر أرقامًا مصطنعة قبل بناء مصادر البيانات وعملياتها المعتمدة.</p></CardHeader>
      <CardContent className="grid gap-3 md:grid-cols-2">
        <div className="flex gap-3 rounded-md border p-4"><Fuel className="mt-1 h-5 w-5 shrink-0 text-muted-foreground" /><div><p className="font-semibold">الاستهلاك الفعلي وكفاءة الوقود</p><p className="mt-1 text-sm leading-6 text-muted-foreground">سيُتاح في المرحلة B بعد تسجيل التعبئة وقياسات الخزان وساعات التشغيل؛ حركات الصرف وحدها لا تثبت الاستهلاك الفعلي.</p><span className="mt-2 inline-block rounded border px-2 py-1 text-xs">المرحلة B</span></div></div>
        <div className="flex gap-3 rounded-md border p-4"><Wrench className="mt-1 h-5 w-5 shrink-0 text-muted-foreground" /><div><p className="font-semibold">الصيانة المتأخرة وتكلفة تشغيل المولد</p><p className="mt-1 text-sm leading-6 text-muted-foreground">سيُتاح في المرحلة C بعد تطبيق أوامر الصيانة والجداول الوقائية وربط قطع الغيار والتكاليف.</p><span className="mt-2 inline-block rounded border px-2 py-1 text-xs">المرحلة C</span></div></div>
        <div className="flex gap-3 rounded-md border p-4 md:col-span-2"><Gauge className="mt-1 h-5 w-5 shrink-0 text-muted-foreground" /><div><p className="font-semibold">حالة المصدر</p><p className="mt-1 text-sm leading-6 text-muted-foreground">يُعرض الرصيد الحالي من دالة أرصدة المخزون، والذمم من تقرير أعمار الذمم. إذا فشل المصدر يظهر شرطة أو تنبيه بدل الصفر، والقيم المالية تخضع لصلاحية التقارير.</p></div></div>
      </CardContent>
    </Card>
  </div>;
}
