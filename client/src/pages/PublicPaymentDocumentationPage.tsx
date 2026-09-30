import { PowerHubLogo } from "@/components/PowerHubLogo";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trpc } from "@/lib/trpc";
import { Loader2, Upload, CheckCircle2, FileText } from "lucide-react";
import { useRoute } from "wouter";
import { useMemo, useState } from "react";
import { toast } from "sonner";

const methods = [
  ["cash","نقدي"],["jawwal_pay","جوال Pay"],["palpay","PalPay"],["bank_of_palestine","بنك فلسطين"],["wallet","محفظة"],["bank_transfer","تحويل بنكي"],["card","بطاقة"]
] as const;

export default function PublicPaymentDocumentationPage() {
  const [, params] = useRoute("/payment-documentation/public/:token");
  const token = params?.token ?? "";
  const [method,setMethod]=useState("");
  const [accountId,setAccountId]=useState("");
  const [amount,setAmount]=useState("");
  const [senderPhone,setSenderPhone]=useState("");
  const [referenceNo,setReferenceNo]=useState("");
  const [file,setFile]=useState<File|null>(null);
  const [submitted,setSubmitted]=useState(false);

  const context=trpc.powerhub.paymentDocumentation.publicContext.useQuery({token},{enabled:token.length>=16,retry:false});
  const accounts=context.data?.accounts ?? [];
  const selectedAccount=useMemo(()=>accounts.find((a:any)=>String(a.id)===accountId),[accounts,accountId]);
  const submit=trpc.powerhub.paymentDocumentation.publicSubmit.useMutation({
    onSuccess:()=>setSubmitted(true),
    onError:e=>toast.error(e.message)
  });

  const invoice=context.data?.invoice;
  const subscriber=context.data?.subscriber;
  const canPay=Boolean(context.data?.paymentDocumentationAvailable && invoice && Number(invoice.balanceDue)>0 && invoice.status!=="cancelled");

  async function send(){
    if(!invoice)return;
    if(!method)return toast.error("اختر طريقة الدفع.");
    if(!accountId)return toast.error("اختر الحساب المستقبِل.");
    if(!amount || Number(amount)<=0 || Number(amount)>Number(invoice.balanceDue)) return toast.error("أدخل مبلغاً ضمن الرصيد المستحق.");
    if(method!=="cash" && !senderPhone) return toast.error("أدخل رقم الجوال المحوّل منه.");
    if(method!=="cash" && !file) return toast.error("أرفق صورة التحويل.");

    let receiptImageData:string|undefined;
    let receiptImageMime:"image/jpeg"|"image/png"|"image/webp"|undefined;
    if(file){
      const dataUrl=await new Promise<string>((resolve,reject)=>{
        const reader=new FileReader(); reader.onload=()=>resolve(String(reader.result)); reader.onerror=reject; reader.readAsDataURL(file);
      });
      receiptImageData=dataUrl.split(",")[1] ?? "";
      receiptImageMime=(file.type as typeof receiptImageMime);
    }

    submit.mutate({
      token,
      destinationAccountId:Number(accountId),
      paymentAmount:Number(amount),
      paymentMethod:method as any,
      senderPhone:senderPhone||undefined,
      referenceNo:referenceNo||undefined,
      receiptImageData,
      receiptImageMime,
      clientOperationId:crypto.randomUUID()
    });
  }

  if(context.isLoading)return <div className="grid min-h-screen place-items-center bg-[#0D1117]"><Loader2 className="h-8 w-8 animate-spin text-[#F5B800]"/></div>;
  if(context.isError || !context.data)return <div className="grid min-h-screen place-items-center bg-[#0D1117] px-4" dir="rtl"><main className="w-full max-w-xl rounded-[28px] border border-white/10 bg-[#111823] p-8 text-center"><PowerHubLogo className="justify-center"/><h1 className="mt-6 text-xl font-extrabold text-white">الرابط غير صالح أو منتهي</h1><p className="mt-3 leading-7 text-slate-400">تعذر تجهيز نموذج توثيق الدفع من رابط الفاتورة.</p></main></div>;

  if(submitted)return <div className="min-h-screen bg-[#0D1117] px-4 py-10" dir="rtl"><main className="mx-auto max-w-xl rounded-[28px] border border-white/10 bg-[#111823] p-8 text-center shadow-2xl"><PowerHubLogo className="justify-center"/><div className="mx-auto mt-8 grid h-16 w-16 place-items-center rounded-2xl bg-emerald-400/10 text-emerald-300"><CheckCircle2 className="h-8 w-8"/></div><h1 className="mt-5 text-2xl font-extrabold text-white">تم إرسال طلب توثيق الدفع</h1><p className="mt-3 leading-7 text-slate-400">تم تسجيل الطلب للمراجعة. لن تُحتسب الحركة المالية إلا بعد اعتمادها من الجهة المخولة.</p><p className="mt-5 text-sm text-slate-500">الفاتورة: {invoice?.invoiceNo}</p></main></div>;

  return <div className="min-h-screen bg-[#0D1117] px-4 py-8" dir="rtl"><main className="mx-auto max-w-3xl overflow-hidden rounded-[28px] border border-white/10 bg-[#111823] shadow-2xl">
    <header className="border-b border-white/10 px-6 py-6 sm:px-9"><PowerHubLogo/><div className="mt-5 flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-2xl font-extrabold text-white">توثيق الدفع الإلكتروني</h1><p className="mt-1 text-sm text-slate-400">النموذج مرتبط برابط الفاتورة الموثوق.</p></div><Badge className="bg-[#F5B800]/10 text-[#F5B800]">دفع آمن</Badge></div></header>
    <section className="space-y-6 px-6 py-7 sm:px-9">
      {!canPay?<div className="rounded-2xl border border-amber-400/20 bg-amber-400/[.05] p-5 text-center text-amber-200">توثيق الدفع غير متاح لهذه الفاتورة حالياً.</div>:<>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-white/8 bg-white/[.02] p-4"><p className="text-xs text-slate-500">المشترك</p><p className="mt-2 font-bold text-white">{subscriber?.fullName}</p><p className="mt-1 text-xs text-slate-500">#{subscriber?.subscriberNo}</p></div>
        <div className="rounded-xl border border-white/8 bg-white/[.02] p-4"><p className="text-xs text-slate-500">الفاتورة</p><p className="mt-2 font-bold text-[#F5B800]">{invoice?.invoiceNo}</p></div>
        <div className="rounded-xl border border-white/8 bg-white/[.02] p-4"><p className="text-xs text-slate-500">الرصيد المستحق</p><p className="mt-2 text-xl font-extrabold text-[#F5B800]">{invoice?.balanceDue}</p></div>
      </div>
      <div className="rounded-2xl border border-[#F5B800]/20 bg-[#F5B800]/[.035] p-5"><div className="flex items-center gap-2 text-white"><FileText className="h-4 w-4 text-[#F5B800]"/>الفاتورة مهيأة تلقائياً</div><p className="mt-2 text-sm leading-6 text-slate-400">لا تحتاج إلى إدخال رقم الفاتورة أو المشترك؛ تم التحقق منهما من رابط المشاركة.</p></div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div><Label className="text-slate-300">مبلغ الدفع</Label><Input type="number" min="0.01" max={invoice?.balanceDue} value={amount||String(invoice?.balanceDue??"")} onChange={e=>setAmount(e.target.value)} className="mt-2 bg-white/[.03] text-white"/></div>
        <div><Label className="text-slate-300">طريقة الدفع</Label><select value={method} onChange={e=>{setMethod(e.target.value);setAccountId("");}} className="mt-2 h-10 w-full rounded-xl border border-white/10 bg-[#101722] px-3 text-sm text-white"><option value="">اختر طريقة الدفع</option>{methods.map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></div>
        <div><Label className="text-slate-300">الحساب المستقبِل</Label><select value={accountId} onChange={e=>setAccountId(e.target.value)} className="mt-2 h-10 w-full rounded-xl border border-white/10 bg-[#101722] px-3 text-sm text-white"><option value="">اختر الحساب</option>{accounts.filter((a:any)=>!method||a.accountType===method).map((a:any)=><option key={a.id} value={a.id}>{a.name}</option>)}</select>{selectedAccount&&<p className="mt-1 text-xs text-slate-500">{selectedAccount.accountType}</p>}</div>
        <div><Label className="text-slate-300">رقم الجوال المحوّل منه</Label><Input value={senderPhone} onChange={e=>setSenderPhone(e.target.value)} placeholder={method==="cash"?"غير مطلوب":"مطلوب للتحويل"} disabled={method==="cash"} className="mt-2 bg-white/[.03] text-white"/></div>
        <div><Label className="text-slate-300">الرقم المرجعي للتحويل</Label><Input value={referenceNo} onChange={e=>setReferenceNo(e.target.value)} placeholder="اختياري" className="mt-2 bg-white/[.03] text-white"/></div>
        <div><Label className="text-slate-300">صورة التحويل</Label><Input type="file" accept="image/jpeg,image/png,image/webp" disabled={method==="cash"} onChange={e=>setFile(e.target.files?.[0]??null)} className="mt-2 text-slate-300"/><p className="mt-1 text-xs text-slate-500">{method==="cash"?"غير مطلوبة للدفع النقدي":"مطلوبة لعمليات التحويل."}</p></div>
      </div>
      <Button disabled={submit.isPending} onClick={()=>void send()} className="w-full bg-[#F5B800] font-bold text-[#0D1117] hover:bg-[#ffd23f]">{submit.isPending?<Loader2 className="animate-spin"/>:<Upload className="ml-2 h-4 w-4"/>}إرسال للتحقق</Button>
      <p className="text-center text-xs leading-6 text-slate-500">لن يتم إنشاء حركة مالية أو خصم الرصيد عند إرسال الطلب. الاعتماد من الجهة المخولة هو المرحلة التي تُنشئ الحركة.</p>
      </>}
    </section>
  </main></div>;
}
