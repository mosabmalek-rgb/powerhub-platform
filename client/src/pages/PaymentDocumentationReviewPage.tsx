import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { useBranchFilter } from "@/hooks/useBranchFilter";
import { trpc } from "@/lib/trpc";
import { CheckCircle2, ExternalLink, Loader2, XCircle } from "lucide-react";
import { can } from "@shared/powerhub-rbac";
import { useState } from "react";
import { toast } from "sonner";

export default function PaymentDocumentationReviewPage() {
  const { branchId: siteId } = useBranchFilter();
  const [status,setStatus]=useState<"pending"|"approved"|"rejected"|"all">("pending");
  const [rejectId,setRejectId]=useState<number|null>(null);
  const [reason,setReason]=useState("");
  const access=trpc.powerhub.staff.myAccess.useQuery({siteId:siteId??0},{enabled:Boolean(siteId)});
  const canApprove=can(access.data?.role,"approvePaymentDocumentation",access.data?.permissions);
  const requests=trpc.powerhub.paymentDocumentation.list.useQuery({siteId:siteId??0,status},{enabled:Boolean(siteId && canApprove)});
  const utils=trpc.useUtils();
  const approve=trpc.powerhub.paymentDocumentation.approve.useMutation({onSuccess:()=>{toast.success("تم اعتماد الدفع وربطه بالحركة المالية.");utils.powerhub.paymentDocumentation.list.invalidate();},onError:e=>toast.error(e.message)});
  const reject=trpc.powerhub.paymentDocumentation.reject.useMutation({onSuccess:()=>{toast.success("تم رفض طلب توثيق الدفع.");setRejectId(null);setReason("");utils.powerhub.paymentDocumentation.list.invalidate();},onError:e=>toast.error(e.message)});
  return <DashboardLayout><div className="space-y-6 p-6" dir="rtl">
    <div><h1 className="text-2xl font-black text-white">مراجعة توثيق الدفع</h1><p className="mt-1 text-sm text-slate-400">اعتماد طلب الدفع هنا هو النقطة الوحيدة التي تنشئ الحركة المالية الفعلية.</p></div>
    {!access.isLoading && !canApprove ? <Card className="border-rose-400/20 bg-rose-400/[.04]"><CardContent className="p-8 text-center"><p className="font-bold text-white">لا تملك صلاحية اعتماد توثيق الدفع الإلكتروني.</p><p className="mt-2 text-sm text-slate-400">يمكن لمالك المولد منحك الصلاحية من إعدادات الحسابات الفرعية.</p></CardContent></Card> : <>
    <div className="flex flex-wrap gap-2">{(["pending","approved","rejected","all"] as const).map(v=><Button key={v} variant={status===v?"default":"outline"} onClick={()=>setStatus(v)}>{v==="pending"?"قيد التحقق":v==="approved"?"معتمد":v==="rejected"?"مرفوض":"الكل"}</Button>)}</div>
    {requests.isFetching?<Loader2 className="animate-spin text-slate-400"/>:requests.data?.length===0?<Card className="border-white/10 bg-white/[.03]"><CardContent className="p-8 text-center text-slate-400">لا توجد طلبات في هذا التصنيف.</CardContent></Card>:requests.data?.map((r:any)=><Card key={r.id} className="border-white/10 bg-white/[.025]"><CardHeader><div className="flex items-center justify-between gap-4"><CardTitle className="text-white">طلب #{r.id} — {r.invoice_no_snapshot}</CardTitle><Badge>{r.status}</Badge></div></CardHeader><CardContent className="space-y-5">
      <div className="grid gap-4 md:grid-cols-4 text-sm"><div><span className="text-slate-500">المشترك</span><p className="text-white">{r.subscriber_name_snapshot}</p></div><div><span className="text-slate-500">الرقم</span><p className="text-white">{r.subscriber_no_snapshot}</p></div><div><span className="text-slate-500">الاستهلاك</span><p className="text-white">{r.consumption_kwh_snapshot} ك.و.س</p></div><div><span className="text-slate-500">سعر الكيلو</span><p className="text-white">{r.price_per_kwh_snapshot}</p></div><div><span className="text-slate-500">إجمالي الفاتورة</span><p className="text-white">{r.invoice_total_snapshot}</p></div><div><span className="text-slate-500">الرصيد وقت الطلب</span><p className="text-amber-400 font-bold">{r.invoice_balance_snapshot}</p></div><div><span className="text-slate-500">مبلغ الدفع</span><p className="text-white font-bold">{r.payment_amount}</p></div><div><span className="text-slate-500">طريقة الدفع</span><p className="text-white">{r.payment_method}</p></div><div><span className="text-slate-500">جوال المحوّل</span><p className="text-white">{r.sender_phone||"—"}</p></div><div><span className="text-slate-500">المرجع</span><p className="text-white">{r.reference_no||"—"}</p></div></div>
      {r.status==="pending"&&canApprove&&<div className="flex flex-wrap gap-2 pt-2"><Button disabled={approve.isPending} onClick={()=>approve.mutate({siteId:siteId??0,requestId:Number(r.id)})}><CheckCircle2 className="ml-2 h-4 w-4"/>اعتماد الدفع</Button><Button variant="destructive" onClick={()=>setRejectId(Number(r.id))}><XCircle className="ml-2 h-4 w-4"/>رفض</Button></div>}
      {rejectId===Number(r.id)&&<div className="rounded-xl border border-red-500/20 p-4"><Textarea value={reason} onChange={e=>setReason(e.target.value)} placeholder="سبب الرفض" className="bg-white/[.03] text-white"/><div className="mt-3 flex gap-2"><Button variant="destructive" disabled={reject.isPending||reason.trim().length<2} onClick={()=>reject.mutate({siteId:siteId??0,requestId:Number(r.id),rejectionReason:reason.trim()})}>تأكيد الرفض</Button><Button variant="outline" onClick={()=>{setRejectId(null);setReason("");}}>إلغاء</Button></div></div>}
      {r.status==="rejected"&&r.rejection_reason&&<p className="rounded-xl bg-red-500/5 p-3 text-sm text-red-300">سبب الرفض: {r.rejection_reason}</p>}
    </CardContent></Card>)}
    </>}

  </div></DashboardLayout>;
}
