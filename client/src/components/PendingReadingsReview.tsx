import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import { CheckCircle2, Edit3, Loader2, Save, ShieldAlert } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";

const inputClass = "h-9 w-full rounded-lg border border-white/10 bg-white/[0.025] px-2.5 text-sm text-white outline-none focus:border-[#F5B800]/70";
const dateValue = (date: Date | string) => new Date(date).toISOString().slice(0, 10);

type Row = { reading: any; subscriber: any };
export default function PendingReadingsReview({ siteId, rows, canReview, onUpdated }: { siteId: number; rows: Row[]; canReview: boolean; onUpdated: () => Promise<void> }) {
  const pendingRows = useMemo(() => rows.filter((row) => row.reading.status === "pending_review"), [rows]);
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState<{ value: string; date: string; notes: string }>({ value: "", date: dateValue(new Date()), notes: "" });
  const approvalOperationsRef = useRef(new Map<number, { baseVersion: number; id: string }>());
  const updateOperationsRef = useRef(new Map<number, { fingerprint: string; id: string }>());
  const update = trpc.powerhub.readings.updatePending.useMutation();
  const approve = trpc.powerhub.readings.approve.useMutation();
  const startEdit = (row: Row) => { setEditing(row.reading.id); setDraft({ value: String(row.reading.readingValue), date: dateValue(row.reading.readingAt), notes: row.reading.notes ?? "" }); };
  const save = async (row: Row) => {
    const baseVersion = Number(row.reading.versionNo);
    const fingerprint = JSON.stringify({ siteId, readingId: row.reading.id, baseVersion, readingValue: draft.value, readingAt: new Date(`${draft.date}T12:00:00`).toISOString(), notes: draft.notes || "" });
    const current = updateOperationsRef.current.get(Number(row.reading.id));
    const operation = current?.fingerprint === fingerprint ? current : { fingerprint, id: crypto.randomUUID() };
    updateOperationsRef.current.set(Number(row.reading.id), operation);
    try { await update.mutateAsync({ siteId, readingId: row.reading.id, baseVersion, readingValue: draft.value, readingAt: new Date(`${draft.date}T12:00:00`), notes: draft.notes || undefined, clientOperationId: operation.id }); updateOperationsRef.current.delete(Number(row.reading.id)); setEditing(null); await onUpdated(); toast.success("تم حفظ تعديل القراءة وهي بانتظار الاعتماد."); }
    catch (error) { toast.error(error instanceof Error ? error.message : "تعذر حفظ التعديل."); }
  };
  const confirm = async (row: Row) => {
    const readingId = Number(row.reading.id);
    const baseVersion = Number(row.reading.versionNo);
    const current = approvalOperationsRef.current.get(readingId);
    const operation = current?.baseVersion === baseVersion ? current : { baseVersion, id: crypto.randomUUID() };
    approvalOperationsRef.current.set(readingId, operation);
    try {
      const result = await approve.mutateAsync({ siteId, readingId, baseVersion, clientOperationId: operation.id });
      approvalOperationsRef.current.delete(readingId);
      await onUpdated();
      toast.success(result.replayed ? "تم تأكيد اعتماد القراءة السابق." : "تم اعتماد القراءة وأصبحت جاهزة للفوترة.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "تعذر اعتماد القراءة.");
    }
  };
  if (!pendingRows.length) return <Card className="border-white/8 bg-[#111823] shadow-panel"><CardContent className="p-5"><div className="flex items-center gap-3 text-slate-400"><CheckCircle2 className="h-5 w-5 text-emerald-400" /><div><h2 className="font-bold text-white">مراجعة القراءات المعلقة</h2><p className="mt-1 text-xs">لا توجد قراءات بانتظار المراجعة في الفرع المحدد.</p></div></div></CardContent></Card>;
  return <Card className="border-amber-400/20 bg-[#111823] shadow-panel"><CardContent className="p-0"><div className="flex items-center justify-between border-b border-white/8 px-5 py-4"><div><h2 className="flex items-center gap-2 font-bold text-white"><ShieldAlert className="h-4 w-4 text-amber-300" />مراجعة القراءات المعلقة</h2><p className="mt-1 text-xs text-slate-500">صحح القراءة أو تاريخها ثم اعتمدها قبل إصدار الفاتورة.</p></div><Badge className="bg-amber-400/10 text-amber-200">{pendingRows.length} معلقة</Badge></div><div className="overflow-x-auto p-5"><table className="w-full min-w-[900px] text-sm"><thead className="text-right text-xs text-slate-500"><tr><th className="pb-3">المشترك</th><th className="pb-3">المرجع</th><th className="pb-3">القراءة</th><th className="pb-3">التاريخ</th><th className="pb-3">ملاحظات</th><th className="pb-3">الإجراءات</th></tr></thead><tbody>{pendingRows.map((row) => { const isEditing = editing === row.reading.id; return <tr key={row.reading.id} className="border-t border-white/7 align-top"><td className="py-3 font-bold text-white">{row.subscriber.fullName}</td><td className="py-3 text-slate-400" dir="ltr">{row.subscriber.subscriberNo}</td><td className="py-3">{isEditing ? <input className={inputClass} value={draft.value} onChange={(event) => setDraft((current) => ({ ...current, value: event.target.value }))} dir="ltr" /> : `${Number(row.reading.readingValue).toFixed(3)} kWh`}</td><td className="py-3">{isEditing ? <input className={inputClass} type="date" value={draft.date} onChange={(event) => setDraft((current) => ({ ...current, date: event.target.value }))} /> : new Date(row.reading.readingAt).toLocaleDateString("ar")}</td><td className="py-3 text-xs text-slate-400">{isEditing ? <input className={inputClass} value={draft.notes} onChange={(event) => setDraft((current) => ({ ...current, notes: event.target.value }))} /> : row.reading.notes || "—"}</td><td className="py-3"><div className="flex flex-wrap gap-2">{isEditing ? <Button size="sm" disabled={update.isPending} onClick={() => void save(row)} className="bg-[#F5B800] text-xs font-bold text-[#0D1117] hover:bg-[#ffd23f]">{update.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="ml-1 h-3.5 w-3.5" />}حفظ</Button> : <Button size="sm" variant="outline" disabled={!canReview} onClick={() => startEdit(row)} className="border-white/15 text-xs text-slate-300"><Edit3 className="ml-1 h-3.5 w-3.5" />تعديل</Button>}{!isEditing && <Button size="sm" disabled={!canReview || approve.isPending} onClick={() => void confirm(row)} className="bg-emerald-500/90 text-xs font-bold text-white hover:bg-emerald-500">اعتماد</Button>}</div></td></tr>; })}</tbody></table></div></CardContent></Card>;
}
