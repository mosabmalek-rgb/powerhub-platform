import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import { CreditCard, Loader2, RefreshCw, RotateCcw, Wallet } from "lucide-react";
import { toast } from "sonner";

type PayableRow = {
  document_type: "purchase_invoice" | "opening_balance";
  document_id: number | string;
  supplier_id: number | string;
  supplier_name: string;
  document_number: string;
  document_date: string;
  due_date: string;
  gross_amount: number | string;
  paid_amount: number | string;
  credit_amount: number | string;
  outstanding_amount: number | string;
  days_overdue: number | string;
  aging_bucket: string;
};

type BatchOptions = {
  suppliers: Array<{ id: number | string; name: string; supplier_code: string | null }>;
  payables: {
    as_of_date: string;
    totals: {
      not_due: number | string;
      days_1_30: number | string;
      days_31_60: number | string;
      days_61_90: number | string;
      days_91_plus: number | string;
      total_outstanding: number | string;
    };
    rows: PayableRow[];
  };
};

function todayForInput() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

function operationKey() {
  const token = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `supplier-batch-payment:${token}`;
}

function amount(value: number | string | null | undefined) {
  const parsed = Number(value ?? 0);
  return `₪${new Intl.NumberFormat("ar-PS", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number.isFinite(parsed) ? parsed : 0)}`;
}

const accountTypeLabels: Record<string, string> = {
  cash: "نقدي",
  jawwal_pay: "جوال باي",
  palpay: "بال باي",
  bank_of_palestine: "بنك فلسطين",
  other: "أخرى",
};

