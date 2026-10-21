import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import DashboardLayout from "@/components/DashboardLayout";
import InventoryPurchasesPanel from "@/components/InventoryPurchasesPanel";
import InventoryStockOperationsPanel from "@/components/InventoryStockOperationsPanel";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { trpc } from "@/lib/trpc";
import { useBranchFilter } from "@/hooks/useBranchFilter";
import { Boxes, ClipboardList, Loader2, PackagePlus, Search, Store, Warehouse, ArrowLeftRight } from "lucide-react";
import { toast } from "sonner";

const categoryLabels: Record<string, string> = {
  fuel: "وقود",
  oil: "زيوت",
  filter: "فلاتر",
  spare_part: "قطع غيار",
  maintenance_supply: "مستلزمات صيانة",
  other: "أخرى",
};
const unitLabels: Record<string, string> = {
  liter: "لتر",
  milliliter: "ملليلتر",
  piece: "قطعة",
  container: "عبوة",
  kg: "كغم",
  gram: "غرام",
  meter: "متر",
  set: "طقم",
  gallon: "غالون",
  other: "أخرى",
};

function formatSupplierLedgerAmount(value: unknown) {
  const amount = Number(value ?? 0);
  return "₪" + new Intl.NumberFormat("ar-PS", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number.isFinite(amount) ? amount : 0);
}

