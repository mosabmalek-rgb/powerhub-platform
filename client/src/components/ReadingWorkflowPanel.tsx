import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import type { QueuedReading } from "@/lib/offline-reading-queue";
import { AlertCircle, Calculator, CheckCircle2, ImagePlus, Loader2, Pencil, Save, Search, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

const inputClass = "h-10 w-full rounded-xl border border-white/10 bg-white/[0.025] px-3 text-sm text-white outline-none transition placeholder:text-slate-600 focus:border-[#F5B800]/70 focus:ring-2 focus:ring-[#F5B800]/15";
const today = () => new Date().toISOString().slice(0, 10);
const format = (value: number) => new Intl.NumberFormat("ar", { maximumFractionDigits: 3 }).format(value);

type FormErrors = { subscriber?: string; reading?: string; date?: string };

type Props = { userId: number; siteId: number; role?: string; anomalyAlertPercent?: number; subscribers: any[]; readings: any[]; isOnline?: boolean; onQueueReading?: (reading: Omit<QueuedReading, "id" | "createdAt" | "status" | "userId" | "attempts" | "nextAttemptAt">) => Promise<string | undefined>; onSaved: () => Promise<void> };

export default function ReadingWorkflowPanel({ siteId, role, anomalyAlertPercent = 50, subscribers, readings, isOnline = true, onQueueReading, onSaved }: Props) {
  const initialSubscriberId = typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("subscriberId") ?? "";
  const [subscriberId, setSubscriberId] = useState(initialSubscriberId);
  const [readingValue, setReadingValue] = useState("");
  const [readingDate, setReadingDate] = useState(today());
  const [notes, setNotes] = useState("");
  const [fieldVerified, setFieldVerified] = useState(false);
  const [isReadingReset, setIsReadingReset] = useState(false);
  const [overrideSameDay, setOverrideSameDay] = useState(false);
  const [errors, setErrors] = useState<FormErrors>({});
  const [successMessage, setSuccessMessage] = useState("");
  const [listSearch, setListSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "pending_review" | "approved">("all");
  const [visibleCount, setVisibleCount] = useState(5);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [selectedImage, setSelectedImage] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [isOcrRunning, setIsOcrRunning] = useState(false);
  const create = trpc.powerhub.readings.create.useMutation();
  const updatePending = trpc.powerhub.readings.updatePending.useMutation();
  const deletePending = trpc.powerhub.readings.deletePending.useMutation();
  const selectedSubscriber = subscribers.find((entry) => String(entry.id) === subscriberId);
  const previous = useMemo(() => {
    if (!subscriberId) return 0;
    const rows = readings.filter((row) => String(row.reading.subscriberId) === subscriberId && row.reading.status === "approved").sort((a, b) => +new Date(b.reading.readingAt) - +new Date(a.reading.readingAt));
    return Number(rows[0]?.reading.readingValue ?? 0);
  }, [subscriberId, readings]);
  const next = Number(readingValue || 0);
  const consumption = isReadingReset && next < previous ? next : next - previous;
  const averageConsumption = useMemo(() => {
    if (!subscriberId) return 0;
    const values = readings.filter((row) => String(row.reading.subscriberId) === subscriberId && row.reading.status === "approved").slice(0, 3).map((row) => Number(row.reading.consumptionKwh ?? 0)).filter((value) => value > 0);
    return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
  }, [subscriberId, readings]);
  const filteredReadings = useMemo(() => {
    const term = listSearch.trim().toLocaleLowerCase();
    return [...readings].sort((a, b) => +new Date(b.reading.readingAt) - +new Date(a.reading.readingAt)).filter((row) => {
      const matchesSearch = !term || `${row.subscriber.fullName} ${row.subscriber.subscriberNo}`.toLocaleLowerCase().includes(term);
      const matchesStatus = statusFilter === "all" || row.reading.status === statusFilter;
      return matchesSearch && matchesStatus;
    });
  }, [listSearch, readings, statusFilter]);
  const recentReadings = filteredReadings.slice(0, visibleCount);
  const isAnomalous = averageConsumption > 0 && consumption > averageConsumption * (1 + anomalyAlertPercent / 100);
  const canOverride = ["owner", "manager", "accountant"].includes(role ?? "");
  const readImage = (file: File) => new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(new Error("تعذر قراءة صورة القراءة.")); reader.onload = () => resolve(String(reader.result).split(",")[1] ?? ""); reader.readAsDataURL(file); });
  const chooseImage = async (file?: File) => { if (!file) return; if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) { setErrors({ reading: "استخدم صورة JPG أو PNG أو WebP فقط." }); return; } if (file.size > 7 * 1024 * 1024) { setErrors({ reading: "يجب ألا يتجاوز حجم صورة القراءة 7 ميغابايت." }); return; } if (imagePreview) URL.revokeObjectURL(imagePreview); setSelectedImage(file); setImagePreview(URL.createObjectURL(file)); setIsOcrRunning(true); try { const { createWorker } = await import("tesseract.js"); const worker = await createWorker("eng"); const result = await worker.recognize(file); await worker.terminate(); const match = result.data.text.replaceAll(",", ".").match(/\d+(?:\.\d{1,2})?/); if (match) { setReadingValue(match[0]); setErrors((current) => ({ ...current, reading: undefined })); toast.success(`تم استخراج القراءة تلقائياً: ${match[0]}`); } else toast.message("لم يتم العثور على رقم واضح؛ أدخل القراءة يدوياً."); } catch { toast.error("تعذر استخراج القراءة من الصورة؛ يمكنك إدخالها يدوياً."); } finally { setIsOcrRunning(false); } };

  useEffect(() => {
    if (!initialSubscriberId || editingId !== null || subscriberId) return;
    if (subscribers.some((entry) => String(entry.id) === initialSubscriberId)) setSubscriberId(initialSubscriberId);
  }, [editingId, initialSubscriberId, subscriberId, subscribers]);

  useEffect(() => {
    if (!successMessage) return;
    const timer = window.setTimeout(() => setSuccessMessage(""), 4500);
    return () => window.clearTimeout(timer);
  }, [successMessage]);

  const validate = () => {
    const nextErrors: FormErrors = {};
    if (!subscriberId) nextErrors.subscriber = "اختر المشترك قبل حفظ القراءة.";
    if (!/^\d+(\.\d{1,2})?$/.test(readingValue)) nextErrors.reading = "أدخل قراءة رقمية صحيحة بحد أقصى منزلتين عشريتين.";
    if (!readingDate || Number.isNaN(new Date(`${readingDate}T12:00:00`).getTime())) nextErrors.date = "اختر تاريخاً صحيحاً للقراءة.";
    setErrors(nextErrors);
    return nextErrors;
  };

  const startEditing = (row: any) => {
    setEditingId(row.reading.id);
    setSubscriberId(String(row.reading.subscriberId));
    setReadingValue(String(row.reading.readingValue));
    setReadingDate(new Date(row.reading.readingAt).toISOString().slice(0, 10));
    setNotes(row.reading.notes ?? "");
    setErrors({});
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const cancelEditing = () => { setEditingId(null); setErrors({}); };
  const resetReadingForm = () => { setEditingId(null); setSubscriberId(""); setReadingValue(""); setReadingDate(today()); setNotes(""); setFieldVerified(false); setIsReadingReset(false); setOverrideSameDay(false); setErrors({}); setSelectedImage(null); if (imagePreview) URL.revokeObjectURL(imagePreview); setImagePreview(null); };
  const submit = async () => {
    if (Object.keys(validate()).length) return;
    if (next < previous && !isReadingReset) { setErrors({ reading: "القراءة أقل من السابقة. فعّل إعادة ضبط سجل القراءة مع ملاحظة للتأكيد." }); return; }
    if (isReadingReset && next < previous && !notes.trim()) { setErrors({ reading: "أدخل ملاحظة توضّح سبب إعادة ضبط سجل القراءة." }); return; }
    try {
      if (editingId !== null) {
        await updatePending.mutateAsync({ siteId, readingId: editingId, baseVersion: Number(readings.find((row) => row.reading.id === editingId)?.reading.versionNo ?? 1), readingValue, readingAt: new Date(`${readingDate}T12:00:00`), notes: notes || undefined });
        const message = "تم تعديل القراءة بنجاح.";
        setSuccessMessage(message); toast.success(message); setEditingId(null); setReadingValue(""); setNotes(""); setErrors({}); await onSaved(); return;
      }
      const imageData = selectedImage ? await readImage(selectedImage) : undefined;
      if (!isOnline) {
        if (!onQueueReading) throw new Error("طابور العمل دون اتصال غير متاح على هذا الجهاز.");
        const reservedInvoiceNo = await onQueueReading({ siteId, subscriberId: Number(subscriberId), readingValue, readingAt: new Date(`${readingDate}T12:00:00`).toISOString(), captureMethod: imageData ? "photo" : "manual", imageData, imageMime: imageData ? selectedImage?.type as "image/jpeg" | "image/png" | "image/webp" : undefined, notes: notes || undefined, isReadingReset, overrideSameDay, fieldVerified, clientOperationId: crypto.randomUUID() });
        const message = reservedInvoiceNo
          ? `تم حفظ القراءة محلياً. رقم الفاتورة المحجوز ${reservedInvoiceNo} مؤقت حتى يؤكده الخادم عند المزامنة.`
          : "تم حفظ القراءة محلياً؛ سيحدد الخادم رقم الفاتورة عند المزامنة لعدم توفر نطاق محجوز لهذه السنة.";
        setErrors({}); setSuccessMessage(message); toast.success(message);
        resetReadingForm();
        await onSaved();
        return;
      }
      const created = await create.mutateAsync({ siteId, subscriberId: Number(subscriberId), readingValue, readingAt: new Date(`${readingDate}T12:00:00`), captureMethod: imageData ? "photo" : "manual", imageData, imageMime: imageData ? selectedImage?.type as "image/jpeg" | "image/png" | "image/webp" : undefined, notes: notes || undefined, isReadingReset, overrideSameDay, fieldVerified, clientOperationId: crypto.randomUUID() });
      const message = created.status === "approved"
        ? "تم حفظ القراءة واعتمادها وإصدار الفاتورة تلقائيًا."
        : "تم حفظ القراءة، لكن لم يتم تأكيد اعتمادها وإصدار فاتورتها.";
      setErrors({});
      setSuccessMessage(message);
      toast.success(message);
      resetReadingForm();
      await onSaved();
    } catch (error) { toast.error(error instanceof Error ? error.message : "تعذر حفظ القراءة."); }
  };

  return <Card className="border-[#F5B800]/25 bg-[#111823] shadow-panel"><CardContent className="p-5">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="font-bold text-white">تسجيل قراءة</h2><p className="mt-1 text-xs leading-5 text-slate-500">يعرض الاستهلاك قبل الحفظ، ثم يعتمد القراءة ويصدر الفاتورة تلقائيًا.</p></div>{selectedSubscriber && <Badge className="w-fit bg-sky-400/10 text-sky-200">{selectedSubscriber.fullName} · {selectedSubscriber.subscriberNo}</Badge>}</div>
    {successMessage && <div role="status" className="mt-4 flex animate-in items-center gap-2 rounded-xl border border-emerald-400/30 bg-emerald-400/10 px-4 py-3 text-sm font-bold text-emerald-200 duration-300 fade-in slide-in-from-top-2"><CheckCircle2 className="h-5 w-5 shrink-0" />{successMessage}</div>}
    <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3"><label className="block"><span className="mb-2 block text-xs font-bold text-slate-400">المشترك</span><select aria-invalid={Boolean(errors.subscriber)} value={subscriberId} onChange={(event) => { setSubscriberId(event.target.value); setErrors((current) => ({ ...current, subscriber: undefined })); }} className={`${inputClass} ${errors.subscriber ? "border-rose-400/70" : ""}`}><option className="bg-[#111823]" value="">ابحث بالاسم أو الرقم المرجعي من القائمة</option>{subscribers.map((entry) => <option className="bg-[#111823]" key={entry.id} value={entry.id}>{entry.fullName} — {entry.subscriberNo}</option>)}</select>{errors.subscriber && <span className="mt-1 flex items-center gap-1 text-xs text-rose-300"><AlertCircle className="h-3.5 w-3.5" />{errors.subscriber}</span>}</label><label className="block"><span className="mb-2 block text-xs font-bold text-slate-400">القراءة الحالية</span><input aria-invalid={Boolean(errors.reading)} value={readingValue} onChange={(event) => { setReadingValue(event.target.value); setErrors((current) => ({ ...current, reading: undefined })); }} type="number" min="0" step="0.01" className={`${inputClass} ${errors.reading ? "border-rose-400/70" : ""}`} dir="ltr" />{errors.reading && <span className="mt-1 flex items-center gap-1 text-xs text-rose-300"><AlertCircle className="h-3.5 w-3.5" />{errors.reading}</span>}</label><label className="block"><span className="mb-2 block text-xs font-bold text-slate-400">تاريخ القراءة</span><input aria-invalid={Boolean(errors.date)} value={readingDate} onChange={(event) => { setReadingDate(event.target.value); setErrors((current) => ({ ...current, date: undefined })); }} type="date" className={`${inputClass} ${errors.date ? "border-rose-400/70" : ""}`} />{errors.date && <span className="mt-1 flex items-center gap-1 text-xs text-rose-300"><AlertCircle className="h-3.5 w-3.5" />{errors.date}</span>}</label><div className="rounded-xl border border-white/8 bg-white/[.018] p-3"><p className="text-xs text-slate-500">القراءة السابقة المعتمدة</p><p className="mt-1 font-display text-lg font-bold text-white">{format(previous)} kWh</p></div><div className={`rounded-xl border p-3 ${consumption < 0 ? "border-rose-400/30 bg-rose-400/[.04]" : "border-[#F5B800]/25 bg-[#F5B800]/[.04]"}`}><p className="flex items-center gap-1 text-xs text-slate-500"><Calculator className="h-3.5 w-3.5 text-[#F5B800]" />الاستهلاك المحسوب</p><p className={`mt-1 font-display text-lg font-bold ${consumption < 0 ? "text-rose-200" : "text-[#F5B800]"}`}>{format(consumption)} kWh</p></div><label className="block"><span className="mb-2 block text-xs font-bold text-slate-400">ملاحظات</span><input value={notes} onChange={(event) => setNotes(event.target.value)} className={inputClass} placeholder="اختياري" /></label></div>
    {isAnomalous && <div className="mt-4 rounded-xl border border-amber-400/30 bg-amber-400/[.06] px-4 py-3 text-sm text-amber-100">تنبيه: الاستهلاك الحالي تجاوز نسبة التنبيه المحددة للفرع مقارنة بمتوسط آخر ثلاث قراءات معتمدة ({format(averageConsumption)} kWh). راجع القراءة أو أرفق ملاحظة قبل الفوترة.</div>}
    <div className="mt-4 rounded-xl border border-dashed border-white/15 bg-white/[.015] p-3"><div className="flex flex-wrap items-center justify-between gap-3"><span className="flex items-center gap-2 text-sm text-slate-300"><ImagePlus className="h-4 w-4 text-[#F5B800]" />{selectedImage ? selectedImage.name : "إرفاق أو التقاط صورة القراءة (اختياري)"}{isOcrRunning && <span className="text-xs text-[#F5B800]">جاري استخراج الرقم...</span>}</span><div className="flex gap-2"><label className="cursor-pointer rounded-lg border border-white/10 px-3 py-2 text-xs text-slate-300 hover:border-[#F5B800]/50"><input type="file" accept="image/jpeg,image/png,image/webp" capture="environment" className="sr-only" onChange={(event) => chooseImage(event.target.files?.[0])} />التقاط / اختيار صورة</label>{selectedImage && <Button type="button" size="sm" variant="ghost" onClick={() => { setSelectedImage(null); if (imagePreview) URL.revokeObjectURL(imagePreview); setImagePreview(null); }} className="text-rose-300">إزالة</Button>}</div></div>{imagePreview && <img src={imagePreview} alt="معاينة صورة القراءة" className="mt-3 h-36 w-full rounded-lg object-cover" />}</div><div className="mt-4 flex flex-wrap gap-x-5 gap-y-3 text-xs text-slate-300"><label className="flex items-center gap-2"><input checked={fieldVerified} onChange={(event) => setFieldVerified(event.target.checked)} type="checkbox" className="accent-[#F5B800]" />تم التحقق ميدانياً</label><label className="flex items-center gap-2"><input checked={isReadingReset} onChange={(event) => setIsReadingReset(event.target.checked)} type="checkbox" className="accent-[#F5B800]" />إعادة ضبط سجل القراءة</label>{canOverride && <label className="flex items-center gap-2"><input checked={overrideSameDay} onChange={(event) => setOverrideSameDay(event.target.checked)} type="checkbox" className="accent-[#F5B800]" />تجاوز قراءة اليوم</label>}</div><div className="mt-5 flex flex-col gap-2 sm:flex-row"><Button disabled={create.isPending || updatePending.isPending || isOcrRunning} onClick={() => void submit()} className="bg-[#F5B800] font-bold text-[#0D1117] hover:bg-[#ffd23f]"><Save className="ml-2 h-4 w-4" />{editingId !== null ? "حفظ تعديل القراءة" : "حفظ القراءة واعتمادها وإصدار الفاتورة تلقائيًا"}</Button><Button type="button" variant="outline" onClick={resetReadingForm} className="border-white/10 text-slate-300">إفراغ الحقول</Button></div><p className="mt-3 text-xs leading-5 text-slate-500"><CheckCircle2 className="ml-1 inline h-3.5 w-3.5 text-emerald-400" />تُعتمد القراءة وتصدر فاتورتها تلقائيًا بعد الحفظ؛ أما القراءة الافتتاحية فتُستخدم كخط أساس دون فاتورة استهلاك.</p>
    <div className="mt-6 border-t border-white/8 pt-5"><div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><h3 className="font-bold text-white">آخر القراءات المسجلة</h3><span className="text-xs text-slate-500">{filteredReadings.length} نتيجة مطابقة</span></div><div className="flex flex-col gap-2 sm:flex-row"><label className="relative"><Search className="pointer-events-none absolute right-3 top-2.5 h-4 w-4 text-slate-500" /><input aria-label="بحث في القراءات" value={listSearch} onChange={(event) => { setListSearch(event.target.value); setVisibleCount(5); }} placeholder="الاسم أو الرقم المرجعي" className={`${inputClass} pr-9 sm:w-52`} /></label><select aria-label="فلترة حالة القراءة" value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value as typeof statusFilter); setVisibleCount(5); }} className={`${inputClass} sm:w-40`}><option value="all">كل الحالات</option><option value="pending_review">بانتظار المراجعة</option><option value="approved">معتمدة</option></select></div></div>{editingId !== null && <div className="mb-4 flex items-center justify-between rounded-xl border border-[#F5B800]/25 bg-[#F5B800]/[.06] px-3 py-2 text-xs text-[#F5B800]"><span>أنت تعدّل قراءة من القائمة. احفظ التعديل أو ألغِ العملية.</span><Button type="button" size="sm" variant="ghost" onClick={cancelEditing} className="text-slate-300 hover:text-white"><X className="ml-1 h-3.5 w-3.5" />إلغاء</Button></div>}{recentReadings.length ? <div className="overflow-x-auto"><table className="w-full min-w-[620px] text-sm"><thead className="text-right text-xs text-slate-500"><tr><th className="pb-2">المشترك</th><th className="pb-2">المرجع</th><th className="pb-2">القراءة</th><th className="pb-2">الاستهلاك</th><th className="pb-2">الحالة</th><th className="pb-2">إجراء</th></tr></thead><tbody>{recentReadings.map((row) => <tr key={row.reading.id} className="border-t border-white/6"><td className="py-2.5 font-bold text-slate-200">{row.subscriber.fullName}</td><td className="py-2.5 text-xs text-slate-400" dir="ltr">{row.subscriber.subscriberNo}</td><td className="py-2.5 text-slate-300">{format(Number(row.reading.readingValue))}</td><td className="py-2.5 text-[#F5B800]">{format(Number(row.reading.consumptionKwh ?? 0))} kWh</td><td className="py-2.5"><Badge className={row.reading.status === "approved" ? "bg-emerald-400/10 text-emerald-300" : "bg-sky-400/10 text-sky-300"}>{row.reading.status === "approved" ? "معتمدة" : "بانتظار المراجعة"}</Badge></td><td className="py-2.5"><div className="flex items-center gap-1">{row.reading.status === "pending_review" && <><Button type="button" size="sm" variant="ghost" aria-label={`تعديل قراءة ${row.subscriber.fullName}`} onClick={() => startEditing(row)} className="h-8 px-2 text-sky-300 hover:bg-sky-400/10"><Pencil className="h-3.5 w-3.5" /></Button><Button type="button" size="sm" variant="ghost" aria-label={`حذف قراءة ${row.subscriber.fullName}`} onClick={async () => { if (!window.confirm("هل تريد حذف هذه القراءة؟")) return; try { await deletePending.mutateAsync({ siteId, readingId: row.reading.id, baseVersion: row.reading.versionNo }); toast.success("تم حذف القراءة."); await onSaved(); } catch (error) { toast.error(error instanceof Error ? error.message : "تعذر حذف القراءة."); } }} className="h-8 px-2 text-rose-300 hover:bg-rose-400/10"><Trash2 className="h-3.5 w-3.5" /></Button></>}</div></td></tr>)}</tbody></table></div> : <p className="rounded-xl border border-dashed border-white/10 p-4 text-center text-sm text-slate-500">لا توجد قراءات مطابقة.</p>}{filteredReadings.length > visibleCount && <Button type="button" variant="outline" onClick={() => setVisibleCount((count) => count + 5)} className="mt-4 w-full border-white/10 text-slate-300 hover:bg-white/5">عرض المزيد</Button>}</div>
  </CardContent></Card>;
}
