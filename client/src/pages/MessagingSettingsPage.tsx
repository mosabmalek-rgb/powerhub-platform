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
import { BellRing, CircleAlert, Eye, FileText, KeyRound, Loader2, MessageSquareText, RotateCcw, ShieldCheck, WalletCards } from "lucide-react";
import { FormEvent, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";

type Channel = "whatsapp" | "sms";

const inputClass = "h-10 w-full rounded-xl border border-white/10 bg-white/[0.025] px-3 text-sm text-white outline-none transition focus:border-[#F5B800]/70 focus:ring-2 focus:ring-[#F5B800]/15";
const defaultTemplates: Record<Channel, string> = {
  whatsapp: "مرحباً {{subscriber_name}}، صدرت فاتورتك رقم {{invoice_no}} عن فترة {{billing_period}} بإجمالي {{total_amount}}. تاريخ الاستحقاق: {{due_date}}.",
  sms: "PowerHub: {{subscriber_name}}، فاتورتك {{invoice_no}} للفترة {{billing_period}} بقيمة {{total_amount}}. الاستحقاق: {{due_date}}.",
};
const variableLabels = ["{{subscriber_name}}", "{{invoice_no}}", "{{billing_period}}", "{{total_amount}}", "{{due_date}}"];
const variableButtonLabels: Record<string, string> = { "{{subscriber_name}}": "اسم المشترك", "{{invoice_no}}": "رقم الفاتورة", "{{billing_period}}": "فترة الفوترة", "{{total_amount}}": "قيمة الفاتورة", "{{due_date}}": "تاريخ الاستحقاق" };
const previewValues: Record<string, string> = { subscriber_name: "أحمد علي", invoice_no: "INV-2026-00125", billing_period: "آب 2026", total_amount: "33,000 د.ع", due_date: "31 آب 2026" };
const statusLabels: Record<string, string> = { pending: "بانتظار المعالجة", processing: "قيد المعالجة", submitted: "مرسلة", delivered: "مرسلة", read: "مرسلة", failed: "غير مرسلة" };
const previewTemplate = (body: string) => body.replace(/{{\s*(subscriber_name|invoice_no|billing_period|total_amount|due_date)\s*}}/g, (_, key) => previewValues[key] ?? "");

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="block"><span className="mb-2 block text-xs font-bold text-slate-400">{label}</span>{children}</label>; }