export default function InventoryWorkspacePage() {
  const { isAuthenticated } = useAuth();
  const sites = trpc.powerhub.sites.list.useQuery(undefined, { enabled: isAuthenticated });
  const { branchId: selectedSiteId } = useBranchFilter(sites.data);
  const siteId = selectedSiteId && sites.data?.some((site) => site.id === selectedSiteId)
    ? selectedSiteId
    : sites.data?.[0]?.id ?? 0;
  const supplierAccess = trpc.powerhub.staff.myAccess.useQuery({ siteId }, {
    enabled: Boolean(siteId && isAuthenticated),
    staleTime: 30_000,
  });
  const canViewSuppliers = supplierAccess.data?.permissions.includes("viewSuppliers") ?? false;
  const canViewSupplierLedger = supplierAccess.data?.permissions.includes("viewSupplierLedger") ?? false;
  const canViewInventory = supplierAccess.data?.permissions.includes("viewInventory") ?? false;
  const canViewInventoryReports = supplierAccess.data?.permissions.includes("viewInventoryReports") ?? false;
  const canIssueInventory = supplierAccess.data?.permissions.includes("issueInventory") ?? false;
  const canAdjustInventory = supplierAccess.data?.permissions.includes("adjustInventory") ?? false;
  const canManageFuelAndConsumption = supplierAccess.data?.permissions.includes("manageFuelAndConsumption") ?? false;
  const canReadStock = canViewInventory || canViewInventoryReports;
  const canViewPurchases = supplierAccess.data?.permissions.includes("viewPurchases") ?? false;
  const canCreatePurchases = supplierAccess.data?.permissions.includes("createPurchases") ?? false;
  const canApprovePurchases = supplierAccess.data?.permissions.includes("approvePurchases") ?? false;
  const canReceiveInventory = supplierAccess.data?.permissions.includes("receiveInventory") ?? false;
  const canManageSupplierPayments = supplierAccess.data?.permissions.includes("manageSupplierPayments") ?? false;
  const canReadPurchases = canViewPurchases || canReceiveInventory || canManageSupplierPayments || canAdjustInventory;
  const canViewPurchaseFinancials = canViewPurchases || canManageSupplierPayments;
  const utils = trpc.useUtils();
  const [tab, setTab] = useState("catalog");
  const [itemSearch, setItemSearch] = useState("");
  const [supplierSearch, setSupplierSearch] = useState("");
  const [selectedSupplierLedgerId, setSelectedSupplierLedgerId] = useState<number | null>(null);
  const [showItemForm, setShowItemForm] = useState(false);
  const [showSupplierForm, setShowSupplierForm] = useState(false);
  const [showWarehouseForm, setShowWarehouseForm] = useState(false);

  const [sku, setSku] = useState("");
  const [itemName, setItemName] = useState("");
  const [category, setCategory] = useState("other");
  const [baseUnit, setBaseUnit] = useState("piece");
  const [reorderPoint, setReorderPoint] = useState("0");
  const [specification, setSpecification] = useState("");
  const [itemNotes, setItemNotes] = useState("");

  const [supplierCode, setSupplierCode] = useState("");
  const [supplierName, setSupplierName] = useState("");
  const [contactName, setContactName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [paymentTerms, setPaymentTerms] = useState("0");
  const [supplierNotes, setSupplierNotes] = useState("");

  const [warehouseCode, setWarehouseCode] = useState("");
  const [warehouseName, setWarehouseName] = useState("");
  const [warehouseNotes, setWarehouseNotes] = useState("");

  const items = trpc.powerhub.inventory.listItems.useQuery(
    { siteId, search: itemSearch || undefined },
    { enabled: Boolean(siteId && isAuthenticated), staleTime: 30_000 },
  );
  const suppliers = trpc.powerhub.inventory.listSuppliers.useQuery(
    { siteId, search: supplierSearch || undefined },
    { enabled: Boolean(siteId && isAuthenticated && canViewSuppliers), staleTime: 30_000 },
  );
  const supplierLedger = trpc.powerhub.inventory.supplierLedgerStatement.useQuery(
    { siteId, supplierId: selectedSupplierLedgerId ?? 0, limit: 200 },
    { enabled: Boolean(siteId && isAuthenticated && canViewSupplierLedger && selectedSupplierLedgerId), staleTime: 15_000 },
  );
  const warehouses = trpc.powerhub.inventory.listWarehouses.useQuery(
    { siteId },
    { enabled: Boolean(siteId && isAuthenticated), staleTime: 30_000 },
  );

  const createItem = trpc.powerhub.inventory.createItem.useMutation({
    onSuccess: async () => {
      toast.success("تمت إضافة الصنف إلى الدليل الموحد.");
      setSku(""); setItemName(""); setCategory("other"); setBaseUnit("piece");
      setReorderPoint("0"); setSpecification(""); setItemNotes(""); setShowItemForm(false);
      await utils.powerhub.inventory.listItems.invalidate();
    },
    onError: (error) => toast.error(error.message || "تعذرت إضافة الصنف."),
  });
  const createSupplier = trpc.powerhub.inventory.createSupplier.useMutation({
    onSuccess: async () => {
      toast.success("تمت إضافة المورد.");
      setSupplierCode(""); setSupplierName(""); setContactName(""); setPhone("");
      setEmail(""); setPaymentTerms("0"); setSupplierNotes(""); setShowSupplierForm(false);
      await utils.powerhub.inventory.listSuppliers.invalidate();
    },
    onError: (error) => toast.error(error.message || "تعذرت إضافة المورد."),
  });
  const createWarehouse = trpc.powerhub.inventory.createWarehouse.useMutation({
    onSuccess: async () => {
      toast.success("تم إنشاء المخزن.");
      setWarehouseCode(""); setWarehouseName(""); setWarehouseNotes(""); setShowWarehouseForm(false);
      await utils.powerhub.inventory.listWarehouses.invalidate();
    },
    onError: (error) => toast.error(error.message || "تعذر إنشاء المخزن."),
  });

  useEffect(() => {
    if ((!canViewSuppliers && tab === "suppliers") || (!canReadPurchases && tab === "purchases") || (!canReadStock && tab === "stock")) setTab("catalog");
  }, [canViewSuppliers, canReadPurchases, canReadStock, tab]);

  const selectedSiteName = useMemo(() => sites.data?.find((site) => site.id === siteId)?.name ?? "", [sites.data, siteId]);

  if (sites.isLoading) {
    return <DashboardLayout><div className="flex min-h-[40vh] items-center justify-center gap-2 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /> جارٍ تحميل بيانات الفروع…</div></DashboardLayout>;
  }

  return (
    <DashboardLayout>
      <div dir="rtl" className="mx-auto w-full max-w-7xl space-y-5 p-3 md:p-6">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex items-center gap-2"><Boxes className="h-6 w-6 text-primary" /><h1 className="text-2xl font-bold">المخزون والمشتريات والصيانة</h1></div>
            <p className="mt-1 text-sm text-muted-foreground">إدارة دليل الأصناف والموردين والمخازن من مساحة موحدة.</p>
            {selectedSiteName ? <p className="mt-1 text-xs text-muted-foreground">الفرع: {selectedSiteName}</p> : null}
          </div>
        </header>

        {!siteId ? (
          <Card><CardContent className="p-6 text-center text-muted-foreground">لا يوجد فرع متاح لهذا الحساب. أنشئ فرعًا أولًا أو تواصل مع مدير المنصة.</CardContent></Card>
        ) : (
          <Tabs value={tab} onValueChange={setTab} dir="rtl" className="space-y-4">
            <div className="overflow-x-auto pb-1">
              <TabsList className="inline-flex min-w-max gap-1">
                <TabsTrigger value="catalog" className="gap-2"><Boxes className="h-4 w-4" /> دليل الأصناف</TabsTrigger>
                {canViewSuppliers ? <TabsTrigger value="suppliers" className="gap-2"><Store className="h-4 w-4" /> الموردون</TabsTrigger> : null}
                <TabsTrigger value="warehouses" className="gap-2"><Warehouse className="h-4 w-4" /> المخازن</TabsTrigger>
                {canReadStock ? <TabsTrigger value="stock" className="gap-2"><ArrowLeftRight className="h-4 w-4" /> الأرصدة والحركات</TabsTrigger> : null}
                {canReadPurchases ? <TabsTrigger value="purchases" className="gap-2"><ClipboardList className="h-4 w-4" /> المشتريات</TabsTrigger> : null}
              </TabsList>
            </div>

            <TabsContent value="catalog" className="space-y-4">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
                  <div><CardTitle>دليل الأصناف الموحد</CardTitle><p className="mt-1 text-sm text-muted-foreground">تعريف الصنف لا يضيف كمية إلى المخزون؛ الكميات تُضاف لاحقًا من استلام المشتريات.</p></div>
                  <Button onClick={() => setShowItemForm((value) => !value)}><PackagePlus className="ml-2 h-4 w-4" /> {showItemForm ? "إلغاء" : "إضافة صنف"}</Button>
                </CardHeader>
                {showItemForm ? <CardContent className="border-t pt-4">
                  <form className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3" onSubmit={(event) => {
                    event.preventDefault();
                    const point = Number(reorderPoint);
                    if (!Number.isFinite(point) || point < 0) { toast.error("أدخل حد إعادة طلب صحيحًا."); return; }
                    createItem.mutate({ siteId, sku: sku.trim() || undefined, name: itemName.trim(), category: category as "fuel" | "oil" | "filter" | "spare_part" | "maintenance_supply" | "other", baseUnit: baseUnit as "liter" | "milliliter" | "piece" | "container" | "kg" | "gram" | "meter" | "set" | "gallon" | "other", reorderPoint: point, specification: specification.trim() || undefined, notes: itemNotes.trim() || undefined });
                  }}>
                    <label className="space-y-1 text-sm">اسم الصنف *<Input required maxLength={180} value={itemName} onChange={(e) => setItemName(e.target.value)} placeholder="مثال: سولار" /></label>
                    <label className="space-y-1 text-sm">رمز الصنف (اختياري)<Input maxLength={80} value={sku} onChange={(e) => setSku(e.target.value)} placeholder="FUEL-001" /></label>
                    <label className="space-y-1 text-sm">التصنيف<select className="h-10 w-full rounded-md border bg-background px-3" value={category} onChange={(e) => setCategory(e.target.value)}>{Object.entries(categoryLabels).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                    <label className="space-y-1 text-sm">وحدة القياس الأساسية<select className="h-10 w-full rounded-md border bg-background px-3" value={baseUnit} onChange={(e) => setBaseUnit(e.target.value)}>{Object.entries(unitLabels).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                    <label className="space-y-1 text-sm">حد إعادة الطلب<Input type="number" min="0" step="0.001" value={reorderPoint} onChange={(e) => setReorderPoint(e.target.value)} /></label>
                    <label className="space-y-1 text-sm">المواصفات<Input maxLength={500} value={specification} onChange={(e) => setSpecification(e.target.value)} /></label>
                    <label className="space-y-1 text-sm md:col-span-2">ملاحظات<Input maxLength={2000} value={itemNotes} onChange={(e) => setItemNotes(e.target.value)} /></label>
                    <div className="flex items-end"><Button type="submit" disabled={createItem.isPending || !itemName.trim()}>{createItem.isPending ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : null} حفظ الصنف</Button></div>
                  </form>
                </CardContent> : null}
                <CardContent className="space-y-3">
                  <div className="relative max-w-md"><Search className="absolute right-3 top-3 h-4 w-4 text-muted-foreground" /><Input className="pr-9" value={itemSearch} onChange={(e) => setItemSearch(e.target.value)} placeholder="ابحث باسم الصنف أو رمزه…" /></div>
                  {items.isLoading ? <p className="py-8 text-center text-muted-foreground">جارٍ تحميل الأصناف…</p> : items.error ? <p className="py-8 text-center text-destructive">تعذر تحميل دليل الأصناف. حدّث الصفحة أو تحقق من صلاحياتك.</p> : !items.data?.length ? <p className="py-8 text-center text-muted-foreground">لا توجد أصناف بعد. استخدم «إضافة صنف» لبدء الدليل.</p> : <div className="overflow-x-auto rounded-md border"><table className="w-full min-w-[720px] text-right text-sm"><thead className="bg-muted/60"><tr>{["الصنف","الرمز","التصنيف","الوحدة","حد إعادة الطلب","الحالة"].map((x) => <th key={x} className="p-3 font-semibold">{x}</th>)}</tr></thead><tbody>{items.data.map((item) => <tr key={item.id} className="border-t"><td className="p-3 font-medium">{item.name}<div className="text-xs text-muted-foreground">{item.specification || ""}</div></td><td className="p-3">{item.sku || "—"}</td><td className="p-3">{categoryLabels[item.category] || item.category}</td><td className="p-3">{unitLabels[item.base_unit] || item.base_unit}</td><td className="p-3 tabular-nums">{Number(item.reorder_point).toLocaleString("ar", { maximumFractionDigits: 3 })}</td><td className="p-3">{item.is_active ? "نشط" : "موقوف"}</td></tr>)}</tbody></table></div>}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="suppliers" className="space-y-4">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0"><div><CardTitle>دليل الموردين</CardTitle><p className="mt-1 text-sm text-muted-foreground">تُستخدم بيانات المورد عند تسجيل المشتريات والذمم.</p></div><Button onClick={() => setShowSupplierForm((value) => !value)}><PackagePlus className="ml-2 h-4 w-4" /> {showSupplierForm ? "إلغاء" : "إضافة مورد"}</Button></CardHeader>
                {showSupplierForm ? <CardContent className="border-t pt-4"><form className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3" onSubmit={(event) => {event.preventDefault(); const days = Number(paymentTerms); if (!Number.isInteger(days) || days < 0 || days > 3650) {toast.error("مدة السداد يجب أن تكون عدد أيام صحيحًا."); return;} createSupplier.mutate({siteId,supplierCode:supplierCode.trim() || undefined,name:supplierName.trim(),contactName:contactName.trim() || undefined,phone:phone.trim() || undefined,email:email.trim(),defaultPaymentTermsDays:days,notes:supplierNotes.trim() || undefined});}}>
                  <label className="space-y-1 text-sm">اسم المورد *<Input required maxLength={180} value={supplierName} onChange={(e) => setSupplierName(e.target.value)} /></label>
                  <label className="space-y-1 text-sm">رمز المورد<Input maxLength={80} value={supplierCode} onChange={(e) => setSupplierCode(e.target.value)} /></label>
                  <label className="space-y-1 text-sm">مسؤول التواصل<Input maxLength={180} value={contactName} onChange={(e) => setContactName(e.target.value)} /></label>
                  <label className="space-y-1 text-sm">الهاتف<Input maxLength={40} value={phone} onChange={(e) => setPhone(e.target.value)} /></label>
                  <label className="space-y-1 text-sm">البريد الإلكتروني<Input type="email" maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} /></label>
                  <label className="space-y-1 text-sm">أجل السداد الافتراضي (أيام)<Input type="number" min="0" max="3650" step="1" value={paymentTerms} onChange={(e) => setPaymentTerms(e.target.value)} /></label>
                  <label className="space-y-1 text-sm md:col-span-2">ملاحظات<Input maxLength={2000} value={supplierNotes} onChange={(e) => setSupplierNotes(e.target.value)} /></label>
                  <div className="flex items-end"><Button type="submit" disabled={createSupplier.isPending || !supplierName.trim()}>{createSupplier.isPending ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : null} حفظ المورد</Button></div>
                </form></CardContent> : null}
                <CardContent className="space-y-3"><div className="relative max-w-md"><Search className="absolute right-3 top-3 h-4 w-4 text-muted-foreground" /><Input className="pr-9" value={supplierSearch} onChange={(e) => setSupplierSearch(e.target.value)} placeholder="ابحث باسم المورد أو الرمز أو الهاتف…" /></div>
                  {suppliers.isLoading ? <p className="py-8 text-center text-muted-foreground">جارٍ تحميل الموردين…</p> : suppliers.error ? <p className="py-8 text-center text-destructive">تعذر تحميل الموردين. تحقق من صلاحياتك.</p> : !suppliers.data?.length ? <p className="py-8 text-center text-muted-foreground">لا يوجد موردون مسجلون بعد.</p> : <div className="overflow-x-auto rounded-md border"><table className="w-full min-w-[650px] text-right text-sm"><thead className="bg-muted/60"><tr>{["المورد","الرمز","مسؤول التواصل","الهاتف","أجل السداد","الحالة",...(canViewSupplierLedger ? ["كشف الحساب"] : [])].map((x) => <th key={x} className="p-3 font-semibold">{x}</th>)}</tr></thead><tbody>{suppliers.data.map((supplier) => <tr key={supplier.id} className="border-t"><td className="p-3 font-medium">{supplier.name}<div className="text-xs text-muted-foreground">{supplier.email || ""}</div></td><td className="p-3">{supplier.supplier_code || "—"}</td><td className="p-3">{supplier.contact_name || "—"}</td><td className="p-3">{supplier.phone || "—"}</td><td className="p-3">{supplier.default_payment_terms_days} يوم</td><td className="p-3">{supplier.is_active ? "نشط" : "موقوف"}</td>{canViewSupplierLedger ? <td className="p-3"><Button type="button" variant="outline" size="sm" onClick={() => setSelectedSupplierLedgerId(Number(supplier.id))}>كشف الحساب</Button></td> : null}</tr>)}</tbody></table></div>}
                </CardContent>
              </Card>
                {canViewSupplierLedger && selectedSupplierLedgerId ? <Card>
                  <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
                    <div><CardTitle>كشف حساب المورد — {supplierLedger.data?.supplier?.name ?? "جارٍ التحميل…"}</CardTitle><p className="mt-1 text-sm text-muted-foreground">كشف الفرع الحالي؛ الرصيد الموجب يمثل مبلغًا مستحقًا للمورد.</p></div>
                    <div className="flex items-center gap-3"><div><p className="text-xs text-muted-foreground">الرصيد المستحق</p><p className="font-bold tabular-nums">{supplierLedger.data ? formatSupplierLedgerAmount(supplierLedger.data.balance) : "—"}</p></div><Button type="button" variant="outline" onClick={() => setSelectedSupplierLedgerId(null)}>إغلاق</Button></div>
                  </CardHeader>
                  <CardContent>
                    {supplierLedger.isLoading ? <p className="py-6 text-center text-muted-foreground">جارٍ تحميل كشف الحساب…</p> : supplierLedger.error ? <p className="py-6 text-center text-destructive">تعذر تحميل كشف حساب المورد. تحقق من الصلاحيات.</p> : !supplierLedger.data?.entries?.length ? <p className="py-6 text-center text-muted-foreground">لا توجد حركات مالية لهذا المورد في الفرع الحالي.</p> : <div className="overflow-x-auto rounded-md border"><table className="w-full min-w-[760px] text-right text-sm"><thead className="bg-muted/60"><tr>{["التاريخ","نوع الحركة","البيان","المرجع","مدين","دائن"].map((label) => <th key={label} className="p-3 font-semibold">{label}</th>)}</tr></thead><tbody>{supplierLedger.data.entries.map((entry: any) => <tr key={entry.id} className="border-t"><td className="p-3 whitespace-nowrap">{new Date(entry.occurred_at).toLocaleDateString("ar-PS")}</td><td className="p-3">{({purchase:"فاتورة مشتريات",payment:"دفعة مورد",opening_balance:"رصيد افتتاحي",supplier_return:"مرتجع مورد",debit_note:"إشعار مدين",credit_note:"إشعار دائن",adjustment:"تسوية",reversal:"قيد عكسي"} as Record<string,string>)[entry.entry_type] ?? entry.entry_type}</td><td className="p-3">{entry.description}</td><td className="p-3">{entry.reference_no || "—"}</td><td className="p-3 tabular-nums">{formatSupplierLedgerAmount(entry.debit_amount)}</td><td className="p-3 tabular-nums">{formatSupplierLedgerAmount(entry.credit_amount)}</td></tr>)}</tbody></table></div>}
                    {supplierLedger.data && supplierLedger.data.entry_count > supplierLedger.data.entries.length ? <p className="mt-2 text-xs text-muted-foreground">يعرض أحدث {supplierLedger.data.entries.length} حركة من أصل {supplierLedger.data.entry_count}؛ الرصيد محسوب من كامل السجل.</p> : null}
                  </CardContent>
                </Card> : null}
            </TabsContent>

            <TabsContent value="warehouses" className="space-y-4">
              <Card><CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0"><div><CardTitle>المخازن</CardTitle><p className="mt-1 text-sm text-muted-foreground">كل مخزن مرتبط بالفرع الحالي؛ لا توجد حركة كمية بمجرد إنشائه.</p></div><Button onClick={() => setShowWarehouseForm((value) => !value)}><Warehouse className="ml-2 h-4 w-4" /> {showWarehouseForm ? "إلغاء" : "إنشاء مخزن"}</Button></CardHeader>
                {showWarehouseForm ? <CardContent className="border-t pt-4"><form className="grid grid-cols-1 gap-3 md:grid-cols-3" onSubmit={(event) => {event.preventDefault(); createWarehouse.mutate({siteId,code:warehouseCode.trim(),name:warehouseName.trim(),notes:warehouseNotes.trim() || undefined});}}>
                  <label className="space-y-1 text-sm">رمز المخزن *<Input required maxLength={40} value={warehouseCode} onChange={(e) => setWarehouseCode(e.target.value)} /></label>
                  <label className="space-y-1 text-sm">اسم المخزن *<Input required maxLength={120} value={warehouseName} onChange={(e) => setWarehouseName(e.target.value)} /></label>
                  <label className="space-y-1 text-sm">ملاحظات<Input maxLength={2000} value={warehouseNotes} onChange={(e) => setWarehouseNotes(e.target.value)} /></label>
                  <div><Button type="submit" disabled={createWarehouse.isPending || !warehouseCode.trim() || !warehouseName.trim()}>{createWarehouse.isPending ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : null} حفظ المخزن</Button></div>
                </form></CardContent> : null}
                <CardContent>{warehouses.isLoading ? <p className="py-8 text-center text-muted-foreground">جارٍ تحميل المخازن…</p> : warehouses.error ? <p className="py-8 text-center text-destructive">تعذر تحميل المخازن. تحقق من صلاحياتك.</p> : !warehouses.data?.length ? <p className="py-8 text-center text-muted-foreground">لا توجد مخازن لهذا الفرع.</p> : <div className="overflow-x-auto rounded-md border"><table className="w-full text-right text-sm"><thead className="bg-muted/60"><tr>{["الرمز","اسم المخزن","ملاحظات","الحالة"].map((x) => <th key={x} className="p-3 font-semibold">{x}</th>)}</tr></thead><tbody>{warehouses.data.map((warehouse) => <tr key={warehouse.id} className="border-t"><td className="p-3">{warehouse.code}</td><td className="p-3 font-medium">{warehouse.name}</td><td className="p-3">{warehouse.notes || "—"}</td><td className="p-3">{warehouse.is_active ? "نشط" : "موقوف"}</td></tr>)}</tbody></table></div>}</CardContent>
              </Card>
            </TabsContent>

            {canReadStock ? <TabsContent value="stock" className="space-y-4">
              <InventoryStockOperationsPanel
                siteId={siteId}
                isAuthenticated={isAuthenticated}
                canIssueInventory={canIssueInventory}
                canAdjustInventory={canAdjustInventory}
                canManageFuelAndConsumption={canManageFuelAndConsumption}
                canViewInventoryReports={canViewInventoryReports}
              />
            </TabsContent> : null}

            {canReadPurchases ? <TabsContent value="purchases" className="space-y-4">
              <InventoryPurchasesPanel
                siteId={siteId}
                isAuthenticated={isAuthenticated}
                canViewPurchases={canReadPurchases}
                canViewFinancials={canViewPurchaseFinancials}
                canManageSupplierPayments={canManageSupplierPayments}
                canCreatePurchases={canCreatePurchases}
                canApprovePurchases={canApprovePurchases}
                canReceiveInventory={canReceiveInventory}
                canAdjustInventory={canAdjustInventory}
              />
            </TabsContent> : null}
          </Tabs>
        )}
      </div>
    </DashboardLayout>
  );
}
