import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import DashboardLayout from "@/components/DashboardLayout";
import InventoryPurchasesPanel from "@/components/InventoryPurchasesPanel";
import InventoryStockOperationsPanel from "@/components/InventoryStockOperationsPanel";
import InventoryWarehouseTransferPanel from "@/components/InventoryWarehouseTransferPanel";
import InventoryReportsPanel from "@/components/InventoryReportsPanel";
import InventorySupplierPaymentsPanel from "@/components/InventorySupplierPaymentsPanel";
import InventorySupplierPayablesAgingPanel from "@/components/InventorySupplierPayablesAgingPanel";
import InventoryStocktakePanel from "@/components/InventoryStocktakePanel";
import InventoryDashboardPanel from "@/components/InventoryDashboardPanel";
import InventoryFuelConsumptionPanel from "@/components/InventoryFuelConsumptionPanel";
import InventoryMaintenancePanel from "@/components/InventoryMaintenancePanel";
import NetworkDirectoryPage from "@/pages/NetworkDirectoryPage";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { trpc } from "@/lib/trpc";
import { useBranchFilter } from "@/hooks/useBranchFilter";
import { useDeltaRevisionRefresh } from "@/hooks/useDeltaRevisionRefresh";
import { isExplicitAuthorizationDenial } from "@/lib/offline-query-errors";
import { clearOfflineSupplierFinancialQueryCacheForSite } from "@/lib/offline-query-cache";
import { Boxes, ClipboardList, Loader2, PackagePlus, Search, Store, Warehouse, ArrowLeftRight, FileSpreadsheet, CreditCard, ClipboardCheck, LayoutDashboard, Droplet, Wrench, Bolt } from "lucide-react";
import { toast } from "sonner";

