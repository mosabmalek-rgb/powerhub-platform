import { PowerHubLogo } from "@/components/PowerHubLogo";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { copyTextSafely } from "@/lib/clipboard";
import { CreditCard, Download, FileText, Loader2, Share2 } from "lucide-react";
import { useRoute } from "wouter";
import { toast } from "sonner";

export default function PublicInvoice() {
  const [, params] = useRoute("/invoice/:token");
  const token = params?.token ?? "";
  const invoiceQuery = trpc.powerhub.invoices.publicByToken.useQuery({ token }, { enabled: token.length >= 16, retry: false });

  if (invoiceQuery.isLoading) {
    return <div className="grid min-h-screen place-items-center bg-[#0D1117]"><Loader2 className="h-8 w-8 animate-spin text-[#F5B800]" /></div>;
  }

  if (invoiceQuery.isError || !invoiceQuery.data) {
    return <div className="min-h-screen bg-[#0D1117] px-4 py-10" dir="ltr"><main dir="rtl" style={{ width: "100%", maxWidth: "576px", margin: "0 auto" }} className="rounded-[28px] border border-white/10 bg-[#111823] p-8 text-center shadow-2xl shadow-black/30"><PowerHubLogo className="justify-center" /><div className="mx-auto mt-8 grid h-14 w-14 place-items-center rounded-2xl bg-rose-400/10 text-rose-400"><FileText className="h-6 w-6" /></div><h1 className="mt-5 text-xl font-extrabold text-white">الرابط غير صالح أو منتهي</h1><p className="mt-3 leading-7 text-slate-400">تحقق من رابط الفاتورة، أو اطلب من مشغّل PowerHub إرسال رابط جديد.</p></main></div>;
  }

  const { invoice, subscriber, lines, paymentDocumentationAvailable } = invoiceQuery.data;
  const format = (value: unknown, digits = 2) => new Intl.NumberFormat("ar", { maximumFractionDigits: digits }).format(Number(value ?? 0));

  return (
    <div className="min-h-screen bg-[#0D1117] px-4 py-10" dir="ltr">
      <main dir="rtl" style={{ width: "100%", maxWidth: "768px", margin: "0 auto" }} className="overflow-hidden rounded-[28px] border border-white/10 bg-[#111823] shadow-2xl shadow-black/30">
        <header className="flex flex-col gap-6 border-b border-white/10 px-6 py-7 sm:flex-row sm:items-center sm:justify-between sm:px-10">
          <PowerHubLogo />
          <div className="text-right sm:text-left">
            <span className="inline-flex rounded-full bg-[#F5B800]/10 px-3 py-1 text-xs font-bold text-[#F5B800]">فاتورة قابلة للمشاركة</span>
            <p className="mt-2 text-sm text-slate-400">صفحة عامة آمنة — تُعرض بعد اعتماد الفاتورة</p>
          </div>
        </header>
        <section className="px-6 py-9 sm:px-10">
          <div className="mx-auto grid h-16 w-16 place-items-center rounded-2xl bg-[#F5B800]/10 text-[#F5B800]"><FileText className="h-7 w-7" /></div>
          <h1 className="mt-5 text-2xl font-extrabold text-white">فاتورة كهرباء</h1>
          <p className="mx-auto mt-2 max-w-md leading-7 text-slate-400">{subscriber?.fullName} · الفترة {invoice.billingPeriod}</p>
          <div className="mx-auto mt-8 grid max-w-xl gap-px overflow-hidden rounded-2xl border border-white/8 bg-white/8 sm:grid-cols-2">
            <div className="bg-[#111823] p-4 text-right"><p className="text-xs text-slate-500">رقم الفاتورة</p><p className="mt-2 font-display text-sm font-bold text-[#F5B800]" dir="ltr">{invoice.invoiceNo}</p></div>
            <div className="bg-[#111823] p-4 text-right"><p className="text-xs text-slate-500">حالة الفاتورة</p><p className="mt-2 text-sm font-bold text-white">{invoice.status === "paid" ? "مدفوعة" : invoice.status === "partially_paid" ? "مدفوعة جزئياً" : "مستحقة"}</p></div>
            <div className="bg-[#111823] p-4 text-right"><p className="text-xs text-slate-500">الاستهلاك</p><p className="mt-2 font-display text-xl font-extrabold text-white">{format(invoice.consumptionKwh, 3)} <span className="text-xs text-slate-500">kWh</span></p></div>
            <div className="bg-[#111823] p-4 text-right"><p className="text-xs text-slate-500">المتبقي للسداد</p><p className="mt-2 font-display text-xl font-extrabold text-[#F5B800]">{format(invoice.balanceDue)}</p></div>
          </div>
          <div className="mx-auto mt-5 max-w-xl overflow-hidden rounded-2xl border border-white/8 text-right">
            <div className="border-b border-white/8 bg-white/[0.025] px-4 py-3 text-sm font-bold text-white">بنود الفاتورة</div>
            {lines.map((line) => <div className="flex items-center justify-between border-b border-white/7 px-4 py-3 text-sm last:border-b-0" key={line.id}><span className="text-slate-400">{line.description}</span><span className="font-display font-bold text-white">{format(line.amount)}</span></div>)}
          </div>
          <div className="mt-9 grid gap-3 sm:grid-cols-2">
            {paymentDocumentationAvailable && Number(invoice.balanceDue) > 0 ? <Button className="bg-emerald-500 font-bold text-white hover:bg-emerald-400" onClick={() => { window.location.href = `/payment-documentation/public/${encodeURIComponent(token)}`; }}><CreditCard className="ml-2 h-4 w-4" />توثيق الدفع</Button> : <div className="rounded-xl border border-white/10 bg-white/[.02] px-4 py-3 text-center text-sm text-slate-500">توثيق الدفع الإلكتروني غير متاح لهذه الفاتورة حالياً.</div>}
            <Button className="bg-[#F5B800] font-bold text-[#0D1117] hover:bg-[#ffd23f]" onClick={async () => { const copied = await copyTextSafely(window.location.href); copied ? toast.success("تم نسخ رابط الفاتورة.") : toast.error("تعذر نسخ الرابط. انسخه يدوياً."); }}><Share2 className="ml-2 h-4 w-4" />نسخ رابط الفاتورة</Button>
            <Button variant="outline" className="border-white/15 text-white hover:bg-white/5 hover:text-white sm:col-span-2" onClick={() => window.print()}><Download className="ml-2 h-4 w-4" />طباعة الفاتورة</Button>
          </div>
        </section>
      </main>
    </div>
  );
}
