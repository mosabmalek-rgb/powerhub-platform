import { useAuth } from "@/_core/hooks/useAuth";
import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { startLogin } from "@/const";
import { trpc } from "@/lib/trpc";
import { can } from "@shared/powerhub-rbac";
import { segmentArabicSms } from "@shared/sms-segmentation";
import { MESSAGE_SCHEDULE_TIME_ZONE, buildMonthlyScheduleAnchor, buildWeeklyScheduleAnchor } from "@/lib/messaging-schedule";
import { formatDateTimeLocalInTimeZone, parseDateTimeLocalInTimeZone } from "@/lib/zoned-date-time";
import { formatPreviewAmount, previewMessageTemplate } from "@/lib/message-template-preview";
import { BellRing, CircleAlert, Eye, FileText, KeyRound, Loader2, LockKeyhole, MessageSquareText, RotateCcw, ShieldCheck, WalletCards } from "lucide-react";
import React, { FormEvent, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";

type Channel = "whatsapp" | "sms";

const inputClass = "h-10 w-full rounded-xl border border-white/10 bg-white/[0.025] px-3 text-sm text-white outline-none transition focus:border-[#F5B800]/70 focus:ring-2 focus:ring-[#F5B800]/15";
const defaultTemplates: Record<Channel, string> = {
  whatsapp: "مرحباً {{subscriber_name}}، صدرت فاتورتك رقم {{invoice_no}} عن فترة {{billing_period}} بإجمالي {{total_amount}}. تاريخ الاستحقاق: {{due_date}}.",
  sms: "PowerHub: {{subscriber_name}}، فاتورتك {{invoice_no}} للفترة {{billing_period}} بقيمة {{total_amount}}. الاستحقاق: {{due_date}}.",
};
const messageVariableOptions = [
  { token: "{{subscriber_name}}", label: "اسم المشترك", description: "اسم صاحب الاشتراك" },
  { token: "{{subscriber_no}}", label: "الرقم المرجعي", description: "الرقم المرجعي للمشترك" },
  { token: "{{invoice_no}}", label: "رقم الفاتورة", description: "رقم الفاتورة الصادرة" },
  { token: "{{billing_period}}", label: "فترة الفوترة", description: "الفترة التي تخصها الفاتورة" },
  { token: "{{total_amount}}", label: "قيمة الفاتورة", description: "إجمالي قيمة الفاتورة" },
  { token: "{{balance_due}}", label: "الرصيد المتبقي", description: "المبلغ المتبقي المطلوب سداده" },
  { token: "{{previous_reading}}", label: "القراءة السابقة", description: "قراءة العداد السابقة لهذه الفاتورة" },
  { token: "{{current_reading}}", label: "القراءة الحالية", description: "قراءة العداد الحالية لهذه الفاتورة" },
  { token: "{{consumption_kwh}}", label: "الاستهلاك (ك.و.س)", description: "كمية الاستهلاك المسجلة لهذه الفاتورة" },
  { token: "{{total_balance}}", label: "الرصيد الإجمالي للمشترك", description: "مجموع المستحقات غير المسددة على المشترك في هذا الفرع، شاملاً الفاتورة الحالية إن كانت مستحقة" },
  { token: "{{due_date}}", label: "تاريخ الاستحقاق", description: "آخر موعد للسداد" },
  { token: "{{invoice_link}}", label: "رابط الفاتورة", description: "رابط مباشر للفواتير" },
  { token: "{{portal_link}}", label: "رابط بوابة المشترك", description: "رابط بوابة المشترك للاستعلام والمتابعة" },
] as const;
const variableLabels = messageVariableOptions.map((item) => item.token);
const variableButtonLabels: Record<string, string> = Object.fromEntries(messageVariableOptions.map((item) => [item.token, item.label]));
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="block"><span className="mb-2 block text-xs font-bold text-slate-400">{label}</span>{children}</label>; }

function UnifiedMessageHistoryPanel({ siteId }: { siteId: number }) {
  const unifiedMessaging = (trpc.powerhub as typeof trpc.powerhub & { unifiedMessaging?: unknown }).unifiedMessaging;
  if (!unifiedMessaging) return null;
  return <UnifiedMessageHistory siteId={siteId} />;
}

function UnifiedMessageHistory({ siteId }: { siteId: number }) {
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [period, setPeriod] = useState<"cycle" | "today" | "custom">("cycle");
  const [startDate, setStartDate] = useState(() => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Gaza", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()));
  const [endDate, setEndDate] = useState(() => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Gaza", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()));
  const [type, setType] = useState<"all" | "invoice_issued" | "payment_reminder" | "payment_received" | "subscriber_reference" | "service_alert" | "manual" | "automatic">("all");
  const [channel, setChannel] = useState<"all" | "sms" | "whatsapp">("all");
  const [status, setStatus] = useState<"all" | "pending" | "processing" | "submitted" | "delivered" | "read" | "failed" | "needs_review">("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const history = trpc.powerhub.unifiedMessaging.history.useQuery({
    siteId, period, startDate: period === "custom" ? startDate : undefined,
    endDate: period === "custom" ? endDate : undefined, type, channel, status,
    search: search.trim() || undefined, limit: 50, offset: page * 50,
  }, { refetchInterval: 15000 });
  const retryInvoice = trpc.powerhub.notifications.retryFailedInvoiceNotification.useMutation({
    onSuccess: async () => { await history.refetch(); toast.success("تمت إعادة معالجة طلب رسالة الفاتورة."); },
    onError: (error) => toast.error(error.message),
  });
  const retryReceipt = trpc.powerhub.notifications.retryPaymentReceipt.useMutation({
    onSuccess: async () => { await history.refetch(); toast.success("تمت إعادة معالجة طلب إيصال الدفع."); },
    onError: (error) => toast.error(error.message),
  });
  const retryGeneral = trpc.powerhub.notifications.retry.useMutation({
    onSuccess: async () => { await history.refetch(); toast.success("تمت إعادة معالجة الرسالة."); },
    onError: (error) => toast.error(error.message),
  });
  const retrySmsBatch = trpc.powerhub.notifications.retryFailedSmsBatch.useMutation({
    onSuccess: async (result) => {
      await history.refetch();
      const message = "نتيجة إعادة المحاولة: " + result.submitted + " أُرسلت إلى المزود، " + result.failed + " فاشلة، " + result.skipped + " متجاوزة" + (result.needsReview ? "، " + result.needsReview + " تحتاج مراجعة" : "") + ".";
      if (result.failed > 0 || result.needsReview > 0) toast.warning(message); else toast.success(message);
    },
    onError: (error) => toast.error(error.message),
  });
  const resolveReview = trpc.powerhub.notifications.resolveSmsNeedsReview.useMutation({
    onSuccess: async () => { await history.refetch(); toast.success("تم تثبيت نتيجة مراجعة الرسالة."); },
    onError: (error) => toast.error(error.message),
  });
  useEffect(() => { setPage(0); }, [period, startDate, endDate, type, channel, status, search]);
  const data: any = history.data;
  const rows: any[] = Array.isArray(data?.items) ? data.items : [];
  const stats: any = data?.stats ?? {};
  const busy = retryInvoice.isPending || retryReceipt.isPending || retryGeneral.isPending || retrySmsBatch.isPending || resolveReview.isPending;
  const retry = (row: any) => {
    if (row.status !== "failed") return;
    if (row.eventType === "invoice_issued" && row.invoiceId) retryInvoice.mutate({ siteId, notificationId: Number(row.id) });
    else if (row.eventType === "payment_received") retryReceipt.mutate({ siteId, notificationId: Number(row.id) });
    else if (row.channel === "sms") retrySmsBatch.mutate({ siteId, notificationIds: [Number(row.id)] });
    else retryGeneral.mutate({ siteId, notificationId: Number(row.id) });
  };
  const statusClass = (value: string) => ["submitted", "delivered", "read"].includes(value)
    ? "bg-emerald-400/10 text-emerald-300"
    : value === "failed" ? "bg-rose-400/10 text-rose-300"
    : value === "needs_review" ? "bg-amber-400/10 text-amber-200"
    : "bg-sky-400/10 text-sky-200";
  const eventLabel = (value: string) => ({
    invoice_issued: "فاتورة", payment_reminder: "تذكير بالسداد", payment_received: "إيصال دفع",
    subscriber_reference: "ترحيب / رقم مرجعي", subscriber_created: "ترحيب / رقم مرجعي",
    service_alert: "تنبيه تشغيلي", manual: "رسالة يدوية",
  } as Record<string, string>)[value] ?? value;
  const sourceLabel = (row: any) => row.source === "manual" ? "حملة يدوية" : row.source === "automatic" ? "أتمتة" : "مسار سابق";
  const statusLabel = (value: string, channel: string) => {
    // TweetSMS does not provide a verified delivery/read receipt. Legacy statuses
    // must not be presented as proof of delivery for SMS messages.
    if (channel === "sms" && ["submitted", "delivered", "read"].includes(value)) return "مرسلة للمزود";
    return ({
      pending: "بانتظار المعالجة", processing: "قيد المعالجة", submitted: "قبلها مزود الرسائل",
      delivered: "تم التسليم", read: "تمت القراءة", failed: "فشلت", needs_review: "تحتاج مراجعة",
    } as Record<string, string>)[value] ?? value;
  };
  const refresh = async () => { await history.refetch(); };
  const totalPages = Math.max(1, Math.ceil(Number(data?.total ?? 0) / 50));
  const validCustomRange = period !== "custom" || Boolean(startDate && endDate && startDate <= endDate);

  return <section className="space-y-4">
    <Card className="border-sky-400/15 bg-[#111823] shadow-panel">
      <CardContent className="space-y-4 p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-2"><MessageSquareText className="h-5 w-5 text-[#F5B800]" /><h2 className="font-bold text-white">سجل الرسائل الموحد</h2></div>
            <p className="mt-1 text-sm leading-6 text-slate-400">كل رسالة محفوظة تظهر مرة واحدة، مع ربطها بحملتها أو فاتورتها أو إيصالها أو الأتمتة التي أنشأتها. القبول لدى المزود لا يعني بالضرورة التسليم النهائي.</p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={refresh} disabled={history.isFetching}><RotateCcw className={"ml-2 h-4 w-4 " + (history.isFetching ? "animate-spin" : "")} />تحديث السجل</Button>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-xl border border-white/8 bg-white/[.025] p-3"><p className="text-xs text-slate-400">إجمالي الرسائل حسب الفلاتر</p><p className="mt-1 text-2xl font-bold text-white">{stats.total ?? 0}</p></div>
          <div className="rounded-xl border border-emerald-400/15 bg-emerald-400/[.025] p-3"><p className="text-xs text-slate-400">قبلها مزود الرسائل</p><p className="mt-1 text-2xl font-bold text-emerald-300">{stats.submitted ?? 0}</p></div>
          <div className="rounded-xl border border-rose-400/15 bg-rose-400/[.025] p-3"><p className="text-xs text-slate-400">فاشلة</p><p className="mt-1 text-2xl font-bold text-rose-300">{stats.failed ?? 0}</p></div>
          <div className="rounded-xl border border-amber-400/15 bg-amber-400/[.025] p-3"><p className="text-xs text-slate-400">تحتاج مراجعة</p><p className="mt-1 text-2xl font-bold text-amber-200">{stats.needsReview ?? 0}</p></div>
        </div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
          <label className="block"><span className="mb-1 block text-xs font-bold text-slate-400">الفترة الزمنية</span><select value={period} onChange={(e) => { setPeriod(e.target.value as typeof period); setPage(0); }} className={inputClass}><option value="cycle">هذه الدورة</option><option value="today">اليوم</option><option value="custom">مخصص: بداية ونهاية</option></select></label>
          {period === "custom" ? <>
            <label className="block"><span className="mb-1 block text-xs font-bold text-slate-400">من تاريخ</span><input type="date" value={startDate} max={endDate || undefined} onChange={(e) => { setStartDate(e.target.value); setPage(0); }} className={inputClass} /></label>
            <label className="block"><span className="mb-1 block text-xs font-bold text-slate-400">إلى تاريخ (شامل)</span><input type="date" value={endDate} min={startDate || undefined} onChange={(e) => { setEndDate(e.target.value); setPage(0); }} className={inputClass} /></label>
          </> : null}
          <label className="block"><span className="mb-1 block text-xs font-bold text-slate-400">نوع الرسالة</span><select value={type} onChange={(e) => { setType(e.target.value as typeof type); setPage(0); }} className={inputClass}>
            <option value="all">جميع الأنواع</option><option value="invoice_issued">الفواتير</option><option value="payment_reminder">تذكير بالسداد</option><option value="payment_received">إيصالات الدفع</option><option value="subscriber_reference">الترحيب / الرقم المرجعي</option><option value="service_alert">التنبيهات التشغيلية</option><option value="manual">الحملات اليدوية</option><option value="automatic">الرسائل الآلية والمجدولة</option>
          </select></label>
          <label className="block"><span className="mb-1 block text-xs font-bold text-slate-400">القناة</span><select value={channel} onChange={(e) => { setChannel(e.target.value as typeof channel); setPage(0); }} className={inputClass}><option value="all">كل القنوات</option><option value="sms">SMS</option><option value="whatsapp">WhatsApp</option></select></label>
          <label className="block"><span className="mb-1 block text-xs font-bold text-slate-400">حالة الرسالة</span><select value={status} onChange={(e) => { setStatus(e.target.value as typeof status); setPage(0); }} className={inputClass}>
            <option value="all">كل الحالات</option><option value="pending">بانتظار المعالجة</option><option value="processing">قيد المعالجة</option><option value="submitted">مرسلة للمزود</option><option value="failed">فاشلة</option><option value="needs_review">تحتاج مراجعة</option>
          </select></label>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input type="search" value={search} onChange={(e) => { setSearch(e.target.value); setPage(0); }} placeholder="بحث باسم المشترك أو الهاتف أو الفاتورة أو الحملة أو نص الرسالة" className={inputClass} />
          <Button type="button" variant="outline" onClick={() => { setPeriod("cycle"); setType("all"); setChannel("all"); setStatus("all"); setSearch(""); setPage(0); }}>إعادة ضبط الفلاتر</Button>
        </div>
        {!validCustomRange ? <p role="alert" className="text-sm text-rose-200">تحقق من تاريخ البداية والنهاية؛ تاريخ النهاية يجب ألا يسبق البداية.</p> : null}
        {data?.periodStart && data?.periodEndExclusive ? <p className="text-xs text-slate-500">الفترة الفعلية: {new Date(data.periodStart).toLocaleDateString("ar-PS", { timeZone: data.timezone || "Asia/Gaza" })} – {new Date(new Date(data.periodEndExclusive).getTime() - 1).toLocaleDateString("ar-PS", { timeZone: data.timezone || "Asia/Gaza" })} · المنطقة الزمنية {data.timezone || "Asia/Gaza"}</p> : null}
        {history.isError ? <p role="alert" className="rounded-lg border border-rose-400/20 p-3 text-sm text-rose-200">تعذر تحميل السجل الموحد. راجع صلاحية الحساب ثم أعد التحديث.</p> : null}
        {history.isLoading ? <p className="py-8 text-center text-sm text-slate-400">جارٍ تحميل الرسائل...</p> : !rows.length ? <p className="rounded-xl border border-white/8 p-8 text-center text-sm text-slate-400">{validCustomRange ? "لا توجد رسائل تطابق الفترة والفلاتر المحددة لهذا الفرع." : "أدخل نطاقاً زمنياً صحيحاً لعرض الرسائل."}</p> :
          <div className="overflow-x-auto rounded-xl border border-white/8">
            <table className="w-full min-w-[1120px] text-right text-sm">
              <thead className="border-b border-white/8 bg-white/[.025] text-xs text-slate-400"><tr><th className="px-3 py-3">وقت الإنشاء</th><th className="px-3 py-3">المشترك / الرقم</th><th className="px-3 py-3">النوع والمصدر</th><th className="px-3 py-3">الفاتورة / الحملة</th><th className="px-3 py-3">القناة</th><th className="px-3 py-3">الحالة</th><th className="px-3 py-3">المحاولات</th><th className="px-3 py-3">التفاصيل</th><th className="px-3 py-3">الإجراء</th></tr></thead>
              <tbody>{rows.map((row: any) => <React.Fragment key={row.id}>
                <tr className="border-b border-white/5 align-top">
                  <td className="whitespace-nowrap px-3 py-3 text-slate-400">{row.createdAt ? new Date(row.createdAt).toLocaleString("ar-PS", { timeZone: data?.timezone || "Asia/Gaza" }) : "—"}</td>
                  <td className="px-3 py-3"><div className="font-medium text-white">{row.subscriberName || "مشترك غير محدد"}</div><div className="text-xs text-slate-500">{row.subscriberNo || "—"}</div><div className="mt-1 text-xs text-slate-400" dir="ltr">{row.recipient || "—"}</div></td>
                  <td className="px-3 py-3"><div className="font-medium text-slate-200">{eventLabel(row.eventType)}</div><div className="mt-1 text-xs text-slate-500">{sourceLabel(row)}</div></td>
                  <td className="px-3 py-3"><div className="text-slate-200">{row.invoiceNo ? row.invoiceNo : "—"}</div>{row.campaignId ? <div className="mt-1 text-xs text-sky-200">{row.campaignLabel}</div> : null}{row.automationName ? <div className="mt-1 text-xs text-slate-500">{row.automationName}</div> : null}</td>
                  <td className="px-3 py-3 text-slate-300">{row.channel === "whatsapp" ? "WhatsApp" : "SMS"}</td>
                  <td className="px-3 py-3"><Badge className={statusClass(row.status)}>{statusLabel(row.status, row.channel)}</Badge>{row.lastError ? <p className="mt-1 max-w-48 text-xs leading-5 text-rose-200">{row.lastError}</p> : null}</td>
                  <td className="px-3 py-3 text-slate-300">{row.attempts ?? 0}</td>
                  <td className="px-3 py-3"><Button type="button" size="sm" variant="outline" onClick={() => setExpandedId((current) => current === Number(row.id) ? null : Number(row.id))}>{expandedId === Number(row.id) ? "إخفاء" : "عرض النص"}</Button></td>
                  <td className="px-3 py-3">{row.status === "failed" ? <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => retry(row)}><RotateCcw className="ml-1 h-3.5 w-3.5" />إعادة المحاولة</Button> : row.status === "needs_review" ? <div className="flex min-w-48 flex-wrap gap-1"><Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => resolveReview.mutate({ siteId, notificationId: Number(row.id), resolution: "submitted" })}>اعتماد الإرسال</Button><Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => resolveReview.mutate({ siteId, notificationId: Number(row.id), resolution: "failed", reason: "تمت المراجعة من سجل الرسائل الموحد." })}>تأكيد الفشل</Button></div> : <span className="text-xs text-slate-600">—</span>}</td>
                </tr>
                {expandedId === Number(row.id) ? <tr className="border-b border-white/8 bg-white/[.018]"><td colSpan={9} className="px-4 py-4"><div className="grid gap-3 md:grid-cols-2"><div><p className="text-xs font-bold text-slate-400">نص الرسالة المسجل</p><p className="mt-2 whitespace-pre-wrap break-words rounded-lg border border-white/8 p-3 text-sm text-slate-200">{row.messageText || "لا يتوفر نص الرسالة في سجل المصدر."}</p></div><div className="space-y-2 text-xs text-slate-400"><p>معرّف الرسالة: <span className="text-slate-200">{row.id}</span></p><p>معرّف المزود: <span className="break-all text-slate-200">{row.providerMessageId || "غير متوفر"}</span></p><p>آخر تحديث: <span className="text-slate-200">{row.updatedAt ? new Date(row.updatedAt).toLocaleString("ar-PS", { timeZone: data?.timezone || "Asia/Gaza" }) : "—"}</span></p><p>نوع الجدولة: <span className="text-slate-200">{row.scheduleType || "غير محدد"}</span></p><p>العملية المرجعية: <span className="break-all text-slate-200">{row.operationKey || "—"}</span></p></div></div></td></tr> : null}
              </React.Fragment>)}</tbody>
            </table>
          </div>}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><p className="text-xs text-slate-500">الصفحة {page + 1} من {totalPages} · {data?.campaignCount ?? 0} حملة ممثلة ضمن النتائج · التحديث كل 15 ثانية</p><div className="flex gap-2"><Button type="button" variant="outline" size="sm" disabled={page <= 0 || history.isFetching} onClick={() => setPage((current) => Math.max(0, current - 1))}>السابق</Button><Button type="button" variant="outline" size="sm" disabled={page + 1 >= totalPages || history.isFetching} onClick={() => setPage((current) => current + 1)}>التالي</Button></div></div>
      </CardContent>
    </Card>
  </section>;
}