const categoryLabels: Record<string, string> = {
  fuel: "وقود",
  oil: "زيوت",
  filter: "فلاتر",
  spare_part: "قطع غيار",
  maintenance_supply: "مستلزمات صيانة",
  other: "أخرى",
};
const warehouseTypeLabels: Record<string, string> = {
  central_warehouse: "المخزن المركزي",
  branch_warehouse: "مخزن فرع",
  fixed_fuel_tank: "خزان وقود ثابت",
  generator_fuel_tank: "خزان مرتبط بمولد",
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
  const { isAuthenticated, user } = useAuth();
  const sites = trpc.powerhub.sites.list.useQuery(undefined, { enabled: isAuthenticated });
  const { branchId: selectedSiteId } = useBranchFilter(sites.data);
  const siteId = selectedSiteId && sites.data?.some((site) => site.id === selectedSiteId)
    ? selectedSiteId
    : sites.data?.[0]?.id ?? 0;
  const siteName = sites.data?.find((site) => site.id === siteId)?.name ?? "الفرع المحدد";
  const supplierAccess = trpc.powerhub.staff.myAccess.useQuery({ siteId }, {
    enabled: Boolean(siteId && isAuthenticated),
    staleTime: 30_000,
  });
  const canViewGenerators = ["owner", "manager", "technician", "viewer"].includes(supplierAccess.data?.role ?? "") || (supplierAccess.data?.permissions.includes("manageGenerators") ?? false);
  const canViewSuppliers = supplierAccess.data?.permissions.includes("viewSuppliers") ?? false;
  const canViewSupplierLedger = supplierAccess.data?.permissions.includes("viewSupplierLedger") ?? false;
  const canViewInventory = supplierAccess.data?.permissions.includes("viewInventory") ?? false;
  const canCreateInventoryItems = supplierAccess.data?.permissions.includes("createInventoryItems") ?? false;
  const canEditInventoryItems = supplierAccess.data?.permissions.includes("editInventoryItems") ?? false;
  const canDeactivateInventoryItems = supplierAccess.data?.permissions.includes("deactivateInventoryItems") ?? false;
  const canCreateSuppliers = supplierAccess.data?.permissions.includes("createSuppliers") ?? false;
  const canEditSuppliers = supplierAccess.data?.permissions.includes("editSuppliers") ?? false;
  const canDeactivateSuppliers = supplierAccess.data?.permissions.includes("deactivateSuppliers") ?? false;
  const canCreateWarehouses = supplierAccess.data?.permissions.includes("createWarehouses") ?? false;
  const canEditWarehouses = supplierAccess.data?.permissions.includes("editWarehouses") ?? false;
  const canDeactivateWarehouses = supplierAccess.data?.permissions.includes("deactivateWarehouses") ?? false;
  const canViewInventoryReports = supplierAccess.data?.permissions.includes("viewInventoryReports") ?? false;
  const canIssueInventory = supplierAccess.data?.permissions.includes("issueInventory") ?? false;
  const canAdjustInventory = supplierAccess.data?.permissions.includes("adjustInventory") ?? false;
  const canManageFuelAndConsumption = supplierAccess.data?.permissions.includes("manageFuelAndConsumption") ?? false;
  const canManageMaintenance = supplierAccess.data?.permissions.includes("manageMaintenance") ?? false;
  const canViewMaintenance = canViewInventory || canManageMaintenance;
  const canViewMaintenanceReport = canViewInventoryReports;
  const canViewStocktakes = supplierAccess.data?.permissions.includes("viewStocktakes") ?? false;
  const canManageStocktakes = supplierAccess.data?.permissions.includes("manageStocktakes") ?? false;
  const canApproveStocktakes = supplierAccess.data?.permissions.includes("approveStocktakes") ?? false;
  const canAccessStocktakes = canViewStocktakes || canManageStocktakes || canApproveStocktakes;
  const canViewPurchases = supplierAccess.data?.permissions.includes("viewPurchases") ?? false;
  const canCreatePurchases = supplierAccess.data?.permissions.includes("createPurchases") ?? false;
  const canApprovePurchases = supplierAccess.data?.permissions.includes("approvePurchases") ?? false;
  const canReceiveInventory = supplierAccess.data?.permissions.includes("receiveInventory") ?? false;
  const canManageSupplierPayments = supplierAccess.data?.permissions.includes("manageSupplierPayments") ?? false;
  const canReverseSupplierPayments = supplierAccess.data?.permissions.includes("reverseSupplierPayments") ?? false;
  const canReadPurchases = canViewPurchases || canReceiveInventory || canManageSupplierPayments || canAdjustInventory;
  const canViewPurchaseFinancials = canViewPurchases || canManageSupplierPayments;
  const utils = trpc.useUtils();
  const [tab, setTab] = useState("dashboard");
  const [itemSearch, setItemSearch] = useState("");
  const [supplierSearch, setSupplierSearch] = useState("");
  const [selectedSupplierLedgerId, setSelectedSupplierLedgerId] = useState<number | null>(null);
  const [showInactiveItems, setShowInactiveItems] = useState(false);
  const [showInactiveSuppliers, setShowInactiveSuppliers] = useState(false);
  const [showInactiveWarehouses, setShowInactiveWarehouses] = useState(false);
  const [editingItemId, setEditingItemId] = useState<number | null>(null);
  const [selectedItemUnitsId, setSelectedItemUnitsId] = useState<number | null>(null);
  const [purchaseUnitLabel, setPurchaseUnitLabel] = useState("");
  const [purchaseUnitFactor, setPurchaseUnitFactor] = useState("1");
  const [editingSupplierId, setEditingSupplierId] = useState<number | null>(null);
  const [editingWarehouseId, setEditingWarehouseId] = useState<number | null>(null);
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
  const [supplierAddress, setSupplierAddress] = useState("");
  const [supplierTaxNumber, setSupplierTaxNumber] = useState("");
  const [paymentTerms, setPaymentTerms] = useState("0");
  const [supplierType, setSupplierType] = useState<"permanent" | "one_time">("permanent");
  const [supplierNotes, setSupplierNotes] = useState("");

  const [warehouseCode, setWarehouseCode] = useState("");
  const [warehouseName, setWarehouseName] = useState("");
  const [warehouseNotes, setWarehouseNotes] = useState("");
  const [warehouseLocationType, setWarehouseLocationType] = useState("branch_warehouse");
  const [warehouseGeneratorId, setWarehouseGeneratorId] = useState("");

  const items = trpc.powerhub.inventory.listItems.useQuery(
    { siteId, search: itemSearch || undefined, includeInactive: showInactiveItems },
    { enabled: Boolean(siteId && isAuthenticated && canViewInventory), staleTime: 30_000 },
  );
  const itemUnits = trpc.powerhub.inventory.listItemUnits.useQuery(
    { siteId, itemId: selectedItemUnitsId ?? 0, includeInactive: true },
    { enabled: Boolean(siteId && isAuthenticated && canViewInventory && selectedItemUnitsId), staleTime: 15_000 },
  );
  const suppliers = trpc.powerhub.inventory.listSuppliers.useQuery(
    { siteId, search: supplierSearch || undefined, includeInactive: showInactiveSuppliers },
    { enabled: Boolean(siteId && isAuthenticated && canViewSuppliers), staleTime: 30_000 },
  );
  const supplierLedger = trpc.powerhub.inventory.supplierLedgerStatement.useQuery(
    { siteId, supplierId: selectedSupplierLedgerId ?? 0, limit: 200 },
    { enabled: Boolean(siteId && isAuthenticated && canViewSupplierLedger && selectedSupplierLedgerId), staleTime: 15_000 },
  );
  const supplierLedgerAuthorizationDenied = isExplicitAuthorizationDenial(supplierLedger.error);
  const supplierLedgerIsOfflineSnapshot = Boolean(
    (supplierLedger.data as (typeof supplierLedger.data & { offlineSnapshot?: boolean }) | undefined)?.offlineSnapshot,
  );
  useDeltaRevisionRefresh({
    siteId, userId: user?.id, entityTypes: ["supplier_ledger"],
    enabled: Boolean(siteId && isAuthenticated && canViewSupplierLedger),
    onChange: (changed) => {
      if (changed.includes("supplier_ledger") && selectedSupplierLedgerId) void supplierLedger.refetch();
    },
  });
  useEffect(() => {
    if (supplierLedgerAuthorizationDenied && user?.id) {
      void clearOfflineSupplierFinancialQueryCacheForSite(String(user.id), siteId);
    }
  }, [supplierLedgerAuthorizationDenied, user?.id, siteId]);
  const warehouses = trpc.powerhub.inventory.listWarehouses.useQuery(
    { siteId, includeInactive: showInactiveWarehouses },
    { enabled: Boolean(siteId && isAuthenticated && canViewInventory), staleTime: 30_000 },
  );
  const warehouseGenerators = trpc.powerhub.generators.list.useQuery(
    { siteId },
    { enabled: Boolean(siteId && isAuthenticated && (canCreateWarehouses || canEditWarehouses)), staleTime: 30_000 },
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
  const updateItem = trpc.powerhub.inventory.updateItem.useMutation({
    onSuccess: async () => {
      toast.success("تم تحديث بيانات الصنف.");
      setEditingItemId(null); setShowItemForm(false);
      setSku(""); setItemName(""); setCategory("other"); setBaseUnit("piece");
      setReorderPoint("0"); setSpecification(""); setItemNotes("");
      await Promise.all([utils.powerhub.inventory.listItems.invalidate(), utils.powerhub.inventory.stockOverview.invalidate()]);
    },
    onError: (error) => toast.error(error.message || "تعذر تعديل بيانات الصنف."),
  });
  const setItemActive = trpc.powerhub.inventory.setItemActive.useMutation({
    onSuccess: async (result) => {
      toast.success(result.is_active ? "تمت إعادة تفعيل الصنف." : "تم إيقاف الصنف مع الحفاظ على تاريخه.");
      await Promise.all([utils.powerhub.inventory.listItems.invalidate(), utils.powerhub.inventory.stockOverview.invalidate()]);
    },
    onError: (error) => toast.error(error.message || "تعذر تغيير حالة الصنف."),
  });

  const createItemUnit = trpc.powerhub.inventory.createItemUnit.useMutation({
    onSuccess: async () => {
      toast.success("تمت إضافة وحدة الشراء ومعامل تحويلها.");
      setPurchaseUnitLabel(""); setPurchaseUnitFactor("1");
      await Promise.all([
        utils.powerhub.inventory.listItemUnits.invalidate(),
        utils.powerhub.inventory.listPurchaseOptions.invalidate({ siteId }),
      ]);
    },
    onError: (error) => toast.error(error.message || "تعذرت إضافة وحدة الشراء."),
  });
  const setItemUnitActive = trpc.powerhub.inventory.setItemUnitActive.useMutation({
    onSuccess: async (result) => {
      toast.success(result.is_active ? "تمت إعادة تفعيل وحدة الشراء." : "تم إيقاف وحدة الشراء مع الحفاظ على سجلها.");
      await Promise.all([
        utils.powerhub.inventory.listItemUnits.invalidate(),
        utils.powerhub.inventory.listPurchaseOptions.invalidate({ siteId }),
      ]);
    },
    onError: (error) => toast.error(error.message || "تعذر تغيير حالة وحدة الشراء."),
  });

  const createSupplier = trpc.powerhub.inventory.createSupplier.useMutation({
    onSuccess: async () => {
      toast.success("تمت إضافة المورد.");
      setSupplierCode(""); setSupplierName(""); setContactName(""); setPhone("");
      setEmail(""); setSupplierAddress(""); setSupplierTaxNumber(""); setPaymentTerms("0"); setSupplierType("permanent"); setSupplierNotes(""); setShowSupplierForm(false);
      setEditingSupplierId(null);
      await utils.powerhub.inventory.listSuppliers.invalidate();
    },
    onError: (error) => toast.error(error.message || "تعذرت إضافة المورد."),
  });
  const updateSupplier = trpc.powerhub.inventory.updateSupplier.useMutation({
    onSuccess: async () => {
      toast.success("تم تحديث بيانات المورد.");
      setEditingSupplierId(null); setShowSupplierForm(false);
      setSupplierCode(""); setSupplierName(""); setContactName(""); setPhone("");
      setEmail(""); setSupplierAddress(""); setSupplierTaxNumber(""); setPaymentTerms("0"); setSupplierType("permanent"); setSupplierNotes("");
      await utils.powerhub.inventory.listSuppliers.invalidate();
    },
    onError: (error) => toast.error(error.message || "تعذر تعديل بيانات المورد."),
  });
  const setSupplierActive = trpc.powerhub.inventory.setSupplierActive.useMutation({
    onSuccess: async (result) => {
      toast.success(result.is_active ? "تمت إعادة تفعيل المورد." : "تم إيقاف المورد مع الحفاظ على سجله المالي.");
      await utils.powerhub.inventory.listSuppliers.invalidate();
    },
    onError: (error) => toast.error(error.message || "تعذر تغيير حالة المورد."),
  });

  const createWarehouse = trpc.powerhub.inventory.createWarehouse.useMutation({
    onSuccess: async () => {
      toast.success("تم إنشاء المخزن.");
      setWarehouseCode(""); setWarehouseName(""); setWarehouseNotes("");
      setWarehouseLocationType("branch_warehouse"); setWarehouseGeneratorId("");
      setEditingWarehouseId(null); setShowWarehouseForm(false);
      await utils.powerhub.inventory.listWarehouses.invalidate();
    },
    onError: (error) => toast.error(error.message || "تعذر إنشاء المخزن."),
  });

  const updateWarehouse = trpc.powerhub.inventory.updateWarehouse.useMutation({
    onSuccess: async () => {
      toast.success("تم تحديث بيانات المخزن.");
      setEditingWarehouseId(null); setShowWarehouseForm(false);
      setWarehouseCode(""); setWarehouseName(""); setWarehouseNotes("");
      setWarehouseLocationType("branch_warehouse"); setWarehouseGeneratorId("");
      await utils.powerhub.inventory.listWarehouses.invalidate();
    },
    onError: (error) => toast.error(error.message || "تعذر تعديل بيانات المخزن."),
  });
  const setWarehouseActive = trpc.powerhub.inventory.setWarehouseActive.useMutation({
    onSuccess: async (result) => {
      toast.success(result.is_active ? "تمت إعادة تفعيل المخزن." : "تم إيقاف المخزن مع الحفاظ على حركاته التاريخية.");
      await Promise.all([utils.powerhub.inventory.listWarehouses.invalidate(), utils.powerhub.inventory.stockOverview.invalidate()]);
    },
    onError: (error) => toast.error(error.message || "تعذر تغيير حالة المخزن."),
  });

  useEffect(() => {
    if ((!canViewSuppliers && tab === "suppliers") || (!canManageSupplierPayments && tab === "supplierPayments") || (!canReadPurchases && tab === "purchases") || ((!canViewInventory && !canAccessStocktakes) && tab === "stock") || (!canViewInventoryReports && tab === "reports") || (!(canManageFuelAndConsumption || canViewInventoryReports) && tab === "fuel") || (!canViewInventory && tab === "catalog") || (!canViewInventory && tab === "warehouses")) {
      setTab(
        canViewInventory ? "catalog"
          : canViewSuppliers ? "suppliers"
          : canManageSupplierPayments ? "supplierPayments"
          : canAccessStocktakes ? "stock"
          : canReadPurchases ? "purchases"
          : canManageFuelAndConsumption || canViewInventoryReports ? "fuel"
          : canViewInventoryReports ? "reports"
          : "catalog",
      );
    }
  }, [canViewSuppliers, canManageSupplierPayments, canReadPurchases, canViewInventory, canViewInventoryReports, canManageFuelAndConsumption, canAccessStocktakes, tab]);

  const selectedSiteName = useMemo(() => sites.data?.find((site) => site.id === siteId)?.name ?? "", [sites.data, siteId]);

  if (sites.isLoading) {
    return <DashboardLayout><div className="flex min-h-[40vh] items-center justify-center gap-2 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /> جارٍ تحميل بيانات الفروع…</div></DashboardLayout>;
  }

  return (
    <DashboardLayout>
      <div dir="rtl" className="mx-auto w-full max-w-7xl space-y-5 p-3 md:p-6">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex items-center gap-2"><Boxes className="h-6 w-6 text-primary" /><h1 className="text-2xl font-bold">التشغيل والمشتريات</h1></div>
            <p className="mt-1 text-sm text-muted-foreground">إدارة المولدات والوقود والصيانة والمخزون والموردين والمشتريات من مساحة تشغيل موحدة.</p>
            {selectedSiteName ? <p className="mt-1 text-xs text-muted-foreground">الفرع: {selectedSiteName}</p> : null}
          </div>
        </header>

        {!siteId ? (
          <Card><CardContent className="p-6 text-center text-muted-foreground">لا يوجد فرع متاح لهذا الحساب. أنشئ فرعًا أولًا أو تواصل مع مدير المنصة.</CardContent></Card>
        ) : (
          <Tabs value={tab} onValueChange={setTab} dir="rtl" className="space-y-4">
            <div className="overflow-x-auto pb-1">
              <TabsList className="inline-flex min-w-max gap-1">
                {canViewGenerators ? <TabsTrigger value="generators" className="gap-2"><Bolt className="h-4 w-4" /> المولدات</TabsTrigger> : null}
                <TabsTrigger value="dashboard" className="gap-2"><LayoutDashboard className="h-4 w-4" /> لوحة التحكم</TabsTrigger>
                {canViewInventory ? <TabsTrigger value="catalog" className="gap-2"><Boxes className="h-4 w-4" /> دليل الأصناف</TabsTrigger> : null}
                {canViewSuppliers ? <TabsTrigger value="suppliers" className="gap-2"><Store className="h-4 w-4" /> الموردون والذمم</TabsTrigger> : null}
                {canManageSupplierPayments ? <TabsTrigger value="supplierPayments" className="gap-2"><CreditCard className="h-4 w-4" /> دفعات الموردين</TabsTrigger> : null}
                {canViewInventory ? <TabsTrigger value="warehouses" className="gap-2"><Warehouse className="h-4 w-4" /> المخازن</TabsTrigger> : null}
                {canViewInventory || canAccessStocktakes ? <TabsTrigger value="stock" className="gap-2">{canAccessStocktakes && !canViewInventory ? <ClipboardCheck className="h-4 w-4" /> : <ArrowLeftRight className="h-4 w-4" />} {canAccessStocktakes && !canViewInventory ? "الجرد الفعلي" : "الأرصدة والحركات"}</TabsTrigger> : null}
                {canReadPurchases ? <TabsTrigger value="purchases" className="gap-2"><ClipboardList className="h-4 w-4" /> المشتريات</TabsTrigger> : null}
                {canManageFuelAndConsumption || canViewInventoryReports ? <TabsTrigger value="fuel" className="gap-2"><Droplet className="h-4 w-4" /> الوقود والاستهلاك</TabsTrigger> : null}
                {canViewMaintenance ? <TabsTrigger value="maintenance" className="gap-2"><Wrench className="h-4 w-4" /> الصيانة والأعطال</TabsTrigger> : null}
                {canViewInventoryReports ? <TabsTrigger value="reports" className="gap-2"><FileSpreadsheet className="h-4 w-4" /> التقارير والتصدير</TabsTrigger> : null}
              </TabsList>
            </div>

            {canViewGenerators ? <TabsContent value="generators" className="space-y-4"><NetworkDirectoryPage kind="generators" embedded /></TabsContent> : null}

            <TabsContent value="dashboard" className="space-y-4">
              <InventoryDashboardPanel
                siteId={siteId}
                siteName={siteName}
                isAuthenticated={isAuthenticated}
                canViewInventory={canViewInventory}
                canViewInventoryReports={canViewInventoryReports}
                canViewSupplierLedger={canViewSupplierLedger}
                canReadPurchases={canReadPurchases}
                canAccessStocktakes={canAccessStocktakes}
                canManageFuelAndConsumption={canManageFuelAndConsumption}
                onNavigate={(nextTab) => setTab(nextTab)}
              />
            </TabsContent>

            {canViewInventory ? <TabsContent value="catalog" className="space-y-4">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
                  <div><CardTitle>دليل الأصناف الموحد</CardTitle><p className="mt-1 text-sm text-muted-foreground">تعريف الصنف لا يضيف كمية إلى المخزون؛ الكميات تُضاف لاحقًا من استلام المشتريات.</p></div>
                  {canCreateInventoryItems ? <Button onClick={() => { setEditingItemId(null); setShowItemForm((value) => !value); }}><PackagePlus className="ml-2 h-4 w-4" /> {showItemForm && editingItemId === null ? "إلغاء" : "إضافة صنف"}</Button> : null}
                </CardHeader>
                {showItemForm ? <CardContent className="border-t pt-4">
                  <form className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3" onSubmit={(event) => {
                    event.preventDefault();
                    const point = Number(reorderPoint);
                    if (!Number.isFinite(point) || point < 0) { toast.error("أدخل حد إعادة طلب صحيحًا."); return; }
                    const payload = { siteId, sku: sku.trim() || undefined, name: itemName.trim(), category: category as "fuel" | "oil" | "filter" | "spare_part" | "maintenance_supply" | "other", baseUnit: baseUnit as "liter" | "milliliter" | "piece" | "container" | "kg" | "gram" | "meter" | "set" | "gallon" | "other", reorderPoint: point, specification: specification.trim() || undefined, notes: itemNotes.trim() || undefined };
                    if (editingItemId) updateItem.mutate({ ...payload, itemId: editingItemId });
                    else createItem.mutate(payload);
                  }}>
                    <label className="space-y-1 text-sm">اسم الصنف *<Input required maxLength={180} value={itemName} onChange={(e) => setItemName(e.target.value)} placeholder="مثال: سولار" /></label>
                    <label className="space-y-1 text-sm">رمز الصنف (اختياري)<Input maxLength={80} value={sku} onChange={(e) => setSku(e.target.value)} placeholder="FUEL-001" /></label>
                    <label className="space-y-1 text-sm">التصنيف<select className="h-10 w-full rounded-md border bg-background px-3" value={category} onChange={(e) => setCategory(e.target.value)}>{Object.entries(categoryLabels).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                    <label className="space-y-1 text-sm">وحدة القياس الأساسية<select className="h-10 w-full rounded-md border bg-background px-3" value={baseUnit} onChange={(e) => setBaseUnit(e.target.value)}>{Object.entries(unitLabels).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                    <label className="space-y-1 text-sm">حد إعادة الطلب<Input type="number" min="0" step="0.001" value={reorderPoint} onChange={(e) => setReorderPoint(e.target.value)} /></label>
                    <label className="space-y-1 text-sm">المواصفات<Input maxLength={500} value={specification} onChange={(e) => setSpecification(e.target.value)} /></label>
                    <label className="space-y-1 text-sm md:col-span-2">ملاحظات<Input maxLength={2000} value={itemNotes} onChange={(e) => setItemNotes(e.target.value)} /></label>
                    <div className="flex items-end"><Button type="submit" disabled={createItem.isPending || updateItem.isPending || !itemName.trim()}>{createItem.isPending ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : null} {editingItemId ? "حفظ التعديلات" : "حفظ الصنف"}</Button>{editingItemId ? <Button type="button" variant="outline" onClick={() => { setEditingItemId(null); setShowItemForm(false); setSku(""); setItemName(""); setCategory("other"); setBaseUnit("piece"); setReorderPoint("0"); setSpecification(""); setItemNotes(""); }}>إلغاء التعديل</Button> : null}</div>
                  </form>
                </CardContent> : null}
                <CardContent className="space-y-3">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center"><div className="relative max-w-md flex-1"><Search className="absolute right-3 top-3 h-4 w-4 text-muted-foreground" /><Input className="pr-9" value={itemSearch} onChange={(e) => setItemSearch(e.target.value)} placeholder="ابحث باسم الصنف أو رمزه…" /></div><label className="flex items-center gap-2 text-sm text-muted-foreground"><input type="checkbox" checked={showInactiveItems} onChange={(e) => setShowInactiveItems(e.target.checked)} /> إظهار الأصناف الموقوفة</label></div>
                  {items.isLoading ? <p className="py-8 text-center text-muted-foreground">جارٍ تحميل الأصناف…</p> : items.error ? <p className="py-8 text-center text-destructive">تعذر تحميل دليل الأصناف. حدّث الصفحة أو تحقق من صلاحياتك.</p> : !items.data?.length ? <p className="py-8 text-center text-muted-foreground">لا توجد أصناف بعد. استخدم «إضافة صنف» لبدء الدليل.</p> : <div className="overflow-x-auto rounded-md border"><table className="w-full min-w-[720px] text-right text-sm"><thead className="bg-muted/60"><tr>{["الصنف","الرمز","التصنيف","الوحدة","حد إعادة الطلب","الحالة","إجراءات"].map((x) => <th key={x} className="p-3 font-semibold">{x}</th>)}</tr></thead><tbody>{items.data.map((item) => <tr key={item.id} className="border-t"><td className="p-3 font-medium">{item.name}<div className="text-xs text-muted-foreground">{item.specification || ""}</div></td><td className="p-3">{item.sku || "—"}</td><td className="p-3">{categoryLabels[item.category] || item.category}</td><td className="p-3">{unitLabels[item.base_unit] || item.base_unit}</td><td className="p-3 tabular-nums">{Number(item.reorder_point).toLocaleString("ar", { maximumFractionDigits: 3 })}</td><td className="p-3">{item.is_active ? "نشط" : "موقوف"}</td><td className="p-3"><div className="flex flex-wrap gap-1">{(canEditInventoryItems || canDeactivateInventoryItems || canCreateInventoryItems) ? <><>{canEditInventoryItems ? <Button type="button" size="sm" variant="outline" onClick={() => { setEditingItemId(Number(item.id)); setSku(item.sku ?? ""); setItemName(item.name); setCategory(item.category); setBaseUnit(item.base_unit); setReorderPoint(String(item.reorder_point)); setSpecification(item.specification ?? ""); setItemNotes(item.notes ?? ""); setShowItemForm(true); }}>تعديل</Button> : null}</><>{canCreateInventoryItems || canDeactivateInventoryItems ? <Button type="button" size="sm" variant="outline" onClick={() => { setSelectedItemUnitsId(Number(item.id)); setPurchaseUnitLabel(""); setPurchaseUnitFactor("1"); }}>وحدات الشراء</Button> : null}</><>{canDeactivateInventoryItems ? <Button type="button" size="sm" variant="outline" disabled={setItemActive.isPending} onClick={() => { const reason = item.is_active ? window.prompt("أدخل سبب إيقاف الصنف (مطلوب):")?.trim() : undefined; if (item.is_active && (!reason || reason.length < 3)) { toast.error("أدخل سببًا واضحًا من 3 أحرف على الأقل."); return; } setItemActive.mutate({ siteId, itemId: Number(item.id), isActive: !item.is_active, ...(reason ? { reason } : {}) }); }}>{item.is_active ? "إيقاف" : "إعادة تفعيل"}</Button> : null}</> </> : "—"}</div></td></tr>)}</tbody></table></div>}
                </CardContent>
              </Card>
              {selectedItemUnitsId ? <Card>
                <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
                  <div>
                    <CardTitle>وحدات الشراء — {items.data?.find((item) => Number(item.id) === selectedItemUnitsId)?.name ?? "الصنف المحدد"}</CardTitle>
                    <p className="mt-1 text-sm text-muted-foreground">معامل التحويل يحدد عدد وحدات الصنف الأساسية داخل وحدة الشراء الواحدة. مثال: عبوة زيت 4 لترات = 4.</p>
                  </div>
                  <Button type="button" variant="outline" onClick={() => setSelectedItemUnitsId(null)}>إغلاق</Button>
                </CardHeader>
                <CardContent className="space-y-4">
                  {canCreateInventoryItems ? <form className="grid grid-cols-1 gap-3 sm:grid-cols-3" onSubmit={(event) => {
                    event.preventDefault();
                    const factor = Number(purchaseUnitFactor);
                    if (!purchaseUnitLabel.trim() || !Number.isFinite(factor) || factor <= 0 || Math.abs(factor * 1_000_000 - Math.round(factor * 1_000_000)) > 1e-5) {
                      toast.error("أدخل اسم وحدة ومعامل تحويل موجبًا حتى 6 منازل عشرية."); return;
                    }
                    createItemUnit.mutate({ siteId, itemId: selectedItemUnitsId, unitLabel: purchaseUnitLabel.trim(), factorToBase: factor });
                  }}>
                    <label className="space-y-1 text-sm">اسم وحدة الشراء *<Input required maxLength={40} value={purchaseUnitLabel} onChange={(event) => setPurchaseUnitLabel(event.target.value)} placeholder="عبوة، كرتونة، جالون…" /></label>
                    <label className="space-y-1 text-sm">عدد الوحدات الأساسية داخلها *<Input required type="number" min="0.000001" max="99999999.999999" step="0.000001" value={purchaseUnitFactor} onChange={(event) => setPurchaseUnitFactor(event.target.value)} /></label>
                    <div className="flex items-end"><Button type="submit" disabled={createItemUnit.isPending || !purchaseUnitLabel.trim()}>إضافة وحدة شراء</Button></div>
                  </form> : null}
                  {itemUnits.isLoading ? <p className="text-sm text-muted-foreground">جارٍ تحميل وحدات الشراء…</p> : itemUnits.error ? <p className="text-sm text-destructive">تعذر تحميل وحدات الشراء.</p> : !itemUnits.data?.length ? <p className="text-sm text-muted-foreground">لا توجد وحدات شراء إضافية. يمكن الشراء بالوحدة الأساسية مباشرة.</p> : <div className="overflow-x-auto rounded-md border"><table className="w-full min-w-[540px] text-right text-sm"><thead className="bg-muted/60"><tr>{["وحدة الشراء","معامل التحويل إلى الوحدة الأساسية","الحالة",...(canDeactivateInventoryItems ? ["إجراءات"] : [])].map((heading) => <th key={heading} className="p-3">{heading}</th>)}</tr></thead><tbody>{itemUnits.data.map((unit) => <tr key={unit.id} className="border-t"><td className="p-3">{unit.unit_label}</td><td className="p-3 tabular-nums">{Number(unit.factor_to_base).toLocaleString("ar-PS", { maximumFractionDigits: 6 })}</td><td className="p-3">{unit.is_active ? "نشطة" : "موقوفة"}</td>{canDeactivateInventoryItems ? <td className="p-3"><Button type="button" size="sm" variant="outline" disabled={setItemUnitActive.isPending} onClick={() => { const reason = unit.is_active ? window.prompt("أدخل سبب إيقاف وحدة الشراء (مطلوب):")?.trim() : undefined; if (unit.is_active && (!reason || reason.length < 3)) { toast.error("أدخل سببًا واضحًا من 3 أحرف على الأقل."); return; } setItemUnitActive.mutate({ siteId, itemId: selectedItemUnitsId, unitId: Number(unit.id), isActive: !unit.is_active, ...(reason ? { reason } : {}) }); }}>{unit.is_active ? "إيقاف" : "إعادة تفعيل"}</Button></td> : null}</tr>)}</tbody></table></div>}
                </CardContent>
              </Card> : null}
            </TabsContent> : null}

            <TabsContent value="suppliers" className="space-y-4">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0"><div><CardTitle>دليل الموردين</CardTitle><p className="mt-1 text-sm text-muted-foreground">تُستخدم بيانات المورد عند تسجيل المشتريات والذمم.</p></div>{canCreateSuppliers ? <Button onClick={() => { setEditingSupplierId(null); setShowSupplierForm((value) => !value); }}><PackagePlus className="ml-2 h-4 w-4" /> {showSupplierForm && editingSupplierId === null ? "إلغاء" : "إضافة مورد"}</Button> : null}</CardHeader>
                {showSupplierForm ? <CardContent className="border-t pt-4"><form className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3" onSubmit={(event) => {event.preventDefault(); const days = Number(paymentTerms); if (!Number.isInteger(days) || days < 0 || days > 3650) {toast.error("مدة السداد يجب أن تكون عدد أيام صحيحًا."); return;} const payload = {siteId,supplierCode:supplierCode.trim() || undefined,name:supplierName.trim(),contactName:contactName.trim() || undefined,phone:phone.trim() || undefined,email:email.trim(),address:supplierAddress.trim() || undefined,taxNumber:supplierTaxNumber.trim() || undefined,defaultPaymentTermsDays: supplierType === "one_time" ? 0 : days,supplierType,notes:supplierNotes.trim() || undefined}; if (editingSupplierId) updateSupplier.mutate({...payload,supplierId:editingSupplierId}); else createSupplier.mutate(payload);}}>
                  <label className="space-y-1 text-sm">اسم المورد *<Input required maxLength={180} value={supplierName} onChange={(e) => setSupplierName(e.target.value)} /></label>
                  <label className="space-y-1 text-sm">رمز المورد<Input maxLength={80} value={supplierCode} onChange={(e) => setSupplierCode(e.target.value)} /></label>
                  <label className="space-y-1 text-sm">مسؤول التواصل<Input maxLength={180} value={contactName} onChange={(e) => setContactName(e.target.value)} /></label>
                  <label className="space-y-1 text-sm">الهاتف<Input maxLength={40} value={phone} onChange={(e) => setPhone(e.target.value)} /></label>
                  <label className="space-y-1 text-sm">البريد الإلكتروني<Input type="email" maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} /></label>
                  <label className="space-y-1 text-sm">العنوان<Input maxLength={500} value={supplierAddress} onChange={(e) => setSupplierAddress(e.target.value)} /></label>
                  <label className="space-y-1 text-sm">الرقم الضريبي<Input maxLength={100} value={supplierTaxNumber} onChange={(e) => setSupplierTaxNumber(e.target.value)} /></label>
                  <label className="space-y-1 text-sm">نوع المورد<select className="h-10 w-full rounded-md border bg-background px-3" value={supplierType} onChange={(e) => { const next=e.target.value as "permanent" | "one_time"; setSupplierType(next); if(next==="one_time") setPaymentTerms("0"); }}><option value="permanent">مورد دائم</option><option value="one_time">مورد لمرة واحدة</option></select>{supplierType==="one_time" ? <span className="block text-xs text-muted-foreground">يظل سجل المورد محفوظًا للفواتير والتدقيق، ويكون أجل السداد الافتراضي صفرًا.</span> : null}</label>
                  <label className="space-y-1 text-sm">أجل السداد الافتراضي (أيام)<Input type="number" min="0" max="3650" step="1" value={supplierType==="one_time" ? "0" : paymentTerms} disabled={supplierType==="one_time"} onChange={(e) => setPaymentTerms(e.target.value)} /></label>
                  <label className="space-y-1 text-sm md:col-span-2">ملاحظات<Input maxLength={2000} value={supplierNotes} onChange={(e) => setSupplierNotes(e.target.value)} /></label>
                  <div className="flex items-end"><Button type="submit" disabled={createSupplier.isPending || updateSupplier.isPending || !supplierName.trim()}>{createSupplier.isPending || updateSupplier.isPending ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : null} {editingSupplierId ? "حفظ التعديلات" : "حفظ المورد"}</Button>{editingSupplierId ? <Button type="button" variant="outline" onClick={() => { setEditingSupplierId(null); setShowSupplierForm(false); setSupplierCode(""); setSupplierName(""); setContactName(""); setPhone(""); setEmail(""); setSupplierAddress(""); setSupplierTaxNumber(""); setPaymentTerms("0"); setSupplierType("permanent"); setSupplierNotes(""); }}>إلغاء التعديل</Button> : null}</div>
                </form></CardContent> : null}
                <CardContent className="space-y-3"><div className="flex flex-col gap-3 sm:flex-row sm:items-center"><div className="relative max-w-md flex-1"><Search className="absolute right-3 top-3 h-4 w-4 text-muted-foreground" /><Input className="pr-9" value={supplierSearch} onChange={(e) => setSupplierSearch(e.target.value)} placeholder="ابحث باسم المورد أو الرمز أو الهاتف…" /></div><label className="flex items-center gap-2 text-sm text-muted-foreground"><input type="checkbox" checked={showInactiveSuppliers} onChange={(e) => setShowInactiveSuppliers(e.target.checked)} /> إظهار الموردين الموقوفين</label></div>
                  {suppliers.isLoading ? <p className="py-8 text-center text-muted-foreground">جارٍ تحميل الموردين…</p> : suppliers.error ? <p className="py-8 text-center text-destructive">تعذر تحميل الموردين. تحقق من صلاحياتك.</p> : !suppliers.data?.length ? <p className="py-8 text-center text-muted-foreground">لا يوجد موردون مسجلون بعد.</p> : <div className="overflow-x-auto rounded-md border"><table className="w-full min-w-[650px] text-right text-sm"><thead className="bg-muted/60"><tr>{["المورد","الرمز","نوع المورد","مسؤول التواصل","الهاتف","أجل السداد","الحالة",...(canViewSupplierLedger ? ["كشف الحساب"] : []),...(canEditSuppliers || canDeactivateSuppliers ? ["إجراءات"] : [])].map((x) => <th key={x} className="p-3 font-semibold">{x}</th>)}</tr></thead><tbody>{suppliers.data.map((supplier) => <tr key={supplier.id} className="border-t"><td className="p-3 font-medium">{supplier.name}<div className="text-xs text-muted-foreground">{supplier.email || ""}</div></td><td className="p-3">{supplier.supplier_code || "—"}</td><td className="p-3">{supplier.supplier_type === "one_time" ? "لمرة واحدة" : "دائم"}</td><td className="p-3">{supplier.contact_name || "—"}</td><td className="p-3">{supplier.phone || "—"}</td><td className="p-3">{supplier.default_payment_terms_days} يوم</td><td className="p-3">{supplier.is_active ? "نشط" : "موقوف"}</td>{canViewSupplierLedger ? <td className="p-3"><Button type="button" variant="outline" size="sm" onClick={() => setSelectedSupplierLedgerId(Number(supplier.id))}>كشف الحساب</Button></td> : null}{canEditSuppliers || canDeactivateSuppliers ? <td className="p-3"><div className="flex flex-wrap gap-1">{canEditSuppliers ? <Button type="button" size="sm" variant="outline" onClick={() => { setEditingSupplierId(Number(supplier.id)); setSupplierCode(supplier.supplier_code ?? ""); setSupplierName(supplier.name); setContactName(supplier.contact_name ?? ""); setPhone(supplier.phone ?? ""); setEmail(supplier.email ?? ""); setSupplierAddress(supplier.address ?? ""); setSupplierTaxNumber(supplier.tax_number ?? ""); setPaymentTerms(String(supplier.default_payment_terms_days)); setSupplierType((supplier.supplier_type ?? "permanent") as "permanent" | "one_time"); setSupplierNotes(supplier.notes ?? ""); setShowSupplierForm(true); }}>تعديل</Button> : null}{canDeactivateSuppliers ? <Button type="button" size="sm" variant="outline" disabled={setSupplierActive.isPending} onClick={() => { const reason = supplier.is_active ? window.prompt("أدخل سبب إيقاف المورد (مطلوب):")?.trim() : undefined; if (supplier.is_active && (!reason || reason.length < 3)) { toast.error("أدخل سببًا واضحًا من 3 أحرف على الأقل."); return; } setSupplierActive.mutate({ siteId, supplierId: Number(supplier.id), isActive: !supplier.is_active, ...(reason ? { reason } : {}) }); }}>{supplier.is_active ? "إيقاف" : "إعادة تفعيل"}</Button> : null}</div></td> : null}</tr>)}</tbody></table></div>}
                </CardContent>
              </Card>
              <InventorySupplierPayablesAgingPanel siteId={siteId} isAuthenticated={isAuthenticated} canViewSupplierLedger={canViewSupplierLedger} />
                {canViewSupplierLedger && selectedSupplierLedgerId ? <Card>
                  <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
                    <div><CardTitle>كشف حساب المورد — {supplierLedgerAuthorizationDenied ? "غير متاح" : supplierLedger.data?.supplier?.name ?? "جارٍ التحميل…"}</CardTitle><p className="mt-1 text-sm text-muted-foreground">كشف الفرع الحالي؛ الرصيد الموجب يمثل مبلغًا مستحقًا للمورد.</p></div>
                    <div className="flex items-center gap-3"><div><p className="text-xs text-muted-foreground">الرصيد المستحق</p><p className="font-bold tabular-nums">{supplierLedger.data && !supplierLedgerAuthorizationDenied ? formatSupplierLedgerAmount(supplierLedger.data.balance) : "—"}</p></div><Button type="button" variant="outline" onClick={() => setSelectedSupplierLedgerId(null)}>إغلاق</Button></div>
                  </CardHeader>
                  <CardContent>
                    {supplierLedgerAuthorizationDenied ? <p role="alert" className="py-6 text-center text-destructive">رفض الخادم صلاحية كشف المورد؛ تم إخفاء اللقطة المحلية وحذفها من كاش هذا الفرع.</p> : null}
                    {!supplierLedgerAuthorizationDenied && supplierLedgerIsOfflineSnapshot ? <p role="status" className="mb-3 rounded-md border border-dashed p-3 text-sm text-muted-foreground">تعرض هذه البطاقة آخر كشف محفوظ لهذا الفرع والمورد. البيانات للقراءة فقط وقد تكون أقدم من الخادم؛ يلزم الاتصال لتأكيد الرصيد قبل أي دفع.</p> : null}
                    {!supplierLedgerAuthorizationDenied && supplierLedger.isLoading && !supplierLedger.data ? <p className="py-6 text-center text-muted-foreground">جارٍ تحميل كشف الحساب…</p> : !supplierLedgerAuthorizationDenied && supplierLedger.error && !supplierLedger.data ? <p className="py-6 text-center text-destructive">تعذر تحميل كشف حساب المورد. تحقق من الصلاحيات.</p> : supplierLedgerAuthorizationDenied ? null : !supplierLedger.data?.entries?.length ? <p className="py-6 text-center text-muted-foreground">لا توجد حركات مالية لهذا المورد في الفرع الحالي.</p> : <div className="overflow-x-auto rounded-md border"><table className="w-full min-w-[760px] text-right text-sm"><thead className="bg-muted/60"><tr>{["التاريخ","نوع الحركة","البيان","المرجع","مدين","دائن"].map((label) => <th key={label} className="p-3 font-semibold">{label}</th>)}</tr></thead><tbody>{supplierLedger.data.entries.map((entry: any) => <tr key={entry.id} className="border-t"><td className="p-3 whitespace-nowrap">{new Date(entry.occurred_at).toLocaleDateString("ar-PS")}</td><td className="p-3">{({purchase:"فاتورة مشتريات",payment:"دفعة مورد",opening_balance:"رصيد افتتاحي",supplier_return:"مرتجع مورد",debit_note:"إشعار مدين",credit_note:"إشعار دائن",adjustment:"تسوية",reversal:"قيد عكسي"} as Record<string,string>)[entry.entry_type] ?? entry.entry_type}</td><td className="p-3">{entry.description}</td><td className="p-3">{entry.reference_no || "—"}</td><td className="p-3 tabular-nums">{formatSupplierLedgerAmount(entry.debit_amount)}</td><td className="p-3 tabular-nums">{formatSupplierLedgerAmount(entry.credit_amount)}</td></tr>)}</tbody></table></div>}
                    {supplierLedger.data && supplierLedger.data.entry_count > supplierLedger.data.entries.length ? <p className="mt-2 text-xs text-muted-foreground">يعرض أحدث {supplierLedger.data.entries.length} حركة من أصل {supplierLedger.data.entry_count}؛ الرصيد محسوب من كامل السجل.</p> : null}
                  </CardContent>
                </Card> : null}
            </TabsContent>

            {canManageSupplierPayments ? <TabsContent value="supplierPayments" className="space-y-4">
              <InventorySupplierPaymentsPanel siteId={siteId} isAuthenticated={isAuthenticated} canManageSupplierPayments={canManageSupplierPayments} canReverseSupplierPayments={canReverseSupplierPayments} />
            </TabsContent> : null}

            {canViewInventory ? <TabsContent value="warehouses" className="space-y-4">
              <Card><CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0"><div><CardTitle>المخازن</CardTitle><p className="mt-1 text-sm text-muted-foreground">كل مخزن مرتبط بالفرع الحالي؛ لا توجد حركة كمية بمجرد إنشائه.</p></div>{canCreateWarehouses ? <Button onClick={() => { setEditingWarehouseId(null); setShowWarehouseForm((value) => !value); }}><Warehouse className="ml-2 h-4 w-4" /> {showWarehouseForm && editingWarehouseId === null ? "إلغاء" : "إنشاء مخزن"}</Button> : null}</CardHeader>
                {showWarehouseForm ? <CardContent className="border-t pt-4"><form className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3" onSubmit={(event) => {
                  event.preventDefault();
                  if (warehouseLocationType === "generator_fuel_tank" && !warehouseGeneratorId) { toast.error("اختر المولد المرتبط بالخزان."); return; }
                  const payload = {
                    siteId, code: warehouseCode.trim(), name: warehouseName.trim(), notes: warehouseNotes.trim() || undefined,
                    locationType: warehouseLocationType as "central_warehouse" | "branch_warehouse" | "fixed_fuel_tank" | "generator_fuel_tank",
                    ...(warehouseLocationType === "generator_fuel_tank" ? { generatorId: Number(warehouseGeneratorId) } : {}),
                  };
                  if (editingWarehouseId) updateWarehouse.mutate({...payload, warehouseId: editingWarehouseId});
                  else createWarehouse.mutate(payload);
                }}>
                  <label className="space-y-1 text-sm">رمز موقع التخزين *<Input required maxLength={40} value={warehouseCode} onChange={(e) => setWarehouseCode(e.target.value)} /></label>
                  <label className="space-y-1 text-sm">اسم موقع التخزين *<Input required maxLength={120} value={warehouseName} onChange={(e) => setWarehouseName(e.target.value)} /></label>
                  <label className="space-y-1 text-sm">نوع الموقع
                    <select className="h-10 w-full rounded-md border bg-background px-3" value={warehouseLocationType} onChange={(e) => { setWarehouseLocationType(e.target.value); if (e.target.value !== "generator_fuel_tank") setWarehouseGeneratorId(""); }}>
                      {Object.entries(warehouseTypeLabels).map(([value,label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                  </label>
                  {warehouseLocationType === "generator_fuel_tank" ? <label className="space-y-1 text-sm">المولد المرتبط *
                    <select required className="h-10 w-full rounded-md border bg-background px-3" value={warehouseGeneratorId} onChange={(e) => setWarehouseGeneratorId(e.target.value)}>
                      <option value="">اختر المولد</option>
                      {(warehouseGenerators.data ?? []).map((generator) => <option key={generator.id} value={generator.id}>{generator.name} — #{generator.id}</option>)}
                    </select>
                  </label> : null}
                  <label className="space-y-1 text-sm">ملاحظات<Input maxLength={2000} value={warehouseNotes} onChange={(e) => setWarehouseNotes(e.target.value)} /></label>
                  <div className="flex flex-wrap items-end gap-2"><Button type="submit" disabled={createWarehouse.isPending || updateWarehouse.isPending || !warehouseCode.trim() || !warehouseName.trim() || (warehouseLocationType === "generator_fuel_tank" && !warehouseGeneratorId)}>{createWarehouse.isPending || updateWarehouse.isPending ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : null} {editingWarehouseId ? "حفظ التعديلات" : "حفظ موقع التخزين"}</Button>{editingWarehouseId ? <Button type="button" variant="outline" onClick={() => { setEditingWarehouseId(null); setShowWarehouseForm(false); setWarehouseCode(""); setWarehouseName(""); setWarehouseNotes(""); setWarehouseLocationType("branch_warehouse"); setWarehouseGeneratorId(""); }}>إلغاء التعديل</Button> : null}</div>
                </form></CardContent> : null}
                <CardContent><div className="mb-3 flex justify-end"><label className="flex items-center gap-2 text-sm text-muted-foreground"><input type="checkbox" checked={showInactiveWarehouses} onChange={(e) => setShowInactiveWarehouses(e.target.checked)} /> إظهار المخازن الموقوفة</label></div>{warehouses.isLoading ? <p className="py-8 text-center text-muted-foreground">جارٍ تحميل المخازن…</p> : warehouses.error ? <p className="py-8 text-center text-destructive">تعذر تحميل المخازن. تحقق من صلاحياتك.</p> : !warehouses.data?.length ? <p className="py-8 text-center text-muted-foreground">لا توجد مخازن لهذا الفرع.</p> : <div className="overflow-x-auto rounded-md border"><table className="w-full text-right text-sm"><thead className="bg-muted/60"><tr>{["الرمز","اسم موقع التخزين","النوع","المولد المرتبط","ملاحظات","الحالة","إجراءات"].map((x) => <th key={x} className="p-3 font-semibold">{x}</th>)}</tr></thead><tbody>{warehouses.data.map((warehouse) => <tr key={warehouse.id} className="border-t"><td className="p-3">{warehouse.code}</td><td className="p-3 font-medium">{warehouse.name}</td><td className="p-3">{warehouseTypeLabels[warehouse.location_type] ?? warehouse.location_type ?? "مخزن فرع"}</td><td className="p-3">{warehouse.generator_id ? (warehouseGenerators.data ?? []).find((generator) => Number(generator.id) === Number(warehouse.generator_id))?.name ?? `مولد #${warehouse.generator_id}` : "—"}</td><td className="p-3">{warehouse.notes || "—"}</td><td className="p-3">{warehouse.is_active ? "نشط" : "موقوف"}</td><td className="p-3"><div className="flex flex-wrap gap-1">{(canEditWarehouses || canDeactivateWarehouses) ? <><>{canEditWarehouses ? <Button type="button" size="sm" variant="outline" onClick={() => { setEditingWarehouseId(Number(warehouse.id)); setWarehouseCode(warehouse.code); setWarehouseName(warehouse.name); setWarehouseNotes(warehouse.notes ?? ""); setWarehouseLocationType(warehouse.location_type || "branch_warehouse"); setWarehouseGeneratorId(warehouse.generator_id ? String(warehouse.generator_id) : ""); setShowWarehouseForm(true); }}>تعديل</Button> : null}</><>{canDeactivateWarehouses ? <Button type="button" size="sm" variant="outline" disabled={setWarehouseActive.isPending} onClick={() => { const reason = warehouse.is_active ? window.prompt("أدخل سبب إيقاف المخزن (مطلوب):")?.trim() : undefined; if (warehouse.is_active && (!reason || reason.length < 3)) { toast.error("أدخل سببًا واضحًا من 3 أحرف على الأقل."); return; } setWarehouseActive.mutate({ siteId, warehouseId: Number(warehouse.id), isActive: !warehouse.is_active, ...(reason ? { reason } : {}) }); }}>{warehouse.is_active ? "إيقاف" : "إعادة تفعيل"}</Button> : null}</> </> : "—"}</div></td></tr>)}</tbody></table></div>}</CardContent>
              </Card>
            </TabsContent> : null}

            {canViewInventory || canAccessStocktakes ? <TabsContent value="stock" className="space-y-4">
              {canViewInventory ? <>
                <InventoryWarehouseTransferPanel
                  siteId={siteId}
                  isAuthenticated={isAuthenticated}
                  canAdjustInventory={canAdjustInventory}
                />
                <InventoryStockOperationsPanel
                  siteId={siteId}
                  isAuthenticated={isAuthenticated}
                  canIssueInventory={canIssueInventory}
                  canAdjustInventory={canAdjustInventory}
                  canManageFuelAndConsumption={canManageFuelAndConsumption}
                  canViewInventoryReports={canViewInventoryReports}
                />
              </> : null}
              {canAccessStocktakes ? <InventoryStocktakePanel
                siteId={siteId}
                isAuthenticated={isAuthenticated}
                canViewStocktakes={canViewStocktakes}
                canManageStocktakes={canManageStocktakes}
                canApproveStocktakes={canApproveStocktakes}
              /> : null}
            </TabsContent> : null}

            {canViewMaintenance ? <TabsContent value="maintenance" className="space-y-4"><InventoryMaintenancePanel
                siteId={siteId}
                isAuthenticated={isAuthenticated}
                canViewMaintenance={canViewMaintenance}
                canViewMaintenanceReport={canViewMaintenanceReport}
                canManageMaintenance={canManageMaintenance}
                canIssueInventory={canIssueInventory}
                canManageExpenses={supplierAccess.data?.permissions.includes("manageExpenses") ?? false}
              /></TabsContent> : null}

            {(canManageFuelAndConsumption || canViewInventoryReports) ? <TabsContent value="fuel" className="space-y-4">
              <InventoryFuelConsumptionPanel
                siteId={siteId}
                isAuthenticated={isAuthenticated}
                canManageFuelAndConsumption={canManageFuelAndConsumption}
                canViewInventoryReports={canViewInventoryReports}
              />
            </TabsContent> : null}
            {canViewInventoryReports ? <TabsContent value="reports" className="space-y-4"><InventoryReportsPanel siteId={siteId} isAuthenticated={isAuthenticated} canViewInventoryReports={canViewInventoryReports} /></TabsContent> : null}

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
