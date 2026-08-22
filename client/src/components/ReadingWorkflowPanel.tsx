import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import { AlertCircle, Calculator, CheckCircle2, FileText, Loader2, Save } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

const inputClass = "h-10 w-full rounded-xl border border-white/10 bg-white/[0.025] px-3 text-sm text-white outline-none transition placeholder:text-slate-600 focus:border-[#F5B800]/70 focus:ring-2 focus:ring-[#F5B800]/15";
const today = () => new Date().toISOString().slice(0, 10);
const format = (value: number) => new Intl.NumberFormat("ar", { maximumFractionDigits: 3 }).format(value);

type FormErrors = { meter?: string; reading?: string; date?: string };

type Props = { siteId: number; role?: string; anomalyAlertPercent?: number; meters: any[]; readings: any[]; onSaved: () => Promise<void> };

export default function ReadingWorkflowPanel({ siteId, role, anomalyAlertPercent = 50, meters, readings, onSaved }: Props) {
  const [meterId, setMeterId] = useState("");
  const [readingValue, setReadingValue] = useState("");
  const [readingDate, setReadingDate] = useState(today());
  const [notes, setNotes] = useState("");
  const [fieldVerified, setFieldVerified] = useState(false);
  const [isReplacement, setIsReplacement] = useState(false);
  const [overrideSameDay, setOverrideSameDay] = useState(false);
  const [errors, setErrors] = useState<FormErrors>({});
  const [successMessage, setSuccessMessage] = useState("");
  const create = trpc.powerhub.readings.create.useMutation();
  const approve = trpc.powerhub.readings.approve.useMutation();
  const issue = trpc.powerhub.invoices.createFromReading.useMutation();
  const tariffs = trpc.powerhub.tariffs.list.useQuery({ siteId });
  const selectedMeter = meters.find((entry) => String(entry.meter.id) === meterId);
  const previous = useMemo(() => {
    if (!meterId) return 0;
    const rows = readings.filter((row) => String(row.reading.meterId) === meterId && row.reading.status === "approved").sort((a, b) => +new Date(b.reading.readingAt) - +new Date(a.reading.readingAt));
    return Number(rows[0]?.reading.readingValue ?? 0);
  }, [meterId, readings]);
  const next = Number(readingValue || 0);
  const consumption = isReplacement && next < previous ? next : next - previous;
  const averageConsumption = useMemo(() => {
    if (!meterId) return 0;
    const values = readings.filter((row) => String(row.reading.meterId) === meterId && row.reading.status === "approved").slice(0, 3).map((row) => Number(row.reading.consumptionKwh ?? 0)).filter((value) => value > 0);
    return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
  }, [meterId, readings]);
  const recentReadings = useMemo(() => [...readings].sort((a, b) => +new Date(b.reading.readingAt) - +new Date(a.reading.readingAt)).slice(0, 5), [readings]);
  const isAnomalous = averageConsumption > 0 && consumption > averageConsumption * (1 + anomalyAlertPercent / 100);
  const canOverride = ["owner", "manager", "accountant"].includes(role ?? "");
  const canIssue = canOverride;

  useEffect(() => {
    if (!successMessage) return;
    const timer = window.setTimeout(() => setSuccessMessage(""), 4500);
    return () => window.clearTimeout(timer);
  }, [successMessage]);

  const validate = () => {
    const nextErrors: FormErrors = {};
    if (!meterId) nextErrors.meter = "اختر المشترك والعداد قبل حفظ القراءة.";
    if (!/^\d+(\.\d{1,3})?$/.test(readingValue)) nextErrors.reading = "أدخل قراءة رقمية صحيحة بحد أقصى ثلاث منازل عشرية.";
    if (!readingDate || Number.isNaN(new Date(`${readingDate}T12:00:00`).getTime())) nextErrors.date = "اختر تاريخاً صحيحاً للقراءة.";
    setErrors(nextErrors);
    return nextErrors;
  };

  const submit = async (shouldIssue = false) => {
    if (Object.keys(validate()).length) return;
    if (next < previous && !isReplacement) { setErrors({ reading: "القراءة أقل من السابقة. فعّل استبدال العداد إن كانت هذه قراءة عداد جديد." }); return; }
    if (isReplacement && next < previous && !notes.trim()) { setErrors({ reading: "أدخل ملاحظة توضّح سبب استبدال العداد." }); return; }
    try {
      const created = await create.mutateAsync({ siteId, meterId: Number(meterId), readingValue, readingAt: new Date(`${readingDate}T12:00:00`), captureMethod: "manual", notes: notes || undefined, isMeterReplacement: isReplacement, overrideSameDay, fieldVerified, clientOperationId: crypto.randomUUID() });
      let message = "تم حفظ القراءة بانتظار المراجعة.";
      if (shouldIssue) {
        const tariff = (tariffs.data ?? []).find((entry) => entry.isActive);
        if (!canIssue || !tariff) throw new Error("يلزم وجود تعرفة فعالة وصلاحية اعتماد القراءة لإصدار الفاتورة فوراً.");
        await approve.mutateAsync({ siteId, readingId: created.id, baseVersion: 1 });
        const dueDate = new Date(`${readingDate}T12:00:00`); dueDate.setDate(dueDate.getDate() + 14);
        await issue.mutateAsync({ siteId, readingId: created.id, tariffId: tariff.id, billingPeriod: readingDate.slice(0, 7), dueDate, discountAmount: 0 });
        message = "تم حفظ القراءة واعتمادها وإصدار الفاتورة.";
      }
      setErrors({});
      setSuccessMessage(message);
      toast.success(message);
      setReadingValue(""); setNotes(""); setFieldVerified(false); setIsReplacement(false); setOverrideSameDay(false);
      await onSaved();
    } catch (error) { toast.error(error instanceof Error ? error.message : "تعذر حفظ القراءة."); }
  };

  return <Card className="border-[#F5B800]/25 bg-[#111823] shadow-panel"><CardContent className="p-5">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="font-bold text-white">تسجيل قراءة</h2><p className="mt-1 text-xs leading-5 text-slate-500">يعرض الاستهلاك قبل الحفظ، مع اعتماد وفوترة فورية للحسابات المخولة.</p></div>{selectedMeter && <Badge className="w-fit bg-sky-400/10 text-sky-200">{selectedMeter.subscriber.fullName} · {selectedMeter.subscriber.subscriberNo}</Badge>}</div>
    {successMessage && <div role="status" className="mt-4 flex animate-in items-center gap-2 rounded-xl border border-emerald-400/30 bg-emerald-400/10 px-4 py-3 text-sm font-bold text-emerald-200 duration-300 fade-in slide-in-from-top-2"><CheckCircle2 className="h-5 w-5 shrink-0" />{successMessage}</div>}
    <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3"><label className="block"><span className="mb-2 block text-xs font-bold text-slate-400">المشترك / العداد</span><select aria-invalid={Boolean(errors.meter)} value={meterId} onChange={(event) => { setMeterId(event.target.value); setErrors((current) => ({ ...current, meter: undefined })); }} className={`${inputClass} ${errors.meter ? "border-rose-400/70" : ""}`}><option className="bg-[#111823]" value="">ابحث بالاسم أو الرقم المرجعي من القائمة</option>{meters.map((entry) => <option className="bg-[#111823]" key={entry.meter.id} value={entry.meter.id}>{entry.subscriber.fullName} — {entry.subscriber.subscriberNo} — {entry.meter.serialNumber}</option>)}</select>{errors.meter && <span className="mt-1 flex items-center gap-1 text-xs text-rose-300"><AlertCircle className="h-3.5 w-3.5" />{errors.meter}</span>}</label><label className="block"><span className="mb-2 block text-xs font-bold text-slate-400">القراءة الحالية</span><input aria-invalid={Boolean(errors.reading)} value={readingValue} onChange={(event) => { setReadingValue(event.target.value); setErrors((current) => ({ ...current, reading: undefined })); }} type="number" min="0" step="0.001" className={`${inputClass} ${errors.reading ? "border-rose-400/70" : ""}`} dir="ltr" />{errors.reading && <span className="mt-1 flex items-center gap-1 text-xs text-rose-300"><AlertCircle className="h-3.5 w-3.5" />{errors.reading}</span>}</label><label className="block"><span className="mb-2 block text-xs font-bold text-slate-400">تاريخ القراءة</span><input aria-invalid={Boolean(errors.date)} value={readingDate} onChange={(event) => { setReadingDate(event.target.value); setErrors((current) => ({ ...current, date: undefined })); }} type="date" className={`${inputClass} ${errors.date ? "border-rose-400/70" : ""}`} />{errors.date && <span className="mt-1 flex items-center gap-1 text-xs text-rose-300"><AlertCircle className="h-3.5 w-3.5" />{errors.date}</span>}</label><div className="rounded-xl border border-white/8 bg-white/[.018] p-3"><p className="text-xs text-slate-500">القراءة السابقة المعتمدة</p><p className="mt-1 font-display text-lg font-bold text-white">{format(previous)} kWh</p></div><div className={`rounded-xl border p-3 ${consumption < 0 ? "border-rose-400/30 bg-rose-400/[.04]" : "border-[#F5B800]/25 bg-[#F5B800]/[.04]"}`}><p className="flex items-center gap-1 text-xs text-slate-500"><Calculator className="h-3.5 w-3.5 text-[#F5B800]" />الاستهلاك المحسوب</p><p className={`mt-1 font-display text-lg font-bold ${consumption < 0 ? "text-rose-200" : "text-[#F5B800]"}`}>{format(consumption)} kWh</p></div><label className="block"><span className="mb-2 block text-xs font-bold text-slate-400">ملاحظات</span><input value={notes} onChange={(event) => setNotes(event.target.value)} className={inputClass} placeholder="اختياري" /></label></div>
    {isAnomalous && <div className="mt-4 rounded-xl border border-amber-400/30 bg-amber-400/[.06] px-4 py-3 text-sm text-amber-100">تنبيه: الاستهلاك الحالي تجاوز نسبة التنبيه المحددة للفرع مقارنة بمتوسط آخر ثلاث قراءات معتمدة ({format(averageConsumption)} kWh). راجع القراءة أو أرفق ملاحظة قبل الفوترة.</div>}
    <div className="mt-4 flex flex-wrap gap-x-5 gap-y-3 text-xs text-slate-300"><label className="flex items-center gap-2"><input checked={fieldVerified} onChange={(event) => setFieldVerified(event.target.checked)} type="checkbox" className="accent-[#F5B800]" />تم التحقق ميدانياً</label><label className="flex items-center gap-2"><input checked={isReplacement} onChange={(event) => setIsReplacement(event.target.checked)} type="checkbox" className="accent-[#F5B800]" />استبدال عداد</label>{canOverride && <label className="flex items-center gap-2"><input checked={overrideSameDay} onChange={(event) => setOverrideSameDay(event.target.checked)} type="checkbox" className="accent-[#F5B800]" />تجاوز قراءة اليوم</label>}</div><div className="mt-5 flex flex-col gap-3 sm:flex-row"><Button disabled={create.isPending || approve.isPending || issue.isPending} onClick={() => void submit(false)} className="bg-[#F5B800] font-bold text-[#0D1117] hover:bg-[#ffd23f]"><Save className="ml-2 h-4 w-4" />حفظ القراءة</Button>{canIssue && <Button disabled={create.isPending || approve.isPending || issue.isPending || !(tariffs.data ?? []).some((entry) => entry.isActive)} onClick={() => void submit(true)} variant="outline" className="border-[#F5B800]/35 text-[#F5B800] hover:bg-[#F5B800]/10">{create.isPending || approve.isPending || issue.isPending ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <FileText className="ml-2 h-4 w-4" />}حفظ وإصدار فاتورة</Button>}</div><p className="mt-3 text-xs leading-5 text-slate-500"><CheckCircle2 className="ml-1 inline h-3.5 w-3.5 text-emerald-400" />تُقفل القراءة عملياً بعد اعتمادها وإصدار فاتورتها؛ أي تعديل لاحق يخضع لسجل التدقيق وصلاحيات المراجعة.</p>
    <div className="mt-6 border-t border-white/8 pt-5"><div className="mb-3 flex items-center justify-between"><h3 className="font-bold text-white">آخر القراءات المسجلة</h3><span className="text-xs text-slate-500">{recentReadings.length} من الأحدث</span></div>{recentReadings.length ? <div className="overflow-x-auto"><table className="w-full min-w-[620px] text-sm"><thead className="text-right text-xs text-slate-500"><tr><th className="pb-2">المشترك</th><th className="pb-2">المرجع</th><th className="pb-2">القراءة</th><th className="pb-2">الاستهلاك</th><th className="pb-2">الحالة</th></tr></thead><tbody>{recentReadings.map((row) => <tr key={row.reading.id} className="border-t border-white/6"><td className="py-2.5 font-bold text-slate-200">{row.subscriber.fullName}</td><td className="py-2.5 text-xs text-slate-400" dir="ltr">{row.subscriber.subscriberNo}</td><td className="py-2.5 text-slate-300">{format(Number(row.reading.readingValue))}</td><td className="py-2.5 text-[#F5B800]">{format(Number(row.reading.consumptionKwh ?? 0))} kWh</td><td className="py-2.5"><Badge className={row.reading.status === "approved" ? "bg-emerald-400/10 text-emerald-300" : "bg-sky-400/10 text-sky-300"}>{row.reading.status === "approved" ? "معتمدة" : "بانتظار المراجعة"}</Badge></td></tr>)}</tbody></table></div> : <p className="rounded-xl border border-dashed border-white/10 p-4 text-center text-sm text-slate-500">لا توجد قراءات مسجلة بعد.</p>}</div>
  </CardContent></Card>;
}
