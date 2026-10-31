import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { runWithStableOperationKey } from "@/lib/offline-operation-idempotency";
import { getPowerHubConnectivitySnapshot, usePowerHubConnectivity } from "@/lib/offline-connectivity";
import { toast } from "sonner";
import { Boxes, ClipboardList, Loader2, Pencil, RefreshCw, Save, TrendingDown, X } from "lucide-react";

type MovementType = "issue" | "opening_balance" | "adjustment_in" | "adjustment_out" | "fuel_consumption";
type Props = {
  siteId: number;
  isAuthenticated: boolean;
  canIssueInventory: boolean;
  canAdjustInventory: boolean;
  canManageFuelAndConsumption: boolean;
  canViewInventoryReports: boolean;
};

type StockOverviewRow = {
  warehouse_id: number;
  warehouse_code: string;
  warehouse_name: string;
  item_id: number;
  sku: string | null;
  item_name: string;
  category: string;
  base_unit: string;
  reorder_point: number | string;
  on_hand_quantity: number | string;
  stock_value?: number | string;
  average_unit_cost?: number | string;
  below_reorder_point: boolean;
};

type StockMovementRow = {
  movement_id: number;
  warehouse_id: number;
  warehouse_code: string;
  warehouse_name: string;
  item_id: number;
  sku: string | null;
  item_name: string;
  base_unit: string;
  generator_id: number | null;
  movement_type: string;
  quantity: number | string;
  unit_cost?: number | string;
  total_cost_amount?: number | string;
  reference_no: string | null;
  notes: string | null;
  operation_key: string;
  occurred_at: string;
  reversal_of_movement_id?: number | null;
  corrects_movement_id?: number | null;
  correction_reason?: string | null;
  corrected_by_movement_id?: number | null;
  can_edit?: boolean;
  source_issue_movement_id?: number | null;
  returnable_quantity?: number | string;
};

const movementLabels: Record<MovementType, string> = {
  issue: "صرف صنف",
  opening_balance: "رصيد افتتاحي",
  adjustment_in: "تسوية زيادة",
  adjustment_out: "تسوية نقص",
  fuel_consumption: "استهلاك وقود للمولد",
};
const movementDescriptions: Record<MovementType, string> = {
  issue: "يصرف الكمية من المخزن، ويمكن ربطها بالمولد.",
  opening_balance: "يسجل الرصيد الفعلي عند بدء استخدام النظام مرة واحدة للصنف والمخزن، مع تكلفة وحدة وسبب واضح.",
  adjustment_in: "يسجل زيادة الجرد مع سبب واضح وتكلفة وحدة عند عدم وجود رصيد سابق.",
  adjustment_out: "يسجل نقص الجرد، ولا يسمح بأن يصبح الرصيد سالبًا.",
  fuel_consumption: "يسجل استهلاك صنف وقود ويربط الحركة بمولد محدد.",
};
const units: Record<string, string> = {
  liter: "لتر", milliliter: "ملليلتر", piece: "قطعة", container: "عبوة",
  kg: "كغم", gram: "غرام", meter: "متر", set: "طقم", gallon: "غالون", other: "أخرى",
};
const inputClass = "grid gap-1.5 text-sm";
const selectClass = "h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground";

function newOperationKey() {
  const token = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : String(Date.now()) + "-" + Math.random().toString(36).slice(2);
  return "stock-movement:" + token;
}
function fmtQty(value: unknown) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number.toLocaleString("ar-PS", { maximumFractionDigits: 3 }) : "—";
}
function fmtMoney(value: unknown) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number.toLocaleString("ar-PS", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—";
}

