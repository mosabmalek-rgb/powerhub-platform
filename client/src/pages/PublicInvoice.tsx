import { PowerHubLogo } from "@/components/PowerHubLogo";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { copyTextSafely } from "@/lib/clipboard";
import { CheckCircle2, CreditCard, Download, FileText, Loader2, Share2 } from "lucide-react";
import { useRoute } from "wouter";
import { useEffect, useState } from "react";
import { toast } from "sonner";

export default function PublicInvoice() {
  const [, params] = useRoute("/invoice/:token");
  const token = params?.token ?? "";
  const [loadingTimedOut, setLoadingTimedOut] = useState(false);
  const invoiceQuery = trpc.powerhub.invoices.publicByToken.useQuery(
    { token },
    { enabled: token.length >= 16, retry: false, staleTime: 0 },
  );
  const paymentStatusQuery = trpc.powerhub.paymentDocumentation.publicStatus.useQuery(
    { token },
    { enabled: token.length >= 16, retry: false, staleTime: 0, refetchOnMount: "always" },
  );
  const [downloadingPdf, setDownloadingPdf] = useState(false);
  const [invoiceElement, setInvoiceElement] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (invoiceQuery.isSuccess || invoiceQuery.isError || !invoiceQuery.isFetching || token.length < 16) {
      setLoadingTimedOut(false);
      return;
    }
    // A manual retry after the fallback must start a fresh bounded wait.
    if (loadingTimedOut) return;
    const timeout = window.setTimeout(() => setLoadingTimedOut(true), 16_000);
    return () => window.clearTimeout(timeout);
  }, [invoiceQuery.isFetching, invoiceQuery.isSuccess, invoiceQuery.isError, token, loadingTimedOut]);

  // The invoice may be shown inside the billing dialog. A parent-ready handshake
  // lets the child resend its current state if the original status post arrived
  // before the parent's listener was mounted. Only same-origin parent messages
  // from window.parent are accepted; the invoice token is never included.
  useEffect(() => {
    if (window.parent === window) return;
    const currentStatus = (): "loaded" | "error" | null => {
      if (invoiceQuery.isSuccess && invoiceQuery.data) return "loaded";
      if (invoiceQuery.isError || loadingTimedOut || token.length < 16) return "error";
      return null;
    };
    const sendStatus = () => {
      const status = currentStatus();
      if (status) window.parent.postMessage({ type: "powerhub-public-invoice-status", status }, window.location.origin);
    };
    const handleParentReady = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== window.parent) return;
      if (event.data?.type !== "powerhub-public-invoice-parent-ready") return;
      sendStatus();
    };
    window.addEventListener("message", handleParentReady);
    sendStatus();
    return () => window.removeEventListener("message", handleParentReady);
  }, [invoiceQuery.isSuccess, invoiceQuery.isError, invoiceQuery.data, loadingTimedOut, token]);

  if (invoiceQuery.isLoading && !loadingTimedOut) {
    return <div className="grid min-h-screen place-items-center bg-[#0D1117]"><Loader2 className="h-8 w-8 animate-spin text-[#F5B800]" /><p className="mt-4 text-sm text-slate-400">جارٍ تحميل الفاتورة…</p></div>;
  }

  const errorMessage = String(invoiceQuery.error?.message ?? "");
  const linkIsInvalid = token.length < 16 || errorMessage.includes("رابط الفاتورة غير صالح أو منتهي");
  if (invoiceQuery.isError || !invoiceQuery.data || loadingTimedOut || linkIsInvalid) {
    const title = linkIsInvalid ? "الرابط غير صالح أو منتهي" : loadingTimedOut ? "تأخر تحميل الفاتورة" : "تعذر تحميل الفاتورة الآن";
    const description = linkIsInvalid
      ? "تحقق من رابط الفاتورة، أو اطلب من مشغّل PowerHub إرسال رابط جديد."
      : loadingTimedOut
        ? "استغرق تحميل الفاتورة وقتاً أطول من المعتاد. تحقق من الاتصال ثم أعد المحاولة."
        : "تعذر الاتصال بخدمة الفواتير مؤقتاً. يمكنك إعادة المحاولة دون الحاجة إلى طلب رابط جديد.";
    return <div className="min-h-screen bg-[#0D1117] px-4 py-10" dir="ltr"><main dir="rtl" style={{ width: "100%", maxWidth: "576px", margin: "0 auto" }} className="rounded-[28px] border border-white/10 bg-[#111823] p-8 text-center shadow-2xl shadow-black/30"><PowerHubLogo className="justify-center" /><div className="mx-auto mt-8 grid h-14 w-14 place-items-center rounded-2xl bg-rose-400/10 text-rose-400"><FileText className="h-6 w-6" /></div><h1 className="mt-5 text-xl font-extrabold text-white">{title}</h1><p className="mt-3 leading-7 text-slate-400">{description}</p>{!linkIsInvalid ? <Button className="mt-6 bg-[#F5B800] font-bold text-[#0D1117] hover:bg-[#ffd23f]" onClick={() => { setLoadingTimedOut(false); void invoiceQuery.refetch(); }}>إعادة المحاولة</Button> : null}</main></div>;
  }

  const { invoice, subscriber, lines, paymentDocumentationAvailable, companyName, companyLogoUrl } = invoiceQuery.data;
  const format = (value: unknown, digits = 2) => new Intl.NumberFormat("ar", { maximumFractionDigits: digits }).format(Number(value ?? 0));
  const visibleLines = lines.filter((line) => {
    const amount = Number(line.amount ?? 0);
    // Keep every line type consistent with two-decimal display precision.
    // Anything rendered as 0.00 is not a financial item to show.
    return Number.isFinite(amount) && Math.round(Math.abs(amount) * 100) > 0;
  });

  return (
    <div className="min-h-screen bg-[#0D1117] px-4 py-10" dir="ltr">
      <main ref={setInvoiceElement} dir="rtl" style={{ width: "100%", maxWidth: "768px", margin: "0 auto" }} className="overflow-hidden rounded-[28px] border border-white/10 bg-[#111823] shadow-2xl shadow-black/30">
        <header className="flex flex-col items-center gap-4 border-b border-white/10 px-6 py-7 text-center sm:px-10">
          {companyLogoUrl
            ? <img src={companyLogoUrl} alt={companyName ? `شعار ${companyName}` : "شعار الشركة"} className="h-[6.75rem] w-[21.6rem] max-w-full object-contain sm:h-[8.1rem] sm:w-[26.1rem]" />
            : <PowerHubLogo size="invoice" className="justify-center" />}
          <div className="w-full text-center">
            <h1 className="text-3xl font-black tracking-tight text-white sm:text-4xl">فاتورة كهرباء</h1>
            {companyName ? <p className="mt-2 text-base font-bold text-slate-200 sm:text-lg">{companyName}</p> : null}
            <p className="mt-3"><span className="inline-flex rounded-full bg-[#F5B800]/10 px-3 py-1 text-xs font-bold text-[#F5B800]">فاتورة قابلة للمشاركة</span></p>
            <p className="mt-2 text-sm text-slate-400">صفحة عامة آمنة — تُعرض بعد اعتماد الفاتورة</p>
            <p className="mt-4 text-[1.7rem] font-extrabold text-white/95">{subscriber?.fullName ?? "المشترك"}</p>
            <p className="mt-1 text-sm leading-6 text-slate-400">الفترة {invoice.billingPeriod}</p>
          </div>
        </header>
        <section className="px-6 py-9 sm:px-10">
          <div className="mx-auto grid max-w-3xl grid-cols-2 gap-px overflow-hidden rounded-2xl border border-white/8 bg-white/8 md:grid-cols-3">
            <div className="bg-[#111823] p-4 text-right"><p className="text-xs text-slate-500">رقم الفاتورة</p><p className="mt-2 break-words font-display text-sm font-bold text-[#F5B800]" dir="ltr">{invoice.invoiceNo}</p></div>
            <div className="bg-[#111823] p-4 text-right"><p className="text-xs text-slate-500">حالة الفاتورة</p><p className="mt-2 text-sm font-bold text-white">{invoice.status === "paid" ? "مدفوعة" : invoice.status === "partially_paid" ? "مدفوعة جزئياً" : invoice.status === "overdue" ? "متأخرة" : "مستحقة"}</p></div>
            <div className="bg-[#111823] p-4 text-right"><p className="text-xs text-slate-500">القراءة السابقة</p><p className="mt-2 font-display text-lg font-extrabold text-white">{invoice.previousReading === null || invoice.previousReading === undefined ? "—" : format(invoice.previousReading, 3)}</p></div>
            <div className="bg-[#111823] p-4 text-right"><p className="text-xs text-slate-500">القراءة الحالية</p><p className="mt-2 font-display text-lg font-extrabold text-white">{invoice.currentReading === null || invoice.currentReading === undefined ? "—" : format(invoice.currentReading, 3)}</p></div>
            <div className="bg-[#111823] p-4 text-right"><p className="text-xs text-slate-500">الاستهلاك</p><p className="mt-2 font-display text-xl font-extrabold text-white">{format(invoice.consumptionKwh, 3)} <span className="text-xs text-slate-500">kWh</span></p></div>
            <div className="bg-[#111823] p-4 text-right"><p className="text-xs text-slate-500">سعر الكيلوواط</p><p className="mt-2 font-display text-lg font-extrabold text-white">{format(invoice.pricePerKwh, 4)} <span className="text-xs font-medium text-slate-400">شيكل/kWh</span></p></div>
            <div className="bg-[#111823] p-4 text-right col-span-2 md:col-span-1"><p className="text-xs text-slate-500">المتبقي للسداد</p><p className="mt-2 font-display text-xl font-extrabold text-[#F5B800]">{format(invoice.balanceDue)} <span className="text-xs font-medium">شيكل</span></p></div>
          </div>
          <div className="mx-auto mt-5 max-w-3xl overflow-hidden rounded-2xl border border-white/8 text-right">
            <div className="border-b border-white/8 bg-white/[0.025] px-4 py-3 text-sm font-bold text-white">بنود الفاتورة</div>
            {visibleLines.map((line) => {
              const value = Number(line.amount ?? 0);
              const description = String(line.description ?? "").normalize("NFKD").replace(/\p{M}/gu, "");
              const isDiscount = line.lineType === "discount" || /خصم.{0,35}(?:كسر|كسور)|fraction[\s_-]*discount/i.test(description);
              const isFractionalCarry = /(?:كسر|كسور).{0,35}(?:مرحل|ترحيل)|(?:ترحيل|مرحل).{0,35}(?:كسر|كسور)|fraction[\s_-]*(?:carry|carried)/i.test(description);
              const displayedAmount = isDiscount ? -Math.abs(value) : value;
              const isCredit = isDiscount || isFractionalCarry || displayedAmount < 0;
              const amountText = new Intl.NumberFormat("ar", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(displayedAmount);
              return <div className={isFractionalCarry ? "flex items-start justify-between gap-4 border-b border-white/7 bg-emerald-500/5 px-4 py-3 text-sm last:border-b-0" : "flex items-start justify-between gap-4 border-b border-white/7 px-4 py-3 text-sm last:border-b-0"} key={line.id}>
                <span className={isCredit ? "text-emerald-300" : "text-slate-300"}>
                  {isFractionalCarry
                    ? <span className="inline-flex flex-col gap-0.5"><span className="font-bold">تسوية الكسر المرحّل</span><span className="text-xs text-emerald-200/80">{line.description || "كسر مُرحّل إلى الفاتورة التالية"}</span></span>
                    : line.description}
                </span>
                <span className={isCredit ? "shrink-0 font-display font-bold text-emerald-300" : "shrink-0 font-display font-bold text-white"} dir="ltr">{displayedAmount > 0 ? "+" : ""}{amountText} شيكل</span>
              </div>;
            })}
            {!visibleLines.length ? <p className="px-4 py-5 text-sm text-slate-400">لا توجد بنود مالية لعرضها.</p> : null}
          </div>
          <div data-html2canvas-ignore="true" className="mt-9 grid gap-3 sm:grid-cols-2">
            {paymentStatusQuery.isFetching || (!paymentStatusQuery.data && !paymentStatusQuery.isError) ? <Button disabled className="bg-white/5 font-bold text-slate-300"><Loader2 className="ml-2 h-4 w-4 animate-spin" />جارٍ التحقق من حالة التوثيق...</Button> : paymentStatusQuery.isError ? <Button variant="outline" className="border-rose-400/30 text-rose-200 hover:bg-rose-400/10" onClick={() => void paymentStatusQuery.refetch()}>تعذر التحقق من حالة التوثيق — أعد المحاولة</Button> : paymentStatusQuery.data?.hasPendingSubmission ? <Button disabled className="bg-amber-500/15 font-bold text-amber-200"><CheckCircle2 className="ml-2 h-4 w-4" />تم إرسال التوثيق — بانتظار المراجعة</Button> : paymentDocumentationAvailable && Number(invoice.balanceDue) > 0 && !["draft", "cancelled", "paid"].includes(String(invoice.status).toLowerCase()) ? <Button className="bg-emerald-500 font-bold text-white hover:bg-emerald-400" onClick={() => { window.location.href = `/payment-documentation/public/${encodeURIComponent(token)}`; }}><CreditCard className="ml-2 h-4 w-4" />توثيق الدفع</Button> : <div className="rounded-xl border border-white/10 bg-white/[.02] px-4 py-3 text-center text-sm text-slate-500">توثيق الدفع الإلكتروني غير متاح لهذه الفاتورة حالياً.</div>}
            <Button className="bg-[#F5B800] font-bold text-[#0D1117] hover:bg-[#ffd23f]" onClick={async () => { const copied = await copyTextSafely(window.location.href); copied ? toast.success("تم نسخ رابط الفاتورة.") : toast.error("تعذر نسخ الرابط. انسخه يدوياً."); }}><Share2 className="ml-2 h-4 w-4" />نسخ رابط الفاتورة</Button>
            <Button variant="outline" disabled={downloadingPdf || !invoiceElement} className="border-white/15 text-white hover:bg-white/5 hover:text-white" onClick={async () => { if (!invoiceElement) return; setDownloadingPdf(true); try { const { downloadReportHtmlAsPdf } = await import("@/lib/report-pdf"); await downloadReportHtmlAsPdf(invoiceElement, `فاتورة-${invoice.invoiceNo}.pdf`, { title: `فاتورة كهرباء - ${invoice.invoiceNo}` }); toast.success("تم تحميل الفاتورة بصيغة PDF."); } catch (error) { toast.error(error instanceof Error ? error.message : "تعذر تحميل الفاتورة PDF."); } finally { setDownloadingPdf(false); } }}><Download className="ml-2 h-4 w-4" />{downloadingPdf ? "جارٍ تجهيز PDF..." : "تحميل PDF"}</Button>
            <Button variant="outline" className="border-white/15 text-white hover:bg-white/5 hover:text-white" onClick={() => window.print()}><FileText className="ml-2 h-4 w-4" />طباعة الفاتورة</Button>
          </div>
        </section>
      </main>
    </div>
  );
}