function UnifiedMessagingPanel({ siteId }: { siteId: number }) {
  const unifiedMessaging = (trpc.powerhub as typeof trpc.powerhub & { unifiedMessaging?: unknown }).unifiedMessaging;
  if (!unifiedMessaging) return null;
  return <UnifiedMessagingPanelContent siteId={siteId} />;
}

function UnifiedMessagingPanelContent({ siteId }: { siteId: number }) {
  const utils = trpc.useUtils();
  const billingPolicy = trpc.powerhub.siteBillingPolicy.get.useQuery({ siteId });
  const settlementDisplayEnabled = Boolean(billingPolicy.data?.automaticFractionDiscountEnabled || billingPolicy.data?.fractionCarryEnabled);
  const templates = trpc.powerhub.unifiedMessaging.templates.useQuery({ siteId });
  const connectionReadiness = trpc.powerhub.unifiedMessaging.connectionReadiness.useQuery({ siteId }, { refetchInterval: 30000 });
  const automations = trpc.powerhub.unifiedMessaging.automations.useQuery({ siteId });
  const subscribers = trpc.powerhub.subscribers.list.useQuery({ siteId });
  const saveTemplate = trpc.powerhub.unifiedMessaging.saveTemplate.useMutation({
    onSuccess: async () => { await templates.refetch(); toast.success("تم حفظ القالب الموحد وربطه بالمصدر التشغيلي."); },
    onError: (e) => toast.error(e.message),
  });
  const saveAutomation = trpc.powerhub.unifiedMessaging.saveAutomation.useMutation({
    onSuccess: async () => { await automations.refetch(); toast.success("تم حفظ الأتمتة."); },
    onError: (e) => toast.error(e.message),
  });
  const setAutomationState = trpc.powerhub.unifiedMessaging.setAutomationState.useMutation({
    onSuccess: async () => { await automations.refetch(); toast.success("تم تحديث حالة الأتمتة."); },
    onError: (e) => toast.error(e.message),
  });
  const sendManual = trpc.powerhub.unifiedMessaging.sendManual.useMutation({
    onSuccess: async (result) => {
      await Promise.all([utils.powerhub.unifiedMessaging.campaign.invalidate(), utils.powerhub.unifiedMessaging.history.invalidate()]);
      const reviewPersistenceFailed = Number(result.reviewPersistenceFailed ?? 0);
      setLastManualResult({ campaignId: result.campaignId, operationId: result.operationId, replayed: result.replayed, requested: result.requested, submitted: result.submitted, failed: result.failed, skipped: result.skipped, pending: result.pending ?? 0, processing: result.processing ?? 0, needsReview: result.needsReview, reviewPersistenceFailed, issues: (result.results ?? []).filter((row: any) => row.status !== "submitted").map((row: any) => String(row.error ?? (row.status === "needs_review" ? "نتيجة الإرسال غير مؤكدة وتحتاج مراجعة." : row.status === "failed" ? "فشل إرسال الرسالة." : "لم يبدأ إرسال الرسالة."))).filter(Boolean).slice(0, 5) });
      const message = `${result.replayed ? "استُرجعت نتيجة الحملة السابقة" : "اكتملت معالجة الحملة"}: ${result.submitted} مرسلة، ${result.failed} فاشلة، ${result.skipped} متجاوزة، ${result.needsReview} تحتاج مراجعة` + (reviewPersistenceFailed > 0 ? `، وتعذر تأكيد حفظ حالة المراجعة لعدد ${reviewPersistenceFailed} رسالة` : "") + ".";
      if (result.failed > 0 || result.needsReview > 0 || reviewPersistenceFailed > 0) toast.warning(message);
      else if (result.submitted > 0) toast.success(message);
      else toast.info(message);
      // Keep the same idempotency key while the campaign is still processing so a retry resumes pending rows instead of creating a duplicate campaign.
      if (result.status !== "processing") setManualOperationId(crypto.randomUUID());
    },
    onError: (e) => toast.error(e.message),
  });

  const sendManualFreeText = trpc.powerhub.unifiedMessaging.sendManualFreeText.useMutation({
    onSuccess: (result) => {
      if (result.status === "submitted" || result.status === "delivered") toast.success("تم إرسال الرسالة اليدوية إلى مزود SMS.");
      else if (result.status === "failed" || result.status === "needs_review") toast.warning(result.error || "تعذر تأكيد إرسال الرسالة؛ راجع سجل الرسائل قبل إعادة المحاولة.");
      else if (result.queued || result.status === "processing") toast.info("تم تجهيز الرسالة اليدوية؛ راجع سجل الرسائل لتأكيد النتيجة.");
      else toast.info(result.error || "تمت معالجة طلب الرسالة اليدوية دون تأكيد الإرسال.");
      if (result.status !== "processing") setManualFreeOperationId(crypto.randomUUID());
      void utils.powerhub.unifiedMessaging.history.invalidate();
      void utils.powerhub.unifiedMessaging.campaign.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const [templateId, setTemplateId] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [eventType, setEventType] = useState<"invoice_issued"|"subscriber_created"|"invoice_overdue"|"payment_received"|"service_alert">("invoice_issued");
  const [invoiceStyle, setInvoiceStyle] = useState<"details"|"portal_link">("details");
  const [automationId, setAutomationId] = useState<number | null>(null);
  const [automationName, setAutomationName] = useState("");
  const [automationTemplateId, setAutomationTemplateId] = useState<number | null>(null);
  const [automationEventType, setAutomationEventType] = useState<"invoice_issued"|"subscriber_created"|"invoice_overdue"|"payment_received"|"service_alert">("invoice_issued");
  const [scheduleType, setScheduleType] = useState<"none"|"weekly"|"every_10_days"|"every_15_days"|"monthly">("none");
  const [anchor, setAnchor] = useState("");
  const [automationTimezone, setAutomationTimezone] = useState("Asia/Gaza");
  const [afterDueHours, setAfterDueHours] = useState(24);
  const [minBalance, setMinBalance] = useState("");
  const [manualTemplateId, setManualTemplateId] = useState<number | null>(null);
  const [manualSearch, setManualSearch] = useState("");
  const [selectedSubscribers, setSelectedSubscribers] = useState<number[]>([]);
  const [manualOperationId, setManualOperationId] = useState(() => crypto.randomUUID());
  const [manualFreeMode, setManualFreeMode] = useState<"subscriber" | "phone">("subscriber");
  const [manualFreeSubscriberId, setManualFreeSubscriberId] = useState<number | null>(null);
  const [manualFreePhone, setManualFreePhone] = useState("");
  const [manualFreeMessage, setManualFreeMessage] = useState("");
  const [manualFreeOperationId, setManualFreeOperationId] = useState(() => crypto.randomUUID());
  const [lastManualResult, setLastManualResult] = useState<null | { campaignId: number; operationId: string; replayed: boolean; requested: number; submitted: number; failed: number; skipped: number; pending?: number; processing?: number; needsReview: number; reviewPersistenceFailed: number; issues?: string[] }>(null);

  const activeSmsTemplates = (templates.data ?? []).filter((t: any) => t.channel === "sms" && t.isActive);
  const manualSmsTemplates = activeSmsTemplates.filter((t: any) => !t.eventType || ["subscriber_created","service_alert"].includes(t.eventType));
  const filteredSubscribers = (subscribers.data ?? []).filter((s: any) =>
    `${s.fullName ?? ""} ${s.subscriberNo ?? ""} ${s.phone ?? ""}`.toLowerCase().includes(manualSearch.toLowerCase())
  ).slice(0, 500);

  const loadTemplate = (id: number) => {
    const t: any = (templates.data ?? []).find((row: any) => row.id === id);
    if (!t) return;
    setTemplateId(t.id); setName(t.name); setBody(t.body);
    setEventType(t.eventType ?? "invoice_issued");
    if (t.eventType === "invoice_issued" && t.channel === "sms") {
      setInvoiceStyle(t.invoiceStyle === "portal_link" ? "portal_link" : "details");
    }
  };
  const loadAutomation = (id: number) => {
    const a: any = (automations.data ?? []).find((row: any) => row.id === id);
    if (!a) return;
    setAutomationId(a.id); setAutomationName(a.name);
    setAutomationTemplateId(a.templateId);
    if (["invoice_issued", "subscriber_created", "invoice_overdue", "payment_received", "service_alert"].includes(a.eventType)) {
      setAutomationEventType(a.eventType);
    }
    setScheduleType(a.scheduleType === "none" ? "none" : a.scheduleType);
    const timezone = a.timezone || "Asia/Gaza";
    setAutomationTimezone(timezone);
    setAnchor(a.scheduleAnchorAt ? formatDateTimeLocalInTimeZone(a.scheduleAnchorAt, timezone) : "");
    setAfterDueHours(Number(a.triggerConfig?.afterDueHours ?? (Number(a.triggerConfig?.afterDueDays ?? 1) * 24)));
    setMinBalance(a.triggerConfig?.minBalance == null ? "" : String(a.triggerConfig.minBalance));
  };

  const submitTemplate = () => saveTemplate.mutate({
    siteId, id: templateId ?? undefined, name, body, channel: "sms", eventType,
    invoiceStyle: eventType === "invoice_issued" ? invoiceStyle : undefined,
    variables: variableLabels,
  });

  const submitAutomation = () => {
    let derivedAnchor: Date | undefined;
    if (scheduleType !== "none") {
      if (!anchor) return toast.error("حدد موعد بداية الجدولة.");
      try {
        derivedAnchor = parseDateTimeLocalInTimeZone(anchor, automationTimezone);
      } catch {
        return toast.error("وقت الجدولة المختار غير صالح أو غير موجود في المنطقة الزمنية المحددة.");
      }
    }
    const selectedAutomationTemplateId = automationTemplateId;
    if (!selectedAutomationTemplateId) return toast.error("اختر قالب SMS نشطًا للأتمتة.");
    const selectedAutomationTemplate = activeSmsTemplates.find((t: any) => Number(t.id) === Number(selectedAutomationTemplateId));
    if (!selectedAutomationTemplate) return toast.error("القالب المختار غير نشط أو لم يعد متاحًا. حدّث القوالب واختر قالبًا نشطًا.");
    if (selectedAutomationTemplate.eventType && selectedAutomationTemplate.eventType !== automationEventType) {
      return toast.error("نوع حدث القالب لا يطابق حدث الأتمتة. اختر قالبًا متوافقًا أو عدّل حدث القالب.");
    }
    saveAutomation.mutate({
      siteId, id: automationId ?? undefined, templateId: selectedAutomationTemplateId,
      name: automationName, eventType: automationEventType,
      sendType: scheduleType === "none" ? "automatic" : "scheduled",
      scheduleType, scheduleAnchorAt: derivedAnchor, timezone: automationTimezone, audience: {},
      triggerConfig: automationEventType === "invoice_overdue"
        ? { afterDueHours, ...(minBalance.trim() ? { minBalance: Number(minBalance) } : {}) }
        : {},
    });
  };

  const toggleAll = () => {
    const ids = filteredSubscribers.map((s: any) => Number(s.id));
    const all = ids.length > 0 && ids.every((id) => selectedSubscribers.includes(id));
    setSelectedSubscribers((current) => all ? current.filter((id) => !ids.includes(id)) : Array.from(new Set([...current, ...ids])).slice(0, 500));
  };

  const submitManual = () => {
    if (!manualTemplateId) return toast.error("اختر قالب SMS صالحاً.");
    if (!selectedSubscribers.length) return toast.error("حدد مشتركاً واحداً على الأقل.");
    sendManual.mutate({ siteId, templateId: manualTemplateId, subscriberIds: selectedSubscribers, operationId: manualOperationId });
  };

  const submitManualFreeText = () => {
    if (!manualFreeMessage.trim()) return toast.error("اكتب نص الرسالة أولاً.");
    if (manualFreeMode === "subscriber" && !manualFreeSubscriberId) return toast.error("اختر المشترك المراد إرسال الرسالة إليه.");
    if (manualFreeMode === "phone" && !manualFreePhone.trim()) return toast.error("أدخل رقم الهاتف المراد إرسال الرسالة إليه.");
    sendManualFreeText.mutate({
      siteId,
      recipientMode: manualFreeMode,
      subscriberId: manualFreeMode === "subscriber" ? manualFreeSubscriberId : null,
      phone: manualFreeMode === "phone" ? manualFreePhone.trim() : "",
      message: manualFreeMessage.trim(),
      operationId: manualFreeOperationId,
    });
  };

  return <Card className="border-[#F5B800]/20 bg-[#F5B800]/[.025]">
    <CardContent className="space-y-6 p-5">
      <div>
        <div className="flex items-center gap-2"><MessageSquareText className="h-5 w-5 text-[#F5B800]" /><h2 className="font-bold text-white">مركز المراسلة الموحد</h2></div>
        <p className="mt-1 text-sm leading-6 text-slate-400">القالب والحدث والأتمتة والحملة اليدوية تمر الآن عبر مسار موحد: صلاحية → قاعدة بيانات → طابور → عامل SMS → نتيجة مدققة.</p>
      {lastManualResult ? <div role="status" aria-live="polite" className="mt-4 rounded-xl border border-white/10 bg-white/[.025] p-4">
        <div className="font-bold text-white">{lastManualResult.replayed ? "نتيجة الحملة المسترجعة" : "نتيجة آخر حملة"} #{lastManualResult.campaignId}</div>
        <div className="mt-2 flex flex-wrap gap-3 text-sm"><span>{lastManualResult.requested} مستهدف</span><span className="text-emerald-300">{lastManualResult.submitted} مرسلة</span><span className="text-rose-300">{lastManualResult.failed} فاشلة</span><span>{lastManualResult.skipped} متجاوزة</span><span className="text-sky-200">{lastManualResult.pending ?? 0} بانتظار الإرسال</span><span className="text-sky-200">{lastManualResult.processing ?? 0} قيد المعالجة</span><span className="font-semibold text-amber-200">{lastManualResult.needsReview} تحتاج مراجعة</span></div>
        {(lastManualResult.pending ?? 0) + (lastManualResult.processing ?? 0) > 0 ? <p className="mt-2 text-xs text-sky-100">الحملة لم تنتهِ بعد؛ بقيت رسائل معلّقة أو قيد المعالجة. لا يُعرض ذلك على أنه إرسال ناجح.</p> : null}
        {lastManualResult.needsReview > 0 ? <p className="mt-2 text-xs text-amber-100">لا تُعِد إرسال الرسائل التي تحتاج مراجعة قبل حسم نتيجتها.</p> : null}
        {lastManualResult.issues?.length ? <div className="mt-3 rounded-lg border border-amber-400/20 bg-amber-400/[.04] p-3"><p className="text-xs font-bold text-amber-100">تفاصيل لم تُرسل</p><ul className="mt-2 space-y-1 text-xs text-slate-300">{lastManualResult.issues.map((issue, index) => <li key={`${index}:${issue}`}>• {issue}</li>)}</ul></div> : null}
      </div> : null}
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        <div className="space-y-3 rounded-xl border border-white/10 p-4">
          <div className="flex items-center justify-between"><h3 className="font-bold text-white">{templateId ? "تعديل القالب" : "قالب جديد"}</h3>{templateId ? <Button type="button" size="sm" variant="outline" onClick={() => { setTemplateId(null); setName(""); setBody(""); setEventType("invoice_issued"); setInvoiceStyle("details"); }}>قالب جديد</Button> : null}</div>
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="اسم القالب" />
          <select className={inputClass} value={eventType} onChange={(e) => setEventType(e.target.value as typeof eventType)}>
            <option value="invoice_issued">إرسال الفاتورة</option><option value="subscriber_created">الترحيب والرقم المرجعي</option><option value="invoice_overdue">تذكير بالسداد</option><option value="payment_received">إيصال الدفع</option><option value="service_alert">تنبيه تشغيلي</option>
          </select>
          {eventType === "invoice_issued" ? <select className={inputClass} value={invoiceStyle} onChange={(e) => setInvoiceStyle(e.target.value as typeof invoiceStyle)}><option value="details">الفاتورة بالطريقة الافتراضية</option><option value="portal_link">رابط الفاتورة + النص</option></select> : null}
          <textarea className={inputClass + " min-h-32 py-2"} value={body} onChange={(e) => setBody(e.target.value)} placeholder="اكتب نص الرسالة باستخدام المتغيرات المعتمدة." />
          <div className="grid gap-2 sm:grid-cols-2">{messageVariableOptions.map((item) => <Button key={item.token} type="button" size="sm" variant="outline" onClick={() => setBody((current) => current + (current && !current.endsWith(" ") ? " " : "") + item.token)} className="justify-start border-white/10 text-slate-200"><span className="font-bold">+ {item.label}</span><code className="mr-auto text-[10px] text-slate-500" dir="ltr">{item.token}</code></Button>)}</div>
          <div className="rounded-xl border border-[#F5B800]/20 bg-[#F5B800]/[.04] p-3"><p className="text-xs font-bold text-[#F5B800]">معاينة الرسالة النهائية</p><p className="mt-2 whitespace-pre-wrap text-sm leading-7 text-white">{previewMessageTemplate(body, settlementDisplayEnabled)}</p>{eventType !== "invoice_issued" || invoiceStyle !== "portal_link" ? (() => { const renderedPreview = previewMessageTemplate(body, settlementDisplayEnabled); const sms = segmentArabicSms(renderedPreview); return <div aria-live="polite" className={`mt-3 rounded-lg border px-3 py-2 text-xs ${sms.segmentCount > 1 ? "border-amber-400/25 bg-amber-400/[.06] text-amber-200" : "border-emerald-400/20 bg-emerald-400/[.04] text-emerald-200"}`}><strong>{sms.characterCount} حرفاً · {sms.segmentCount} رسالة SMS تقديرية</strong><p className="mt-1 text-slate-400">يُحسب العداد على النص المعروض بعد استبدال المتغيرات بقيم نموذجية؛ قد يختلف العدد الفعلي باختلاف اسم المشترك والروابط.</p></div>; })() : <p className="mt-3 text-xs text-slate-400">تُحسب شرائح الرسالة النهائية بعد إضافة رابط الفاتورة الفعلي.</p>}</div>
          <Button disabled={saveTemplate.isPending || !name.trim() || !body.trim()} onClick={submitTemplate}>{saveTemplate.isPending ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : null}حفظ القالب الموحد</Button>
          <div className="space-y-2">{(templates.data ?? []).map((t: any) => <button type="button" key={t.id} onClick={() => loadTemplate(t.id)} className="w-full rounded-lg border border-white/10 p-3 text-right hover:border-[#F5B800]/30"><div className="font-medium text-white">{t.name} <Badge>{t.channel}</Badge></div><div className="mt-1 text-xs text-slate-500">v{t.version} · {t.eventType ?? "عام"} · {t.isActive ? "نشط" : "متوقف"}</div></button>)}</div>
        </div>

        <div className="space-y-3 rounded-xl border border-white/10 p-4">
          <div className="flex items-center justify-between"><h3 className="font-bold text-white">{automationId ? "تعديل الأتمتة" : "أتمتة جديدة"}</h3>{automationId ? <Button type="button" size="sm" variant="outline" onClick={() => { setAutomationId(null); setAutomationName(""); setAutomationTemplateId(null); setAutomationEventType("subscriber_created"); setScheduleType("none"); setAnchor(""); setAfterDueHours(24); setMinBalance(""); }}>جديدة</Button> : null}</div>
          <input className={inputClass} value={automationName} onChange={(e) => setAutomationName(e.target.value)} placeholder="اسم الأتمتة" />
          <Field label="قالب الأتمتة"><select aria-label="قالب الأتمتة" className={inputClass} value={automationTemplateId ?? ""} onChange={(e) => setAutomationTemplateId(Number(e.target.value) || null)}><option value="">اختر القالب</option>{activeSmsTemplates.map((t: any) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>
          <Field label="حدث الأتمتة"><select aria-label="حدث الأتمتة" className={inputClass} value={automationEventType} onChange={(e) => setAutomationEventType(e.target.value as typeof automationEventType)}><option value="invoice_issued">صدور فاتورة</option><option value="subscriber_created">مشترك جديد</option><option value="invoice_overdue">فاتورة متأخرة</option><option value="payment_received">استلام دفعة</option><option value="service_alert">تنبيه تشغيلي</option></select></Field>
          <select className={inputClass} value={scheduleType} onChange={(e) => setScheduleType(e.target.value as typeof scheduleType)}><option value="none">عند الحدث</option><option value="weekly">أسبوعي</option><option value="every_10_days">كل 10 أيام</option><option value="every_15_days">كل 15 يوماً</option><option value="monthly">شهري</option></select>
          {automationEventType === "invoice_overdue" ? <div className="grid gap-3 sm:grid-cols-2">
            <Field label="بعد كم ساعة من الاستحقاق"><input aria-label="بعد كم ساعة من الاستحقاق" type="number" min="0" max="2160" step="1" className={inputClass} value={afterDueHours} onChange={(e) => setAfterDueHours(Number(e.target.value))} placeholder="24" /><span className="mt-1 block text-[11px] leading-5 text-slate-500">تبدأ المهلة من تاريخ الاستحقاق المسجّل في الفاتورة، ولا يُرسل التذكير قبل انتهائها.</span></Field>
            <Field label="أقل رصيد مستحق"><input aria-label="أقل رصيد مستحق" type="number" min="0" step="0.01" className={inputClass} value={minBalance} onChange={(e) => setMinBalance(e.target.value)} placeholder="اختياري" /><span className="mt-1 block text-[11px] leading-5 text-slate-500">يشترط أن يكون المتبقي في الفاتورة بهذا المبلغ أو أكثر. اتركه فارغًا لتجاهل الشرط.</span></Field>
          </div> : null}
          {scheduleType !== "none" ? <input type="datetime-local" className={inputClass} value={anchor} onChange={(e) => setAnchor(e.target.value)} /> : null}
          <Button type="button" disabled={saveAutomation.isPending || !automationName.trim() || !automationTemplateId || !activeSmsTemplates.some((t: any) => Number(t.id) === Number(automationTemplateId)) || (scheduleType !== "none" && !anchor)} onClick={submitAutomation}>{saveAutomation.isPending ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : null}حفظ الأتمتة</Button>
          <div className="space-y-2">{(automations.data ?? []).map((a: any) => <div key={a.id} className="rounded-lg border border-white/10 p-3"><button type="button" className="w-full text-right" onClick={() => loadAutomation(a.id)}><div className="font-medium text-white">{a.name}</div><div className="mt-1 text-xs text-slate-500">{a.eventType} · {a.sendType === "automatic" ? "عند الحدث" : a.scheduleType} · {a.enabled ? "مفعّل" : "متوقف"}</div></button><div className="mt-2 flex gap-2"><Button size="sm" variant="outline" disabled={setAutomationState.isPending} onClick={() => setAutomationState.mutate({siteId, automationId:a.id, enabled:!a.enabled, archived:false})}>{a.enabled ? "تعطيل" : "تفعيل"}</Button><Button size="sm" variant="outline" disabled={setAutomationState.isPending} onClick={() => setAutomationState.mutate({siteId, automationId:a.id, enabled:false, archived:true})}>أرشفة</Button></div></div>)}</div>
        </div>
      </div>

      <div className="space-y-3 rounded-xl border border-emerald-400/15 p-4">
        <div><h3 className="font-bold text-white">إرسال يدوي</h3><p className="mt-1 text-xs text-slate-500">اختيار المشتركين يتم من الفرع الحالي فقط. الحد الأقصى 500 مستلم للحملة، وإعادة الطلب بنفس operationId لا تنشئ رسائل ثانية.</p></div>
        <div className="grid gap-3 md:grid-cols-3">
          <select aria-label="قالب SMS للحملة اليدوية" className={inputClass} value={manualTemplateId ?? ""} onChange={(e) => setManualTemplateId(Number(e.target.value) || null)}><option value="">اختر قالب SMS</option>{manualSmsTemplates.map((t: any) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
          <input className={inputClass} value={manualSearch} onChange={(e) => setManualSearch(e.target.value)} placeholder="بحث بالاسم أو الرقم أو الهاتف" />
          <Button type="button" variant="outline" onClick={toggleAll}>{filteredSubscribers.length && filteredSubscribers.every((s: any) => selectedSubscribers.includes(Number(s.id))) ? "إلغاء تحديد الظاهر" : "تحديد الظاهر"}</Button>
        </div>
        <div aria-live="polite" className={`rounded-xl border p-3 ${connectionReadiness.data?.ready ? "border-emerald-400/25 bg-emerald-400/[.05]" : "border-amber-400/25 bg-amber-400/[.05]"}`}>
          <div className="flex items-center gap-2"><span className={`h-2.5 w-2.5 rounded-full ${connectionReadiness.data?.ready ? "bg-emerald-400" : "bg-amber-400"}`} /><strong className="text-sm text-white">{connectionReadiness.isLoading ? "جارٍ التحقق من جاهزية الربط…" : connectionReadiness.data?.label ?? "تعذر التحقق من جاهزية الربط"}</strong><Button type="button" size="sm" variant="outline" className="mr-auto" disabled={connectionReadiness.isFetching} onClick={() => connectionReadiness.refetch()}>تحديث الحالة</Button></div>
          <p className="mt-1 text-xs text-slate-400">{connectionReadiness.data?.detail ?? (connectionReadiness.error ? "تعذر قراءة حالة الربط؛ لا يمكن تأكيد الجاهزية." : "جارٍ تحميل حالة اتصال TweetSMS.")}</p>
        </div>
        <div className="rounded-lg border border-white/10 p-3 text-sm text-slate-300">تم تحديد <strong className="text-[#F5B800]">{selectedSubscribers.length}</strong> مشترك</div>
        <div className="max-h-72 overflow-auto rounded-lg border border-white/10">{filteredSubscribers.map((s: any) => <label key={s.id} className="flex items-center gap-3 border-b border-white/5 p-3 text-sm text-slate-200"><input type="checkbox" checked={selectedSubscribers.includes(Number(s.id))} onChange={() => setSelectedSubscribers((current) => current.includes(Number(s.id)) ? current.filter((id) => id !== Number(s.id)) : [...current,Number(s.id)].slice(0,500))} /><span>{s.fullName}</span><span className="mr-auto text-xs text-slate-500" dir="ltr">{s.subscriberNo}</span></label>)}</div>
        <div className="flex justify-end"><Button type="button" disabled={sendManual.isPending || !manualTemplateId || !selectedSubscribers.length || connectionReadiness.isLoading || connectionReadiness.isError || !connectionReadiness.data?.ready} onClick={submitManual}>{sendManual.isPending ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : null}إرسال الحملة</Button></div>
      </div>

      <div className="space-y-4 rounded-xl border border-sky-400/20 bg-sky-400/[.025] p-4">
        <div>
          <h3 className="font-bold text-white">إرسال SMS يدوي حر</h3>
          <p className="mt-1 text-xs leading-6 text-slate-400">أرسل نصاً تكتبه بنفسك إلى رقم هاتف أو إلى مشترك من هذا الفرع. تُسجّل الرسالة في الطابور وسجل التدقيق، ويُتحقق من رصيد المحفظة الدائم وحد مزود الرسائل الشهري قبل الإرسال.</p>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="المستلم">
            <select className={inputClass} value={manualFreeMode} onChange={(e) => setManualFreeMode(e.target.value as "subscriber" | "phone")}>
              <option value="subscriber">اختيار مشترك موجود</option>
              <option value="phone">إدخال رقم هاتف يدوي</option>
            </select>
          </Field>
          {manualFreeMode === "subscriber" ? <Field label="المشترك">
            <select className={inputClass} value={manualFreeSubscriberId ?? ""} onChange={(e) => setManualFreeSubscriberId(Number(e.target.value) || null)}>
              <option value="">اختر مشتركاً من الفرع الحالي</option>
              {(subscribers.data ?? []).filter((s: any) => s.phone && !s.archivedAt).map((s: any) => <option key={s.id} value={s.id}>{s.fullName} · {s.subscriberNo} · {s.phone}</option>)}
            </select>
          </Field> : <Field label="رقم الهاتف بصيغة دولية">
            <input className={inputClass} dir="ltr" inputMode="tel" autoComplete="tel" value={manualFreePhone} onChange={(e) => setManualFreePhone(e.target.value)} placeholder="+97059xxxxxxx" />
          </Field>}
        </div>
        <Field label="نص الرسالة">
          <textarea className={inputClass + " min-h-32 py-2"} value={manualFreeMessage} onChange={(e) => setManualFreeMessage(e.target.value)} maxLength={2000} placeholder="اكتب نص SMS الذي تريد إرساله..." />
        </Field>
        <div className="rounded-lg border border-white/10 p-3 text-xs text-slate-300">
          {(() => { const sms = segmentArabicSms(manualFreeMessage); return <><strong>{sms.characterCount} حرفاً · {sms.segmentCount} رسالة SMS تقديرية</strong><p className="mt-1 text-slate-500">يُحتسب العدد على النص المكتوب، وقد يختلف حسب قواعد المزود.</p></>; })()}
        </div>
        <div className="flex justify-end">
          <Button type="button" disabled={sendManualFreeText.isPending || !manualFreeMessage.trim() || connectionReadiness.isLoading || connectionReadiness.isError || !connectionReadiness.data?.ready || (manualFreeMode === "subscriber" ? !manualFreeSubscriberId : !manualFreePhone.trim())} onClick={submitManualFreeText}>
            {sendManualFreeText.isPending ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : null}إرسال SMS
          </Button>
        </div>
      </div>
    </CardContent>
  </Card>;
}

export default function MessagingSettingsPage() {
  const { isAuthenticated, loading } = useAuth();
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();

  const sitesQuery = trpc.powerhub.sites.list.useQuery(undefined, { enabled: isAuthenticated });
  const [siteId, setSiteId] = useState<number | null>(null);
  useEffect(() => { if (!siteId && sitesQuery.data?.[0]) setSiteId(sitesQuery.data[0].id); }, [siteId, sitesQuery.data]);
  const enabled = Boolean(isAuthenticated && siteId);
  const billingPolicyQuery = trpc.powerhub.siteBillingPolicy.get.useQuery({ siteId: siteId ?? 0 }, { enabled });
  const settlementDisplayEnabled = Boolean(billingPolicyQuery.data?.automaticFractionDiscountEnabled || billingPolicyQuery.data?.fractionCarryEnabled);
  const accessQuery = trpc.powerhub.staff.myAccess.useQuery({ siteId: siteId ?? 0 }, { enabled });
  const owner = can(accessQuery.data?.role, "manageMessaging");
  const canCollect = can(accessQuery.data?.role, "collectPayments");
  const configsQuery = trpc.powerhub.messaging.listConfigurations.useQuery({ siteId: siteId ?? 0 }, { enabled: enabled && owner });
  const policyQuery = trpc.powerhub.messaging.deliveryPolicy.useQuery({ siteId: siteId ?? 0 }, { enabled: enabled && owner });
  const templatesQuery = trpc.powerhub.messaging.listInvoiceTemplates.useQuery({ siteId: siteId ?? 0 }, { enabled: enabled && owner });
  const receiptTemplatesQuery = trpc.powerhub.messaging.listPaymentReceiptTemplates.useQuery({ siteId: siteId ?? 0 }, { enabled: enabled && owner });
  const phoneReviewQuery = trpc.powerhub.subscribers.phoneReview.useQuery({ siteId: siteId ?? 0 }, { enabled: enabled && owner });
  const notificationsQuery = trpc.powerhub.notifications.list.useQuery({ siteId: siteId ?? 0, eventType: "invoice_issued" }, { enabled });
  const scheduleRunsQuery = trpc.powerhub.messaging.listScheduleRuns.useQuery({ siteId: siteId ?? 0, limit: 20 }, { enabled: enabled && ["owner", "manager", "accountant"].includes(accessQuery.data?.role ?? "") });
  const smsQuotaQuery = trpc.powerhub.messaging.smsQuota.useQuery({ siteId: siteId ?? 0 }, { enabled: enabled && owner });
  const smsCreditPackagesQuery = trpc.powerhub.messaging.smsCreditPackages.useQuery({ siteId: siteId ?? 0 }, { enabled: enabled && owner, staleTime: 60_000 });
  const smsPackageRequestQuery = trpc.powerhub.messaging.currentSmsPackageRequest.useQuery({ siteId: siteId ?? 0 }, { enabled: enabled && owner, refetchInterval: 15_000 });
  const smsDailyUsageQuery = trpc.powerhub.messaging.smsDailyUsage.useQuery({ siteId: siteId ?? 0 }, { enabled: enabled && owner });
  const canViewFinancialAlerts = ["owner", "manager", "accountant", "viewer"].includes(accessQuery.data?.role ?? "");
  const financialOverviewQuery = trpc.powerhub.dashboard.financialOverview.useQuery({ siteId: siteId ?? 0, scope: "branch" }, { enabled: enabled && canViewFinancialAlerts });
  const refresh = async () => { await Promise.all([utils.powerhub.messaging.listConfigurations.invalidate(), utils.powerhub.messaging.deliveryPolicy.invalidate(), utils.powerhub.messaging.listInvoiceTemplates.invalidate(), utils.powerhub.messaging.listPaymentReceiptTemplates.invalidate(), utils.powerhub.subscribers.phoneReview.invalidate(), utils.powerhub.subscribers.list.invalidate(), utils.powerhub.notifications.list.invalidate(), utils.powerhub.messaging.listScheduleRuns.invalidate(), utils.powerhub.messaging.smsQuota.invalidate(), utils.powerhub.messaging.smsDailyUsage.invalidate(), utils.powerhub.audit.list.invalidate()]); };
  const saveConfig = trpc.powerhub.messaging.saveConfiguration.useMutation({ onSuccess: async () => { await refresh(); toast.success("تم حفظ إعداد الربط المشفر للمستأجر."); }, onError: (e) => toast.error(e.message) });
  const saveTemplate = trpc.powerhub.messaging.saveInvoiceTemplate.useMutation({ onSuccess: async () => { await refresh(); toast.success("تم حفظ قالب رسالة الفاتورة."); }, onError: (e) => toast.error(e.message) });
  const saveReceiptTemplate = trpc.powerhub.messaging.savePaymentReceiptTemplate.useMutation({ onSuccess: async () => { await refresh(); toast.success("تم حفظ قالب إيصال SMS."); }, onError: (e) => toast.error(e.message) });
  const requestSmsPackage = trpc.powerhub.messaging.requestSmsPackage.useMutation({ onSuccess: async () => { await Promise.all([smsPackageRequestQuery.refetch(),smsQuotaQuery.refetch(),smsDailyUsageQuery.refetch()]); toast.success("تم إرسال طلب الحزمة للمراجعة."); }, onError: (e) => toast.error(e.message) });
  const retry = trpc.powerhub.notifications.retry.useMutation({ onSuccess: async () => { await refresh(); toast.success("أُعيدت الرسالة إلى طابور الإرسال."); }, onError: (e) => toast.error(e.message) });
  const applyPhoneNormalization = trpc.powerhub.subscribers.applyPhoneNormalization.useMutation({ onSuccess: async (result) => { await refresh(); toast.success(`تم تحديث ${result.updated} رقم وترك ${result.skipped} للمراجعة اليدوية.`); }, onError: (e) => toast.error(e.message) });
  const retryReceipt = trpc.powerhub.notifications.retryPaymentReceipt.useMutation({ onSuccess: async () => { await refresh(); toast.success("تمت معالجة طلب إعادة الإرسال."); }, onError: (e) => toast.error(e.message) });

  const configs = configsQuery.data ?? [];
  const smsConfig = configs.find((item) => item.channel === "sms");
  const policy = policyQuery.data;
  const open = policy?.configured === true && policy?.isEnabled === true;
  const available = { whatsapp: open && policy?.whatsappEnabled === true, sms: open && policy?.smsEnabled === true };
  const templates = templatesQuery.data ?? [];
  const receiptTemplates = receiptTemplatesQuery.data ?? [];
  return <DashboardLayout><div className="space-y-6 pb-12"><header className="flex flex-col gap-4 rounded-[24px] border border-white/8 bg-[#111823]/80 p-5 shadow-panel sm:flex-row sm:items-center sm:justify-between"><div><div className="flex items-center gap-2 text-sm font-bold text-[#F5B800]"><MessageSquareText className="h-4 w-4" />رسائل الفواتير</div><h1 className="mt-1 text-2xl font-extrabold text-white">قوالب الفاتورة وحالة الإرسال</h1><p className="mt-2 text-sm text-slate-400">يدير آدمن PowerHub حساب TweetSMS واسم المرسل وحد مزود الرسائل الشهري، وهو منفصل عن محفظتك المدفوعة الدائمة. يمكنك هنا تخصيص القوالب ومتابعة الإرسال فقط.</p></div>{sitesQuery.data?.length ? <select value={siteId ?? ""} onChange={(e) => setSiteId(Number(e.target.value))} className={inputClass}>{sitesQuery.data.map((site) => <option className="bg-[#111823]" key={site.id} value={site.id}>{site.name}</option>)}</select> : null}</header>
    {!owner ? <Card className="border-white/8 bg-[#111823]"><CardContent className="p-8 text-center text-sm text-slate-500">تحتاج إلى صلاحية <strong className="text-[#F5B800]">إدارة المراسلات</strong> لعرض حالة الرسائل وقوالبها.</CardContent></Card> : <><section className="grid gap-6 xl:grid-cols-2">{available.whatsapp ? <ChannelForm title="إعداد WhatsApp Cloud API" channel="whatsapp" existing={configs.find((item) => item.channel === "whatsapp")} pending={saveConfig.isPending} onSubmit={saveConfig.mutate} siteId={siteId!} /> : null}</section>{owner ? <><TweetSmsQuotaCard quota={smsQuotaQuery.data} packages={smsCreditPackagesQuery.data ?? []} request={smsPackageRequestQuery.data} requestLoading={smsPackageRequestQuery.isLoading} requestError={smsPackageRequestQuery.isError} requesting={requestSmsPackage.isPending} onRetry={() => smsPackageRequestQuery.refetch()} onRequest={(packageId) => requestSmsPackage.mutate({siteId:siteId!,packageId})} /><SmsDailyUsageCard data={smsDailyUsageQuery.data} loading={smsDailyUsageQuery.isLoading} /></> : null}
    {available.sms && owner && siteId ? <AutoSendPolicyCard config={smsConfig} siteId={siteId} /> : null}
      {open ? <section className="grid gap-6 xl:grid-cols-2">{available.whatsapp ? <TemplateEditor channel="whatsapp" template={templates.find((item) => item.channel === "whatsapp")} pending={saveTemplate.isPending} onSubmit={saveTemplate.mutate} siteId={siteId!} settlementEnabled={settlementDisplayEnabled} /> : null}{available.sms ? <TemplateEditor channel="sms" template={templates.find((item) => item.channel === "sms")} pending={saveTemplate.isPending} onSubmit={saveTemplate.mutate} siteId={siteId!} settlementEnabled={settlementDisplayEnabled} /> : null}{available.sms ? <PaymentReceiptSmsEditor template={receiptTemplates.find((item) => item.channel === "sms")} pending={saveReceiptTemplate.isPending} onSubmit={saveReceiptTemplate.mutate} siteId={siteId!} settlementEnabled={settlementDisplayEnabled} /> : null}</section> : null}</>}
    {owner && siteId ? <UnifiedMessagingPanel siteId={siteId} /> : null}
    {owner && siteId ? <UnifiedMessageHistoryPanel siteId={siteId} /> : null}
    {canViewFinancialAlerts ? <FinancialCollectionAlerts overview={financialOverviewQuery.data} canCollect={canCollect} onOpenInvoice={(invoiceId: number) => navigate(`/invoices?invoiceId=${invoiceId}`)} onCollect={(row: any) => navigate(`/collections?subscriberId=${row.subscriberId}&invoiceId=${row.invoiceId}`)} /> : null}
    {owner && siteId ? <InvoiceSmsQueue rows={notificationsQuery.data ?? []} config={smsConfig} siteId={siteId} /> : null}
    {owner ? <PhoneNormalizationTool rows={phoneReviewQuery.data ?? []} pending={applyPhoneNormalization.isPending} onApply={(subscriberIds: number[]) => applyPhoneNormalization.mutate({ siteId: siteId!, subscriberIds })} /> : null}
    {owner ? <ScheduleRunLog rows={scheduleRunsQuery.data ?? []} loading={scheduleRunsQuery.isLoading} /> : null}
  </div></DashboardLayout>;
}

function AutoSendPolicyCard({ config, siteId }: { config: any; siteId: number }) {
  const local = config?.scheduleAnchorAt ? formatDateTimeLocalInTimeZone(config.scheduleAnchorAt, MESSAGE_SCHEDULE_TIME_ZONE) : "";
  const wallDate = local ? new Date(`${local.slice(0,10)}T00:00:00.000Z`) : null;
  const [enabled, setEnabled] = useState(Boolean(config?.autoSendAfterApproval));
  const [mode, setMode] = useState(config?.scheduleMode ?? "immediate");
  const [anchor, setAnchor] = useState(local);
  const [cycleDay, setCycleDay] = useState(wallDate ? wallDate.getUTCDay() : 4);
  const [cycleMonthDay, setCycleMonthDay] = useState(wallDate ? wallDate.getUTCDate() : 2);
  const [cycleTime, setCycleTime] = useState(local ? local.slice(11,16) : "20:00");
  useEffect(() => {
    setEnabled(Boolean(config?.autoSendAfterApproval)); setMode(config?.scheduleMode ?? "immediate");
    if (config?.scheduleAnchorAt) {
      const v = formatDateTimeLocalInTimeZone(config.scheduleAnchorAt, MESSAGE_SCHEDULE_TIME_ZONE);
      const d = new Date(`${v.slice(0,10)}T00:00:00.000Z`);
      setAnchor(v); setCycleDay(d.getUTCDay()); setCycleMonthDay(d.getUTCDate()); setCycleTime(v.slice(11,16));
    }
  }, [config?.autoSendAfterApproval, config?.scheduleMode, config?.scheduleAnchorAt]);
  const buildAnchor = () => {
    if (mode === "immediate") return undefined;
    if (mode === "weekly") return buildWeeklyScheduleAnchor(cycleDay, cycleTime, new Date(), MESSAGE_SCHEDULE_TIME_ZONE);
    if (mode === "monthly") return buildMonthlyScheduleAnchor(cycleMonthDay, cycleTime, new Date(), MESSAGE_SCHEDULE_TIME_ZONE);
    return anchor ? parseDateTimeLocalInTimeZone(anchor, MESSAGE_SCHEDULE_TIME_ZONE).toISOString() : undefined;
  };
  const utils = trpc.useUtils();
  const save = trpc.powerhub.messaging.configureInvoiceAutoSend.useMutation({ onSuccess: async () => { await Promise.all([utils.powerhub.messaging.listConfigurations.invalidate(), utils.powerhub.messaging.listScheduleRuns.invalidate()]); toast.success("تم حفظ دورة إرسال رسائل الفواتير وتحديث الطابور."); }, onError: (e) => toast.error(e.message) });
  const submit = () => {
    let computedAnchor: string | undefined;
    try { computedAnchor = buildAnchor(); } catch (error) { return toast.error(error instanceof Error ? error.message : "تعذر حساب بداية دورة الإرسال."); }
    if (mode !== "immediate" && !computedAnchor) return toast.error("تعذر حساب بداية دورة الإرسال.");
    save.mutate({ siteId, enabled, scheduleMode: mode, scheduleAnchorAt: computedAnchor });
  };
  return <Card className="border-sky-400/20 bg-sky-400/[.035]"><CardContent className="space-y-4 p-5">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div><div className="flex items-center gap-2"><ShieldCheck className="h-5 w-5 text-sky-300" /><h2 className="font-bold text-white">الإرسال الآلي لرسائل الفواتير</h2></div><p className="mt-2 text-sm leading-6 text-slate-400">تُنشأ رسالة SMS عند إصدار الفاتورة. عند اختيار دورة مجمعة، تنتظر الرسائل حتى موعد الدفعة ثم تُرسل معًا.</p></div><label className="flex items-center gap-2 text-sm font-bold text-white"><input type="checkbox" checked={enabled} onChange={e=>setEnabled(e.target.checked)} className="accent-[#F5B800]" />تفعيل الإرسال الآلي</label></div>
    <div className="grid gap-3 md:grid-cols-2"><Field label="دورة الإرسال"><select value={mode} onChange={e=>setMode(e.target.value)} disabled={!enabled} className={inputClass}><option value="immediate">فور إصدار الفاتورة</option><option value="weekly">أسبوعية</option><option value="every_10_days">كل 10 أيام</option><option value="every_15_days">كل 15 يومًا</option><option value="monthly">شهرية</option></select></Field>{mode === "weekly" ? <><Field label="يوم الإرسال"><select value={cycleDay} onChange={e=>setCycleDay(Number(e.target.value))} disabled={!enabled} className={inputClass}><option value={0}>الأحد</option><option value={1}>الاثنين</option><option value={2}>الثلاثاء</option><option value={3}>الأربعاء</option><option value={4}>الخميس</option><option value={5}>الجمعة</option><option value={6}>السبت</option></select></Field><Field label="ساعة الإرسال"><input type="time" value={cycleTime} onChange={e=>setCycleTime(e.target.value)} disabled={!enabled} className={inputClass} dir="ltr" /></Field></> : mode === "monthly" ? <><Field label="يوم الشهر"><select value={cycleMonthDay} onChange={e=>setCycleMonthDay(Number(e.target.value))} disabled={!enabled} className={inputClass}>{Array.from({length:31},(_,i)=><option key={i+1} value={i+1}>{i+1} من كل شهر</option>)}</select></Field><Field label="ساعة الإرسال"><input type="time" value={cycleTime} onChange={e=>setCycleTime(e.target.value)} disabled={!enabled} className={inputClass} dir="ltr" /></Field></> : mode !== "immediate" ? <Field label="بداية الدورة (التاريخ والوقت)"><input type="datetime-local" value={anchor} onChange={e=>setAnchor(e.target.value)} disabled={!enabled} className={inputClass} dir="ltr" /></Field> : <div className="rounded-xl border border-white/10 bg-black/10 p-3 text-xs leading-6 text-slate-400">الإرسال الفوري: تُرسل الرسالة عند إصدار الفاتورة.</div>}</div>
    {mode !== "immediate" ? <p className="text-xs leading-6 text-slate-500">الفواتير الصادرة حتى موعد الدورة تتجمع وتُرسل دفعة واحدة. يمكن الإرسال اليدوي قبل الموعد دون إنشاء رسالة مكررة.</p> : null}
    <div className="flex justify-end"><Button type="button" onClick={submit} disabled={save.isPending} className="bg-[#F5B800] text-[#0D1117] hover:bg-[#ffd23f]">{save.isPending ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : null}حفظ إعداد الإرسال</Button></div>
    <div className="text-xs text-slate-500">الدورات: أسبوعي · كل 10 أيام · كل 15 يومًا · شهري. ولا يحتاج صاحب المولد إلى كتابة Cron أو أي إعداد تقني.</div>
  </CardContent></Card>; }
function PolicyCard({ policy }: { policy: { isEnabled: boolean; configured?: boolean; whatsappEnabled: boolean; smsEnabled: boolean; message?: string | null } | undefined }) { const open = policy?.configured === true && policy?.isEnabled === true; return <Card className={open ? "border-emerald-400/20 bg-emerald-400/[.035]" : "border-amber-400/20 bg-amber-400/[.035]"}><CardContent className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between"><div className="flex items-start gap-3"><LockKeyhole className={open ? "mt-0.5 h-5 w-5 text-emerald-300" : "mt-0.5 h-5 w-5 text-amber-300"} /><div><h2 className="font-bold text-white">سياسة آدمن PowerHub</h2><p className="mt-1 text-sm leading-6 text-slate-400">{policy?.message || (open ? "يمكنك تخصيص القوالب ومتابعة السجل. تُدار بيانات WhatsApp حسب القناة، بينما حساب TweetSMS واسم المرسل والحصة تحت إدارة آدمن PowerHub." : "إرسال الفواتير غير مفتوح حتى يحفظ آدمن المنصة سياسة تشغيله.")}</p></div></div><div className="flex gap-2"><Badge className={policy?.whatsappEnabled && open ? "bg-emerald-400/10 text-emerald-300" : "bg-white/5 text-slate-500"}>WhatsApp {policy?.whatsappEnabled && open ? "مفتوح" : "مغلق"}</Badge><Badge className={policy?.smsEnabled && open ? "bg-emerald-400/10 text-emerald-300" : "bg-white/5 text-slate-500"}>SMS {policy?.smsEnabled && open ? "مفتوح" : "مغلق"}</Badge></div></CardContent></Card>; }
function FinancialCollectionAlerts({ overview, canCollect, onOpenInvoice, onCollect }: { overview: any; canCollect: boolean; onOpenInvoice: (invoiceId: number) => void; onCollect: (row: any) => void }) { const format = (value: unknown) => new Intl.NumberFormat("ar", { maximumFractionDigits: 2 }).format(Number(value ?? 0)); const alerts = [{ key: "overdue", visible: Number(overview?.outstanding?.overdue ?? 0) > 0, title: "متأخرات تجاوزت الاستحقاق", description: `${format(overview?.outstanding?.overdue)} رصيد متأخر يحتاج متابعة تحصيل.`, tone: "rose" as const, icon: CircleAlert }, { key: "partial", visible: Number(overview?.outstanding?.partialInvoices ?? 0) > 0, title: "دفعات جزئية تحتاج متابعة", description: `${format(overview?.outstanding?.partialInvoices)} فاتورة ما زالت غير مكتملة السداد.`, tone: "amber" as const, icon: WalletCards }, { key: "rate", visible: Number(overview?.month?.invoiced ?? 0) > 0 && Number(overview?.month?.collectionRate ?? 0) < 70, title: "نسبة التحصيل الشهرية منخفضة", description: `نسبة التحصيل الحالية ${format(overview?.month?.collectionRate)}%، راجع فواتير وأرصدة الفرع.`, tone: "amber" as const, icon: BellRing }].filter((item) => item.visible); const debtors = (overview?.topDebtors ?? []).filter((row: any) => Number(row.outstanding) > 0 && Number(row.invoiceId) > 0).slice(0, 4); return <Card className={alerts.length ? "border-rose-400/20 bg-rose-400/[.04] shadow-panel" : "border-emerald-400/20 bg-emerald-400/[.035] shadow-panel"}><CardContent className="p-5"><div className="flex items-center justify-between"><div><h2 className="font-bold text-white">تنبيهات التحصيل والمتأخرات</h2><p className="mt-1 text-xs text-slate-500">تُحتسب تلقائياً من بيانات الفوترة والدفعات الحالية للفرع.</p></div><Badge className={alerts.length ? "bg-rose-400/10 text-rose-300" : "bg-emerald-400/10 text-emerald-300"}>{alerts.length ? `${alerts.length} تنبيه يحتاج متابعة` : "لا توجد تنبيهات مالية"}</Badge></div>{alerts.length ? <><div className="mt-4 grid gap-3 lg:grid-cols-3">{alerts.map((alert) => { const Icon = alert.icon; const accent = alert.tone === "rose" ? "border-rose-400/20 bg-rose-400/[.06] text-rose-200" : "border-amber-400/20 bg-amber-400/[.06] text-amber-200"; return <div key={alert.key} className={`rounded-xl border p-4 ${accent}`}><Icon className="h-4 w-4" /><p className="mt-3 font-bold">{alert.title}</p><p className="mt-2 text-xs leading-6 text-slate-300">{alert.description}</p></div>; })}</div>{debtors.length ? <div className="mt-4 rounded-xl border border-white/8 bg-[#0D1117]/35 p-4"><p className="font-bold text-white">أولوية المتأخرات</p><p className="mt-1 text-xs text-slate-500">افتح الفاتورة المستهدفة أو ابدأ تحصيلاً جديداً للمشترك مباشرة.</p><div className="mt-3 grid gap-3 lg:grid-cols-2">{debtors.map((row: any) => <div key={row.invoiceId} className="rounded-lg border border-white/8 bg-white/[.02] p-3"><div className="flex items-start justify-between gap-3"><div><p className="font-bold text-white">{row.subscriber}</p><p className="mt-1 text-xs text-slate-500" dir="ltr">{row.invoiceNo} · {format(row.outstanding)} متبقي</p></div><Badge className={row.isOverdue ? "bg-rose-400/10 text-rose-300" : "bg-amber-400/10 text-amber-200"}>{row.isOverdue ? `${row.ageDays} يوم تأخير` : "رصيد مفتوح"}</Badge></div><div className="mt-3 flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => onOpenInvoice(row.invoiceId)} className="border-white/15 text-white hover:bg-white/5 hover:text-white"><FileText className="ml-1 h-3.5 w-3.5" />فتح الفاتورة</Button>{canCollect ? <Button size="sm" onClick={() => onCollect(row)} className="bg-[#F5B800] text-[#0D1117] hover:bg-[#ffd23f]"><WalletCards className="ml-1 h-3.5 w-3.5" />تسجيل تحصيل</Button> : null}</div></div>)}</div></div> : null}</> : <p className="mt-4 rounded-xl border border-emerald-400/15 bg-[#0D1117]/25 px-4 py-4 text-sm leading-6 text-emerald-200">لا توجد متأخرات تجاوزت الاستحقاق أو دفعات جزئية أو انخفاض تحصيل يتطلب متابعة في الفرع المحدد.</p>}</CardContent></Card>; }
function Unavailable({ channel }: { channel: Channel }) { return <Card className="border-white/8 bg-[#111823]/60"><CardContent className="grid min-h-56 place-items-center p-6 text-center"><div><LockKeyhole className="mx-auto h-6 w-6 text-slate-500" /><h2 className="mt-3 font-bold text-slate-300">قناة {channel === "whatsapp" ? "WhatsApp" : "SMS"} غير متاحة</h2><p className="mt-2 text-sm leading-6 text-slate-500">يجب أن يفتح آدمن PowerHub هذه القناة أولاً.</p></div></CardContent></Card>; }
function ChannelForm({ title, channel, existing, pending, onSubmit, siteId }: { title: string; channel: Channel; existing: any; pending: boolean; onSubmit: (input: any) => void; siteId: number }) {
  const formRef = useRef<HTMLFormElement>(null);
  const [result, setResult] = useState<{ ok: boolean; mode: "live" | "configuration"; message: string } | null>(null);
  const testConnection = trpc.powerhub.messaging.testConnection.useMutation({ onSuccess: (data) => setResult(data), onError: (error) => setResult({ ok: false, mode: "live", message: error.message }) });
  const payload = () => { const data = new FormData(formRef.current!); return { siteId, channel, provider: String(data.get("provider")), phoneNumberId: String(data.get("phoneNumberId") || "") || undefined, credential: String(data.get("credential")) }; };
  const submit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const data = new FormData(event.currentTarget); onSubmit({ ...payload(), senderId: String(data.get("senderId") || "") || undefined, templateName: String(data.get("templateName") || "") || undefined, receiptTemplateName: String(data.get("receiptTemplateName") || "") || undefined, subscriberReferenceTemplateName: String(data.get("subscriberReferenceTemplateName") || "") || undefined, webhookVerifyToken: String(data.get("webhookVerifyToken") || "") || undefined, webhookAppSecret: String(data.get("webhookAppSecret") || "") || undefined, isActive: true }); setResult(null); };
  const resultClass = result?.ok ? "border-emerald-400/30 bg-emerald-400/[.07] text-emerald-200" : result?.mode === "configuration" ? "border-amber-400/30 bg-amber-400/[.07] text-amber-200" : "border-rose-400/30 bg-rose-400/[.07] text-rose-200";
  return <Card className="border-white/8 bg-[#111823] shadow-panel"><CardContent className="p-5"><div className="flex items-center gap-2"><KeyRound className="h-4 w-4 text-[#F5B800]" /><h2 className="font-bold text-white">{title}</h2></div><p className="mt-2 text-xs text-slate-500">اختبار الاتصال لا يحفظ المفتاح؛ تُشفر بيانات API فقط بعد الضغط على الحفظ.</p><form ref={formRef} className="mt-5 space-y-4" onSubmit={submit}>{channel === "whatsapp" ? <><Field label="المزود"><input required name="provider" defaultValue={existing?.provider ?? "meta_whatsapp_cloud"} className={inputClass} /></Field><Field label="Phone Number ID"><input required name="phoneNumberId" defaultValue={existing?.phoneNumberId ?? ""} className={inputClass} dir="ltr" /></Field><Field label="اسم قالب فاتورة Meta المعتمد"><input name="templateName" defaultValue={existing?.templateName ?? "invoice_ready_ar"} className={inputClass} dir="ltr" /></Field><Field label="اسم قالب إيصال الدفع المعتمد"><input name="receiptTemplateName" defaultValue={existing?.receiptTemplateName ?? "payment_receipt_ar"} className={inputClass} dir="ltr" /></Field><Field label="اسم قالب رسالة الرقم المرجعي"><input name="subscriberReferenceTemplateName" defaultValue={existing?.subscriberReferenceTemplateName ?? "subscriber_reference_ar"} className={inputClass} dir="ltr" /></Field><p className="-mt-2 text-xs leading-5 text-slate-500">يجب أن يحتوي قالب رسالة الرقم المرجعي في Meta على ثلاثة متغيرات بالترتيب: الاسم، الرقم المرجعي، رابط البوابة. أما قالب الإيصال فيحتوي: الاسم، رقم الإيصال، المبلغ، الفاتورة، الرصيد.</p><Field label="Webhook Verify Token"><input name="webhookVerifyToken" type="password" minLength={16} className={inputClass} dir="ltr" /></Field><Field label="Meta App Secret"><input name="webhookAppSecret" type="password" minLength={16} className={inputClass} dir="ltr" /></Field></> : <SmsProviderFields existing={existing} />}<Field label={channel === "whatsapp" ? "Access Token" : "رمز API للمزود"}><input required name="credential" type="password" autoComplete="new-password" className={inputClass} placeholder="يُفحص مؤقتاً ولا يظهر بعد الحفظ" /></Field><div className="grid gap-3 sm:grid-cols-2"><Button type="button" disabled={testConnection.isPending} onClick={() => { if (!formRef.current?.reportValidity()) return; setResult({ ok: false, mode: "configuration", message: "جاري فحص بيانات الاعتماد والاتصال بالمزود… لا تُحفظ البيانات أثناء الاختبار." }); testConnection.mutate(payload()); }} variant="outline" className="border-white/15 text-white hover:bg-white/5 hover:text-white">{testConnection.isPending ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <ShieldCheck className="ml-2 h-4 w-4" />}{testConnection.isPending ? "جاري اختبار الاتصال…" : "اختبار الاتصال"}</Button><Button disabled={pending} className="bg-[#F5B800] text-[#0D1117] hover:bg-[#ffd23f]"><ShieldCheck className="ml-2 h-4 w-4" />حفظ إعداد {channel === "whatsapp" ? "WhatsApp" : "SMS"}</Button></div>{result ? <div className={`rounded-xl border p-3 text-sm leading-6 ${resultClass}`} role="status"><strong>{result.ok ? "نجح اختبار الاتصال." : testConnection.isPending ? "جاري التحقق…" : "لم ينجح اختبار الاتصال."}</strong><span className="mr-1">{result.message}</span></div> : null}</form></CardContent></Card>;
}

function SmsProviderFields({ existing }: { existing: any }) {
  const [provider, setProvider] = useState(existing?.provider ?? "jawwal_bulk_sms");
  const isJawwal = provider === "jawwal_bulk_sms";
  return <><Field label="مزود SMS"><select name="provider" value={provider} onChange={(event) => setProvider(event.target.value)} className={inputClass}><option value="jawwal_bulk_sms" className="bg-[#111823]">شركة جوال — Jawwal Bulk SMS</option><option value="twilio" className="bg-[#111823]">Twilio (اختياري)</option></select></Field><Field label={isJawwal ? "اسم المستخدم أو Client ID من جوال" : "Account SID للمزود"}><input name="phoneNumberId" defaultValue={existing?.phoneNumberId ?? ""} className={inputClass} dir="ltr" /></Field><Field label="اسم المرسل أو Sender ID"><input name="senderId" defaultValue={existing?.senderId ?? ""} className={inputClass} dir="ltr" /></Field>{isJawwal ? <div className="space-y-3"><p className="rounded-xl border border-amber-400/20 bg-amber-400/[.06] p-3 text-xs leading-6 text-amber-200">تم اختيار Jawwal Bulk SMS الرسمية. احفظ بيانات الدخول مشفرة بعد الحصول عليها من حساب جوال؛ اختبار حي يحتاج مسار API الرسمي من جوال.</p><div className="grid gap-3 sm:grid-cols-2"><Card className="border-white/8 bg-white/[.025]"><CardContent className="p-4"><p className="text-xs font-bold text-slate-400">رصيد رسائل Jawwal</p><p className="mt-2 text-xl font-extrabold text-amber-200">بانتظار التحقق</p><p className="mt-1 text-xs leading-5 text-slate-500">سيظهر الرصيد والتنبيه عند قرب النفاد بعد توفير مسار رصيد API الرسمي.</p></CardContent></Card><Card className="border-white/8 bg-white/[.025]"><CardContent className="p-4"><p className="text-xs font-bold text-slate-400">رسالة تجريبية</p><p className="mt-2 text-sm font-bold text-white">تحتاج مسار الإرسال الرسمي</p><p className="mt-1 text-xs leading-5 text-slate-500">سيظهر حقل رقم الاختبار وزر الإرسال بعد اعتماد API جوال لمنع إرسال رسالة غير موثقة.</p></CardContent></Card></div></div> : null}</>;
}
function TemplateEditor({ channel, template, pending, onSubmit, siteId, settlementEnabled }: { channel: Channel; template: any; pending: boolean; onSubmit: (input: any) => void; siteId: number; settlementEnabled: boolean }) { const [body, setBody] = useState(template?.body ?? defaultTemplates[channel]); const textareaRef = useRef<HTMLTextAreaElement>(null); useEffect(() => setBody(template?.body ?? defaultTemplates[channel]), [template?.body, channel]); const insertVariable = (variable: string) => { const textarea = textareaRef.current; const start = textarea?.selectionStart ?? body.length; const end = textarea?.selectionEnd ?? body.length; setBody(`${body.slice(0, start)}${variable}${body.slice(end)}`); requestAnimationFrame(() => { textarea?.focus(); textarea?.setSelectionRange(start + variable.length, start + variable.length); }); }; const sms = segmentArabicSms(body); return <Card className="border-white/8 bg-[#111823] shadow-panel"><CardContent className="p-5"><div className="flex items-center gap-2"><FileText className="h-4 w-4 text-[#F5B800]" /><h2 className="font-bold text-white">قالب فاتورة {channel === "whatsapp" ? "WhatsApp" : "SMS"}</h2></div><p className="mt-2 text-xs leading-6 text-slate-500">ضع المؤشر في النص ثم اضغط المتغير المطلوب؛ تستبدل القيم تلقائياً عند إصدار الفاتورة.</p><div className="mt-3 rounded-xl border border-[#F5B800]/15 bg-[#F5B800]/[.025] p-3">
  <p className="text-xs font-bold text-slate-300">المتغيرات الجاهزة</p>
  <p className="mt-1 text-[11px] leading-5 text-slate-500">اختر أي متغير لإضافته إلى موضع المؤشر في الرسالة. سيستخدم النظام القيمة الفعلية عند الإرسال.</p>
  <div className="mt-3 grid gap-2 sm:grid-cols-2">
    {messageVariableOptions.map((item) => <Button type="button" size="sm" variant="outline" onClick={() => insertVariable(item.token)} className="h-auto min-h-10 justify-start border-white/10 bg-white/[.02] text-right text-slate-200 hover:border-[#F5B800]/35 hover:bg-[#F5B800]/10 hover:text-[#ffd23f]" key={item.token} title={item.description}>
      <span className="flex min-w-0 flex-col items-start"><span className="font-bold">+ {item.label}</span><code className="mt-0.5 text-[10px] text-slate-500" dir="ltr">{item.token}</code></span>
    </Button>)}
  </div>
</div><form className="mt-4 space-y-3" onSubmit={(e: FormEvent<HTMLFormElement>) => { e.preventDefault(); onSubmit({ siteId, channel, body, isActive: (new FormData(e.currentTarget).get("isActive") === "on") }); }}><textarea ref={textareaRef} required name="body" value={body} onChange={(e) => setBody(e.target.value)} className="min-h-36 w-full rounded-xl border border-white/10 bg-white/[.025] p-3 text-sm leading-7 text-white outline-none focus:border-[#F5B800]/70" />{channel === "sms" ? <div className={`rounded-xl border px-3 py-2 text-xs ${sms.segmentCount > 1 ? "border-amber-400/25 bg-amber-400/[.06] text-amber-200" : "border-emerald-400/20 bg-emerald-400/[.04] text-emerald-200"}`}><strong>{sms.characterCount} حرفاً · {sms.segmentCount} رسالة SMS</strong><span className="mr-2 text-slate-400">النص العربي يُحسب Unicode: حتى 70 حرفاً للرسالة الواحدة و67 لكل جزء إضافي.</span></div> : null}<div className="grid gap-3 sm:grid-cols-2"><label className="flex items-center gap-2 text-sm text-slate-400"><input defaultChecked={template?.isActive ?? true} name="isActive" type="checkbox" className="accent-[#F5B800]" />استخدام هذا القالب عند إصدار الفاتورة</label><p className="text-xs leading-6 text-slate-500">المعاينة أدناه تتحدث تلقائياً ولا ترسل أي رسالة.</p></div><div className="rounded-xl border border-[#F5B800]/25 bg-[#F5B800]/[.05] p-4"><p className="text-xs font-bold text-[#F5B800]">معاينة حية للرسالة النهائية</p><p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-white">{previewMessageTemplate(body, settlementEnabled)}</p><p className="mt-3 text-[11px] text-slate-500">تستخدم المعاينة بيانات افتراضية للمشترك والفاتورة قبل الحفظ أو الإرسال.</p></div><Button disabled={pending} className="w-full bg-[#F5B800] text-[#0D1117] hover:bg-[#ffd23f]">{pending ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : null}حفظ قالب {channel === "whatsapp" ? "WhatsApp" : "SMS"}</Button></form></CardContent></Card>; }
const receiptVariables = ["{{subscriber_name}}", "{{payment_no}}", "{{payment_amount}}", "{{invoice_no}}", "{{balance_due}}"];
const defaultReceiptSmsTemplate = "مرحباً {{subscriber_name}}، تم استلام دفعة بقيمة {{payment_amount}} عن فاتورتك رقم {{invoice_no}}. رقم الإيصال: {{payment_no}}. الرصيد المتبقي: {{balance_due}}.";
const formatReceiptPreviewAmount = (value: string, settlementEnabled: boolean) => formatPreviewAmount(value, settlementEnabled);
const previewReceiptTemplate = (body: string, settlementEnabled: boolean) => { const values: Record<string, string> = { subscriber_name: "أحمد علي", payment_no: "PAY-2026-0012", payment_amount: formatReceiptPreviewAmount("40.45", settlementEnabled), invoice_no: "INV-2026-00125", balance_due: formatReceiptPreviewAmount("52.26", settlementEnabled) }; return body.replace(/{{\s*(subscriber_name|payment_no|payment_amount|invoice_no|balance_due)\s*}}/g, (_, key) => values[key] ?? ""); };
function PaymentReceiptSmsEditor({ template, pending, onSubmit, siteId, settlementEnabled }: { template: any; pending: boolean; onSubmit: (input: any) => void; siteId: number; settlementEnabled: boolean }) { const [body, setBody] = useState(template?.body ?? defaultReceiptSmsTemplate); const [preview, setPreview] = useState(false); useEffect(() => setBody(template?.body ?? defaultReceiptSmsTemplate), [template?.body]); const sms = segmentArabicSms(body); return <Card className="border-emerald-400/15 bg-[#111823] shadow-panel"><CardContent className="p-5"><div className="flex items-center gap-2"><MessageSquareText className="h-4 w-4 text-emerald-300" /><h2 className="font-bold text-white">قالب إيصال الدفع عبر SMS</h2></div><p className="mt-2 text-xs leading-6 text-slate-500">يرسل إلى رقم المشترك الدولي المسجل عند اختيار SMS من إيصال الدفعة الجزئية.</p><div className="mt-3 flex flex-wrap gap-2">{receiptVariables.map((item) => <code className="rounded bg-emerald-400/10 px-2 py-1 text-[11px] text-emerald-200" key={item}>{item}</code>)}</div><form className="mt-4 space-y-3" onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); onSubmit({ siteId, body, isActive: new FormData(event.currentTarget).get("isActive") === "on" }); }}><textarea required value={body} onChange={(event) => setBody(event.target.value)} className="min-h-36 w-full rounded-xl border border-white/10 bg-white/[.025] p-3 text-sm leading-7 text-white outline-none focus:border-emerald-400/70" /><div aria-live="polite" className={`rounded-xl border px-3 py-2 text-xs ${sms.segmentCount > 1 ? "border-amber-400/25 bg-amber-400/[.06] text-amber-200" : "border-emerald-400/20 bg-emerald-400/[.04] text-emerald-200"}`}><strong>{sms.characterCount} حرفاً · {sms.segmentCount} رسالة SMS</strong><p className="mt-1 text-slate-400">تقدير للنص الحالي: حتى 70 حرفاً للرسالة الواحدة و67 حرفاً لكل جزء إضافي. قد يتغير العدد بعد استبدال المتغيرات بقيمها الفعلية.</p></div><div className="grid gap-3 sm:grid-cols-2"><label className="flex items-center gap-2 text-sm text-slate-400"><input defaultChecked={template?.isActive ?? true} name="isActive" type="checkbox" className="accent-emerald-400" />استخدام هذا القالب عند إرسال الإيصال</label><Button type="button" variant="outline" onClick={() => setPreview((value) => !value)} className="border-white/15 text-white hover:bg-white/5 hover:text-white"><Eye className="ml-2 h-4 w-4" />معاينة الرسالة</Button></div>{preview ? <div className="rounded-xl border border-emerald-400/25 bg-emerald-400/[.05] p-4"><p className="text-xs font-bold text-emerald-300">معاينة إيصال SMS</p><p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-white">{previewReceiptTemplate(body, settlementEnabled)}</p></div> : null}<Button disabled={pending} className="w-full bg-emerald-400 text-[#0D1117] hover:bg-emerald-300">حفظ قالب إيصال SMS</Button></form></CardContent></Card>; }
function InvoiceSmsQueue({ rows, config, siteId }: { rows: any[]; config: any; siteId: number }) {
  const utils = trpc.useUtils();
  const [sendingId, setSendingId] = useState<number | null>(null);
  const [sendingAll, setSendingAll] = useState(false);
  const pending = rows.filter((r) => r.notification.channel === "sms" && r.notification.status === "pending");
  const now = Date.now();
  const due = pending.filter((r) => !r.notification.scheduledAt || new Date(r.notification.scheduledAt).getTime() <= now);
  const nextAt = pending.map((r) => r.notification.scheduledAt ? new Date(r.notification.scheduledAt).getTime() : Infinity).filter(Number.isFinite).sort((a,b)=>a-b)[0];
  const sendNow = trpc.powerhub.notifications.sendBulkInvoiceSms.useMutation({
    onSuccess: async (result: any) => { await utils.powerhub.notifications.list.invalidate(); toast.info(`نتيجة معالجة الطابور: ${result?.submitted ?? 0} أُرسلت للمزود، ${result?.failed ?? 0} فاشلة، ${result?.skipped ?? 0} متجاوزة${Number(result?.needsReview ?? 0) ? `، ${result.needsReview} تحتاج مراجعة` : ""}.`); },
    onError: (e) => toast.error(e.message),
    onSettled: () => { setSendingId(null); setSendingAll(false); },
  });
  const sendDue = trpc.powerhub.notifications.sendDeferredInvoices.useMutation({
    onSuccess: async (result: any) => { await utils.powerhub.notifications.list.invalidate(); toast.info(`نتيجة الرسائل المستحقة: ${result?.submitted ?? 0} أُرسلت للمزود، ${result?.failed ?? 0} فاشلة، ${result?.skipped ?? 0} متجاوزة${Number(result?.needsReview ?? 0) ? `، ${result.needsReview} تحتاج مراجعة` : ""}. الرسائل المستقبلية لم تُرسل.`); },
    onError: (e) => toast.error(e.message),
    onSettled: () => { setSendingId(null); setSendingAll(false); },
  });
  const fmt = (v:number) => new Date(v).toLocaleString("ar-PS", { dateStyle:"medium", timeStyle:"short" });
  const dispatchOne = (row:any) => { setSendingId(row.notification.id); sendNow.mutate({ siteId, invoiceIds: [Number(row.notification.invoiceId)] }); };
  const dispatchDue = () => { if (!due.length) return; setSendingAll(true); sendDue.mutate({ siteId, invoiceIds: due.slice(0,200).map((r:any)=>Number(r.notification.invoiceId)) }); };
  return <Card className="border-[#F5B800]/20 bg-[#111823] shadow-panel"><CardContent className="p-5">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div><h2 className="font-bold text-white">طابور انتظار رسائل الفواتير</h2><p className="mt-1 text-xs leading-6 text-slate-500">الفواتير التي أُصدرت ودخلت الطابور ولم تُرسل بعد. الرسائل المجدولة تبقى هنا حتى موعد دورة الإرسال.</p></div><div className="flex flex-wrap gap-2"><Badge className="bg-[#F5B800]/10 text-[#F5B800]">{pending.length} منتظرة</Badge><Badge className="bg-emerald-400/10 text-emerald-300">{due.length} مستحقة الآن</Badge><Button type="button" size="sm" onClick={dispatchDue} disabled={!due.length || sendingAll || sendingId !== null || sendDue.isPending}>{sendingAll ? "جارٍ الإرسال..." : "إرسال المستحقة الآن"}</Button></div></div>
    <div className="mt-4 grid gap-3 sm:grid-cols-3"><div className="rounded-xl border border-white/8 p-3"><p className="text-xs text-slate-500">الدورة</p><p className="mt-1 font-bold text-white">{({immediate:"فور الإصدار",weekly:"كل أسبوع",every_10_days:"كل 10 أيام",every_15_days:"كل 15 يومًا",monthly:"كل شهر"} as any)[config?.scheduleMode ?? "immediate"]}</p></div><div className="rounded-xl border border-white/8 p-3"><p className="text-xs text-slate-500">موعد الدفعة القادمة</p><p className="mt-1 font-bold text-white">{nextAt ? fmt(nextAt) : "لا توجد رسائل مجدولة"}</p></div><div className="rounded-xl border border-white/8 p-3"><p className="text-xs text-slate-500">الفواتير في الطابور</p><p className="mt-1 font-bold text-white">{pending.length}</p></div></div>
    <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[900px] text-right text-sm"><thead className="border-b border-white/8 text-xs text-slate-500"><tr><th className="px-3 py-3">المشترك</th><th className="px-3 py-3">الفاتورة</th><th className="px-3 py-3">تاريخ الإصدار</th><th className="px-3 py-3">موعد الإرسال</th><th className="px-3 py-3">الحالة</th><th className="px-3 py-3">إجراء</th></tr></thead><tbody>{pending.slice(0,100).map((r:any)=><tr key={r.notification.id} className="border-b border-white/[.06]"><td className="px-3 py-3 font-bold text-white">{r.subscriber.fullName}</td><td className="px-3 py-3 text-slate-300">{r.invoiceNo ?? "—"}</td><td className="px-3 py-3 text-slate-400">{fmt(new Date(r.notification.createdAt).getTime())}</td><td className="px-3 py-3 text-slate-400">{r.notification.scheduledAt ? fmt(new Date(r.notification.scheduledAt).getTime()) : "الآن"}</td><td className="px-3 py-3"><Badge className={r.notification.scheduledAt && new Date(r.notification.scheduledAt).getTime() > now ? "bg-amber-400/10 text-amber-200" : "bg-emerald-400/10 text-emerald-300"}>{r.notification.scheduledAt && new Date(r.notification.scheduledAt).getTime() > now ? "بانتظار الموعد" : "مستحقة للإرسال"}</Badge></td><td className="px-3 py-3"><Button type="button" size="sm" variant="outline" onClick={()=>dispatchOne(r)} disabled={sendingAll || sendingId !== null || Boolean(r.notification.scheduledAt && new Date(r.notification.scheduledAt).getTime() > now)}>{sendingId === r.notification.id ? "جارٍ..." : r.notification.scheduledAt && new Date(r.notification.scheduledAt).getTime() > now ? "بانتظار الموعد" : "إرسال الآن"}</Button></td></tr>)}{!pending.length ? <tr><td colSpan={6} className="px-3 py-10 text-center text-sm text-slate-500">لا توجد رسائل فواتير في طابور الانتظار حاليًا.</td></tr> : null}</tbody></table></div>
    {pending.length > 100 ? <p className="mt-3 text-xs text-slate-500">يُعرض أول 100 عنصر فقط في الواجهة؛ الطابور الكامل محفوظ في النظام.</p> : null}
  </CardContent></Card>;
}
function PhoneNormalizationTool({ rows, pending, onApply }: { rows: any[]; pending: boolean; onApply: (ids: number[]) => void }) { const ready = rows.filter((row) => row.status === "ready"); const manual = rows.filter((row) => row.status === "manual"); return <Card className="border-sky-400/15 bg-[#111823] shadow-panel"><CardContent className="p-5"><div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="font-bold text-white">مراجعة الأرقام القديمة</h2><p className="mt-1 text-sm leading-6 text-slate-500">يحدّث النظام فقط الصيغ القابلة للتحقق مثل بادئة 00 أو المسافات؛ لا يخمّن رمز الدولة للأرقام المحلية.</p></div><Button disabled={pending || !ready.length} onClick={() => onApply(ready.map((row) => row.id))} className="bg-sky-400 text-[#0D1117] hover:bg-sky-300">تحديث {ready.length} رقم جاهز</Button></div><div className="mt-4 grid gap-3 lg:grid-cols-2"><div className="rounded-xl border border-emerald-400/15 bg-emerald-400/[.035] p-4"><p className="text-sm font-bold text-emerald-200">جاهز للتحديث التلقائي ({ready.length})</p>{ready.slice(0, 6).map((row) => <p className="mt-2 text-xs text-slate-300" key={row.id}>{row.fullName}: <span dir="ltr">{row.phone} → {row.normalizedPhone}</span></p>)}{!ready.length ? <p className="mt-2 text-xs text-slate-500">لا توجد أرقام تحتاج توحيد صيغة تلقائياً.</p> : null}</div><div className="rounded-xl border border-amber-400/15 bg-amber-400/[.035] p-4"><p className="text-sm font-bold text-amber-200">تحتاج مراجعة يدوية ({manual.length})</p>{manual.slice(0, 6).map((row) => <p className="mt-2 text-xs text-slate-300" key={row.id}>{row.fullName}: <span dir="ltr">{row.phone}</span></p>)}{!manual.length ? <p className="mt-2 text-xs text-slate-500">لا توجد أرقام محلية غير مكتملة.</p> : null}</div></div></CardContent></Card>; }

function TweetSmsQuotaCard({quota,packages=[],request,requestLoading,requestError,requesting,onRetry,onRequest}:{
 quota:any;packages?:any[];request?:any;requestLoading?:boolean;requestError?:boolean;requesting?:boolean;onRetry?:()=>unknown;onRequest?:(packageId:number)=>void;
}) {
 const [selected,setSelected]=useState("");
 const total=Number(quota?.total??0),used=Number(quota?.used??0),remaining=Number(quota?.remaining??0);
 const providerLimit=Number(quota?.providerMonthlyLimit??0),providerUsed=Number(quota?.providerMonthlyUsed??0);
 const pending=["pending","reviewing"].includes(String(request?.status??""))||request?.ledgerStatus==="pending";
 const selectedId=selected||String(packages[0]?.id??"");
 const money=(pkg:any)=>Number(pkg?.price??0)>0?`${Number(pkg.price).toLocaleString("ar",{maximumFractionDigits:2})} ${pkg.currency==="ILS"?"₪":pkg.currency}`:"السعر يحدده الإدارة";
 return <Card className="border-[#F5B800]/20 bg-[#111823] shadow-panel"><CardContent className="space-y-5 p-5">
  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between"><div><h2 className="font-bold text-white">محفظة رسائل SMS الدائمة</h2><p className="mt-1 max-w-2xl text-sm leading-6 text-slate-400">الرصيد المدفوع لا يتجدد ولا تنتهي صلاحيته بانتهاء الاشتراك. الإرسال يتطلب اشتراكاً فعالاً وحداً متاحاً لدى مزود الرسائل.</p></div><Badge className="w-fit bg-emerald-400/10 text-emerald-300">رصيد غير منتهي الصلاحية</Badge></div>
  <div className="grid gap-3 sm:grid-cols-3"><div className="rounded-xl border border-white/8 bg-white/[.025] p-3"><p className="text-xs text-slate-500">إجمالي الرصيد المشحون</p><p className="mt-1 font-display text-xl font-bold text-[#F5B800]">{total.toLocaleString("ar")}</p></div><div className="rounded-xl border border-white/8 bg-white/[.025] p-3"><p className="text-xs text-slate-500">المستهلك (مقاطع)</p><p className="mt-1 font-display text-xl font-bold text-slate-200">{used.toLocaleString("ar")}</p></div><div className="rounded-xl border border-white/8 bg-white/[.025] p-3"><p className="text-xs text-slate-500">المتبقي</p><p className="mt-1 font-display text-xl font-bold text-emerald-300">{remaining.toLocaleString("ar")}</p></div></div>
  <div className="rounded-xl border border-sky-300/15 bg-sky-300/[.035] p-4"><p className="font-bold text-white">حد مزود الخدمة الشهري</p><p className="mt-1 text-sm text-slate-400">هذا حد إرسال مستقل وليس رصيداً مدفوعاً لصاحب المولد.</p><p className="mt-2 text-sm font-bold text-sky-200">{providerLimit>0?`${providerUsed.toLocaleString("ar")} من ${providerLimit.toLocaleString("ar")} مقطع مستخدم، والمتبقي ${Math.max(0,providerLimit-providerUsed).toLocaleString("ar")}`:"لا يوجد حد شهري رقمي مضبوط لدى مزود الخدمة."}</p></div>
  <div className="rounded-xl border border-white/8 bg-white/[.018] p-4"><h3 className="font-bold text-white">شراء حزمة رسائل مستقلة</h3><p className="mt-1 text-xs leading-5 text-slate-400">اختر حزمة معرفة من إدارة المنصة. لا يضاف الرصيد إلا بعد اعتماد الطلب في قاعدة البيانات.</p>
   {requestError?<div className="mt-3 flex items-center justify-between gap-3"><p className="text-sm text-rose-200">تعذر تحميل حالة الطلب السابق. أعد المحاولة قبل إرسال طلب جديد.</p><Button type="button" variant="outline" onClick={()=>{void onRetry?.();}}>إعادة المحاولة</Button></div>
   :requestLoading?<p className="mt-3 text-sm text-slate-400">جارٍ التحقق من حالة الطلب…</p>
   :pending?<p className="mt-3 rounded-lg border border-amber-300/20 p-3 text-sm font-bold text-amber-200">لديك طلب قيد المراجعة ({Number(request?.requestedMessages??0).toLocaleString("ar")} رسالة). لن يُسمح بطلب آخر قبل حسمه.</p>
   :request?.status==="approved"?<p className="mt-3 text-sm font-bold text-emerald-300">تمت الموافقة على آخر طلب؛ تحقق من الرصيد المشحون أعلاه.</p>
   :request?.status==="rejected"?<p className="mt-3 text-sm font-bold text-rose-300">رُفض آخر طلب ويمكنك اختيار حزمة أخرى.</p>
   :request?.status==="cancelled"?<p className="mt-3 text-sm text-slate-400">أُلغي آخر طلب ويمكنك اختيار حزمة أخرى.</p>:null}
   <div className="mt-3 flex flex-col gap-2 sm:flex-row"><select aria-label="اختيار حزمة رصيد الرسائل" value={selectedId} onChange={e=>setSelected(e.target.value)} disabled={!packages.length||pending||requestLoading||requestError||requesting} className="h-10 min-w-0 flex-1 rounded-xl border border-white/15 bg-[#0D1117] px-3 text-sm text-white disabled:opacity-50">{!packages.length&&<option value="">لا توجد حزم مفعلة حالياً</option>}{packages.map((pkg:any)=><option key={pkg.id} value={String(pkg.id)}>{pkg.name} — {Number(pkg.messages).toLocaleString("ar")} رسالة — {money(pkg)}</option>)}</select><Button type="button" disabled={!packages.length||!selectedId||pending||requestLoading||requestError||requesting} onClick={()=>onRequest?.(Number(selectedId))} className="bg-[#F5B800] font-bold text-[#0D1117] hover:bg-[#ffd23f]">{requesting?"جارٍ إرسال الطلب…":"طلب هذه الحزمة"}</Button></div>
  </div>
 </CardContent></Card>;
}

function SmsDailyUsageCard({ data, loading }: { data: any; loading: boolean }) { const points = data?.points ?? []; const max = Math.max(1, ...points.map((point: any) => Number(point.count ?? 0))); const percent = data?.total ? Math.min(100, (Number(data.used ?? 0) / Number(data.total)) * 100) : 0; return <Card className="border-[#F5B800]/20 bg-[#111823] shadow-panel"><CardContent className="p-5"><div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between"><div><h2 className="font-bold text-white">استهلاك رسائل SMS اليومي</h2><p className="mt-1 text-xs text-slate-500">آخر 14 يوماً من الرسائل التي تمت معالجتها بنجاح.</p></div><div className="rounded-xl border border-emerald-400/20 bg-emerald-400/[.06] px-4 py-3 text-right"><p className="text-xs text-slate-400">الرصيد المتبقي</p><p className="mt-1 text-2xl font-extrabold text-emerald-300">{data?.remaining ?? 0}</p><p className="mt-1 text-xs text-slate-500">من {data?.total ?? 0} رسالة · {percent.toFixed(0)}% مستخدم</p></div></div>{loading ? <Skeleton className="mt-6 h-36 w-full" /> : <div className="mt-6"><div className="flex h-36 items-end gap-1.5 border-b border-white/10 px-1">{points.map((point: any) => <div key={point.date} className="flex h-full flex-1 flex-col items-center justify-end gap-2" title={`${point.date}: ${point.count} رسالة`}><span className="text-[10px] font-bold text-[#F5B800]">{point.count || ""}</span><div className="w-full max-w-8 rounded-t-md bg-[#F5B800] transition-all" style={{ height: `${Math.max(point.count ? 8 : 2, (Number(point.count) / max) * 100)}%` }} /><span className="text-[9px] text-slate-500">{String(point.date).slice(5)}</span></div>)}</div><div className="mt-4 h-2 overflow-hidden rounded-full bg-slate-800"><div className={`h-full rounded-full ${percent >= 100 ? "bg-rose-400" : percent >= 80 ? "bg-amber-300" : "bg-emerald-400"}`} style={{ width: `${percent}%` }} /></div></div>}</CardContent></Card>; }

function ScheduleRunLog({ rows, loading }: { rows: any[]; loading: boolean }) { return <Card className="border-sky-400/15 bg-[#111823] shadow-panel"><CardContent className="p-0"><div className="border-b border-white/8 px-5 py-4"><h2 className="font-bold text-white">سجل معالجة SMS الفواتير الآلي</h2><p className="mt-1 text-xs text-slate-500">سجل تقني داخلي لمعالجة طابور فواتير SMS؛ لا يمثل جدولة يحددها صاحب المولد.</p></div>{loading ? <div className="space-y-3 p-5"><Skeleton className="h-5 w-full" /><Skeleton className="h-5 w-5/6" /><Skeleton className="h-5 w-2/3" /></div> : <div className="overflow-x-auto"><table className="w-full min-w-[860px] text-right text-sm"><thead className="border-b border-white/8 text-xs text-slate-500"><tr><th className="px-5 py-3">وقت التشغيل</th><th className="px-4 py-3">الحالة</th><th className="px-4 py-3">ممسوحة</th><th className="px-4 py-3">مرسلة</th><th className="px-4 py-3">فاشلة</th><th className="px-4 py-3">متجاوزة</th><th className="px-4 py-3">الخطأ</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id} className="border-b border-white/[.06]"><td className="px-5 py-4 text-slate-300">{new Date(row.startedAt).toLocaleString("ar-IQ")}</td><td className="px-4 py-4"><Badge className={row.status === "success" ? "bg-emerald-400/10 text-emerald-300" : "bg-rose-400/10 text-rose-300"}>{row.status === "success" ? "نجح التشغيل" : "فشل التشغيل"}</Badge></td><td className="px-4 py-4 text-slate-300">{row.scanned}</td><td className="px-4 py-4 text-emerald-300">{row.submitted}</td><td className="px-4 py-4 text-rose-300">{row.failed}</td><td className="px-4 py-4 text-amber-200">{row.skipped}</td><td className="max-w-80 px-4 py-4 text-xs text-rose-200">{row.error ?? "—"}</td></tr>)}{!rows.length && <tr><td colSpan={7} className="px-5 py-10 text-center text-sm text-slate-500">لم تُنفذ المهمة المجدولة بعد.</td></tr>}</tbody></table></div>}</CardContent></Card>; }
