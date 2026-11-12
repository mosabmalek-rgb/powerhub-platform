import { useAuth } from "@/_core/hooks/useAuth";
import DashboardLayout from "@/components/DashboardLayout";
import { formatReportDate, formatReportPeriod, REPORT_PAYMENT_METHOD_LABELS, REPORT_PAYMENT_METHOD_OPTIONS } from "@/lib/report-design-system";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import { BarChart3, CalendarRange, CircleDollarSign, Download, FileText, Loader2, Receipt, TrendingUp, RefreshCw, Wallet, Landmark, UsersRound, Truck, HandCoins, Package, ShieldCheck } from "lucide-react";
import { downloadReportHtmlAsPdf, escapeHtml } from "@/lib/report-pdf";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import AccrualAccountingPanel from "@/components/finance/AccrualAccountingPanel";
import FinancialGLAuditPanel from "@/components/finance/FinancialGLAuditPanel";

const format = (value: unknown) => Number(value ?? 0).toLocaleString("ar", { maximumFractionDigits: 2 });
const iso = (date: Date) => {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Gaza", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
};
const dateKey = (value: unknown) => {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? "" : iso(date);
};
const payrollReconciliationDescriptions: Record<string,string> = {
  MISSING_NET_PAYROLL_EXPENSE:"لا يوجد قيد مصروف لصافي رواتب كشف تم صرفه",
  NET_PAYROLL_EXPENSE_MISMATCH:"قيمة مصروف الرواتب لا تطابق صافي كشف الرواتب",
  MISSING_PAYROLL_CASH_MOVEMENT:"لا توجد حركة سحب نقدي مرتبطة بكشف رواتب مصروف",
  PAYROLL_CASH_MOVEMENT_MISMATCH:"حركة سحب الرواتب لا تطابق المبلغ أو المصروف أو حساب الدفع",
  PAYROLL_POSTING_BEFORE_PAYMENT:"يوجد مصروف أو حركة نقدية لكشف رواتب غير مصروف",
  FULLY_DEDUCTED_APPROVED_PAYROLL_REQUIRES_REVIEW:"كشف معتمد بصافي صفر يحتاج إلى مراجعة تصنيف الخصومات",
};
const presets = [{ id: "today", label: "اليوم" }, { id: "current_cycle", label: "هذه الدورة" }, { id: "month_end", label: "آخر الشهر" }, { id: "custom", label: "مخصص" }] as const;

