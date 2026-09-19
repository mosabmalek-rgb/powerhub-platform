import { useAuth } from "@/_core/hooks/useAuth";
import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import { ArrowDownToLine, ArrowLeftRight, ArrowUpFromLine, Banknote, CircleDollarSign, Download, FileSpreadsheet, Landmark, Loader2, Plus, Printer, WalletCards } from "lucide-react";
import ExcelJS from "exceljs";
import jsPDF from "jspdf";
import { type ElementType, useMemo, useState } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { toast } from "sonner";

const labels: Record<string, string> = {
  cash: "كاش",
  jawwal_pay: "جوال بي",
  palpay: "بال بي",
  bank_of_palestine: "بنك فلسطين",
  other: "حساب آخر",
};

const accountTheme: Record<string, { card: string; icon: ElementType; badge: string; shortLabel: string }> = {
  cash: { card: "border-slate-300/40 bg-slate-300/40", icon: Banknote, badge: "bg-slate-950/40 text-white", shortLabel: "CASH" },
  jawwal_pay: { card: "border-lime-300/40 bg-lime-500/40", icon: CircleDollarSign, badge: "bg-lime-950/55 text-lime-50", shortLabel: "JPay" },
  palpay: { card: "border-fuchsia-300/40 bg-fuchsia-500/40", icon: WalletCards, badge: "bg-fuchsia-950/55 text-fuchsia-50", shortLabel: "PalPay" },
  bank_of_palestine: { card: "border-rose-400/40 bg-rose-900/40", icon: Landmark, badge: "bg-rose-950/60 text-rose-50", shortLabel: "BOP" },
  other: { card: "border-amber-300/40 bg-amber-500/40", icon: WalletCards, badge: "bg-amber-950/45 text-amber-50", shortLabel: "حساب" },
};

const money = (value: number) => value.toLocaleString("ar", { maximumFractionDigits: 2 });

type PendingAccountAction = {
  kind: "withdrawal" | "transfer";
  amount: number;
  description: string;
  targetAccountId?: number;
  operationId: string;
};