function FailedSmsPanel({ siteId }: { siteId: number }) {
  const utils = trpc.useUtils();
  const failedQuery = trpc.powerhub.notifications.listFailedSms.useQuery(
    { siteId },
    { refetchInterval: 15000 }
  );
  const retry = trpc.powerhub.notifications.retryFailedSmsBatch.useMutation({
    onSuccess: async (result) => {
      await utils.powerhub.notifications.listFailedSms.invalidate();
      toast.success(`تمت معالجة إعادة الإرسال: ${result.submitted} ناجحة، ${result.failed} فاشلة، ${result.skipped} متجاوزة.`);
    },
    onError: (error) => toast.error(error.message),
  });
  const rows = failedQuery.data ?? [];
  const [selected, setSelected] = useState<number[]>([]);
  useEffect(() => setSelected((current) => current.filter((id) => rows.some((row) => row.notification.id === id))), [rows]);
  const toggle = (id: number) => setSelected((current) => current.includes(id) ? current.filter((x) => x !== id) : [...current, id]);
  const retrySelected = () => {
    if (!selected.length) return toast.error("حدد رسالة فاشلة واحدة على الأقل.");
    retry.mutate({ siteId, notificationIds: selected });
  };
  return <Card className="border-rose-400/20 bg-rose-400/[.035]">
    <CardContent className="space-y-4 p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2"><CircleAlert className="h-5 w-5 text-rose-300" /><h2 className="font-bold text-white">الرسائل الفاشلة</h2></div>
          <p className="mt-1 text-sm leading-6 text-slate-400">مكان موحّد لرسائل SMS التي لم تُرسل، سواء أُنشئت آلياً مع إصدار الفاتورة أو أُرسلت يدوياً.</p>
        </div>
        <Button type="button" variant="outline" onClick={() => failedQuery.refetch()} disabled={failedQuery.isFetching}><RotateCcw className={`ml-2 h-4 w-4 ${failedQuery.isFetching ? "animate-spin" : ""}`} />تحديث</Button>
      </div>
      {selected.length > 0 ? <div className="flex items-center justify-between rounded-lg border border-sky-400/20 bg-sky-400/5 p-3"><span className="text-sm text-slate-300">تم تحديد {selected.length} رسالة</span><Button type="button" onClick={retrySelected} disabled={retry.isPending} className="bg-sky-400 text-[#0D1117] hover:bg-sky-300">{retry.isPending ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : null}إعادة إرسال المحدد</Button></div> : null}
      {failedQuery.isLoading ? <div className="py-8 text-center text-slate-400">جارٍ تحميل الرسائل الفاشلة...</div> : rows.length === 0 ? <div className="rounded-lg border border-white/10 bg-black/10 p-8 text-center text-sm text-slate-400">لا توجد حالياً رسائل SMS غير مرسلة.</div> :
        <div className="overflow-x-auto"><table className="w-full text-right text-sm"><thead><tr className="border-b border-white/10 text-slate-400">
          <th className="px-3 py-3"><input type="checkbox" aria-label="تحديد كل الرسائل الفاشلة" checked={selected.length === rows.length && rows.length > 0} onChange={() => setSelected(selected.length === rows.length ? [] : rows.map((row) => row.notification.id))} /></th>
          <th className="px-3 py-3">المشترك</th><th className="px-3 py-3">النوع</th><th className="px-3 py-3">المصدر</th><th className="px-3 py-3">الحالة</th><th className="px-3 py-3">المحاولات</th><th className="px-3 py-3">آخر خطأ</th><th className="px-3 py-3">الإجراء</th>
        </tr></thead><tbody>
          {rows.map((row) => <tr key={row.notification.id} className="border-b border-white/5">
            <td className="px-3 py-3"><input type="checkbox" checked={selected.includes(row.notification.id)} onChange={() => toggle(row.notification.id)} aria-label={`تحديد رسالة ${row.notification.id}`} /></td>
            <td className="px-3 py-3"><div className="font-medium text-white">{row.subscriber.name}</div><div className="text-xs text-slate-500">{row.subscriber.phone}</div>{row.invoice ? <div className="text-xs text-slate-500">فاتورة {row.invoice.invoiceNo}</div> : null}</td>
            <td className="px-3 py-3 text-slate-300">{row.notification.eventType === "invoice_issued" ? "فاتورة" : row.notification.eventType === "payment_reminder" ? "تذكير" : row.notification.eventType === "payment_received" ? "إيصال دفع" : row.notification.eventType}</td>
            <td className="px-3 py-3">{row.source === "automatic" ? <Badge className="bg-sky-400/10 text-sky-300">آلي</Badge> : <Badge className="bg-amber-400/10 text-amber-200">يدوي</Badge>}</td>
            <td className="px-3 py-3"><Badge className="bg-rose-400/10 text-rose-300">غير مرسلة</Badge></td>
            <td className="px-3 py-3 text-slate-300">{row.notification.attempts}</td>
            <td className="max-w-xs px-3 py-3 text-xs text-rose-200">{row.notification.lastError ?? "—"}</td>
            <td className="px-3 py-3"><Button type="button" size="sm" variant="outline" disabled={row.notification.status !== "failed" || retry.isPending} onClick={() => retry.mutate({ siteId, notificationIds: [row.notification.id] })}>إعادة إرسال</Button></td>
          </tr>)}
        </tbody></table></div>}
    </CardContent>
  </Card>;
}

