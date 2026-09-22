import { useAuth } from "@/_core/hooks/useAuth";
import DashboardLayout from "@/components/DashboardLayout";
import { formatReportDate, formatReportPeriod } from "@/lib/report-design-system";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import { BarChart3, CalendarRange, CircleDollarSign, Download, FileText, Loader2, Receipt, TrendingUp } from "lucide-react";
import { downloadReportHtmlAsPdf, escapeHtml } from "@/lib/report-pdf";
import { useMemo, useState } from "react";
import { toast } from "sonner";

const format = (value: unknown) => Number(value ?? 0).toLocaleString("ar", { maximumFractionDigits: 2 });
const iso = (date: Date) => date.toISOString().slice(0, 10);
const presets = [{ id: "today", label: "اليوم" }, { id: "7d", label: "آخر 7 أيام" }, { id: "30d", label: "آخر 30 يوم" }, { id: "month", label: "هذا الشهر" }, { id: "all", label: "من البداية" }];

export default function FinancialDashboardPage() {
  const { isAuthenticated, loading } = useAuth();
  const sites = trpc.powerhub.sites.list.useQuery(undefined, { enabled: isAuthenticated });
  const siteId = sites.data?.[0]?.id ?? 0;
  const [preset, setPreset] = useState("30d");
  const [startDate, setStartDate] = useState(() => { const d = new Date(); d.setDate(d.getDate() - 29); return iso(d); });
  const [endDate, setEndDate] = useState(() => iso(new Date()));
  const report = trpc.powerhub.reports.range.useQuery({ siteId, startDate, endDate }, { enabled: Boolean(siteId && isAuthenticated) });
  const branding = trpc.powerhub.reportBranding.get.useQuery({ siteId }, { enabled: Boolean(siteId && isAuthenticated) });
  const settlements = trpc.powerhub.settlements.list.useQuery({ siteId }, { enabled: Boolean(siteId && isAuthenticated) });
  const data = report.data;
  const collectionRate = data?.summary.invoiced ? (data.summary.collected / data.summary.invoiced) * 100 : 0;
  const applyPreset = (id: string) => { const end = new Date(); const start = new Date(end); if (id === "today") start.setHours(0, 0, 0, 0); else if (id === "7d") start.setDate(end.getDate() - 6); else if (id === "30d") start.setDate(end.getDate() - 29); else if (id === "month") start.setDate(1); else if (id === "all") start.setFullYear(2020, 0, 1); setPreset(id); setStartDate(iso(start)); setEndDate(iso(end)); };
  const exportAdminPdf = async () => {
    if (!data) return;
    const wrapper = document.createElement("div");
    wrapper.dir = "rtl";
    wrapper.style.cssText = "position:fixed;left:-10000px;top:0;width:1100px;padding:42px;background:#fff;color:#111;font-family:Tajawal,Arial,sans-serif";
    const monthly = Array.from((settlements.data ?? []).reduce((map, row) => {
      const key = new Date(row.periodStart).toISOString().slice(0, 7);
      const item = map.get(key) ?? { collected: 0, expenses: 0 };
      item.collected += Number(row.totalCollected);
      item.expenses += Number(row.totalExpenses);
      map.set(key, item);
      return map;
    }, new Map<string, { collected: number; expenses: number }>()).entries()).slice(-6)
      .map(([month, item]) => `<tr><td>${month}</td><td>${format(item.collected)} شيكل</td><td>${format(item.expenses)} شيكل</td></tr>`)
      .join("");
    const collectorRows = (data.collectors ?? []).map((item) => `<tr><td>${item.name}</td><td>${item.count}</td><td>${format(item.amount)} شيكل</td></tr>`).join("");
    const debtorRows = (data.topDebtors ?? []).slice(0, 10).map((item) => `<tr><td>${item.subscriber}</td><td>${item.invoiceNo}</td><td>${format(item.balanceDue)} شيكل</td><td>${formatReportDate(item.dueDate)}</td></tr>`).join("");
    wrapper.innerHTML = `
      <h1 style="border-bottom:3px solid #f5b800;padding-bottom:18px">${escapeHtml(branding.data?.companyName ?? "PowerHub")} — التقرير الإداري المالي</h1>
      <p>الفترة: ${formatReportPeriod(startDate, endDate)}</p>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px">
        <div style="border:1px solid #ccc;padding:14px">التحصيل<br><b>${format(data.summary.collected)} شيكل</b></div>
        <div style="border:1px solid #ccc;padding:14px">المصروفات<br><b>${format(data.summary.expenseTotal)} شيكل</b></div>
        <div style="border:1px solid #ccc;padding:14px">صافي التدفق التشغيلي<br><b>${format(data.summary.operatingProfit)} شيكل</b></div>
        <div style="border:1px solid #ccc;padding:14px">نسبة التحصيل<br><b>${collectionRate.toFixed(1)}%</b></div>
      </div>
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
  const exportCsv = () => { if (!data) return; const rows = [["المؤشر", "القيمة"], ["الفترة", `${startDate} إلى ${endDate}`], ["إجمالي الفوترة", data.summary.invoiced], ["إجمالي المحصل", data.summary.collected], ["إجمالي المصروفات", data.summary.expenseTotal], ["صافي التدفق التشغيلي", data.summary.operatingProfit], ["الأرصدة المستحقة", data.summary.outstanding], ["الطاقة بالكيلوواط", data.summary.energyKwh], ["نسبة التحصيل", `${collectionRate.toFixed(2)}%`], [], ["المحصل", "عدد العمليات", "المبلغ"], ...(data.collectors ?? []).map((item) => [item.name, item.count, item.amount])]; const csv = rows.map((row) => row.map((cell) => `"${String(cell ?? "").replaceAll('"', '""')}"`).join(",")).join("\n"); const url = URL.createObjectURL(new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" })); const anchor = document.createElement("a"); anchor.href = url; anchor.download = `التقرير-المالي-${startDate}-${endDate}.csv`; anchor.click(); URL.revokeObjectURL(url); toast.success("تم تصدير التقرير المالي."); };
  if (loading || report.isLoading) return <DashboardLayout><div className="grid min-h-[60vh] place-items-center"><Loader2 className="h-7 w-7 animate-spin text-[#F5B800]" /></div></DashboardLayout>;
  if (!isAuthenticated) return <DashboardLayout><div className="p-8 text-center text-white">سجّل الدخول للوصول إلى لوحة المالية.</div></DashboardLayout>;
  return <DashboardLayout><main className="space-y-6 pb-12" dir="rtl"><header className="rounded-2xl border border-[#F5B800]/20 bg-[#111823] p-6"><div className="flex flex-wrap items-start justify-between gap-4"><div><div className="flex items-center gap-2 text-[#F5B800]"><BarChart3 className="h-5 w-5" /><span className="font-bold">الإدارة المالية</span></div><h1 className="mt-2 text-2xl font-extrabold text-white">لوحة الإحصاء المالي والتحصيل</h1><p className="mt-2 text-sm text-slate-400">ملخص التحصيل والمصروفات والديون وصافي التدفق التشغيلي للفترة المحددة.</p></div><div className="flex flex-wrap gap-2"><Button onClick={exportCsv} disabled={!data} variant="outline" className="border-white/15 text-white"><Download className="ml-2 h-4 w-4" />تصدير CSV</Button><Button onClick={exportAdminPdf} disabled={!data} variant="outline" className="border-[#F5B800]/40 text-[#F5B800]"><FileText className="ml-2 h-4 w-4" />تقرير مالي إداري</Button></div></div><div className="mt-6 flex flex-wrap items-center gap-2"><CalendarRange className="h-4 w-4 text-slate-400" />{presets.map((item) => <Button key={item.id} size="sm" variant={preset === item.id ? "default" : "outline"} onClick={() => applyPreset(item.id)} className={preset === item.id ? "bg-[#F5B800] text-[#0D1117]" : "border-white/15 text-white"}>{item.label}</Button>)}<Input type="date" value={startDate} onChange={(event) => { setPreset("custom"); setStartDate(event.target.value); }} className="h-9 w-40 border-white/10 bg-[#0D1117] text-white" /><span className="text-slate-500">إلى</span><Input type="date" value={endDate} onChange={(event) => { setPreset("custom"); setEndDate(event.target.value); }} className="h-9 w-40 border-white/10 bg-[#0D1117] text-white" /></div></header><section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{[{ label: "إجمالي المحصّل", value: data?.summary.collected, color: "text-emerald-300", Icon: CircleDollarSign }, { label: "إجمالي المصروفات", value: data?.summary.expenseTotal, color: "text-rose-300", Icon: Receipt }, { label: "صافي التدفق التشغيلي", value: data?.summary.operatingProfit, color: "text-[#F5B800]", Icon: TrendingUp }, { label: "الديون المستحقة", value: data?.summary.outstanding, color: "text-orange-300", Icon: FileText }].map(({ label, value, color, Icon }) => <Card key={String(label)} className="border-white/10 bg-[#111823]"><CardContent className="p-5"><div className={`flex items-center gap-2 ${String(color)}`}><Icon className="h-5 w-5" /><span className="text-sm font-bold">{String(label)}</span></div><p className="mt-5 text-3xl font-extrabold text-white">{format(value)} شيكل</p><p className="mt-2 text-xs text-slate-500">الفترة: {startDate} — {endDate}</p></CardContent></Card>)}</section><section className="grid gap-6 lg:grid-cols-[1.2fr_.8fr]"><Card className="border-white/10 bg-[#111823]"><CardContent className="p-5"><h2 className="font-bold text-white">مؤشرات الفترة</h2><div className="mt-5 grid gap-3 sm:grid-cols-3"><div className="rounded-xl border border-white/8 p-4"><p className="text-xs text-slate-400">إجمالي الفوترة</p><strong className="mt-2 block text-xl text-white">{format(data?.summary.invoiced)} شيكل</strong></div><div className="rounded-xl border border-white/8 p-4"><p className="text-xs text-slate-400">نسبة التحصيل</p><strong className="mt-2 block text-xl text-emerald-300">{collectionRate.toFixed(1)}%</strong></div><div className="rounded-xl border border-white/8 p-4"><p className="text-xs text-slate-400">الاستهلاك</p><strong className="mt-2 block text-xl text-white">{format(data?.summary.energyKwh)} kWh</strong></div></div><div className="mt-6 h-3 overflow-hidden rounded-full bg-slate-800"><div className="h-full rounded-full bg-emerald-400 transition-all" style={{ width: `${Math.min(100, collectionRate)}%` }} /></div><p className="mt-2 text-xs text-slate-400">نسبة المحصل إلى إجمالي الفوترة في الفترة المختارة.</p></CardContent></Card><Card className="border-white/10 bg-[#111823]"><CardContent className="p-5"><h2 className="font-bold text-white">أداء المحصلين</h2><div className="mt-4 space-y-3">{(data?.collectors ?? []).slice(0, 5).map((item) => <div key={item.name} className="flex items-center justify-between rounded-xl border border-white/8 p-3"><div><p className="font-bold text-white">{item.name}</p><p className="text-xs text-slate-500">{item.count} عملية</p></div><strong className="text-emerald-300">{format(item.amount)} شيكل</strong></div>)}{!data?.collectors?.length && <p className="py-8 text-center text-sm text-slate-500">لا توجد تحصيلات مكتملة في الفترة.</p>}</div></CardContent></Card></section><Card className="border-white/10 bg-[#111823]"><CardContent className="p-5"><div className="flex items-center justify-between"><h2 className="font-bold text-white">أعلى المتأخرات</h2><span className="text-xs text-slate-500">{data?.topDebtors?.length ?? 0} سجلات معروضة</span></div><div className="mt-4 overflow-x-auto"><table className="w-full min-w-[700px] text-right text-sm"><thead className="text-xs text-slate-500"><tr><th className="p-3">المشترك</th><th className="p-3">رقم الفاتورة</th><th className="p-3">الرصيد</th><th className="p-3">تاريخ الاستحقاق</th></tr></thead><tbody>{(data?.topDebtors ?? []).map((item) => <tr key={item.invoiceNo} className="border-t border-white/8"><td className="p-3 font-bold text-white">{item.subscriber}</td><td className="p-3 text-slate-300">{item.invoiceNo}</td><td className="p-3 text-orange-300">{format(item.balanceDue)} شيكل</td><td className="p-3 text-slate-400">{formatReportDate(item.dueDate)}</td></tr>)}</tbody></table></div></CardContent></Card></main></DashboardLayout>;
}
