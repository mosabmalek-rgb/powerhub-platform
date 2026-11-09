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
  const hasMultipleBranches = tenantSites.length > 1;
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
  const report = trpc.powerhub.reports.range.useQuery({ siteId, startDate, endDate, paymentMethod }, { enabled: Boolean(siteId && isAuthenticated && startDate && endDate && startDate <= endDate && cycleRangeReady), staleTime: 60_000, refetchOnWindowFocus: false });
  const branding = trpc.powerhub.reportBranding.get.useQuery({ siteId }, { enabled: false, staleTime: 300_000 });
  const settlements = trpc.powerhub.settlements.list.useQuery({ siteId }, { enabled: false, staleTime: 300_000 });
  const discounts = trpc.powerhub.siteBillingPolicy.discountSummary.useQuery({ siteId, startDate, endDate }, { enabled: Boolean(siteId && isAuthenticated && startDate && endDate && startDate <= endDate && cycleRangeReady), staleTime: 60_000, refetchOnWindowFocus: false });
  const data = report.data;
  const collectionRate = data?.summary.invoiced ? (data.summary.collected / data.summary.invoiced) * 100 : 0;
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
        <div style="border:1px solid #ccc;padding:14px">نسبة التحصيل<br><b>${collectionRate.toFixed(1)}%</b></div>
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
      ["عدد الحسابات المشتركة أو غير الحصرية", snapshot.sharedAccountCount],
      [],
      ["الحساب", "الرصيد بالشيكل", "مشترك بين الفروع"],
      ...snapshot.accounts.map((account) => [account.name, account.balance, account.shared ? "نعم" : "لا"]),
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
  const exportCsv = () => { if (!data) return; const rows = [["المؤشر", "القيمة"], ["الفترة", `${startDate} إلى ${endDate}`], ["إجمالي الفوترة", data.summary.invoiced], ["إجمالي المحصل", data.summary.collected], ["إجمالي المصروفات التشغيلية", data.summary.expenseTotal], ["المصروفات المباشرة التشغيلية", data.summary.directExpenseTotal], ["المصروفات غير التشغيلية", data.summary.nonOperatingExpenseTotal], ["إجمالي المصروفات جميعها", data.summary.allExpenseTotal], ["تكلفة استهلاك المخزون", data.summary.inventoryConsumptionCost], ["فائض التحصيل بعد المصروفات", data.summary.operatingProfit], ["الأرصدة المستحقة", data.summary.outstanding], ["الطاقة بالكيلوواط", data.summary.energyKwh], ["نسبة التحصيل", `${collectionRate.toFixed(2)}%`], [], ["المحصل", "عدد العمليات", "المبلغ"], ...(data.collectors ?? []).map((item) => [item.name, item.count, item.amount])]; const csv = rows.map((row) => row.map((cell) => `"${String(cell ?? "").replaceAll('"', '""')}"`).join(",")).join("\n"); const url = URL.createObjectURL(new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" })); const anchor = document.createElement("a"); anchor.href = url; anchor.download = `التقرير-المالي-${startDate}-${endDate}.csv`; anchor.click(); URL.revokeObjectURL(url); toast.success("تم تصدير التقرير المالي."); };
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
              {(sites.data ?? []).map(site => <option key={site.id} value={site.id}>{site.name}</option>)}
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
          تنبيه: {format(currentPosition.data.sharedAccountCount)} من حسابات الشركة مشتركة أو متاحة لأكثر من فرع؛
          مجموع الأرصدة ليس نقدية مستقلة لهذا الفرع، ولا يجوز جمعه مرة أخرى في تقرير فروع آخر.
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
      {cashFlow.isError ? <div role="alert" className="mt-3 text-sm text-rose-200">تعذر التحقق من التدفقات النقدية؛ لا نعرض أرقاماً افتراضية.
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
            تعذر التحقق من جميع الأشهر؛ لا تُعرض بيانات جزئية.
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
    {data && !report.isError ? <><section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{[{ label: "إجمالي المحصّل", value: data?.summary.collected, color: "text-emerald-300", Icon: CircleDollarSign }, { label: "إجمالي المصروفات التشغيلية", value: data?.summary.expenseTotal, color: "text-rose-300", Icon: Receipt }, { label: "فائض التحصيل بعد المصروفات", value: data?.summary.operatingProfit, color: "text-[#F5B800]", Icon: TrendingUp }, { label: "المتبقي من فواتير الفترة", value: data?.summary.outstanding, color: "text-orange-300", Icon: FileText }].map(({ label, value, color, Icon }) => <Card key={String(label)} className="border-white/10 bg-[#111823]"><CardContent className="p-5"><div className={`flex items-center gap-2 ${String(color)}`}><Icon className="h-5 w-5" /><span className="text-sm font-bold">{String(label)}</span></div><p className="mt-5 text-3xl font-extrabold text-white">{format(value)} شيكل</p><p className="mt-2 text-xs text-slate-500">الفترة: {startDate} — {endDate}</p></CardContent></Card>)}</section><section className="grid gap-3 sm:grid-cols-2"><div className="rounded-xl border border-white/10 bg-[#111823] p-4"><p className="text-xs text-slate-400">مصروفات مباشرة تشغيلية</p><strong className="mt-2 block text-xl text-white">{format(data?.summary.directExpenseTotal)} شيكل</strong></div><div className="rounded-xl border border-white/10 bg-[#111823] p-4"><p className="text-xs text-slate-400">صافي تكلفة استهلاك المخزون</p><strong className="mt-2 block text-xl text-white">{format(data?.summary.inventoryConsumptionCost)} شيكل</strong><p className="mt-1 text-xs text-slate-400">لا يشمل المشتريات غير المستهلكة أو سداد الموردين</p></div><div className="rounded-xl border border-white/10 bg-[#111823] p-4"><p className="text-xs text-slate-400">المصروفات غير التشغيلية</p><strong className="mt-2 block text-xl text-white">{format(data?.summary.nonOperatingExpenseTotal)} شيكل</strong></div></section><Card className="border-white/10 bg-[#111823]"><CardContent className="p-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-bold text-white">إحصاءات الخصومات</h2><p className="mt-1 text-xs text-slate-400">حسب تاريخ تسجيل التسوية خلال الفترة المحددة؛ الأرصدة المرحّلة ليست خصومات.</p></div><span className="rounded-full border border-[#F5B800]/20 px-3 py-1 text-xs text-[#F5B800]">{startDate} — {endDate}</span></div>{discounts.isError ? <p className="mt-4 text-sm text-rose-200">تعذر تحميل إحصاءات الخصومات. أعد المحاولة.</p> : <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3"><div className="rounded-xl border border-white/8 p-4"><p className="text-xs text-slate-400">إجمالي الخصومات الفعلية</p><strong className="mt-2 block text-2xl text-white">{format(discounts.data?.totalDiscount)} شيكل</strong></div><div className="rounded-xl border border-white/8 p-4"><p className="text-xs text-slate-400">خصومات كسر الفاتورة التلقائية</p><strong className="mt-2 block text-2xl text-emerald-300">{format(discounts.data?.automaticDiscountTotal)} شيكل</strong><p className="mt-1 text-xs text-slate-500">{format(discounts.data?.automaticDiscountCount)} فاتورة</p></div><div className="rounded-xl border border-white/8 p-4"><p className="text-xs text-slate-400">خصومات التحصيل اليدوية</p><strong className="mt-2 block text-2xl text-amber-200">{format(discounts.data?.manualDiscountTotal)} شيكل</strong><p className="mt-1 text-xs text-slate-500">{format(discounts.data?.manualDiscountCount)} عملية</p></div></div>}</CardContent></Card><section className="grid gap-6 lg:grid-cols-[1.2fr_.8fr]"><Card className="border-white/10 bg-[#111823]"><CardContent className="p-5"><h2 className="font-bold text-white">مؤشرات الفترة</h2><div className="mt-5 grid gap-3 sm:grid-cols-3"><div className="rounded-xl border border-white/8 p-4"><p className="text-xs text-slate-400">إجمالي الفوترة</p><strong className="mt-2 block text-xl text-white">{format(data?.summary.invoiced)} شيكل</strong></div><div className="rounded-xl border border-white/8 p-4"><p className="text-xs text-slate-400">نسبة التحصيل</p><strong className="mt-2 block text-xl text-emerald-300">{collectionRate.toFixed(1)}%</strong></div><div className="rounded-xl border border-white/8 p-4"><p className="text-xs text-slate-400">الاستهلاك</p><strong className="mt-2 block text-xl text-white">{format(data?.summary.energyKwh)} kWh</strong></div></div><div className="mt-6 h-3 overflow-hidden rounded-full bg-slate-800"><div className="h-full rounded-full bg-emerald-400 transition-all" style={{ width: `${Math.min(100, collectionRate)}%` }} /></div><p className="mt-2 text-xs text-slate-400">{paymentMethod === "all" ? "نسبة التحصيل من إجمالي الفوترة في الفترة المختارة." : "نسبة التحصيل بالطريقة المختارة إلى إجمالي الفوترة؛ ليست نسبة التحصيل الإجمالية."}</p></CardContent></Card><Card className="border-white/10 bg-[#111823]"><CardContent className="p-5"><h2 className="font-bold text-white">أداء المحصلين</h2><div className="mt-4 space-y-3">{(data?.collectors ?? []).slice(0, 5).map((item) => <div key={item.name} className="flex items-center justify-between rounded-xl border border-white/8 p-3"><div><p className="font-bold text-white">{item.name}</p><p className="text-xs text-slate-500">{item.count} عملية</p></div><strong className="text-emerald-300">{format(item.amount)} شيكل</strong></div>)}{!data?.collectors?.length && <p className="py-8 text-center text-sm text-slate-500">لا توجد تحصيلات مكتملة في الفترة.</p>}</div></CardContent></Card></section><Card className="border-white/10 bg-[#111823]"><CardContent className="p-5"><div className="flex items-center justify-between"><h2 className="font-bold text-white">أعلى المتأخرات</h2><span className="text-xs text-slate-500">{data?.topDebtors?.length ?? 0} سجلات معروضة</span></div><div className="mt-4 overflow-x-auto"><table className="w-full min-w-[700px] text-right text-sm"><thead className="text-xs text-slate-500"><tr><th className="p-3">المشترك</th><th className="p-3">رقم الفاتورة</th><th className="p-3">الرصيد</th><th className="p-3">تاريخ الاستحقاق</th></tr></thead><tbody>{(data?.topDebtors ?? []).map((item) => <tr key={item.invoiceNo} className="border-t border-white/8"><td className="p-3 font-bold text-white">{item.subscriber}</td><td className="p-3 text-slate-300">{item.invoiceNo}</td><td className="p-3 text-orange-300">{format(item.balanceDue)} شيكل</td><td className="p-3 text-slate-400">{formatReportDate(item.dueDate)}</td></tr>)}</tbody></table></div></CardContent></Card></> : null}</main></DashboardLayout>;
}
