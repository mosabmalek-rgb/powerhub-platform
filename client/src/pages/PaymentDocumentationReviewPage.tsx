import DashboardLayout from "@/components/DashboardLayout";
import { OfflineWorkSyncPanel } from "@/components/OfflineWorkSyncPanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
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

function dateKeyInGaza(value: Date | string = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Gaza", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(value));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function formatPaymentMethod(value: unknown) {
  const labels: Record<string, string> = { cash: "نقدي", jawwal_pay: "جوال Pay", palpay: "PalPay", bank_of_palestine: "بنك فلسطين", wallet: "محفظة", bank_transfer: "تحويل بنكي", card: "بطاقة" };
  const key = String(value ?? "");
  return labels[key] ?? (key || "—");
}

function formatAccountType(value: unknown) {
  const labels: Record<string, string> = { cash: "نقدي", jawwal_pay: "جوال Pay", palpay: "PalPay", bank_of_palestine: "بنك فلسطين", other: "أخرى" };
  const key = String(value ?? "");
  return labels[key] ?? (key || "—");
}

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
  const [period,setPeriod]=useState<"current_cycle"|"today"|"specific_day"|"date_range"|"all_time">("current_cycle");
  const [specificDate,setSpecificDate]=useState(()=>dateKeyInGaza());
  const [fromDate,setFromDate]=useState(()=>dateKeyInGaza());
  const [toDate,setToDate]=useState(()=>dateKeyInGaza());
  const [rejectId,setRejectId]=useState<number|null>(null);
  const [reason,setReason]=useState("");
  const [selectedIds,setSelectedIds]=useState<number[]>([]);
  const [offlineRows,setOfflineRows]=useState<OfflinePaymentDocumentationApprovalSnapshot[]>([]);
  const [isOnline,setIsOnline]=useState(() => typeof navigator === "undefined" ? true : navigator.onLine);
  const access=trpc.powerhub.staff.myAccess.useQuery({siteId:siteId??0},{enabled:Boolean(siteId),staleTime:0,refetchOnMount:"always"});
  const canApprove=can(access.data?.role,"approvePaymentDocumentation",access.data?.permissions);
  const dateFiltersReady = period === "specific_day" ? Boolean(specificDate) : period === "date_range" ? Boolean(fromDate && toDate && fromDate <= toDate) : true;
  // Pending documentation is operationally time-sensitive. Poll only while this page is
  // mounted and connected; hidden/background tabs do not keep issuing requests.
  const shouldPollRequests = isOnline && (status === "pending" || status === "all");
  const requests=trpc.powerhub.paymentDocumentation.list.useQuery({ siteId:siteId??0, status, period, specificDate:period==="specific_day"?specificDate:undefined, fromDate:period==="date_range"?fromDate:undefined, toDate:period==="date_range"?toDate:undefined },{enabled:Boolean(siteId && canApprove && isOnline && dateFiltersReady),retry:false,staleTime:15_000,refetchOnMount:"always",refetchInterval:shouldPollRequests?15_000:false,refetchIntervalInBackground:false});
  const loadOfflineRows=useCallback(async()=>{
    // Clear any prior identity/branch before starting an async IndexedDB read.
    setOfflineRows([]);
    setSelectedIds([]);
    if(!user?.id||!siteId)return;
    try{
      const rows=await listPaymentDocumentationApprovalSnapshots(Number(user.id),siteId);
      setOfflineRows(rows);
    }catch{
      toast.error("تعذر قراءة قائمة الاعتمادات المحلية.");
    }
  },[siteId,user?.id]);
  useEffect(()=>{const on=()=>setIsOnline(true),off=()=>setIsOnline(false);window.addEventListener("online",on);window.addEventListener("offline",off);return()=>{window.removeEventListener("online",on);window.removeEventListener("offline",off);};},[]);
  useEffect(()=>{
    if(isOnline){
      setOfflineRows([]);
      setSelectedIds([]);
      return;
    }
    void loadOfflineRows();
  },[isOnline,loadOfflineRows]);
  useEffect(()=>{
    if(!isOnline||!user?.id||!siteId||status!=="pending"||!requests.isSuccess||!Array.isArray(requests.data))return;
    void savePaymentDocumentationApprovalSnapshots(Number(user.id),siteId,requests.data.map((r:any)=>({
      id:Number(r.id),invoiceNo:String(r.invoice_no_snapshot),subscriberName:String(r.subscriber_name_snapshot),
      subscriberNo:String(r.subscriber_no_snapshot),paymentAmount:Number(r.payment_amount),
      invoiceBalance:Number(r.invoice_balance_snapshot),paymentMethod:String(r.payment_method),
      destinationAccountId:Number(r.destination_account_id),submittedAt:String(r.submitted_at),status:"pending",
    }))).catch(()=>toast.error("تعذر حفظ لقطة اعتماد الدفع المحلية."));
  },[isOnline,requests.data,requests.isSuccess,siteId,status,user?.id]);
  const visibleRequests:any[] = isOnline ? (dateFiltersReady ? (requests.data ?? []) : []) : offlineRows
    .filter((row) => status === "all" || row.status === status)
    .filter((row) => {
      const submittedDate = dateKeyInGaza(row.submittedAt);
      if (period === "all_time") return true;
      if (period === "current_cycle") return false;
      if (period === "today") return submittedDate === dateKeyInGaza();
      if (period === "specific_day") return submittedDate === specificDate;
      return submittedDate >= fromDate && submittedDate <= toDate;
    })
    .map(row => ({ id: row.id, invoice_no_snapshot: row.invoiceNo, subscriber_name_snapshot: row.subscriberName, subscriber_no_snapshot: row.subscriberNo, payment_amount: row.paymentAmount, invoice_balance_snapshot: row.invoiceBalance, payment_method: row.paymentMethod, destination_account_id: row.destinationAccountId, submitted_at: row.submittedAt, status: row.status, consumption_kwh_snapshot: null, price_per_kwh_snapshot: null, invoice_total_snapshot: null, sender_phone: null, reference_no: null, reviewed_at: null, rejection_reason: null, receipt_image_key: null, destination_account_name: null, destination_account_type: null, destination_account_phone_number: null }));
  const [receiptUrls,setReceiptUrls]=useState<Record<number,string>>({});
  const [receiptLoadingId,setReceiptLoadingId]=useState<number|null>(null);
  const [previewReceipt,setPreviewReceipt]=useState<{requestId:number;url:string}|null>(null);
  const utils=trpc.useUtils();
  const refreshAfterApproval = () => {
    const targetSiteId = siteId ?? 0;
    void Promise.all([
      utils.powerhub.paymentDocumentation.list.invalidate(),
      utils.powerhub.payments.list.invalidate({ siteId: targetSiteId }),
      utils.powerhub.payments.page.invalidate({ siteId: targetSiteId, limit: 100 }),
      utils.powerhub.invoices.list.invalidate({ siteId: targetSiteId }),
      utils.powerhub.invoices.page.invalidate({ siteId: targetSiteId, limit: 100 }),
      utils.powerhub.collectorSessions.list.invalidate({ siteId: targetSiteId }),
      utils.powerhub.collectorSessions.current.invalidate({ siteId: targetSiteId }),
      utils.powerhub.dashboard.summary.invalidate({ siteId: targetSiteId }),
      utils.powerhub.dashboard.financialOverview.invalidate({ siteId: targetSiteId }),
      utils.powerhub.dashboard.periodMetrics.invalidate({ siteId: targetSiteId, scope: "branch" }),
      utils.powerhub.audit.list.invalidate({ siteId: targetSiteId }),
    ]).catch(() => toast.warning("تم اعتماد الدفع، لكن تعذر تحديث بعض الملخصات. أعد تحميل العرض للتحقق."));
  };
  const refreshAfterRejection = () => {
    void Promise.all([
      utils.powerhub.paymentDocumentation.list.invalidate(),
      utils.powerhub.audit.list.invalidate({ siteId: siteId ?? 0 }),
    ]).catch(() => toast.warning("تم رفض الطلب، لكن تعذر تحديث بعض البيانات المعروضة."));
  };
  const openReceiptPreview = async (requestId: number) => {
    let url = receiptUrls[requestId];
    if (!url) {
      setReceiptLoadingId(requestId);
      try {
        const result = await utils.powerhub.paymentDocumentation.receiptUrl.fetch({ siteId: siteId ?? 0, requestId });
        url = result.url;
        setReceiptUrls(current => ({ ...current, [requestId]: result.url }));
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "تعذر فتح صورة التحويل.");
        return;
      } finally {
        setReceiptLoadingId(null);
      }
    }
    if (url) setPreviewReceipt({ requestId, url });
  };
  const approve=trpc.powerhub.paymentDocumentation.approve.useMutation({onSuccess:()=>{toast.success("تم اعتماد الدفع وربطه بالحركة المالية.");refreshAfterApproval();},onError:e=>toast.error(e.message)});
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
  const reject=trpc.powerhub.paymentDocumentation.reject.useMutation({onSuccess:()=>{toast.success("تم رفض طلب توثيق الدفع.");setRejectId(null);setReason("");refreshAfterRejection();},onError:e=>toast.error(e.message)});
  return <DashboardLayout><div className="space-y-6 p-6" dir="rtl">
    <div><h1 className="text-2xl font-black text-white">مراجعة توثيق الدفع</h1><p className="mt-1 text-sm text-slate-400">اعتماد طلب الدفع هنا هو النقطة الوحيدة التي تنشئ الحركة المالية الفعلية.</p></div>{user?.id&&siteId&&canApprove?<OfflineWorkSyncPanel siteId={siteId} userId={Number(user.id)} compact />:null}
    {!access.isLoading && !canApprove ? <Card className="border-rose-400/20 bg-rose-400/[.04]"><CardContent className="p-8 text-center"><p className="font-bold text-white">لا تملك صلاحية اعتماد توثيق الدفع الإلكتروني.</p><p className="mt-2 text-sm text-slate-400">يمكن لمالك المولد منحك الصلاحية من إعدادات الحسابات الفرعية.</p></CardContent></Card> : <>
    <div className="flex flex-wrap gap-2">{(["pending","approved","rejected","all"] as const).map(v=><Button key={v} variant={status===v?"default":"outline"} onClick={()=>setStatus(v)}>{v==="pending"?"قيد التحقق":v==="approved"?"معتمد":v==="rejected"?"مرفوض":"الكل"}</Button>)}</div>
    <Card className="border-white/10 bg-white/[.025]"><CardContent className="grid gap-3 p-4 md:grid-cols-3">
      <div><Label className="text-slate-300">الفترة الزمنية</Label><select value={period} onChange={e=>setPeriod(e.target.value as typeof period)} className="mt-2 h-10 w-full rounded-xl border border-white/10 bg-[#101722] px-3 text-sm text-white"><option value="current_cycle">هذه الدورة</option><option value="today">اليوم</option><option value="specific_day">يوم محدد</option><option value="date_range">فترة زمنية محددة</option><option value="all_time">كل الفترات</option></select></div>
      {period==="specific_day"&&<div><Label className="text-slate-300">اليوم</Label><input aria-label="اليوم المحدد" type="date" value={specificDate} onChange={e=>setSpecificDate(e.target.value)} className="mt-2 h-10 w-full rounded-xl border border-white/10 bg-[#101722] px-3 text-sm text-white"/></div>}
      {period==="date_range"&&<><div><Label className="text-slate-300">من تاريخ</Label><input aria-label="من تاريخ" type="date" value={fromDate} max={toDate||undefined} onChange={e=>setFromDate(e.target.value)} className="mt-2 h-10 w-full rounded-xl border border-white/10 bg-[#101722] px-3 text-sm text-white"/></div><div><Label className="text-slate-300">إلى تاريخ</Label><input aria-label="إلى تاريخ" type="date" value={toDate} min={fromDate||undefined} onChange={e=>setToDate(e.target.value)} className="mt-2 h-10 w-full rounded-xl border border-white/10 bg-[#101722] px-3 text-sm text-white"/></div></>}
    </CardContent></Card>
    {!dateFiltersReady&&<p className="text-sm text-amber-300">أدخل تاريخاً صحيحاً أو اضبط فترة البداية والنهاية قبل عرض الطلبات.</p>}
    {requests.isFetching && requests.data ? <p role="status" aria-live="polite" className="flex items-center gap-2 text-xs text-slate-400"><Loader2 className="h-3.5 w-3.5 animate-spin" /> جارٍ تحديث الطلبات في الخلفية؛ تبقى النتائج الحالية ظاهرة.</p> : null}
    {!isOnline&&<p className="text-xs text-amber-200">أنت دون اتصال؛ المتاح هو ما تم حفظه محلياً فقط، ولا يمكن التحقق من مطابقة لقطة الطلبات لدورة القراءة الحالية دون اتصال.</p>}
    {status==="pending"&&<div className="flex flex-wrap items-center gap-2"><Badge className={isOnline?"bg-emerald-400/10 text-emerald-300":"bg-amber-400/10 text-amber-200"}>{isOnline?"متصل":"دون اتصال — قائمة الاعتماد المحلية"}</Badge>{!isOnline&&selectedIds.length>0&&<Button onClick={()=>void queueOfflineApprovals()}><CheckCircle2 className="ml-2 h-4 w-4"/>تسجيل اعتماد المحدد دون اتصال ({selectedIds.length})</Button>}</div>}
    {requests.isLoading&&isOnline?<Loader2 className="animate-spin text-slate-400"/>:!dateFiltersReady?null:visibleRequests.length===0?<Card className="border-white/10 bg-white/[.03]"><CardContent className="p-8 text-center text-slate-400">لا توجد طلبات تطابق الحالة والفترة المحددتين.</CardContent></Card>:visibleRequests.map((r:any)=><Card key={r.id} className="border-white/10 bg-white/[.025]"><CardHeader><div className="flex items-center gap-3">{r.status==="pending"&&<input type="checkbox" checked={selectedIds.includes(Number(r.id))} onChange={()=>setSelectedIds(current=>current.includes(Number(r.id))?current.filter(id=>id!==Number(r.id)):[...current,Number(r.id)])} disabled={isOnline}/>}<span className="text-xs text-slate-500">{!isOnline?"لقطة محلية":"مصدر الخادم"}</span></div><div className="flex items-center justify-between gap-4"><CardTitle className="text-white">طلب #{r.id} — {r.invoice_no_snapshot}</CardTitle><Badge>{r.status==="pending"?"قيد التحقق":r.status==="approved"?"معتمد":r.status==="rejected"?"مرفوض":r.status}</Badge></div></CardHeader><CardContent className="space-y-5">
      <div className="grid gap-4 md:grid-cols-4 text-sm">
        <div><span className="text-slate-500">المشترك</span><p className="text-white">{r.subscriber_name_snapshot}</p></div>
        <div><span className="text-slate-500">الرقم</span><p className="text-white">{r.subscriber_no_snapshot}</p></div>
        <div><span className="text-slate-500">الاستهلاك</span><p className="text-white">{r.consumption_kwh_snapshot} ك.و.س</p></div>
        <div><span className="text-slate-500">سعر الكيلو</span><p className="text-white">{r.price_per_kwh_snapshot}</p></div>
        <div><span className="text-slate-500">إجمالي الفاتورة</span><p className="text-white">{r.invoice_total_snapshot}</p></div>
        <div><span className="text-slate-500">الرصيد وقت الطلب</span><p className="text-amber-400 font-bold">{r.invoice_balance_snapshot}</p></div>
        <div><span className="text-slate-500">مبلغ الدفع</span><p className="text-white font-bold">{r.payment_amount}</p></div>
        <div><span className="text-slate-500">الحساب المحوَّل منه</span><p className="text-white">{r.sender_phone||"—"}</p><p className="mt-1 text-slate-300">طريقة التحويل: {formatPaymentMethod(r.payment_method)}</p></div>
        <div><span className="text-slate-500">الحساب المستقبِل</span><p className="font-semibold text-white">{r.destination_account_name||"—"}</p><p className="mt-1 text-slate-300">{formatAccountType(r.destination_account_type)} · {r.destination_account_phone_number||"لا يوجد رقم مسجل"}</p></div>
        
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
      {r.receipt_image_key&&isOnline&&<div><Button variant="outline" disabled={receiptLoadingId===Number(r.id)} onClick={()=>void openReceiptPreview(Number(r.id))}>{receiptLoadingId===Number(r.id)?<Loader2 className="ml-2 h-4 w-4 animate-spin"/>:<ExternalLink className="ml-2 h-4 w-4"/>}عرض صورة التحويل</Button></div>}
      {r.status==="pending"&&canApprove&&<div className="flex flex-wrap gap-2 pt-2"><Button disabled={approve.isPending} onClick={()=>approve.mutate({siteId:siteId??0,requestId:Number(r.id)})}>{approve.isPending&&Number(approve.variables?.requestId)===Number(r.id)?<Loader2 className="ml-2 h-4 w-4 animate-spin"/>:<CheckCircle2 className="ml-2 h-4 w-4"/>}{approve.isPending&&Number(approve.variables?.requestId)===Number(r.id)?"جارٍ اعتماد الدفع…":"اعتماد الدفع"}</Button><Button variant="destructive" disabled={reject.isPending||(approve.isPending&&Number(approve.variables?.requestId)===Number(r.id))} onClick={()=>setRejectId(Number(r.id))}><XCircle className="ml-2 h-4 w-4"/>رفض</Button></div>}
      {rejectId===Number(r.id)&&<div className="rounded-xl border border-red-500/20 p-4"><Textarea value={reason} onChange={e=>setReason(e.target.value)} placeholder="سبب الرفض" className="bg-white/[.03] text-white"/><div className="mt-3 flex gap-2"><Button variant="destructive" disabled={reject.isPending||reason.trim().length<2} onClick={()=>reject.mutate({siteId:siteId??0,requestId:Number(r.id),rejectionReason:reason.trim()})}>تأكيد الرفض</Button><Button variant="outline" onClick={()=>{setRejectId(null);setReason("");}}>إلغاء</Button></div></div>}
      {r.status==="rejected"&&r.rejection_reason&&<p className="rounded-xl bg-red-500/5 p-3 text-sm text-red-300">سبب الرفض: {r.rejection_reason}</p>}
    </CardContent></Card>)}
    </>}
    <Dialog open={Boolean(previewReceipt)} onOpenChange={(open)=>!open&&setPreviewReceipt(null)}><DialogContent className="max-w-2xl border-white/10 bg-[#111823] text-white"><DialogHeader><DialogTitle>صورة إيصال توثيق الدفع <span className="text-xs text-slate-400">طلب #{previewReceipt?.requestId}</span></DialogTitle></DialogHeader>{previewReceipt?<img src={previewReceipt.url} alt={`صورة إيصال توثيق الدفع للطلب ${previewReceipt.requestId}`} className="mx-auto max-h-[70vh] w-full rounded-xl border border-white/10 object-contain"/>:null}</DialogContent></Dialog>
  </div></DashboardLayout>;
}
