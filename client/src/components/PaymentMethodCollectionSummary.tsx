import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import ExcelJS from "exceljs";
import { Download, FileSpreadsheet, Loader2, RotateCcw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

const labels: Record<string, string> = { cash: "كاش", jawwal_pay: "Jawwal Pay", palpay: "PalPay", bank_of_palestine: "بنك فلسطين", wallet: "محفظة", bank_transfer: "تحويل بنكي", card: "بطاقة" };
const chartColors = ["#F5B800", "#34d399", "#38bdf8", "#a78bfa", "#fb7185", "#f97316", "#94a3b8"];
const format = (value: number) => new Intl.NumberFormat("ar", { maximumFractionDigits: 2 }).format(value);
const POWERHUB_LOGO_URL = "/manus-storage/powerhub-official-logo_0bcbb9c6.png";
const thinBorder = { top: { style: "thin" as const, color: { argb: "FFCAD1DC" } }, left: { style: "thin" as const, color: { argb: "FFCAD1DC" } }, bottom: { style: "thin" as const, color: { argb: "FFCAD1DC" } }, right: { style: "thin" as const, color: { argb: "FFCAD1DC" } } };

type MethodGroup = { method: string; count: number; amount: number };
export type PaymentDateRange = { from?: string; to?: string };

function isWithinDateRange(value: unknown, range: PaymentDateRange) {
  if (!range.from && !range.to) return true;
  const paidAt = new Date(String(value));
  if (Number.isNaN(paidAt.getTime())) return false;
  const from = range.from ? new Date(`${range.from}T00:00:00`) : undefined;
  const to = range.to ? new Date(`${range.to}T23:59:59.999`) : undefined;
  return (!from || paidAt >= from) && (!to || paidAt <= to);
}

export function summarizePaymentMethods(payments: any[], selectedMethod = "all", range: PaymentDateRange = {}) {
  const completed = payments.filter((row) => row.payment.status === "completed" && isWithinDateRange(row.payment.paidAt, range));
  const filtered = selectedMethod === "all" ? completed : completed.filter((row) => row.payment.paymentMethod === selectedMethod);
  const groups = Object.entries(filtered.reduce((acc: Record<string, Omit<MethodGroup, "method">>, row) => { const key = row.payment.paymentMethod; acc[key] ??= { count: 0, amount: 0 }; acc[key].count += 1; acc[key].amount += Number(row.payment.amount); return acc; }, {})).map(([method, value]) => ({ method, ...value })).sort((a, b) => b.amount - a.amount);
  return { completed, filtered, groups, total: filtered.reduce((sum, row) => sum + Number(row.payment.amount), 0) };
}

function escapeCsv(value: unknown) { return `"${String(value ?? "").replace(/"/g, '""')}"`; }
function dateLabel(range: PaymentDateRange) { return range.from || range.to ? `${range.from || "بداية السجل"} إلى ${range.to || "اليوم"}` : "كامل الفترة"; }
function filterLabel(method: string) { return method === "all" ? "كل طرق الدفع" : labels[method] ?? method; }
function safeDate(value: unknown) { const date = new Date(String(value)); return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString("ar-IQ"); }

export function buildPaymentMethodCsv(groups: MethodGroup[], total: number, selectedMethod: string, range: PaymentDateRange = {}) {
  const lines = [["تقرير ملخص التحصيلات حسب طريقة الدفع"], ["الفلتر", filterLabel(selectedMethod)], ["النطاق الزمني", dateLabel(range)], ["طريقة الدفع", "عدد الدفعات المكتملة", "إجمالي المبلغ"], ...groups.map((group) => [labels[group.method] ?? group.method, group.count, group.amount.toFixed(2)]), ["الإجمالي", "", total.toFixed(2)]];
  return `\uFEFF${lines.map((line) => line.map(escapeCsv).join(",")).join("\r\n")}`;
}

function styleHeader(row: ExcelJS.Row, columns: number) {
  row.height = 24;
  for (let index = 1; index <= columns; index += 1) {
    const cell = row.getCell(index);
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0D1117" } };
    cell.font = { name: "Tahoma", bold: true, color: { argb: "FFFFFFFF" } };
    cell.alignment = { horizontal: "center", vertical: "middle" };
    cell.border = thinBorder;
  }
}

function styleDataRows(sheet: ExcelJS.Worksheet, start: number, end: number, columns: number) {
  for (let rowIndex = start; rowIndex <= end; rowIndex += 1) {
    const row = sheet.getRow(rowIndex);
    row.height = 21;
    for (let colIndex = 1; colIndex <= columns; colIndex += 1) {
      const cell = row.getCell(colIndex);
      cell.font = { name: "Tahoma", color: { argb: "FF1B222C" } };
      cell.alignment = { horizontal: colIndex === 1 ? "right" : "center", vertical: "middle" };
      cell.border = thinBorder;
      if (rowIndex % 2 === 0) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF5F6F8" } };
    }
  }
}

function receiptLink(row: any, baseUrl: string) {
  const value = row.receiptImageUrl ?? row.payment?.receiptImageUrl ?? row.payment?.receiptImageKey;
  if (!value) return "";
  if (String(value).startsWith("http")) return String(value);
  const path = String(value).startsWith("/") ? String(value) : `/manus-storage/${value}`;
  return `${baseUrl.replace(/\/$/, "")}${path}`;
}

function styleSubtotalRow(row: ExcelJS.Row, columns: number) {
  row.height = 23;
  for (let colIndex = 1; colIndex <= columns; colIndex += 1) {
    const cell = row.getCell(colIndex);
    cell.font = { name: "Tahoma", bold: true, color: { argb: "FF0D1117" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFE6A0" } };
    cell.border = thinBorder;
    cell.alignment = { horizontal: colIndex === 1 ? "right" : "center", vertical: "middle" };
  }
}

export function buildPaymentMethodWorkbook(groups: MethodGroup[], total: number, selectedMethod: string, range: PaymentDateRange = {}, paymentRows: any[] = [], baseUrl = "") {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "PowerHub";
  workbook.created = new Date();
  const summary = workbook.addWorksheet("ملخص التحصيل", { views: [{ rightToLeft: true }] });
  summary.columns = [{ width: 28 }, { width: 22 }, { width: 20 }, { width: 20 }];
  summary.mergeCells("A1:C1");
  summary.getCell("A1").value = "PowerHub — تقرير ملخص التحصيلات";
  summary.getCell("A1").font = { name: "Tahoma", bold: true, size: 16, color: { argb: "FFF5B800" } };
  summary.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0D1117" } };
  summary.getCell("A1").alignment = { horizontal: "right", vertical: "middle" };
  summary.getRow(1).height = 38;
  summary.getCell("A2").value = "الفلتر"; summary.getCell("B2").value = filterLabel(selectedMethod);
  summary.getCell("A3").value = "النطاق الزمني"; summary.getCell("B3").value = dateLabel(range);
  summary.getCell("A5").value = "طريقة الدفع"; summary.getCell("B5").value = "عدد الدفعات المكتملة"; summary.getCell("C5").value = "إجمالي المبلغ";
  styleHeader(summary.getRow(5), 3);
  groups.forEach((group) => summary.addRow([labels[group.method] ?? group.method, group.count, group.amount]));
  const totalRow = 6 + groups.length;
  summary.getCell(`A${totalRow}`).value = "الإجمالي"; summary.getCell(`C${totalRow}`).value = total;
  styleDataRows(summary, 2, 3, 3); styleDataRows(summary, 6, totalRow - 1, 3);
  for (let index = 1; index <= 3; index += 1) { const cell = summary.getCell(totalRow, index); cell.font = { name: "Tahoma", bold: true, color: { argb: "FF0D1117" } }; cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF5B800" } }; cell.border = thinBorder; cell.alignment = { horizontal: index === 1 ? "right" : "center", vertical: "middle" }; }
  summary.getColumn(3).numFmt = "#,##0.00";

  const details = workbook.addWorksheet("تفاصيل الدفعات", { views: [{ rightToLeft: true }] });
  details.columns = [{ width: 19 }, { width: 19 }, { width: 24 }, { width: 18 }, { width: 16 }, { width: 22 }, { width: 18 }, { width: 20 }];
  details.mergeCells("A1:H1");
  details.getCell("A1").value = "PowerHub — تفاصيل الدفعات المكتملة";
  details.getCell("A1").font = { name: "Tahoma", bold: true, size: 15, color: { argb: "FFF5B800" } };
  details.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0D1117" } };
  details.getCell("A1").alignment = { horizontal: "right", vertical: "middle" };
  details.getRow(1).height = 38;
  details.addRow(["رقم الإيصال", "رقم الفاتورة", "المشترك", "طريقة الدفع", "المبلغ", "مرجع العملية", "تاريخ الدفع", "صورة الإيصال"]);
  styleHeader(details.getRow(2), 8);
  const byMethod = paymentRows.reduce((acc: Record<string, any[]>, row) => { const key = row.payment.paymentMethod; (acc[key] ??= []).push(row); return acc; }, {});
  Object.entries(byMethod).sort(([left], [right]) => (labels[left] ?? left).localeCompare(labels[right] ?? right, "ar")).forEach(([methodKey, methodRows]) => {
    let subtotal = 0;
    methodRows.forEach((row) => {
      subtotal += Number(row.payment.amount);
      const added = details.addRow([row.payment.paymentNo, row.invoiceNo ?? "—", row.subscriber?.fullName ?? "—", labels[row.payment.paymentMethod] ?? row.payment.paymentMethod, Number(row.payment.amount), row.payment.referenceNo ?? "—", safeDate(row.payment.paidAt), ""]);
      const imageUrl = receiptLink(row, baseUrl);
      if (imageUrl) { added.getCell(8).value = { text: "عرض الصورة", hyperlink: imageUrl }; added.getCell(8).font = { name: "Tahoma", color: { argb: "FF0563C1" }, underline: true }; }
      styleDataRows(details, added.number, added.number, 8);
    });
    const subtotalRow = details.addRow([`إجمالي فرعي — ${labels[methodKey] ?? methodKey}`, "", "", "", subtotal, "", "", ""]);
    styleSubtotalRow(subtotalRow, 8);
  });
  const grandTotalRow = details.addRow(["الإجمالي العام", "", "", "", total, "", "", ""]);
  for (let index = 1; index <= 8; index += 1) {
    const cell = grandTotalRow.getCell(index);
    cell.font = { name: "Tahoma", bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0D1117" } };
    cell.border = thinBorder;
    cell.alignment = { horizontal: index === 1 ? "right" : "center", vertical: "middle" };
  }
  details.getColumn(5).numFmt = "#,##0.00";
  details.autoFilter = { from: "A2", to: `H${Math.max(2, details.rowCount)}` };
  details.views = [{ state: "frozen", ySplit: 2, rightToLeft: true }];
  return workbook;
}

async function addPowerHubLogo(workbook: ExcelJS.Workbook) {
  try {
    const response = await fetch(POWERHUB_LOGO_URL);
    if (!response.ok) return;
    const imageId = workbook.addImage({ buffer: await response.arrayBuffer(), extension: "png" });
    workbook.getWorksheet("ملخص التحصيل")?.addImage(imageId, { tl: { col: 3, row: 0 }, ext: { width: 105, height: 36 } });
    workbook.getWorksheet("تفاصيل الدفعات")?.addImage(imageId, { tl: { col: 6, row: 0 }, ext: { width: 105, height: 36 } });
  } catch { /* يستمر التصدير بترويسة PowerHub النصية إذا تعذر تحميل الشعار. */ }
}

function downloadPaymentMethodCsv(groups: MethodGroup[], total: number, selectedMethod: string, range: PaymentDateRange) { const methodLabel = selectedMethod === "all" ? "all-methods" : selectedMethod; const dateSuffix = range.from || range.to ? `-${range.from || "start"}-${range.to || "end"}` : ""; const blob = new Blob([buildPaymentMethodCsv(groups, total, selectedMethod, range)], { type: "text/csv;charset=utf-8" }); const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = `powerhub-payment-method-summary-${methodLabel}${dateSuffix}.csv`; document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url); }
async function downloadPaymentMethodExcel(groups: MethodGroup[], total: number, selectedMethod: string, range: PaymentDateRange, paymentRows: any[]) { const methodLabel = selectedMethod === "all" ? "all-methods" : selectedMethod; const dateSuffix = range.from || range.to ? `-${range.from || "start"}-${range.to || "end"}` : ""; const workbook = buildPaymentMethodWorkbook(groups, total, selectedMethod, range, paymentRows, window.location.origin); await addPowerHubLogo(workbook); const buffer = await workbook.xlsx.writeBuffer(); const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }); const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = `powerhub-payment-method-summary-${methodLabel}${dateSuffix}.xlsx`; document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url); }

function PaymentMethodChart({ groups, total }: { groups: MethodGroup[]; total: number }) { return <div className="rounded-2xl border border-white/8 bg-[#0D1117]/45 p-4"><div className="flex items-center justify-between"><div><p className="font-bold text-white">توزيع التحصيلات حسب الطريقة</p><p className="mt-1 text-xs text-slate-500">نسبة كل طريقة من إجمالي الفترة المفلترة.</p></div><span className="font-display text-sm text-[#F5B800]">100%</span></div>{groups.length ? <div className="mt-5"><div aria-label="رسم أعمدة توزيع طرق الدفع" className="flex h-44 items-end gap-3 border-b border-white/10 px-2 pb-2">{groups.map((group, index) => { const percentage = total ? Math.round((group.amount / total) * 100) : 0; return <div key={group.method} className="flex h-full min-w-14 flex-1 flex-col items-center justify-end gap-2"><span className="text-xs font-bold text-white">{percentage}%</span><div title={`${labels[group.method] ?? group.method}: ${percentage}%`} className="w-full max-w-14 rounded-t-lg transition-[height] duration-200" style={{ height: `${Math.max(8, percentage)}%`, backgroundColor: chartColors[index % chartColors.length] }} /><span className="max-w-16 truncate text-[10px] text-slate-400">{labels[group.method] ?? group.method}</span></div>; })}</div><div className="mt-4 grid gap-2 sm:grid-cols-2">{groups.map((group, index) => <div key={group.method} className="flex items-center justify-between rounded-lg bg-white/[.025] px-3 py-2 text-xs"><span className="flex items-center gap-2 text-slate-300"><span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: chartColors[index % chartColors.length] }} />{labels[group.method] ?? group.method}</span><span className="font-bold text-white">{format(group.amount)}</span></div>)}</div></div> : <p className="mt-5 text-sm text-slate-500">لا توجد بيانات مكتملة ضمن الفترة المختارة لعرض الرسم.</p>}</div>; }