export default function MessagingSettingsPage() {
  const { isAuthenticated, loading } = useAuth();
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();  const [retryingNotificationId, setRetryingNotificationId] = useState<number | undefined>();
  const retryInvoiceNotification = trpc.powerhub.notifications.retryFailedInvoiceNotification.useMutation({
    onSuccess: async () => { setRetryingNotificationId(undefined); await notificationsQuery.refetch(); },
    onError: () => setRetryingNotificationId(undefined),
  });
  const retryPaymentReceipt = trpc.powerhub.notifications.retryPaymentReceipt.useMutation({
    onSuccess: async () => { setRetryingNotificationId(undefined); await receiptsQuery.refetch(); },
    onError: () => setRetryingNotificationId(undefined),
  });

  const sitesQuery = trpc.powerhub.sites.list.useQuery(undefined, { enabled: isAuthenticated });
  const [siteId, setSiteId] = useState<number | null>(null);
  useEffect(() => { if (!siteId && sitesQuery.data?.[0]) setSiteId(sitesQuery.data[0].id); }, [siteId, sitesQuery.data]);
  const enabled = Boolean(isAuthenticated && siteId);
  const accessQuery = trpc.powerhub.staff.myAccess.useQuery({ siteId: siteId ?? 0 }, { enabled });
  const owner = can(accessQuery.data?.role, "manageMessaging");
  const canRetry = can(accessQuery.data?.role, "issueInvoices");
  const canCollect = can(accessQuery.data?.role, "collectPayments");
  const configsQuery = trpc.powerhub.messaging.listConfigurations.useQuery({ siteId: siteId ?? 0 }, { enabled: enabled && owner });
  const policyQuery = trpc.powerhub.messaging.deliveryPolicy.useQuery({ siteId: siteId ?? 0 }, { enabled: enabled && owner });
  const templatesQuery = trpc.powerhub.messaging.listInvoiceTemplates.useQuery({ siteId: siteId ?? 0 }, { enabled: enabled && owner });
  const receiptTemplatesQuery = trpc.powerhub.messaging.listPaymentReceiptTemplates.useQuery({ siteId: siteId ?? 0 }, { enabled: enabled && owner });
  const phoneReviewQuery = trpc.powerhub.subscribers.phoneReview.useQuery({ siteId: siteId ?? 0 }, { enabled: enabled && owner });
  const notificationsQuery = trpc.powerhub.notifications.list.useQuery({ siteId: siteId ?? 0, eventType: "invoice_issued" }, { enabled });
  const receiptsQuery = trpc.powerhub.notifications.list.useQuery({ siteId: siteId ?? 0, eventType: "payment_received" }, { enabled });
  const scheduleRunsQuery = trpc.powerhub.messaging.listScheduleRuns.useQuery({ siteId: siteId ?? 0, limit: 20 }, { enabled: enabled && ["owner", "manager", "accountant"].includes(accessQuery.data?.role ?? "") });
  const smsQuotaQuery = trpc.powerhub.messaging.smsQuota.useQuery({ siteId: siteId ?? 0 }, { enabled: enabled && owner });
  const smsDailyUsageQuery = trpc.powerhub.messaging.smsDailyUsage.useQuery({ siteId: siteId ?? 0 }, { enabled: enabled && owner });
  const canViewFinancialAlerts = ["owner", "manager", "accountant", "viewer"].includes(accessQuery.data?.role ?? "");
  const financialOverviewQuery = trpc.powerhub.dashboard.financialOverview.useQuery({ siteId: siteId ?? 0, scope: "branch" }, { enabled: enabled && canViewFinancialAlerts });
  const refresh = async () => { await Promise.all([utils.powerhub.messaging.listConfigurations.invalidate(), utils.powerhub.messaging.deliveryPolicy.invalidate(), utils.powerhub.messaging.listInvoiceTemplates.invalidate(), utils.powerhub.messaging.listPaymentReceiptTemplates.invalidate(), utils.powerhub.subscribers.phoneReview.invalidate(), utils.powerhub.subscribers.list.invalidate(), utils.powerhub.notifications.list.invalidate(), utils.powerhub.messaging.listScheduleRuns.invalidate(), utils.powerhub.messaging.smsQuota.invalidate(), utils.powerhub.messaging.smsDailyUsage.invalidate(), utils.powerhub.audit.list.invalidate()]); };
  const saveConfig = trpc.powerhub.messaging.saveConfiguration.useMutation({ onSuccess: async () => { await refresh(); toast.success("تم حفظ إعداد الربط المشفر للمستأجر."); }, onError: (e) => toast.error(e.message) });
  const saveTemplate = trpc.powerhub.messaging.saveInvoiceTemplate.useMutation({ onSuccess: async () => { await refresh(); toast.success("تم حفظ قالب رسالة الفاتورة."); }, onError: (e) => toast.error(e.message) });
  const saveReceiptTemplate = trpc.powerhub.messaging.savePaymentReceiptTemplate.useMutation({ onSuccess: async () => { await refresh(); toast.success("تم حفظ قالب إيصال SMS."); }, onError: (e) => toast.error(e.message) });
  const requestSmsPackage = trpc.powerhub.messaging.requestSmsPackage.useMutation({ onSuccess: async () => { await refresh(); toast.success("تم إرسال طلب الحزمة الإضافية للمراجعة."); }, onError: (e) => toast.error(e.message) });
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
  return <DashboardLayout><div className="space-y-6 pb-12"><header className="flex flex-col gap-4 rounded-[24px] border border-white/8 bg-[#111823]/80 p-5 shadow-panel sm:flex-row sm:items-center sm:justify-between"><div><div className="flex items-center gap-2 text-sm font-bold text-[#F5B800]"><MessageSquareText className="h-4 w-4" />رسائل الفواتير</div><h1 className="mt-1 text-2xl font-extrabold text-white">قوالب الفاتورة وحالة الإرسال</h1><p className="mt-2 text-sm text-slate-400">يدير آدمن PowerHub حساب TweetSMS واسم المرسل والحصة الشهرية. يمكنك هنا تخصيص القوالب ومتابعة الإرسال فقط.</p></div>{sitesQuery.data?.length ? <select value={siteId ?? ""} onChange={(e) => setSiteId(Number(e.target.value))} className={inputClass}>{sitesQuery.data.map((site) => <option className="bg-[#111823]" key={site.id} value={site.id}>{site.name}</option>)}</select> : null}</header>
    {!owner ? <Card className="border-white/8 bg-[#111823]"><CardContent className="p-8 text-center text-sm text-slate-500">تحتاج إلى صلاحية <strong className="text-[#F5B800]">إدارة المراسلات</strong> لعرض حالة الرسائل وقوالبها.</CardContent></Card> : <><section className="grid gap-6 xl:grid-cols-2">{available.whatsapp ? <ChannelForm title="إعداد WhatsApp Cloud API" channel="whatsapp" existing={configs.find((item) => item.channel === "whatsapp")} pending={saveConfig.isPending} onSubmit={saveConfig.mutate} siteId={siteId!} /> : null}</section>{owner ? <><TweetSmsQuotaCard quota={smsQuotaQuery.data} /><SmsDailyUsageCard data={smsDailyUsageQuery.data} loading={smsDailyUsageQuery.isLoading} /></> : null}
    {available.sms && owner && siteId ? <AutoSendPolicyCard config={smsConfig} siteId={siteId} /> : null}
      {available.sms && owner && siteId ? <FailedSmsPanel siteId={siteId} /> : null}{open ? <section className="grid gap-6 xl:grid-cols-2">{available.whatsapp ? <TemplateEditor channel="whatsapp" template={templates.find((item) => item.channel === "whatsapp")} pending={saveTemplate.isPending} onSubmit={saveTemplate.mutate} siteId={siteId!} /> : null}{available.sms ? <TemplateEditor channel="sms" template={templates.find((item) => item.channel === "sms")} pending={saveTemplate.isPending} onSubmit={saveTemplate.mutate} siteId={siteId!} /> : null}{available.sms ? <PaymentReceiptSmsEditor template={receiptTemplates.find((item) => item.channel === "sms")} pending={saveReceiptTemplate.isPending} onSubmit={saveReceiptTemplate.mutate} siteId={siteId!} /> : null}</section> : null}</>}
    {canViewFinancialAlerts ? <FinancialCollectionAlerts overview={financialOverviewQuery.data} canCollect={canCollect} onOpenInvoice={(invoiceId: number) => navigate(`/invoices?invoiceId=${invoiceId}`)} onCollect={(row: any) => navigate(`/collections?subscriberId=${row.subscriberId}&invoiceId=${row.invoiceId}`)} /> : null}
    {owner && siteId ? <InvoiceSmsQueue rows={notificationsQuery.data ?? []} config={smsConfig} siteId={siteId} /> : null}
    {owner ? <PhoneNormalizationTool rows={phoneReviewQuery.data ?? []} pending={applyPhoneNormalization.isPending} onApply={(subscriberIds: number[]) => applyPhoneNormalization.mutate({ siteId: siteId!, subscriberIds })} /> : null}
    <InvoiceLog rows={notificationsQuery.data ?? []} canRetry={owner} pendingId={retryingNotificationId} onRetry={(id) => { setRetryingNotificationId(id); retryInvoiceNotification.mutate({ siteId: siteId!, notificationId: id }); }} />
    {owner ? <ReceiptFailureAlerts rows={receiptsQuery.data ?? []} /> : null}
    {owner ? <ScheduleRunLog rows={scheduleRunsQuery.data ?? []} loading={scheduleRunsQuery.isLoading} /> : null}
    <PaymentReceiptLog rows={receiptsQuery.data ?? []} canRetry={owner} pendingId={retryingNotificationId} onRetry={(id) => { setRetryingNotificationId(id); retryPaymentReceipt.mutate({ siteId: siteId!, notificationId: id }); }} />
  </div></DashboardLayout>;
}

