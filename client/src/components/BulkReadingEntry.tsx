import { loadExcelJS } from "@/lib/lazy-report-deps";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { prepareBulkReadings, type BulkReadingDraft } from "@/lib/bulk-reading-import";
import { trpc } from "@/lib/trpc";
import { Download, FileSpreadsheet, Loader2, Plus, UploadCloud } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

const inputClass = "h-10 w-full rounded-xl border border-white/10 bg-white/[0.025] px-3 text-sm text-white outline-none transition placeholder:text-slate-600 focus:border-[#F5B800]/70 focus:ring-2 focus:ring-[#F5B800]/15";
const today = () => new Date().toISOString().slice(0, 10);
const blankRow = (): BulkReadingDraft => ({ reference: "", readingValue: "", readingDate: today(), notes: "" });

export default function BulkReadingEntry({ siteId, subscribers, readings, onSaved }: { siteId: number; subscribers: any[]; readings: any[]; onSaved: () => Promise<void> }) {
  const [rows, setRows] = useState<BulkReadingDraft[]>([blankRow(), blankRow(), blankRow()]);
  const [isParsing, setIsParsing] = useState(false);
  const create = trpc.powerhub.readings.create.useMutation();
  const prepared = useMemo(() => prepareBulkReadings(rows.filter((row) => row.reference || row.readingValue || row.notes), subscribers, readings), [rows, subscribers, readings]);
  const validRows = prepared.filter((row) => row.status === "ready");
  const setRow = (index: number, key: keyof BulkReadingDraft, value: string) => setRows((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, [key]: value } : row));
  const loadWorkbook = async (file: File | undefined) => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".xlsx")) { toast.error("استخدم ملف Excel بصيغة .xlsx فقط."); return; }
    setIsParsing(true);
    try {
      const { default: ExcelJS } = await loadExcelJS(); const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(await file.arrayBuffer());
      const sheet = workbook.worksheets[0];
      if (!sheet) throw new Error("لا توجد ورقة بيانات في الملف.");
      const parsed: BulkReadingDraft[] = [];
      sheet.eachRow((row, index) => {
        if (index === 1) return;
        const cells = row.values as unknown[];
        const reference = String(cells[1] ?? "").trim();
        const readingValue = String(cells[2] ?? "").trim();
        const rawDate = cells[3];
        const readingDate = rawDate instanceof Date ? rawDate.toISOString().slice(0, 10) : String(rawDate ?? "").trim();
        const notes = String(cells[4] ?? "").trim();
        if (reference || readingValue || readingDate || notes) parsed.push({ reference, readingValue, readingDate, notes });
      });
      if (!parsed.length) throw new Error("لم نعثر على صفوف قراءة. استخدم الأعمدة: الرقم المرجعي، القراءة الحالية، تاريخ القراءة، ملاحظات.");
      setRows(parsed);
      toast.success(`تمت قراءة ${parsed.length} صفاً. راجع الحالة قبل الحفظ.`);
    } catch (error) { toast.error(error instanceof Error ? error.message : "تعذر قراءة ملف Excel."); } finally { setIsParsing(false); }
  };
  const downloadTemplate = async () => {
    try {
      const { default: ExcelJS } = await loadExcelJS(); const workbook = new ExcelJS.Workbook();
      workbook.creator = "PowerHub";
      const sheet = workbook.addWorksheet("قراءات جماعية", { views: [{ rightToLeft: true }] });
      sheet.addRow(["الرقم المرجعي", "القراءة الحالية", "تاريخ القراءة", "ملاحظات"]);
      for (let index = 0; index < 10; index += 1) sheet.addRow(["", "", "", ""]);
      sheet.columns = [{ width: 26 }, { width: 20 }, { width: 18 }, { width: 34 }];
      const header = sheet.getRow(1);
      header.font = { bold: true, color: { argb: "FFFFFFFF" } };
      header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0D1117" } };
      header.alignment = { horizontal: "right" };
      const buffer = await workbook.xlsx.writeBuffer();
      const url = URL.createObjectURL(new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
      const link = document.createElement("a"); link.href = url; link.download = "powerhub-subscriber-readings-template.xlsx"; link.click(); URL.revokeObjectURL(url);
      toast.success("تم تنزيل قالب القراءات الجماعية.");
    } catch { toast.error("تعذر تجهيز قالب Excel."); }
  };
  const saveValid = async () => {
    if (!validRows.length) { toast.error("لا توجد قراءات سليمة للحفظ."); return; }
    let saved = 0;
    for (const row of validRows) {
      try { await create.mutateAsync({ siteId, subscriberId: row.subscriberId!, readingValue: row.readingValue, readingAt: new Date(`${row.readingDate}T12:00:00`), captureMethod: "manual", notes: row.notes || undefined, clientOperationId: crypto.randomUUID() }); saved += 1; }
      catch (error) { toast.error(`${row.subscriberName ?? row.reference}: ${error instanceof Error ? error.message : "تعذر الحفظ."}`); }
    }
    await onSaved();
    if (saved > 0) toast.success(`تم حفظ واعتماد ${saved} قراءة سليمة وإصدار فواتيرها تلقائيًا.`);
    else toast.error("لم يتم حفظ أي قراءة. راجع الأخطاء الظاهرة بجانب الصفوف.");
  };
  return <Card className="border-[#F5B800]/20 bg-[#111823] shadow-panel"><CardContent className="p-5"><div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="flex items-center gap-2 font-bold text-white"><FileSpreadsheet className="h-4 w-4 text-[#F5B800]" />إدخال قراءات جماعي</h2><p className="mt-1 text-xs leading-5 text-slate-500">ارفع Excel: الرقم المرجعي، القراءة الحالية، تاريخ القراءة، ملاحظات؛ أو أدخل الجدول السريع أدناه.</p></div><label><input className="sr-only" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => void loadWorkbook(event.target.files?.[0])} /><span className="inline-flex h-10 cursor-pointer items-center justify-center rounded-xl border border-[#F5B800]/35 px-4 text-sm font-bold text-[#F5B800] hover:bg-[#F5B800]/10">{isParsing ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <UploadCloud className="ml-2 h-4 w-4" />}رفع ملف Excel</span></label><Button type="button" variant="outline" onClick={() => void downloadTemplate()} className="mt-3 border-white/15 text-slate-300 hover:border-[#F5B800]/50 hover:text-[#F5B800]"><Download className="ml-2 h-4 w-4" />تنزيل قالب Excel فارغ</Button></div><div className="mt-5 overflow-x-auto"><table className="w-full min-w-[860px] text-sm"><thead className="text-right text-xs text-slate-500"><tr><th className="pb-3">الرقم المرجعي</th><th className="pb-3">القراءة الحالية</th><th className="pb-3">التاريخ</th><th className="pb-3">ملاحظة</th><th className="pb-3">الحالة / الاستهلاك</th></tr></thead><tbody>{rows.map((row, index) => { const preview = prepared.find((entry) => entry.reference === row.reference && entry.readingValue === row.readingValue && entry.readingDate === row.readingDate); return <tr key={index} className="border-t border-white/7"><td className="py-2"><input value={row.reference} onChange={(event) => setRow(index, "reference", event.target.value)} className={inputClass} dir="ltr" /></td><td className="py-2"><input value={row.readingValue} onChange={(event) => setRow(index, "readingValue", event.target.value)} className={inputClass} dir="ltr" /></td><td className="py-2"><input type="date" value={row.readingDate} onChange={(event) => setRow(index, "readingDate", event.target.value)} className={inputClass} /></td><td className="py-2"><input value={row.notes ?? ""} onChange={(event) => setRow(index, "notes", event.target.value)} className={inputClass} /></td><td className={`py-2 text-xs ${preview?.status === "error" ? "text-rose-300" : "text-emerald-300"}`}>{preview ? preview.status === "ready" ? `${preview.subscriberName} · ${preview.consumption?.toFixed(3)} kWh` : preview.error : "أدخل البيانات للمراجعة"}</td></tr>; })}</tbody></table></div><div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><p className="text-xs text-slate-500">القراءات السليمة: <strong className="text-emerald-300">{validRows.length}</strong> · تحتاج مراجعة: <strong className="text-rose-300">{prepared.filter((row) => row.status === "error").length}</strong></p><div className="flex gap-2"><Button variant="outline" onClick={() => setRows((current) => [...current, blankRow()])} className="border-white/15 text-slate-300"><Plus className="ml-2 h-4 w-4" />صف جديد</Button><Button disabled={create.isPending || !validRows.length} onClick={() => void saveValid()} className="bg-[#F5B800] font-bold text-[#0D1117] hover:bg-[#ffd23f]">حفظ القراءات السليمة</Button></div></div></CardContent></Card>;
}
