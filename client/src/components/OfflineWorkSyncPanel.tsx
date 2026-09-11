import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { listOfflineWork, removeOfflineWork, updateOfflineWork, type QueuedOfflineWork } from "@/lib/offline-work-queue";
import { trpc } from "@/lib/trpc";
import { AlertTriangle, CheckCircle2, CloudOff, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

const labelByKind = { subscriber_create: "إضافة مشترك", subscriber_update: "تعديل مشترك", invoice_issue: "إصدار فاتورة", payment_create: "تحصيل معلق" } as const;
const labelByStatus = { pending: "بانتظار المزامنة", failed: "فشل قابل لإعادة المحاولة", conflict: "يتطلب مراجعة", applied: "تمت المزامنة" } as const;

export function OfflineWorkSyncPanel({ siteId, userId, compact = false }: { siteId: number; userId: number; compact?: boolean }) {
  const utils = trpc.useUtils();
  const [items, setItems] = useState<QueuedOfflineWork[]>([]);
  const [isOnline, setIsOnline] = useState(() => typeof navigator === "undefined" ? true : navigator.onLine);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [syncAllLoading, setSyncAllLoading] = useState(false);
  const previousOnline = useRef(isOnline);
  const load = useCallback(async () => {
    try { setItems(await listOfflineWork({ userId, siteId })); }
    catch { toast.error("تعذر قراءة مسودات العمل المحلي على هذا الجهاز."); }
  }, [siteId, userId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const online = () => setIsOnline(true);
    const offline = () => setIsOnline(false);
    window.addEventListener("online", online); window.addEventListener("offline", offline);
    return () => { window.removeEventListener("online", online); window.removeEventListener("offline", offline); };
  }, []);
  useEffect(() => {
    if (previousOnline.current !== isOnline) {
      if (isOnline) toast.success("عاد الاتصال بالإنترنت. يمكنك مزامنة المسودات الآن.");
      else toast.warning("انقطع الاتصال بالإنترنت. ستبقى المسودات محفوظة محلياً.", { duration: Infinity });
      previousOnline.current = isOnline;
    }
  }, [isOnline]);

  const createSubscriber = trpc.powerhub.subscribers.create.useMutation();
  const updateSubscriber = trpc.powerhub.subscribers.update.useMutation();
  const issueInvoice = trpc.powerhub.invoices.createFromReading.useMutation();
  const createPayment = trpc.powerhub.payments.create.useMutation();

  const refresh = async () => {
    await Promise.all([utils.powerhub.subscribers.list.invalidate(), utils.powerhub.subscribers.quota.invalidate(), utils.powerhub.invoices.list.invalidate(), utils.powerhub.payments.list.invalidate(), utils.powerhub.dashboard.summary.invalidate(), utils.powerhub.audit.list.invalidate()]);
  };
  const syncOne = async (item: QueuedOfflineWork) => {
    if (!isOnline) return toast.error("تحتاج إلى اتصال قبل مزامنة المسودات.");
    setSyncing(item.id);
    try {
      if (item.kind === "subscriber_create") {
        const payload = item.payload as import("@/lib/offline-work-queue").SubscriberCreateDraft;
        const result = await createSubscriber.mutateAsync({ siteId: item.siteId, ...payload, clientOperationId: item.clientOperationId });
        await updateOfflineWork(item.id, { status: "applied", error: undefined, appliedEntityId: result.id, appliedLabel: result.subscriberNo });
      } else if (item.kind === "subscriber_update") {
        const payload = item.payload as import("@/lib/offline-work-queue").SubscriberUpdateDraft;
        await updateSubscriber.mutateAsync({ siteId: item.siteId, id: payload.subscriberId, fullName: payload.fullName, phone: payload.phone, address: payload.address, subscriptionType: payload.subscriptionType, serviceStatus: payload.serviceStatus, expectedUpdatedAt: new Date(payload.expectedUpdatedAt), clientOperationId: item.clientOperationId });
        await updateOfflineWork(item.id, { status: "applied", error: undefined, appliedEntityId: payload.subscriberId, appliedLabel: payload.fullName });
      } else if (item.kind === "invoice_issue") {
        const payload = item.payload as import("@/lib/offline-work-queue").InvoiceIssueDraft;
        const result = await issueInvoice.mutateAsync({ siteId: item.siteId, ...payload, dueDate: new Date(payload.dueDate), clientOperationId: item.clientOperationId });
        await updateOfflineWork(item.id, { status: "applied", error: undefined, appliedEntityId: result.id, appliedLabel: result.invoiceNo });
      } else {
        const payload = item.payload as import("@/lib/offline-work-queue").PaymentDraft;
        const result = await createPayment.mutateAsync({ siteId: item.siteId, ...payload, clientOperationId: item.clientOperationId });
        const { receiptImageData: _receiptImageData, receiptImageMime: _receiptImageMime, ...sanitizedPayload } = payload;
        await updateOfflineWork(item.id, { status: "applied", error: undefined, appliedEntityId: result.id, appliedLabel: payload.paymentNo, payload: sanitizedPayload });
      }
      await refresh();
    } catch (error) {
      const code = (error as { data?: { code?: string } }).data?.code;
      await updateOfflineWork(item.id, { status: code === "CONFLICT" ? "conflict" : "failed", error: error instanceof Error ? error.message : "تعذر مزامنة المسودة." });
      if (code === "CONFLICT" && item.kind === "payment_create") toast.error("حدث تعارض في مسودة تحصيل مالية. لم يتغير الرصيد ولم يُصدر إيصال رسمي.", { duration: Infinity, action: { label: "فتح مركز المزامنة", onClick: () => window.location.assign("/offline-sync") } });
    } finally { setSyncing(null); await load(); }
  };

  const pending = items.filter((item) => item.status === "pending");
  const unresolved = items.filter((item) => item.status !== "applied");
  const syncAllPending = async () => {
    if (!isOnline) return toast.error("تحتاج إلى اتصال قبل بدء المزامنة.");
    if (syncAllLoading || !pending.length) return;
    setSyncAllLoading(true);
    try {
      for (const item of pending) await syncOne(item);
      toast.success("اكتملت محاولة مزامنة المسودات المعلقة.");
    } finally {
      setSyncAllLoading(false);
    }
  };
  if (compact && !items.length) return null;
  return <Card className="border-[#F5B800]/20 bg-[#111823] shadow-panel"><CardContent className="p-5"><div className={`mb-4 flex items-center gap-2 rounded-xl border px-3 py-2 text-xs ${isOnline ? "border-emerald-400/20 bg-emerald-400/10 text-emerald-200" : "border-amber-400/25 bg-amber-400/10 text-amber-100"}`}><span className={`h-2 w-2 rounded-full ${isOnline ? "bg-emerald-300" : "bg-amber-300 animate-pulse"}`} />{isOnline ? "الاتصال متاح — المزامنة اليدوية جاهزة." : "لا يوجد اتصال — ستبقى المسودات محلياً حتى عودة الشبكة."}</div><div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex items-center gap-2 text-sm font-bold text-[#F5B800]"><CloudOff className="h-4 w-4" />مركز مزامنة المسودات</div><p className="mt-1 text-xs leading-5 text-slate-400">تُحفظ المسودات محلياً أولاً. لا يصدر رقم فاتورة ولا يتغير سجل مالي قبل قبول الخادم للعملية؛ والتحصيل المعلق لا يملك إيصالاً رسمياً قبل قبول المزامنة.</p></div><div className="flex items-center gap-2"><Badge className={isOnline ? "bg-emerald-400/10 text-emerald-300" : "bg-amber-400/10 text-amber-200"}>{isOnline ? "متصل" : "دون اتصال"}</Badge><Button size="sm" disabled={!isOnline || !pending.length || syncing !== null || syncAllLoading} onClick={() => void syncAllPending()} className="bg-[#F5B800] text-[#0D1117] hover:bg-[#ffd23f]"><RefreshCw className={`ml-1.5 h-3.5 w-3.5 ${syncAllLoading ? "animate-spin" : ""}`} />{syncAllLoading ? "جارٍ المزامنة…" : `مزامنة الآن (${pending.length})`}</Button></div></div>
    {items.length ? <div className="mt-4 space-y-2">{items.map((item) => <div key={item.id} className="flex flex-col gap-3 rounded-xl border border-white/8 bg-white/[.018] p-3 sm:flex-row sm:items-center sm:justify-between"><div><p className="font-bold text-sm text-white">{labelByKind[item.kind]} {item.appliedLabel ? `— ${item.appliedLabel}` : ""}</p><p className="mt-1 text-xs text-slate-500">{new Date(item.createdAt).toLocaleString("ar-IQ")} · {labelByStatus[item.status]}</p>{item.error ? <p className="mt-1 max-w-2xl text-xs text-rose-200">{item.error}</p> : null}</div><div className="flex items-center gap-2"><Badge className={item.status === "applied" ? "bg-emerald-400/10 text-emerald-300" : item.status === "conflict" ? "bg-rose-400/10 text-rose-200" : item.status === "failed" ? "bg-amber-400/10 text-amber-200" : "bg-sky-400/10 text-sky-200"}>{item.status === "conflict" ? <AlertTriangle className="ml-1 h-3 w-3" /> : item.status === "applied" ? <CheckCircle2 className="ml-1 h-3 w-3" /> : null}{labelByStatus[item.status]}</Badge>{["pending", "failed"].includes(item.status) ? <Button size="sm" variant="outline" disabled={!isOnline || syncing !== null || syncAllLoading} onClick={() => void syncOne(item)} className="border-white/15 text-slate-100"><RefreshCw className="ml-1 h-3 w-3" />مزامنة</Button> : null}<Button aria-label={`حذف مسودة ${labelByKind[item.kind]}`} size="icon" variant="ghost" onClick={() => void removeOfflineWork(item.id).then(load)} className="h-8 w-8 text-slate-400 hover:bg-rose-400/10 hover:text-rose-200"><Trash2 className="h-3.5 w-3.5" /></Button></div></div>)}</div> : <p className="mt-4 rounded-xl border border-dashed border-white/10 px-4 py-5 text-center text-sm text-slate-500">لا توجد مسودات محلية في هذا الفرع.</p>}
    {unresolved.some((item) => item.status === "conflict") ? <p className="mt-3 text-xs leading-5 text-amber-100">تحذير: التعارض لا يدمج تلقائياً. احذف المسودة بعد مراجعة السجل الحالي وأنشئ تعديلاً جديداً من بيانات الخادم.</p> : null}</CardContent></Card>;
}
