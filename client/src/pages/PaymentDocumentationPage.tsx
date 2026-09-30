import DashboardLayout from "@/components/DashboardLayout";
import { OfflineWorkSyncPanel } from "@/components/OfflineWorkSyncPanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useBranchFilter } from "@/hooks/useBranchFilter";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { enqueueOfflineWork } from "@/lib/offline-work-queue";
import { listPaymentDocumentationAccountSnapshots, savePaymentDocumentationSnapshot, searchPaymentDocumentationSnapshots } from "@/lib/offline-payment-documentation";
import { preparePaymentReceiptImage } from "@/lib/payment-receipt-image";
import { Loader2, Search, Upload, CheckCircle2, XCircle, ExternalLink } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

const methods = [
  ["cash","نقدي"],["jawwal_pay","جوال Pay"],["palpay","PalPay"],["bank_of_palestine","بنك فلسطين"],["wallet","محفظة"],["bank_transfer","تحويل بنكي"],["card","بطاقة"]
] as const;

export default function PaymentDocumentationPage() {
  const { branchId, setBranchId } = useBranchFilter();
  const { user } = useAuth();
  const siteId = branchId ?? 0;
  const invoiceToken = typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("invoiceToken") ?? "";
  const [query,setQuery]=useState("");
  const [selected,setSelected]=useState<any>(null);
  const [invoice,setInvoice]=useState<any>(null);
  const [amount,setAmount]=useState("");
  const [method,setMethod]=useState<string>("");
  const [senderPhone,setSenderPhone]=useState("");
  const [referenceNo,setReferenceNo]=useState("");
  const [accountId,setAccountId]=useState("");
  const [file,setFile]=useState<File|null>(null);
  const [isOnline,setIsOnline]=useState(() => typeof navigator === "undefined" ? true : navigator.onLine);
  const [offlineSearchData,setOfflineSearchData]=useState<any[]>([]);
  const [offlineAccounts,setOfflineAccounts]=useState<any[]>([]);

  const search = trpc.powerhub.paymentDocumentation.searchSubscriber.useQuery({siteId,query:query.trim()},{enabled:Boolean(isOnline&&siteId&&query.trim().length>=2)});
  const accounts = trpc.powerhub.paymentDocumentation.availableAccounts.useQuery({siteId: siteId ?? 0},{enabled:Boolean(isOnline&&siteId)});
  const publicInvoice = trpc.powerhub.invoices.publicByToken.useQuery({ token: invoiceToken }, { enabled: Boolean(invoiceToken && isOnline), retry: false });
  const submit = trpc.powerhub.paymentDocumentation.submit.useMutation({
    onSuccess:()=>{toast.success("تم إرسال طلب الدفع بنجاح. سيتم التحقق لاعتماد الدفع. دمتم بخير 🌷");setInvoice(null);setFile(null);setAmount("");setReferenceNo("");setSenderPhone("");},
    onError:e=>toast.error(e.message)
  });

  useEffect(() => {
    const data = publicInvoice.data;
    if (!data?.siteId || !invoiceToken) return;
    setBranchId(Number(data.siteId));
    setSelected({
      id: Number(data.invoice.subscriberId ?? 0),
      full_name: data.subscriber?.fullName ?? "",
      subscriber_no: data.subscriber?.subscriberNo ?? "",
      phone: "",
      invoices: [data.invoice],
    });
    setInvoice(data.invoice);
    setAmount(String(data.invoice.balanceDue ?? ""));
  }, [invoiceToken, publicInvoice.data, setBranchId]);

  const displayedSearch = isOnline ? (search.data ?? []) : offlineSearchData;
  const displayedAccounts = isOnline ? (accounts.data ?? []) : offlineAccounts;
  const selectedAccount = useMemo(()=>displayedAccounts.find((a:any)=>String(a.id)===accountId),[displayedAccounts,accountId]);
  const loadOfflineSnapshots = useCallback(async()=>{ if(!user?.id||!siteId)return; try{ const [subs,acs]=await Promise.all([searchPaymentDocumentationSnapshots({userId:user.id,siteId,query}),listPaymentDocumentationAccountSnapshots({userId:user.id,siteId})]); setOfflineSearchData(subs.map((sub:any)=>({ id:sub.id, full_name:sub.fullName, subscriber_no:sub.subscriberNo, phone:sub.phone, whatsapp_number:sub.whatsappNumber, invoices:(sub.invoices??[]).map((inv:any)=>({ id:inv.id, invoice_no:inv.invoiceNo, billing_period:inv.billingPeriod, previous_reading:inv.previousReading, current_reading:inv.currentReading, consumption_kwh:inv.consumptionKwh, price_per_kwh:inv.pricePerKwh, total_amount:inv.invoiceTotal, balance_due:inv.invoiceBalance, status:inv.status })) }))); setOfflineAccounts(acs); }catch{ toast.error("تعذر قراءة النسخة المحلية لتوثيق الدفع."); } },[query,siteId,user?.id]);
  useEffect(()=>{const on=()=>setIsOnline(true),off=()=>setIsOnline(false);window.addEventListener("online",on);window.addEventListener("offline",off);return()=>{window.removeEventListener("online",on);window.removeEventListener("offline",off);};},[]);
  useEffect(()=>{if(!isOnline&&query.trim().length>=2)void loadOfflineSnapshots();},[isOnline,query,loadOfflineSnapshots]);
  useEffect(()=>{if(!isOnline||!user?.id||!siteId||!search.data?.length)return;const accountsSnapshot=(accounts.data??[]).map((a:any)=>({id:Number(a.id),name:String(a.name),accountType:String(a.accountType),phoneNumber:a.phoneNumber??null}));for(const sub of search.data as any[]){void savePaymentDocumentationSnapshot({userId:user.id,siteId,subscriber:{id:Number(sub.id),fullName:String(sub.full_name),subscriberNo:String(sub.subscriber_no),phone:String(sub.phone??""),whatsappNumber:sub.whatsapp_number??null,invoices:(sub.invoices??[]).map((i:any)=>({id:Number(i.id),invoiceNo:String(i.invoice_no),billingPeriod:i.billing_period??null,previousReading:i.previous_reading===null?null:Number(i.previous_reading),currentReading:i.current_reading===null?null:Number(i.current_reading),consumptionKwh:Number(i.consumption_kwh??0),pricePerKwh:Number(i.price_per_kwh??0),consumptionValue:null,invoiceTotal:Number(i.total_amount??0),invoiceBalance:Number(i.balance_due??0),status:String(i.status??"unknown")}))},accounts:accountsSnapshot});}},[accounts.data,isOnline,search.data,siteId,user?.id]);

  async function submitPayment(){
    if(!invoice||!selected||!siteId)return;
    if(!amount||Number(amount)<=0)return toast.error("أدخل مبلغ دفع صحيح.");
    if(!method)return toast.error("اختر طريقة الدفع.");
    if(!accountId)return toast.error("اختر الحساب المستقبِل.");
    let receiptImageData:string|undefined;
    let receiptImageMime:any;
    if(file){
      try {
        const prepared = await preparePaymentReceiptImage(file);
        receiptImageData = prepared.data;
        receiptImageMime = prepared.mime;
      } catch (error) {
        return toast.error(error instanceof Error ? error.message : "تعذر تجهيز صورة التحويل.");
      }
    }
    if (!isOnline) {
      if (!user?.id || !selectedAccount) return toast.error("لا تتوفر بيانات كافية لحفظ طلب التوثيق محلياً.");
      await enqueueOfflineWork({userId:user.id,siteId,kind:"payment_documentation_submit",payload:{subscriberId:Number(selected.id),invoiceId:Number(invoice.id),destinationAccountId:Number(accountId),paymentAmount:Number(amount),paymentMethod:method as any,senderPhone:senderPhone||undefined,referenceNo:referenceNo||undefined,receiptImageData,receiptImageMime,snapshot:{capturedAt:new Date().toISOString(),subscriber:{id:Number(selected.id),fullName:String(selected.full_name),subscriberNo:String(selected.subscriber_no),phone:String(selected.phone??""),whatsappNumber:selected.whatsapp_number??null,invoices:displayedSearch.find((x:any)=>Number(x.id)===Number(selected.id))?.invoices??[]},invoice:{id:Number(invoice.id),invoiceNo:String(invoice.invoice_no),billingPeriod:invoice.billing_period??null,previousReading:invoice.previous_reading===null?null:Number(invoice.previous_reading),currentReading:invoice.current_reading===null?null:Number(invoice.current_reading),consumptionKwh:Number(invoice.consumption_kwh??0),pricePerKwh:Number(invoice.price_per_kwh??0),consumptionValue:null,invoiceTotal:Number(invoice.total_amount??0),invoiceBalance:Number(invoice.balance_due??0),status:String(invoice.status??"unknown")},account:{id:Number(selectedAccount.id),name:String(selectedAccount.name),accountType:String(selectedAccount.accountType),phoneNumber:selectedAccount.phoneNumber??null}}}});toast.success("تم حفظ طلب توثيق الدفع محلياً. لن تُنشأ حركة مالية قبل مزامنته ثم اعتماده.");setInvoice(null);setSelected(null);setFile(null);setAmount("");setReferenceNo("");setSenderPhone("");setMethod("");setAccountId("");return;
    }
    submit.mutate({siteId: siteId ?? 0,subscriberId:Number(selected.id),invoiceId:Number(invoice.id),destinationAccountId:Number(accountId),paymentAmount:Number(amount),paymentMethod:method as any,senderPhone:senderPhone||undefined,referenceNo:referenceNo||undefined,receiptImageData,receiptImageMime});
  }

  return <DashboardLayout><div className="space-y-6 p-6" dir="rtl">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><h1 className="text-2xl font-black text-white">توثيق الدفع الإلكتروني</h1><p className="mt-1 text-sm text-slate-400">ابحث عن المشترك، اختر الفاتورة، ثم أرسل بيانات التحويل للتحقق قبل اعتماد الحركة المالية.</p></div><Badge className={isOnline?"bg-emerald-400/10 text-emerald-300":"bg-amber-400/10 text-amber-200"}>{isOnline?"متصل":"دون اتصال — النسخة المحلية"}</Badge></div>
    {user?.id&&siteId?<OfflineWorkSyncPanel siteId={siteId} userId={user.id} compact />:null}
    <Card className="border-white/10 bg-white/[.03]"><CardContent className="p-5">
      <Label className="text-slate-300">البحث عن مشترك</Label>
      <div className="mt-2 flex gap-2"><Input value={query} onChange={e=>setQuery(e.target.value)} placeholder="اسم المشترك أو رقمه" className="border-white/10 bg-white/[.03] text-white"/><Button onClick={()=>isOnline?void search.refetch():void loadOfflineSnapshots()}><Search className="ml-2 h-4 w-4"/>بحث</Button></div>
    </CardContent></Card>
    {search.isFetching&&<div className="flex justify-center"><Loader2 className="animate-spin text-slate-400"/></div>}
    {displayedSearch.map((sub:any)=><Card key={sub.id} className="border-white/10 bg-white/[.025]"><CardHeader><CardTitle className="text-white">{sub.full_name} <span className="text-sm text-slate-400">#{sub.subscriber_no}</span></CardTitle></CardHeader><CardContent className="space-y-3">
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
        <div><Label className="text-slate-300">الحساب المستقبِل</Label><select value={accountId} onChange={e=>setAccountId(e.target.value)} className="mt-2 h-10 w-full rounded-xl border border-white/10 bg-[#101722] px-3 text-sm text-white"><option value="">اختر الحساب</option>{displayedAccounts.filter((a:any)=>!method||a.accountType===method).map((a:any)=><option key={a.id} value={a.id}>{a.name}</option>)}</select>{selectedAccount&&<p className="mt-1 text-xs text-slate-500">{selectedAccount.accountType}</p>}</div>
        <div><Label className="text-slate-300">رقم الجوال المحوّل منه</Label><Input value={senderPhone} onChange={e=>setSenderPhone(e.target.value)} placeholder="اختياري" className="mt-2 bg-white/[.03] text-white"/></div>
        <div><Label className="text-slate-300">الرقم المرجعي للتحويل</Label><Input value={referenceNo} onChange={e=>setReferenceNo(e.target.value)} placeholder="اختياري" className="mt-2 bg-white/[.03] text-white"/></div>
        <div><Label className="text-slate-300">صورة التحويل</Label><Input type="file" accept="image/jpeg,image/png,image/webp" onChange={e=>setFile(e.target.files?.[0]??null)} className="mt-2 text-slate-300"/></div>
      </div>
      <div className="rounded-xl border border-white/10 bg-black/10 p-4 text-sm text-slate-400">سيتم حفظ بيانات الفاتورة والقراءات كنسخة توثيقية لحظة الإرسال، ولن تُحتسب الحركة المالية إلا بعد الاعتماد.</div>
      <Button disabled={submit.isPending} onClick={submitPayment}>{submit.isPending?<Loader2 className="animate-spin"/>:<Upload className="ml-2 h-4 w-4"/>}إرسال للتحقق</Button>
    </CardContent></Card>}
  </div></DashboardLayout>;
}
