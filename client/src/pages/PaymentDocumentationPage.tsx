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
import { useRoute } from "wouter";
import { toast } from "sonner";

const methods = [
  ["cash","نقدي"],["jawwal_pay","جوال Pay"],["palpay","PalPay"],["bank_of_palestine","بنك فلسطين"],["wallet","محفظة"],["bank_transfer","تحويل بنكي"],["card","بطاقة"]
] as const;

const accountTypeLabels: Record<string, string> = {
  cash: "نقدي", jawwal_pay: "جوال Pay", palpay: "PalPay", bank_of_palestine: "بنك فلسطين",
  wallet: "محفظة", bank_transfer: "تحويل بنكي", card: "بطاقة", other: "أخرى",
};
function accountTypeLabel(value: unknown) { const key = String(value ?? ""); return accountTypeLabels[key] ?? (key || "غير محدد"); }
function formatPaymentDocumentationAmount(value: unknown) {
  return new Intl.NumberFormat("ar", { maximumFractionDigits: 2 }).format(Number(value ?? 0));
}

function InvoiceLineBreakdown({ lines }: { lines?: Array<{ id?: number; lineType?: string; description?: string; amount?: number | string }> }) {
  const items = lines ?? [];
  const visibleItems = items.filter((line) => {
    const amount = Number(line.amount ?? 0);
    const hasDisplayedAmount = Number.isFinite(amount) && Math.round(Math.abs(amount) * 100) > 0;
    if (!hasDisplayedAmount) return false;

    const description = String(line.description ?? "")
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .replace(/\s+/g, " ")
      .trim();
    const discount = line.lineType === "discount" || /خصم.{0,35}(?:كسر|كسور)|fraction[\s_-]*discount/i.test(description);
    return !discount || amount > 0;
  });

  return <section className="rounded-xl border border-white/10 bg-black/10 p-4" aria-label="تفاصيل الفاتورة وتسوياتها">
    <h3 className="font-bold text-white">تفاصيل الفاتورة وتسوياتها</h3>
    <p className="mt-1 text-xs text-slate-500">تظهر البنود ذات القيمة الفعلية فقط، بما فيها أثر خصم الكسر أو تسوية الكسر المرحّل.</p>
    {visibleItems.length ? <div className="mt-3 divide-y divide-white/5">
      {visibleItems.map((line, index) => {
        const value = Number(line.amount ?? 0);
        const description = String(line.description ?? "").normalize("NFKD").replace(/\p{M}/gu, "");
        const isDiscount = line.lineType === "discount" || /خصم.{0,35}(?:كسر|كسور)|fraction[\s_-]*discount/i.test(description);
        const isFractionalCarry = /(?:كسر|كسور).{0,35}(?:مرحل|ترحيل)|(?:ترحيل|مرحل).{0,35}(?:كسر|كسور)|fraction[\s_-]*(?:carry|carried)/i.test(description);
        const displayed = isDiscount ? -Math.abs(value) : value;
        const isCredit = isDiscount || isFractionalCarry || displayed < 0;
        const formattedAmount = new Intl.NumberFormat("ar", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(displayed);
        return <div key={line.id ?? index} className={isFractionalCarry ? "flex items-start justify-between gap-4 rounded-lg bg-emerald-500/5 px-2 py-2 text-sm" : "flex items-start justify-between gap-4 py-2 text-sm"}>
          <span className={isCredit ? "leading-6 text-emerald-300" : "leading-6 text-slate-300"}>
            {isFractionalCarry
              ? <span className="inline-flex flex-col gap-0.5"><span className="font-bold">تسوية الكسر المرحّل</span><span className="text-xs text-emerald-200/80">{line.description || "كسر مُرحّل إلى الفاتورة التالية"}</span></span>
              : line.description || "بند فاتورة"}
          </span>
          <span className={isCredit ? "shrink-0 font-bold text-emerald-300" : "shrink-0 font-bold text-white"} dir="ltr">{displayed > 0 ? "+" : ""}{formattedAmount} شيكل</span>
        </div>;
      })}
    </div> : <p className="mt-3 text-sm text-slate-500">لا توجد بنود مالية ذات قيمة لهذه الفاتورة.</p>}
  </section>;
}

export default function PaymentDocumentationPage() {
  const { branchId, setBranchId } = useBranchFilter();
  const { user } = useAuth();
  const siteId = branchId ?? 0;
  const [, publicInvoiceParams] = useRoute("/payment-documentation/public/:token");
  const queryInvoiceToken = typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("invoiceToken") ?? "";
  const invoiceToken = publicInvoiceParams?.token ?? queryInvoiceToken;
  const isPublicInvoiceFlow = Boolean(publicInvoiceParams?.token);
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
  const publicInvoice = trpc.powerhub.invoices.publicByToken.useQuery({ token: invoiceToken }, { enabled: Boolean(queryInvoiceToken && isOnline && !isPublicInvoiceFlow), retry: false, staleTime: 0, refetchOnMount: "always" });
  const publicPaymentContext = trpc.powerhub.paymentDocumentation.publicContext.useQuery({ token: invoiceToken }, { enabled: Boolean(isPublicInvoiceFlow && invoiceToken), retry: false, staleTime: 0, refetchOnMount: "always" });
  const utils = trpc.useUtils();
  const invalidatePaymentDocumentationReview = () => {
    void utils.powerhub.paymentDocumentation.list.invalidate().catch(() => undefined);
  };
  const publicSubmit = trpc.powerhub.paymentDocumentation.publicSubmit.useMutation({
    onSuccess: invalidatePaymentDocumentationReview,
    onError: (error) => toast.error(error.message),
  });
  const submit = trpc.powerhub.paymentDocumentation.submit.useMutation({
    onSuccess:()=>{invalidatePaymentDocumentationReview();toast.success("تم إرسال طلب الدفع بنجاح. سيتم التحقق لاعتماد الدفع. دمتم بخير 🌷");setInvoice(null);setFile(null);setAmount("");setReferenceNo("");setSenderPhone("");},
    onError:e=>toast.error(e.message)
  });

  useEffect(() => {
    const data = publicInvoice.data;
    if (isPublicInvoiceFlow || !data?.siteId || !invoiceToken) return;
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
  }, [invoiceToken, isPublicInvoiceFlow, publicInvoice.data, setBranchId]);

  const displayedSearch = isOnline ? (search.data ?? []) : offlineSearchData;
  const displayedAccounts = isOnline ? (accounts.data ?? []) : offlineAccounts;
  const selectedAccount = useMemo(()=>displayedAccounts.find((a:any)=>String(a.id)===accountId),[displayedAccounts,accountId]);
  const loadOfflineSnapshots = useCallback(async()=>{ if(!user?.id||!siteId)return; try{ const [subs,acs]=await Promise.all([searchPaymentDocumentationSnapshots({userId:user.id,siteId,query}),listPaymentDocumentationAccountSnapshots({userId:user.id,siteId})]); setOfflineSearchData(subs.map((sub:any)=>({ id:sub.id, full_name:sub.fullName, subscriber_no:sub.subscriberNo, phone:sub.phone, whatsapp_number:sub.whatsappNumber, invoices:(sub.invoices??[]).map((inv:any)=>({ id:inv.id, invoice_no:inv.invoiceNo, billing_period:inv.billingPeriod, previous_reading:inv.previousReading, current_reading:inv.currentReading, consumption_kwh:inv.consumptionKwh, price_per_kwh:inv.pricePerKwh, total_amount:inv.invoiceTotal, balance_due:inv.invoiceBalance, status:inv.status })) }))); setOfflineAccounts(acs); }catch{ toast.error("تعذر قراءة النسخة المحلية لتوثيق الدفع."); } },[query,siteId,user?.id]);
  useEffect(()=>{const on=()=>setIsOnline(true),off=()=>setIsOnline(false);window.addEventListener("online",on);window.addEventListener("offline",off);return()=>{window.removeEventListener("online",on);window.removeEventListener("offline",off);};},[]);
  useEffect(()=>{if(!isOnline&&query.trim().length>=2)void loadOfflineSnapshots();},[isOnline,query,loadOfflineSnapshots]);
  useEffect(()=>{if(!isOnline||!user?.id||!siteId||!search.data?.length)return;const accountsSnapshot=(accounts.data??[]).map((a:any)=>({id:Number(a.id),name:String(a.name),accountType:String(a.accountType),phoneNumber:a.phoneNumber??null}));for(const sub of search.data as any[]){void savePaymentDocumentationSnapshot({userId:user.id,siteId,subscriber:{id:Number(sub.id),fullName:String(sub.full_name),subscriberNo:String(sub.subscriber_no),phone:String(sub.phone??""),whatsappNumber:sub.whatsapp_number??null,invoices:(sub.invoices??[]).map((i:any)=>({id:Number(i.id),invoiceNo:String(i.invoice_no),billingPeriod:i.billing_period??null,previousReading:i.previous_reading===null?null:Number(i.previous_reading),currentReading:i.current_reading===null?null:Number(i.current_reading),consumptionKwh:Number(i.consumption_kwh??0),pricePerKwh:Number(i.price_per_kwh??0),consumptionValue:null,invoiceTotal:Number(i.total_amount??0),invoiceBalance:Number(i.balance_due??0),status:String(i.status??"unknown")}))},accounts:accountsSnapshot});}},[accounts.data,isOnline,search.data,siteId,user?.id]);

  if (isPublicInvoiceFlow) {
    return <PublicPaymentDocumentationView
      token={invoiceToken}
      loading={publicPaymentContext.isLoading}
      error={publicPaymentContext.isError ? publicPaymentContext.error?.message : null}
      context={publicPaymentContext.data}
      submit={publicSubmit}
    />;
  }

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
      <div className="grid gap-4 md:grid-cols-3 text-sm"><div><span className="text-slate-500">المشترك</span><p className="text-white">{selected.full_name}</p></div><div><span className="text-slate-500">الرقم</span><p className="text-white">{selected.subscriber_no}</p></div><div><span className="text-slate-500">الرصيد وقت الطلب</span><p className="text-amber-400 font-bold">{formatPaymentDocumentationAmount(invoice.balance_due)} شيكل</p></div></div>
      <InvoiceLineBreakdown lines={invoice.lines} />
      <div className="grid gap-4 md:grid-cols-2">
        <div><Label className="text-slate-300">مبلغ الدفع</Label><Input type="number" min="0.01" max={invoice.balance_due} value={amount} onChange={e=>setAmount(e.target.value)} className="mt-2 bg-white/[.03] text-white"/></div>
        <div><Label className="text-slate-300">الحساب المستقبِل</Label><select value={accountId} onChange={e=>setAccountId(e.target.value)} className="mt-2 h-10 w-full rounded-xl border border-white/10 bg-[#101722] px-3 text-sm text-white"><option value="">اختر الحساب المستقبِل</option>{displayedAccounts.filter((a:any)=>method==="cash"?a.accountType==="cash":method?a.accountType!=="cash":true).map((a:any)=><option key={a.id} value={a.id}>{a.name} — {accountTypeLabel(a.accountType)}{a.phoneNumber?` — ${a.phoneNumber}`:""}</option>)}</select>{selectedAccount&&<div className="mt-2 rounded-xl border border-white/10 bg-white/[.025] p-3 text-sm"><p className="font-semibold text-white">اسم الحساب: {selectedAccount.name}</p><p className="mt-1 text-slate-300">نوع الحساب المستقبِل: {accountTypeLabel(selectedAccount.accountType)}</p><p className="mt-1 text-slate-300">الرقم المرتبط بالحساب: {selectedAccount.phoneNumber || "لا يوجد رقم مسجل"}</p></div>}</div>
        <div><Label className="text-slate-300">طريقة/نوع حساب التحويل</Label><select value={method} onChange={e=>{const next=e.target.value;setMethod(next);const destination=displayedAccounts.find((a:any)=>String(a.id)===accountId);if(destination&&next&&((next==="cash"&&destination.accountType!=="cash")||(next!=="cash"&&destination.accountType==="cash")))setAccountId("");}} className="mt-2 h-10 w-full rounded-xl border border-white/10 bg-[#101722] px-3 text-sm text-white"><option value="">اختر طريقة الدفع</option>{methods.map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></div>
        <div><Label className="text-slate-300">رقم الجوال المحوّل منه</Label><Input value={senderPhone} onChange={e=>setSenderPhone(e.target.value)} placeholder="اختياري" className="mt-2 bg-white/[.03] text-white"/></div>
        <div><Label className="text-slate-300">الرقم المرجعي للتحويل</Label><Input value={referenceNo} onChange={e=>setReferenceNo(e.target.value)} placeholder="اختياري" className="mt-2 bg-white/[.03] text-white"/></div>
        <div><Label className="text-slate-300">صورة التحويل</Label><Input type="file" accept="image/jpeg,image/png,image/webp" onChange={e=>setFile(e.target.files?.[0]??null)} className="mt-2 text-slate-300"/></div>
      </div>
      <div className="rounded-xl border border-white/10 bg-black/10 p-4 text-sm text-slate-400">سيتم حفظ بيانات الفاتورة والقراءات كنسخة توثيقية لحظة الإرسال، ولن تُحتسب الحركة المالية إلا بعد الاعتماد.</div>
      <Button disabled={submit.isPending} onClick={submitPayment}>{submit.isPending?<Loader2 className="animate-spin"/>:<Upload className="ml-2 h-4 w-4"/>}إرسال للتحقق</Button>
    </CardContent></Card>}
  </div></DashboardLayout>;
}

function PublicPaymentDocumentationView({ token, loading, error, context, submit }: {
  token: string;
  loading: boolean;
  error: string | null;
  context: any;
  submit: { isPending: boolean; data?: unknown; mutate: (input: any) => void };
}) {
  const [method,setMethod]=useState("");
  const [accountId,setAccountId]=useState("");
  const [amount,setAmount]=useState("");
  const [senderPhone,setSenderPhone]=useState("");
  const [referenceNo,setReferenceNo]=useState("");
  const [file,setFile]=useState<File|null>(null);
  const [submitted,setSubmitted]=useState(false);

  useEffect(() => {
    if (context?.invoice?.balanceDue !== undefined) setAmount(String(context.invoice.balanceDue));
  }, [context?.invoice?.id, context?.invoice?.balanceDue]);
  useEffect(() => {
    if (submit.data) setSubmitted(true);
  }, [submit.data]);

  async function send() {
    if (!context?.invoice) return;
    if (!method) return toast.error("اختر طريقة الدفع.");
    if (!accountId) return toast.error("اختر الحساب المستقبِل.");
    if (!amount || Number(amount) <= 0 || Number(amount) > Number(context.invoice.balanceDue)) return toast.error("أدخل مبلغاً ضمن الرصيد المستحق.");
    if (method !== "cash" && !senderPhone) return toast.error("أدخل رقم الجوال المحوّل منه.");
    if (method !== "cash" && !file) return toast.error("أرفق صورة التحويل.");

    let receiptImageData:string|undefined;
    let receiptImageMime:"image/jpeg"|"image/png"|"image/webp"|undefined;
    if (file) {
      try {
        const prepared=await preparePaymentReceiptImage(file);
        receiptImageData=prepared.data;
        receiptImageMime=prepared.mime;
      } catch (error) {
        return toast.error(error instanceof Error ? error.message : "تعذر تجهيز صورة التحويل.");
      }
    }

    submit.mutate({
      token,
      destinationAccountId:Number(accountId),
      paymentAmount:Number(amount),
      paymentMethod:method,
      senderPhone:senderPhone||undefined,
      referenceNo:referenceNo||undefined,
      receiptImageData,
      receiptImageMime,
      clientOperationId:crypto.randomUUID()
    });
  }

  if (loading) return <div className="grid min-h-screen place-items-center bg-[#0D1117]"><Loader2 className="h-8 w-8 animate-spin text-[#F5B800]" /></div>;
  if (error || !context) return <div className="grid min-h-screen place-items-center bg-[#0D1117] px-4" dir="rtl"><main className="w-full max-w-xl rounded-[28px] border border-white/10 bg-[#111823] p-8 text-center"><Loader2 className="mx-auto h-7 w-7 text-rose-400" /><h1 className="mt-5 text-xl font-extrabold text-white">تعذر تجهيز توثيق الدفع</h1><p className="mt-3 leading-7 text-slate-400">{error || "رابط الفاتورة غير صالح أو منتهي."}</p></main></div>;

  const invoice=context.invoice;
  const subscriber=context.subscriber;
  const accounts=context.accounts ?? [];
  const selectedAccount = accounts.find((a:any)=>String(a.id)===accountId);
  const canPay=Boolean(context.paymentDocumentationAvailable && Number(invoice?.balanceDue)>0 && !["draft", "cancelled", "paid"].includes(String(invoice?.status ?? "").toLowerCase()));

  if (submitted) return <div className="min-h-screen bg-[#0D1117] px-4 py-10" dir="rtl"><main className="mx-auto max-w-xl rounded-[28px] border border-white/10 bg-[#111823] p-8 text-center shadow-2xl"><div className="mx-auto grid h-16 w-16 place-items-center rounded-2xl bg-emerald-400/10 text-emerald-300"><CheckCircle2 className="h-8 w-8" /></div><h1 className="mt-5 text-2xl font-extrabold text-white">تم إرسال طلب توثيق الدفع</h1><p className="mt-3 leading-7 text-slate-400">تم تسجيل الطلب للمراجعة، ولن تُحتسب الحركة المالية إلا بعد الاعتماد.</p><p className="mt-5 text-sm text-slate-500">الفاتورة: {invoice.invoiceNo}</p></main></div>;

  return <div className="min-h-screen bg-[#0D1117] px-4 py-8" dir="rtl"><main className="mx-auto max-w-3xl overflow-hidden rounded-[28px] border border-white/10 bg-[#111823] shadow-2xl">
    <header className="border-b border-white/10 px-6 py-6 sm:px-9"><div className="text-sm font-bold text-[#F5B800]">PowerHub</div><div className="mt-5 flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-2xl font-extrabold text-white">توثيق الدفع الإلكتروني</h1><p className="mt-1 text-sm text-slate-400">نفس نموذج توثيق الدفع؛ تم تحديد المشترك والفاتورة تلقائياً من رابط الفاتورة.</p></div><Badge className="bg-[#F5B800]/10 text-[#F5B800]">فاتورة محددة</Badge></div></header>
    <section className="space-y-6 px-6 py-7 sm:px-9">
      {!canPay ? <div className="rounded-2xl border border-amber-400/20 bg-amber-400/[.05] p-5 text-center text-amber-200">توثيق الدفع غير متاح لهذه الفاتورة حالياً.</div> : <>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-white/8 bg-white/[.02] p-4"><p className="text-xs text-slate-500">المشترك</p><p className="mt-2 font-bold text-white">{subscriber?.fullName}</p><p className="mt-1 text-xs text-slate-500">#{subscriber?.subscriberNo}</p></div>
          <div className="rounded-xl border border-white/8 bg-white/[.02] p-4"><p className="text-xs text-slate-500">الفاتورة</p><p className="mt-2 font-bold text-[#F5B800]">{invoice?.invoiceNo}</p></div>
          <div className="rounded-xl border border-white/8 bg-white/[.02] p-4"><p className="text-xs text-slate-500">الرصيد المستحق</p><p className="mt-2 text-xl font-extrabold text-[#F5B800]">{formatPaymentDocumentationAmount(invoice?.balanceDue)} شيكل</p></div>
        </div>
        <InvoiceLineBreakdown lines={context.lines} />
        <div className="grid gap-4 md:grid-cols-2">
          <div><Label className="text-slate-300">مبلغ الدفع</Label><Input type="number" min="0.01" max={invoice?.balanceDue} value={amount} onChange={e=>setAmount(e.target.value)} className="mt-2 bg-white/[.03] text-white"/></div>
          <div><Label className="text-slate-300">الحساب المستقبِل</Label><select value={accountId} onChange={e=>setAccountId(e.target.value)} className="mt-2 h-10 w-full rounded-xl border border-white/10 bg-[#101722] px-3 text-sm text-white"><option value="">اختر الحساب المستقبِل</option>{accounts.filter((a:any)=>method==="cash"?a.accountType==="cash":method?a.accountType!=="cash":true).map((a:any)=><option key={a.id} value={a.id}>{a.name} — {accountTypeLabel(a.accountType)}{a.phoneNumber?` — ${a.phoneNumber}`:""}</option>)}</select>{selectedAccount&&<div className="mt-2 rounded-xl border border-white/10 bg-white/[.025] p-3 text-sm"><p className="font-semibold text-white">اسم الحساب: {selectedAccount.name}</p><p className="mt-1 text-slate-300">نوع الحساب المستقبِل: {accountTypeLabel(selectedAccount.accountType)}</p><p className="mt-1 text-slate-300">الرقم المرتبط بالحساب: {selectedAccount.phoneNumber || "لا يوجد رقم مسجل"}</p></div>}</div>
          <div><Label className="text-slate-300">طريقة/نوع حساب التحويل</Label><select value={method} onChange={e=>{const next=e.target.value;setMethod(next);const destination=accounts.find((a:any)=>String(a.id)===accountId);if(destination&&next&&((next==="cash"&&destination.accountType!=="cash")||(next!=="cash"&&destination.accountType==="cash")))setAccountId("");}} className="mt-2 h-10 w-full rounded-xl border border-white/10 bg-[#101722] px-3 text-sm text-white"><option value="">اختر طريقة الدفع</option>{methods.map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></div>
          <div><Label className="text-slate-300">رقم الجوال المحوّل منه</Label><Input value={senderPhone} onChange={e=>setSenderPhone(e.target.value)} disabled={method==="cash"} placeholder={method==="cash"?"غير مطلوب":"مطلوب للتحويل"} className="mt-2 bg-white/[.03] text-white"/></div>
          <div><Label className="text-slate-300">الرقم المرجعي للتحويل</Label><Input value={referenceNo} onChange={e=>setReferenceNo(e.target.value)} placeholder="اختياري" className="mt-2 bg-white/[.03] text-white"/></div>
          <div><Label className="text-slate-300">صورة التحويل</Label><Input type="file" accept="image/jpeg,image/png,image/webp" disabled={method==="cash"} onChange={e=>setFile(e.target.files?.[0]??null)} className="mt-2 text-slate-300"/><p className="mt-1 text-xs text-slate-500">{method==="cash"?"غير مطلوبة للدفع النقدي":"مطلوبة لعمليات التحويل."}</p></div>
        </div>
        <Button disabled={submit.isPending} onClick={()=>void send()} className="w-full bg-[#F5B800] font-bold text-[#0D1117] hover:bg-[#ffd23f]">{submit.isPending?<Loader2 className="animate-spin"/>:<Upload className="ml-2 h-4 w-4"/>}إرسال للتحقق</Button>
      </>}
    </section>
  </main></div>;
}
