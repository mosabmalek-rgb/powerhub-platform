import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { useBranchFilter } from "@/hooks/useBranchFilter";
import { trpc } from "@/lib/trpc";
import { enqueueOfflineWork, listOfflineWork, type PaymentDocumentationApprovalDraft } from "@/lib/offline-work-queue";
import { listPaymentDocumentationApprovalSnapshots, savePaymentDocumentationApprovalSnapshots, type OfflinePaymentDocumentationApprovalSnapshot } from "@/lib/offline-payment-documentation-approvals";
import { CheckCircle2, ExternalLink, Loader2, XCircle } from "lucide-react";
import { can } from "@shared/powerhub-rbac";
import { useAuth } from "@/_core/hooks/useAuth";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

function formatArabicDateTime(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("ar-PS", {
    dateStyle: "medium",
    timeStyle: "short",
    hour12: true,
    timeZone: "Asia/Gaza",
  }).format(date);
}

export default function PaymentDocumentationReviewPage() {
  const { branchId: siteId } = useBranchFilter();
  const { user } = useAuth();
  const [status,setStatus]=useState<"pending"|"approved"|"rejected"|"all">("pending");
  const [rejectId,setRejectId]=useState<number|null>(null);
  const [reason,setReason]=useState("");
  const [selectedIds,setSelectedIds]=useState<number[]>([]);
  const [offlineRows,setOfflineRows]=useState<OfflinePaymentDocumentationApprovalSnapshot[]>([]);
  const [isOnline,setIsOnline]=useState(() => typeof navigator === "undefined" ? true : navigator.onLine);
  const access=trpc.powerhub.staff.myAccess.useQuery({siteId:siteId??0},{enabled:Boolean(siteId)});
  const canApprove=can(access.data?.role,"approvePaymentDocumentation",access.data?.permissions);
  const requests=trpc.powerhub.paymentDocumentation.list.useQuery({siteId:siteId??0,status},{enabled:Boolean(siteId && canApprove && isOnline)});
  const loadOfflineRows=useCallback(async()=>{if(!siteId)return;try{setOfflineRows(await listPaymentDocumentationApprovalSnapshots(siteId));}catch{toast.error("تعذر قراءة قائمة الاعتمادات المحلية.");}},[siteId]);
  useEffect(()=>{const on=()=>setIsOnline(true),off=()=>setIsOnline(false);window.addEventListener("online",on);window.addEventListener("offline",off);return()=>{window.removeEventListener("online",on);window.removeEventListener("offline",off);};},[]);
  useEffect(()=>{if(!isOnline)void loadOfflineRows();},[isOnline,loadOfflineRows]);
  useEffect(()=>{if(isOnline&&status==="pending"&&requests.data?.length)void savePaymentDocumentationApprovalSnapshots(siteId??0,requests.data.map((r:any)=>({id:Number(r.id),siteId:siteId??0,savedAt:Date.now(),invoiceNo:String(r.invoice_no_snapshot),subscriberName:String(r.subscriber_name_snapshot),subscriberNo:String(r.subscriber_no_snapshot),paymentAmount:Number(r.payment_amount),invoiceBalance:Number(r.invoice_balance_snapshot),paymentMethod:String(r.payment_method),destinationAccountId:Number(r.destination_account_id),submittedAt:String(r.submitted_at),status:"pending"})));},[isOnline,requests.data,siteId,status]);
  const visibleRequests:any[] = isOnline ? (requests.data ?? []) : offlineRows.map(row => ({ id: row.id, invoice_no_snapshot: row.invoiceNo, subscriber_name_snapshot: row.subscriberName, subscriber_no_snapshot: row.subscriberNo, payment_amount: row.paymentAmount, invoice_balance_snapshot: row.invoiceBalance, payment_method: row.paymentMethod, destination_account_id: row.destinationAccountId, submitted_at: row.submittedAt, status: row.status, consumption_kwh_snapshot: null, price_per_kwh_snapshot: null, invoice_total_snapshot: null, sender_phone: null, reference_no: null, reviewed_at: null, rejection_reason: null }));
  const utils=trpc.useUtils();
  const approve=trpc.powerhub.paymentDocumentation.approve.useMutation({onSuccess:()=>{toast.success("تم اعتماد الدفع وربطه بالحركة المالية.");utils.powerhub.paymentDocumentation.list.invalidate();},onError:e=>toast.error(e.message)});
  const queueOfflineApprovals = async () => {
    if (isOnline || !siteId || !user?.id || !selectedIds.length) return;
    const existing = await listOfflineWork({ userId: Number(user?.id ?? 0), siteId });
    const existingRequestIds = new Set(existing.filter(item => item.kind === "payment_documentation_approve").map(item => (item.payload as PaymentDocumentationApprovalDraft).requestId));
    const rows = offlineRows.filter(row => selectedIds.includes(row.id));
    let queued = 0;
    for (const row of rows) {
      if (existingRequestIds.has(row.id)) continue;
      await enqueueOfflineWork({ userId: Number(user.id), siteId, kind: "payment_documentation_approve", payload: { requestId: row.id, capturedAt: new Date().toISOString(), requestSnapshot: { invoiceNo: row.invoiceNo, subscriberName: row.subscriberName, subscriberNo: row.subscriberNo, paymentAmount: row.paymentAmount, invoiceBalance: row.invoiceBalance, paymentMethod: row.paymentMethod, destinationAccountId: row.destinationAccountId, submittedAt: row.submittedAt, status: "pending" } } });
      queued++;
    }
    setSelectedIds([]);
    toast.success(`تم تسجيل اعتماد ${queued} طلباً محلياً. لن تُنشأ الحركات المالية حتى تعود الشبكة وتنجح المزامنة والتحقق من الخادم.`);
  };
  const reject=trpc.powerhub.paymentDocumentation.reject.useMutation({onSuccess:()=>{toast.success("تم رفض طلب توثيق الدفع.");setRejectId(null);setReason("");utils.powerhub.paymentDocumentation.list.invalidate();},onError:e=>toast.error(e.message)});
  return <DashboardLayout><div className="space-y-6 p-6" dir="rtl">
    <div><h1 className="text-2xl font-black text-white">مراجعة توثيق الدفع</h1><p className="mt-1 text-sm text-slate-400">اعتماد طلب الدفع هنا هو النقطة الوحيدة التي تنشئ الحركة المالية الفعلية.</p></div>
    {!access.isLoading && !canApprove ? <Card className="border-rose-400/20 bg-rose-400/[.04]"><CardContent className="p-8 text-center"><p className="font-bold text-white">لا تملك صلاحية اعتماد توثيق الدفع الإلكتروني.</p><p className="mt-2 text-sm text-slate-400">يمكن لمالك المولد منحك الصلاحية من إعدادات الحسابات الفرعية.</p></CardContent></Card> : <>
    <div className="flex flex-wrap gap-2">{(["pending","approved","rejected","all"] as const).map(v=><Button key={v} variant={status===v?"default":"outline"} onClick={()=>setStatus(v)}>{v==="pending"?"قيد التحقق":v==="approved"?"معتمد":v==="rejected"?"مرفوض":"الكل"}</Button>)}</div>{status==="pending"&&<div className="flex flex-wrap items-center gap-2"><Badge className={isOnline?"bg-emerald-400/10 text-emerald-300":"bg-amber-400/10 text-amber-200"}>{isOnline?"متصل":"دون اتصال — قائمة الاعتماد المحلية"}</Badge>{!isOnline&&selectedIds.length>0&&<Button onClick={()=>void queueOfflineApprovals()}><CheckCircle2 className="ml-2 h-4 w-4"/>تسجيل اعتماد المحدد دون اتصال ({selectedIds.length})</Button>}</div>}
    {requests.isFetching&&isOnline?<Loader2 className="animate-spin text-slate-400"/>:visibleRequests.length===0?<Card className="border-white/10 bg-white/[.03]"><CardContent className="p-8 text-center text-slate-400">لا توجد طلبات في هذا التصنيف.</CardContent></Card>:visibleRequests.map((r:any)=><Card key={r.id} className="border-white/10 bg-white/[.025]"><CardHeader><div className="flex items-center gap-3">{r.status==="pending"&&<input type="checkbox" checked={selectedIds.includes(Number(r.id))} onChange={()=>setSelectedIds(current=>current.includes(Number(r.id))?current.filter(id=>id!==Number(r.id)):[...current,Number(r.id)])} disabled={isOnline}/>}<span className="text-xs text-slate-500">{!isOnline?"لقطة محلية":"مصدر الخادم"}</span></div><div className="flex items-center justify-between gap-4"><CardTitle className="text-white">طلب #{r.id} — {r.invoice_no_snapshot}</CardTitle><Badge>{r.status}</Badge></div></CardHeader><CardContent className="space-y-5">
      <div className="grid gap-4 md:grid-cols-4 text-sm">
        <div><span className="text-slate-500">المشترك</span><p className="text-white">{r.subscriber_name_snapshot}</p></div>
        <div><span className="text-slate-500">الرقم</span><p className="text-white">{r.subscriber_no_snapshot}</p></div>
        <div><span className="text-slate-500">الاستهلاك</span><p className="text-white">{r.consumption_kwh_snapshot} ك.و.س</p></div>
        <div><span className="text-slate-500">سعر الكيلو</span><p className="text-white">{r.price_per_kwh_snapshot}</p></div>
        <div><span className="text-slate-500">إجمالي الفاتورة</span><p className="text-white">{r.invoice_total_snapshot}</p></div>
        <div><span className="text-slate-500">الرصيد وقت الطلب</span><p className="text-amber-400 font-bold">{r.invoice_balance_snapshot}</p></div>
        <div><span className="text-slate-500">مبلغ الدفع</span><p className="text-white font-bold">{r.payment_amount}</p></div>
        <div><span className="text-slate-500">طريقة الدفع</span><p className="text-white">{r.payment_method}</p></div>
        <div><span className="text-slate-500">جوال المحوّل</span><p className="text-white">{r.sender_phone||"—"}</p></div>
        <div><span className="text-slate-500">المرجع</span><p className="text-white">{r.reference_no||"—"}</p></div>
        <div className="md:col-span-2">
          <span className="text-slate-500">تاريخ ووقت الإرسال</span>
          <p className="mt-1 text-white font-semibold">{formatArabicDateTime(r.submitted_at)}</p>
        </div>
        <div className="md:col-span-2">
          <span className="text-slate-500">تاريخ ووقت المراجعة</span>
          <p className="mt-1 text-white font-semibold">{r.reviewed_at ? formatArabicDateTime(r.reviewed_at) : "لم تتم المراجعة بعد"}</p>
        </div>
      </div>
      {r.status==="pending"&&canApprove&&<div className="flex flex-wrap gap-2 pt-2"><Button disabled={approve.isPending} onClick={()=>approve.mutate({siteId:siteId??0,requestId:Number(r.id)})}><CheckCircle2 className="ml-2 h-4 w-4"/>اعتماد الدفع</Button><Button variant="destructive" onClick={()=>setRejectId(Number(r.id))}><XCircle className="ml-2 h-4 w-4"/>رفض</Button></div>}
      {rejectId===Number(r.id)&&<div className="rounded-xl border border-red-500/20 p-4"><Textarea value={reason} onChange={e=>setReason(e.target.value)} placeholder="سبب الرفض" className="bg-white/[.03] text-white"/><div className="mt-3 flex gap-2"><Button variant="destructive" disabled={reject.isPending||reason.trim().length<2} onClick={()=>reject.mutate({siteId:siteId??0,requestId:Number(r.id),rejectionReason:reason.trim()})}>تأكيد الرفض</Button><Button variant="outline" onClick={()=>{setRejectId(null);setReason("");}}>إلغاء</Button></div></div>}
      {r.status==="rejected"&&r.rejection_reason&&<p className="rounded-xl bg-red-500/5 p-3 text-sm text-red-300">سبب الرفض: {r.rejection_reason}</p>}
    </CardContent></Card>)}
    </>}

  </div></DashboardLayout>;
}
