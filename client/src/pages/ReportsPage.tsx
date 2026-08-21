import { useAuth } from "@/_core/hooks/useAuth";
import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { startLogin } from "@/const";
import { useBranchFilter } from "@/hooks/useBranchFilter";
import { trpc } from "@/lib/trpc";
import ExcelJS from "exceljs";
import { Download, FileBarChart2, FileSpreadsheet, Layers3, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

const inputClass = "h-10 rounded-xl border border-white/10 bg-white/[0.025] px-3 text-sm text-white outline-none focus:border-[#F5B800]/70";
const currentDate = new Date().toISOString().slice(0, 10);
const currentMonthStart = `${currentDate.slice(0, 7)}-01`;
const number = (value: unknown, digits = 2) => new Intl.NumberFormat("ar", { maximumFractionDigits: digits }).format(Number(value ?? 0));

type FinancialReport = {
  range: { startDate: string; endDate: string };
  summary: { invoiced: number; collected: number; outstanding: number; energyKwh: number; expenseTotal: number; operatingProfit: number };
  collectors: { name: string; count: number; amount: number }[];
  topDebtors: { subscriber: string; invoiceNo: string; balanceDue: number; branchName?: string }[];
  scope?: { branchCount: number };
  branchSummaries?: { siteId: number; branchName: string; invoiced: number; collected: number; outstanding: number; energyKwh: number; expenseTotal: number; operatingProfit: number }[];
};

function financialRows(report: FinancialReport, scopeName: string) {
  const branchRows = report.branchSummaries ?? [];
  return [
    ["تقرير PowerHub المالي", ""],
    ["النطاق", scopeName],
    ["بداية الفترة", report.range.startDate], ["نهاية الفترة", report.range.endDate],
    [], ["المؤشر", "القيمة"],
    ["إجمالي الفوترة", report.summary.invoiced], ["إجمالي التحصيل", report.summary.collected], ["المتأخرات", report.summary.outstanding], ["الاستهلاك kWh", report.summary.energyKwh], ["المصروفات", report.summary.expenseTotal], ["الربح التشغيلي", report.summary.operatingProfit],
    ...(branchRows.length ? [[], ["تفصيل الأفرع", "الفوترة", "التحصيل", "المتأخرات", "المصروفات", "الربح التشغيلي"], ...branchRows.map((branch) => [branch.branchName, branch.invoiced, branch.collected, branch.outstanding, branch.expenseTotal, branch.operatingProfit])] : []),
    [], ["المحصل", "عدد الدفعات", "قيمة التحصيل"], ...report.collectors.map((row) => [row.name, row.count, row.amount]),
  ];
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export default function ReportsPage() {
  const { isAuthenticated, loading } = useAuth();
  const sitesQuery = trpc.powerhub.sites.list.useQuery(undefined, { enabled: isAuthenticated });
  const { branchId, setBranchId } = useBranchFilter(sitesQuery.data);
  const [scope, setScope] = useState<"branch" | "all">("branch");
  const [startDate, setStartDate] = useState(currentMonthStart);
  const [endDate, setEndDate] = useState(currentDate);
  const accessQuery = trpc.powerhub.staff.allBranchAccess.useQuery({ siteId: branchId ?? 0 }, { enabled: Boolean(branchId && isAuthenticated) });
  const canUseAllBranches = accessQuery.data?.isGlobal === true && (sitesQuery.data?.length ?? 0) > 1;
  useEffect(() => { if (scope === "all" && !canUseAllBranches) setScope("branch"); }, [canUseAllBranches, scope]);
  const baseEnabled = Boolean(branchId && isAuthenticated && startDate <= endDate);
  const branchReportQuery = trpc.powerhub.reports.range.useQuery({ siteId: branchId ?? 0, startDate, endDate }, { enabled: baseEnabled && scope === "branch" });
  const allReportQuery = trpc.powerhub.reports.allBranchesRange.useQuery({ siteId: branchId ?? 0, startDate, endDate }, { enabled: baseEnabled && scope === "all" && canUseAllBranches });
  const activeQuery = scope === "all" ? allReportQuery : branchReportQuery;
  const report = activeQuery.data as FinancialReport | undefined;
  const scopeName = scope === "all" ? `جميع الأفرع (${report?.scope?.branchCount ?? sitesQuery.data?.length ?? 0})` : sitesQuery.data?.find((site) => site.id === branchId)?.name ?? "الفرع المحدد";

  const downloadCsv = () => {
    if (!report) return;
    const rows = financialRows(report, scopeName);
    const csv = "\uFEFF" + rows.map((row) => row.map((cell) => `"${String(cell ?? "").replaceAll('"', '""')}"`).join(",")).join("\n");
    triggerDownload(new Blob([csv], { type: "text/csv;charset=utf-8" }), `powerhub-financial-${scope === "all" ? "all-branches" : `branch-${branchId}`}-${startDate}_to_${endDate}.csv`);
    toast.success("تم تصدير التقرير المالي بصيغة CSV.");
  };

  const downloadExcel = async () => {
    if (!report) return;
    try {
      const workbook = new ExcelJS.Workbook();
      workbook.creator = "PowerHub";
      workbook.created = new Date();
      const sheet = workbook.addWorksheet("التقرير المالي", { views: [{ rightToLeft: true }] });
      financialRows(report, scopeName).forEach((row) => sheet.addRow(row));
      sheet.columns = [{ width: 30 }, { width: 22 }, { width: 18 }, { width: 18 }, { width: 18 }, { width: 18 }];
      [1, 6].forEach((rowNumber) => { const row = sheet.getRow(rowNumber); row.font = { bold: true, color: { argb: "FFFFFFFF" } }; row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0D1117" } }; row.height = 24; });
      for (let index = 1; index <= sheet.rowCount; index += 1) sheet.getRow(index).alignment = { vertical: "middle", horizontal: "right" };
      const buffer = await workbook.xlsx.writeBuffer();
      triggerDownload(new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), `powerhub-financial-${scope === "all" ? "all-branches" : `branch-${branchId}`}-${startDate}_to_${endDate}.xlsx`);
      toast.success("تم تجهيز تقرير Excel المالي.");
    } catch {
      toast.error("تعذر تجهيز ملف Excel. حاول مرة أخرى.");
    }
  };

  if (loading) return <DashboardLayout><div className="grid min-h-[60vh] place-items-center"><Loader2 className="h-7 w-7 animate-spin text-[#F5B800]" /></div></DashboardLayout>;
  if (!isAuthenticated) return <DashboardLayout><div className="mx-auto mt-12 max-w-xl rounded-[28px] border border-[#F5B800]/20 bg-[#111823] p-8 text-center shadow-panel"><FileBarChart2 className="mx-auto h-8 w-8 text-[#F5B800]" /><h1 className="mt-5 text-xl font-extrabold text-white">سجّل الدخول لعرض التقارير</h1><Button onClick={() => startLogin()} className="mt-6 bg-[#F5B800] font-bold text-[#0D1117] hover:bg-[#ffd23f]">تسجيل الدخول</Button></div></DashboardLayout>;

  const summary = report?.summary;
  const branchSummaries = report?.branchSummaries ?? [];
  return <DashboardLayout><div className="space-y-6 pb-12"><header className="flex flex-col gap-4 rounded-[24px] border border-white/8 bg-[#111823]/80 p-5 shadow-panel sm:flex-row sm:items-center sm:justify-between"><div><div className="flex items-center gap-2 text-sm font-bold text-[#F5B800]"><FileBarChart2 className="h-4 w-4" />الرؤية والتحليل</div><h1 className="mt-1 text-2xl font-extrabold text-white">التقارير المالية</h1><p className="mt-2 text-sm text-slate-400">اعرض تقرير فرعك المحدد أو تقريراً مجمّعاً لكل الأفرع المصرح بها، ثم صدّره بصيغة CSV أو Excel.</p></div><div className="flex flex-wrap gap-2"><select aria-label="فلتر الفرع الموحد" value={scope === "all" ? "all" : String(branchId ?? "")} onChange={(event) => { const value = event.target.value; if (value === "all") setScope("all"); else { setBranchId(Number(value)); setScope("branch"); } }} className={inputClass}>{canUseAllBranches && <option className="bg-[#111823]" value="all">جميع الأفرع (مجمّع)</option>}{(sitesQuery.data ?? []).map((site) => <option className="bg-[#111823]" value={site.id} key={site.id}>{site.name}</option>)}</select><input aria-label="تاريخ بداية التقرير" type="date" value={startDate} max={endDate} onChange={(event) => setStartDate(event.target.value)} className={inputClass} dir="ltr" /><input aria-label="تاريخ نهاية التقرير" type="date" value={endDate} min={startDate} onChange={(event) => setEndDate(event.target.value)} className={inputClass} dir="ltr" /><Button onClick={downloadCsv} disabled={!report || startDate > endDate} className="bg-[#F5B800] font-bold text-[#0D1117] hover:bg-[#ffd23f]"><Download className="ml-2 h-4 w-4" />CSV</Button><Button onClick={downloadExcel} disabled={!report || startDate > endDate} variant="outline" className="border-white/10 text-white hover:bg-white/5 hover:text-white"><FileSpreadsheet className="ml-2 h-4 w-4" />Excel</Button></div></header>
    <Card className="border-[#F5B800]/18 bg-[#F5B800]/[.035]"><CardContent className="flex flex-wrap items-center justify-between gap-3 p-4"><div className="flex items-center gap-3"><Layers3 className="h-5 w-5 text-[#F5B800]" /><div><p className="font-bold text-white">نطاق التقرير: {scopeName}</p><p className="mt-1 text-xs text-slate-400">فلتر الفرع محفوظ ويُستخدم تلقائياً في صفحات التشغيل التي تدعمه.</p></div></div>{activeQuery.isFetching && <span className="text-xs font-bold text-[#F5B800]">جارٍ تحديث التقرير…</span>}</CardContent></Card>
    <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{[{ label: "إجمالي الفوترة", value: summary?.invoiced }, { label: "التحصيل", value: summary?.collected }, { label: "المتأخرات", value: summary?.outstanding }, { label: "الربح التشغيلي", value: summary?.operatingProfit }].map((item) => <Card className="border-white/8 bg-[#111823] shadow-panel" key={item.label}><CardContent className="p-5"><p className="text-sm text-slate-400">{item.label}</p><p className="mt-4 font-display text-3xl font-extrabold text-white">{number(item.value)}</p><p className="mt-2 text-xs text-slate-500">من {startDate} إلى {endDate}</p></CardContent></Card>)}</section>
    {scope === "all" && <TableCard title="التفصيل المالي حسب الفرع" columns={["الفرع", "الفوترة", "التحصيل", "المتأخرات", "المصروفات", "الربح"]} rows={branchSummaries.map((branch) => [branch.branchName, number(branch.invoiced), number(branch.collected), number(branch.outstanding), number(branch.expenseTotal), number(branch.operatingProfit)])} empty="لا توجد بيانات مالية ضمن الفترة المحددة." />}
    <section className="grid gap-6 xl:grid-cols-2"><TableCard title="أداء المحصلين" columns={["المحصل", "عدد الدفعات", "التحصيل"]} rows={(report?.collectors ?? []).map((row) => [row.name, number(row.count, 0), number(row.amount)])} empty="لا توجد دفعات مكتملة في هذه الفترة." /><TableCard title="أعلى المتأخرات" columns={scope === "all" ? ["الفرع", "المشترك", "الفاتورة", "المتبقي"] : ["المشترك", "الفاتورة", "المتبقي"]} rows={(report?.topDebtors ?? []).map((row) => scope === "all" ? [row.branchName ?? "—", row.subscriber, row.invoiceNo, number(row.balanceDue)] : [row.subscriber, row.invoiceNo, number(row.balanceDue)])} empty="لا توجد متأخرات في الفترة المحددة." /></section>
  </div></DashboardLayout>;
}

function TableCard({ title, columns, rows, empty }: { title: string; columns: string[]; rows: string[][]; empty: string }) { return <Card className="border-white/8 bg-[#111823] shadow-panel"><CardContent className="p-0"><div className="border-b border-white/8 px-5 py-4"><h2 className="font-bold text-white">{title}</h2></div><div className="overflow-x-auto p-5">{rows.length ? <table className="w-full min-w-[380px] text-sm"><thead className="text-right text-xs text-slate-500"><tr>{columns.map((column) => <th className="pb-3" key={column}>{column}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr className="border-t border-white/7" key={`${row[0]}-${index}`}>{row.map((cell, cellIndex) => <td className={cellIndex === 0 ? "py-3 font-bold text-white" : "py-3 text-slate-300"} key={cellIndex}>{cell}</td>)}</tr>)}</tbody></table> : <p className="rounded-xl border border-dashed border-white/10 px-4 py-10 text-center text-sm text-slate-500">{empty}</p>}</div></CardContent></Card>; }