export default function CompanyAccountsPage() {
  const { isAuthenticated, loading } = useAuth();
  const sites = trpc.powerhub.sites.list.useQuery(undefined, { enabled: isAuthenticated });
  const siteId = sites.data?.[0]?.id ?? 0;
  const [branchFilter, setBranchFilter] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [transactionTypeFilter, setTransactionTypeFilter] = useState("");
  const [movementFromDate, setMovementFromDate] = useState("");
  const [movementToDate, setMovementToDate] = useState("");
  const [transactionPage, setTransactionPage] = useState(1);
  const [selected, setSelected] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [accountType, setAccountType] = useState("cash");
  const [name, setName] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [createOpeningBalance, setCreateOpeningBalance] = useState("0");
  const [openingBalance, setOpeningBalance] = useState("0");
  const [selectedSites, setSelectedSites] = useState<number[]>([]);
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [mode, setMode] = useState<"deposit" | "withdrawal" | "transfer">("deposit");
  const [target, setTarget] = useState("");
  const [pendingAction, setPendingAction] = useState<PendingAccountAction | null>(null);
  const [movementOperationId, setMovementOperationId] = useState<string | null>(null);

  const accounts = trpc.powerhub.companyAccounts.list.useQuery(
    { siteId, branchId: branchFilter ? Number(branchFilter) : undefined, fromDate: fromDate || undefined, toDate: toDate || undefined },
    { enabled: Boolean(siteId && isAuthenticated) },
  );
  const utils = trpc.useUtils();
  const refreshAccounts = () => void utils.powerhub.companyAccounts.list.invalidate();
  const updateOpeningBalance = trpc.powerhub.companyAccounts.updateOpeningBalance.useMutation({ onSuccess: () => { toast.success("تم حفظ الرصيد الافتتاحي."); refreshAccounts(); }, onError: (error) => toast.error(error.message) });
  const updateSites = trpc.powerhub.companyAccounts.updateSites.useMutation({ onSuccess: () => { toast.success("تم تحديث الفروع المرتبطة."); refreshAccounts(); }, onError: (error) => toast.error(error.message) });
  const updatePhone = trpc.powerhub.companyAccounts.updatePhone.useMutation({ onSuccess: () => { toast.success("تم حفظ رقم الجوال."); refreshAccounts(); }, onError: (error) => toast.error(error.message) });
  const create = trpc.powerhub.companyAccounts.create.useMutation({
    onSuccess: () => {
      toast.success("تم إنشاء الحساب وحفظ رصيده الافتتاحي.");
      setShowCreate(false);
      setName("");
      setNewPhone("");
      setCreateOpeningBalance("0");
      setSelectedSites([]);
      refreshAccounts();
    },
    onError: (error) => toast.error(error.message),
  });
  const movement = trpc.powerhub.companyAccounts.addMovement.useMutation({ onSuccess: () => { toast.success("تم تسجيل حركة الحساب."); setAmount(""); setDescription(""); setMovementOperationId(null); refreshAccounts(); }, onError: (error) => toast.error(error.message) });
  const transfer = trpc.powerhub.companyAccounts.transfer.useMutation({ onSuccess: () => { toast.success("تم تنفيذ التحويل بين الحسابات."); setAmount(""); setDescription(""); setPendingAction(null); refreshAccounts(); }, onError: (error) => toast.error(error.message) });

  const rows = accounts.data ?? [];
  const filtered = useMemo(() => rows.filter((account) => `${account.name} ${account.phoneNumber ?? ""} ${labels[account.accountType] ?? account.accountType}`.toLowerCase().includes(search.toLowerCase().trim())), [rows, search]);
  const selectedAccount = rows.find((account) => account.id === selected);
  const total = rows.reduce((sum, row) => sum + Number(row.balance), 0);
  const transactionRows = selectedAccount?.transactions.filter((row) => {
    const date = new Date(row.occurredAt).toISOString().slice(0, 10);
    return (!transactionTypeFilter || row.transactionType === transactionTypeFilter) && (!movementFromDate || date >= movementFromDate) && (!movementToDate || date <= movementToDate);
  }) ?? [];
  const pageSize = 10;
  const pageCount = Math.max(1, Math.ceil(transactionRows.length / pageSize));
  const visibleTransactions = transactionRows.slice((transactionPage - 1) * pageSize, transactionPage * pageSize);
  const balanceTimeline = useMemo(() => {
    if (!selectedAccount) return [];
    let running = Number(selectedAccount.openingBalance ?? 0);
    const rows = [{ label: "الرصيد الافتتاحي", balance: running }];
    [...selectedAccount.transactions].reverse().forEach((row) => {
      running += row.transactionType === "withdrawal" || row.transactionType === "transfer_out" ? -Number(row.amount) : Number(row.amount);
      rows.push({ label: new Date(row.occurredAt).toLocaleDateString("ar", { month: "short", day: "numeric" }), balance: running });
    });
    return rows;
  }, [selectedAccount]);
  const cumulativeById = (() => {
    if (!selectedAccount) return new Map<number, number>();
    let running = Number(selectedAccount.openingBalance ?? 0);
    const result = new Map<number, number>();
    [...selectedAccount.transactions].reverse().forEach((row) => {
      running += row.transactionType === "withdrawal" || row.transactionType === "transfer_out" ? -Number(row.amount) : Number(row.amount);
      result.set(row.id, running);
    });
    return result;
  })();

  if (loading || accounts.isLoading) return <DashboardLayout><div className="grid min-h-[60vh] place-items-center"><Loader2 className="h-7 w-7 animate-spin text-[#F5B800]" /></div></DashboardLayout>;
  if (!isAuthenticated) return <DashboardLayout><div className="p-8 text-center text-white">سجّل الدخول للوصول إلى حسابات الشركة.</div></DashboardLayout>;

  const selectAccount = (accountId: number) => {
    const account = rows.find((row) => row.id === accountId);
    if (!account) return;
    setSelected(account.id);
    setSelectedSites(account.linkedSites.map((site) => site.siteId));
    setOpeningBalance(String(account.openingBalance ?? 0));
    setNewPhone(account.phoneNumber ?? "");
    setTransactionPage(1);
    setTransactionTypeFilter("");
    setMovementFromDate("");
    setMovementToDate("");
    setMode("deposit");
    setTarget("");
  };

  const saveOpeningBalance = () => {
    const value = Number(openingBalance);
    if (!selectedAccount || !Number.isFinite(value) || value < 0) return toast.error("أدخل رصيداً افتتاحياً صحيحاً يساوي صفراً أو أكثر.");
    updateOpeningBalance.mutate({ siteId, accountId: selectedAccount.id, openingBalance: value });
  };

  const submitCreate = () => {
    const value = Number(createOpeningBalance);
    if (!Number.isFinite(value) || value < 0) return toast.error("أدخل رصيداً افتتاحياً صحيحاً يساوي صفراً أو أكثر.");
    create.mutate({ siteId, name: name.trim(), accountType: accountType as "cash" | "jawwal_pay" | "palpay" | "bank_of_palestine" | "other", phoneNumber: newPhone, openingBalance: value, siteIds: selectedSites.length ? selectedSites : [siteId] });
  };

  const submitMovement = () => {
    const value = Number(amount);
    if (!selectedAccount || !Number.isFinite(value) || value <= 0 || !description.trim()) return toast.error("اختر الحساب وأدخل مبلغاً ووصفاً صحيحين.");
    if ((mode === "withdrawal" || mode === "transfer") && value > Number(selectedAccount.balance)) return toast.error("المبلغ يتجاوز الرصيد المتاح في الحساب.");
    if (mode === "transfer") {
      if (!target) return toast.error("اختر الحساب المستقبِل للتحويل.");
      setPendingAction({ kind: "transfer", amount: value, description: description.trim(), targetAccountId: Number(target), operationId: globalThis.crypto.randomUUID() });
      return;
    }
    if (mode === "withdrawal") {
      setPendingAction({ kind: "withdrawal", amount: value, description: description.trim(), operationId: globalThis.crypto.randomUUID() });
      return;
    }
    const operationId = movementOperationId ?? globalThis.crypto.randomUUID();
    setMovementOperationId(operationId);
    movement.mutate({ siteId, accountId: selectedAccount.id, transactionType: mode, amount: value, description: description.trim(), clientOperationId: operationId });
  };

  const confirmPendingAction = () => {
    if (!selectedAccount || !pendingAction) return;
    if (pendingAction.kind === "transfer" && pendingAction.targetAccountId) {
      transfer.mutate({ siteId, fromAccountId: selectedAccount.id, toAccountId: pendingAction.targetAccountId, amount: pendingAction.amount, description: pendingAction.description, clientOperationId: pendingAction.operationId });
    } else {
      movement.mutate({ siteId, accountId: selectedAccount.id, transactionType: "withdrawal", amount: pendingAction.amount, description: pendingAction.description, clientOperationId: pendingAction.operationId });
    }
  };

  const exportCsv = () => {
    const header = "الحساب,نوع الحساب,رقم الجوال,الفروع,الرصيد\n";
    const body = filtered.map((row) => [row.name, labels[row.accountType] ?? row.accountType, row.phoneNumber ?? "", row.linkedSites.map((site) => site.siteName).join(" | "), Number(row.balance).toFixed(2)].map((value) => `"${String(value).replaceAll('"', '""')}"`).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob(["\ufeff" + header + body], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "كشف-حسابات-الشركة.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const exportExcel = async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("حسابات الشركة", { views: [{ rightToLeft: true }] });
    sheet.addRow(["الحساب", "نوع الحساب", "رقم الجوال", "الفروع", "الرصيد"]);
    filtered.forEach((row) => sheet.addRow([row.name, labels[row.accountType] ?? row.accountType, row.phoneNumber ?? "غير مرتبط", row.linkedSites.map((site) => site.siteName).join("، ") || "غير محدد", Number(row.balance)]));
    sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0D1117" } };
    sheet.columns = [{ width: 24 }, { width: 20 }, { width: 20 }, { width: 35 }, { width: 16 }];
    const url = URL.createObjectURL(new Blob([await workbook.xlsx.writeBuffer()], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "كشف-حسابات-الشركة.xlsx";
    anchor.click();
    URL.revokeObjectURL(url);
    toast.success("تم تصدير كشف الحساب إلى Excel.");
  };

  const exportPdf = () => {
    const pdf = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
    pdf.setFontSize(16);
    pdf.text("PowerHub - Company Accounts", 770, 35, { align: "right" });
    pdf.setFontSize(9);
    pdf.text(`Accounts: ${filtered.length}`, 770, 52, { align: "right" });
    let y = 80;
    pdf.text("Account | Type | Phone | Branches | Balance", 770, y, { align: "right" });
    y += 18;
    filtered.forEach((row) => {
      if (y > 540) { pdf.addPage(); y = 40; }
      const line = [row.name, labels[row.accountType] ?? row.accountType, row.phoneNumber ?? "-", row.linkedSites.map((site) => site.siteName).join(" / ") || "-", Number(row.balance).toLocaleString("en-US")].join(" | ");
      pdf.text(line.slice(0, 145), 770, y, { align: "right" });
      y += 14;
    });
    pdf.save("كشف-حسابات-الشركة.pdf");
    toast.success("تم تصدير كشف الحساب إلى PDF.");
  };

  const exportTransactionsExcel = async () => {
    if (!selectedAccount) return;
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("حركات الحساب", { views: [{ rightToLeft: true }] });
    sheet.addRow(["الحساب", selectedAccount.name]);
    sheet.addRow(["الرصيد الافتتاحي", Number(selectedAccount.openingBalance ?? 0)]);
    sheet.addRow([]);
    sheet.addRow(["التاريخ", "النوع", "المبلغ", "الرصيد التراكمي", "الوصف", "المرجع"]);
    transactionRows.forEach((row) => sheet.addRow([new Date(row.occurredAt).toLocaleString("ar"), row.transactionType, Number(row.amount), Number(cumulativeById.get(row.id) ?? 0), row.description, row.referenceNo ?? "—"]));
    sheet.getRow(4).font = { bold: true, color: { argb: "FFFFFFFF" } };
    sheet.getRow(4).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0D1117" } };
    sheet.columns = [{ width: 23 }, { width: 18 }, { width: 16 }, { width: 18 }, { width: 42 }, { width: 22 }];
    const url = URL.createObjectURL(new Blob([await workbook.xlsx.writeBuffer()], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `حركات-${selectedAccount.name}.xlsx`;
    anchor.click();
    URL.revokeObjectURL(url);
    toast.success("تم تصدير حركات الحساب إلى Excel.");
  };

  const exportTransactionsPdf = () => {
    if (!selectedAccount) return;
    const pdf = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
    pdf.setFontSize(16);
    pdf.text(`PowerHub - ${selectedAccount.name}`, 770, 35, { align: "right" });
    pdf.setFontSize(9);
    pdf.text(`Opening balance: ${Number(selectedAccount.openingBalance ?? 0).toLocaleString("en-US")}`, 770, 52, { align: "right" });
    let y = 80;
    pdf.text("Date | Type | Amount | Running balance | Description | Reference", 770, y, { align: "right" });
    y += 18;
    transactionRows.forEach((row) => {
      if (y > 540) { pdf.addPage(); y = 40; }
      const line = [new Date(row.occurredAt).toLocaleDateString("en-US"), row.transactionType, Number(row.amount).toFixed(2), Number(cumulativeById.get(row.id) ?? 0).toFixed(2), row.description, row.referenceNo ?? "-"].join(" | ");
      pdf.text(line.slice(0, 150), 770, y, { align: "right" });
      y += 14;
    });
    pdf.save(`حركات-${selectedAccount.name}.pdf`);
    toast.success("تم تصدير حركات الحساب إلى PDF.");
  };

  return (
    <DashboardLayout>
      <div className="space-y-6 pb-12 print:bg-white print:text-black">
        <header className="rounded-2xl border border-white/10 bg-[#111823] p-6 print:hidden">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-3 text-[#F5B800]"><WalletCards className="h-6 w-6" /><span className="font-bold">الخزينة والصناديق</span></div>
              <h1 className="mt-2 text-2xl font-extrabold text-white">حسابات الشركة</h1>
              <p className="mt-2 text-sm text-slate-400">أضف حساباً برصيد افتتاحي، ثم سجل الإيداعات والسحوبات والتحويلات بسجل مالي واضح.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => setShowCreate((visible) => !visible)} className="bg-[#F5B800] font-bold text-[#0D1117]"><Plus className="ml-2 h-4 w-4" />إضافة حساب</Button>
              <Button onClick={exportExcel} variant="outline" className="border-white/15 text-white"><FileSpreadsheet className="ml-2 h-4 w-4" />Excel</Button>
              <Button onClick={exportCsv} variant="outline" className="border-white/15 text-white"><Download className="ml-2 h-4 w-4" />CSV</Button>
              <Button onClick={exportPdf} variant="outline" className="border-white/15 text-white"><Printer className="ml-2 h-4 w-4" />PDF</Button>
            </div>
          </div>
        </header>

        {showCreate && (
          <Card className="border-[#F5B800]/30 bg-[#111823] print:hidden">
            <CardContent className="grid gap-3 p-5 md:grid-cols-2">
              <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="اسم الحساب، مثال: محفظة جوال بي 2" className="border-white/10 bg-[#0D1117] text-white" />
              <select value={accountType} onChange={(event) => setAccountType(event.target.value)} className="h-10 rounded-xl border border-white/10 bg-[#0D1117] px-3 text-sm text-white"><option value="cash">كاش</option><option value="jawwal_pay">جوال بي</option><option value="palpay">بال بي</option><option value="bank_of_palestine">بنك فلسطين</option><option value="other">حساب آخر</option></select>
              <Input dir="ltr" value={newPhone} onChange={(event) => setNewPhone(event.target.value)} placeholder="رقم الجوال المرتبط" className="border-white/10 bg-[#0D1117] text-white" />
              <label className="grid gap-1 text-xs text-slate-300"><span>الرصيد الافتتاحي (شيكل)</span><Input dir="ltr" type="number" min="0" step="0.01" value={createOpeningBalance} onChange={(event) => setCreateOpeningBalance(event.target.value)} className="border-white/10 bg-[#0D1117] text-white" /></label>
              <div className="rounded-xl border border-white/10 p-3 md:col-span-2"><p className="mb-2 text-sm font-bold text-white">الفروع المرتبطة</p><div className="flex flex-wrap gap-2">{(sites.data ?? []).map((site) => <label key={site.id} className="flex items-center gap-2 text-sm text-slate-300"><input type="checkbox" checked={selectedSites.includes(site.id)} onChange={(event) => setSelectedSites((current) => event.target.checked ? [...current, site.id] : current.filter((id) => id !== site.id))} />{site.name}</label>)}</div></div>
              <Button disabled={create.isPending} onClick={submitCreate} className="bg-emerald-600 font-bold text-white md:col-span-2">{create.isPending ? "جارٍ الإنشاء…" : "حفظ الحساب ورصيده الافتتاحي"}</Button>
            </CardContent>
          </Card>
        )}

        <div className="flex flex-wrap items-end gap-3 print:hidden">
          <select value={branchFilter} onChange={(event) => setBranchFilter(event.target.value)} className="h-10 rounded-xl border border-white/10 bg-[#111823] px-3 text-sm text-white"><option value="">كل الفروع</option>{(sites.data ?? []).map((site) => <option value={site.id} key={site.id}>{site.name}</option>)}</select>
          <label className="grid gap-1 text-xs text-slate-300"><span>من تاريخ</span><Input dir="ltr" type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} className="h-10 w-40 border-white/10 bg-[#111823] text-white" /></label>
          <label className="grid gap-1 text-xs text-slate-300"><span>إلى تاريخ</span><Input dir="ltr" type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} className="h-10 w-40 border-white/10 bg-[#111823] text-white" /></label>
          <Button variant="outline" onClick={() => { setBranchFilter(""); setFromDate(""); setToDate(""); }} className="border-white/15 text-white">مسح الفلاتر</Button>
          <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="بحث حسب اسم الحساب أو نوعه أو رقم الجوال" className="max-w-xl border-white/10 bg-[#111823] text-white" />
          <span className="text-sm text-slate-400">عرض {filtered.length} من {rows.length} حساب</span>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {filtered.map((account) => {
            const theme = accountTheme[account.accountType] ?? accountTheme.other;
            const BrandIcon = theme.icon;
            return <button key={account.id} onClick={() => selectAccount(account.id)} className={`rounded-2xl border p-5 text-right transition print:border-slate-300 print:bg-white ${theme.card} ${selected === account.id ? "ring-2 ring-[#F5B800] ring-offset-2 ring-offset-[#0D1117]" : "hover:brightness-110"}`}>
              <div className="flex items-center justify-between gap-3"><span className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-extrabold shadow-sm ${theme.badge}`}><BrandIcon className="h-4 w-4" />{theme.shortLabel}</span><span className="font-bold text-white print:text-black">{account.name}</span></div>
              <p className="mt-5 text-xs text-white/80 print:text-slate-600">الرصيد المتاح</p><p className="mt-1 text-2xl font-extrabold text-white print:text-slate-900">{money(Number(account.balance))} ش</p>
              <p className="mt-2 text-xs font-semibold text-white/90 print:text-slate-700">افتتاحي: {money(Number(account.openingBalance ?? 0))} ش</p>
              <p className="mt-2 text-xs font-semibold text-white/90 print:text-slate-700">النوع: {labels[account.accountType] ?? account.accountType}</p><p className="mt-2 text-xs text-white/80 print:text-slate-600">الجوال: {account.phoneNumber ?? "غير مرتبط"}</p>
            </button>;
          })}
        </div>

        <Card className="border-[#F5B800]/20 bg-[#F5B800]/5 print:border-slate-300 print:bg-white"><CardContent className="flex items-center justify-between p-5"><span className="font-bold text-white print:text-black">إجمالي السيولة المتاحة</span><strong className="text-2xl text-[#F5B800] print:text-black">{money(total)} ش</strong></CardContent></Card>

        {selectedAccount && <Card className="border-white/10 bg-[#111823] print:hidden"><CardContent className="flex flex-wrap items-end gap-3 p-4"><div className="min-w-52"><p className="font-bold text-white">تصفية كشف الحركات</p><p className="mt-1 text-xs text-slate-500">تنطبق الفلاتر على السجل والمخطط وملفي Excel وPDF.</p></div><label className="grid gap-1 text-xs text-slate-300"><span>من تاريخ</span><Input dir="ltr" type="date" value={movementFromDate} max={movementToDate || undefined} onChange={(event) => { setMovementFromDate(event.target.value); setTransactionPage(1); }} className="h-9 w-40 border-white/10 bg-[#0D1117] text-white" /></label><label className="grid gap-1 text-xs text-slate-300"><span>إلى تاريخ</span><Input dir="ltr" type="date" value={movementToDate} min={movementFromDate || undefined} onChange={(event) => { setMovementToDate(event.target.value); setTransactionPage(1); }} className="h-9 w-40 border-white/10 bg-[#0D1117] text-white" /></label><Button size="sm" variant="outline" onClick={() => { setMovementFromDate(""); setMovementToDate(""); setTransactionTypeFilter(""); setTransactionPage(1); }} className="border-white/15 text-white">مسح فلاتر الحركات</Button></CardContent></Card>}

        {selectedAccount && (
          <div className="grid gap-6 xl:grid-cols-[.8fr_1.2fr] print:hidden">
            <Card className="border-white/10 bg-[#111823]"><CardContent className="space-y-4 p-5">
              <div><h2 className="font-bold text-white">إدارة حساب {selectedAccount.name}</h2><p className="mt-1 text-sm font-semibold text-[#F5B800]">الرصيد المتاح للسحب أو التحويل: {money(Number(selectedAccount.balance))} ش</p></div>
              <div className="grid gap-2 rounded-xl border border-white/10 p-3 sm:grid-cols-[1fr_auto]"><label className="grid gap-1 text-xs text-slate-300"><span>الرصيد الافتتاحي (شيكل)</span><Input dir="ltr" type="number" min="0" step="0.01" value={openingBalance} onChange={(event) => setOpeningBalance(event.target.value)} className="border-white/10 bg-[#0D1117] text-white" /></label><Button className="self-end bg-[#F5B800] font-bold text-[#0D1117]" onClick={saveOpeningBalance} disabled={updateOpeningBalance.isPending}>حفظ الرصيد</Button></div>
              <div className="flex gap-2"><Input dir="ltr" value={newPhone} onChange={(event) => setNewPhone(event.target.value)} placeholder="رقم الجوال المرتبط بالحساب" className="border-white/10 bg-[#0D1117] text-white" /><Button onClick={() => updatePhone.mutate({ siteId, accountId: selectedAccount.id, phoneNumber: newPhone })} disabled={updatePhone.isPending} variant="outline" className="border-[#F5B800]/40 text-[#F5B800]">حفظ الجوال</Button></div>
              <div className="rounded-xl border border-white/10 p-3"><p className="mb-2 text-sm font-bold text-white">الفروع المرتبطة</p><div className="flex flex-wrap gap-2">{(sites.data ?? []).map((site) => <label key={site.id} className="flex items-center gap-2 text-sm text-slate-300"><input type="checkbox" checked={selectedSites.includes(site.id)} onChange={(event) => setSelectedSites((current) => event.target.checked ? [...current, site.id] : current.filter((id) => id !== site.id))} />{site.name}</label>)}</div><Button className="mt-3 bg-[#F5B800] font-bold text-[#0D1117]" onClick={() => updateSites.mutate({ siteId, accountId: selectedAccount.id, siteIds: selectedSites.length ? selectedSites : [siteId] })} disabled={updateSites.isPending}>حفظ الفروع المرتبطة</Button></div>
              <div className="rounded-xl border border-white/10 p-3"><p className="mb-3 text-sm font-bold text-white">حركة مالية جديدة</p><div className="grid grid-cols-3 gap-2"><Button onClick={() => setMode("deposit")} variant={mode === "deposit" ? "default" : "outline"} className={mode === "deposit" ? "bg-emerald-600 text-white" : "border-white/10 text-white"}><ArrowDownToLine className="ml-1 h-4 w-4" />إيداع</Button><Button onClick={() => setMode("withdrawal")} variant={mode === "withdrawal" ? "default" : "outline"} className={mode === "withdrawal" ? "bg-rose-700 text-white" : "border-white/10 text-white"}><ArrowUpFromLine className="ml-1 h-4 w-4" />سحب</Button><Button onClick={() => setMode("transfer")} variant={mode === "transfer" ? "default" : "outline"} className={mode === "transfer" ? "bg-sky-700 text-white" : "border-white/10 text-white"}><ArrowLeftRight className="ml-1 h-4 w-4" />تحويل</Button></div>
                {mode === "withdrawal" && <p className="mt-3 rounded-lg bg-rose-950/35 px-3 py-2 text-xs text-rose-100">سيُسجل السحب في كشف الحساب وسجل التدقيق، ولا يمكن أن يتجاوز الرصيد المتاح.</p>}
                {mode === "transfer" && <select value={target} onChange={(event) => setTarget(event.target.value)} className="mt-3 h-10 w-full rounded-xl border border-white/10 bg-[#0D1117] px-3 text-sm text-white"><option value="">الحساب المستقبِل</option>{rows.filter((row) => row.id !== selectedAccount.id).map((row) => <option value={row.id} key={row.id}>{row.name}</option>)}</select>}
                <div className="mt-3 grid gap-2"><Input dir="ltr" type="number" min="0.01" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="المبلغ بالشيكل" className="border-white/10 bg-[#0D1117] text-white" /><Input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="وصف الحركة، مثال: سحب مصروف تشغيلي" className="border-white/10 bg-[#0D1117] text-white" /><Button onClick={submitMovement} disabled={movement.isPending || transfer.isPending} className="w-full bg-[#F5B800] font-bold text-[#0D1117]">{mode === "withdrawal" ? "تسجيل السحب" : mode === "transfer" ? "تنفيذ التحويل" : "تسجيل الإيداع"}</Button></div>
              </div>
            </CardContent></Card>

            <Card className="border-white/10 bg-[#111823]"><CardContent className="p-5"><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-bold text-white">سجل الحركات الكامل</h2><div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={!transactionRows.length} onClick={() => void exportTransactionsExcel()} className="border-emerald-400/35 text-emerald-200">Excel</Button><Button size="sm" variant="outline" disabled={!transactionRows.length} onClick={exportTransactionsPdf} className="border-rose-400/35 text-rose-200">PDF</Button><select value={transactionTypeFilter} onChange={(event) => { setTransactionTypeFilter(event.target.value); setTransactionPage(1); }} className="h-9 rounded-lg border border-white/10 bg-[#0D1117] px-2 text-xs text-white"><option value="">كل العمليات</option><option value="collection">تحصيل</option><option value="deposit">إيداع</option><option value="withdrawal">سحب</option><option value="transfer_in">تحويل وارد</option><option value="transfer_out">تحويل صادر</option></select></div></div><div className="mt-4 h-52 rounded-xl border border-white/8 bg-white/[.015] p-3"><p className="mb-2 text-xs font-bold text-slate-300">تطور الرصيد بمرور الوقت</p><ResponsiveContainer width="100%" height="88%"><AreaChart data={balanceTimeline} margin={{ top: 6, right: 6, left: 0, bottom: 0 }}><defs><linearGradient id="accountBalanceFill" x1="0" x2="0" y1="0" y2="1"><stop offset="5%" stopColor="#F5B800" stopOpacity={0.35} /><stop offset="95%" stopColor="#F5B800" stopOpacity={0.03} /></linearGradient></defs><CartesianGrid stroke="rgba(255,255,255,.08)" vertical={false} /><XAxis dataKey="label" tick={{ fill: "#94a3b8", fontSize: 10 }} axisLine={false} tickLine={false} /><YAxis tick={{ fill: "#94a3b8", fontSize: 10 }} axisLine={false} tickLine={false} width={44} /><Tooltip formatter={(value) => [`${money(Number(value))} ش`, "الرصيد"]} contentStyle={{ background: "#111823", border: "1px solid rgba(255,255,255,.12)", borderRadius: 10, color: "#fff" }} /><Area type="monotone" dataKey="balance" stroke="#F5B800" strokeWidth={2} fill="url(#accountBalanceFill)" /></AreaChart></ResponsiveContainer></div><div className="mt-4 space-y-2">{transactionRows.length ? visibleTransactions.map((row) => <div className="flex items-center justify-between rounded-xl border border-white/8 px-3 py-3 text-sm" key={row.id}><div><p className="font-bold text-white">{row.description}</p><p className="mt-1 text-xs text-slate-500">{new Date(row.occurredAt).toLocaleString("ar")} · الرصيد التراكمي: {money(Number(cumulativeById.get(row.id) ?? 0))} ش</p></div><span className={row.transactionType === "withdrawal" || row.transactionType === "transfer_out" ? "text-rose-300" : "text-emerald-300"}>{row.transactionType === "withdrawal" || row.transactionType === "transfer_out" ? "−" : "+"}{money(Number(row.amount))}</span></div>) : <p className="py-10 text-center text-sm text-slate-500">لا توجد حركات مسجلة بعد.</p>}</div>{transactionRows.length > 0 && <div className="mt-4 flex items-center justify-between text-xs text-slate-400"><span>صفحة {transactionPage} من {pageCount} · {transactionRows.length} حركة</span><div className="flex gap-2"><Button size="sm" variant="outline" disabled={transactionPage === 1} onClick={() => setTransactionPage((page) => Math.max(1, page - 1))} className="border-white/10 text-white">السابق</Button><Button size="sm" variant="outline" disabled={transactionPage === pageCount} onClick={() => setTransactionPage((page) => Math.min(pageCount, page + 1))} className="border-white/10 text-white">التالي</Button></div></div>}</CardContent></Card>
          </div>
        )}
        <Dialog open={Boolean(pendingAction)} onOpenChange={(open) => !open && setPendingAction(null)}><DialogContent className="border-white/10 bg-[#111823] text-white"><DialogHeader><DialogTitle>{pendingAction?.kind === "withdrawal" ? "تأكيد عملية السحب" : "تأكيد التحويل بين الحسابات"}</DialogTitle></DialogHeader><div className="space-y-3 text-sm"><p className="text-slate-300">الحساب المصدر: <strong className="text-white">{selectedAccount?.name}</strong></p><p className="text-slate-300">المبلغ: <strong className="text-[#F5B800]">{money(pendingAction?.amount ?? 0)} ش</strong></p>{pendingAction?.kind === "transfer" ? <p className="text-slate-300">الحساب المستقبِل: <strong className="text-white">{rows.find((row) => row.id === pendingAction.targetAccountId)?.name ?? "—"}</strong></p> : null}<p className="rounded-lg bg-amber-400/10 p-3 text-xs leading-6 text-amber-100">سيُسجل الإجراء في كشف الحساب وسجل التدقيق. راجع البيانات قبل التأكيد.</p></div><DialogFooter><Button variant="outline" onClick={() => setPendingAction(null)} className="border-white/15 text-white">إلغاء</Button><Button onClick={confirmPendingAction} disabled={movement.isPending || transfer.isPending} className="bg-[#F5B800] font-bold text-[#0D1117]">تأكيد التنفيذ</Button></DialogFooter></DialogContent></Dialog>
      </div>
    </DashboardLayout>
  );
}
