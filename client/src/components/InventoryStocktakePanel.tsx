import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import { ClipboardCheck, Loader2, PackageCheck, Plus, RefreshCw, Send, XCircle } from "lucide-react";
import { toast } from "sonner";

type Props = {
  siteId: number;
  isAuthenticated: boolean;
  canViewStocktakes: boolean;
  canManageStocktakes: boolean;
  canApproveStocktakes: boolean;
};

const statusLabels: Record<string, string> = {
  counting: "قيد العد",
  submitted: "بانتظار الاعتماد",
  posted: "مُرحّل",
  cancelled: "ملغى",
};

const statusTone: Record<string, string> = {
  counting: "bg-sky-400/10 text-sky-200",
  submitted: "bg-amber-400/10 text-amber-200",
  posted: "bg-emerald-400/10 text-emerald-200",
  cancelled: "bg-white/5 text-slate-400",
};

const locationLabels: Record<string, string> = {
  central_warehouse: "المخزن المركزي",
  branch_warehouse: "مخزن فرع",
  fixed_fuel_tank: "خزان وقود ثابت",
  generator_fuel_tank: "خزان مرتبط بمولد",
};

function stocktakeOperationKey() {
  const token = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `inventory-stocktake:${token}`;
}

function qty(value: number | string | null | undefined) {
  const parsed = Number(value ?? 0);
  return new Intl.NumberFormat("ar-PS", { maximumFractionDigits: 3 }).format(Number.isFinite(parsed) ? parsed : 0);
}

function money(value: number | string | null | undefined) {
  const parsed = Number(value ?? 0);
  return `₪${new Intl.NumberFormat("ar-PS", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number.isFinite(parsed) ? parsed : 0)}`;
}

