import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useBranchFilter } from "@/hooks/useBranchFilter";
import { trpc } from "@/lib/trpc";
import { Loader2, Search, Upload, CheckCircle2, XCircle, ExternalLink } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

const methods = [
  ["cash","نقدي"],["jawwal_pay","جوال Pay"],["palpay","PalPay"],["bank_of_palestine","بنك فلسطين"],["wallet","محفظة"],["bank_transfer","تحويل بنكي"],["card","بطاقة"]
] as const;

export default function PaymentDocumentationPage() {
  const { siteId } = useBranchFilter();
  const [query,setQuery]=useState("");
  const [selected,setSelected]=useState<any>(null);
  const [invoice,setInvoice]=useState<any>(null);
  const [amount,setAmount]=useState("");
  const [method,setMethod]=useState<string>("");
  const [senderPhone,setSenderPhone]=useState("");
  const [referenceNo,setReferenceNo]=useState("");
  const [accountId,setAccountId]=useState("");
  const [file,setFile]=useState<File|null>(null);

  const search = trpc.powerhub.paymentDocumentation.searchSubscriber.useQuery({siteId,query:query.trim()},{enabled:Boolean(siteId&&query.trim().length>=2)});
  const accounts = trpc.powerhub.paymentDocumentation.availableAccounts.useQuery({siteId},{enabled:Boolean(siteId)});
  const submit = trpc.powerhub.paymentDocumentation.submit.useMutation({
    onSuccess:()=>{toast.success("تم إرسال طلب الدفع بنجاح. سيتم التحقق لاعتماد الدفع. دمتم بخير 🌷");setInvoice(null);setFile(null);setAmount("");setReferenceNo("");setSenderPhone("");},
    onError:e=>toast.error(e.message)
  });

  const selectedAccount = useMemo(()=>accounts.data?.find((a:any)=>String(a.id)===accountId),[accounts.data,accountId]);

  async function submitPayment(){
    if(!invoice||!selected||!siteId)return;
    if(!amount||Number(amount)<=0)return toast.error("أدخل مبلغ دفع صحيح.");
    if(!method)return toast.error("اختر طريقة الدفع.");
    if(!accountId)return toast.error("اختر الحساب المستقبِل.");
    let receiptImageData:string|undefined;
    let receiptImageMime:any;
    if(file){
      if(file.size>7*1024*1024)return toast.error("حجم صورة التحويل يجب ألا يتجاوز 7 ميغابايت.");
      receiptImageData=await new Promise<string>((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result).split(",")[1]??"");r.onerror=reject;r.readAsDataURL(file);});
      receiptImageMime=file.type as any;
    }
    submit.mutate({siteId,subscriberId:Number(selected.id),invoiceId:Number(invoice.id),destinationAccountId:Number(accountId),paymentAmount:Number(amount),paymentMethod:method as any,senderPhone:senderPhone||undefined,referenceNo:referenceNo||undefined,receiptImageData,receiptImageMime});
  }

  return <DashboardLayout><div className="space-y-6 p-6" dir="rtl">
    <div><h1 className="text-2xl font-black text-white">توثيق الدفع الإلكتروني</h1><p className="mt-1 text-sm text-slate-400">ابحث عن المشترك، اختر الفاتورة، ثم أرسل بيانات التحويل للتحقق قبل اعتماد الحركة المالية.</p></div>
    <Card className="border-white/10 bg-white/[.03]"><CardContent className="p-5">
      <Label className="text-slate-300">البحث عن مشترك</Label>
      <div className="mt-2 flex gap-2"><Input value={query} onChange={e=>setQuery(e.target.value)} placeholder="اسم المشترك أو رقمه" className="border-white/10 bg-white/[.03] text-white"/><Button onClick={()=>search.refetch()}><Search className="ml-2 h-4 w-4"/>بحث</Button></div>
    </CardContent></Card>
    {search.isFetching&&<div className="flex justify-center"><Loader2 className="animate-spin text-slate-400"/></div>}
    {search.data?.map((sub:any)=><Card key={sub.id} className="border-white/10 bg-white/[.025]"><CardHeader><CardTitle className="text-white">{sub.full_name} <span className="text-sm text-slate-400">#{sub.subscriber_no}</span></CardTitle></CardHeader><CardContent className="space-y-3">
      {(sub.invoices??[]).map((inv:any)=><div key={inv.id} className="rounded-xl border border-white/10 p-4">
        <div className="grid gap-3 md:grid-cols-4 text-sm">
          <div><span className="text-slate-500">الفاتورة</span><p className="font-bold text-white">{inv.invoice_no}</p></div>
          <div><span className="text-slate-500">القراءة السابقة</span><p className="text-white">{inv.previous_reading ?? "—"}</p></div>
          <div><span className="text-slate-500">القراءة الحالية</span><p className="text-white">{inv.current_reading ?? "—"}</p></div>
          <div><span className="text-slate-500">الاستهلاك</span><p className="text-white">{inv.consumption_kwh ?? 0} ك.و.س</p></div>
          <div><span className="text-slate-500">سعر الكيلو</span><p className="text-white">{inv.price_per_kwh ?? 0}</p></div>
          <div><span className="text-slate-500">إجمالي الفاتورة</span><p className="text-white">{inv.total_amount}</p></div>
          <div><span className="text-slate-500">الرصيد المستحق</span><p className="font-bold text-amber-400">{inv.balance_due}</p></div>
          <div><span className="text-slate-500">الحالة</span><p><Badge variant="outline">{inv.status}</Badge></p></div>
        </div>
        {Number(inv.balance_due)>0&&<Button className="mt-4" onClick={()=>{setInvoice(inv);setSelected(sub);setAmount(String(inv.balance_due));}} >تسديد فاتورة</Button>}
      </div>)}
      {!sub.invoices?.length&&<p className="text-sm text-slate-500">لا توجد فواتير لهذا المشترك.</p>}
    </CardContent></Card>)}
    {invoice&&<Card className="border-[#F5B800]/30 bg-[#F5B800]/[.035]"><CardHeader><CardTitle className="text-white">بطاقة توثيق الدفع — {invoice.invoice_no}</CardTitle></CardHeader><CardContent className="space-y-5">
      <div className="grid gap-4 md:grid-cols-3 text-sm"><div><span className="text-slate-500">المشترك</span><p className="text-white">{selected.full_name}</p></div><div><span className="text-slate-500">الرقم</span><p className="text-white">{selected.subscriber_no}</p></div><div><span className="text-slate-500">الرصيد وقت الطلب</span><p className="text-amber-400 font-bold">{invoice.balance_due}</p></div></div>
      <div className="grid gap-4 md:grid-cols-2">
        <div><Label className="text-slate-300">مبلغ الدفع</Label><Input type="number" min="0.01" max={invoice.balance_due} value={amount} onChange={e=>setAmount(e.target.value)} className="mt-2 bg-white/[.03] text-white"/></div>
        <div><Label className="text-slate-300">طريقة الدفع</Label><select value={method} onChange={e=>setMethod(e.target.value)} className="mt-2 h-10 w-full rounded-xl border border-white/10 bg-[#101722] px-3 text-sm text-white"><option value="">اختر طريقة الدفع</option>{methods.map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></div>
        <div><Label className="text-slate-300">الحساب المستقبِل</Label><select value={accountId} onChange={e=>setAccountId(e.target.value)} className="mt-2 h-10 w-full rounded-xl border border-white/10 bg-[#101722] px-3 text-sm text-white"><option value="">اختر الحساب</option>{accounts.data?.filter((a:any)=>!method||a.accountType===method).map((a:any)=><option key={a.id} value={a.id}>{a.name}</option>)}</select>{selectedAccount&&<p className="mt-1 text-xs text-slate-500">{selectedAccount.accountType}</p>}</div>
        <div><Label className="text-slate-300">رقم الجوال المحوّل منه</Label><Input value={senderPhone} onChange={e=>setSenderPhone(e.target.value)} placeholder="اختياري" className="mt-2 bg-white/[.03] text-white"/></div>
        <div><Label className="text-slate-300">الرقم المرجعي للتحويل</Label><Input value={referenceNo} onChange={e=>setReferenceNo(e.target.value)} placeholder="اختياري" className="mt-2 bg-white/[.03] text-white"/></div>
        <div><Label className="text-slate-300">صورة التحويل</Label><Input type="file" accept="image/jpeg,image/png,image/webp" onChange={e=>setFile(e.target.files?.[0]??null)} className="mt-2 text-slate-300"/></div>
      </div>
      <div className="rounded-xl border border-white/10 bg-black/10 p-4 text-sm text-slate-400">سيتم حفظ بيانات الفاتورة والقراءات كنسخة توثيقية لحظة الإرسال، ولن تُحتسب الحركة المالية إلا بعد الاعتماد.</div>
      <Button disabled={submit.isPending} onClick={submitPayment}>{submit.isPending?<Loader2 className="animate-spin"/>:<Upload className="ml-2 h-4 w-4"/>}إرسال للتحقق</Button>
    </CardContent></Card>}
  </div></DashboardLayout>;
}