export default function InventoryStockOperationsPanel({
  siteId,
  isAuthenticated,
  canIssueInventory,
  canAdjustInventory,
  canManageFuelAndConsumption,
  canViewInventoryReports,
}: Props) {
  const utils = trpc.useUtils();
  const { user } = useAuth();
  const { isOnline: powerHubOnline, isChecking: connectivityChecking } = usePowerHubConnectivity();
  const serverWriteBlocked = connectivityChecking || !powerHubOnline || getPowerHubConnectivitySnapshot() !== true;
  const ensureServerWriteAllowed = () => {
    if (serverWriteBlocked || getPowerHubConnectivitySnapshot() !== true) {
      toast.error("يلزم اتصال موثوق بخادم PowerHub لتنفيذ هذه العملية؛ لم تُرحّل أي حركة.");
      return false;
    }
    return true;
  };
  const allowedTypes = useMemo<MovementType[]>(() => [
    ...(canIssueInventory ? ["issue" as const] : []),
    ...(canAdjustInventory ? ["opening_balance" as const, "adjustment_in" as const, "adjustment_out" as const] : []),
    ...(canManageFuelAndConsumption ? ["fuel_consumption" as const] : []),
  ], [canIssueInventory, canAdjustInventory, canManageFuelAndConsumption]);

  const [movementType, setMovementType] = useState<MovementType>(allowedTypes[0] ?? "issue");
  const [warehouseId, setWarehouseId] = useState("");
  const [itemId, setItemId] = useState("");
  const [generatorId, setGeneratorId] = useState("");
  const [quantity, setQuantity] = useState("");
  const [unitCost, setUnitCost] = useState("");
  const [referenceNo, setReferenceNo] = useState("");
  const [notes, setNotes] = useState("");
  const [stockSearch, setStockSearch] = useState("");
  const [returningMovement, setReturningMovement] = useState<StockMovementRow | null>(null);
  const [returnQuantity, setReturnQuantity] = useState("");
  const [returnReason, setReturnReason] = useState("");
  const [returnReferenceNo, setReturnReferenceNo] = useState("");
  const [returnNotes, setReturnNotes] = useState("");
  const [returnOperationKey, setReturnOperationKey] = useState("");
  const [editingMovement, setEditingMovement] = useState<StockMovementRow | null>(null);
  const [editQuantity, setEditQuantity] = useState("");
  const [editUnitCost, setEditUnitCost] = useState("");
  const [editReferenceNo, setEditReferenceNo] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [editReason, setEditReason] = useState("");
  const [editOperationKey, setEditOperationKey] = useState("");

  const warehouses = trpc.powerhub.inventory.listWarehouses.useQuery(
    { siteId }, { enabled: Boolean(siteId && isAuthenticated && allowedTypes.length), staleTime: 30_000 },
  );
  const items = trpc.powerhub.inventory.listItems.useQuery(
    { siteId }, { enabled: Boolean(siteId && isAuthenticated && allowedTypes.length), staleTime: 30_000 },
  );
  const generators = trpc.powerhub.generators.list.useQuery(
    { siteId }, { enabled: Boolean(siteId && isAuthenticated && (canIssueInventory || canManageFuelAndConsumption)), staleTime: 30_000 },
  );
  const stock = trpc.powerhub.inventory.stockOverview.useQuery(
    { siteId }, { enabled: Boolean(siteId && isAuthenticated), staleTime: 10_000 },
  );
  const movements = trpc.powerhub.inventory.listStockMovements.useQuery(
    { siteId, limit: 100 }, { enabled: Boolean(siteId && isAuthenticated), staleTime: 10_000 },
  );

  useEffect(() => {
    if (!allowedTypes.includes(movementType)) setMovementType(allowedTypes[0] ?? "issue");
  }, [allowedTypes, movementType]);
  useEffect(() => {
    if (!warehouses.data?.some((warehouse) => String(warehouse.id) === warehouseId) && warehouses.data?.[0]) {
      setWarehouseId(String(warehouses.data[0].id));
    }
  }, [warehouses.data, warehouseId]);
  const eligibleItems = useMemo(() => {
    const values = items.data ?? [];
    return movementType === "fuel_consumption" ? values.filter((item) => item.category === "fuel") : values;
  }, [items.data, movementType]);
  useEffect(() => {
    if (!eligibleItems.some((item) => String(item.id) === itemId) && eligibleItems[0]) {
      setItemId(String(eligibleItems[0].id));
    } else if (!eligibleItems.length && itemId) setItemId("");
  }, [eligibleItems, itemId]);
  const stockRows = (stock.data ?? []) as StockOverviewRow[];
  const movementRows = (movements.data ?? []) as StockMovementRow[];
  const selectedStock = stockRows.find((row) => String(row.warehouse_id) === warehouseId && String(row.item_id) === itemId);
  const currentQuantity = Number(selectedStock?.on_hand_quantity ?? 0);
  const visibleStock = stockRows.filter((row) => {
    if (!stockSearch.trim()) return true;
    const query = stockSearch.trim().toLocaleLowerCase();
    return (String(row.item_name ?? "") + " " + String(row.sku ?? "") + " " + String(row.warehouse_name ?? "")).toLocaleLowerCase().includes(query);
  });

  const refreshStock = async () => {
    await Promise.all([
      utils.powerhub.inventory.stockOverview.invalidate({ siteId }),
      utils.powerhub.inventory.listStockMovements.invalidate({ siteId }),
    ]);
  };
  const recordMovement = trpc.powerhub.inventory.recordStockMovement.useMutation({
    onSuccess: async (result) => {
      toast.success(result.replayed ? "تم التحقق من الحركة السابقة دون تكرار الكمية." :
        "تم تسجيل الحركة: " + (movementLabels[result.movement_type as MovementType] ?? result.movement_type));
      setQuantity("");
      setUnitCost("");
      setReferenceNo("");
      setNotes("");
      await refreshStock();
    },
  });

  const returnFromIssue = trpc.powerhub.inventory.returnFromIssue.useMutation({
    onSuccess: async (result) => {
      toast.success(result.replayed ? "تم التحقق من مرتجع الصرف السابق دون تكرار." :
        "تمت إعادة " + fmtQty(result.quantity) + " إلى المخزون بالتكلفة الأصلية للصرف.");
      setReturningMovement(null);
      setReturnQuantity("");
      setReturnReason("");
      setReturnReferenceNo("");
      setReturnNotes("");
      setReturnOperationKey("");
      await refreshStock();
    },
  });

  const beginReturnFromIssue = (movement: StockMovementRow) => {
    if (movement.movement_type !== "issue" || Number(movement.returnable_quantity ?? 0) <= 0) return;
    setReturningMovement(movement);
    setReturnQuantity(String(movement.returnable_quantity));
    setReturnReason("");
    setReturnReferenceNo(movement.reference_no ?? "");
    setReturnNotes("");
    setReturnOperationKey(newOperationKey());
  };

  const submitReturnFromIssue = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!ensureServerWriteAllowed()) return;
    if (!returningMovement || !returnOperationKey) return;
    const quantity = Number(returnQuantity);
    const returnable = Number(returningMovement.returnable_quantity ?? 0);
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > returnable ||
      Math.abs(quantity * 1000 - Math.round(quantity * 1000)) > 1e-7) {
      toast.error("أدخل كمية صحيحة لا تتجاوز المتبقي القابل للإرجاع: " + fmtQty(returnable)); return;
    }
    if (returnReason.trim().length < 3) { toast.error("أدخل سببًا واضحًا للإرجاع."); return; }
    const userId = Number(user?.id);
    if (!Number.isSafeInteger(userId) || userId < 1) { toast.error("تعذر تحديد مستخدم الجلسة؛ لم يُرسل المرتجع."); return; }
    const payload = {
      siteId, sourceIssueMovementId: returningMovement.movement_id, quantity,
      reason: returnReason.trim(), referenceNo: returnReferenceNo.trim() || undefined,
      notes: returnNotes.trim() || undefined,
    };
    void runWithStableOperationKey({ userId, siteId, kind: "inventory_issue_return", payload },
      (operationKey) => returnFromIssue.mutateAsync({ ...payload, operationKey }))
      .catch((error) => toast.error(error instanceof Error ? error.message : "تعذر إرجاع الصرف إلى المخزون."));
  };

  const correctMovement = trpc.powerhub.inventory.correctStockMovement.useMutation({
    onSuccess: async (result) => {
      toast.success(result.replayed ? "تم التحقق من التصحيح السابق دون إنشاء حركات مكررة." :
        "تم تصحيح الحركة #" + result.original_movement_id + " مع حفظ سجل العكس والتعديل.");
      setEditingMovement(null);
      setEditReason("");
      setEditOperationKey("");
      await refreshStock();
    },
  });

  const beginEditMovement = (movement: StockMovementRow) => {
    if (!movement.can_edit) return;
    setEditingMovement(movement);
    setEditQuantity(String(movement.quantity));
    setEditUnitCost(movement.movement_type === "adjustment_in" ? String(movement.unit_cost ?? "") : "");
    setEditReferenceNo(movement.reference_no ?? "");
    setEditNotes(movement.notes ?? "");
    setEditReason("");
    setEditOperationKey(newOperationKey());
  };

  const submitMovementCorrection = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!ensureServerWriteAllowed()) return;
    if (!editingMovement || !editOperationKey) return;
    const amount = Number(editQuantity);
    const cost = editUnitCost.trim() ? Number(editUnitCost) : undefined;
    if (!Number.isFinite(amount) || amount <= 0 || Math.abs(amount * 1000 - Math.round(amount * 1000)) > 1e-7) {
      toast.error("أدخل كمية موجبة لا تتجاوز ثلاث منازل عشرية."); return;
    }
    if (editingMovement.movement_type === "adjustment_in" &&
      (cost === undefined || !Number.isFinite(cost) || cost < 0 || Math.abs(cost * 10000 - Math.round(cost * 10000)) > 1e-7)) {
      toast.error("أدخل تكلفة وحدة صحيحة حتى أربع منازل عشرية."); return;
    }
    if (editReason.trim().length < 3) { toast.error("أدخل سببًا واضحًا للتعديل."); return; }
    const userId = Number(user?.id);
    if (!Number.isSafeInteger(userId) || userId < 1) { toast.error("تعذر تحديد مستخدم الجلسة؛ لم يُرسل التصحيح."); return; }
    const payload = {
      siteId, movementId: editingMovement.movement_id, quantity: amount,
      unitCost: editingMovement.movement_type === "adjustment_in" ? cost : undefined,
      referenceNo: editReferenceNo.trim() || undefined,
      notes: editNotes.trim() || undefined, reason: editReason.trim(),
    };
    void runWithStableOperationKey({ userId, siteId, kind: "inventory_movement_correction", payload },
      (operationKey) => correctMovement.mutateAsync({ ...payload, operationKey }))
      .catch((error) => toast.error(error instanceof Error ? error.message : "تعذر تصحيح حركة المخزون."));
  };

  const submitMovement = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!ensureServerWriteAllowed()) return;
    const amount = Number(quantity);
    const cost = unitCost.trim() ? Number(unitCost) : undefined;
    if (!Number.isFinite(amount) || amount <= 0 || Math.abs(amount * 1000 - Math.round(amount * 1000)) > 1e-7) {
      toast.error("أدخل كمية موجبة لا تتجاوز ثلاث منازل عشرية."); return;
    }
    if (cost !== undefined && (!Number.isFinite(cost) || cost < 0 || Math.abs(cost * 10000 - Math.round(cost * 10000)) > 1e-7)) {
      toast.error("أدخل تكلفة وحدة صحيحة حتى أربع منازل عشرية."); return;
    }
    if (["opening_balance", "adjustment_in", "adjustment_out"].includes(movementType) && !notes.trim()) {
      toast.error("أدخل سبب الحركة المخزنية."); return;
    }
    if (movementType === "opening_balance" && cost === undefined) {
      toast.error("أدخل تكلفة الوحدة للرصيد الافتتاحي."); return;
    }
    if (movementType === "adjustment_in" && currentQuantity <= 0 && cost === undefined) {
      toast.error("أدخل تكلفة الوحدة عند إضافة كمية لصنف لا يملك رصيدًا سابقًا."); return;
    }
    if (["issue", "adjustment_out", "fuel_consumption"].includes(movementType) && amount > currentQuantity) {
      toast.error("الكمية المتاحة هي " + fmtQty(currentQuantity) + " " + (units[selectedStock?.base_unit ?? "other"] ?? "")); return;
    }
    if (!warehouseId || !itemId) { toast.error("اختر المخزن والصنف."); return; }
    if (movementType === "fuel_consumption" && !generatorId) { toast.error("اختر المولد المرتبط باستهلاك الوقود."); return; }

    const userId = Number(user?.id);
    if (!Number.isSafeInteger(userId) || userId < 1) { toast.error("تعذر تحديد مستخدم الجلسة؛ لم تُرسل الحركة."); return; }
    const payload = {
      siteId, warehouseId: Number(warehouseId), itemId: Number(itemId), movementType,
      quantity: amount, unitCost: cost,
      generatorId: generatorId ? Number(generatorId) : undefined,
      referenceNo: referenceNo.trim() || undefined, notes: notes.trim() || undefined,
    };
    void runWithStableOperationKey({ userId, siteId, kind: "inventory_stock_movement", payload },
      (operationKey) => recordMovement.mutateAsync({ ...payload, operationKey }))
      .catch((error) => toast.error(error instanceof Error ? error.message : "تعذر تسجيل حركة المخزون."));
  };

  return (
    <div className="space-y-4">
      {serverWriteBlocked ? <p role="status" className="rounded-md border border-amber-500/30 p-3 text-sm text-amber-700">يُسمح باستعراض اللقطات المحلية، لكن حركات الصرف والتسوية والتصحيح والإرجاع تتطلب اتصالًا موثوقًا بالخادم.</p> : null}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
          <div>
            <CardTitle className="flex items-center gap-2"><Boxes className="h-5 w-5" /> أرصدة المخزون وحركاته</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">الرصيد مشتق من سجل الحركات؛ لا تُعدّل الكميات مباشرة في دليل الأصناف.</p>
          </div>
          <Button type="button" variant="outline" onClick={() => void refreshStock()} disabled={stock.isFetching || movements.isFetching}>
            {stock.isFetching || movements.isFetching ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <RefreshCw className="ml-2 h-4 w-4" />} تحديث
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          <Input value={stockSearch} onChange={(event) => setStockSearch(event.target.value)} placeholder="ابحث باسم الصنف أو الرمز أو المخزن…" />
          {stock.isLoading ? <p className="py-6 text-center text-muted-foreground">جارٍ تحميل الأرصدة…</p>
            : stock.error ? <p className="py-6 text-center text-destructive">تعذر تحميل الأرصدة: {stock.error.message}</p>
              : !visibleStock.length ? <p className="py-6 text-center text-muted-foreground">لا توجد أرصدة أو أصناف تحت حد إعادة الطلب لهذا الفرع.</p>
                : <div className="overflow-x-auto rounded-md border">
                  <table className="w-full min-w-[680px] text-right text-sm">
                    <thead className="bg-muted/60"><tr>
                      {["الصنف","المخزن","الرصيد المتاح","حد إعادة الطلب","الحالة",...(canViewInventoryReports ? ["قيمة المخزون"] : [])].map((label) => <th key={label} className="p-3 font-semibold">{label}</th>)}
                    </tr></thead>
                    <tbody>{visibleStock.map((row) => (
                      <tr key={String(row.warehouse_id) + ":" + String(row.item_id)} className="border-t">
                        <td className="p-3 font-medium">{row.item_name}<div className="text-xs text-muted-foreground">{row.sku || "—"}</div></td>
                        <td className="p-3">{row.warehouse_name}</td>
                        <td className="p-3 tabular-nums">{fmtQty(row.on_hand_quantity)} {units[row.base_unit] ?? row.base_unit}</td>
                        <td className="p-3 tabular-nums">{fmtQty(row.reorder_point)}</td>
                        <td className="p-3">{row.below_reorder_point ? <span className="text-amber-700 dark:text-amber-300">يحتاج إعادة طلب</span> : "متوفر"}</td>
                        {canViewInventoryReports ? <td className="p-3 tabular-nums">{fmtMoney(row.stock_value)}</td> : null}
                      </tr>
                    ))}</tbody>
                  </table>
                </div>}
          <p className="text-xs text-muted-foreground">تُقيّم حركات الصرف والاستهلاك بتكلفة متوسط الرصيد الحالي؛ تستخدم تسوية الزيادة التكلفة المدخلة أو المتوسط الحالي.</p>
        </CardContent>
      </Card>

      {allowedTypes.length ? <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><TrendingDown className="h-5 w-5" /> تسجيل حركة مخزنية</CardTitle>
          <p className="text-sm text-muted-foreground">تُراجع الصلاحية والكمية والتكرار داخل معاملة قاعدة البيانات قبل تثبيت الحركة.</p>
        </CardHeader>
        <CardContent>
          <form className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3" onSubmit={submitMovement}>
            <label className={inputClass}>نوع الحركة
              <select className={selectClass} value={movementType} onChange={(event) => {
                setMovementType(event.target.value as MovementType); setItemId(""); setQuantity(""); setUnitCost("");
              }}>
                {allowedTypes.map((type) => <option key={type} value={type}>{movementLabels[type]}</option>)}
              </select>
            </label>
            <label className={inputClass}>المخزن *
              <select className={selectClass} value={warehouseId} onChange={(event) => setWarehouseId(event.target.value)} required>
                <option value="">اختر المخزن</option>
                {(warehouses.data ?? []).map((warehouse) => <option key={warehouse.id} value={warehouse.id}>{warehouse.name} ({warehouse.code})</option>)}
              </select>
            </label>
            <label className={inputClass}>الصنف *
              <select className={selectClass} value={itemId} onChange={(event) => setItemId(event.target.value)} required>
                <option value="">اختر الصنف</option>
                {eligibleItems.map((item) => <option key={item.id} value={item.id}>
                  {item.name}{item.sku ? " (" + item.sku + ")" : ""} — {units[item.base_unit] ?? item.base_unit}
                </option>)}
              </select>
            </label>
            {movementType === "fuel_consumption" || movementType === "issue" ? (
              <label className={inputClass}>{movementType === "fuel_consumption" ? "المولد *" : "المولد (اختياري)"}
                <select className={selectClass} value={generatorId} onChange={(event) => setGeneratorId(event.target.value)} required={movementType === "fuel_consumption"}>
                  <option value="">اختر المولد</option>
                  {(generators.data ?? []).map((generator) => <option key={generator.id} value={generator.id}>
                    {generator.name}{generator.code ? " (" + generator.code + ")" : ""}
                  </option>)}
                </select>
              </label>
            ) : null}
            <label className={inputClass}>الكمية *
              <Input type="number" required min="0.001" step="0.001" max={["opening_balance", "adjustment_in"].includes(movementType) ? 1_000_000_000 : undefined} value={quantity} onChange={(event) => setQuantity(event.target.value)} />
              <span className="text-xs text-muted-foreground">الرصيد الحالي: {fmtQty(currentQuantity)} {units[selectedStock?.base_unit ?? "other"] ?? ""}</span>
            </label>
            {["opening_balance", "adjustment_in"].includes(movementType) ? <label className={inputClass}>{movementType === "opening_balance" ? "تكلفة الوحدة *" : "تكلفة الوحدة (اختيارية مع وجود رصيد)"}
              <Input type="number" min="0" step="0.0001" max="1000000000" value={unitCost} onChange={(event) => setUnitCost(event.target.value)} placeholder={selectedStock?.average_unit_cost ? String(selectedStock.average_unit_cost) : "مطلوبة لأول رصيد"} />
            </label> : null}
            <label className={inputClass}>رقم المرجع (اختياري)
              <Input maxLength={120} value={referenceNo} onChange={(event) => setReferenceNo(event.target.value)} placeholder="رقم أمر صرف أو مرجع داخلي" />
            </label>
            <label className={inputClass + " md:col-span-2"}>{["opening_balance", "adjustment_in", "adjustment_out"].includes(movementType) ? (movementType === "opening_balance" ? "سبب الرصيد الافتتاحي *" : "سبب التسوية *") : "ملاحظات"}
              <Input maxLength={2000} value={notes} onChange={(event) => setNotes(event.target.value)} required={["opening_balance", "adjustment_in", "adjustment_out"].includes(movementType)} placeholder={movementType === "fuel_consumption" ? "مثال: تعبئة مولد الفرع" : movementType === "issue" ? "سبب الصرف أو أمر العمل" : "سبب الجرد والتسوية"} />
            </label>
            <div className="md:col-span-2 xl:col-span-3 rounded-md bg-muted/40 p-3 text-sm text-muted-foreground">{movementDescriptions[movementType]}</div>
            <div><Button type="submit" disabled={serverWriteBlocked || recordMovement.isPending || warehouses.isLoading || items.isLoading || !warehouseId || !itemId}>
              {recordMovement.isPending ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Save className="ml-2 h-4 w-4" />} تسجيل الحركة
            </Button></div>
          </form>
        </CardContent>
      </Card> : null}

      {!allowedTypes.length ? <Card><CardContent className="p-4 text-sm text-muted-foreground">
        لديك صلاحية الاطلاع فقط. لإجراء الصرف أو التسويات أو استهلاك الوقود اطلب الصلاحية المناسبة من صاحب المولد.
      </CardContent></Card> : null}

      {editingMovement ? <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2"><Pencil className="h-5 w-5" /> تعديل الحركة #{editingMovement.movement_id}</CardTitle>
            <p className="text-sm text-muted-foreground">سيُحفظ عكس الحركة الأصلية والحركة المصححة في سجل مستقل؛ لن تتغير الحركة القديمة.</p>
          </div>
          <Button type="button" variant="outline" onClick={() => setEditingMovement(null)} disabled={correctMovement.isPending}>
            <X className="ml-2 h-4 w-4" /> إلغاء
          </Button>
        </CardHeader>
        <CardContent>
          <form className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3" onSubmit={submitMovementCorrection}>
            <div className={inputClass}>نوع الحركة
              <Input value={movementLabels[editingMovement.movement_type as MovementType] ?? editingMovement.movement_type} readOnly />
            </div>
            <div className={inputClass}>الصنف والمخزن
              <Input value={editingMovement.item_name + " — " + editingMovement.warehouse_name} readOnly />
            </div>
            <label className={inputClass}>الكمية المصححة *
              <Input type="number" required min="0.001" max="1000000000" step="0.001" value={editQuantity} onChange={(event) => setEditQuantity(event.target.value)} />
            </label>
            {editingMovement.movement_type === "adjustment_in" ? <label className={inputClass}>تكلفة الوحدة *
              <Input type="number" required min="0" max="1000000000" step="0.0001" value={editUnitCost} onChange={(event) => setEditUnitCost(event.target.value)} />
            </label> : null}
            <label className={inputClass}>رقم المرجع
              <Input maxLength={120} value={editReferenceNo} onChange={(event) => setEditReferenceNo(event.target.value)} />
            </label>
            <label className={inputClass}>ملاحظات
              <Input maxLength={2000} value={editNotes} onChange={(event) => setEditNotes(event.target.value)} />
            </label>
            <label className={inputClass + " md:col-span-2"}>سبب التعديل * 
              <Input required minLength={3} maxLength={500} value={editReason} onChange={(event) => setEditReason(event.target.value)} placeholder="مثال: تصحيح الكمية بعد إعادة الجرد" />
            </label>
            <div className="md:col-span-2 xl:col-span-3 rounded-md bg-muted/40 p-3 text-sm text-muted-foreground">
              لا يمكن تعديل حركة سبقها صرف أو حركة أحدث للصنف نفسه، أو حركة مرتبطة بفاتورة مشتريات أو مرتجع مورد أو فترة مالية مقفلة.
            </div>
            <div><Button type="submit" disabled={serverWriteBlocked || correctMovement.isPending || !editOperationKey}>
              {correctMovement.isPending ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Save className="ml-2 h-4 w-4" />} حفظ التصحيح
            </Button></div>
          </form>
        </CardContent>
      </Card> : null}


      {returningMovement ? <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
          <div><CardTitle>إرجاع صرف إلى المخزون</CardTitle>
            <p className="text-sm text-muted-foreground">{returningMovement.item_name} — الصرف #{returningMovement.movement_id}; المتبقي للإرجاع {fmtQty(returningMovement.returnable_quantity)} {units[returningMovement.base_unit] ?? returningMovement.base_unit}.</p>
          </div>
          <Button type="button" variant="ghost" onClick={() => setReturningMovement(null)}><X className="ml-1 h-4 w-4" /> إلغاء</Button>
        </CardHeader>
        <CardContent>
          <form className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3" onSubmit={submitReturnFromIssue}>
            <label className={inputClass}>الكمية المراد إرجاعها *
              <Input type="number" min="0.001" step="0.001" max={Number(returningMovement.returnable_quantity ?? 0)} required value={returnQuantity} onChange={(event) => setReturnQuantity(event.target.value)} />
            </label>
            <label className={inputClass}>المرجع (اختياري)
              <Input maxLength={120} value={returnReferenceNo} onChange={(event) => setReturnReferenceNo(event.target.value)} />
            </label>
            <label className={inputClass}>سبب الإرجاع *
              <Input minLength={3} maxLength={500} required value={returnReason} onChange={(event) => setReturnReason(event.target.value)} placeholder="مثال: إعادة مواد غير مستخدمة" />
            </label>
            <label className={inputClass + " md:col-span-2"}>ملاحظات
              <Input maxLength={2000} value={returnNotes} onChange={(event) => setReturnNotes(event.target.value)} />
            </label>
            <div className="md:col-span-2 xl:col-span-3 rounded-md bg-muted/40 p-3 text-sm text-muted-foreground">
              تُحسب تكلفة المرتجع من تكلفة الصرف الأصلي وتُوزّع فروق التقريب تراكميًا. لا يمكن تجاوز الكمية المصروفة أو إرجاع الكمية نفسها مرتين.
            </div>
            <div><Button type="submit" disabled={serverWriteBlocked || returnFromIssue.isPending || !returnOperationKey}>
              {returnFromIssue.isPending ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Save className="ml-2 h-4 w-4" />} تأكيد الإرجاع
            </Button></div>
          </form>
        </CardContent>
      </Card> : null}

      <Card>
        <CardHeader className="flex flex-row items-center gap-2 space-y-0"><ClipboardList className="h-5 w-5" /><CardTitle>آخر الحركات</CardTitle></CardHeader>
        <CardContent>
          {movements.isLoading ? <p className="py-6 text-center text-muted-foreground">جارٍ تحميل سجل الحركات…</p>
            : movements.error ? <p className="py-6 text-center text-destructive">تعذر تحميل سجل الحركات.</p>
              : !movements.data?.length ? <p className="py-6 text-center text-muted-foreground">لا توجد حركات حتى الآن.</p>
                : <div className="overflow-x-auto rounded-md border">
                  <table className="w-full min-w-[760px] text-right text-sm">
                    <thead className="bg-muted/60"><tr>
                      {["التاريخ","الحركة","الصنف","المخزن","الكمية","المولد","المرجع",...(canViewInventoryReports ? ["التكلفة"] : []),...(canAdjustInventory ? ["إجراء"] : [])].map((label) => <th key={label} className="p-3 font-semibold">{label}</th>)}
                    </tr></thead>
                    <tbody>{movementRows.map((movement) => (
                      <tr key={movement.movement_id} className="border-t">
                        <td className="p-3 whitespace-nowrap">{new Date(movement.occurred_at).toLocaleString("ar-PS")}</td>
                        <td className="p-3">{movementLabels[movement.movement_type as MovementType] ?? movement.movement_type}</td>
                        <td className="p-3 font-medium">{movement.item_name}<div className="text-xs text-muted-foreground">{movement.sku || "—"}</div></td>
                        <td className="p-3">{movement.warehouse_name}</td>
                        <td className="p-3 tabular-nums">{fmtQty(movement.quantity)} {units[movement.base_unit] ?? movement.base_unit}</td>
                        <td className="p-3">{movement.generator_id ? (generators.data?.find((item) => item.id === movement.generator_id)?.name ?? "#" + movement.generator_id) : "—"}</td>
                        <td className="p-3">{movement.reference_no || "—"}</td>
                        {canViewInventoryReports ? <td className="p-3 tabular-nums">{fmtMoney(movement.total_cost_amount)}</td> : null}
                        {canAdjustInventory ? <td className="p-3 whitespace-nowrap">
                          {movement.movement_type === "issue" && Number(movement.returnable_quantity ?? 0) > 0 ?
                            <Button type="button" size="sm" variant="outline" onClick={() => beginReturnFromIssue(movement)}>
                              إرجاع ({fmtQty(movement.returnable_quantity)})
                            </Button> : null}
                          {movement.can_edit ? <Button type="button" size="sm" variant="outline" onClick={() => beginEditMovement(movement)}>
                            <Pencil className="ml-1 h-3.5 w-3.5" /> تعديل
                          </Button> : movement.corrects_movement_id ? <span className="text-xs text-muted-foreground">تصحيح #{movement.corrects_movement_id}</span>
                            : movement.reversal_of_movement_id ? <span className="text-xs text-muted-foreground">عكس #{movement.reversal_of_movement_id}</span>
                              : movement.corrected_by_movement_id ? <span className="text-xs text-muted-foreground">تم تصحيحها</span>
                                : !movement.can_edit && !(movement.movement_type === "issue" && Number(movement.returnable_quantity ?? 0) > 0) ? <span className="text-xs text-muted-foreground">—</span> : null}
                        </td> : null}
                      </tr>
                    ))}</tbody>
                  </table>
                </div>}
          <p className="mt-2 text-xs text-muted-foreground">يعرض السجل آخر 100 حركة. استخدم تحديث الأرصدة لإعادة تحميل الإجماليات.</p>
        </CardContent>
      </Card>
    </div>
  );
}