function AutoSendPolicyCard({ config, siteId }: { config: any; siteId: number }) {
  const [enabled, setEnabled] = useState(Boolean(config?.autoSendAfterApproval));
  const [mode, setMode] = useState(config?.scheduleMode ?? "immediate");
  const [anchor, setAnchor] = useState(config?.scheduleAnchorAt ? new Date(config.scheduleAnchorAt).toISOString().slice(0,16) : "");
  useEffect(() => { setEnabled(Boolean(config?.autoSendAfterApproval)); setMode(config?.scheduleMode ?? "immediate"); setAnchor(config?.scheduleAnchorAt ? new Date(config.scheduleAnchorAt).toISOString().slice(0,16) : ""); }, [config?.autoSendAfterApproval, config?.scheduleMode, config?.scheduleAnchorAt]);
  const save = trpc.powerhub.messaging.configureInvoiceAutoSend.useMutation({ onSuccess: () => toast.success("تم حفظ دورة إرسال رسائل الفواتير."), onError: (e) => toast.error(e.message) });
  const submit = () => { if (mode !== "immediate" && !anchor) return toast.error("حدد تاريخ ووقت بداية دورة الإرسال."); save.mutate({ siteId, enabled, scheduleMode: mode, scheduleAnchorAt: mode === "immediate" ? undefined : new Date(anchor).toISOString() }); };
  return <Card className="border-sky-400/20 bg-sky-400/[.035]"><CardContent className="space-y-4 p-5">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div><div className="flex items-center gap-2"><ShieldCheck className="h-5 w-5 text-sky-300" /><h2 className="font-bold text-white">الإرسال الآلي لرسائل الفواتير</h2></div><p className="mt-2 text-sm leading-6 text-slate-400">تُنشأ رسالة SMS عند إصدار الفاتورة. عند اختيار دورة مجمعة، تنتظر الرسائل حتى موعد الدفعة ثم تُرسل معًا.</p></div><label className="flex items-center gap-2 text-sm font-bold text-white"><input type="checkbox" checked={enabled} onChange={e=>setEnabled(e.target.checked)} className="accent-[#F5B800]" />تفعيل الإرسال الآلي</label></div>
    <div className="grid gap-3 md:grid-cols-2"><Field label="دورة الإرسال"><select value={mode} onChange={e=>setMode(e.target.value)} disabled={!enabled} className={inputClass}><option value="immediate">فور إصدار الفاتورة</option><option value="weekly">كل أسبوع</option><option value="every_10_days">كل 10 أيام</option><option value="every_15_days">كل 15 يومًا</option><option value="monthly">كل شهر</option></select></Field>{mode !== "immediate" ? <Field label="بداية الدورة (التاريخ والوقت)"><input type="datetime-local" value={anchor} onChange={e=>setAnchor(e.target.value)} disabled={!enabled} className={inputClass} dir="ltr" /></Field> : <div className="rounded-xl border border-white/10 bg-black/10 p-3 text-xs leading-6 text-slate-400">الإرسال الفوري: تُرسل الرسالة عند إصدار الفاتورة، والتنفيذ الفعلي للطابور يتم داخليًا.</div>}</div>
    {mode !== "immediate" ? <p className="text-xs leading-6 text-slate-500">الفواتير الصادرة حتى موعد الدورة تتجمع وتُرسل دفعة واحدة. يمكن الإرسال اليدوي قبل الموعد دون إنشاء رسالة مكررة.</p> : null}
    <div className="flex justify-end"><Button type="button" onClick={submit} disabled={save.isPending || (enabled && mode !== "immediate" && !anchor)} className="bg-[#F5B800] text-[#0D1117] hover:bg-[#ffd23f]">{save.isPending ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : null}حفظ إعداد الإرسال</Button></div>
    <div className="text-xs text-slate-500">الدورات: أسبوعي · كل 10 أيام · كل 15 يومًا · شهري. ولا يحتاج صاحب المولد إلى كتابة Cron أو أي إعداد تقني.</div>
  </CardContent></Card>; }