export default function InventoryStocktakePanel({
  siteId,
  isAuthenticated,
  canViewStocktakes,
  canManageStocktakes,
  canApproveStocktakes,
}: Props) {
  const utils = trpc.useUtils();
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [warehouseId, setWarehouseId] = useState("");
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  const [operationKey, setOperationKey] = useState(stocktakeOperationKey);
  const [selectedStocktakeId, setSelectedStocktakeId] = useState<number | null>(null);
  const [countValues, setCountValues] = useState<Record<string, string>>({});
  const [countCosts, setCountCosts] = useState<Record<string, string>>({});
  const [countNotes, setCountNotes] = useState<Record<string, string>>({});

  const enabled = Boolean(siteId && isAuthenticated && (canViewStocktakes || canManageStocktakes || canApproveStocktakes));
  const warehouseQuery = trpc.powerhub.inventory.listStocktakeWarehouses.useQuery(
    { siteId },
    { enabled, staleTime: 30_000 },
  );
  const stocktakesQuery = trpc.powerhub.inventory.listStocktakes.useQuery(
    { siteId, warehouseId: warehouseId ? Number(warehouseId) : undefined, limit: 100 },
    { enabled, staleTime: 10_000 },
  );
  const linesQuery = trpc.powerhub.inventory.listStocktakeLines.useQuery(
    { siteId, stocktakeId: selectedStocktakeId ?? 0 },
    { enabled: Boolean(enabled && selectedStocktakeId), staleTime: 5_000 },
  );

  const warehouses = warehouseQuery.data ?? [];
  const stocktakes = stocktakesQuery.data ?? [];
  const lines = linesQuery.data ?? [];
  const selectedStocktake = stocktakes.find((stocktake) => Number(stocktake.stocktake_id) === selectedStocktakeId) ?? null;
  const varianceCount = Number(selectedStocktake?.variance_count ?? 0);
  const countedCount = Number(selectedStocktake?.counted_count ?? 0);
  const itemCount = Number(selectedStocktake?.item_count ?? 0);

  useEffect(() => {
    if (warehouseId && !warehouses.some((warehouse) => String(warehouse.id) === warehouseId)) {
      setWarehouseId("");
    }
  }, [warehouseId, warehouses]);

  useEffect(() => {
    if (selectedStocktakeId && stocktakes.some((stocktake) => Number(stocktake.stocktake_id) === selectedStocktakeId)) return;
    const next = stocktakes[0]?.stocktake_id;
    setSelectedStocktakeId(next == null ? null : Number(next));
  }, [selectedStocktakeId, stocktakes]);

  useEffect(() => {
    if (!selectedStocktakeId || !lines.length) return;
    setCountValues((current) => {
      const next = { ...current };
      for (const line of lines) {
        const key = `${selectedStocktakeId}:${line.item_id}`;
        if (next[key] === undefined) next[key] = line.counted_quantity == null ? "" : String(line.counted_quantity);
      }
      return next;
    });
    setCountCosts((current) => {
      const next = { ...current };
      for (const line of lines) {
        const key = `${selectedStocktakeId}:${line.item_id}`;
        if (next[key] === undefined) next[key] = line.counted_unit_cost == null ? "" : String(line.counted_unit_cost);
      }
      return next;
    });
    setCountNotes((current) => {
      const next = { ...current };
      for (const line of lines) {
        const key = `${selectedStocktakeId}:${line.item_id}`;
        if (next[key] === undefined) next[key] = line.count_notes ?? "";
      }
      return next;
    });
  }, [selectedStocktakeId, lines]);

  const refresh = async () => {
    await Promise.all([
      utils.powerhub.inventory.listStocktakes.invalidate(),
      utils.powerhub.inventory.listStocktakeLines.invalidate(),
      utils.powerhub.inventory.stockOverview.invalidate({ siteId }),
      utils.powerhub.inventory.listStockMovements.invalidate({ siteId, limit: 100 }),
      utils.powerhub.inventory.listStockMovementReport.invalidate(),
    ]);
  };

  const createStocktake = trpc.powerhub.inventory.createStocktake.useMutation({
    onSuccess: async (result) => {
      toast.success(result.replayed ? "تم التحقق من جلسة الجرد السابقة دون إنشاء نسخة مكررة." : `تم فتح جلسة الجرد ${result.stocktake_number} وإثبات لقطة الأرصدة.`);
      setShowCreateForm(false);
      setReason("");
      setNotes("");
      setOperationKey(stocktakeOperationKey());
      setSelectedStocktakeId(Number(result.stocktake_id));
      await refresh();
    },
    onError: (error) => toast.error(error.message || "تعذر فتح جلسة الجرد."),
  });

  const recordCount = trpc.powerhub.inventory.recordStocktakeCount.useMutation({
    onSuccess: async (result) => {
      const key = `${result.stocktake_id}:${result.item_id}`;
      setCountValues((current) => ({ ...current, [key]: String(result.counted_quantity) }));
      toast.success("تم حفظ العد الفعلي وتسجيل أثره في التدقيق.");
      await Promise.all([
        utils.powerhub.inventory.listStocktakes.invalidate(),
        utils.powerhub.inventory.listStocktakeLines.invalidate({ siteId, stocktakeId: Number(result.stocktake_id) }),
      ]);
    },
    onError: (error) => toast.error(error.message || "تعذر حفظ العد الفعلي."),
  });

  const submitStocktake = trpc.powerhub.inventory.submitStocktake.useMutation({
    onSuccess: async (result) => {
      toast.success(result.replayed ? "جلسة الجرد أُرسلت للاعتماد سابقًا." : "تم إرسال الجرد للاعتماد بعد التحقق من اكتمال العد وثبات الأرصدة.");
      await refresh();
    },
    onError: (error) => toast.error(error.message || "تعذر إرسال الجرد للاعتماد."),
  });

  const postStocktake = trpc.powerhub.inventory.postStocktake.useMutation({
    onSuccess: async (result) => {
      toast.success(result.replayed
        ? "الجرد مُرحّل مسبقًا؛ لم تُنشأ حركات مكررة."
        : `تم اعتماد الجرد وترحيل ${result.posted_movement_count} حركة تسوية.`);
      await refresh();
    },
    onError: (error) => toast.error(error.message || "تعذر اعتماد وترحيل الجرد."),
  });

  const cancelStocktake = trpc.powerhub.inventory.cancelStocktake.useMutation({
    onSuccess: async (result) => {
      toast.success(result.replayed ? "جلسة الجرد ملغاة مسبقًا." : "تم إلغاء جلسة الجرد مع الاحتفاظ بسجلها.");
      await refresh();
    },
    onError: (error) => toast.error(error.message || "تعذر إلغاء جلسة الجرد."),
  });

  const selectedLinesComplete = useMemo(() => lines.length > 0 && lines.every((line) => line.counted_quantity != null), [lines]);

  const onCreate = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!warehouseId) { toast.error("اختر موقع التخزين الذي ستجري جرده."); return; }
    if (reason.trim().length < 3) { toast.error("أدخل سببًا واضحًا لبدء الجرد."); return; }
    createStocktake.mutate({
      siteId,
      warehouseId: Number(warehouseId),
      reason: reason.trim(),
      notes: notes.trim() || undefined,
      operationKey,
    });
  };

  const saveLine = (line: (typeof lines)[number]) => {
    if (!selectedStocktakeId) return;
    const key = `${selectedStocktakeId}:${line.item_id}`;
    const rawQuantity = (countValues[key] ?? "").trim();
    const countedQuantity = Number(rawQuantity);
    if (!rawQuantity || !Number.isFinite(countedQuantity) || countedQuantity < 0
      || Math.abs(countedQuantity * 1000 - Math.round(countedQuantity * 1000)) > 1e-7) {
      toast.error("أدخل الكمية الفعلية بصفر أو أكثر وبحد أقصى ثلاث منازل عشرية.");
      return;
    }
    const costText = (countCosts[key] ?? "").trim();
    const countedUnitCost = costText ? Number(costText) : undefined;
    if (costText && (!Number.isFinite(countedUnitCost) || Number(countedUnitCost) < 0
      || Math.abs(Number(countedUnitCost) * 10000 - Math.round(Number(countedUnitCost) * 10000)) > 1e-7)) {
      toast.error("تكلفة الوحدة تقبل أربع منازل عشرية كحد أقصى.");
      return;
    }
    if (line.system_quantity <= 0 && countedQuantity > 0 && countedUnitCost == null) {
      toast.error("أدخل تكلفة وحدة لتقييم الزيادة لأن الصنف لا يملك رصيدًا سابقًا.");
      return;
    }
    recordCount.mutate({
      siteId,
      stocktakeId: selectedStocktakeId,
      itemId: Number(line.item_id),
      countedQuantity,
      countedUnitCost,
      countNotes: (countNotes[key] ?? "").trim() || undefined,
    });
  };

  const requestCancel = () => {
    if (!selectedStocktakeId) return;
    const cancelReason = window.prompt("أدخل سبب إلغاء جلسة الجرد (مطلوب):")?.trim();
    if (!cancelReason || cancelReason.length < 3) {
      toast.error("يلزم إدخال سبب واضح من 3 أحرف على الأقل.");
      return;
    }
    cancelStocktake.mutate({ siteId, stocktakeId: selectedStocktakeId, reason: cancelReason });
  };

  if (!enabled) {
    return <Card><CardContent className="p-5 text-sm text-muted-foreground">لا توجد صلاحية لعرض أو تنفيذ الجرد المخزني.</CardContent></Card>;
  }

  return (
    <div dir="rtl" className="space-y-4">
      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2"><ClipboardCheck className="h-5 w-5" /> الجرد الفعلي</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">تبدأ الجلسة بلقطة أرصدة مرجعية، ثم تُدخل الكميات الفعلية. يُمنع الإرسال أو الترحيل إذا تغيّر الرصيد أو دليل الأصناف أثناء العد.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" disabled={stocktakesQuery.isFetching || linesQuery.isFetching || warehouseQuery.isFetching} onClick={() => void refresh()}>
              <RefreshCw className="ml-2 h-4 w-4" /> تحديث
            </Button>
            {canManageStocktakes ? <Button type="button" onClick={() => setShowCreateForm((current) => !current)}>
              <Plus className="ml-2 h-4 w-4" /> {showCreateForm ? "إلغاء" : "جلسة جرد جديدة"}
            </Button> : null}
          </div>
        </CardHeader>
        {showCreateForm && canManageStocktakes ? <CardContent className="border-t pt-4">
          <form className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" onSubmit={onCreate}>
            <label className="grid gap-1.5 text-sm">موقع التخزين *
              <select required className="h-10 rounded-md border bg-background px-3" value={warehouseId} onChange={(event) => setWarehouseId(event.target.value)}>
                <option value="">اختر الموقع</option>
                {warehouses.map((warehouse) => <option key={warehouse.id} value={warehouse.id}>{warehouse.name} — {locationLabels[warehouse.location_type] ?? warehouse.location_type}</option>)}
              </select>
            </label>
            <label className="grid gap-1.5 text-sm">سبب الجرد *
              <Input required minLength={3} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="جرد دوري / نهاية دورة" />
            </label>
            <label className="grid gap-1.5 text-sm">ملاحظات
              <Input maxLength={2000} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="ملاحظات إدارية" />
            </label>
            <div className="flex items-end"><Button type="submit" className="w-full" disabled={createStocktake.isPending || !warehouseId || reason.trim().length < 3}>
              {createStocktake.isPending ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <ClipboardCheck className="ml-2 h-4 w-4" />} فتح الجلسة وتصوير الأرصدة
            </Button></div>
          </form>
          {warehouseQuery.error ? <p className="mt-3 text-sm text-destructive">تعذر تحميل مواقع التخزين المتاحة للجرد.</p> : null}
        </CardContent> : null}
        <CardContent className="space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <label className="grid max-w-md flex-1 gap-1.5 text-sm">تصفية سجل الجرد بموقع التخزين
              <select className="h-10 rounded-md border bg-background px-3" value={warehouseId} onChange={(event) => setWarehouseId(event.target.value)}>
                <option value="">كل المواقع</option>
                {warehouses.map((warehouse) => <option key={warehouse.id} value={warehouse.id}>{warehouse.name}</option>)}
              </select>
            </label>
            <span className="text-xs text-muted-foreground">{stocktakes.length} جلسة في السجل الظاهر</span>
          </div>
          {stocktakesQuery.isLoading ? <p className="py-6 text-center text-muted-foreground"><Loader2 className="ml-2 inline h-4 w-4 animate-spin" /> جارٍ تحميل سجل الجرد…</p>
            : stocktakesQuery.error ? <div className="rounded-md border p-4 text-sm text-destructive">تعذر تحميل جلسات الجرد. تحقق من صلاحياتك أو أعد المحاولة.</div>
            : !stocktakes.length ? <p className="rounded-md border p-5 text-center text-sm text-muted-foreground">لا توجد جلسات جرد بعد. افتح جلسة جديدة لتصوير الأرصدة قبل العد.</p>
            : <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
              {stocktakes.map((stocktake) => {
                const selected = Number(stocktake.stocktake_id) === selectedStocktakeId;
                return <button type="button" key={stocktake.stocktake_id} onClick={() => setSelectedStocktakeId(Number(stocktake.stocktake_id))}
                  className={`rounded-lg border p-3 text-right transition-colors ${selected ? "border-primary bg-primary/5" : "hover:bg-muted/40"}`}>
                  <div className="flex items-start justify-between gap-2">
                    <span className="font-semibold">{stocktake.stocktake_number || `#${stocktake.stocktake_id}`}</span>
                    <Badge className={statusTone[stocktake.status] ?? "bg-white/5 text-slate-400"}>{statusLabels[stocktake.status] ?? stocktake.status}</Badge>
                  </div>
                  <p className="mt-2 text-sm">{stocktake.warehouse_name}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{stocktake.reason}</p>
                  <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span>الأصناف: {stocktake.item_count}</span>
                    <span>المعدود: {stocktake.counted_count}</span>
                    <span>الفروقات: {stocktake.variance_count}</span>
                  </div>
                </button>;
              })}
            </div>}
        </CardContent>
      </Card>

      {selectedStocktake ? <Card>
        <CardHeader className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
          <div>
            <CardTitle>{selectedStocktake.stocktake_number} — {selectedStocktake.warehouse_name}</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">{selectedStocktake.reason}</p>
            <p className="mt-1 text-xs text-muted-foreground">لقطة الأرصدة: {new Date(selectedStocktake.snapshot_at).toLocaleString("ar-PS")}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge className={statusTone[selectedStocktake.status] ?? "bg-white/5 text-slate-400"}>{statusLabels[selectedStocktake.status] ?? selectedStocktake.status}</Badge>
            {selectedStocktake.status === "counting" && canManageStocktakes ? <Button type="button" variant="outline" onClick={() => {
              if (!selectedStocktakeId) return;
              if (!selectedLinesComplete) { toast.error("احفظ عدّ كل الأصناف قبل إرسال الجرد."); return; }
              submitStocktake.mutate({ siteId, stocktakeId: selectedStocktakeId });
            }} disabled={submitStocktake.isPending || !selectedLinesComplete || countedCount !== itemCount}>
              {submitStocktake.isPending ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Send className="ml-2 h-4 w-4" />} إرسال للاعتماد
            </Button> : null}
            {selectedStocktake.status === "submitted" && canApproveStocktakes ? <Button type="button" onClick={() => selectedStocktakeId && postStocktake.mutate({ siteId, stocktakeId: selectedStocktakeId })} disabled={postStocktake.isPending}>
              {postStocktake.isPending ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <PackageCheck className="ml-2 h-4 w-4" />} اعتماد وترحيل
            </Button> : null}
            {selectedStocktake.status === "counting" && canManageStocktakes ? <Button type="button" variant="outline" onClick={requestCancel} disabled={cancelStocktake.isPending}>
              {cancelStocktake.isPending ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <XCircle className="ml-2 h-4 w-4" />} إلغاء الجلسة
            </Button> : null}
          </div>
        </CardHeader>
        <CardContent>
          {linesQuery.isLoading ? <p className="py-6 text-center text-muted-foreground">جارٍ تحميل تفاصيل العد…</p>
            : linesQuery.error ? <p className="py-6 text-center text-destructive">تعذر تحميل تفاصيل جلسة الجرد.</p>
            : !lines.length ? <p className="py-6 text-center text-muted-foreground">لا توجد بنود ضمن هذه الجلسة.</p>
            : <div className="overflow-x-auto rounded-md border">
              <table className="w-full min-w-[1200px] text-right text-sm">
                <thead className="bg-muted/60"><tr>{["الصنف","الوحدة","رصيد النظام","قيمة النظام","تكلفة الوحدة","الكمية المعدودة","تكلفة الزيادة","الفرق","ملاحظات العد","إجراء"].map((title) => <th key={title} className="p-3 font-semibold">{title}</th>)}</tr></thead>
                <tbody>{lines.map((line) => {
                  const key = `${selectedStocktakeId}:${line.item_id}`;
                  const countText = countValues[key] ?? (line.counted_quantity == null ? "" : String(line.counted_quantity));
                  const countValue = countText.trim() === "" ? NaN : Number(countText);
                  const variance = Number.isFinite(countValue) ? countValue - Number(line.system_quantity) : null;
                  const canEditLine = selectedStocktake.status === "counting" && canManageStocktakes;
                  return <tr key={line.item_id} className="border-t align-top">
                    <td className="p-3"><span className="font-medium">{line.item_name}</span><span className="block text-xs text-muted-foreground">{line.sku || "—"}</span></td>
                    <td className="p-3 whitespace-nowrap">{line.base_unit}</td>
                    <td className="p-3 whitespace-nowrap tabular-nums">{qty(line.system_quantity)}</td>
                    <td className="p-3 whitespace-nowrap tabular-nums">{money(line.system_value)}</td>
                    <td className="p-3 whitespace-nowrap tabular-nums">{money(line.system_unit_cost)}</td>
                    <td className="p-3"><Input disabled={!canEditLine} type="number" min="0" step="0.001" className="min-w-[120px]" value={countText} onChange={(event) => setCountValues((current) => ({ ...current, [key]: event.target.value }))} aria-label={`الكمية المعدودة: ${line.item_name}`} /></td>
                    <td className="p-3"><Input disabled={!canEditLine} type="number" min="0" step="0.0001" className="min-w-[120px]" value={countCosts[key] ?? (line.counted_unit_cost == null ? "" : String(line.counted_unit_cost))} onChange={(event) => setCountCosts((current) => ({ ...current, [key]: event.target.value }))} aria-label={`تكلفة كمية الزيادة: ${line.item_name}`} placeholder={Number(line.system_quantity) > 0 ? "تلقائي من المتوسط" : "مطلوب للزيادة"} /></td>
                    <td className={`p-3 whitespace-nowrap font-semibold tabular-nums ${variance == null ? "text-muted-foreground" : variance === 0 ? "text-emerald-600" : variance < 0 ? "text-destructive" : "text-amber-600"}`}>{variance == null ? "—" : `${variance > 0 ? "+" : ""}${qty(variance)}`}</td>
                    <td className="p-3"><Input disabled={!canEditLine} maxLength={500} className="min-w-[170px]" value={countNotes[key] ?? line.count_notes ?? ""} onChange={(event) => setCountNotes((current) => ({ ...current, [key]: event.target.value }))} placeholder="ملاحظة مختصرة" /></td>
                    <td className="p-3">{canEditLine ? <Button type="button" size="sm" variant="outline" disabled={recordCount.isPending || !countText.trim()} onClick={() => saveLine(line)}>{recordCount.isPending && recordCount.variables?.itemId === Number(line.item_id) ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : null} حفظ العد</Button> : <span className="text-xs text-muted-foreground">{line.counted_at ? `حُفظ ${new Date(line.counted_at).toLocaleDateString("ar-PS")}` : "—"}</span>}</td>
                  </tr>;
                })}</tbody>
              </table>
            </div>}
          <div className="mt-3 flex flex-wrap gap-3 text-xs text-muted-foreground">
            <span>الأصناف المعدودة: {countedCount} / {itemCount}</span>
            <span>عدد الفروقات: {varianceCount}</span>
            <span>الكمية الصافية للفرق: {qty(selectedStocktake.variance_quantity)}</span>
          </div>
          {selectedStocktake.status === "submitted" ? <p className="mt-3 rounded-md border p-3 text-sm text-muted-foreground">أرسلت هذه الجلسة للاعتماد؛ تُراجع فروقاتها قبل الترحيل. إذا تغيّر الرصيد منذ اللقطة، سيرفض الخادم الترحيل ويجب فتح جلسة جديدة.</p> : null}
          {selectedStocktake.status === "posted" ? <p className="mt-3 rounded-md border p-3 text-sm text-muted-foreground">تم ترحيل الفروقات إلى سجل حركات المخزون كحركات تسوية مرتبطة برقم الجرد. إعادة المحاولة لا تنشئ حركات مكررة.</p> : null}
        </CardContent>
      </Card> : null}
    </div>
  );
}
