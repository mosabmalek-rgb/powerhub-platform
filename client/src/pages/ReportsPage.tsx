import { useAuth } from "@/_core/hooks/useAuth";
import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { startLogin } from "@/const";
import { trpc } from "@/lib/trpc";
import { Download, FileBarChart2, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

const inputClass = "h-10 rounded-xl border border-white/10 bg-white/[0.025] px-3 text-sm text-white outline-none focus:border-[#F5B800]/70";
const currentDate = new Date().toISOString().slice(0, 10);
const currentMonthStart = `${currentDate.slice(0, 7)}-01`;
const number = (value: unknown, digits = 2) => new Intl.NumberFormat("ar", { maximumFractionDigits: digits }).format(Number(value ?? 0));

export default function ReportsPage() {
  const { isAuthenticated, loading } = useAuth();
  const sitesQuery = trpc.powerhub.sites.list.useQuery(undefined, { enabled: isAuthenticated });
  const [siteId, setSiteId] = useState<number | null>(null);
  const [startDate, setStartDate] = useState(currentMonthStart);
  const [endDate, setEndDate] = useState(currentDate);
  useEffect(() => { if (!siteId && sitesQuery.data?.[0]) setSiteId(sitesQuery.data[0].id); }, [siteId, sitesQuery.data]);
  const reportQuery = trpc.powerhub.reports.range.useQuery({ siteId: siteId ?? 0, startDate, endDate }, { enabled: Boolean(siteId && isAuthenticated && startDate <= endDate) });

  const downloadCsv = () => {
    if (!reportQuery.data) return;
    const rows = [
      ["المؤشر", "القيمة"],
      ["بداية الفترة", startDate], ["نهاية الفترة", endDate],
      ["الفوترة", reportQuery.data.summary.invoiced], ["التحصيل", reportQuery.data.summary.collected], ["المتأخرات", reportQuery.data.summary.outstanding], ["الاستهلاك kWh", reportQuery.data.summary.energyKwh], ["المصروفات", reportQuery.data.summary.expenseTotal], ["الربح التشغيلي", reportQuery.data.summary.operatingProfit],
      [], ["المحصل", "عدد الدفعات", "قيمة التحصيل"],
      ...reportQuery.data.collectors.map((row) => [row.name, row.count, row.amount]),
    ];
    const csv = "\uFEFF" + rows.map((row) => row.map((cell) => `"${String(cell ?? "").replaceAll('"', '""')}"`).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = `powerhub-report-${startDate}_to_${endDate}.csv`; link.click(); URL.revokeObjectURL(url);
  };

  if (loading) return <DashboardLayout><div className="grid min-h-[60vh] place-items-center"><Loader2 className="h-7 w-7 animate-spin text-[#F5B800]" /></div></DashboardLayout>;
  if (!isAuthenticated) return <DashboardLayout><div className="mx-auto mt-12 max-w-xl rounded-[28px] border border-[#F5B800]/20 bg-[#111823] p-8 text-center shadow-panel"><FileBarChart2 className="mx-auto h-8 w-8 text-[#F5B800]" /><h1 className="mt-5 text-xl font-extrabold text-white">سجّل الدخول لعرض التقارير</h1><Button onClick={() => startLogin()} className="mt-6 bg-[#F5B800] font-bold text-[#0D1117] hover:bg-[#ffd23f]">تسجيل الدخول</Button></div></DashboardLayout>;

  const summary = reportQuery.data?.summary;
  return <DashboardLayout><div className="space-y-6 pb-12"><header className="flex flex-col gap-4 rounded-[24px] border border-white/8 bg-[#111823]/80 p-5 shadow-panel sm:flex-row sm:items-center sm:justify-between"><div><div className="flex items-center gap-2 text-sm font-bold text-[#F5B800]"><FileBarChart2 className="h-4 w-4" />الرؤية والتحليل</div><h1 className="mt-1 text-2xl font-extrabold text-white">التقارير المالية</h1><p className="mt-2 text-sm text-slate-400">إيرادات وتحصيلات ومصروفات ومتأخرات وأداء المحصلين ضمن نطاق تحدده أنت.</p></div><div className="flex flex-wrap gap-2">{sitesQuery.data?.length ? <select value={siteId ?? ""} onChange={(e) => setSiteId(Number(e.target.value))} className={inputClass}>{sitesQuery.data.map((site) => <option className="bg-[#111823]" value={site.id} key={site.id}>{site.name}</option>)}</select> : null}<input aria-label="تاريخ بداية التقرير" type="date" value={startDate} max={endDate} onChange={(e) => setStartDate(e.target.value)} className={inputClass} dir="ltr" /><input aria-label="تاريخ نهاية التقرير" type="date" value={endDate} min={startDate} onChange={(e) => setEndDate(e.target.value)} className={inputClass} dir="ltr" /><Button onClick={downloadCsv} disabled={!reportQuery.data || startDate > endDate} className="bg-[#F5B800] font-bold text-[#0D1117] hover:bg-[#ffd23f]"><Download className="ml-2 h-4 w-4" />CSV</Button></div></header>
    <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{[{ label: "إجمالي الفوترة", value: summary?.invoiced }, { label: "التحصيل", value: summary?.collected }, { label: "المتأخرات", value: summary?.outstanding }, { label: "الربح التشغيلي", value: summary?.operatingProfit }].map((item) => <Card className="border-white/8 bg-[#111823] shadow-panel" key={item.label}><CardContent className="p-5"><p className="text-sm text-slate-400">{item.label}</p><p className="mt-4 font-display text-3xl font-extrabold text-white">{number(item.value)}</p><p className="mt-2 text-xs text-slate-500">من {startDate} إلى {endDate}</p></CardContent></Card>)}</section>
    <section className="grid gap-6 xl:grid-cols-2"><TableCard title="أداء المحصلين" columns={["المحصل", "عدد الدفعات", "التحصيل"]} rows={(reportQuery.data?.collectors ?? []).map((row) => [row.name, number(row.count, 0), number(row.amount)])} empty="لا توجد دفعات مكتملة في هذه الفترة." /><TableCard title="أعلى المتأخرات" columns={["المشترك", "الفاتورة", "المتبقي"]} rows={(reportQuery.data?.topDebtors ?? []).map((row) => [row.subscriber, row.invoiceNo, number(row.balanceDue)])} empty="لا توجد متأخرات في الفترة المحددة." /></section>
  </div></DashboardLayout>;
}

function TableCard({ title, columns, rows, empty }: { title: string; columns: string[]; rows: string[][]; empty: string }) { return <Card className="border-white/8 bg-[#111823] shadow-panel"><CardContent className="p-0"><div className="border-b border-white/8 px-5 py-4"><h2 className="font-bold text-white">{title}</h2></div><div className="overflow-x-auto p-5">{rows.length ? <table className="w-full min-w-[380px] text-sm"><thead className="text-right text-xs text-slate-500"><tr>{columns.map((column) => <th className="pb-3" key={column}>{column}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr className="border-t border-white/7" key={`${row[0]}-${index}`}>{row.map((cell, cellIndex) => <td className={cellIndex === 0 ? "py-3 font-bold text-white" : "py-3 text-slate-300"} key={cellIndex}>{cell}</td>)}</tr>)}</tbody></table> : <p className="rounded-xl border border-dashed border-white/10 px-4 py-10 text-center text-sm text-slate-500">{empty}</p>}</div></CardContent></Card>; }
