import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import { Calculator, CheckCircle2, FileText, Loader2, Save } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

const inputClass = "h-10 w-full rounded-xl border border-white/10 bg-white/[0.025] px-3 text-sm text-white outline-none transition placeholder:text-slate-600 focus:border-[#F5B800]/70 focus:ring-2 focus:ring-[#F5B800]/15";
const today = () => new Date().toISOString().slice(0, 10);
const format = (value: number) => new Intl.NumberFormat("ar", { maximumFractionDigits: 3 }).format(value);

export default function ReadingWorkflowPanel({ siteId, role, meters, readings, onSaved }: { siteId: number; role?: string; meters: any[]; readings: any[]; onSaved: () => Promise<void> }) {
  const [meterId, setMeterId] = useState("");
  const [readingValue, setReadingValue] = useState("");
  const [readingDate, setReadingDate] = useState(today());
  const [notes, setNotes] = useState("");
  const [fieldVerified, setFieldVerified] = useState(false);
  const [isReplacement, setIsReplacement] = useState(false);
  const [overrideSameDay, setOverrideSameDay] = useState(false);
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
  const isAnomalous = averageConsumption > 0 && consumption > averageConsumption * 1.5;
  const canOverride = ["owner", "manager", "accountant"].includes(role ?? "");
  const canIssue = canOverride;
  const submit = async (shouldIssue = false) => {
    if (!meterId || !/^\d+(\.\d{1,3})?$/.test(readingValue)) { toast.error("اختر العداد وأدخل قراءة صحيحة حتى ثلاث منازل عشرية."); return; }
    if (next < previous && !isReplacement) { toast.error("القراءة أقل من السابقة. فعّل استبدال العداد إن كانت هذه قراءة عداد جديد."); return; }
    if (isReplacement && next < previous && !notes.trim()) { toast.error("أدخل ملاحظة لاستبدال العداد."); return; }
    try {
      const created = await create.mutateAsync({ siteId, meterId: Number(meterId), readingValue, readingAt: new Date(`${readingDate}T12:00:00`), captureMethod: "manual", notes: notes || undefined, isMeterReplacement: isReplacement, overrideSameDay, fieldVerified, clientOperationId: crypto.randomUUID() });
      if (shouldIssue) {
        const tariff = (tariffs.data ?? []).find((entry) => entry.isActive);
        if (!canIssue || !tariff) throw new Error("يلزم وجود تعرفة فعالة وصلاحية اعتماد القراءة لإصدار الفاتورة فوراً.");
        await approve.mutateAsync({ siteId, readingId: created.id, baseVersion: 1 });
        const dueDate = new Date(`${readingDate}T12:00:00`); dueDate.setDate(dueDate.getDate() + 14);
        await issue.mutateAsync({ siteId, readingId: created.id, tariffId: tariff.id, billingPeriod: readingDate.slice(0, 7), dueDate, discountAmount: 0 });
        toast.success("تم حفظ القراءة واعتمادها وإصدار الفاتورة.");
      } else toast.success("تم حفظ القراءة بانتظار المراجعة.");
      setReadingValue(""); setNotes(""); setFieldVerified(false); setIsReplacement(false); setOverrideSameDay(false);
      await onSaved();
    } catch (error) { toast.error(error instanceof Error ? error.message : "تعذر حفظ القراءة."); }
  };
  return <Card className="border-[#F5B800]/25 bg-[#111823] shadow-panel"><CardContent className="p-5"><div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="font-bold text-white">قراءة مفصلة وفوترة مباشرة</h2><p className="mt-1 text-xs leading-5 text-slate-500">يعرض الاستهلاك قبل الحفظ، مع اعتماد وفوترة فورية للحسابات المخولة.</p></div>{selectedMeter && <Badge className="w-fit bg-sky-400/10 text-sky-200">{selectedMeter.subscriber.fullName} · {selectedMeter.subscriber.subscriberNo}</Badge>}</div><div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3"><label className="block"><span className="mb-2 block text-xs font-bold text-slate-400">المشترك / العداد</span><select value={meterId} onChange={(event) => setMeterId(event.target.value)} className={inputClass}><option className="bg-[#111823]" value="">ابحث بالاسم أو الرقم المرجعي من القائمة</option>{meters.map((entry) => <option className="bg-[#111823]" key={entry.meter.id} value={entry.meter.id}>{entry.subscriber.fullName} — {entry.subscriber.subscriberNo} — {entry.meter.serialNumber}</option>)}</select></label><label className="block"><span className="mb-2 block text-xs font-bold text-slate-400">القراءة الحالية</span><input value={readingValue} onChange={(event) => setReadingValue(event.target.value)} type="number" min="0" step="0.001" className={inputClass} dir="ltr" /></label><label className="block"><span className="mb-2 block text-xs font-bold text-slate-400">تاريخ القراءة</span><input value={readingDate} onChange={(event) => setReadingDate(event.target.value)} type="date" className={inputClass} /></label><div className="rounded-xl border border-white/8 bg-white/[.018] p-3"><p className="text-xs text-slate-500">القراءة السابقة المعتمدة</p><p className="mt-1 font-display text-lg font-bold text-white">{format(previous)} kWh</p></div><div className={`rounded-xl border p-3 ${consumption < 0 ? "border-rose-400/30 bg-rose-400/[.04]" : "border-[#F5B800]/25 bg-[#F5B800]/[.04]"}`}><p className="flex items-center gap-1 text-xs text-slate-500"><Calculator className="h-3.5 w-3.5 text-[#F5B800]" />الاستهلاك المحسوب</p><p className={`mt-1 font-display text-lg font-bold ${consumption < 0 ? "text-rose-200" : "text-[#F5B800]"}`}>{format(consumption)} kWh</p></div><label className="block"><span className="mb-2 block text-xs font-bold text-slate-400">ملاحظات</span><input value={notes} onChange={(event) => setNotes(event.target.value)} className={inputClass} placeholder="اختياري" /></label></div>{isAnomalous && <div className="mt-4 rounded-xl border border-amber-400/30 bg-amber-400/[.06] px-4 py-3 text-sm text-amber-100">تنبيه: الاستهلاك الحالي أعلى من 150% من متوسط آخر ثلاث قراءات معتمدة ({format(averageConsumption)} kWh). راجع القراءة أو أرفق ملاحظة قبل الفوترة.</div>}<div className="mt-4 flex flex-wrap gap-x-5 gap-y-3 text-xs text-slate-300"><label className="flex items-center gap-2"><input checked={fieldVerified} onChange={(event) => setFieldVerified(event.target.checked)} type="checkbox" className="accent-[#F5B800]" />تم التحقق ميدانياً</label><label className="flex items-center gap-2"><input checked={isReplacement} onChange={(event) => setIsReplacement(event.target.checked)} type="checkbox" className="accent-[#F5B800]" />استبدال عداد</label>{canOverride && <label className="flex items-center gap-2"><input checked={overrideSameDay} onChange={(event) => setOverrideSameDay(event.target.checked)} type="checkbox" className="accent-[#F5B800]" />تجاوز قراءة اليوم</label>}</div><div className="mt-5 flex flex-col gap-3 sm:flex-row"><Button disabled={create.isPending || approve.isPending || issue.isPending} onClick={() => void submit(false)} className="bg-[#F5B800] font-bold text-[#0D1117] hover:bg-[#ffd23f]"><Save className="ml-2 h-4 w-4" />حفظ القراءة</Button>{canIssue && <Button disabled={create.isPending || approve.isPending || issue.isPending || !(tariffs.data ?? []).some((entry) => entry.isActive)} onClick={() => void submit(true)} variant="outline" className="border-[#F5B800]/35 text-[#F5B800] hover:bg-[#F5B800]/10">{create.isPending || approve.isPending || issue.isPending ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <FileText className="ml-2 h-4 w-4" />}حفظ وإصدار فاتورة</Button>}</div><p className="mt-3 text-xs leading-5 text-slate-500"><CheckCircle2 className="ml-1 inline h-3.5 w-3.5 text-emerald-400" />تُقفل القراءة عملياً بعد اعتمادها وإصدار فاتورتها؛ أي تعديل لاحق يخضع لسجل التدقيق وصلاحيات المراجعة.</p></CardContent></Card>;
}
