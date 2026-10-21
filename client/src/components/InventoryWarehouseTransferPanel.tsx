import { useEffect, useState, type FormEvent } from "react";
import { ArrowLeftRight, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";

type Props = { siteId: number; isAuthenticated: boolean; canAdjustInventory: boolean };
function operationKey() {
  const id = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID() : String(Date.now()) + "-" + Math.random().toString(36).slice(2);
  return "stock-transfer:" + id;
}

export default function InventoryWarehouseTransferPanel({ siteId, isAuthenticated, canAdjustInventory }: Props) {
  const utils = trpc.useUtils();
  const warehouses = trpc.powerhub.inventory.listWarehouses.useQuery(
    { siteId }, { enabled: Boolean(siteId && isAuthenticated), staleTime: 30_000 },
  );
  const items = trpc.powerhub.inventory.listItems.useQuery(
    { siteId }, { enabled: Boolean(siteId && isAuthenticated && canAdjustInventory), staleTime: 30_000 },
  );
  const [itemId, setItemId] = useState("");
  const [sourceWarehouseId, setSourceWarehouseId] = useState("");
  const [destinationWarehouseId, setDestinationWarehouseId] = useState("");
  const [quantity, setQuantity] = useState("");
  const [referenceNo, setReferenceNo] = useState("");
  const [notes, setNotes] = useState("");
  const [key, setKey] = useState(operationKey);
  useEffect(() => {
    if (!items.data?.some((item) => String(item.id) === itemId) && items.data?.[0]) setItemId(String(items.data[0].id));
  }, [items.data, itemId]);
  useEffect(() => {
    const rows = warehouses.data ?? [];
    if (!rows.some((warehouse) => String(warehouse.id) === sourceWarehouseId) && rows[0]) setSourceWarehouseId(String(rows[0].id));
    if (!rows.some((warehouse) => String(warehouse.id) === destinationWarehouseId) && rows.length > 1) {
      setDestinationWarehouseId(String(rows.find((warehouse) => String(warehouse.id) !== sourceWarehouseId)?.id ?? rows[1].id));
    }
  }, [warehouses.data, sourceWarehouseId, destinationWarehouseId]);

  const transfer = trpc.powerhub.inventory.transferStock.useMutation({
    onSuccess: async (result) => {
      toast.success(result.replayed
        ? "تم التحقق من التحويل السابق دون تكرار الحركة."
        : "تم التحويل بنجاح؛ رقم العملية " + result.transfer_id + "، والتكلفة " +
          Number(result.total_cost_amount ?? 0).toLocaleString("ar-PS", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ".");
      setQuantity(""); setReferenceNo(""); setNotes(""); setKey(operationKey());
      await Promise.all([
        utils.powerhub.inventory.stockOverview.invalidate({ siteId }),
        utils.powerhub.inventory.listStockMovements.invalidate({ siteId }),
      ]);
    },
    onError: (error) => toast.error(error.message || "تعذر تنفيذ التحويل المخزني."),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!itemId || !sourceWarehouseId || !destinationWarehouseId || sourceWarehouseId === destinationWarehouseId) {
      toast.error("اختر الصنف ومخزنين مختلفين."); return;
    }
    const parsedQuantity = Number(quantity);
    if (!Number.isFinite(parsedQuantity) || parsedQuantity <= 0 || Math.abs(parsedQuantity * 1000 - Math.round(parsedQuantity * 1000)) > 1e-7) {
      toast.error("أدخل كمية موجبة لا تتجاوز ثلاث منازل عشرية."); return;
    }
    transfer.mutate({
      siteId, itemId: Number(itemId), sourceWarehouseId: Number(sourceWarehouseId),
      destinationWarehouseId: Number(destinationWarehouseId), quantity: parsedQuantity, operationKey: key,
      referenceNo: referenceNo.trim() || undefined, notes: notes.trim() || undefined,
    });
  };

  return <Card>
    <CardHeader className="flex flex-row items-center gap-3 space-y-0">
      <ArrowLeftRight className="h-5 w-5" />
      <div><CardTitle>تحويل بين المخازن</CardTitle>
        <p className="mt-1 text-sm text-muted-foreground">ينقل الكمية والتكلفة في معاملة واحدة مع حفظ حركتي الصرف والإضافة وسجل التدقيق.</p>
      </div>
    </CardHeader>
    <CardContent>
      {!canAdjustInventory ? <p className="text-sm text-muted-foreground">تحتاج إلى صلاحية تسوية المخزون لتنفيذ التحويل.</p>
        : <form className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3" onSubmit={submit}>
          <label className="grid gap-1.5 text-sm">الصنف *
            <select className="h-10 rounded-md border border-input bg-background px-3 text-sm" required value={itemId} onChange={(e) => setItemId(e.target.value)}>
              <option value="">اختر الصنف</option>
              {(items.data ?? []).map((item) => <option key={item.id} value={item.id}>{item.name}{item.sku ? " (" + item.sku + ")" : ""}</option>)}
            </select>
          </label>
          <label className="grid gap-1.5 text-sm">من المخزن *
            <select className="h-10 rounded-md border border-input bg-background px-3 text-sm" required value={sourceWarehouseId} onChange={(e) => setSourceWarehouseId(e.target.value)}>
              <option value="">اختر المخزن المصدر</option>
              {(warehouses.data ?? []).map((warehouse) => <option key={warehouse.id} value={warehouse.id}>{warehouse.name} ({warehouse.code})</option>)}
            </select>
          </label>
          <label className="grid gap-1.5 text-sm">إلى المخزن *
            <select className="h-10 rounded-md border border-input bg-background px-3 text-sm" required value={destinationWarehouseId} onChange={(e) => setDestinationWarehouseId(e.target.value)}>
              <option value="">اختر المخزن المستلم</option>
              {(warehouses.data ?? []).filter((warehouse) => String(warehouse.id) !== sourceWarehouseId).map((warehouse) => <option key={warehouse.id} value={warehouse.id}>{warehouse.name} ({warehouse.code})</option>)}
            </select>
          </label>
          <label className="grid gap-1.5 text-sm">الكمية *
            <Input type="number" required min="0.001" step="0.001" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
          </label>
          <label className="grid gap-1.5 text-sm">رقم المرجع
            <Input maxLength={120} value={referenceNo} onChange={(e) => setReferenceNo(e.target.value)} placeholder="رقم إذن التحويل" />
          </label>
          <label className="grid gap-1.5 text-sm">ملاحظات
            <Input maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="سبب أو تفاصيل التحويل" />
          </label>
          <div className="md:col-span-2 xl:col-span-3 rounded-md bg-muted/40 p-3 text-sm text-muted-foreground">
            تُحتسب التكلفة من قيمة المخزون المصدر، وتُسجّل الحركتان معًا أو لا تُسجّل أي منهما. لا يمكن التحويل عند نقص الرصيد أو إغلاق الفترة المالية.
          </div>
          <div><Button type="submit" disabled={transfer.isPending || warehouses.isLoading || items.isLoading || !itemId ||
            !sourceWarehouseId || !destinationWarehouseId || sourceWarehouseId === destinationWarehouseId}>
            {transfer.isPending ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <ArrowLeftRight className="ml-2 h-4 w-4" />}
            تأكيد التحويل
          </Button></div>
        </form>}
    </CardContent>
  </Card>;
}
