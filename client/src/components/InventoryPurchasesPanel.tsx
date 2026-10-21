import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import { CheckCircle2, ClipboardList, Eye, FilePlus2, Loader2, PackageCheck, Plus, RotateCcw, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";

type DraftLine = {
  key: string;
  itemId: string;
  quantity: string;
  unit: string;
  unitsToBaseFactor: string;
  unitPrice: string;
  discountAmount: string;
  taxAmount: string;
  notes: string;
};

type InventoryPurchasesPanelProps = {
  siteId: number;
  isAuthenticated: boolean;
  canViewPurchases: boolean;
  canViewFinancials: boolean;
  canCreatePurchases: boolean;
  canApprovePurchases: boolean;
  canReceiveInventory: boolean;
  canAdjustInventory: boolean;
  canManageSupplierPayments: boolean;
};

const selectClass = "h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground";
const inputGridClass = "grid gap-1.5 text-sm";
const accountTypeLabels: Record<string, string> = {
  cash: "نقدي", jawwal_pay: "جوال باي", palpay: "بال باي", bank_of_palestine: "بنك فلسطين", other: "أخرى",
};
const statusLabels: Record<string, string> = {
  draft: "مسودة",
  confirmed: "معتمدة — بانتظار الاستلام",
  partially_received: "استلام جزئي",
  received: "مستلمة بالكامل",
  cancelled: "ملغاة",
};

function operationKey(prefix: string) {
  const token = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}:${token}`;
}

function todayForInput() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

function getOrCreateOperationKey(storageKey: string, prefix: string) {
  if (typeof window === "undefined") return operationKey(prefix);
  try {
    const existing = window.sessionStorage.getItem(storageKey);
    if (existing) return existing;
    const created = operationKey(prefix);
    window.sessionStorage.setItem(storageKey, created);
    return created;
  } catch {
    return operationKey(prefix);
  }
}

function clearOperationKey(storageKey: string) {
  if (typeof window === "undefined") return;
  try { window.sessionStorage.removeItem(storageKey); } catch { /* storage may be blocked */ }
}

function emptyLine(firstItem?: { id: number; base_unit: string }): DraftLine {
  return {
    key: operationKey("purchase-line"),
    itemId: firstItem ? String(firstItem.id) : "",
    quantity: "1",
    unit: firstItem?.base_unit ?? "",
    unitsToBaseFactor: "1",
    unitPrice: "0",
    discountAmount: "0",
    taxAmount: "0",
    notes: "",
  };
}

function formatAmount(value: number | string | null | undefined) {
  const amount = Number(value ?? 0);
  return `₪${new Intl.NumberFormat("ar-PS", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number.isFinite(amount) ? amount : 0)}`;
}

function updateLine(lines: DraftLine[], key: string, patch: Partial<DraftLine>) {
  return lines.map((line) => line.key === key ? { ...line, ...patch } : line);
}

export default function InventoryPurchasesPanel({
  siteId,
  isAuthenticated,
  canViewPurchases,
  canViewFinancials,
  canCreatePurchases,
  canApprovePurchases,
  canReceiveInventory,
  canAdjustInventory,
  canManageSupplierPayments,
}: InventoryPurchasesPanelProps) {
  const [search, setSearch] = useState("");
  const [selectedPurchaseId, setSelectedPurchaseId] = useState<number | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [supplierId, setSupplierId] = useState("");
  const [warehouseId, setWarehouseId] = useState("");
  const [supplierInvoiceNo, setSupplierInvoiceNo] = useState("");
  const [invoiceDate, setInvoiceDate] = useState(todayForInput);
  const [dueDate, setDueDate] = useState("");
  const [paymentTermsDays, setPaymentTermsDays] = useState("");
  const [referenceNo, setReferenceNo] = useState("");
  const [purchaseNotes, setPurchaseNotes] = useState("");
  const createOperationStorageKey = `powerhub:inventory:${siteId}:purchase-create`;
  const [createOperationKey, setCreateOperationKey] = useState(() => getOrCreateOperationKey(createOperationStorageKey, "purchase-create"));
  const [draftLines, setDraftLines] = useState<DraftLine[]>([emptyLine()]);
  const [receiptDate, setReceiptDate] = useState(todayForInput);
  const [receiptNotes, setReceiptNotes] = useState("");

  const [receiptQuantities, setReceiptQuantities] = useState<Record<number, string>>({});
  const [returnQuantities, setReturnQuantities] = useState<Record<number, string>>({});
  const [returnDate, setReturnDate] = useState(todayForInput);
  const [returnReason, setReturnReason] = useState("");
  const [returnNotes, setReturnNotes] = useState("");
  const [returnRefundAmount, setReturnRefundAmount] = useState("0");
  const [returnRefundAccountId, setReturnRefundAccountId] = useState("");
  const [paymentAmount, setPaymentAmount] = useState("");
  const [companyAccountId, setCompanyAccountId] = useState("");
  const [paymentDate, setPaymentDate] = useState(todayForInput);
  const [paymentReferenceNo, setPaymentReferenceNo] = useState("");
  const [paymentNotes, setPaymentNotes] = useState("");
  const [paymentReversalReasons, setPaymentReversalReasons] = useState<Record<number, string>>({});
  const [purchaseCancellationReason, setPurchaseCancellationReason] = useState("");

  const utils = trpc.useUtils();
  const purchases = trpc.powerhub.inventory.listPurchases.useQuery(
    { siteId, search: search.trim() || undefined },
    { enabled: Boolean(siteId && isAuthenticated && canViewPurchases), staleTime: 15_000 },
  );
  const options = trpc.powerhub.inventory.listPurchaseOptions.useQuery(
    { siteId },
    { enabled: Boolean(siteId && isAuthenticated && canCreatePurchases), staleTime: 30_000 },
  );
  const paymentOptions = trpc.powerhub.inventory.listSupplierPaymentOptions.useQuery(
    { siteId },
    { enabled: Boolean(siteId && isAuthenticated && canManageSupplierPayments), staleTime: 15_000 },
  );
  const details = trpc.powerhub.inventory.getPurchase.useQuery(
    { siteId, purchaseId: selectedPurchaseId ?? 0 },
    { enabled: Boolean(siteId && isAuthenticated && canViewPurchases && selectedPurchaseId), staleTime: 10_000 },
  );

  useEffect(() => {
    const firstSupplier = options.data?.suppliers[0];
    const firstWarehouse = options.data?.warehouses[0];
    const firstItem = options.data?.items[0];
    if (firstSupplier) {
      setSupplierId((current) => options.data?.suppliers.some((supplier) => String(supplier.id) === current) ? current : String(firstSupplier.id));
    }
    if (firstWarehouse) {
      setWarehouseId((current) => options.data?.warehouses.some((warehouse) => String(warehouse.id) === current) ? current : String(firstWarehouse.id));
    }
    if (firstItem) {
      setDraftLines((current) => current.map((line) => line.itemId ? line : { ...line, itemId: String(firstItem.id), unit: firstItem.base_unit }));
    }
  }, [options.data]);

  useEffect(() => {
    const accounts = paymentOptions.data ?? [];
    if (!accounts.length) return;
    setCompanyAccountId((current) => accounts.some((account) => String(account.id) === current) ? current : String(accounts[0].id));
  }, [paymentOptions.data]);

  useEffect(() => {
    const outstanding = details.data?.purchase.outstandingAmount;
    if (outstanding === null || outstanding === undefined || !Number.isFinite(Number(outstanding))) return;
    setPaymentAmount((current) => !current.trim() || Number(current) > Number(outstanding) ? Number(outstanding).toFixed(2) : current);
  }, [details.data?.purchase.id, details.data?.purchase.paidAmount, details.data?.purchase.outstandingAmount]);

  useEffect(() => {
    const lines = details.data?.lines;
    if (!lines) return;
    setReceiptQuantities(Object.fromEntries(lines.map((line) => [
      Number(line.id),
      String(Math.max(0, Number(line.quantity) - Number(line.received_quantity))),
    ])));
  }, [details.data?.purchase.id, details.data?.purchase.updated_at]);
  
  useEffect(() => {
    const lines = details.data?.lines;
    const returns = details.data?.returns ?? [];
    if (!lines) return;
    // Never preselect a return quantity: a destructive stock operation must require an explicit choice.
    setReturnQuantities(Object.fromEntries(lines.map((line) => [Number(line.id), "0"])));
  }, [details.data?.purchase.id, details.data?.purchase.updated_at, details.data?.returns]);

  const previewTotal = useMemo(() => draftLines.reduce((sum, line) => {
    const quantity = Number(line.quantity);
    const price = Number(line.unitPrice);
    const subtotal = Math.round(quantity * price * 100) / 100;
    return sum + subtotal - Number(line.discountAmount || 0) + Number(line.taxAmount || 0);
  }, 0), [draftLines]);

  const refreshPurchaseData = async (purchaseId?: number) => {
    await Promise.all([
      utils.powerhub.inventory.listPurchases.invalidate(),
      utils.powerhub.inventory.getPurchase.invalidate(purchaseId ? { siteId, purchaseId } : undefined),
    ]);
  };

  const createPurchase = trpc.powerhub.inventory.createPurchase.useMutation({
    onSuccess: async (result) => {
      toast.success(`تم إنشاء مسودة المشتريات ${result.purchase_number}.`);
      setSelectedPurchaseId(Number(result.purchase_id));
      setCreateOpen(false);
      setSupplierInvoiceNo("");
      setInvoiceDate(todayForInput());
      setDueDate("");
      setPaymentTermsDays("");
      setReferenceNo("");
      setPurchaseNotes("");
      setDraftLines([emptyLine(options.data?.items[0])]);
      clearOperationKey(createOperationStorageKey);
      setCreateOperationKey(getOrCreateOperationKey(createOperationStorageKey, "purchase-create"));
      await refreshPurchaseData(Number(result.purchase_id));
    },
    onError: (error) => toast.error(error.message || "تعذر إنشاء فاتورة المشتريات."),
  });

  const confirmPurchase = trpc.powerhub.inventory.confirmPurchase.useMutation({
    onSuccess: async (result) => {
      toast.success(result.replayed ? "الفاتورة معتمدة مسبقًا." : "تم اعتماد فاتورة المشتريات وتسجيل استحقاق المورد.");
      await refreshPurchaseData(Number(result.purchase_id));
    },
    onError: (error) => toast.error(error.message || "تعذر اعتماد فاتورة المشتريات."),
  });

  const receivePurchase = trpc.powerhub.inventory.receivePurchase.useMutation({
    onSuccess: async (result) => {
      toast.success(result.replayed ? "تم التحقق من عملية الاستلام السابقة دون تكرار الحركة." : `تم تسجيل الاستلام ${result.receipt_number}.`);
      setReceiptNotes("");
      setReceiptDate(todayForInput());
      clearOperationKey(`powerhub:inventory:${siteId}:purchase:${Number(result.purchase_id)}:receipt`);
      await refreshPurchaseData(Number(result.purchase_id));
    },
    onError: (error) => toast.error(error.message || "تعذر تسجيل الاستلام."),
  });


  const cancelPurchase = trpc.powerhub.inventory.cancelPurchase.useMutation({
    onSuccess: async (result) => {
      toast.success(result.replayed ? "الفاتورة ملغاة مسبقًا." : "تم إلغاء فاتورة المشتريات وتسجيل عكس الاستحقاق عند الحاجة.");
      setPurchaseCancellationReason("");
      await refreshPurchaseData(Number(result.purchase_id));
    },
    onError: (error) => toast.error(error.message || "تعذر إلغاء فاتورة المشتريات."),
  });

  const returnToSupplier = trpc.powerhub.inventory.returnToSupplier.useMutation({
    onSuccess: async (result) => {
      toast.success(result.replayed
        ? "تم التحقق من مرتجع المورد السابق دون تكرار."
        : `تم تسجيل المرتجع ${result.return_number}. رصيد المورد الدائن المتبقي: ${formatAmount(result.supplier_credit_remaining)}.`);
      setReturnReason("");
      setReturnNotes("");
      setReturnRefundAmount("0");
      setReturnRefundAccountId("");
      setReturnDate(todayForInput());
      clearOperationKey(`powerhub:inventory:${siteId}:purchase:${Number(result.purchase_id)}:return`);
      await Promise.all([
        refreshPurchaseData(Number(result.purchase_id)),
        utils.powerhub.inventory.stockOverview.invalidate({ siteId }),
        utils.powerhub.inventory.listStockMovements.invalidate({ siteId, limit: 100 }),
        utils.powerhub.inventory.listSupplierPaymentOptions.invalidate({ siteId }),
      ]);
    },
    onError: (error) => toast.error(error.message || "تعذر تسجيل مرتجع المورد."),
  });

  const reverseSupplierPayment = trpc.powerhub.inventory.reverseSupplierPayment.useMutation({
    onSuccess: async (result) => {
      toast.success(result.replayed ? "تم التحقق من أن الدفعة معكوسة مسبقًا." : "تم عكس دفعة المورد وإعادة المبلغ إلى حساب الشركة.");
      setPaymentReversalReasons((current) => ({ ...current, [Number(result.payment_id)]: "" }));
      await Promise.all([
        refreshPurchaseData(Number(result.purchase_id)),
        utils.powerhub.inventory.listSupplierPaymentOptions.invalidate({ siteId }),
      ]);
    },
    onError: (error) => toast.error(error.message || "تعذر عكس دفعة المورد."),
  });

  const recordSupplierPayment = trpc.powerhub.inventory.recordSupplierPayment.useMutation({
    onSuccess: async (result) => {
      toast.success(result.replayed ? "تم التحقق من الدفعة السابقة دون خصم مكرر." : `تم تسجيل دفعة المورد بقيمة ${formatAmount(result.amount)}.`);
      setPaymentReferenceNo("");
      setPaymentNotes("");
      setPaymentDate(todayForInput());
      setPaymentAmount("");
      clearOperationKey(`powerhub:inventory:${siteId}:purchase:${Number(result.purchase_id)}:payment`);
      await Promise.all([
        refreshPurchaseData(Number(result.purchase_id)),
        utils.powerhub.inventory.listSupplierPaymentOptions.invalidate({ siteId }),
      ]);
    },
    onError: (error) => toast.error(error.message || "تعذر تسجيل دفعة المورد."),
  });

  const onCreateSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!supplierId || !warehouseId) {
      toast.error("اختر المورد والمخزن قبل حفظ الفاتورة.");
      return;
    }
    const lines = draftLines.map((line) => ({
      itemId: Number(line.itemId),
      quantity: Number(line.quantity),
      unit: line.unit.trim(),
      unitsToBaseFactor: Number(line.unitsToBaseFactor),
      unitPrice: Number(line.unitPrice),
      discountAmount: Number(line.discountAmount || 0),
      taxAmount: Number(line.taxAmount || 0),
      notes: line.notes.trim() || undefined,
    }));
    if (lines.some((line) => !line.itemId || !Number.isFinite(line.quantity) || line.quantity <= 0
      || !line.unit || !Number.isFinite(line.unitsToBaseFactor) || line.unitsToBaseFactor <= 0
      || !Number.isFinite(line.unitPrice) || line.unitPrice < 0
      || line.discountAmount < 0 || line.taxAmount < 0
      || line.discountAmount > Math.round(line.quantity * line.unitPrice * 100) / 100)) {
      toast.error("راجع الصنف والكمية والتحويل والسعر والخصم والضريبة في كل بند.");
      return;
    }
    const terms = paymentTermsDays.trim() ? Number(paymentTermsDays) : undefined;
    if (terms !== undefined && (!Number.isInteger(terms) || terms < 0 || terms > 3650)) {
      toast.error("مدة السداد يجب أن تكون عدد أيام صحيحًا بين 0 و3650.");
      return;
    }
    createPurchase.mutate({
      siteId,
      supplierId: Number(supplierId),
      warehouseId: Number(warehouseId),
      supplierInvoiceNo: supplierInvoiceNo.trim() || undefined,
      invoiceDate: invoiceDate || undefined,
      dueDate: dueDate || undefined,
      paymentTermsDays: terms,
      referenceNo: referenceNo.trim() || undefined,
      notes: purchaseNotes.trim() || undefined,
      operationKey: createOperationKey,
      lines,
    });
  };

  const onSupplierPaymentSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedPurchaseId || !details.data) return;
    const amount = Number(paymentAmount);
    const outstanding = Number(details.data.purchase.outstandingAmount ?? 0);
    const account = paymentOptions.data?.find((row) => String(row.id) === companyAccountId);
    if (!account) {
      toast.error("اختر حساب شركة نشطًا ومتاحًا لهذا الفرع.");
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0 || Math.abs(amount * 100 - Math.round(amount * 100)) >= 1e-7) {
      toast.error("أدخل مبلغًا موجبًا وبحد أقصى منزلتين عشريتين.");
      return;
    }
    if (amount > outstanding) {
      toast.error("مبلغ الدفعة يتجاوز المتبقي من فاتورة المشتريات.");
      return;
    }
    if (amount > Number(account.balance)) {
      toast.error("رصيد الحساب المحدد لا يكفي لهذه الدفعة.");
      return;
    }
    const storageKey = `powerhub:inventory:${siteId}:purchase:${selectedPurchaseId}:payment`;
    recordSupplierPayment.mutate({
      siteId,
      purchaseId: selectedPurchaseId,
      companyAccountId: Number(companyAccountId),
      amount,
      paymentDate: paymentDate || undefined,
      referenceNo: paymentReferenceNo.trim() || undefined,
      notes: paymentNotes.trim() || undefined,
      operationKey: getOrCreateOperationKey(storageKey, "supplier-payment"),
    });
  };

  const onReturnSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedPurchaseId || !details.data) return;
    const lines = details.data.lines
      .map((line) => ({ purchaseLineId: Number(line.id), quantity: Number(returnQuantities[Number(line.id)] ?? 0) }))
      .filter((line) => Number.isFinite(line.quantity) && line.quantity > 0);
    if (!lines.length) {
      toast.error("أدخل كمية واحدة على الأقل لإرجاعها للمورد.");
      return;
    }
    if (returnReason.trim().length < 3) {
      toast.error("أدخل سببًا واضحًا للمرتجع.");
      return;
    }
    const refundAmount = Number(returnRefundAmount || 0);
    if (!Number.isFinite(refundAmount) || refundAmount < 0 || Math.abs(refundAmount * 100 - Math.round(refundAmount * 100)) >= 1e-7) {
      toast.error("مبلغ الاسترداد يجب أن يكون صفرًا أو موجبًا وبحد أقصى منزلتين عشريتين.");
      return;
    }
    if (refundAmount > 0 && !returnRefundAccountId) {
      toast.error("اختر حساب الشركة الذي سيستقبل المبلغ المسترد.");
      return;
    }
    const storageKey = `powerhub:inventory:${siteId}:purchase:${selectedPurchaseId}:return`;
    returnToSupplier.mutate({
      siteId,
      purchaseId: selectedPurchaseId,
      returnDate: returnDate || undefined,
      operationKey: getOrCreateOperationKey(storageKey, "supplier-return"),
      reason: returnReason.trim(),
      notes: returnNotes.trim() || undefined,
      refundAmount,
      refundCompanyAccountId: refundAmount > 0 ? Number(returnRefundAccountId) : undefined,
      lines,
    });
  };

  const onReceiveSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedPurchaseId || !details.data) return;
    const lines = details.data.lines
      .map((line) => ({ purchaseLineId: Number(line.id), quantity: Number(receiptQuantities[Number(line.id)] ?? 0) }))
      .filter((line) => Number.isFinite(line.quantity) && line.quantity > 0);
    if (!lines.length) {
      toast.error("أدخل كمية واحدة على الأقل للاستلام.");
      return;
    }
    const remainingByLine = new Map(details.data.lines.map((line) => [
      Number(line.id),
      Number(line.quantity) - Number(line.received_quantity),
    ]));
    if (lines.some((line) => line.quantity > (remainingByLine.get(line.purchaseLineId) ?? 0))) {
      toast.error("إحدى الكميات أكبر من المتبقي؛ حدّث التفاصيل وراجع الأرقام.");
      return;
    }
    const receiptStorageKey = `powerhub:inventory:${siteId}:purchase:${selectedPurchaseId}:receipt`;
    const receiptKey = getOrCreateOperationKey(receiptStorageKey, "purchase-receipt");
    receivePurchase.mutate({
      siteId,
      purchaseId: selectedPurchaseId,
      receiptDate: receiptDate || undefined,
      operationKey: receiptKey,
      notes: receiptNotes.trim() || undefined,
      lines,
    });
  };

  if (!canViewPurchases) {
    return <Card><CardContent className="p-6 text-center text-muted-foreground">ليست لديك صلاحية عرض المشتريات.</CardContent></Card>;
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2"><ClipboardList className="h-5 w-5" /> فواتير المشتريات والاستلام</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">إنشاء المسودات، اعتمادها، ثم تسجيل الاستلام الفعلي دون زيادة المخزون عند إنشاء الفاتورة.</p>
          </div>
          {canCreatePurchases ? <Button onClick={() => setCreateOpen((open) => !open)}>
            <FilePlus2 className="ml-2 h-4 w-4" /> {createOpen ? "إغلاق نموذج الشراء" : "فاتورة مشتريات جديدة"}
          </Button> : null}
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="relative">
            <Search className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="ابحث برقم الفاتورة أو رقم فاتورة المورد أو المرجع" className="pr-9" />
          </div>

          {createOpen && canCreatePurchases ? (
            <form onSubmit={onCreateSubmit} className="space-y-4 rounded-lg border p-3 md:p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-semibold">مسودة مشتريات جديدة</h3>
                <p className="text-sm text-muted-foreground">لا تُضاف كميات إلى المخزون حتى تسجيل الاستلام.</p>
              </div>
              {options.isLoading ? <p className="py-4 text-center text-muted-foreground">جارٍ تحميل الموردين والمخازن والأصناف…</p> : null}
              {options.error ? <p className="text-sm text-destructive">تعذر تحميل خيارات المشتريات: {options.error.message}</p> : null}
              {!options.isLoading && options.data && (!options.data.suppliers.length || !options.data.warehouses.length || !options.data.items.length) ? (
                <p className="rounded-md bg-muted p-3 text-sm text-muted-foreground">تحتاج إلى مورد نشط ومخزن نشط وصنف واحد على الأقل قبل إنشاء فاتورة.</p>
              ) : null}
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <label className={inputGridClass}>المورد
                  <select className={selectClass} value={supplierId} onChange={(event) => setSupplierId(event.target.value)} required>
                    <option value="">اختر المورد</option>
                    {options.data?.suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}{supplier.supplier_code ? ` — ${supplier.supplier_code}` : ""}</option>)}
                  </select>
                </label>
                <label className={inputGridClass}>المخزن المستلم
                  <select className={selectClass} value={warehouseId} onChange={(event) => setWarehouseId(event.target.value)} required>
                    <option value="">اختر المخزن</option>
                    {options.data?.warehouses.map((warehouse) => <option key={warehouse.id} value={warehouse.id}>{warehouse.name} — {warehouse.code}</option>)}
                  </select>
                </label>
                <label className={inputGridClass}>رقم فاتورة المورد
                  <Input value={supplierInvoiceNo} onChange={(event) => setSupplierInvoiceNo(event.target.value)} maxLength={120} />
                </label>
                <label className={inputGridClass}>تاريخ الفاتورة
                  <Input type="date" value={invoiceDate} onChange={(event) => setInvoiceDate(event.target.value)} required />
                </label>
                <label className={inputGridClass}>تاريخ الاستحقاق (اختياري)
                  <Input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} min={invoiceDate || undefined} />
                </label>
                <label className={inputGridClass}>مدة السداد بالأيام
                  <Input type="number" min={0} max={3650} step={1} value={paymentTermsDays} onChange={(event) => setPaymentTermsDays(event.target.value)} placeholder="اتركها لاستخدام مدة المورد" />
                </label>
                <label className={inputGridClass}>المرجع
                  <Input value={referenceNo} onChange={(event) => setReferenceNo(event.target.value)} maxLength={120} />
                </label>
                <label className={inputGridClass + " sm:col-span-2"}>ملاحظات
                  <Input value={purchaseNotes} onChange={(event) => setPurchaseNotes(event.target.value)} maxLength={2000} />
                </label>
              </div>

              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h4 className="font-semibold">بنود الفاتورة</h4>
                  <Button type="button" variant="outline" size="sm" onClick={() => setDraftLines((lines) => [...lines, emptyLine(options.data?.items[0])])} disabled={(options.data?.items.length ?? 0) === 0 || draftLines.length >= 200}>
                    <Plus className="ml-1 h-4 w-4" /> إضافة بند
                  </Button>
                </div>
                {draftLines.map((line, index) => {
                  const selectedItem = options.data?.items.find((item) => String(item.id) === line.itemId);
                  const lineSubtotal = Math.round(Number(line.quantity || 0) * Number(line.unitPrice || 0) * 100) / 100;
                  const lineTotal = lineSubtotal - Number(line.discountAmount || 0) + Number(line.taxAmount || 0);
                  return (
                    <div key={line.key} className="space-y-3 rounded-md border p-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold">البند {index + 1}{selectedItem ? ` — ${selectedItem.name}` : ""}</span>
                        <Button type="button" size="icon" variant="ghost" aria-label="حذف البند" title="حذف البند" disabled={draftLines.length === 1} onClick={() => setDraftLines((lines) => lines.filter((candidate) => candidate.key !== line.key))}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                        <label className={inputGridClass}>الصنف
                          <select className={selectClass} value={line.itemId} onChange={(event) => {
                            const item = options.data?.items.find((candidate) => String(candidate.id) === event.target.value);
                            setDraftLines((lines) => updateLine(lines, line.key, { itemId: event.target.value, unit: item?.base_unit ?? "" }));
                          }} required>
                            <option value="">اختر الصنف</option>
                            {options.data?.items.map((item) => <option key={item.id} value={item.id}>{item.name}{item.sku ? ` — ${item.sku}` : ""}</option>)}
                          </select>
                        </label>
                        <label className={inputGridClass}>الكمية
                          <Input type="number" min="0.001" step="0.001" value={line.quantity} onChange={(event) => setDraftLines((lines) => updateLine(lines, line.key, { quantity: event.target.value }))} required />
                        </label>
                        <label className={inputGridClass}>وحدة الشراء
                          <Input value={line.unit} onChange={(event) => setDraftLines((lines) => updateLine(lines, line.key, { unit: event.target.value }))} maxLength={40} required />
                        </label>
                        <label className={inputGridClass}>كمية الوحدة الأساسية لكل وحدة شراء
                          <Input type="number" min="0.000001" step="0.000001" value={line.unitsToBaseFactor} onChange={(event) => setDraftLines((lines) => updateLine(lines, line.key, { unitsToBaseFactor: event.target.value }))} required />
                        </label>
                        <label className={inputGridClass}>سعر الوحدة
                          <Input type="number" min="0" step="0.0001" value={line.unitPrice} onChange={(event) => setDraftLines((lines) => updateLine(lines, line.key, { unitPrice: event.target.value }))} required />
                        </label>
                        <label className={inputGridClass}>الخصم
                          <Input type="number" min="0" step="0.01" value={line.discountAmount} onChange={(event) => setDraftLines((lines) => updateLine(lines, line.key, { discountAmount: event.target.value }))} />
                        </label>
                        <label className={inputGridClass}>الضريبة
                          <Input type="number" min="0" step="0.01" value={line.taxAmount} onChange={(event) => setDraftLines((lines) => updateLine(lines, line.key, { taxAmount: event.target.value }))} />
                        </label>
                        <label className={inputGridClass}>ملاحظات البند
                          <Input value={line.notes} onChange={(event) => setDraftLines((lines) => updateLine(lines, line.key, { notes: event.target.value }))} maxLength={1000} />
                        </label>
                      </div>
                      <div className="text-left text-sm text-muted-foreground">إجمالي البند: <span className="font-semibold text-foreground">{formatAmount(lineTotal)}</span></div>
                    </div>
                  );
                })}
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-muted/60 p-3">
                <p className="text-sm text-muted-foreground">المجموع التقديري — يُحسب نهائيًا في قاعدة البيانات</p>
                <p className="text-lg font-bold">{formatAmount(previewTotal)}</p>
              </div>
              <div className="flex flex-wrap justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>إلغاء</Button>
                <Button type="submit" disabled={createPurchase.isPending || options.isLoading || !options.data?.items.length || !options.data?.suppliers.length || !options.data?.warehouses.length}>
                  {createPurchase.isPending ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <FilePlus2 className="ml-2 h-4 w-4" />}
                  حفظ المسودة
                </Button>
              </div>
            </form>
          ) : null}

          {purchases.isLoading ? <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin" /><span className="mr-2 text-sm text-muted-foreground">جارٍ تحميل المشتريات…</span></div> : null}
          {purchases.error ? <p className="py-6 text-center text-sm text-destructive">تعذر تحميل المشتريات: {purchases.error.message}</p> : null}
          {!purchases.isLoading && !purchases.error && !purchases.data?.length ? (
            <div className="rounded-lg border border-dashed p-8 text-center">
              <ClipboardList className="mx-auto mb-2 h-8 w-8 text-muted-foreground" />
              <p className="font-semibold">لا توجد فواتير مشتريات مطابقة</p>
              <p className="mt-1 text-sm text-muted-foreground">إنشاء المسودة لا يغيّر المخزون؛ الكميات تدخل عند تأكيد الاستلام.</p>
            </div>
          ) : null}
          {purchases.data?.length ? (
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full min-w-[850px] text-right text-sm">
                <thead className="bg-muted/60"><tr>{(canViewFinancials ? ["رقم الفاتورة","المورد","المخزن","التاريخ","الاستحقاق","الحالة","الإجمالي","التفاصيل"] : ["رقم الفاتورة","المورد","المخزن","التاريخ","الحالة","التفاصيل"]).map((label) => <th key={label} className="p-3 font-semibold">{label}</th>)}</tr></thead>
                <tbody>
                  {purchases.data.map((purchase) => (
                    <tr key={purchase.id} className={"border-t " + (selectedPurchaseId === Number(purchase.id) ? "bg-muted/40" : "")}>
                      <td className="p-3 font-medium">{purchase.purchase_number}{canViewFinancials ? <div className="text-xs text-muted-foreground">{purchase.supplier_invoice_no || "—"}</div> : null}</td>
                      <td className="p-3">{purchase.supplierName}</td>
                      <td className="p-3">{purchase.warehouseName}</td>
                      <td className="p-3 whitespace-nowrap">{purchase.invoice_date}</td>
                      {canViewFinancials ? <><td className="p-3 whitespace-nowrap">{purchase.due_date || "—"}</td><td className="p-3">{statusLabels[purchase.status] ?? purchase.status}</td><td className="p-3 whitespace-nowrap font-semibold">{formatAmount(purchase.total_amount)}</td></> : <td className="p-3">{statusLabels[purchase.status] ?? purchase.status}</td>}
                      <td className="p-3"><Button type="button" variant="outline" size="sm" onClick={() => setSelectedPurchaseId(Number(purchase.id))}><Eye className="ml-1 h-4 w-4" /> فتح</Button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {selectedPurchaseId ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center justify-between gap-2">
              <span>تفاصيل فاتورة المشتريات</span>
              <Button type="button" size="sm" variant="ghost" onClick={() => setSelectedPurchaseId(null)}>إغلاق التفاصيل</Button>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {details.isLoading ? <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin" /></div> : null}
            {details.error ? <p className="text-sm text-destructive">تعذر تحميل التفاصيل: {details.error.message}</p> : null}
            {details.data ? (
              <>
                <div className="grid gap-3 rounded-md border p-3 sm:grid-cols-2 lg:grid-cols-4">
                  <div><p className="text-xs text-muted-foreground">رقم الفاتورة</p><p className="font-semibold">{details.data.purchase.purchase_number}</p></div>
                  <div><p className="text-xs text-muted-foreground">المورد</p><p className="font-semibold">{details.data.purchase.supplierName}</p></div>
                  <div><p className="text-xs text-muted-foreground">المخزن</p><p className="font-semibold">{details.data.purchase.warehouseName}</p></div>
                  <div><p className="text-xs text-muted-foreground">الحالة</p><p className="font-semibold">{statusLabels[details.data.purchase.status] ?? details.data.purchase.status}</p></div>
                  <div><p className="text-xs text-muted-foreground">تاريخ الفاتورة</p><p>{details.data.purchase.invoice_date}</p></div>
                  {canViewFinancials ? <><div><p className="text-xs text-muted-foreground">الإجمالي</p><p className="text-lg font-bold">{formatAmount(details.data.purchase.total_amount)}</p></div><div><p className="text-xs text-muted-foreground">الاستحقاق</p><p>{details.data.purchase.due_date || "—"}</p></div><div><p className="text-xs text-muted-foreground">المرجع</p><p>{details.data.purchase.reference_no || "—"}</p></div><div><p className="text-xs text-muted-foreground">إجمالي المدفوع</p><p className="font-semibold">{formatAmount(details.data.purchase.paidAmount)}</p></div><div><p className="text-xs text-muted-foreground">المتبقي</p><p className="text-lg font-bold">{formatAmount(details.data.purchase.outstandingAmount)}</p></div></> : null}
                </div>
                <div className="overflow-x-auto rounded-md border">
                  <table className="w-full min-w-[850px] text-right text-sm">
                    <thead className="bg-muted/60"><tr>{(canViewFinancials ? ["الصنف","الكمية المطلوبة","المستلم","المتبقي","الوحدة","سعر الوحدة","الخصم","الضريبة","الإجمالي"] : ["الصنف","الكمية المطلوبة","المستلم","المتبقي","الوحدة"]).map((label) => <th key={label} className="p-3 font-semibold">{label}</th>)}</tr></thead>
                    <tbody>{details.data.lines.map((line) => (
                      <tr key={line.id} className="border-t">
                        <td className="p-3 font-medium">{line.itemName}{line.itemSku ? <div className="text-xs text-muted-foreground">{line.itemSku}</div> : null}</td>
                        <td className="p-3">{Number(line.quantity).toLocaleString("ar-PS", { maximumFractionDigits: 3 })}</td>
                        <td className="p-3">{Number(line.received_quantity).toLocaleString("ar-PS", { maximumFractionDigits: 3 })}</td>
                        <td className="p-3 font-semibold">{Math.max(0, Number(line.quantity) - Number(line.received_quantity)).toLocaleString("ar-PS", { maximumFractionDigits: 3 })}</td>
                        <td className="p-3">{line.unit}</td>
                        {canViewFinancials ? <><td className="p-3 whitespace-nowrap">{formatAmount(line.unit_price)}</td><td className="p-3 whitespace-nowrap">{formatAmount(line.discount_amount)}</td><td className="p-3 whitespace-nowrap">{formatAmount(line.tax_amount)}</td><td className="p-3 whitespace-nowrap font-semibold">{formatAmount(line.line_total)}</td></> : null}
                      </tr>
                    ))}</tbody>
                  </table>
                </div>

                {details.data.returns.length ? (
                  <div className="space-y-2">
                    <h4 className="font-semibold">سجل مرتجعات المورد</h4>
                    <div className="overflow-x-auto rounded-md border">
                      <table className="w-full min-w-[760px] text-right text-sm">
                        <thead className="bg-muted/60"><tr>{["رقم المرتجع","التاريخ","السبب","البنود",...(canViewFinancials ? ["قيمة تخفيض المورد","المسترد نقدًا","رصيد دائن متبقٍ"] : [])].map((label) => <th key={label} className="p-3 font-semibold">{label}</th>)}</tr></thead>
                        <tbody>{details.data.returns.map((supplierReturn) => (
                          <tr key={supplierReturn.id} className="border-t align-top">
                            <td className="p-3 font-medium">{supplierReturn.return_number}</td>
                            <td className="p-3">{supplierReturn.return_date}</td>
                            <td className="p-3">{supplierReturn.reason}{supplierReturn.notes ? <span className="block text-xs text-muted-foreground">{supplierReturn.notes}</span> : null}</td>
                            <td className="p-3">{supplierReturn.lines.map((line) => <div key={line.id}>{line.itemName}: {Number(line.quantity).toLocaleString("ar-PS", { maximumFractionDigits: 3 })} {line.unit}</div>)}</td>
                            {canViewFinancials ? <><td className="p-3 whitespace-nowrap">{formatAmount(supplierReturn.total_credit_amount)}</td><td className="p-3 whitespace-nowrap">{formatAmount(supplierReturn.refund_amount)}</td><td className="p-3 whitespace-nowrap">{formatAmount(Number(supplierReturn.total_credit_amount ?? 0) - Number(supplierReturn.refund_amount ?? 0))}</td></> : null}
                          </tr>
                        ))}</tbody>
                      </table>
                    </div>
                  </div>
                ) : null}

                {canAdjustInventory && ["partially_received", "received"].includes(details.data.purchase.status) ? (
                  <form onSubmit={onReturnSubmit} className="space-y-3 rounded-md border border-dashed p-3">
                    <div className="flex items-center gap-2 font-semibold"><RotateCcw className="h-5 w-5" /> مرتجع إلى المورد</div>
                    <p className="text-sm text-muted-foreground">لا يمكن إرجاع أكثر من الكمية المستلمة والمتبقية بعد المرتجعات السابقة، ولا يتجاوز المرتجع المخزون الفعلي. تخفيض استحقاق المورد يُسجل مستقلًا عن المبلغ النقدي الذي يرده فعليًا.</p>
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                      <label className={inputGridClass}>تاريخ المرتجع
                        <Input type="date" value={returnDate} onChange={(event) => setReturnDate(event.target.value)} required />
                      </label>
                      <label className={inputGridClass + " sm:col-span-2"}>سبب المرتجع
                        <Input value={returnReason} onChange={(event) => setReturnReason(event.target.value)} maxLength={500} minLength={3} required placeholder="تلف، خطأ في التوريد، فائض…" />
                      </label>
                      <label className={inputGridClass + " sm:col-span-2"}>ملاحظات إضافية
                        <Input value={returnNotes} onChange={(event) => setReturnNotes(event.target.value)} maxLength={2000} />
                      </label>
                      {canManageSupplierPayments ? <>
                        <label className={inputGridClass}>المبلغ الذي استردته الشركة نقدًا (₪)
                          <Input type="number" min="0" step="0.01" value={returnRefundAmount} onChange={(event) => setReturnRefundAmount(event.target.value)} required />
                        </label>
                        {Number(returnRefundAmount) > 0 ? <label className={inputGridClass}>حساب الشركة المستلم
                          <select className={selectClass} value={returnRefundAccountId} onChange={(event) => setReturnRefundAccountId(event.target.value)} required>
                            <option value="">اختر حسابًا</option>
                            {(paymentOptions.data ?? []).map((account) => <option key={account.id} value={account.id}>{account.name} — الرصيد {formatAmount(account.balance)}</option>)}
                          </select>
                        </label> : null}
                      </> : null}
                    </div>
                    <div className="grid gap-2 md:grid-cols-2">
                      {details.data.lines.filter((line) => Number(line.received_quantity) > (details.data.returns.flatMap((supplierReturn) => supplierReturn.lines).filter((returnLine) => Number(returnLine.purchase_line_id) === Number(line.id)).reduce((sum, returnLine) => sum + Number(returnLine.quantity), 0))).map((line) => {
                        const returned = details.data.returns.flatMap((supplierReturn) => supplierReturn.lines).filter((returnLine) => Number(returnLine.purchase_line_id) === Number(line.id)).reduce((sum, returnLine) => sum + Number(returnLine.quantity), 0);
                        const remaining = Math.max(0, Number(line.received_quantity) - returned);
                        return <label key={line.id} className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm">
                          <span className="min-w-0 flex-1"><span className="block font-medium">{line.itemName}</span><span className="text-xs text-muted-foreground">المستلم غير المرتجع {remaining.toLocaleString("ar-PS", { maximumFractionDigits: 3 })} {line.unit}</span></span>
                          <span className="w-32 shrink-0"><Input type="number" min="0" max={remaining} step="0.001" value={returnQuantities[Number(line.id)] ?? "0"} onChange={(event) => setReturnQuantities((current) => ({ ...current, [Number(line.id)]: event.target.value }))} aria-label={`كمية الإرجاع ${line.itemName}`} /></span>
                        </label>;
                      })}
                    </div>
                    <div className="flex justify-end">
                      <Button type="submit" disabled={returnToSupplier.isPending}>
                        {returnToSupplier.isPending ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <RotateCcw className="ml-2 h-4 w-4" />} تسجيل مرتجع المورد
                      </Button>
                    </div>
                  </form>
                ) : null}

                {details.data.receipts.length ? (
                  <div className="space-y-2">
                    <h4 className="font-semibold">سجل الاستلام</h4>
                    <div className="overflow-x-auto rounded-md border">
                      <table className="w-full min-w-[600px] text-right text-sm">
                        <thead className="bg-muted/60"><tr>{["رقم الاستلام","التاريخ","وقت التسجيل","ملاحظات"].map((label) => <th key={label} className="p-3 font-semibold">{label}</th>)}</tr></thead>
                        <tbody>{details.data.receipts.map((receipt) => <tr key={receipt.id} className="border-t">
                          <td className="p-3 font-medium">{receipt.receipt_number}</td>
                          <td className="p-3">{receipt.receipt_date}</td>
                          <td className="p-3">{new Date(receipt.received_at).toLocaleString("ar-PS")}</td>
                          <td className="p-3">{receipt.notes || "—"}</td>
                        </tr>)}</tbody>
                      </table>
                    </div>
                  </div>
                ) : null}

                {details.data.payments.length ? (
                  <div className="space-y-2">
                    <h4 className="font-semibold">سجل دفعات المورد</h4>
                    <div className="overflow-x-auto rounded-md border">
                      <table className="w-full min-w-[700px] text-right text-sm">
                        <thead className="bg-muted/60"><tr>{["تاريخ الدفع","حساب الشركة","المرجع","المبلغ","الحالة",...(canManageSupplierPayments ? ["إجراء"] : [])].map((label) => <th key={label} className="p-3 font-semibold">{label}</th>)}</tr></thead>
                        <tbody>{details.data.payments.map((payment) => <tr key={payment.id} className="border-t">
                          <td className="p-3">{payment.payment_date}</td>
                          <td className="p-3">{payment.company_account_name}</td>
                          <td className="p-3">{payment.reference_no || "—"}</td>
                          <td className="p-3 font-semibold">{formatAmount(payment.allocated_amount)}</td>
                          <td className="p-3">{payment.status === "reversed" ? <span className="text-muted-foreground">معكوسة{payment.reversal_reason ? <span className="block text-xs">{payment.reversal_reason}</span> : null}</span> : "مسجلة"}</td>
                          {canManageSupplierPayments ? <td className="p-3">{payment.status === "posted" ? <div className="flex min-w-56 flex-col gap-2">
                            <Input value={paymentReversalReasons[payment.id] ?? ""} onChange={(event) => setPaymentReversalReasons((current) => ({ ...current, [payment.id]: event.target.value }))} maxLength={500} placeholder="سبب عكس الدفعة" aria-label="سبب عكس الدفعة" />
                            <Button type="button" size="sm" variant="outline" disabled={reverseSupplierPayment.isPending || (paymentReversalReasons[payment.id] ?? "").trim().length < 3} onClick={() => reverseSupplierPayment.mutate({ siteId, paymentId: payment.id, reason: (paymentReversalReasons[payment.id] ?? "").trim() })}>عكس الدفعة</Button>
                          </div> : "—"}</td> : null}
                        </tr>)}</tbody>
                      </table>
                    </div>
                  </div>
                ) : null}

                {canManageSupplierPayments
                  && ["confirmed", "partially_received", "received"].includes(details.data.purchase.status)
                  && Number(details.data.purchase.outstandingAmount ?? 0) > 0 ? (
                  <form onSubmit={onSupplierPaymentSubmit} className="space-y-3 rounded-md border border-dashed p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div><p className="font-semibold">تسجيل دفعة للمورد</p><p className="text-sm text-muted-foreground">تُسجل الدفعة والسحب من حساب الشركة وتخصيص الفاتورة وقيد المورد في معاملة واحدة.</p></div>
                      <div className="text-left"><p className="text-xs text-muted-foreground">المتبقي</p><p className="font-bold">{formatAmount(details.data.purchase.outstandingAmount)}</p></div>
                    </div>
                    {paymentOptions.isLoading ? <p className="text-sm text-muted-foreground">جارٍ تحميل حسابات الشركة وأرصدتها…</p> : null}
                    {paymentOptions.error ? <p className="text-sm text-destructive">تعذر تحميل حسابات الشركة: {paymentOptions.error.message}</p> : null}
                    {!paymentOptions.isLoading && !paymentOptions.error && !paymentOptions.data?.length
                      ? <p className="rounded-md bg-muted p-3 text-sm text-muted-foreground">لا يوجد حساب شركة نشط مرتبط بهذا الفرع أو متاح للشركة بالكامل.</p>
                      : null}
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                      <label className={inputGridClass}>حساب الشركة
                        <select className={selectClass} value={companyAccountId} onChange={(event) => setCompanyAccountId(event.target.value)} required>
                          <option value="">اختر الحساب</option>
                          {paymentOptions.data?.map((account) => <option key={account.id} value={account.id}>{account.name} — {accountTypeLabels[account.accountType] ?? account.accountType} — الرصيد {formatAmount(account.balance)}</option>)}
                        </select>
                      </label>
                      <label className={inputGridClass}>مبلغ الدفعة
                        <Input type="number" min="0.01" max={Math.max(0, Number(details.data.purchase.outstandingAmount ?? 0))} step="0.01" value={paymentAmount} onChange={(event) => setPaymentAmount(event.target.value)} required />
                      </label>
                      <label className={inputGridClass}>تاريخ الدفع
                        <Input type="date" value={paymentDate} onChange={(event) => setPaymentDate(event.target.value)} required />
                      </label>
                      <label className={inputGridClass}>رقم مرجع الدفع
                        <Input value={paymentReferenceNo} onChange={(event) => setPaymentReferenceNo(event.target.value)} maxLength={120} />
                      </label>
                      <label className={inputGridClass + " sm:col-span-2"}>ملاحظات الدفعة
                        <Input value={paymentNotes} onChange={(event) => setPaymentNotes(event.target.value)} maxLength={2000} />
                      </label>
                    </div>
                    {companyAccountId && paymentAmount && Number(paymentAmount) > Number(paymentOptions.data?.find((account) => String(account.id) === companyAccountId)?.balance ?? 0)
                      ? <p className="text-sm text-destructive">المبلغ أكبر من الرصيد الحالي للحساب المحدد.</p> : null}
                    <div className="flex justify-end">
                      <Button type="submit" disabled={recordSupplierPayment.isPending || paymentOptions.isLoading || !paymentOptions.data?.length}>
                        {recordSupplierPayment.isPending ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="ml-2 h-4 w-4" />}
                        تسجيل الدفعة
                      </Button>
                    </div>
                  </form>
                ) : null}

                {["draft", "confirmed"].includes(details.data.purchase.status) && canApprovePurchases ? (
                  <form onSubmit={(event) => {
                    event.preventDefault();
                    const reason = purchaseCancellationReason.trim();
                    if (reason.length < 3) { toast.error("اكتب سببًا واضحًا للإلغاء."); return; }
                    cancelPurchase.mutate({ siteId, purchaseId: selectedPurchaseId, reason });
                  }} className="space-y-3 rounded-md border border-destructive/30 p-3">
                    <div><p className="font-semibold">إلغاء فاتورة المشتريات</p><p className="text-sm text-muted-foreground">لا يُسمح بالإلغاء بعد الاستلام أو مع وجود دفعات مسجلة. عند إلغاء فاتورة معتمدة يُسجل قيد عكسي بدل حذف الاستحقاق الأصلي.</p></div>
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <Input value={purchaseCancellationReason} onChange={(event) => setPurchaseCancellationReason(event.target.value)} maxLength={500} placeholder="سبب الإلغاء (إلزامي)" required minLength={3} />
                      <Button type="submit" variant="destructive" disabled={cancelPurchase.isPending || purchaseCancellationReason.trim().length < 3}>
                        {cancelPurchase.isPending ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : null} إلغاء الفاتورة
                      </Button>
                    </div>
                  </form>
                ) : null}

                {details.data.purchase.status === "draft" && canApprovePurchases ? (
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-dashed p-3">
                    <div><p className="font-semibold">اعتماد الفاتورة</p><p className="text-sm text-muted-foreground">يسجل الاعتماد استحقاق المورد. لا تتغير كميات المخزون حتى تسجيل الاستلام.</p></div>
                    <Button type="button" disabled={confirmPurchase.isPending} onClick={() => confirmPurchase.mutate({ siteId, purchaseId: selectedPurchaseId })}>
                      {confirmPurchase.isPending ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="ml-2 h-4 w-4" />} اعتماد المشتريات
                    </Button>
                  </div>
                ) : null}

                {["confirmed", "partially_received"].includes(details.data.purchase.status) && canReceiveInventory ? (
                  <form onSubmit={onReceiveSubmit} className="space-y-3 rounded-md border border-dashed p-3">
                    <div className="flex items-center gap-2 font-semibold"><PackageCheck className="h-5 w-5" /> تسجيل استلام فعلي</div>
                    <p className="text-sm text-muted-foreground">أدخل ما وصل فعليًا الآن فقط. يمكن استلام الفاتورة على دفعات؛ النظام يمنع تجاوز الكمية المطلوبة.</p>
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                      <label className={inputGridClass}>تاريخ الاستلام
                        <Input type="date" value={receiptDate} onChange={(event) => setReceiptDate(event.target.value)} required />
                      </label>
                      <label className={inputGridClass + " sm:col-span-2"}>ملاحظات الاستلام
                        <Input value={receiptNotes} onChange={(event) => setReceiptNotes(event.target.value)} maxLength={2000} />
                      </label>
                    </div>
                    <div className="grid gap-2 md:grid-cols-2">
                      {details.data.lines.filter((line) => Number(line.quantity) > Number(line.received_quantity)).map((line) => {
                        const remaining = Number(line.quantity) - Number(line.received_quantity);
                        return <label key={line.id} className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm">
                          <span className="min-w-0 flex-1"><span className="block font-medium">{line.itemName}</span><span className="text-xs text-muted-foreground">المتبقي {remaining.toLocaleString("ar-PS", { maximumFractionDigits: 3 })} {line.unit}</span></span>
                          <span className="w-32 shrink-0"><Input type="number" min="0" max={remaining} step="0.001" value={receiptQuantities[Number(line.id)] ?? ""} onChange={(event) => setReceiptQuantities((current) => ({ ...current, [Number(line.id)]: event.target.value }))} aria-label={`كمية الاستلام ${line.itemName}`} /></span>
                        </label>;
                      })}
                    </div>
                    <div className="flex justify-end">
                      <Button type="submit" disabled={receivePurchase.isPending}>
                        {receivePurchase.isPending ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <PackageCheck className="ml-2 h-4 w-4" />} تسجيل الاستلام
                      </Button>
                    </div>
                  </form>
                ) : null}
              </>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