export function PaymentMethodCollectionSummary({ payments }: { payments: any[] }) {
  const [method, setMethod] = useState("all");
  const [range, setRange] = useState<PaymentDateRange>({});
  const [exportingExcel, setExportingExcel] = useState(false);
  const [excelMethods, setExcelMethods] = useState<string[]>([]);
  const { completed, filtered, groups, total } = summarizePaymentMethods(payments, method, range);
  const periodPayments = summarizePaymentMethods(payments, "all", range).completed;
  const methods = Array.from(new Set(periodPayments.map((row) => row.payment.paymentMethod)));
  const excelRows = excelMethods.length ? periodPayments.filter((row) => excelMethods.includes(row.payment.paymentMethod)) : periodPayments;
  const { groups: excelGroups, total: excelTotal } = summarizePaymentMethods(excelRows);
  const excelFilterLabel = excelMethods.length ? excelMethods.map((item) => labels[item] ?? item).join("، ") : "all";
  const clearRange = () => setRange({});
  const exportExcel = async () => { setExportingExcel(true); try { await downloadPaymentMethodExcel(excelGroups, excelTotal, excelFilterLabel, range, excelRows); toast.success("تم إنشاء ملف Excel وتحميله بنجاح."); } catch { toast.error("تعذر إنشاء ملف Excel. أعد المحاولة."); } finally { setExportingExcel(false); } };
  const toggleExcelMethod = (item: string) => setExcelMethods((current) => current.includes(item) ? current.filter((value) => value !== item) : [...current, item]);
  return <Card className="border-white/8 bg-[#111823] shadow-panel"><CardContent className="p-5"><div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between"><div><h2 className="font-bold text-white">ملخص التحصيل حسب طريقة الدفع</h2><p className="mt-1 text-sm text-slate-400">اعرض الدفعات المكتملة ضمن نطاق زمني وطريقة دفع محددين لتسهيل الجرد المالي.</p><p className="mt-3 font-display text-3xl font-extrabold text-emerald-300">{format(total)}</p><p className="mt-1 text-xs text-slate-500">النطاق: {dateLabel(range)}</p></div><div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4"><label className="block"><span className="mb-2 block text-xs font-bold text-slate-400">من تاريخ</span><input type="date" value={range.from ?? ""} onChange={(event) => setRange((current) => ({ ...current, from: event.target.value || undefined }))} className="h-10 w-full rounded-xl border border-white/10 bg-white/[.025] px-3 text-sm text-white outline-none focus:border-[#F5B800]/70" /></label><label className="block"><span className="mb-2 block text-xs font-bold text-slate-400">إلى تاريخ</span><input type="date" value={range.to ?? ""} onChange={(event) => setRange((current) => ({ ...current, to: event.target.value || undefined }))} className="h-10 w-full rounded-xl border border-white/10 bg-white/[.025] px-3 text-sm text-white outline-none focus:border-[#F5B800]/70" /></label><label className="block"><span className="mb-2 block text-xs font-bold text-slate-400">طريقة الدفع</span><select value={method} onChange={(event) => setMethod(event.target.value)} className="h-10 w-full rounded-xl border border-white/10 bg-white/[.025] px-3 text-sm text-white outline-none focus:border-[#F5B800]/70"><option className="bg-[#111823]" value="all">كل الطرق</option>{methods.map((item) => <option className="bg-[#111823]" key={item} value={item}>{labels[item] ?? item}</option>)}</select></label><div className="flex flex-col gap-2"><span className="mb-2 block text-xs font-bold text-slate-400">التقرير</span><Button type="button" size="sm" variant="outline" disabled={!filtered.length || exportingExcel} onClick={() => downloadPaymentMethodCsv(groups, total, method, range)} className="border-[#F5B800]/40 text-[#F5B800] hover:bg-[#F5B800]/10 hover:text-[#ffd23f]"><Download className="ml-1 h-3.5 w-3.5" />CSV</Button><Button type="button" size="sm" disabled={!excelRows.length || exportingExcel} onClick={exportExcel} className="bg-emerald-400 text-[#0D1117] hover:bg-emerald-300">{exportingExcel ? <Loader2 className="ml-1 h-3.5 w-3.5 animate-spin" /> : <FileSpreadsheet className="ml-1 h-3.5 w-3.5" />}{exportingExcel ? "جارٍ تجهيز Excel..." : "Excel"}</Button><Button type="button" size="sm" variant="ghost" onClick={clearRange} className="text-slate-400 hover:bg-white/5 hover:text-white"><RotateCcw className="ml-1 h-3.5 w-3.5" />مسح الفترة</Button></div><fieldset className="sm:col-span-2 xl:col-span-4 rounded-xl border border-white/10 bg-white/[.025] p-3"><div className="flex items-center justify-between gap-2"><legend className="text-xs font-bold text-slate-300">طرق الدفع المضمّنة في Excel</legend><button type="button" onClick={() => setExcelMethods([])} className="text-xs text-[#F5B800] hover:underline">اختيار الكل</button></div><div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">{methods.map((item) => <label key={item} className="flex cursor-pointer items-center gap-1.5 text-xs text-slate-300"><input type="checkbox" checked={!excelMethods.length || excelMethods.includes(item)} onChange={() => toggleExcelMethod(item)} className="accent-[#F5B800]" />{labels[item] ?? item}</label>)}</div><p className="mt-2 text-[11px] text-slate-500">{excelMethods.length ? `سيُصدّر: ${excelFilterLabel}` : "لم يُحدد خيار؛ سيُصدّر كل طرق الدفع."}</p></fieldset></div></div><div className="mt-6 grid gap-5 xl:grid-cols-[1.15fr_.85fr]"><div className="grid gap-3 sm:grid-cols-2">{groups.map((group) => <div key={group.method} className="rounded-xl border border-white/8 bg-white/[.025] p-4"><p className="text-xs font-bold text-slate-400">{labels[group.method] ?? group.method}</p><p className="mt-2 font-display text-xl font-extrabold text-[#F5B800]">{format(group.amount)}</p><p className="mt-1 text-xs text-slate-500">{group.count} دفعة مكتملة</p></div>)}{!groups.length ? <div className="rounded-xl border border-dashed border-white/10 p-5 text-sm text-slate-500">لا توجد دفعات مكتملة ضمن الفترة أو الفلتر المحدد.</div> : null}</div><PaymentMethodChart groups={groups} total={total} /></div></CardContent></Card>;
}