export default function InventorySupplierPaymentsPanel({
  siteId,
  isAuthenticated,
  canManageSupplierPayments,
  canReverseSupplierPayments,
}: {
  siteId: number;
  isAuthenticated: boolean;
  canManageSupplierPayments: boolean;
  canReverseSupplierPayments: boolean;
}) {
  const utils = trpc.useUtils();
  const [supplierId, setSupplierId] = useState("");
  const [companyAccountId, setCompanyAccountId] = useState("");
  const [paymentDate, setPaymentDate] = useState(todayForInput);
  const [referenceNo, setReferenceNo] = useState("");
  const [notes, setNotes] = useState("");
  const [allocationAmounts, setAllocationAmounts] = useState<Record<string, string>>({});
  const [currentOperationKey, setCurrentOperationKey] = useState(operationKey);
  const [openingAmount, setOpeningAmount] = useState("");
  const [openingDate, setOpeningDate] = useState(todayForInput);
  const [openingReference, setOpeningReference] = useState("");
  const [openingNotes, setOpeningNotes] = useState("");
  const [reversalReasons, setReversalReasons] = useState<Record<number, string>>({});

  const batchOptionsQuery = trpc.powerhub.inventory.listSupplierPaymentBatchOptions.useQuery(
    { siteId },
    { enabled: Boolean(siteId && isAuthenticated && canManageSupplierPayments), staleTime: 15_000 },
  );
  const accountOptionsQuery = trpc.powerhub.inventory.listSupplierPaymentOptions.useQuery(
    { siteId },
    { enabled: Boolean(siteId && isAuthenticated && canManageSupplierPayments), staleTime: 15_000 },
  );
  const historyQuery = trpc.powerhub.inventory.listSupplierPaymentHistory.useQuery(
    { siteId, supplierId: supplierId ? Number(supplierId) : undefined, limit: 100 },
    { enabled: Boolean(siteId && isAuthenticated && canManageSupplierPayments), staleTime: 10_000 },
  );

  const batchOptions = batchOptionsQuery.data as unknown as BatchOptions | undefined;
  const suppliers = batchOptions?.suppliers ?? [];
  const allRows = batchOptions?.payables?.rows ?? [];
  const selectedRows = useMemo(
    () => allRows.filter((row) => Number(row.supplier_id) === Number(supplierId) && Number(row.outstanding_amount) > 0),
    [allRows, supplierId],
  );
  const accounts = accountOptionsQuery.data ?? [];
  const chosenAccount = accounts.find((account) => String(account.id) === companyAccountId);
  const selectedAllocations = useMemo(() => selectedRows.map((row) => {
    const key = `${row.document_type}:${row.document_id}`;
    const allocationAmount = Number(allocationAmounts[key] ?? 0);
    const outstanding = Number(row.outstanding_amount);
    return { row, key, allocationAmount, outstanding };
  }).filter((entry) => Number.isFinite(entry.allocationAmount) && entry.allocationAmount > 0), [selectedRows, allocationAmounts]);
  const totalCents = selectedAllocations.reduce((sum, entry) => sum + Math.round(entry.allocationAmount * 100), 0);
  const totalAmount = totalCents / 100;
  const allAllocationAmountsValid = selectedAllocations.every((entry) =>
    Math.abs(entry.allocationAmount * 100 - Math.round(entry.allocationAmount * 100)) < 1e-7
      && entry.allocationAmount <= entry.outstanding
  );

  useEffect(() => {
    if (!supplierId && suppliers.length) setSupplierId(String(suppliers[0].id));
  }, [supplierId, suppliers]);
  useEffect(() => {
    if (!companyAccountId && accounts.length) setCompanyAccountId(String(accounts[0].id));
    else if (companyAccountId && !accounts.some((account) => String(account.id) === companyAccountId)) {
      setCompanyAccountId(accounts[0] ? String(accounts[0].id) : "");
    }
  }, [accounts, companyAccountId]);

  const refreshData = async () => {
    await Promise.all([
      utils.powerhub.inventory.listSupplierPaymentBatchOptions.invalidate(),
      utils.powerhub.inventory.listSupplierPaymentOptions.invalidate({ siteId }),
      utils.powerhub.inventory.listSupplierPaymentHistory.invalidate(),
      utils.powerhub.inventory.supplierPayablesAging.invalidate(),
      utils.powerhub.inventory.listPurchases.invalidate(),
      utils.powerhub.inventory.getPurchase.invalidate(),
      utils.powerhub.inventory.supplierLedgerStatement.invalidate(),
    ]);
  };

  const postPayment = trpc.powerhub.inventory.recordSupplierPaymentBatch.useMutation({
    onSuccess: async (result) => {
      toast.success(result.replayed
        ? "تم التحقق من دفعة المورد السابقة دون تكرار الخصم."
        : `تم تسجيل دفعة المورد بقيمة ${amount(result.amount)} وتوزيعها على ${result.allocation_count} مستند/مستندات.`);
      setAllocationAmounts({});
      setReferenceNo("");
      setNotes("");
      setPaymentDate(todayForInput());
      setCurrentOperationKey(operationKey());
      await refreshData();
    },
    onError: (error) => toast.error(error.message || "تعذر تسجيل دفعة المورد."),
  });

  const addOpeningBalance = trpc.powerhub.inventory.recordSupplierOpeningBalance.useMutation({
    onSuccess: async (result) => {
      toast.success(result.replayed
        ? "الرصيد الافتتاحي مسجل مسبقًا بالبيانات نفسها."
        : `تم تسجيل الرصيد الافتتاحي ${amount(result.amount)} للمورد.`);
      setOpeningAmount("");
      setOpeningReference("");
      setOpeningNotes("");
      setOpeningDate(todayForInput());
      await refreshData();
    },
    onError: (error) => toast.error(error.message || "تعذر تسجيل الرصيد الافتتاحي."),
  });

  const reversePayment = trpc.powerhub.inventory.reverseSupplierPayment.useMutation({
    onSuccess: async (result) => {
      toast.success(result.replayed ? "تم التحقق من عكس الدفعة سابقًا." : "تم عكس الدفعة وإعادة المبلغ إلى حساب الشركة.");
      setReversalReasons((current) => ({ ...current, [Number(result.payment_id)]: "" }));
      await refreshData();
    },
    onError: (error) => toast.error(error.message || "تعذر عكس دفعة المورد."),
  });

  const submitPayment = () => {
    if (!supplierId) { toast.error("اختر المورد أولًا."); return; }
    if (!companyAccountId) { toast.error("اختر حساب الدفع من حسابات الشركة."); return; }
    if (!selectedAllocations.length || totalAmount <= 0) { toast.error("أدخل مبلغًا على فاتورة أو رصيد افتتاحي واحد على الأقل."); return; }
    if (!allAllocationAmountsValid) { toast.error("تحقق من المبالغ؛ يجب ألا يتجاوز أي تخصيص المتبقي عن المستند وألا يتجاوز منزلتين عشريتين."); return; }
    if (chosenAccount && totalAmount > Number(chosenAccount.balance)) { toast.error("المبلغ الإجمالي يتجاوز الرصيد الظاهر للحساب. سيعيد الخادم التحقق من الرصيد الفعلي عند الحفظ."); return; }
    postPayment.mutate({
      siteId,
      supplierId: Number(supplierId),
      companyAccountId: Number(companyAccountId),
      amount: totalAmount,
      paymentDate,
      referenceNo: referenceNo.trim() || undefined,
      notes: notes.trim() || undefined,
      operationKey: currentOperationKey,
      allocations: selectedAllocations.map(({ row, allocationAmount }) => ({
        ...(row.document_type === "purchase_invoice"
          ? { purchaseId: Number(row.document_id) }
          : { openingBalanceEntryId: Number(row.document_id) }),
        amount: allocationAmount,
      })),
    });
  };

  const submitOpeningBalance = () => {
    if (!supplierId) { toast.error("اختر المورد أولًا."); return; }
    const parsed = Number(openingAmount);
    if (!Number.isFinite(parsed) || parsed <= 0 || Math.abs(parsed * 100 - Math.round(parsed * 100)) > 1e-7) {
      toast.error("أدخل رصيدًا افتتاحيًا موجبًا وبمنزلتين عشريتين كحد أقصى.");
      return;
    }
    addOpeningBalance.mutate({
      siteId,
      supplierId: Number(supplierId),
      amount: parsed,
      asOfDate: openingDate,
      referenceNo: openingReference.trim() || undefined,
      notes: openingNotes.trim() || undefined,
    });
  };

  const history = historyQuery.data ?? [];

  if (!canManageSupplierPayments) {
    return <Card><CardContent className="p-6 text-center text-muted-foreground">لا تملك صلاحية تسجيل دفعات الموردين أو مراجعة سجلها.</CardContent></Card>;
  }

  return (
    <div dir="rtl" className="space-y-4">
      <Card>
        <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2"><CreditCard className="h-5 w-5" /> دفعة مورد وتوزيعها على عدة مستندات</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">اختر المورد وحساب الشركة، ثم وزّع المبلغ على فاتورة واحدة أو عدة فواتير أو رصيد افتتاحي. يجب أن يطابق مجموع التخصيصات مبلغ الدفعة.</p>
          </div>
          <Button type="button" variant="outline" disabled={batchOptionsQuery.isFetching || accountOptionsQuery.isFetching || historyQuery.isFetching} onClick={() => void refreshData()}>
            <RefreshCw className="ml-2 h-4 w-4" /> تحديث البيانات
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="grid gap-1.5 text-sm">المورد *
              <select className="h-10 rounded-md border bg-background px-3" value={supplierId} onChange={(event) => { setSupplierId(event.target.value); setAllocationAmounts({}); }}>
                <option value="">اختر المورد</option>
                {suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}{supplier.supplier_code ? ` — ${supplier.supplier_code}` : ""}</option>)}
              </select>
            </label>
            <label className="grid gap-1.5 text-sm">حساب الدفع من حسابات الشركة *
              <select className="h-10 rounded-md border bg-background px-3" value={companyAccountId} onChange={(event) => setCompanyAccountId(event.target.value)}>
                <option value="">اختر الحساب</option>
                {accounts.map((account) => <option key={account.id} value={account.id}>{account.name} — {accountTypeLabels[account.accountType] ?? account.accountType} — الرصيد {amount(account.balance)}</option>)}
              </select>
            </label>
            <label className="grid gap-1.5 text-sm">تاريخ الدفع *
              <Input type="date" value={paymentDate} onChange={(event) => setPaymentDate(event.target.value)} required />
            </label>
            <label className="grid gap-1.5 text-sm">مرجع الدفعة
              <Input value={referenceNo} maxLength={120} onChange={(event) => setReferenceNo(event.target.value)} placeholder="رقم سند/تحويل" />
            </label>
          </div>

          {batchOptionsQuery.isLoading ? <p className="py-5 text-center text-muted-foreground">جارٍ تحميل المستحقات…</p>
            : batchOptionsQuery.error ? <p className="py-5 text-center text-destructive">تعذر تحميل المستحقات المفتوحة. حدّث البيانات أو تحقق من صلاحياتك.</p>
            : !supplierId ? <p className="rounded-md border p-4 text-muted-foreground">اختر المورد لعرض فواتيره ومستحقاته.</p>
            : !selectedRows.length ? <p className="rounded-md border p-4 text-muted-foreground">لا توجد فواتير أو أرصدة افتتاحية مستحقة لهذا المورد بحسب البيانات المتاحة.</p>
            : <div className="space-y-2">
              <div className="flex items-center justify-between gap-3"><h3 className="font-semibold">المستندات المستحقة</h3><span className="text-sm text-muted-foreground">{selectedRows.length} مستند</span></div>
              <div className="overflow-x-auto rounded-md border">
                <table className="w-full min-w-[850px] text-right text-sm">
                  <thead className="bg-muted/60"><tr>{["المستند","التاريخ","الاستحقاق","قيمة المستند","المسدّد","المتبقي","مبلغ التخصيص"].map((title) => <th key={title} className="p-3 font-semibold">{title}</th>)}</tr></thead>
                  <tbody>{selectedRows.map((row) => {
                    const key = `${row.document_type}:${row.document_id}`;
                    const currentValue = allocationAmounts[key] ?? "";
                    const overdue = Number(row.days_overdue) > 0;
                    return <tr key={key} className="border-t">
                      <td className="p-3"><span className="font-medium">{row.document_type === "purchase_invoice" ? "فاتورة شراء" : "رصيد افتتاحي"}</span><span className="block text-xs text-muted-foreground">{row.document_number || "—"}</span>{overdue ? <span className="mt-1 inline-block text-xs text-destructive">متأخر {Number(row.days_overdue)} يومًا</span> : null}</td>
                      <td className="p-3 whitespace-nowrap">{row.document_date || "—"}</td>
                      <td className="p-3 whitespace-nowrap">{row.due_date || "—"}</td>
                      <td className="p-3 whitespace-nowrap">{amount(row.gross_amount)}</td>
                      <td className="p-3 whitespace-nowrap">{amount(row.paid_amount)}</td>
                      <td className="p-3 whitespace-nowrap font-semibold">{amount(row.outstanding_amount)}</td>
                      <td className="p-3"><Input className="min-w-[130px]" type="number" min="0" max={Number(row.outstanding_amount)} step="0.01" value={currentValue} onChange={(event) => setAllocationAmounts((current) => ({ ...current, [key]: event.target.value }))} placeholder="0.00" aria-label={`مبلغ تخصيص ${row.document_number}`} /></td>
                    </tr>;
                  })}</tbody>
                </table>
              </div>
            </div>}

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1.5 text-sm">ملاحظات
              <Input value={notes} maxLength={2000} onChange={(event) => setNotes(event.target.value)} placeholder="ملاحظات الدفعة" />
            </label>
            <div className="rounded-md border p-3">
              <div className="flex items-center justify-between gap-3"><span className="text-sm text-muted-foreground">إجمالي التخصيصات / مبلغ الدفعة</span><span className="text-xl font-bold tabular-nums">{amount(totalAmount)}</span></div>
              <div className="mt-1 flex items-center justify-between gap-3 text-xs text-muted-foreground"><span>عدد المستندات المحددة</span><span>{selectedAllocations.length}</span></div>
              {chosenAccount ? <div className="mt-1 flex items-center justify-between gap-3 text-xs text-muted-foreground"><span>رصيد الحساب بعد الدفعة (تقديري)</span><span>{amount(Number(chosenAccount.balance) - totalAmount)}</span></div> : null}
              <Button type="button" className="mt-3 w-full" disabled={postPayment.isPending || !supplierId || !companyAccountId || !selectedAllocations.length || !allAllocationAmountsValid || totalAmount <= 0} onClick={submitPayment}>
                {postPayment.isPending ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Wallet className="ml-2 h-4 w-4" />} تسجيل الدفعة وتوزيعها ذريًا
              </Button>
              <p className="mt-2 text-xs text-muted-foreground">لن تُسجل الدفعة إلا إذا طابق مجموع التخصيصات مبلغها؛ ويعيد الخادم التحقق من الرصيد المتاح والمستحقات وحالة الفترة المالية قبل أي أثر مالي.</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>رصيد افتتاحي مستحق للمورد</CardTitle><p className="text-sm text-muted-foreground">يستخدم مرة واحدة عند بدء العمل بالنظام لإثبات ذمة موجودة مسبقًا. لا يمثل شراءً جديدًا ولا يضيف كمية للمخزون.</p></CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <label className="grid gap-1.5 text-sm">المبلغ *
              <Input type="number" min="0.01" step="0.01" value={openingAmount} onChange={(event) => setOpeningAmount(event.target.value)} />
            </label>
            <label className="grid gap-1.5 text-sm">تاريخ الرصيد *
              <Input type="date" value={openingDate} onChange={(event) => setOpeningDate(event.target.value)} required />
            </label>
            <label className="grid gap-1.5 text-sm">المرجع
              <Input value={openingReference} maxLength={120} onChange={(event) => setOpeningReference(event.target.value)} />
            </label>
            <label className="grid gap-1.5 text-sm">ملاحظات
              <Input value={openingNotes} maxLength={500} onChange={(event) => setOpeningNotes(event.target.value)} />
            </label>
            <div className="flex items-end"><Button type="button" className="w-full" disabled={addOpeningBalance.isPending || !supplierId || !openingAmount} onClick={submitOpeningBalance}>{addOpeningBalance.isPending ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : null} تسجيل الرصيد الافتتاحي</Button></div>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">يمنع الخادم تسجيل رصيد افتتاحي ثانٍ للمورد/الفرع نفسه؛ أي تصحيح لاحق يجب أن يكون بتسوية موثقة، لا بتعديل القيد التاريخي.</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>سجل دفعات الموردين</CardTitle><p className="text-sm text-muted-foreground">سجل موحد يتضمن حساب الشركة وتفاصيل تخصيص كل دفعة للمستندات المرتبطة بها وحالة العكس.</p></CardHeader>
        <CardContent className="space-y-3">
          {historyQuery.isLoading ? <p className="py-5 text-center text-muted-foreground">جارٍ تحميل الدفعات…</p>
            : historyQuery.error ? <p className="py-5 text-center text-destructive">تعذر تحميل سجل الدفعات.</p>
            : !history.length ? <p className="py-5 text-center text-muted-foreground">لا توجد دفعات مسجلة ضمن الفرع الحالي.</p>
            : <div className="overflow-x-auto rounded-md border">
              <table className="w-full min-w-[1000px] text-right text-sm">
                <thead className="bg-muted/60"><tr>{["التاريخ","المورد","المبلغ","حساب الشركة","المستندات المخصصة","الحالة","العكس"].map((title) => <th key={title} className="p-3 font-semibold">{title}</th>)}</tr></thead>
                <tbody>{history.map((payment) => {
                  const status = payment.status === "reversed";
                  return <tr key={payment.id} className="border-t align-top">
                    <td className="p-3 whitespace-nowrap">{payment.payment_date}<span className="block text-xs text-muted-foreground">{payment.reference_no || "—"}</span></td>
                    <td className="p-3">{payment.supplier_name}<span className="block text-xs text-muted-foreground">{payment.supplier_code || ""}</span></td>
                    <td className="p-3 whitespace-nowrap font-semibold">{amount(payment.amount)}</td>
                    <td className="p-3">{payment.company_account_name}<span className="block text-xs text-muted-foreground">{accountTypeLabels[payment.company_account_type ?? ""] ?? payment.company_account_type ?? ""}</span></td>
                    <td className="p-3"><div className="space-y-1">{payment.allocations.map((allocation, index) => <div key={`${payment.id}:${index}`} className="flex items-center justify-between gap-3"><span>{allocation.document_type === "purchase_invoice" ? "فاتورة" : "رصيد افتتاحي"} — {allocation.document_reference}</span><span className="whitespace-nowrap">{amount(allocation.amount)}</span></div>)}</div><div className="mt-1 text-xs text-muted-foreground">{payment.notes || ""}</div></td>
                    <td className="p-3"><span className={status ? "font-medium text-destructive" : "font-medium"}>{status ? "معكوسة" : "مرحّلة"}</span>{status && payment.reversal_reason ? <span className="mt-1 block max-w-[180px] text-xs text-muted-foreground">{payment.reversal_reason}</span> : null}</td>
                    <td className="p-3">
                      {status ? "—" : !canReverseSupplierPayments ? <span className="text-xs text-muted-foreground">لا تملك صلاحية عكس الدفعات</span> : <div className="min-w-[210px] space-y-2">
                        <Input value={reversalReasons[payment.id] ?? ""} maxLength={500} onChange={(event) => setReversalReasons((current) => ({ ...current, [payment.id]: event.target.value }))} placeholder="سبب العكس (مطلوب)" />
                        <Button type="button" size="sm" variant="outline" disabled={reversePayment.isPending || (reversalReasons[payment.id] ?? "").trim().length < 3} onClick={() => reversePayment.mutate({ siteId, paymentId: payment.id, reason: reversalReasons[payment.id].trim() })}>
                          {reversePayment.isPending ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <RotateCcw className="ml-2 h-4 w-4" />} عكس الدفعة
                        </Button>
                      </div>}
                    </td>
                  </tr>;
                })}</tbody>
              </table>
            </div>}
        </CardContent>
      </Card>
    </div>
  );
}