function TweetSmsQuotaCard({ quota }: { quota: any }) { return <Card className="border-[#F5B800]/20 bg-[#111823] shadow-panel"><CardContent className="p-5"><div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between"><div><h2 className="font-bold text-white">رصيد رسائل TweetSMS</h2><p className="mt-1 text-sm leading-6 text-slate-500">يحدده آدمن PowerHub لكل صاحب مولد ويُحتسب من بداية الشهر الحالي فقط.</p></div><div className="grid grid-cols-3 gap-3 text-center"><div className="rounded-xl border border-white/8 bg-white/[.025] p-3"><p className="text-xs text-slate-500">الحد الشهري</p><p className="mt-1 font-display text-xl font-bold text-[#F5B800]">{quota?.total ?? 0}</p></div><div className="rounded-xl border border-white/8 bg-white/[.025] p-3"><p className="text-xs text-slate-500">المستخدم</p><p className="mt-1 font-display text-xl font-bold text-slate-200">{quota?.used ?? 0}</p></div><div className="rounded-xl border border-white/8 bg-white/[.025] p-3"><p className="text-xs text-slate-500">المتبقي</p><p className="mt-1 font-display text-xl font-bold text-emerald-300">{quota?.remaining ?? 0}</p></div></div></div><p className="mt-4 rounded-xl border border-[#F5B800]/20 bg-[#F5B800]/[.045] p-3 text-xs leading-6 text-[#f9d66a]">لرفع الحد الشهري تواصل مع آدمن PowerHub؛ لا تحتاج إلى إدخال أي إعداد تقني.</p></CardContent></Card>; }
function SmsDailyUsageCard({ data, loading }: { data: any; loading: boolean }) { const points = data?.points ?? []; const max = Math.max(1, ...points.map((point: any) => Number(point.count ?? 0))); const percent = data?.total ? Math.min(100, (Number(data.used ?? 0) / Number(data.total)) * 100) : 0; return <Card className="border-[#F5B800]/20 bg-[#111823] shadow-panel"><CardContent className="p-5"><div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between"><div><h2 className="font-bold text-white">استهلاك رسائل SMS اليومي</h2><p className="mt-1 text-xs text-slate-500">آخر 14 يوماً من الرسائل التي تمت معالجتها بنجاح.</p></div><div className="rounded-xl border border-emerald-400/20 bg-emerald-400/[.06] px-4 py-3 text-right"><p className="text-xs text-slate-400">الرصيد المتبقي</p><p className="mt-1 text-2xl font-extrabold text-emerald-300">{data?.remaining ?? 0}</p><p className="mt-1 text-xs text-slate-500">من {data?.total ?? 0} رسالة · {percent.toFixed(0)}% مستخدم</p></div></div>{loading ? <Skeleton className="mt-6 h-36 w-full" /> : <div className="mt-6"><div className="flex h-36 items-end gap-1.5 border-b border-white/10 px-1">{points.map((point: any) => <div key={point.date} className="flex h-full flex-1 flex-col items-center justify-end gap-2" title={`${point.date}: ${point.count} رسالة`}><span className="text-[10px] font-bold text-[#F5B800]">{point.count || ""}</span><div className="w-full max-w-8 rounded-t-md bg-[#F5B800] transition-all" style={{ height: `${Math.max(point.count ? 8 : 2, (Number(point.count) / max) * 100)}%` }} /><span className="text-[9px] text-slate-500">{String(point.date).slice(5)}</span></div>)}</div><div className="mt-4 h-2 overflow-hidden rounded-full bg-slate-800"><div className={`h-full rounded-full ${percent >= 100 ? "bg-rose-400" : percent >= 80 ? "bg-amber-300" : "bg-emerald-400"}`} style={{ width: `${percent}%` }} /></div></div>}</CardContent></Card>; }
function ScheduleRunLog({ rows, loading }: { rows: any[]; loading: boolean }) { return <Card className="border-sky-400/15 bg-[#111823] shadow-panel"><CardContent className="p-0"><div className="border-b border-white/8 px-5 py-4"><h2 className="font-bold text-white">سجل معالجة SMS الفواتير الآلي</h2><p className="mt-1 text-xs text-slate-500">سجل تقني داخلي لمعالجة طابور فواتير SMS؛ لا يمثل جدولة يحددها صاحب المولد.</p></div>{loading ? <div className="space-y-3 p-5"><Skeleton className="h-5 w-full" /><Skeleton className="h-5 w-5/6" /><Skeleton className="h-5 w-2/3" /></div> : <div className="overflow-x-auto"><table className="w-full min-w-[860px] text-right text-sm"><thead className="border-b border-white/8 text-xs text-slate-500"><tr><th className="px-5 py-3">وقت التشغيل</th><th className="px-4 py-3">الحالة</th><th className="px-4 py-3">ممسوحة</th><th className="px-4 py-3">مرسلة</th><th className="px-4 py-3">فاشلة</th><th className="px-4 py-3">متجاوزة</th><th className="px-4 py-3">الخطأ</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id} className="border-b border-white/[.06]"><td className="px-5 py-4 text-slate-300">{new Date(row.startedAt).toLocaleString("ar-IQ")}</td><td className="px-4 py-4"><Badge className={row.status === "success" ? "bg-emerald-400/10 text-emerald-300" : "bg-rose-400/10 text-rose-300"}>{row.status === "success" ? "نجح التشغيل" : "فشل التشغيل"}</Badge></td><td className="px-4 py-4 text-slate-300">{row.scanned}</td><td className="px-4 py-4 text-emerald-300">{row.submitted}</td><td className="px-4 py-4 text-rose-300">{row.failed}</td><td className="px-4 py-4 text-amber-200">{row.skipped}</td><td className="max-w-80 px-4 py-4 text-xs text-rose-200">{row.error ?? "—"}</td></tr>)}{!rows.length && <tr><td colSpan={7} className="px-5 py-10 text-center text-sm text-slate-500">لم تُنفذ المهمة المجدولة بعد.</td></tr>}</tbody></table></div>}</CardContent></Card>; }
function Stat({ label, value, tone }: { label: string; value: string | number; tone: "gold" | "green" | "red" }) { const color = tone === "green" ? "text-emerald-300" : tone === "red" ? "text-rose-300" : "text-[#F5B800]"; return <Card className="border-white/8 bg-[#111823]"><CardContent className="p-5"><p className="text-sm text-slate-400">{label}</p><p className={`mt-3 text-3xl font-extrabold ${color}`}>{value}</p></CardContent></Card>; }