export default function FinancialDashboardPage() {
  const { isAuthenticated, loading } = useAuth();
  const sites = trpc.powerhub.sites.list.useQuery(undefined, { enabled: isAuthenticated });
  const [selectedSiteId, setSelectedSiteId] = useState<number | null>(null);
  const siteId = (selectedSiteId && sites.data?.some(site => site.id === selectedSiteId) ? selectedSiteId : sites.data?.[0]?.id) ?? 0;
  // The ordinary one-branch experience never issues the multi-branch query.
  const [showAllBranches, setShowAllBranches] = useState(false);
  const tenantSites = useMemo(() => {
    const current = sites.data?.find(site => site.id === siteId);
    return (sites.data ?? []).filter(site =>
      current && site.tenantId === current.tenantId && site.status !== "archived"
    );
  }, [sites.data, siteId]);
  const multiBranchAccess=trpc.powerhub.sites.multiBranchAccess.useQuery({siteId},{
    enabled:Boolean(isAuthenticated && siteId),staleTime:60_000,
    refetchOnReconnect:true,refetchOnWindowFocus:false,
  });
  const hasMultipleBranches = multiBranchAccess.isSuccess &&
    multiBranchAccess.data?.enabled===true &&
    multiBranchAccess.data?.siteId===siteId && tenantSites.length>1;
  const allBranchesPosition = trpc.powerhub.reports.allSitesCurrentPosition.useQuery({ siteId }, {
    enabled: Boolean(isAuthenticated && siteId && hasMultipleBranches && showAllBranches),
    staleTime: 120_000, refetchOnWindowFocus: false, refetchOnReconnect: true,
  });
  useEffect(() => {
    // Switching to an unrelated tenant or a single-site tenant removes the aggregate view.
    setShowAllBranches(false);
  }, [siteId]);
  const [preset, setPreset] = useState<"today" | "current_cycle" | "month_end" | "custom">("current_cycle");
  const [paymentMethod, setPaymentMethod] = useState("all");
  const currentPosition = trpc.powerhub.reports.currentPosition.useQuery({ siteId }, {
    enabled: Boolean(siteId && isAuthenticated), staleTime: 120_000, refetchOnWindowFocus: false,
    refetchOnReconnect: true,
  });
  const [startDate, setStartDate] = useState(() => { const d = new Date(); d.setDate(d.getDate() - 29); return iso(d); });
  const [endDate, setEndDate] = useState(() => iso(new Date()));
  const cycleBoundsQuery = trpc.powerhub.readingCycle.currentBounds.useQuery({ siteId }, { enabled: Boolean(siteId && isAuthenticated) });
  useEffect(() => {
    if (preset !== "current_cycle" || !cycleBoundsQuery.data) return;
    const start = dateKey(cycleBoundsQuery.data.startAt);
    const end = dateKey(cycleBoundsQuery.data.endAt);
    if (start && end && start <= end && (startDate !== start || endDate !== end)) {
      setStartDate(start);
      setEndDate(end);
    }
  }, [preset, cycleBoundsQuery.data, startDate, endDate]);
  const cycleRangeReady = preset !== "current_cycle" || Boolean(cycleBoundsQuery.data && dateKey(cycleBoundsQuery.data.startAt) === startDate && dateKey(cycleBoundsQuery.data.endAt) === endDate);
  const cashFlow = trpc.powerhub.reports.cashFlow.useQuery({ siteId, startDate, endDate }, {
    enabled: Boolean(siteId && isAuthenticated && startDate && endDate && startDate <= endDate && cycleRangeReady),
    staleTime: 60_000, refetchOnWindowFocus: false,
  });
  // Previous adjacent calendar period: same inclusive number of days, not a month approximation.
  const [showCashComparison, setShowCashComparison] = useState(false);
  const previousCashPeriod = useMemo(() => {
    const start = Date.parse(`${startDate}T00:00:00Z`);
    const end = Date.parse(`${endDate}T00:00:00Z`);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
    const duration = end - start + 86_400_000;
    const toDate = (timestamp: number) => new Date(timestamp).toISOString().slice(0, 10);
    return { startDate: toDate(start - duration), endDate: toDate(start - 86_400_000) };
  }, [startDate, endDate]);
  const priorCashFlow = trpc.powerhub.reports.cashFlow.useQuery({
    siteId, startDate: previousCashPeriod?.startDate ?? startDate,
    endDate: previousCashPeriod?.endDate ?? endDate,
  }, {
    enabled: Boolean(showCashComparison && previousCashPeriod && siteId && isAuthenticated && cycleRangeReady),
    staleTime: 60_000, refetchOnWindowFocus: false,
  });
  // Cash-flow trend is optional and never fetched during ordinary dashboard navigation.
  const [showCashTrend, setShowCashTrend] = useState(false);
  const cashFlowTrend = trpc.powerhub.reports.cashFlowTrend.useQuery({ siteId, endDate }, {
    enabled: Boolean(showCashTrend && siteId && isAuthenticated && endDate && startDate <= endDate && cycleRangeReady),
    staleTime: 120_000, refetchOnWindowFocus: false,
  });
  const [showAccrualAccounting, setShowAccrualAccounting] = useState(false);
  const [showGLAudit, setShowGLAudit] = useState(false);
  const [showAccrualBridge, setShowAccrualBridge] = useState(false);
  const [showServiceCycleBilling, setShowServiceCycleBilling] = useState(false);
  const serviceCycleBilling = trpc.powerhub.reports.serviceCycleBillingReview.useQuery({
    siteId,startDate,endDate,
  },{
    enabled:Boolean(isAuthenticated && siteId && showAccrualBridge && showServiceCycleBilling &&
      cycleRangeReady && startDate <= endDate),
    staleTime:120_000,refetchOnWindowFocus:false,
  });
  const [showPayrollReview, setShowPayrollReview] = useState(false);
  const payrollPeriod = endDate.slice(0, 7);
  const payrollReview = trpc.powerhub.reports.payrollAccrualReview.useQuery({
    siteId,period:payrollPeriod,
  },{
    enabled: Boolean(showPayrollReview && isAuthenticated && siteId && /^\d{4}-(0[1-9]|1[0-2])$/.test(payrollPeriod) && cycleRangeReady),
    staleTime:120_000,refetchOnWindowFocus:false,
  });
  const report = trpc.powerhub.reports.range.useQuery({ siteId, startDate, endDate, paymentMethod }, { enabled: Boolean(siteId && isAuthenticated && startDate && endDate && startDate <= endDate && cycleRangeReady), staleTime: 60_000, refetchOnWindowFocus: false });
  const branding = trpc.powerhub.reportBranding.get.useQuery({ siteId }, { enabled: false, staleTime: 300_000 });
  const settlements = trpc.powerhub.settlements.list.useQuery({ siteId }, { enabled: false, staleTime: 300_000 });
  const discounts = trpc.powerhub.siteBillingPolicy.discountSummary.useQuery({ siteId, startDate, endDate }, { enabled: Boolean(siteId && isAuthenticated && startDate && endDate && startDate <= endDate && cycleRangeReady), staleTime: 60_000, refetchOnWindowFocus: false });
  const data = report.data;
  const collectionToBillingRatio = data?.summary.invoiced ? (data.summary.collected / data.summary.invoiced) * 100 : null;
  const ratioLabel = collectionToBillingRatio === null ? "غير قابل للحساب" : `${collectionToBillingRatio.toFixed(1)}%`;
  const applyPreset = async (id: typeof preset) => {
    setPreset(id);
    if (id === "custom") return;
    if (id === "current_cycle") {
      let bounds = cycleBoundsQuery.data;
      if (!bounds) {
        const result = await cycleBoundsQuery.refetch();
        bounds = result.data;
      }
      if (!bounds) { toast.error("تعذر تحديد حدود دورة الفوترة الحالية."); return; }
      const start = dateKey(bounds.startAt);
      const end = dateKey(bounds.endAt);
      if (!start || !end || start > end) { toast.error("حدود دورة الفوترة غير صالحة."); return; }
      setStartDate(start); setEndDate(end); return;
    }
    const now = new Date();
    if (id === "today") { const today = iso(now); setStartDate(today); setEndDate(today); return; }
    const year = Number(iso(now).slice(0, 4));
    const month = Number(iso(now).slice(5, 7));
    setStartDate(`${year}-${String(month).padStart(2, "0")}-01`);
    setEndDate(new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10));
  };
  const exportAdminPdf = async () => {
    if (!data) return;
    // Historical settlements and branding are needed only for export.
    // Do not fetch them on every financial dashboard visit.
    const [brandResponse, settlementResponse] = await Promise.all([
      branding.refetch(), settlements.refetch(),
    ]);
    if (brandResponse.isError || settlementResponse.isError) {
      toast.error("تعذر جلب تفاصيل التقرير الإداري؛ لم يُنشأ ملف ناقص.");
      return;
    }
    const wrapper = document.createElement("div");
    wrapper.dir = "rtl";
    wrapper.style.cssText = "position:fixed;left:-10000px;top:0;width:1100px;padding:42px;background:#fff;color:#111;font-family:Tajawal,Arial,sans-serif";
    const monthly = Array.from((settlementResponse.data ?? []).reduce((map, row) => {
      const key = new Date(row.periodStart).toISOString().slice(0, 7);
      const item = map.get(key) ?? { collected: 0, expenses: 0 };
      item.collected += Number(row.totalCollected);
      item.expenses += Number(row.totalExpenses);
      map.set(key, item);
      return map;
    }, new Map<string, { collected: number; expenses: number }>()).entries()).slice(-6)
      .map(([month, item]) => `<tr><td>${escapeHtml(month)}</td><td>${format(item.collected)} شيكل</td><td>${format(item.expenses)} شيكل</td></tr>`)
      .join("");
    const collectorRows = (data.collectors ?? []).map((item) => `<tr><td>${escapeHtml(item.name)}</td><td>${item.count}</td><td>${format(item.amount)} شيكل</td></tr>`).join("");
    const debtorRows = (data.topDebtors ?? []).slice(0, 10).map((item) => `<tr><td>${escapeHtml(item.subscriber)}</td><td>${escapeHtml(item.invoiceNo)}</td><td>${format(item.balanceDue)} شيكل</td><td>${escapeHtml(formatReportDate(item.dueDate))}</td></tr>`).join("");
    wrapper.innerHTML = `
      <h1 style="border-bottom:3px solid #f5b800;padding-bottom:18px">${escapeHtml(brandResponse.data?.companyName ?? "PowerHub")} — التقرير الإداري المالي</h1>
      <p>الفترة: ${escapeHtml(formatReportPeriod(startDate, endDate))}</p>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px">
        <div style="border:1px solid #ccc;padding:14px">التحصيل<br><b>${format(data.summary.collected)} شيكل</b></div>
        <div style="border:1px solid #ccc;padding:14px">المصروفات التشغيلية<br><b>${format(data.summary.expenseTotal)} شيكل</b></div>
        <div style="border:1px solid #ccc;padding:14px">فائض التحصيل بعد المصروفات<br><b>${format(data.summary.operatingProfit)} شيكل</b></div>
        <div style="border:1px solid #ccc;padding:14px">التحصيل مقابل فوترة الفترة<br><b>${ratioLabel}</b></div>
      </div>
      <p>المصروفات المباشرة التشغيلية: ${format(data.summary.directExpenseTotal)} شيكل · صافي تكلفة استهلاك المخزون: ${format(data.summary.inventoryConsumptionCost)} شيكل · المصروفات غير التشغيلية: ${format(data.summary.nonOperatingExpenseTotal)} شيكل · إجمالي المصروفات: ${format(data.summary.allExpenseTotal)} شيكل</p>
      <p>الشراء للمخزون وسداد المورد لا يُحتسبان مصروفًا تشغيليًا عند الدفع؛ يُحتسب الاستهلاك المؤهل فقط.</p>
      <h2>التحصيل والمصروفات شهريًا</h2>
      <table style="width:100%;border-collapse:collapse;text-align:right"><thead><tr style="background:#0d1117;color:#fff"><th>الشهر</th><th>التحصيل</th><th>المصروفات</th></tr></thead><tbody>${monthly || "<tr><td colspan=\"3\">لا توجد تسويات شهرية مسجلة.</td></tr>"}</tbody></table>
      <h2>أداء المحصلين</h2>
      <table style="width:100%;border-collapse:collapse;text-align:right"><thead><tr style="background:#0d1117;color:#fff"><th>المحصل</th><th>عدد الدفعات</th><th>قيمة التحصيل</th></tr></thead><tbody>${collectorRows}</tbody></table>
      <h2>أعلى الأرصدة المستحقة</h2>
      <table style="width:100%;border-collapse:collapse;text-align:right"><thead><tr style="background:#0d1117;color:#fff"><th>المشترك</th><th>الفاتورة</th><th>الرصيد</th><th>الاستحقاق</th></tr></thead><tbody>${debtorRows}</tbody></table>`;
    document.body.appendChild(wrapper);
    try {
      await downloadReportHtmlAsPdf(wrapper, `التقرير-الإداري-${startDate}-${endDate}.pdf`, { landscape: true, title: "التقرير الإداري المالي - PowerHub" });
      toast.success("تم إنشاء التقرير الإداري PDF باللغة العربية.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "تعذر إنشاء التقرير الإداري PDF.");
    } finally {
      wrapper.remove();
    }
  };
  const exportCurrentPositionCsv = () => {
    if (!currentPosition.data || currentPosition.isError || currentPosition.isFetching) {
      toast.error("تعذر التحقق من حداثة المركز المالي الحالي؛ لم يُنشأ التصدير.");
      return;
    }
    const snapshot = currentPosition.data;
    const rows: (string | number)[][] = [
      ["المركز المالي الحالي — عرض مكونات وليس ميزانية عمومية مكتملة", "القيمة بالشيكل"],
      ["تاريخ اللقطة", snapshot.asOf],
      ["رقم الفرع", siteId],
      ["أرصدة الحسابات المرتبطة بالفرع", snapshot.cashBalance],
      ["ديون المشتركين القائمة", snapshot.subscriberReceivables],
      ["مستحقات الموردين", snapshot.supplierPayables],
      ["دفعات مقدمة للموردين", snapshot.supplierPrepayments],
      ["سلف الموظفين القائمة", snapshot.employeeAdvances],
      ["قيمة المخزون الحالية بالتكلفة", snapshot.inventoryValue],
      ["أرصدة دائنة للمشتركين", snapshot.subscriberCreditLiability],
      ["تأمينات المشتركين", snapshot.securityDepositLiability],
      ["الرواتب المعتمدة غير المدفوعة", snapshot.approvedPayrollPayable],
      ["عدد الحسابات غير الحصرية", snapshot.sharedAccountCount],
      [],
      ["الحساب", "الرصيد بالشيكل", ...(hasMultipleBranches ? ["مشترك بين الفروع"] : [])],
      ...snapshot.accounts.map((account) => [account.name, account.balance, ...(hasMultipleBranches ? [account.shared ? "نعم" : "لا"] : [])]),
    ];
    const csv = rows.map(row => row.map(cell => `"${String(cell ?? "").replaceAll('"', '""')}"`).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `المركز-المالي-الفرع-${siteId}-${iso(new Date())}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
    toast.success("تم تصدير لقطة المركز المالي الحالي.");
  };
  const exportCsv = () => { if (!data) return; const rows = [["المؤشر", "القيمة"], ["الفترة", `${startDate} إلى ${endDate}`], ["إجمالي الفوترة", data.summary.invoiced], ["إجمالي المحصل", data.summary.collected], ["إجمالي المصروفات التشغيلية", data.summary.expenseTotal], ["المصروفات المباشرة التشغيلية", data.summary.directExpenseTotal], ["المصروفات غير التشغيلية", data.summary.nonOperatingExpenseTotal], ["إجمالي المصروفات جميعها", data.summary.allExpenseTotal], ["تكلفة استهلاك المخزون", data.summary.inventoryConsumptionCost], ["فائض التحصيل بعد المصروفات", data.summary.operatingProfit], ["الأرصدة المستحقة", data.summary.outstanding], ["الطاقة بالكيلوواط", data.summary.energyKwh], ["التحصيل مقابل فوترة الفترة", collectionToBillingRatio === null ? "غير قابل للحساب" : `${collectionToBillingRatio.toFixed(2)}%`], [], ["المحصل", "عدد العمليات", "المبلغ"], ...(data.collectors ?? []).map((item) => [item.name, item.count, item.amount])]; const csv = rows.map((row) => row.map((cell) => `"${String(cell ?? "").replaceAll('"', '""')}"`).join(",")).join("\n"); const url = URL.createObjectURL(new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" })); const anchor = document.createElement("a"); anchor.href = url; anchor.download = `التقرير-المالي-${startDate}-${endDate}.csv`; anchor.click(); URL.revokeObjectURL(url); toast.success("تم تصدير التقرير المالي."); };
  if (loading) return <DashboardLayout><div className="grid min-h-[60vh] place-items-center"><Loader2 className="h-7 w-7 animate-spin text-[#F5B800]" /></div></DashboardLayout>;
  if (!isAuthenticated) return <DashboardLayout><div className="p-8 text-center text-white">سجّل الدخول للوصول إلى لوحة المالية.</div></DashboardLayout>;
  return <DashboardLayout><main className="space-y-6 pb-12" dir="rtl">
    <section aria-labelledby="financial-current-title" className="rounded-2xl border border-[#F5B800]/25 bg-[#111823] p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-[#F5B800]"><Landmark className="h-5 w-5" />
            <h2 id="financial-current-title" className="text-lg font-bold">المركز المالي الحالي</h2></div>
          <p className="mt-1 text-xs text-slate-300">أرصدة حالية لا تتأثر بفلتر اليوم أو الدورة أو الشهر. العملة: شيكل.</p>
          {currentPosition.data?.asOf ? <p className="mt-2 text-xs text-slate-400">آخر لقطة: {formatReportDate(currentPosition.data.asOf)}</p> : null}
        </div>
        <div className="flex flex-wrap items-end gap-2">
          {hasMultipleBranches ? <label className="text-xs text-slate-300">الفرع
            <select aria-label="فرع المركز المالي" className="mt-1 block min-w-36 rounded-lg border border-white/15 bg-[#0D1117] px-2 py-2 text-white"
              value={siteId} onChange={(event) => setSelectedSiteId(Number(event.target.value))}>
              {tenantSites.map(site => <option key={site.id} value={site.id}>{site.name}</option>)}
            </select>
          </label> : null}
          <Button size="sm" variant="outline" onClick={exportCurrentPositionCsv}
            disabled={!siteId || !currentPosition.data || currentPosition.isError || currentPosition.isFetching}
            className="border-white/20 text-white">
            <Download className="ml-2 h-4 w-4" />تصدير المركز المالي
          </Button>
          <Button size="sm" variant="outline" disabled={!siteId || currentPosition.isFetching}
            className="border-white/20 text-white" onClick={() => void currentPosition.refetch()}>
            {currentPosition.isFetching ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <RefreshCw className="ml-2 h-4 w-4" />}
            تحديث الأرصدة
          </Button>
        </div>
      </div>
      {currentPosition.isError ? <div role="alert" className="mt-4 rounded-lg border border-rose-400/30 p-3 text-sm text-rose-200">
        تعذر التحقق من الأرصدة الحالية. لا تُعرض أرقام صفرية بدلاً من البيانات المفقودة.
        <Button size="sm" variant="outline" className="mr-2 text-white" onClick={() => void currentPosition.refetch()}>إعادة المحاولة</Button>
      </div> : null}
      {currentPosition.isLoading ? <div role="status" className="mt-4 flex items-center gap-2 text-sm text-slate-300"><Loader2 className="h-4 w-4 animate-spin" />جارٍ التحقق من الأرصدة الحالية…</div> : null}
      {!currentPosition.isError && currentPosition.data ? <>
        <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {([
            {label:"أرصدة الحسابات المتاحة",amount:currentPosition.data.cashBalance,Icon:Wallet,help:"تشمل الحسابات المشتركة المرتبطة بالفرع"},
            {label:"ديون المشتركين القائمة",amount:currentPosition.data.subscriberReceivables,Icon:UsersRound,help:"جميع الفواتير غير المسددة حتى الآن"},
            {label:"مستحقات الموردين",amount:currentPosition.data.supplierPayables,Icon:Truck,help:"صافي أرصدة الموردين الدائنة"},
            {label:"السلف القائمة للموظفين",amount:currentPosition.data.employeeAdvances,Icon:HandCoins,help:"مبالغ لم تُسوَّ بعد، وليست مصروفاً"},
            {label:"قيمة المخزون الحالية",amount:currentPosition.data.inventoryValue,Icon:Package,help:"تكلفة الرصيد المتبقي في مواقع الفرع، لا تكلفة المشتريات خلال الفترة"},
            {label:"أرصدة دائنة للمشتركين",amount:currentPosition.data.subscriberCreditLiability,Icon:UsersRound,help:"مبالغ للمشتركين لم تُطبق أو تُرد بعد"},
            {label:"تأمينات المشتركين",amount:currentPosition.data.securityDepositLiability,Icon:ShieldCheck,help:"التزام قابل للرد أو التسوية، وليس إيراداً"},
            {label:"رواتب معتمدة غير مدفوعة",amount:currentPosition.data.approvedPayrollPayable,Icon:HandCoins,help:"المسيرات المعتمدة فقط؛ المسودات غير مستحقة هنا"},
          ] as const).map(({label,amount,Icon,help}) => <Card key={label} className="border-white/10 bg-[#0D1117]">
            <CardContent className="p-4"><div className="flex items-center gap-2 text-slate-300">
              <Icon className="h-4 w-4" /><span className="text-sm font-medium">{label}</span></div>
              <p className="mt-3 text-2xl font-extrabold text-white">{format(amount)} شيكل</p>
              <p className="mt-2 text-xs text-slate-400">{help}</p></CardContent></Card>)}
        </div>
        {currentPosition.data.sharedAccountCount > 0 ? <p className="mt-3 text-xs text-amber-200">
          {hasMultipleBranches ? <>تنبيه: {format(currentPosition.data.sharedAccountCount)} من حسابات الشركة مشتركة أو متاحة لأكثر من فرع؛ مجموع الأرصدة ليس نقدية مستقلة لهذا الفرع، ولا يجوز جمعه مرة أخرى في تقرير فروع آخر.</> : <>تنبيه: توجد حسابات غير حصرية ضمن الأرصدة المعروضة؛ تجنب مضاعفة احتساب مبالغها.</>}
        </p> : null}
        <details className="mt-3 rounded-lg border border-white/10 p-3">
          <summary className="cursor-pointer text-sm font-semibold text-white">
            تفاصيل {format(currentPosition.data.accountCount)} حساباً · دفعات مقدمة للموردين: {format(currentPosition.data.supplierPrepayments)} شيكل
          </summary>
          <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {currentPosition.data.accounts.map(account => <div key={account.id} className="flex justify-between gap-3 rounded-lg bg-[#0D1117] p-3 text-sm">
              <span className="text-slate-200">{account.name}{account.shared ? " (مشترك)" : ""}</span>
              <strong className="text-white">{format(account.balance)} شيكل</strong>
            </div>)}
          </div>
        </details>
      </> : null}
    </section>
    {hasMultipleBranches ? <section aria-labelledby="all-branches-title" className="rounded-2xl border border-white/10 bg-[#111823] p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="all-branches-title" className="text-lg font-bold text-white">المركز المالي لجميع الفروع المخوّلة</h2>
          <p className="mt-1 text-xs text-slate-300">عرض اختياري للاشتراكات متعددة الفروع. تُحتسب الحسابات المشتركة مرة واحدة، ولا تتأثر الأرصدة بفلتر الفترة.</p>
        </div>
        <Button size="sm" variant="outline" className="border-white/20 text-white"
          onClick={() => setShowAllBranches(value => !value)}>
          {showAllBranches ? "إخفاء التجميع" : "عرض جميع الفروع"}
        </Button>
      </div>
      {showAllBranches ? <>
        {allBranchesPosition.isLoading ? <p role="status" className="mt-4 text-sm text-slate-300">جارٍ تجميع الأرصدة المخوّلة…</p> : null}
        {allBranchesPosition.isError ? <div role="alert" className="mt-4 text-sm text-rose-200">
          تعذر تحميل مركز جميع الفروع؛ لم يُعرض إجمالي جزئي أو غير موثوق.
          <Button size="sm" variant="outline" className="mr-2 text-white" onClick={() => void allBranchesPosition.refetch()}>إعادة المحاولة</Button>
        </div> : null}
        {allBranchesPosition.data && !allBranchesPosition.isError ? <>
          <p className="mt-4 text-xs text-amber-200">
            يشمل {format(allBranchesPosition.data.branchCount)} فروع مخوّلة فقط؛ ولا يمثّل ميزانية عمومية مكتملة.
            أرصدة الحسابات المشتركة مُجمّعة دون تكرار.
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {([
              {label:"أرصدة الحسابات (دون تكرار)",value:allBranchesPosition.data.cashBalance},
              {label:"ديون المشتركين",value:allBranchesPosition.data.subscriberReceivables},
              {label:"مستحقات الموردين",value:allBranchesPosition.data.supplierPayables},
              {label:"قيمة المخزون بالتكلفة",value:allBranchesPosition.data.inventoryValue},
              {label:"سلف الموظفين",value:allBranchesPosition.data.employeeAdvances},
              {label:"دفعات مقدمة للموردين",value:allBranchesPosition.data.supplierPrepayments},
              {label:"أرصدة المشتركين الدائنة",value:allBranchesPosition.data.subscriberCreditLiability},
              {label:"التأمينات المحتجزة",value:allBranchesPosition.data.securityDepositLiability},
              {label:"الرواتب المستحقة",value:allBranchesPosition.data.approvedPayrollPayable},
            ] as const).map(item => <div key={item.label} className="rounded-lg border border-white/10 bg-[#0D1117] p-4">
              <p className="text-xs text-slate-300">{item.label}</p>
              <strong className="mt-2 block text-xl text-white">{format(item.value)} شيكل</strong>
            </div>)}
          </div>
          <details className="mt-4 rounded-lg border border-white/10 p-3">
            <summary className="cursor-pointer text-sm font-bold text-white">مقارنة الفروع المخوّلة</summary>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[550px] text-right text-sm">
                <thead className="text-slate-300"><tr><th className="p-2">الفرع</th><th className="p-2">ديون المشتركين</th><th className="p-2">المخزون</th><th className="p-2">مستحقات الموردين</th></tr></thead>
                <tbody>{allBranchesPosition.data.branches.map(branch => <tr key={branch.siteId} className="border-t border-white/10 text-white">
                  <td className="p-2">{branch.siteName}</td><td className="p-2">{format(branch.subscriberReceivables)}</td>
                  <td className="p-2">{format(branch.inventoryValue)}</td><td className="p-2">{format(branch.supplierPayables)}</td>
                </tr>)}</tbody>
              </table>
            </div>
          </details>
        </> : null}
      </> : null}
    </section> : null}
    <header className="rounded-2xl border border-[#F5B800]/20 bg-[#111823] p-6"><div className="flex flex-wrap items-start justify-between gap-4"><div><div className="flex items-center gap-2 text-[#F5B800]"><BarChart3 className="h-5 w-5" /><span className="font-bold">الإدارة المالية</span></div><h1 className="mt-2 text-2xl font-extrabold text-white">الأداء المالي خلال الفترة</h1><p className="mt-2 text-sm text-slate-400">أداء التحصيل والمصروفات خلال الفترة المختارة. الأرصدة الحالية أعلاه لا تتغير بتغيير الفترة.</p></div><div className="flex flex-wrap gap-2"><Button onClick={exportCsv} disabled={!data || report.isError} variant="outline" className="border-white/15 text-white"><Download className="ml-2 h-4 w-4" />تصدير CSV</Button><Button onClick={exportAdminPdf} disabled={!data} variant="outline" className="border-[#F5B800]/40 text-[#F5B800]"><FileText className="ml-2 h-4 w-4" />تقرير مالي إداري</Button></div></div><div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <div className="flex flex-wrap items-center gap-2 xl:col-span-4"><CalendarRange className="h-4 w-4 text-slate-400" />{presets.map((item) => <Button key={item.id} size="sm" variant={preset === item.id ? "default" : "outline"} onClick={() => void applyPreset(item.id)} className={preset === item.id ? "bg-[#F5B800] text-[#0D1117]" : "border-white/15 text-white"}>{item.label}</Button>)}</div>
      {preset === "custom" ? <><label className="text-xs text-slate-400">من تاريخ<Input aria-label="بداية فترة الإحصاء المالي" type="date" value={startDate} max={endDate || undefined} onChange={(event) => setStartDate(event.target.value)} className="mt-1 h-9 w-full border-white/10 bg-[#0D1117] text-white" /></label><label className="text-xs text-slate-400">إلى تاريخ<Input aria-label="نهاية فترة الإحصاء المالي" type="date" value={endDate} min={startDate || undefined} onChange={(event) => setEndDate(event.target.value)} className="mt-1 h-9 w-full border-white/10 bg-[#0D1117] text-white" /></label></> : <div className="flex items-end text-xs text-slate-400">الفترة: <span className="mr-1 font-semibold text-white">{startDate} — {endDate}</span></div>}
      <label className="text-xs text-slate-400">طريقة التحصيل<select aria-label="فلترة الإحصاءات حسب طريقة التحصيل" value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value)} className="mt-1 h-9 w-full rounded-md border border-white/10 bg-[#0D1117] px-3 text-sm text-white">{REPORT_PAYMENT_METHOD_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
    </div></header>
    {report.isError ? <div role="alert" className="rounded-xl border border-rose-400/30 p-4 text-rose-200">تعذر تحميل تقرير الفترة.
      <Button size="sm" variant="outline" className="mr-3 text-white" onClick={() => void report.refetch()}>إعادة المحاولة</Button>
    </div> : null}
    {report.isLoading || (preset === "current_cycle" && cycleBoundsQuery.isLoading) ? <div role="status" className="flex items-center gap-2 rounded-xl border border-white/10 bg-[#111823] p-4 text-sm text-slate-300"><Loader2 className="h-4 w-4 animate-spin" />جارٍ تحميل أداء الفترة دون إيقاف المركز المالي الحالي…</div> : null}
    <section aria-labelledby="cashflow-period-title" className="rounded-xl border border-white/10 bg-[#111823] p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h2 id="cashflow-period-title" className="text-lg font-bold text-white">التدفق النقدي خلال الفترة</h2>
          <p className="mt-1 text-xs text-slate-400">حركات النقد المسندة للفرع فقط؛ لا تشمل التحويلات بين حسابات الشركة أو الحركات غير المنسوبة للفرع. الإيداعات ليست بالضرورة إيرادات.</p></div>
        <Button size="sm" variant="outline" className="border-white/20 text-white" disabled={cashFlow.isFetching || !siteId}
          onClick={() => void cashFlow.refetch()}>
          {cashFlow.isFetching ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <RefreshCw className="ml-2 h-4 w-4" />}
          تحديث الحركة
        </Button>
      </div>
      {cashFlow.isError ? <div role="alert" className="mt-3 text-sm text-rose-200">{cashFlow.error?.message || "تعذر التحقق من التدفقات النقدية؛ لا نعرض أرقاماً افتراضية."}
        <Button size="sm" variant="outline" className="mr-2 text-white" onClick={() => void cashFlow.refetch()}>إعادة المحاولة</Button>
      </div> : null}
      {cashFlow.isLoading ? <p role="status" className="mt-3 text-sm text-slate-300">جارٍ جمع الحركات النقدية للفترة…</p> : null}
      {cashFlow.data && !cashFlow.isError ? <div className="mt-4 grid gap-3 sm:grid-cols-3">
        {([
          {name:"نقد وارد من خارج الحسابات",value:cashFlow.data.externalCashIn},
          {name:"نقد صادر إلى خارج الحسابات",value:cashFlow.data.externalCashOut},
          {name:"صافي التدفق النقدي",value:cashFlow.data.netCashFlow},
        ] as const).map(row=><div key={row.name} className="rounded-lg border border-white/10 bg-[#0D1117] p-3">
          <p className="text-xs text-slate-300">{row.name}</p>
          <strong className="mt-2 block text-xl text-white">{format(row.value)} شيكل</strong>
        </div>)}
      </div> : null}
      {cashFlow.data && !cashFlow.isError && cashFlow.data.fixtureExcludedMovements > 0 ? (
        <p role="status" className="mt-3 rounded-lg border border-amber-400/30 bg-amber-400/10 p-3 text-xs text-amber-100">
          استُبعدت {format(cashFlow.data.fixtureExcludedMovements)} حركة أداء تجريبية بعد التحقق من بصمتها وموافقة مراجعة مستقلة.
          التقرير نقدي تشغيلي، وليس شهادة محاسبية نهائية.
        </p>
      ) : null}
      <div className="mt-4 border-t border-white/10 pt-4">
        <Button size="sm" variant="outline" className="border-white/20 text-white"
          onClick={() => setShowCashComparison((value) => !value)}
          disabled={!previousCashPeriod || !siteId}>
          <BarChart3 className="ml-2 h-4 w-4" />
          {showCashComparison ? "إخفاء المقارنة" : "مقارنة التدفق بالفترة السابقة"}
        </Button>
        {showCashComparison && previousCashPeriod ? <div className="mt-4 space-y-3">
          <p className="text-xs text-slate-300">
            مقارنة مع فترة مساوية في عدد الأيام: {previousCashPeriod.startDate} — {previousCashPeriod.endDate}.
            المقارنة نقدية وليست قياساً لصافي الربح.
          </p>
          {priorCashFlow.isLoading ? <p role="status" className="text-sm text-slate-300">جارٍ حساب الفترة السابقة…</p> : null}
          {priorCashFlow.isError ? <div role="alert" className="text-sm text-rose-200">
            تعذر حساب الفترة السابقة؛ لا تعرض مقارنة غير مكتملة.
            <Button size="sm" variant="outline" className="mr-2 text-white" onClick={() => void priorCashFlow.refetch()}>إعادة المحاولة</Button>
          </div> : null}
          {cashFlow.data && priorCashFlow.data && !cashFlow.isError && !priorCashFlow.isError ? <div className="grid gap-3 sm:grid-cols-3">
            {([
              {label:"النقد الوارد", current:cashFlow.data.externalCashIn, previous:priorCashFlow.data.externalCashIn},
              {label:"النقد الصادر", current:cashFlow.data.externalCashOut, previous:priorCashFlow.data.externalCashOut},
              {label:"صافي التدفق", current:cashFlow.data.netCashFlow, previous:priorCashFlow.data.netCashFlow},
            ] as const).map(({label,current,previous}) => {
              const delta = Number(current) - Number(previous);
              const maximum = Math.max(Math.abs(Number(current)), Math.abs(Number(previous)), 1);
              return <div key={label} className="rounded-lg border border-white/10 bg-[#0D1117] p-3">
                <p className="font-semibold text-white">{label}</p>
                <div className="mt-3 space-y-2">
                  {([{name:"الحالية",amount:Number(current)},{name:"السابقة",amount:Number(previous)}] as const).map(({name,amount}) =>
                    <div key={name}>
                      <div className="mb-1 flex justify-between gap-2 text-xs text-slate-300"><span>{name}</span><span>{format(amount)} شيكل</span></div>
                      <div className="h-2 overflow-hidden rounded-full bg-slate-700">
                        <div className={name === "الحالية" ? "h-full rounded-full bg-[#F5B800]" : "h-full rounded-full bg-slate-400"}
                          style={{width:`${Math.min(100, Math.abs(amount) / maximum * 100)}%`}} />
                      </div>
                    </div>)}
                </div>
                <p className="mt-3 text-xs text-slate-300">التغير: {delta > 0 ? "+" : ""}{format(delta)} شيكل</p>
              </div>;
            })}
          </div> : null}
        </div> : null}
      </div>
      <div className="mt-4 border-t border-white/10 pt-4">
        <Button size="sm" variant="outline" className="border-white/20 text-white"
          disabled={!siteId || !endDate || !cycleRangeReady}
          onClick={() => setShowCashTrend(value => !value)}>
          <TrendingUp className="ml-2 h-4 w-4" />
          {showCashTrend ? "إخفاء الاتجاه الشهري" : "عرض اتجاه التدفق خلال 6 أشهر"}
        </Button>
        {showCashTrend ? <div className="mt-4 space-y-3">
          <p className="text-xs text-slate-300">
            اتجاه الحركات النقدية المسندة للفرع، دون تحويلات الحسابات الداخلية. تُعرض الأشهر السابقة كاملة،
            والشهر الأخير حتى تاريخ نهاية الفترة المختارة. الإيداعات ليست بالضرورة إيراداً، والاتجاه لا يمثل صافي الربح.
          </p>
          {cashFlowTrend.isLoading ? <p role="status" className="text-sm text-slate-300">جارٍ تحميل الاتجاهات الشهرية…</p> : null}
          {cashFlowTrend.isError ? <div role="alert" className="text-sm text-rose-200">
            {cashFlowTrend.error?.message || "تعذر التحقق من جميع الأشهر؛ لا تُعرض بيانات جزئية."}
            <Button size="sm" variant="outline" className="mr-2 text-white"
              onClick={() => void cashFlowTrend.refetch()}>إعادة المحاولة</Button>
          </div> : null}
          {cashFlowTrend.data && !cashFlowTrend.isError ? <div className="overflow-x-auto">
            <div className="grid min-w-[510px] grid-cols-6 gap-2" aria-label="مقارنة النقد الوارد والصادر خلال ستة أشهر">
              {(() => {
                const maxAmount = Math.max(1, ...cashFlowTrend.data.months.flatMap(month => [Math.abs(month.externalCashIn),Math.abs(month.externalCashOut)]));
                return cashFlowTrend.data.months.map(month => <div key={month.month} className="rounded-lg border border-white/10 bg-[#0D1117] p-2 text-center">
                  <p className="text-xs font-bold text-white">{month.month}</p>
                  <p className="mt-1 text-[10px] text-slate-400">{month.endDate.slice(8)}/{month.endDate.slice(5,7)} حتى</p>
                  <div className="mt-3 flex h-28 items-end justify-center gap-1" role="img"
                    aria-label={`شهر ${month.month}: وارد ${format(month.externalCashIn)} وصادر ${format(month.externalCashOut)} شيكل`}>
                    <div className="w-5 rounded-t bg-emerald-400" style={{height:`${Math.max(2,Math.abs(month.externalCashIn)/maxAmount*100)}%`}} />
                    <div className="w-5 rounded-t bg-rose-400" style={{height:`${Math.max(2,Math.abs(month.externalCashOut)/maxAmount*100)}%`}} />
                  </div>
                  <div className="mt-2 space-y-1 text-[10px] text-slate-200">
                    <p>وارد: {format(month.externalCashIn)}</p>
                    <p>صادر: {format(month.externalCashOut)}</p>
                    <p className="border-t border-white/10 pt-1 font-semibold">الصافي: {format(month.netCashFlow)}</p>
                  </div>
                </div>);
              })()}
            </div>
            <p className="mt-2 text-xs text-slate-400">الأخضر: النقد الوارد · الوردي: النقد الصادر · القيم بالشيكل.</p>
          </div> : null}
        </div> : null}
      </div>
      {cashFlow.data && !cashFlow.isError ? <p className="mt-3 text-xs text-slate-400">
        {format(cashFlow.data.transactionCount)} حركة خارجية؛ استُبعدت تحويلات داخلية بقيمة
        {" "}{format(cashFlow.data.internalTransferVolume)} شيكل من التدفق الصافي.
      </p> : null}
    </section>
    <section className="rounded-xl border border-white/10 bg-[#111823] p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-white">قائمة الاستحقاق الشهرية والتسويات</h2>
          <p className="mt-1 text-xs text-slate-300">
            بيانات الشهر {endDate.slice(0,7)} · عرض اختياري لا يُحمّل عند فتح اللوحة
          </p>
        </div>
        <Button size="sm" variant="outline" className="border-white/20 text-white"
          disabled={!siteId||!cycleRangeReady}
          onClick={()=>setShowAccrualAccounting(v=>!v)}>
          {showAccrualAccounting?"إخفاء الاستحقاق الشهري":"فتح مراجعة الاستحقاق والتسويات"}
        </Button>
      </div>
    </section>
    <section aria-label="حالة اعتماد دفتر الأستاذ" className="rounded-xl border border-white/10 bg-[#111823] p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-white">تغطية دفتر الأستاذ ومطابقة الافتتاحية</h2>
          <p className="mt-1 text-xs text-slate-400">
            تقارير مصادر محاسبية تراكمية، مع فصل التوازن الرياضي عن صحة مستندات الافتتاحية ومطابقتها.
          </p>
        </div>
        <Button size="sm" variant="outline" disabled={!siteId || !cycleRangeReady}
          className="border-white/20 text-white"
          onClick={() => setShowGLAudit(value => !value)}>
          {showGLAudit ? "إخفاء تدقيق دفتر الأستاذ" : "فتح تدقيق دفتر الأستاذ"}
        </Button>
      </div>
    </section>
    {showGLAudit && siteId && cycleRangeReady ?
      <FinancialGLAuditPanel key={`${siteId}-${endDate.slice(0,7)}`}
        siteId={siteId} period={endDate.slice(0,7)} active={showGLAudit} /> : null}
    {showAccrualAccounting&&siteId&&cycleRangeReady?
      <AccrualAccountingPanel key={`${siteId}-${endDate.slice(0,7)}`}
        siteId={siteId} period={endDate.slice(0,7)} active={showAccrualAccounting}/>:null}
    <section aria-labelledby="accrual-bridge-title" className="rounded-xl border border-white/10 bg-[#111823] p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="accrual-bridge-title" className="text-lg font-bold text-white">مكوّنات قائمة الدخل — مراجعة أولية</h2>
          <p className="mt-1 text-xs text-slate-400">
            فصل الفوترة عن التحصيل، وفصل النقد المدفوع للرواتب عن تكلفة أجورها. هذا ليس صافي ربح محاسبياً معتمداً.
          </p>
        </div>
        <Button size="sm" variant="outline" className="border-white/20 text-white"
          onClick={() => setShowAccrualBridge(v => !v)}>
          {showAccrualBridge ? "إخفاء المكوّنات" : "عرض مكوّنات الاستحقاق"}
        </Button>
      </div>
      {showAccrualBridge ? <div className="mt-4 space-y-3">
        {report.isLoading ? <p role="status" className="text-sm text-slate-300">جارٍ تحميل مكوّنات الفترة…</p> : null}
        {report.isError ? <p role="alert" className="text-sm text-rose-200">
          تعذر التحقق من بيانات الفترة؛ لن تُعرض نتائج ناقصة أو مخزّنة بعد فشل التحديث.
        </p> : null}
        {data?.accrualComponents && !report.isError ? <>
          <p className="text-xs text-amber-200">
            القيم للفترة {startDate} — {endDate}، حسب تاريخ إصدار الفاتورة وتاريخ تسجيل المصروف؛
            توقيت تقديم الخدمة والضرائب والخصومات والالتزامات بحاجة إلى مطابقة إضافية.
          </p>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {([
              {label:"إجمالي الفواتير الصادرة",amount:data.accrualComponents.billedGross},
              {label:"الضرائب ضمن الفواتير",amount:data.accrualComponents.billedTax},
              {label:"الفوترة بعد استبعاد الضريبة",amount:data.accrualComponents.billedExTax},
              {label:"مصروفات تشغيلية غير رواتب الدفع",amount:data.accrualComponents.nonPayrollOperatingExpenses},
              {label:"صافي الرواتب المسجل نقدياً كمصروف",amount:data.accrualComponents.payrollCashOperatingExpenses},
              {label:"مصروفات غير تشغيلية",amount:data.accrualComponents.nonOperatingExpenses},
              {label:"تكلفة استهلاك المخزون",amount:data.summary.inventoryConsumptionCost},
            ] as const).map(item => <div key={item.label} className="rounded-lg border border-white/10 bg-[#0D1117] p-3">
              <p className="text-xs text-slate-300">{item.label}</p>
              <strong className="mt-2 block text-lg text-white">{format(item.amount)} شيكل</strong>
            </div>)}
          </div>
          <p className="text-xs text-slate-300">
            فواتير محتسبة: {format(data.accrualComponents.issuedInvoiceCount)}،
            مسودات مستبعدة: {format(data.accrualComponents.excludedDraftCount)}،
            فواتير ملغاة مستبعدة: {format(data.accrualComponents.excludedCancelledCount)}.
          </p>
          <div className="rounded-lg border border-white/10 bg-[#0D1117] p-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-white">الفوترة بحسب دورة الخدمة</h3>
                <p className="mt-1 text-xs text-slate-400">
                  فحص إضافي اختياري يشمل فواتير الدورة حتى إن صدرت خارج الفترة المحددة.
                  يُحمّل عند الطلب فقط، ولا يمثل إيراداً معترفاً به.
                </p>
              </div>
              <Button size="sm" variant="outline" className="border-white/20 text-white"
                disabled={!cycleRangeReady || !siteId}
                onClick={() => setShowServiceCycleBilling(v=>!v)}>
                {showServiceCycleBilling ? "إخفاء فوترة الدورة" : "فحص فوترة الدورة"}
              </Button>
            </div>
            {showServiceCycleBilling ? <div className="mt-3 space-y-3">
              {serviceCycleBilling.isLoading ? <p role="status" className="text-xs text-slate-300">جارٍ احتساب فوترة دورة الخدمة…</p> : null}
              {serviceCycleBilling.isError ? <div role="alert" className="text-xs text-rose-200">
                تعذر إكمال فحص دورة الخدمة؛ لن تُعرض بيانات جزئية أو قديمة.
                <Button size="sm" variant="outline" className="mr-2 text-white" onClick={() => void serviceCycleBilling.refetch()}>
                  إعادة المحاولة
                </Button>
              </div> : null}
              {serviceCycleBilling.data && !serviceCycleBilling.isError ? <>
                <p className="text-xs text-amber-200">
                  فواتير الدورات المتداخلة مع {startDate} — {endDate}. لا توجد قسمة افتراضية للإيراد على أيام الخدمة.
                </p>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  {([
                    {label:"فوترة الدورات (الإجمالي)",amount:serviceCycleBilling.data.billedGross},
                    {label:"فوترة الدورات دون الضريبة",amount:serviceCycleBilling.data.billedExTax},
                    {label:"فوترة دورات مكتملة",amount:serviceCycleBilling.data.completedCycleBilledGross},
                    {label:"فوترة دورات جارية",amount:serviceCycleBilling.data.ongoingCycleBilledGross},
                    {label:"فوترة دورات مستقبلية",amount:serviceCycleBilling.data.futureCycleBilledGross},
                    {label:"فوترة أُصدرت خارج الفترة",amount:serviceCycleBilling.data.issuedOutsideRangeBilledGross},
                  ] as const).map(item=><div key={item.label}>
                    <p className="text-xs text-slate-400">{item.label}</p>
                    <strong className="text-lg text-white">{format(item.amount)} شيكل</strong>
                  </div>)}
                </div>
                <p className="text-xs text-slate-300">
                  {format(serviceCycleBilling.data.issuedInvoiceCount)} فاتورة، منها{" "}
                  {format(serviceCycleBilling.data.issuedOutsideRangeCount)} أُصدرت خارج الفترة،
                  {" "}{format(serviceCycleBilling.data.crossBoundaryCount)} دورة تعبر حدودها.
                </p>
                {!serviceCycleBilling.data.isCycleCoverageComplete ? <p role="alert" className="text-xs text-rose-200">
                  توجد {format(serviceCycleBilling.data.missingCycleCount)} فاتورة صادرة داخل الفترة
                  لا تحتوي على نطاق دورة خدمة مكتمل؛ لم تدخل في مجموع فوترة الدورات.
                  إجمالي الدورات ليس شاملاً لهذه الحالات ولا يجوز استخدامه كقيمة إيراد.
                </p> : null}
                <p className="text-xs text-amber-200">الاكتمال يعني انتهاء دورة الخدمة، لا اعتماد الإيراد المحاسبي.
                  لا تُستخدم هذه المجاميع مباشرة لحساب صافي الربح دون معالجة التسويات والاعتراف بالإيراد.</p>
              </> : null}
            </div> : null}
          </div>
          {data.serviceCycleCoverage ? <div className="rounded-lg border border-white/10 bg-[#0D1117] p-3">
            <p className="text-sm font-semibold text-white">مطابقة الفوترة مع فترة الخدمة</p>
            <p className="mt-1 text-xs text-slate-400">
              التحليل يشمل الفواتير الصادرة خلال الفترة المختارة فقط؛ لا يشمل فواتير أصدرت خارجها
              وإن كانت خدماتها داخلها، ولا يوزع الإيرادات على أيام الخدمة.
            </p>
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
              {([
                {label:"دورة داخل الفترة بالكامل",value:data.serviceCycleCoverage.withinPeriodCount},
                {label:"دورة تعبر حدود الفترة",value:data.serviceCycleCoverage.crossBoundaryCount},
                {label:"دورة خارج الفترة",value:data.serviceCycleCoverage.outsidePeriodCount},
                {label:"دورة غير محددة",value:data.serviceCycleCoverage.missingCycleCount},
                {label:"إصدار خارج دورة الخدمة",value:data.serviceCycleCoverage.issueDateOutsideCycleCount},
                {label:"إصدار بشهر مختلف عن نهاية الدورة",value:data.serviceCycleCoverage.billedInOtherServiceMonthCount},
              ] as const).map(x=><div key={x.label}><p className="text-xs text-slate-400">{x.label}</p><strong className="text-lg text-white">{format(x.value)}</strong></div>)}
            </div>
            {(data.serviceCycleCoverage.outsidePeriodCount>0 || data.serviceCycleCoverage.crossBoundaryCount>0 ||
              data.serviceCycleCoverage.missingCycleCount>0) ? <p className="mt-3 text-xs text-amber-200">
              توجد فواتير تحتاج مراجعة فترة الاستحقاق. إجمالي فواتير الدورات خارج الفترة:
              {" "}{format(data.serviceCycleCoverage.outsidePeriodBilledGross)} شيكل؛
              وإجمالي الدورات العابرة للحدود: {format(data.serviceCycleCoverage.crossBoundaryBilledGross)} شيكل.
              هذه مبالغ فوترة إجمالية وليست إيرادات مستحقة محسوبة.
            </p> : null}
          </div> : null}
          {data.accrualComponents.unknownInvoiceCount > 0 ? <p role="alert" className="text-xs text-rose-200">
            توجد حالات فواتير غير معروفة ({format(data.accrualComponents.unknownInvoiceCount)}) لم تُحتسب؛ يلزم مراجعتها.
          </p> : null}
          <p className="text-xs text-amber-200">
            لا تُجمع الرواتب المدفوعة أعلاه مرة ثانية مع إجمالي أجور كشوف الرواتب.
            ويلزم ربط فترة تقديم الخدمة وإجمالي الأجور المعتمدة وأثر تسويات السلف
            والمخصصات والإهلاك قبل إصدار قائمة دخل أو صافي ربح معتمد.
          </p>
        </> : null}
      </div> : null}
    </section>
    <section aria-labelledby="payroll-financial-review-title" className="rounded-xl border border-white/10 bg-[#111823] p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="payroll-financial-review-title" className="text-lg font-bold text-white">مراجعة أثر الرواتب على الاستحقاق</h2>
          <p className="mt-1 text-xs text-slate-400">
            تدقيق اختياري لشهر {payrollPeriod} حسب كشوف الرواتب، وليس صافي ربح أو مصروفاً إضافياً.
            تاريخ الشهر يعتمد على نهاية الفترة المحددة، دون تحميل سجل الرواتب عند فتح اللوحة.
          </p>
        </div>
        <Button size="sm" variant="outline" className="border-white/20 text-white" disabled={!siteId || !cycleRangeReady}
          onClick={() => setShowPayrollReview(value => !value)}>
          {showPayrollReview ? "إخفاء تدقيق الرواتب" : "فحص الرواتب والاستحقاق"}
        </Button>
      </div>
      {showPayrollReview ? <div className="mt-4 space-y-3">
        {payrollReview.isLoading ? <p role="status" className="text-sm text-slate-300">جارٍ التحقق من كشوف الرواتب والمصروفات المرتبطة بها…</p> : null}
        {payrollReview.isError ? <div role="alert" className="text-sm text-rose-200">
          تعذر مطابقة الرواتب مع المصروفات. لا يُعرض إجمالي غير موثوق.
          <Button size="sm" variant="outline" className="mr-2 text-white" onClick={() => void payrollReview.refetch()}>إعادة المحاولة</Button>
        </div> : null}
        {payrollReview.data && !payrollReview.isError ? <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {([
              {label:"إجمالي المسودات غير المعتمدة",value:payrollReview.data.draftGross,help:"معلومة للمراجعة، لا تُحتسب كمصروف معتمد"},
              {label:"إجمالي الأجور المعتمدة",value:payrollReview.data.approvedGross,help:"قبل الخصومات، ولم يُصرف بعد"},
              {label:"إجمالي الأجور المصروفة",value:payrollReview.data.paidGross,help:"قبل الخصومات"},
              {label:"النقد المسجل كمصروف رواتب",value:payrollReview.data.matchedNetExpense,help:"صافي المدفوع المطابق لقيد المصروف"},
              {label:"صافي الرواتب المعتمدة المستحقة",value:payrollReview.data.approvedNet,help:"التزام قائم عند الاعتماد"},
              {label:"صافي الرواتب المصروفة",value:payrollReview.data.paidNet,help:"ليس تكلفة أجور إضافية"},
              {label:"خصومات كشوف الرواتب المصروفة",value:payrollReview.data.paidDeductions,help:"تحتاج تصنيفاً محاسبياً حسب نوع الخصم"},
            ] as const).map(item => <div key={item.label} className="rounded-lg border border-white/10 bg-[#0D1117] p-3">
              <p className="text-xs text-slate-300">{item.label}</p>
              <strong className="mt-2 block text-lg text-white">{format(item.value)} شيكل</strong>
              <p className="mt-1 text-xs text-slate-400">{item.help}</p>
            </div>)}
          </div>
          <p className="text-xs text-slate-300">
            الكشوف: {format(payrollReview.data.counts.draft)} مسودة · {format(payrollReview.data.counts.approved)} معتمد ·
            {" "}{format(payrollReview.data.counts.paid)} مصروف · {format(payrollReview.data.counts.cancelled)} ملغى.
          </p>
          {payrollReview.data.reconciliationIssues.length ? <div role="alert" className="rounded-lg border border-rose-400/20 p-3 text-xs text-rose-200">
            <p>توجد {format(payrollReview.data.reconciliationIssues.length)} ملاحظات مطابقة تحتاج مراجعة قبل اعتماد أي تقرير ربحية:</p>
            <ul className="mt-2 list-disc space-y-1 pr-5">
              {payrollReview.data.reconciliationIssues.map((issue,index) =>
                <li key={`${issue}-${index}`}>{payrollReconciliationDescriptions[issue] ?? "توجد مشكلة مطابقة مالية تحتاج مراجعة"}</li>)}
            </ul>
          </div> : <p className="text-xs text-amber-200">
            تمت مطابقة قيود الرواتب المرتبطة بالكشوف المعروضة، لكن صافي الربح النهائي غير معتمد؛
            يلزم التحقق من توقيت الإيرادات والمصروفات ومنع ازدواج الرواتب مع قيود الدفع.
          </p>}
          <p className="text-xs text-slate-400">
            نطاق الفحص: كشوف رواتب الفرع لهذا الشهر والمصروفات وحركات السحب المرتبطة بأرقامها فقط.
            لا يشمل البحث الشامل عن قيود يتيمة أو حركات رواتب من شهور أخرى.
          </p>
        </> : null}
      </div> : null}
    </section>
    {data && !report.isError ? <><section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{[{ label: "إجمالي المحصّل", value: data?.summary.collected, color: "text-emerald-300", Icon: CircleDollarSign }, { label: "إجمالي المصروفات التشغيلية", value: data?.summary.expenseTotal, color: "text-rose-300", Icon: Receipt }, { label: "فائض التحصيل بعد المصروفات", value: data?.summary.operatingProfit, color: "text-[#F5B800]", Icon: TrendingUp }, { label: "المتبقي من فواتير الفترة", value: data?.summary.outstanding, color: "text-orange-300", Icon: FileText }].map(({ label, value, color, Icon }) => <Card key={String(label)} className="border-white/10 bg-[#111823]"><CardContent className="p-5"><div className={`flex items-center gap-2 ${String(color)}`}><Icon className="h-5 w-5" /><span className="text-sm font-bold">{String(label)}</span></div><p className="mt-5 text-3xl font-extrabold text-white">{format(value)} شيكل</p><p className="mt-2 text-xs text-slate-500">الفترة: {startDate} — {endDate}</p></CardContent></Card>)}</section><section className="grid gap-3 sm:grid-cols-2"><div className="rounded-xl border border-white/10 bg-[#111823] p-4"><p className="text-xs text-slate-400">مصروفات مباشرة تشغيلية</p><strong className="mt-2 block text-xl text-white">{format(data?.summary.directExpenseTotal)} شيكل</strong></div><div className="rounded-xl border border-white/10 bg-[#111823] p-4"><p className="text-xs text-slate-400">صافي تكلفة استهلاك المخزون</p><strong className="mt-2 block text-xl text-white">{format(data?.summary.inventoryConsumptionCost)} شيكل</strong><p className="mt-1 text-xs text-slate-400">لا يشمل المشتريات غير المستهلكة أو سداد الموردين</p></div><div className="rounded-xl border border-white/10 bg-[#111823] p-4"><p className="text-xs text-slate-400">المصروفات غير التشغيلية</p><strong className="mt-2 block text-xl text-white">{format(data?.summary.nonOperatingExpenseTotal)} شيكل</strong></div></section><Card className="border-white/10 bg-[#111823]"><CardContent className="p-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-bold text-white">إحصاءات الخصومات</h2><p className="mt-1 text-xs text-slate-400">حسب تاريخ تسجيل التسوية خلال الفترة المحددة؛ الأرصدة المرحّلة ليست خصومات.</p></div><span className="rounded-full border border-[#F5B800]/20 px-3 py-1 text-xs text-[#F5B800]">{startDate} — {endDate}</span></div>{discounts.isError ? <p className="mt-4 text-sm text-rose-200">تعذر تحميل إحصاءات الخصومات. أعد المحاولة.</p> : <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3"><div className="rounded-xl border border-white/8 p-4"><p className="text-xs text-slate-400">إجمالي الخصومات الفعلية</p><strong className="mt-2 block text-2xl text-white">{format(discounts.data?.totalDiscount)} شيكل</strong></div><div className="rounded-xl border border-white/8 p-4"><p className="text-xs text-slate-400">خصومات كسر الفاتورة التلقائية</p><strong className="mt-2 block text-2xl text-emerald-300">{format(discounts.data?.automaticDiscountTotal)} شيكل</strong><p className="mt-1 text-xs text-slate-500">{format(discounts.data?.automaticDiscountCount)} فاتورة</p></div><div className="rounded-xl border border-white/8 p-4"><p className="text-xs text-slate-400">خصومات التحصيل اليدوية</p><strong className="mt-2 block text-2xl text-amber-200">{format(discounts.data?.manualDiscountTotal)} شيكل</strong><p className="mt-1 text-xs text-slate-500">{format(discounts.data?.manualDiscountCount)} عملية</p></div></div>}</CardContent></Card><section className="grid gap-6 lg:grid-cols-[1.2fr_.8fr]"><Card className="border-white/10 bg-[#111823]"><CardContent className="p-5"><h2 className="font-bold text-white">مؤشرات الفترة</h2><div className="mt-5 grid gap-3 sm:grid-cols-3"><div className="rounded-xl border border-white/8 p-4"><p className="text-xs text-slate-400">إجمالي الفوترة</p><strong className="mt-2 block text-xl text-white">{format(data?.summary.invoiced)} شيكل</strong></div><div className="rounded-xl border border-white/8 p-4"><p className="text-xs text-slate-400">التحصيل مقابل فوترة الفترة</p><strong className="mt-2 block text-xl text-emerald-300">{ratioLabel}</strong></div><div className="rounded-xl border border-white/8 p-4"><p className="text-xs text-slate-400">الاستهلاك</p><strong className="mt-2 block text-xl text-white">{format(data?.summary.energyKwh)} kWh</strong></div></div><p className="mt-3 text-xs text-amber-200">مؤشر للمقارنة فقط: تاريخ تحصيل الدفعات يختلف عن تاريخ إصدار الفواتير، ولا يُستخدم لحساب الربح أو معدل سداد نفس الفواتير.</p><div className="mt-6 h-3 overflow-hidden rounded-full bg-slate-800"><div className="h-full rounded-full bg-emerald-400 transition-all" style={{ width: `${Math.max(0,Math.min(100, collectionToBillingRatio ?? 0))}%` }} /></div><p className="mt-2 text-xs text-slate-400">{paymentMethod === "all" ? "نسبة مقارنة حسابية بين التحصيلات المسجلة وفواتير الفترة، وقد تتضمن التحصيلات فواتير أقدم؛ ليست نسبة سداد الفواتير الصادرة في الفترة." : "مقارنة التحصيل بالطريقة المختارة مع قيمة فوترة الفترة؛ لا تمثل معدل سداد فواتير الفترة."}</p></CardContent></Card><Card className="border-white/10 bg-[#111823]"><CardContent className="p-5"><h2 className="font-bold text-white">أداء المحصلين</h2><div className="mt-4 space-y-3">{(data?.collectors ?? []).slice(0, 5).map((item) => <div key={item.name} className="flex items-center justify-between rounded-xl border border-white/8 p-3"><div><p className="font-bold text-white">{item.name}</p><p className="text-xs text-slate-500">{item.count} عملية</p></div><strong className="text-emerald-300">{format(item.amount)} شيكل</strong></div>)}{!data?.collectors?.length && <p className="py-8 text-center text-sm text-slate-500">لا توجد تحصيلات مكتملة في الفترة.</p>}</div></CardContent></Card></section><Card className="border-white/10 bg-[#111823]"><CardContent className="p-5"><div className="flex items-center justify-between"><h2 className="font-bold text-white">أعلى المتأخرات</h2><span className="text-xs text-slate-500">{data?.topDebtors?.length ?? 0} سجلات معروضة</span></div><div className="mt-4 overflow-x-auto"><table className="w-full min-w-[700px] text-right text-sm"><thead className="text-xs text-slate-500"><tr><th className="p-3">المشترك</th><th className="p-3">رقم الفاتورة</th><th className="p-3">الرصيد</th><th className="p-3">تاريخ الاستحقاق</th></tr></thead><tbody>{(data?.topDebtors ?? []).map((item) => <tr key={item.invoiceNo} className="border-t border-white/8"><td className="p-3 font-bold text-white">{item.subscriber}</td><td className="p-3 text-slate-300">{item.invoiceNo}</td><td className="p-3 text-orange-300">{format(item.balanceDue)} شيكل</td><td className="p-3 text-slate-400">{formatReportDate(item.dueDate)}</td></tr>)}</tbody></table></div></CardContent></Card></> : null}</main></DashboardLayout>;
}
