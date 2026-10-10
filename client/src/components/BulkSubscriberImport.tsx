import { loadExcelJS } from "@/lib/lazy-report-deps";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { prepareSubscriberImport, type SubscriberImportDraft } from "@/lib/subscriber-import";
import { trpc } from "@/lib/trpc";
import { Download, FileSpreadsheet, Loader2, UploadCloud } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

type ImportResult = { created: Array<{ sourceRow: number; fullName: string; subscriberNo: string; openingReadingStatus?: string | null }>; updated: Array<{ sourceRow: number; fullName: string; subscriberNo: string }>; failed: Array<{ sourceRow: number; fullName: string; reason: string }>; message: string };

function cellText(value: unknown) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (value && typeof value === "object" && "text" in value) return String((value as { text?: unknown }).text ?? "").trim();
  return String(value ?? "").trim();
}

export function BulkSubscriberImport({ siteId, onSaved, canApproveOpeningReadings = false }: { siteId: number; onSaved: () => Promise<void>; canApproveOpeningReadings?: boolean }) {
  const [rows, setRows] = useState<SubscriberImportDraft[]>([]);
  const [isParsing, setIsParsing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState("");
  const [updateExisting, setUpdateExisting] = useState(false);
  const [approveOpeningReadings, setApproveOpeningReadings] = useState(false);
  const [clientOperationId, setClientOperationId] = useState<string>();
  const [result, setResult] = useState<ImportResult | null>(null);
  const importSubscribers = trpc.powerhub.subscribers.bulkImport.useMutation({
    onMutate: () => { setProgress(72); setProgressLabel("جارٍ حفظ المشتركين…"); },
    onSuccess: async (value) => { setProgress(100); setProgressLabel("اكتمل الحفظ بنجاح"); setResult(value); setClientOperationId(undefined); await onSaved(); toast.success(`تمت إضافة ${value.created.length} وتحديث ${value.updated.length} مشتركاً.`); },
    onError: (error) => { setProgress(0); setProgressLabel(""); toast.error(error.message); },
  });
  const prepared = useMemo(() => prepareSubscriberImport(rows), [rows]);
  const validRows = prepared.filter((row) => row.status === "ready");
  const errorRows = prepared.filter((row) => row.status === "error");

  const loadWorkbook = async (file: File | undefined) => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".xlsx")) { toast.error("استخدم ملف Excel بصيغة .xlsx فقط."); return; }
    setIsParsing(true); setResult(null); setProgress(15); setProgressLabel("جارٍ قراءة ملف Excel…");
    let parsedSuccessfully = false;
    try {
      const { default: ExcelJS } = await loadExcelJS(); const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(await file.arrayBuffer());
      setProgress(45); setProgressLabel("جارٍ تحليل أعمدة المشتركين…");
      const sheet = workbook.worksheets[0];
      if (!sheet) throw new Error("لا توجد ورقة بيانات في الملف.");
      const headerCells = typeof sheet.getRow === "function" ? sheet.getRow(1).values as unknown[] : [];
      const includesWhatsappColumn = /واتساب|whatsapp/i.test(cellText(headerCells[3]));
      const parsed: SubscriberImportDraft[] = [];
      sheet.eachRow((row, index) => {
        if (index === 1 || parsed.length >= 300) return;
        const cells = row.values as unknown[];
        const entry = includesWhatsappColumn
          ? { sourceRow: index, fullName: cellText(cells[1]), phone: cellText(cells[2]), whatsappNumber: cellText(cells[3]) || undefined, address: cellText(cells[4]), subscriptionType: cellText(cells[5]), subscriberNo: cellText(cells[6]) || undefined, openingReading: cellText(cells[7]) || undefined, openingReadingAt: cellText(cells[8]) || undefined }
          : { sourceRow: index, fullName: cellText(cells[1]), phone: cellText(cells[2]), whatsappNumber: undefined, address: cellText(cells[3]), subscriptionType: cellText(cells[4]), subscriberNo: cellText(cells[5]) || undefined, openingReading: cellText(cells[6]) || undefined, openingReadingAt: cellText(cells[7]) || undefined };
        if (entry.fullName || entry.phone || entry.whatsappNumber || entry.address || entry.subscriptionType || entry.subscriberNo) parsed.push(entry);
      });
      if (!parsed.length) throw new Error("لم نعثر على صفوف مشتركين. استخدم الأعمدة: الاسم الكامل، رقم الجوال، رقم واتساب الاختياري، العنوان، نوع الاشتراك، والرقم المرجعي الاختياري.");
      setProgress(85); setProgressLabel("جارٍ تجهيز المعاينة…");
      setRows(parsed);
      parsedSuccessfully = true;
      toast.success(`تمت قراءة ${parsed.length} صفاً. راجع المعاينة قبل الحفظ.`);
    } catch (error) { setProgress(0); setProgressLabel(""); toast.error(error instanceof Error ? error.message : "تعذر قراءة ملف Excel."); }
    finally { setIsParsing(false); if (parsedSuccessfully) { setProgress(100); setProgressLabel("اكتملت قراءة الملف"); } }
  };

  const downloadTemplate = async () => {
    try {
      const { default: ExcelJS } = await loadExcelJS(); const workbook = new ExcelJS.Workbook();
      workbook.creator = "PowerHub";
      const sheet = workbook.addWorksheet("استيراد المشتركين", { views: [{ rightToLeft: true }] });
      sheet.addRow(["الاسم الكامل", "رقم الجوال الدولي", "رقم واتساب (اختياري)", "العنوان (اختياري)", "نوع الاشتراك: سكني أو تجاري", "الرقم المرجعي (اختياري للتحديث فقط)", "القراءة الافتتاحية (اختياري)", "تاريخ القراءة الافتتاحية (اختياري)"]);
      for (let index = 0; index < 12; index += 1) sheet.addRow(["", "", "", "", "سكني", "", "", ""]);
      sheet.columns = [{ width: 30 }, { width: 24 }, { width: 24 }, { width: 38 }, { width: 28 }, { width: 32 }, { width: 24 }, { width: 30 }];
      const header = sheet.getRow(1); header.font = { bold: true, color: { argb: "FFFFFFFF" } }; header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0D1117" } }; header.alignment = { horizontal: "right", vertical: "middle", wrapText: true }; header.height = 34;
      const buffer = await workbook.xlsx.writeBuffer();
      const url = URL.createObjectURL(new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
      const link = document.createElement("a"); link.href = url; link.download = "powerhub-subscribers-import-template.xlsx"; link.click(); URL.revokeObjectURL(url);
      toast.success("تم تنزيل قالب استيراد المشتركين.");
    } catch { toast.error("تعذر تجهيز قالب Excel."); }
  };

  const saveValid = () => {
    if (!validRows.length) return;
    const nextOperationId = clientOperationId ?? crypto.randomUUID();
    setClientOperationId(nextOperationId);
    importSubscribers.mutate({
      siteId,
      updateExisting,
      clientOperationId: nextOperationId,
      approveOpeningReadings,
      rows: validRows.map((row) => ({
        sourceRow: row.rowNumber,
        subscriberNo: updateExisting ? row.subscriberNo || undefined : undefined,
        fullName: row.fullName,
        phone: row.phone,
        whatsappNumber: row.whatsappNumber || undefined,
        address: row.address || undefined,
        subscriptionType: row.normalizedSubscriptionType === "commercial" ? "commercial" : "residential",
        ...(row.openingReading?.trim() ? { openingReading: row.openingReading.trim() } : {}),
        ...(row.openingReadingAt ? { openingReadingAt: new Date(row.openingReadingAt).toISOString() } : {}),
      })),
    });
  };

  return <Card className="border-[#F5B800]/20 bg-[#111823] shadow-panel"><CardContent className="p-5"><div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between"><div><h2 className="flex items-center gap-2 font-bold text-white"><FileSpreadsheet className="h-4 w-4 text-[#F5B800]" />إضافة مشتركين جماعياً</h2><p className="mt-1 max-w-3xl text-xs leading-6 text-slate-500">ارفع ملف Excel ثم راجع الصفوف قبل الحفظ. الرقم المرجعي في الملف يُستخدم فقط عند تفعيل تحديث المشتركين المطابقين، ولا يحدد رقم المشترك الجديد.</p></div><div className="flex flex-wrap gap-2"><label><input aria-label="رفع ملف Excel" className="sr-only" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => void loadWorkbook(event.target.files?.[0])} /><span className="inline-flex h-10 cursor-pointer items-center justify-center rounded-xl border border-[#F5B800]/35 px-4 text-sm font-bold text-[#F5B800] hover:bg-[#F5B800]/10">{isParsing ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <UploadCloud className="ml-2 h-4 w-4" />}رفع ملف Excel</span></label><Button type="button" variant="outline" onClick={() => void downloadTemplate()} className="border-white/15 text-slate-300 hover:border-[#F5B800]/50 hover:text-[#F5B800]"><Download className="ml-2 h-4 w-4" />تنزيل القالب</Button></div></div>
    <div className="mt-4 rounded-xl border border-emerald-400/25 bg-emerald-400/10 px-3 py-2 text-xs leading-5 text-emerald-100">سيُحفظ الملف كاملاً داخل معاملة ذرية في Supabase؛ إذا فشل خطأ غير متوقع فلن تُعتمد أي كتابة جزئية. الصفوف غير الصالحة ستظهر في النتيجة للمراجعة.</div>
    {(isParsing || importSubscribers.isPending) ? <div className="mt-4 rounded-xl border border-[#F5B800]/25 bg-[#F5B800]/5 p-3"><div className="mb-2 flex items-center justify-between text-xs"><span className="font-bold text-amber-100">{progressLabel}</span><span className="text-[#F5B800]">{progress}%</span></div><div role="progressbar" aria-label="تقدم الاستيراد الجماعي" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} className="h-2 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-[#F5B800] transition-all duration-300" style={{ width: `${progress}%` }} /></div></div> : null}
    {rows.length ? <><div className="mt-5 overflow-x-auto"><table className="w-full min-w-[1040px] text-sm"><thead className="text-right text-xs text-slate-500"><tr><th className="pb-3">صف Excel</th><th className="pb-3">الاسم</th><th className="pb-3">الجوال</th><th className="pb-3">واتساب</th><th className="pb-3">العنوان</th><th className="pb-3">النوع</th><th className="pb-3">الرقم المرجعي</th><th className="pb-3">القراءة الافتتاحية</th><th className="pb-3">التحقق</th></tr></thead><tbody>{prepared.slice(0, 50).map((row) => <tr key={row.rowNumber} className="border-t border-white/7"><td className="py-2 text-slate-500">{row.rowNumber}</td><td className="py-2 font-medium text-white">{row.fullName || "—"}</td><td className="py-2" dir="ltr">{row.phone || "—"}</td><td className="py-2 text-slate-400" dir="ltr">{row.whatsappNumber || "—"}</td><td className="py-2 text-slate-400">{row.address || "—"}</td><td className="py-2 text-slate-400">{row.normalizedSubscriptionType === "commercial" ? "تجاري" : row.normalizedSubscriptionType === "residential" ? "سكني" : "—"}</td><td className="py-2 text-slate-400" dir="ltr">{row.subscriberNo || "—"}</td><td className="py-2 text-slate-300" dir="ltr">{row.openingReading?.trim() || "—"}</td><td className={`py-2 text-xs ${row.status === "ready" ? "text-emerald-300" : "text-rose-300"}`}>{row.status === "ready" ? "جاهز للحفظ" : row.errors.join(" ")}</td></tr>)}</tbody></table></div>{prepared.length > 50 ? <p className="mt-3 text-xs text-slate-500">تظهر أول 50 صفاً للمعاينة من أصل {prepared.length}.</p> : null}<div className="mt-4 flex flex-col gap-3 border-t border-white/8 pt-4 sm:flex-row sm:items-center sm:justify-between"><div><p className="text-xs text-slate-500">صفوف سليمة: <strong className="text-emerald-300">{validRows.length}</strong> · تحتاج تصحيحاً: <strong className="text-rose-300">{errorRows.length}</strong></p><label className="mt-3 flex items-start gap-2 text-xs leading-5 text-slate-300"><input aria-label="تحديث المشتركين المطابقين" type="checkbox" checked={updateExisting} onChange={(event) => setUpdateExisting(event.target.checked)} className="mt-1 accent-[#F5B800]" />عند تفعيل التحديث، يطابق النظام أولاً الرقم المرجعي إن أُدخل؛ وإلا يطابق الاسم ورقم الجوال معاً. لا يُحدّث صف غير مطابق لتفادي إنشاء سجل مكرر بالخطأ.</label></div><Button type="button" disabled={importSubscribers.isPending || !validRows.length} onClick={saveValid} className="bg-[#F5B800] font-bold text-[#0D1117] hover:bg-[#ffd23f]">{importSubscribers.isPending ? "جارٍ حفظ المشتركين…" : `حفظ ${validRows.length} مشتركاً سليماً`}</Button></div></> : null}
    {result ? <div className="mt-5 rounded-xl border border-white/8 bg-black/15 p-4"><p className="font-bold text-white">نتيجة الاستيراد: <span className="text-emerald-300">{result.created.length} مضاف</span> · <span className="text-sky-300">{result.updated.length} محدّث</span> · <span className="text-rose-300">{result.failed.length} لم يضاف</span></p><p className="mt-1 text-xs leading-6 text-slate-400">{result.message}</p>{result.created.length ? <p className="mt-3 text-xs text-slate-300">أرقام المشتركين الجديدة: {result.created.slice(0, 10).map((row) => `${row.fullName} (${row.subscriberNo})`).join("، ")}{result.created.length > 10 ? "…" : ""}</p> : null}{result.failed.length ? <ul className="mt-3 space-y-1 text-xs text-rose-200">{result.failed.slice(0, 12).map((row) => <li key={`${row.sourceRow}-${row.fullName}`}>صف {row.sourceRow}: {row.fullName || "بدون اسم"} — {row.reason}</li>)}</ul> : null}</div> : null}</CardContent></Card>;
}