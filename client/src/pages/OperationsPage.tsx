import { useAuth } from "@/_core/hooks/useAuth";
import DashboardLayout from "@/components/DashboardLayout";
import { formatReportDate, REPORT_PAYMENT_METHOD_LABELS, REPORT_PAYMENT_METHOD_OPTIONS } from "@/lib/report-design-system";
import { OfflineWorkSyncPanel } from "@/components/OfflineWorkSyncPanel";
import { PaymentMethodCollectionSummary } from "@/components/PaymentMethodCollectionSummary";
import { PowerHubLogo } from "@/components/PowerHubLogo";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { startLogin } from "@/const";
import { useBranchFilter } from "@/hooks/useBranchFilter";
import { trpc } from "@/lib/trpc";
import { enqueueOfflineWork } from "@/lib/offline-work-queue";
import { preparePaymentReceiptImage } from "@/lib/payment-receipt-image";
import { cn } from "@/lib/utils";
import { downloadReportHtmlAsPdf, escapeHtml } from "@/lib/report-pdf";
import { loadExcelJS } from "@/lib/lazy-report-deps";
import { invoiceStatusMeta, outstandingInvoices, summarizeOutstandingInvoices } from "@/lib/invoice-collection-presentation";
import { can } from "@shared/powerhub-rbac";
import { CheckCircle2, ChevronDown, ChevronUp, CircleAlert, ClipboardList, Eye, Fuel, Gauge, ImagePlus, Loader2, Plus, Printer, ReceiptText, Send, ShieldCheck, UsersRound, WalletCards, Zap } from "lucide-react";
import { FormEvent, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

type Section = "subscribers" | "generators" | "readings" | "invoices" | "collections" | "expenses" | "reports" | "notifications" | "audit";

const moduleMeta: Record<Section, { title: string; subtitle: string; icon: typeof UsersRound }> = {
  subscribers: { title: "المشتركون", subtitle: "إدارة ملفات المشتركين والبحث السريع في بياناتهم.", icon: UsersRound },
  generators: { title: "الخدمة والمولدات", subtitle: "الخدمة تضم المشتركين، بينما تسجل المولدات كموارد للقدرة والوقود وساعات التشغيل.", icon: Zap },
  readings: { title: "العدادات والقراءات", subtitle: "تسجيل العدادات والقراءات اليدوية ومراجعة الاستهلاك قبل الفوترة.", icon: Gauge },
  invoices: { title: "الفواتير", subtitle: "ملخص الفواتير؛ الإدارة التفصيلية والفلاتر في مركز الفواتير.", icon: ReceiptText },
  collections: { title: "التحصيلات والمدفوعات", subtitle: "تسجيل الدفعات ومتابعة الإيصالات وتوزيعها على الفواتير.", icon: WalletCards },
  expenses: { title: "المصروفات والربحية", subtitle: "تسجيل الوقود والصيانة والرواتب لفهم الربحية التشغيلية.", icon: Fuel },
  reports: { title: "التقارير", subtitle: "ملخصات تشغيلية ومالية تتحدث من بيانات الخدمة الفعلية.", icon: ClipboardList },
  notifications: { title: "الإشعارات", subtitle: "متابعة رسائل WhatsApp وSMS ونتائج الإرسال والفشل.", icon: CheckCircle2 },
  audit: { title: "سجل التدقيق", subtitle: "سجل غير قابل للحذف للعمليات المالية والتشغيلية الحساسة.", icon: ShieldCheck },
};

const inputClass = "h-10 w-full rounded-xl border border-white/10 bg-white/[0.025] px-3 text-sm text-white outline-none transition placeholder:text-slate-600 focus:border-[#F5B800]/70 focus:ring-2 focus:ring-[#F5B800]/15";
const selectClass = `${inputClass} appearance-none`;

function normalizeSubscriberSearch(value: unknown) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("ar")
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
    .replace(/\s+/g, " ")
    .trim();
}

function formatValue(value: unknown, fractionDigits = 0) {
  const numeric = Number(value ?? 0);
  return new Intl.NumberFormat("ar", { maximumFractionDigits: fractionDigits }).format(Number.isFinite(numeric) ? numeric : 0);
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block text-right"><span className="mb-2 block text-xs font-bold text-slate-400">{label}</span>{children}</label>;
}

function SectionCard({ title, children, className, collapsed, onToggleCollapse }: { title: string; children: ReactNode; className?: string; collapsed?: boolean; onToggleCollapse?: () => void }) {
  return <Card className={cn("border-white/8 bg-[#111823] shadow-panel", className)}><CardContent className="p-0"><div className="flex items-center justify-between gap-3 border-b border-white/8 px-5 py-4"><h2 className="font-bold text-white">{title}</h2>{onToggleCollapse && <Button type="button" size="sm" variant="ghost" aria-expanded={!collapsed} onClick={onToggleCollapse} className="shrink-0 text-[#F5B800]">{collapsed ? <><ChevronDown className="ml-1 h-4 w-4" />فتح البطاقة</> : <><ChevronUp className="ml-1 h-4 w-4" />طي البطاقة</>}</Button>}</div>{!collapsed && <div className="p-5">{children}</div>}</CardContent></Card>;
}

function Empty({ text }: { text: string }) {
  return <div className="rounded-xl border border-dashed border-white/10 bg-white/[0.015] px-4 py-10 text-center text-sm leading-6 text-slate-500">{text}</div>;
}

const statusToneClass = { emerald: "border-emerald-400/25 bg-emerald-400/10 text-emerald-300", amber: "border-amber-400/25 bg-amber-400/10 text-amber-200", rose: "border-rose-400/25 bg-rose-400/10 text-rose-300", slate: "border-white/10 bg-white/5 text-slate-300", sky: "border-sky-400/25 bg-sky-400/10 text-sky-300" } as const;
const paymentMethodLabel = REPORT_PAYMENT_METHOD_LABELS;

function formatDate(value: unknown) { return value ? formatReportDate(value as string | number | Date) : "—"; }
function escapeReceiptHtml(value: unknown) { return String(value ?? "—").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"); }
function printPartialPaymentReceipt({ payment, invoice, subscriber, siteName }: { payment: any; invoice: any; subscriber: any; siteName: string }) {
  const popup = window.open("", "powerhub-payment-receipt", "width=760,height=860");
  if (!popup) { toast.error("تعذر فتح نافذة الطباعة. اسمح بالنوافذ المنبثقة ثم أعد المحاولة."); return; }
  const total = Number(invoice.totalAmount); const paid = Number(invoice.paidAmount); const balance = Number(invoice.balanceDue); const paymentAmount = Number(payment.amount);
  popup.document.write(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>إيصال ${escapeReceiptHtml(payment.paymentNo)}</title><style>@page{size:A4;margin:15mm}*{box-sizing:border-box}body{font-family:Tahoma,Arial,sans-serif;color:#0D1117;margin:0;background:#f5f6f8}.receipt{max-width:720px;margin:0 auto;background:#fff;border:1px solid #e6e9ee;border-radius:18px;overflow:hidden}.head{background:#0D1117;color:#fff;padding:28px 32px;display:flex;justify-content:space-between;gap:24px}.brand{color:#F5B800;font-weight:800;font-size:22px}.eyebrow{color:#F5B800;font-size:12px;font-weight:700;letter-spacing:.04em}.head h1{font-size:24px;margin:8px 0 0}.body{padding:30px 32px}.notice{margin-bottom:22px;border:1px solid #f5b800;background:#fff8df;color:#735400;border-radius:12px;padding:14px 16px;font-weight:700}.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.item{border:1px solid #edf0f4;border-radius:12px;padding:12px}.label{display:block;color:#657080;font-size:12px;margin-bottom:6px}.value{font-weight:700}.amounts{margin-top:22px;border-radius:14px;background:#0D1117;color:#fff;padding:18px}.amounts div{display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid rgba(255,255,255,.12)}.amounts div:last-child{border:0;color:#F5B800;font-size:18px;font-weight:800}.footer{margin-top:28px;padding-top:16px;border-top:1px dashed #cfd5dd;color:#657080;font-size:12px;text-align:center}@media print{body{background:#fff}.receipt{border:0}}</style></head><body><main class="receipt"><header class="head"><div><div class="eyebrow">POWERHUB — إدارة الطاقة بذكاء</div><h1>إيصال تحصيل — دفعة جزئية</h1></div><div class="brand">PowerHub</div></header><section class="body"><div class="notice">تم استلام دفعة جزئية، وما زال الرصيد الموضح أدناه مستحقاً على الفاتورة.</div><div class="grid"><div class="item"><span class="label">المحطة</span><span class="value">${escapeReceiptHtml(siteName)}</span></div><div class="item"><span class="label">رقم الإيصال</span><span class="value" dir="ltr">${escapeReceiptHtml(payment.paymentNo)}</span></div><div class="item"><span class="label">المشترك</span><span class="value">${escapeReceiptHtml(subscriber.fullName)}</span></div><div class="item"><span class="label">رقم الفاتورة</span><span class="value" dir="ltr">${escapeReceiptHtml(invoice.invoiceNo)}</span></div><div class="item"><span class="label">طريقة الدفع</span><span class="value">${escapeReceiptHtml(paymentMethodLabel[payment.paymentMethod] ?? payment.paymentMethod)}</span></div><div class="item"><span class="label">تاريخ التحصيل</span><span class="value">${escapeReceiptHtml(formatDate(payment.paidAt))}</span></div></div><div class="amounts"><div><span>إجمالي الفاتورة</span><strong>${formatValue(total, 2)}</strong></div><div><span>الدفعة المستلمة الآن</span><strong>${formatValue(paymentAmount, 2)}</strong></div><div><span>إجمالي المدفوع</span><strong>${formatValue(paid, 2)}</strong></div><div><span>الرصيد المتبقي</span><strong>${formatValue(balance, 2)}</strong></div></div><p class="footer">هذا الإيصال صادر من PowerHub. احتفظ به كمرجع لعملية التحصيل.</p></section></main><script>window.onload=()=>window.print()<\/script></body></html>`);
  popup.document.close();
}

function ReadOnlyCard() {
  return <SectionCard title="وضع القراءة فقط"><div className="py-8 text-center text-sm leading-7 text-slate-500">لا يتيح دورك تنفيذ هذه العملية في المحطة المحددة. تواصل مع مالك المحطة أو مديرها إذا احتجت صلاحية إضافية.</div></SectionCard>;
}

export default function OperationsPage({ section }: { section: Section }) {
  const { user, loading, isAuthenticated } = useAuth();
  const meta = moduleMeta[section];
  const Icon = meta.icon;
  const utils = trpc.useUtils();
  const sitesQuery = trpc.powerhub.sites.list.useQuery(undefined, { enabled: isAuthenticated });
  const { branchId: siteId, setBranchId: setSiteId } = useBranchFilter(sitesQuery.data);

  const createSite = trpc.powerhub.sites.create.useMutation({
    onSuccess: async () => { await utils.powerhub.sites.list.invalidate(); toast.success("تم إنشاء المحطة بنجاح."); },
    onError: (error) => toast.error(error.message),
  });

  const canQuery = Boolean(siteId && isAuthenticated);
  const accessQuery = trpc.powerhub.staff.myAccess.useQuery({ siteId: siteId ?? 0 }, { enabled: canQuery });
  const powerRole = accessQuery.data?.role;
  const canCreateFinancialRecord = can(powerRole, "collectPayments");
  const canManageExpenses = can(powerRole, "manageExpenses");
  const canManageReadings = can(powerRole, "recordReadings");
  const canManageInvoices = can(powerRole, "issueInvoices");
  const canSendReceipts = can(powerRole, "manageMessaging");
  const canManageSubscribers = can(powerRole, "manageSubscribers");
  const canManageGenerators = can(powerRole, "manageGenerators");
  const canViewAudit = can(powerRole, "viewAudit");
  // Keep only the data dependencies required by the currently visible operational section.
  const needsSubscribers = section === "subscribers" || section === "readings" || section === "collections";
  const needsGenerators = section === "generators" || section === "expenses";
  const needsReadings = section === "readings";
  const needsInvoices = section === "invoices" || section === "collections";
  const needsPayments = section === "collections";
  const needsExpenses = section === "expenses";
  const needsNotifications = section === "notifications";
  const needsAudit = section === "audit" && canViewAudit;
  const needsSummary = section === "expenses" || section === "reports";
  const subscribersQuery = trpc.powerhub.subscribers.list.useQuery({ siteId: siteId ?? 0 }, { enabled: canQuery && needsSubscribers });
  const generatorsQuery = trpc.powerhub.generators.list.useQuery({ siteId: siteId ?? 0 }, { enabled: canQuery && needsGenerators });
  const readingsQuery = trpc.powerhub.readings.page.useQuery({ siteId: siteId ?? 0, limit: 100 }, { enabled: canQuery && needsReadings });
  const invoicesQuery = trpc.powerhub.invoices.page.useQuery({ siteId: siteId ?? 0, limit: 100 }, { enabled: canQuery && needsInvoices });
  const paymentsQuery = trpc.powerhub.payments.page.useQuery({ siteId: siteId ?? 0, limit: 100 }, { enabled: canQuery && needsPayments });
  const readings = readingsQuery.data?.items ?? [];
  const invoices = invoicesQuery.data?.items ?? [];
  const payments = paymentsQuery.data?.items ?? [];
  const notificationsQuery = trpc.powerhub.notifications.list.useQuery({ siteId: siteId ?? 0 }, { enabled: canQuery && needsNotifications });
  const auditQuery = trpc.powerhub.audit.list.useQuery({ siteId: siteId ?? 0 }, { enabled: Boolean(canQuery && needsAudit) });
  const summaryQuery = trpc.powerhub.dashboard.summary.useQuery({ siteId: siteId ?? 0 }, { enabled: canQuery && needsSummary });

  const refreshOperational = async (
    required: Array<() => Promise<unknown>>,
    secondary: Array<() => Promise<unknown>> = [],
  ) => {
    // The server mutation has already succeeded before this runs. Keep the visible
    // result refresh separate from secondary cache invalidation so unrelated data
    // cannot delay the user's confirmation.
    if (required.length > 0) {
      void Promise.all(required.map((refresh) => refresh())).catch(() => {
        toast.warning("نجحت العملية، لكن تعذر تحديث بعض البيانات المعروضة. أعد تحميل العرض للتحقق.");
      });
    }
    if (secondary.length > 0) {
      void Promise.all(secondary.map((refresh) => refresh())).catch(() => {
        toast.warning("نجحت العملية، لكن تعذر تحديث بعض البيانات التابعة. أعد تحميل العرض للتحقق.");
      });
    }
  };

  const addGenerator = trpc.powerhub.generators.create.useMutation({ onSuccess: () => {
    toast.success("تمت إضافة المولد.");
    refreshOperational(
      [() => utils.powerhub.generators.list.invalidate({ siteId: siteId ?? 0 })],
      [
        () => utils.powerhub.dashboard.summary.invalidate({ siteId: siteId ?? 0 }),
        () => utils.powerhub.audit.list.invalidate({ siteId: siteId ?? 0 }),
      ],
    );
  }, onError: (e) => toast.error(e.message) });
  const addReading = trpc.powerhub.readings.create.useMutation({ onSuccess: (result) => {
    toast.success(`تم اعتماد القراءة وإصدار الفاتورة ${result.invoiceNo} تلقائيًا.`);
    refreshOperational(
      [() => utils.powerhub.readings.page.invalidate({ siteId: siteId ?? 0, limit: 100 })],
      [
        // Reading creation issues an invoice. Refresh the active site's collection list and
        // the reading workflow list without polling or invalidating unrelated sites.
        () => utils.powerhub.invoices.page.invalidate({ siteId: siteId ?? 0, limit: 100 }),
        () => utils.powerhub.invoices.page.invalidate({ siteId: siteId ?? 0, limit: 200 }),
        () => utils.powerhub.dashboard.summary.invalidate({ siteId: siteId ?? 0 }),
        () => utils.powerhub.dashboard.financialOverview.invalidate({ siteId: siteId ?? 0, scope: "branch" }),
        () => utils.powerhub.dashboard.periodMetrics.invalidate({ siteId: siteId ?? 0, scope: "branch" }),
        () => utils.powerhub.audit.list.invalidate({ siteId: siteId ?? 0 }),
      ],
    );
  }, onError: (e) => toast.error(e.message) });
  const addPayment = trpc.powerhub.payments.create.useMutation({ onSuccess: () => {
    refreshOperational(
      [
        () => utils.powerhub.invoices.page.invalidate({ siteId: siteId ?? 0, limit: 100 }),
        () => utils.powerhub.payments.page.invalidate({ siteId: siteId ?? 0, limit: 100 }),
      ],
      [
        // Collection sessions and the payment list expose totals derived from the new payment.
        () => utils.powerhub.payments.list.invalidate({ siteId: siteId ?? 0 }),
        () => utils.powerhub.collectorSessions.list.invalidate({ siteId: siteId ?? 0 }),
        () => utils.powerhub.collectorSessions.current.invalidate({ siteId: siteId ?? 0 }),
        () => utils.powerhub.dashboard.summary.invalidate({ siteId: siteId ?? 0 }),
        () => utils.powerhub.dashboard.financialOverview.invalidate({ siteId: siteId ?? 0, scope: "branch" }),
        () => utils.powerhub.dashboard.periodMetrics.invalidate({ siteId: siteId ?? 0, scope: "branch" }),
        () => utils.powerhub.audit.list.invalidate({ siteId: siteId ?? 0 }),
      ],
    );
  } });
  const sendPaymentReceipt = trpc.powerhub.notifications.sendPaymentReceiptSms.useMutation({ onSuccess: (result, variables) => {
    const channelLabel = variables.channel === "whatsapp" ? "WhatsApp" : "SMS";
    if (result.status === "submitted") toast.success(`قَبِل مزود ${channelLabel} طلب إرسال الإيصال؛ هذا لا يؤكد التسليم النهائي.`);
    else if (result.status === "needs_review") toast.warning(`نتيجة إرسال ${channelLabel} غير مؤكدة؛ راجع سجل الرسائل قبل إعادة المحاولة.`);
    else toast.error(`تعذر إرسال إيصال ${channelLabel}؛ راجع سجل الرسائل.`);
    refreshOperational([], [
      () => utils.powerhub.notifications.list.invalidate({ siteId: siteId ?? 0 }),
      () => utils.powerhub.audit.list.invalidate({ siteId: siteId ?? 0 }),
    ]);
  }, onError: (error) => toast.error(error.message) });
  const addExpense = trpc.powerhub.expenses.create.useMutation({ onSuccess: () => {
    toast.success("تم تسجيل المصروف.");
    refreshOperational(
      [
        () => utils.powerhub.expenses.page.invalidate({ siteId: siteId ?? 0, limit: 100 }),
        () => utils.powerhub.dashboard.summary.invalidate({ siteId: siteId ?? 0 }),
        () => utils.powerhub.dashboard.financialOverview.invalidate({ siteId: siteId ?? 0, scope: "branch" }),
        () => utils.powerhub.dashboard.periodMetrics.invalidate({ siteId: siteId ?? 0, scope: "branch" }),
      ],
      [() => utils.powerhub.audit.list.invalidate({ siteId: siteId ?? 0 })],
    );
  }, onError: (e) => toast.error(e.message) });

  const siteOptions = sitesQuery.data ?? [];
  const activeSite = useMemo(() => siteOptions.find((site) => site.id === siteId), [siteId, siteOptions]);

  if (loading) return <DashboardLayout><div className="grid min-h-[60vh] place-items-center"><Loader2 className="h-7 w-7 animate-spin text-[#F5B800]" /></div></DashboardLayout>;

  if (!isAuthenticated) {
    return <DashboardLayout><div className="mx-auto mt-12 max-w-2xl rounded-[28px] border border-[#F5B800]/20 bg-[#111823] p-8 text-center shadow-panel"><PowerHubLogo className="justify-center" /><h1 className="mt-8 text-2xl font-extrabold text-white">سجّل الدخول لتفعيل إدارة البيانات</h1><p className="mx-auto mt-3 max-w-md leading-7 text-slate-400">هذه الواجهة تعرض تصميم PowerHub. يلزم تسجيل الدخول للوصول إلى الخدمات والمولدات والمشتركين والفواتير وبيانات التحصيل الفعلية.</p><Button onClick={() => startLogin()} className="mt-7 bg-[#F5B800] font-bold text-[#0D1117] hover:bg-[#ffd23f]">تسجيل الدخول إلى PowerHub</Button></div></DashboardLayout>;
  }

  if (sitesQuery.isLoading) return <DashboardLayout><div className="grid min-h-[60vh] place-items-center"><Loader2 className="h-7 w-7 animate-spin text-[#F5B800]" /></div></DashboardLayout>;

  if (!siteOptions.length) {
    return <DashboardLayout><div className="mx-auto mt-10 max-w-2xl"><SectionCard title="ابدأ بإعداد خدمتك الأولى"><form className="space-y-4" onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); createSite.mutate({ name: String(data.get("name")), code: String(data.get("code")), city: String(data.get("city") || "") || undefined, address: String(data.get("address") || "") || undefined }); }}><p className="text-sm leading-6 text-slate-400">المشتركون والفواتير والعدادات تتبع للخدمة التي يقدمها صاحب المولد. أضف المولدات لاحقاً كموارد تشغيلية للخدمة.</p><div className="grid gap-4 sm:grid-cols-2"><Field label="اسم الخدمة"><input required name="name" className={inputClass} placeholder="خدمة كهرباء الحي التجاري" /></Field><Field label="رمز الخدمة"><input required name="code" className={inputClass} placeholder="SVC-01" dir="ltr" /></Field><Field label="المدينة"><input name="city" className={inputClass} placeholder="بغداد" /></Field><Field label="العنوان"><input name="address" className={inputClass} placeholder="وصف مختصر للخدمة" /></Field></div><Button disabled={createSite.isPending} className="bg-[#F5B800] font-bold text-[#0D1117] hover:bg-[#ffd23f]"><Plus className="ml-2 h-4 w-4" />إنشاء الخدمة</Button></form></SectionCard></div></DashboardLayout>;
  }

  const header = <header className="flex flex-col gap-4 rounded-[24px] border border-white/8 bg-[#111823]/80 p-5 shadow-panel sm:flex-row sm:items-center sm:justify-between"><div><div className="flex items-center gap-2 text-sm font-bold text-[#F5B800]"><Icon className="h-4 w-4" />{activeSite?.name}</div><h1 className="mt-1 text-2xl font-extrabold text-white">{meta.title}</h1><p className="mt-2 text-sm text-slate-400">{meta.subtitle}</p></div><select aria-label="فلتر الفرع الموحد" value={siteId ?? ""} onChange={(event) => setSiteId(Number(event.target.value))} className="h-10 min-w-44 rounded-xl border border-white/10 bg-white/[0.03] px-3 text-sm font-bold text-white outline-none">{siteOptions.map((site) => <option className="bg-[#111823]" value={site.id} key={site.id}>{site.name}</option>)}</select><Button type="button" variant="outline" onClick={() => window.location.assign("/financial-settlements")} className="border-orange-400/30 text-orange-300">تصحيح عملية مقفلة</Button></header>;

  if (section === "subscribers" && !canManageSubscribers) return <DashboardLayout><div className="space-y-6 pb-12">{header}<ReadOnlyCard /></div></DashboardLayout>;
  if (section === "generators" && !canManageGenerators) return <DashboardLayout><div className="space-y-6 pb-12">{header}<ReadOnlyCard /></div></DashboardLayout>;
  if (section === "readings" && !canManageReadings) return <DashboardLayout><div className="space-y-6 pb-12">{header}<ReadOnlyCard /></div></DashboardLayout>;
  if (section === "invoices" && !canManageInvoices) return <DashboardLayout><div className="space-y-6 pb-12">{header}<ReadOnlyCard /></div></DashboardLayout>;
  if (section === "audit" && !canViewAudit) return <DashboardLayout><div className="space-y-6 pb-12">{header}<ReadOnlyCard /></div></DashboardLayout>;

  const submitPayment = async (payload: Parameters<typeof addPayment.mutate>[0]) => {
    const companyAccountId = Number(payload.companyAccountId);
    if (!Number.isInteger(companyAccountId) || companyAccountId <= 0) throw new Error("اختر الحساب المستقبِل من حسابات الشركة قبل تسجيل التحصيل.");
    // Keep one operation ID across an uncertain network failure and later replay. The
    // server's idempotency contract prevents a second payment if the first request committed.
    const completePayload = { ...payload, clientOperationId: payload.clientOperationId ?? crypto.randomUUID() };
    const queueDraft = async () => {
      if (Number(completePayload.manualDiscountAmount ?? 0) > 0) {
        throw new Error("تعذر تأكيد التحصيل مع الخصم اليدوي دون اتصال. لم نحفظه كتحصيل عادي؛ اتصل بالإنترنت وتحقق من الفاتورة قبل إعادة المحاولة.");
      }
      if (!user?.id) throw new Error("تعذر معرفة المستخدم الحالي لحفظ مسودة التحصيل.");
      await enqueueOfflineWork({
        userId: user.id,
        siteId: siteId!,
        kind: "payment_create",
        clientOperationId: completePayload.clientOperationId,
        payload: {
          subscriberId: completePayload.subscriberId,
          invoiceId: completePayload.invoiceId,
          paymentNo: completePayload.paymentNo,
          amount: completePayload.amount,
          paymentMethod: completePayload.paymentMethod ?? "cash",
          companyAccountId: completePayload.companyAccountId,
          transferFromAccount: completePayload.transferFromAccount,
          transferFromType: completePayload.transferFromType,
          referenceNo: completePayload.referenceNo,
          receiptImageData: completePayload.receiptImageData,
          receiptImageMime: completePayload.receiptImageMime,
        },
      });
      return { queued: true as const };
    };
    if (typeof navigator !== "undefined" && !navigator.onLine) return queueDraft();
    try {
      return await addPayment.mutateAsync(completePayload);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? "");
      const networkFailure = error instanceof TypeError ||
        /failed to fetch|networkerror|network request failed|load failed|fetch failed|connection (?:lost|reset|refused)|timeout/i.test(message);
      if (!networkFailure) throw error;
      const queued = await queueDraft();
      toast.warning("انقطع الاتصال أثناء إرسال التحصيل؛ حُفظت العملية كمسودة للمزامنة. سيُستخدم معرّف العملية نفسه لمنع تكرار التحصيل.");
      return queued;
    }
  };
  return <DashboardLayout><div className="space-y-6 pb-12">{header}{section === "subscribers" && <SubscribersOverview data={subscribersQuery.data ?? []} canManage={canManageSubscribers} />}{section === "generators" && <GeneratorsModule siteId={siteId!} data={generatorsQuery.data ?? []} pending={addGenerator.isPending} onSubmit={addGenerator.mutate} />}{section === "readings" && <ReadingsModule siteId={siteId!} subscribers={subscribersQuery.data ?? []} readings={readings} readingPending={addReading.isPending} onAddReading={addReading.mutateAsync} />}{section === "invoices" && <InvoicesOverview invoices={invoices} />}{section === "collections" && <><CollectionsModule siteId={siteId!} siteName={activeSite?.name ?? "محطة PowerHub"} subscribers={subscribersQuery.data ?? []} invoices={invoices} payments={payments} pending={addPayment.isPending} sendingReceipt={sendPaymentReceipt.isPending} onSubmit={submitPayment} onSendReceipt={sendPaymentReceipt.mutate} canCollect={canCreateFinancialRecord} canSendReceipts={canSendReceipts} canDiscount={["owner", "manager", "accountant"].includes(powerRole ?? "")} />{canCreateFinancialRecord && user?.id ? <OfflineWorkSyncPanel siteId={siteId!} userId={user.id} compact /> : null}<CollectorSessionsPanel siteId={siteId!} /></>}{section === "expenses" && (canManageExpenses ? <ExpensesModule siteId={siteId!} generators={generatorsQuery.data ?? []} summary={summaryQuery.data} pending={addExpense.isPending} onSubmit={addExpense.mutateAsync} /> : <ExpensesReadOnlyModule siteId={siteId!} summary={summaryQuery.data} />)}{section === "reports" && <ReportsModule summary={summaryQuery.data} />}{section === "notifications" && <NotificationsModule data={notificationsQuery.data ?? []} />}{section === "audit" && <AuditModule data={auditQuery.data ?? []} />}</div></DashboardLayout>;
}

function SubscribersOverview({ data, canManage }: { data: any[]; canManage: boolean }) {
  const active = data.filter((subscriber) => subscriber.serviceStatus === "active").length;
  const suspended = data.filter((subscriber) => subscriber.serviceStatus === "suspended").length;
  return <div className="space-y-6">
    <section className="grid gap-4 sm:grid-cols-3">
      <Card className="border-sky-400/20 bg-sky-400/[.04]"><CardContent className="p-5"><p className="text-sm text-slate-400">إجمالي المشتركين</p><p className="mt-3 text-3xl font-extrabold text-white">{data.length}</p></CardContent></Card>
      <Card className="border-emerald-400/20 bg-emerald-400/[.04]"><CardContent className="p-5"><p className="text-sm text-slate-400">مشتركون نشطون</p><p className="mt-3 text-3xl font-extrabold text-emerald-300">{active}</p></CardContent></Card>
      <Card className="border-amber-400/20 bg-amber-400/[.04]"><CardContent className="p-5"><p className="text-sm text-slate-400">مشتركون موقوفون</p><p className="mt-3 text-3xl font-extrabold text-amber-200">{suspended}</p></CardContent></Card>
    </section>
    <SectionCard title="إدارة المشتركين">
      <p className="text-sm leading-7 text-slate-400">تم توحيد إضافة المشتركين وملفاتهم والبحث الذكي والاستيراد الجماعي في تبويب «المشتركون» الرئيسي، لتجنب تكرار النماذج والقوائم بين الصفحات.</p>
      <div className="mt-4 flex justify-end"><Button disabled={!canManage} onClick={() => window.location.assign("/subscribers")} className="bg-[#F5B800] font-bold text-[#0D1117]">فتح تبويب المشتركين</Button></div>
    </SectionCard>
  </div>;
}

function GeneratorsModule({ siteId, data, pending, onSubmit }: any) { return <div className="grid gap-6 xl:grid-cols-[.8fr_1.2fr]"><SectionCard title="إضافة مولد"><form className="space-y-4" onSubmit={(e: FormEvent<HTMLFormElement>) => { e.preventDefault(); const f = new FormData(e.currentTarget); onSubmit({ siteId, code: String(f.get("code")), name: String(f.get("name")), serialNumber: String(f.get("serial") || "") || undefined, ratedCapacityKw: String(f.get("capacity") || "").trim() || undefined, fuelType: String(f.get("fuel")) }); e.currentTarget.reset(); }}><Field label="رمز المولد"><input required name="code" className={inputClass} placeholder="GEN-01" dir="ltr" /></Field><Field label="اسم المولد"><input required name="name" className={inputClass} placeholder="مولد السوق" /></Field><Field label="القدرة بالكيلوواط (اختياري)"><input name="capacity" type="number" step="0.001" min="0" className={inputClass} placeholder="250" dir="ltr" /></Field><Field label="الرقم التسلسلي"><input name="serial" className={inputClass} placeholder="اختياري" dir="ltr" /></Field><Field label="نوع الوقود"><select name="fuel" className={selectClass}><option value="diesel">ديزل</option><option value="gasoline">بنزين</option><option value="gas">غاز</option><option value="other">آخر</option></select></Field><Button disabled={pending} className="w-full bg-[#F5B800] font-bold text-[#0D1117] hover:bg-[#ffd23f]">إضافة المولد</Button></form></SectionCard><SectionCard title={`المولدات (${data.length})`}>{data.length ? <div className="grid gap-3 sm:grid-cols-2">{data.map((row: any) => <div key={row.id} className="rounded-xl border border-white/8 bg-white/[0.015] p-4"><div className="flex items-center justify-between"><span className="font-bold text-white">{row.name}</span><Badge className="bg-slate-400/10 text-slate-400">{row.status === "active" ? "يعمل" : row.status === "maintenance" ? "صيانة" : "متوقف"}</Badge></div><p className="mt-3 font-display text-lg font-extrabold text-[#F5B800]">{formatValue(row.ratedCapacityKw)} <span className="text-xs text-slate-500">kW</span></p><p className="mt-2 text-xs text-slate-500">{row.fuelType} · {formatValue(row.operatingHours, 1)} ساعة تشغيل</p></div>)}</div> : <Empty text="لا توجد مولدات مسجلة. أضف المولد الأول لتبدأ متابعة التشغيل." />}</SectionCard></div>; }

function ReadingsModule({ siteId, subscribers, readings, readingPending, onAddReading }: any) { return <div className="space-y-6"><SectionCard title="تسجيل قراءة المشترك"><form className="grid gap-4 sm:grid-cols-2" onSubmit={async (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); const form = e.currentTarget; const f = new FormData(form); try { await onAddReading({ siteId, subscriberId: Number(f.get("subscriberId")), readingValue: String(f.get("readingValue")), captureMethod: String(f.get("captureMethod")), notes: String(f.get("notes") || "") || undefined }); form.reset(); } catch { /* onError already displays the failure; keep inputs so the user can correct and retry. */ } }}><Field label="المشترك"><select required name="subscriberId" className={selectClass}><option value="">اختر المشترك</option>{subscribers.map((x: any) => <option key={x.id} value={x.id}>{x.fullName} — {x.subscriberNo}</option>)}</select></Field><Field label="القراءة الحالية (حتى منزلتين عشريتين)"><input required name="readingValue" type="number" step="0.01" min="0" className={inputClass} placeholder="0.00" dir="ltr" /></Field><Field label="طريقة الإدخال"><select name="captureMethod" className={selectClass}><option value="manual">يدوي</option><option value="photo">مع صورة</option></select></Field><Field label="ملاحظة"><input name="notes" className={inputClass} placeholder="اختياري" /></Field><div className="sm:col-span-2"><Button disabled={readingPending || !subscribers.length} className="bg-[#F5B800] font-bold text-[#0D1117] hover:bg-[#ffd23f]">حفظ القراءة واعتمادها وإصدار الفاتورة تلقائيًا</Button></div></form></SectionCard><SectionCard title={`سجل القراءات (${readings.length})`}>{readings.length ? <div className="overflow-x-auto"><table className="w-full min-w-[560px] text-sm"><thead className="text-right text-xs text-slate-500"><tr><th className="pb-3">المشترك</th><th className="pb-3">الرقم المرجعي</th><th className="pb-3">القراءة</th><th className="pb-3">الاستهلاك</th><th className="pb-3">الحالة</th></tr></thead><tbody>{readings.map((x: any) => <tr key={x.reading.id} className="border-t border-white/7"><td className="py-3 font-bold text-white">{x.subscriber.fullName}</td><td className="py-3 text-slate-400" dir="ltr">{x.subscriber.subscriberNo}</td><td className="py-3 text-slate-300">{formatValue(x.reading.readingValue, 3)}</td><td className="py-3 text-[#F5B800]">{formatValue(x.reading.consumptionKwh, 3)} kWh</td><td className="py-3"><Badge className="bg-sky-400/10 text-sky-400">{x.reading.status === "pending_review" ? "بانتظار المراجعة" : x.reading.status}</Badge></td></tr>)}</tbody></table></div> : <Empty text="لا توجد قراءات بعد. اختر مشتركاً وسجل أول قراءة." />}</SectionCard></div>; }

function InvoicesOverview({ invoices }: { invoices: any[] }) {
  const summary=summarizeOutstandingInvoices(invoices);
  const latest=[...invoices].sort((a,b)=>new Date(b.issueDate).getTime()-new Date(a.issueDate).getTime()).slice(0,8);
  return <div className="space-y-6">
    <section className="grid gap-4 sm:grid-cols-3">
      <Card className="border-rose-400/20 bg-rose-400/[.055]"><CardContent className="p-5"><p className="text-sm text-rose-100/75">الأرصدة المتبقية</p><p className="mt-3 font-display text-3xl font-extrabold text-rose-200">{formatValue(summary.outstanding,2)}</p><p className="mt-2 text-xs text-rose-100/65">{summary.count} فاتورة غير مكتملة السداد</p></CardContent></Card>
      <Card className="border-amber-400/20 bg-amber-400/[.055]"><CardContent className="p-5"><p className="text-sm text-amber-100/75">دفعات جزئية</p><p className="mt-3 font-display text-3xl font-extrabold text-amber-200">{summary.partiallyPaidCount}</p><p className="mt-2 text-xs text-amber-100/65">تحتاج متابعة الرصيد</p></CardContent></Card>
      <Card className="border-emerald-400/20 bg-emerald-400/[.055]"><CardContent className="p-5"><p className="text-sm text-emerald-100/75">فواتير غير مسددة</p><p className="mt-3 font-display text-3xl font-extrabold text-emerald-200">{summary.unpaidCount}</p><p className="mt-2 text-xs text-emerald-100/65">فواتير صادرة بلا سداد كافٍ</p></CardContent></Card>
    </section>
    <SectionCard title="أحدث الفواتير">
      {latest.length?<div className="overflow-x-auto"><table className="w-full min-w-[700px] text-sm"><thead className="text-right text-xs text-slate-500"><tr><th className="pb-3">رقم الفاتورة</th><th className="pb-3">الفترة</th><th className="pb-3">الإجمالي</th><th className="pb-3">المتبقي</th><th className="pb-3">الحالة</th><th className="pb-3">تاريخ الإصدار</th></tr></thead><tbody>{latest.map((invoice:any)=>{const meta=invoiceStatusMeta(invoice.status);return <tr key={invoice.id} className="border-t border-white/7"><td className="py-3 font-display text-xs font-bold text-[#F5B800]" dir="ltr">{invoice.invoiceNo}</td><td className="py-3">{invoice.billingPeriod}</td><td className="py-3">{formatValue(invoice.totalAmount,2)}</td><td className="py-3">{formatValue(invoice.balanceDue,2)}</td><td className="py-3"><Badge className={statusToneClass[meta.tone]}>{meta.label}</Badge></td><td className="py-3 text-slate-400">{formatDate(invoice.issueDate)}</td></tr>})}</tbody></table></div>:<Empty text="لا توجد فواتير صادرة بعد."/>}
      <div className="mt-4 flex justify-end"><Button onClick={()=>window.location.assign("/invoices")} className="bg-[#F5B800] font-bold text-[#0D1117]">فتح مركز الفواتير والفلاتر</Button></div>
    </SectionCard>
  </div>;
}

function CollectionsModule({ siteId, siteName, subscribers, invoices, payments, pending, sendingReceipt, onSubmit, onSendReceipt, canCollect, canSendReceipts, canDiscount }: any) {
  const [receiptFile, setReceiptFile] = useState<File | null>(null);
  const accountsQuery = trpc.powerhub.companyAccounts.list.useQuery({ siteId }, { enabled: canCollect });
  const accounts = accountsQuery.data ?? [];
  const [companyAccountId, setCompanyAccountId] = useState("");
  const selectedCompanyAccount = accounts.find((account: any) => Number(account.id) === Number(companyAccountId));
  useEffect(() => {
    if (companyAccountId && !accounts.some((account: any) => Number(account.id) === Number(companyAccountId))) {
      setCompanyAccountId("");
    }
  }, [accounts, companyAccountId]);
  const [previewPayment, setPreviewPayment] = useState<{ url: string; paymentNo: string } | null>(null);
  const [paymentSearch, setPaymentSearch] = useState("");
  const [paymentProvider, setPaymentProvider] = useState("all");
  const [paymentReceiverType, setPaymentReceiverType] = useState("all");
  const [paymentReceiverAccountId, setPaymentReceiverAccountId] = useState("all");
  const [paymentPeriod, setPaymentPeriod] = useState<"today" | "current_cycle" | "month_end" | "custom">("current_cycle");
  const [paymentStartDate, setPaymentStartDate] = useState("");
  const [paymentEndDate, setPaymentEndDate] = useState("");
  const cycleBoundsQuery = trpc.powerhub.readingCycle.currentBounds.useQuery({ siteId }, { enabled: Boolean(siteId) });
  const gazaDateKey = (value: unknown) => {
    if (!value) return "";
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Gaza", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(String(value)));
    const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
    return `${part("year")}-${part("month")}-${part("day")}`;
  };
  const todayKey = gazaDateKey(new Date());
  const monthEndStart = `${todayKey.slice(0, 7)}-01`;
  const [todayYear, todayMonth] = todayKey.split("-").map(Number);
  const monthEndKey = new Date(Date.UTC(todayYear, todayMonth, 0)).toISOString().slice(0, 10);
  const effectivePaymentStart = paymentPeriod === "today" ? todayKey : paymentPeriod === "current_cycle" ? gazaDateKey(cycleBoundsQuery.data?.startAt) : paymentPeriod === "month_end" ? monthEndStart : paymentStartDate;
  const effectivePaymentEnd = paymentPeriod === "today" ? todayKey : paymentPeriod === "current_cycle" ? gazaDateKey(cycleBoundsQuery.data?.endAt) : paymentPeriod === "month_end" ? monthEndKey : paymentEndDate;
  const cycleFilterReady = paymentPeriod !== "current_cycle" || Boolean(cycleBoundsQuery.data && !cycleBoundsQuery.isError);
  const initialSubscriberId = Number(new URLSearchParams(window.location.search).get("subscriberId") ?? 0);
  const [selectedSubscriberId, setSelectedSubscriberId] = useState<number>(initialSubscriberId);
  const [selectedInvoiceIds, setSelectedInvoiceIds] = useState<number[]>([]);
  const [subscriberSearch, setSubscriberSearch] = useState("");
  const [subscriberPickerOpen, setSubscriberPickerOpen] = useState(false);
  const subscriberPickerRef = useRef<HTMLDivElement | null>(null);
  const [collectionFormOpen, setCollectionFormOpen] = useState(false);
  const [collectionAmount, setCollectionAmount] = useState("");
  const [paymentNo, setPaymentNo] = useState(() => `PAY-${Date.now()}`);
  const collectionFormRef = useRef<HTMLFormElement>(null);
  const dateKey = (value: unknown) => value ? new Date(String(value)).toISOString().slice(0, 10) : "";
  const unpaidInvoicesForSubscriber = useMemo(() => invoices.filter((x:any)=>Number(x.subscriberId)===selectedSubscriberId && Number(x.balanceDue)>0 && x.status!=="cancelled"), [invoices, selectedSubscriberId]);
  useEffect(()=>{setSelectedInvoiceIds((ids)=>ids.filter((id)=>unpaidInvoicesForSubscriber.some((x:any)=>Number(x.id)===id)));},[selectedSubscriberId,unpaidInvoicesForSubscriber]);
  const selectedInvoicesDue = selectedInvoiceIds.reduce((sum,id)=>sum+Number(unpaidInvoicesForSubscriber.find((x:any)=>Number(x.id)===id)?.balanceDue??0),0);
  useEffect(()=>{setCollectionAmount(selectedInvoiceIds.length ? selectedInvoicesDue.toFixed(2) : "");},[selectedInvoiceIds, selectedInvoicesDue]);
  const selectedSubscriber = useMemo(
    () => subscribers.find((subscriber: any) => Number(subscriber.id) === selectedSubscriberId),
    [subscribers, selectedSubscriberId],
  );
  const searchedSubscribers = useMemo(() => {
    const query = normalizeSubscriberSearch(subscriberSearch);
    const words = query.split(/\s+/).filter(Boolean);
    const matches = subscribers.filter((subscriber: any) => {
      const normalizedName = normalizeSubscriberSearch(subscriber.fullName);
      const normalizedPhone = normalizeSubscriberSearch(subscriber.phone);
      const normalizedNumber = normalizeSubscriberSearch(subscriber.subscriberNo);
      const searchableText = [normalizedName, normalizedPhone, normalizedNumber].filter(Boolean).join(" ");
      return words.every((word) => {
        if (searchableText.includes(word)) return true;
        // Match phone/reference digits even when the stored value contains +, spaces, or separators.
        if (!/^[+]?[0-9s().-]+$/.test(word)) return false;
        const digits = word.replace(/D/g, "");
        return digits.length > 0 &&
          (normalizedPhone.replace(/D/g, "").includes(digits) ||
           normalizedNumber.replace(/D/g, "").includes(digits));
      });
    });
    const rank = (subscriber: any) => {
      const name = normalizeSubscriberSearch(subscriber.fullName);
      const phone = normalizeSubscriberSearch(subscriber.phone);
      const number = normalizeSubscriberSearch(subscriber.subscriberNo);
      if (query && number === query) return 0;
      if (query && phone === query) return 1;
      if (query && name === query) return 2;
      if (query && name.startsWith(query)) return 3;
      if (query && (number.startsWith(query) || phone.startsWith(query))) return 4;
      return 5;
    };
    return matches.sort((a: any, b: any) => rank(a) - rank(b)).slice(0, query ? 30 : 15);
  }, [subscribers, subscriberSearch]);
  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (!subscriberPickerRef.current?.contains(event.target as Node)) setSubscriberPickerOpen(false);
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, []);
  const chooseSubscriber = (subscriberId: number) => {
    setSelectedSubscriberId(subscriberId);
    setSubscriberSearch("");
    setSubscriberPickerOpen(false);
    setSelectedInvoiceIds([]);
    setCollectionAmount("");
  };
  const resetCollectionForm = (form: HTMLFormElement | null = collectionFormRef.current) => {
    form?.reset(); setReceiptFile(null); setSubscriberSearch(""); setSubscriberPickerOpen(false); setSelectedSubscriberId(0); setSelectedInvoiceIds([]); setCollectionAmount(""); setPaymentNo(`PAY-${Date.now()}`);
  };
  const receiverTypes = Array.from(new Set(accounts.map((account: any) => String(account.accountType ?? "")).filter(Boolean)));
  const receiverAccountsForType = accounts.filter((account: any) => paymentReceiverType === "all" || String(account.accountType) === paymentReceiverType);
  useEffect(() => {
    if (paymentReceiverAccountId !== "all" && !receiverAccountsForType.some((account: any) => String(account.id) === paymentReceiverAccountId)) setPaymentReceiverAccountId("all");
  }, [paymentReceiverType, accounts]);
  const filteredPayments = payments.filter((entry: any) => {
    if (!cycleFilterReady) return false;
    const payment = entry.payment;
    const query = paymentSearch.trim().toLowerCase();
    const paidDate = gazaDateKey(payment.paidAt);
    const matchesSearch = !query || [payment.transferFromAccount, payment.transferToAccount, payment.paymentNo, entry.subscriber?.fullName].some((value) => String(value ?? "").toLowerCase().includes(query));
    const matchesProvider = paymentProvider === "all" || payment.paymentMethod === paymentProvider || payment.transferFromType === paymentProvider;
    const matchedReceiverAccount = accounts.find((account: any) => [account.phoneNumber, account.name].some((value) => value && String(value) === String(payment.transferToAccount)));
    const matchesReceiverType = paymentReceiverType === "all" || payment.transferToType === paymentReceiverType || matchedReceiverAccount?.accountType === paymentReceiverType;
    const selectedReceiverAccount = accounts.find((account: any) => String(account.id) === paymentReceiverAccountId);
    const matchesReceiverAccount = paymentReceiverAccountId === "all" || (selectedReceiverAccount && [selectedReceiverAccount.phoneNumber, selectedReceiverAccount.name].some((value: unknown) => value && String(value) === String(payment.transferToAccount)));
    const matchesStart = !effectivePaymentStart || paidDate >= effectivePaymentStart;
    const matchesEnd = !effectivePaymentEnd || paidDate <= effectivePaymentEnd;
    return matchesSearch && matchesProvider && matchesReceiverType && matchesReceiverAccount && matchesStart && matchesEnd;
  });
  const invoiceById = new Map<number, any>(invoices.map((invoice: any) => [Number(invoice.id), invoice] as const));
  const exportPaymentRows = filteredPayments.map((entry: any) => {
    const payment = entry.payment;
    const invoice = invoiceById.get(Number(payment.invoiceId));
    const receiverType = paymentMethodLabel[payment.transferToType] ?? payment.transferToType ?? "—";
    const receiverValue = payment.transferToAccount ?? "—";
    return [payment.paymentNo, siteName, invoice?.billingPeriod ?? invoice?.cycleLabel ?? "—", entry.subscriber?.fullName ?? "—", formatValue(payment.amount, 2), paymentMethodLabel[payment.transferFromType] ?? payment.transferFromType ?? "نقدي", payment.transferFromAccount ?? "—", `${receiverValue} — ${receiverType}`, entry.invoiceNo ?? "—", gazaDateKey(payment.paidAt)];
  });
  const exportPaymentsExcel = async () => {
    const { default: ExcelJS } = await loadExcelJS();
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "PowerHub";
    const sheet = workbook.addWorksheet("الدفعات", { views: [{ rightToLeft: true, state: "frozen", ySplit: 4 }] });
    sheet.mergeCells("A1:J1");
    sheet.getCell("A1").value = `PowerHub — تقرير الدفعات | ${siteName}`;
    sheet.getCell("A1").font = { name: "Tahoma", size: 16, bold: true, color: { argb: "FFF5B800" } };
    sheet.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0D1117" } };
    sheet.getCell("A1").alignment = { horizontal: "right", vertical: "middle" };
    sheet.getRow(1).height = 34;
    sheet.mergeCells("A2:J2");
    sheet.getCell("A2").value = `الفترة: ${paymentPeriod === "today" ? "اليوم" : paymentPeriod === "current_cycle" ? (cycleBoundsQuery.data?.cycleLabel || "هذه الدورة") : paymentPeriod === "month_end" ? "من بداية الشهر حتى اليوم" : `${paymentStartDate || "—"} إلى ${paymentEndDate || "—"}`}`;
    sheet.getCell("A2").font = { name: "Tahoma", size: 11, bold: true };
    sheet.getCell("A2").alignment = { horizontal: "right", vertical: "middle", wrapText: true };
    sheet.getRow(2).height = 26;
    sheet.addRow(["الإيصال", "اسم المولد", "دورة الفوترة", "المشترك", "المبلغ", "نوع الحساب المحوَّل منه", "الحساب المحوِّل", "الحساب المستقبل", "الفاتورة", "التاريخ"]);
    const header = sheet.getRow(3); header.height = 34;
    header.eachCell((cell) => { cell.font = { name: "Tahoma", bold: true, color: { argb: "FFFFFFFF" } }; cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0D1117" } }; cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true }; cell.border = { top: {style:"thin",color:{argb:"FFCAD1DC"}}, bottom:{style:"thin",color:{argb:"FFCAD1DC"}}, left:{style:"thin",color:{argb:"FFCAD1DC"}}, right:{style:"thin",color:{argb:"FFCAD1DC"}} }; });
    exportPaymentRows.forEach((row: any[]) => {
      const added = sheet.addRow(row);
      added.height = 30;
      added.eachCell((cell, col) => { cell.font = { name: "Tahoma", size: 10 }; cell.alignment = { horizontal: col === 2 || col === 3 || col === 4 || col === 6 || col === 7 || col === 8 ? "right" : "center", vertical: "middle", wrapText: true }; cell.border = { bottom: { style: "thin", color: { argb: "FFE1E5EB" } } }; if (added.number % 2 === 0) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF5F6F8" } }; });
    });
    sheet.columns = [{ width: 20 }, { width: 25 }, { width: 24 }, { width: 25 }, { width: 14 }, { width: 25 }, { width: 24 }, { width: 30 }, { width: 20 }, { width: 16 }];
    sheet.getColumn(5).numFmt = "#,##0.00";
    sheet.autoFilter = { from: "A3", to: `J${Math.max(3, sheet.rowCount)}` };
    const buffer = await workbook.xlsx.writeBuffer();
    const url = URL.createObjectURL(new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    const link = document.createElement("a"); link.href = url; link.download = `powerhub-payments-${effectivePaymentStart || "all"}-${effectivePaymentEnd || "all"}.xlsx`; link.click(); URL.revokeObjectURL(url);
    toast.success("تم تصدير الدفعات المفلترة إلى Excel.");
  };
  const exportPaymentsPdf = async () => {
    if (!exportPaymentRows.length) return toast.error("لا توجد دفعات لتصديرها.");
    const root = document.createElement("div"); root.dir = "rtl";
    root.style.cssText = "position:fixed;left:-10000px;top:0;width:1400px;background:#fff;color:#101828;padding:36px;font-family:Tahoma,Arial,sans-serif";
    const paymentRowsHtml = exportPaymentRows.map((row: any[]) => `<tr>${row.map((cell, index) => `<td style="padding:9px 7px;border:1px solid #d8dee8;vertical-align:top;overflow-wrap:anywhere;text-align:${[1,2,3,5,6,7].includes(index) ? "right" : "center"}">${escapeHtml(cell)}</td>`).join("")}</tr>`).join("");
    root.innerHTML = `<h1 style="border-bottom:3px solid #F5B800;padding-bottom:14px;margin:0 0 12px">PowerHub — تفاصيل الدفعات</h1><p style="margin:0 0 18px;font-weight:bold">اسم المولد: ${escapeHtml(siteName)} | الفترة: ${escapeHtml(paymentPeriod === "today" ? "اليوم" : paymentPeriod === "current_cycle" ? (cycleBoundsQuery.data?.cycleLabel || "هذه الدورة") : paymentPeriod === "month_end" ? "من بداية الشهر حتى اليوم" : `${paymentStartDate || "—"} إلى ${paymentEndDate || "—"}`)}</p><table style="width:100%;border-collapse:collapse;table-layout:fixed;text-align:right;font-size:10px;line-height:1.6;overflow-wrap:anywhere"><thead><tr style="background:#0D1117;color:#fff">${["الإيصال","اسم المولد","دورة الفوترة","المشترك","المبلغ","نوع الحساب المحوَّل منه","الحساب المحوِّل","الحساب المستقبل","الفاتورة","التاريخ"].map(h=>`<th style="padding:10px 6px;border:1px solid #d8dee8;overflow-wrap:anywhere;vertical-align:middle">${h}</th>`).join("")}</tr></thead><tbody>${paymentRowsHtml}</tbody></table>`;
    document.body.appendChild(root);
    try { await downloadReportHtmlAsPdf(root, `دفعات-${effectivePaymentStart || "كل"}-${effectivePaymentEnd || "الفترات"}.pdf`, { landscape: true, title: "تفاصيل الدفعات - PowerHub" }); toast.success("تم تصدير الدفعات المفلترة إلى PDF."); }
    catch (error) { toast.error(error instanceof Error ? error.message : "تعذر إنشاء ملف PDF."); }
    finally { root.remove(); }
  };
  return <div className="w-full min-w-0 space-y-6">
    <SectionCard title="تسجيل دفعة" className="w-full min-w-0" collapsed={!collectionFormOpen} onToggleCollapse={() => setCollectionFormOpen((open) => !open)}>{canCollect ? <form ref={collectionFormRef} className="space-y-4" onSubmit={async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const formElement = e.currentTarget;
      const f = new FormData(formElement);
      if (receiptFile && receiptFile.size > 7 * 1024 * 1024) return toast.error("يجب ألا تتجاوز صورة الإيصال 7 ميغابايت.");
      let receiptImageData: string | undefined;
      let receiptImageMime: "image/webp" | "image/jpeg" | undefined;
      try {
        if (receiptFile) { const prepared = await preparePaymentReceiptImage(receiptFile); receiptImageData = prepared.data; receiptImageMime = prepared.mime; }
      } catch (error) { toast.error(error instanceof Error ? error.message : "تعذر تجهيز صورة الإيصال."); return; }
      const invoiceIds = selectedInvoiceIds.length ? [...selectedInvoiceIds] : [Number(f.get("invoiceId"))].filter(Boolean);
      if (!invoiceIds.length) return toast.error("اختر فاتورة واحدة على الأقل للتحصيل.");
      const subscriberId = Number(f.get("subscriberId"));
      if (!subscriberId || subscriberId !== selectedSubscriberId) return toast.error("اختر المشترك من القائمة قبل تسجيل التحصيل.");
      const requestedAmount = Number(f.get("amount"));
      const manualDiscountAmount = Number(f.get("manualDiscountAmount") || 0);
      const manualDiscountReason = String(f.get("manualDiscountReason") || "").trim();
      if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) return toast.error("أدخل مبلغ تحصيل أكبر من صفر.");
      if (manualDiscountAmount > 0 && invoiceIds.length !== 1) return toast.error("الخصم اليدوي متاح عند تحصيل فاتورة واحدة في العملية؛ اختر فاتورة واحدة أولًا.");
      if (manualDiscountAmount > 0 && manualDiscountReason.length < 3) return toast.error("اكتب سببًا واضحًا للخصم اليدوي لا يقل عن 3 أحرف.");
      const dueById = new Map<number, number>(unpaidInvoicesForSubscriber.map((invoice: any) => [Number(invoice.id), Number(invoice.balanceDue)] as const));
      if (invoiceIds.some((invoiceId) => !dueById.has(invoiceId))) return toast.error("تغيرت أهلية إحدى الفواتير للتحصيل. حدّث البيانات ثم اختر الفواتير المؤهلة مجددًا.");
      if (invoiceIds.length > 1) {
        const totalDue = invoiceIds.reduce((sum,id)=>sum+(dueById.get(id) ?? 0),0);
        if (Math.abs(requestedAmount-totalDue)>0.01) return toast.error("عند تحديد عدة فواتير يجب أن يساوي المبلغ إجمالي أرصدة الفواتير المحددة.");
      }
      for (const invoiceId of invoiceIds) {
        const due = dueById.get(invoiceId) ?? 0;
        const amount = invoiceIds.length===1 ? requestedAmount : due;
        if (amount<=0 || amount+(invoiceIds.length===1 ? manualDiscountAmount : 0)-due>0.01) return toast.error("مبلغ التحصيل والخصم معًا يتجاوزان الرصيد المستحق لإحدى الفواتير.");
      }
      const completedInvoiceIds: number[] = [];
      const queuedInvoiceIds: number[] = [];
      try {
        for (const invoiceId of invoiceIds) {
          const due = dueById.get(invoiceId) ?? 0;
          const amount = invoiceIds.length===1 ? requestedAmount : due;
          const result = await onSubmit({ siteId, subscriberId, invoiceId, paymentNo: invoiceIds.length===1 ? String(f.get("paymentNo")) : String(f.get("paymentNo"))+"-"+invoiceId, amount, paymentMethod: String(f.get("method")), companyAccountId: Number(companyAccountId), transferFromAccount: String(f.get("transferFromAccount") || "") || undefined, transferFromType: String(f.get("transferFromType") || "") || undefined, referenceNo: String(f.get("reference") || "") || undefined, receiptImageData, receiptImageMime, manualDiscountAmount: invoiceIds.length===1 ? manualDiscountAmount : 0, manualDiscountReason: invoiceIds.length===1 ? manualDiscountReason || undefined : undefined, clientOperationId: crypto.randomUUID() });
          completedInvoiceIds.push(invoiceId);
          if (result && typeof result === "object" && "queued" in result && result.queued) queuedInvoiceIds.push(invoiceId);
        }
      } catch (error) {
        if (completedInvoiceIds.length) {
          setSelectedInvoiceIds((ids) => ids.filter((id) => !completedInvoiceIds.includes(id)));
          toast.error(queuedInvoiceIds.length === completedInvoiceIds.length
            ? `تم حفظ ${completedInvoiceIds.length} فاتورة كمسودات تحصيل محلية؛ تعذر حفظ بقية الفواتير. بقيت الفواتير غير المكتملة محددة.`
            : `نجح تسجيل ${completedInvoiceIds.length} من ${invoiceIds.length} فاتورة. لم يُمسح النموذج؛ أُزيلت الفواتير الناجحة من التحديد لتجنب تكرارها، وبقيت الفواتير غير المكتملة محددة.`);
        } else {
          toast.error(error instanceof Error ? error.message : "تعذر تسجيل التحصيل. لم تُمسح بيانات النموذج.");
        }
        return;
      }
      const allQueued = queuedInvoiceIds.length === completedInvoiceIds.length;
      resetCollectionForm(formElement);
      if (allQueued) toast.success("حُفظ التحصيل كمسودة محلية؛ لن يتغير رصيد الفاتورة قبل قبول الخادم للمزامنة.");
      else toast.success("تم تسجيل التحصيل بنجاح، وتم إفراغ النموذج.");
    }}><div className="rounded-xl border border-[#F5B800]/20 bg-[#F5B800]/[.04] p-3">
      <Field label="الحساب المستقبِل للتحصيل">
        <select aria-label="الحساب المستقبِل للتحصيل" name="companyAccountId" required value={companyAccountId} disabled={accountsQuery.isLoading || accountsQuery.isError || accounts.length === 0} onChange={(event) => {
          setCompanyAccountId(event.target.value);
        }} className={selectClass}>
          <option value="">اختر حساب الشركة الذي سيستقبل التحصيل</option>
          {accounts.map((account: any) => <option key={account.id} value={account.id} disabled={account.accountType === "other"}>{account.name} — {paymentMethodLabel[account.accountType] ?? account.accountType}{account.accountType === "other" ? " — نوع غير مدعوم للتحصيل" : ""}{account.phoneNumber ? ` — ${account.phoneNumber}` : ""}</option>)}
        </select>
      </Field>
      {accountsQuery.isLoading ? <p className="mt-2 text-xs text-slate-400">جارٍ تحميل حسابات الشركة…</p> : accountsQuery.isError ? <p role="alert" className="mt-2 text-xs text-rose-200">تعذر تحميل حسابات الشركة. لا يمكن تسجيل التحصيل قبل نجاح التحميل.</p> : !accounts.length ? <p className="mt-2 text-xs text-rose-200">لا توجد حسابات مالية فعالة مرتبطة بهذه المحطة. أضف حسابًا من إدارة حسابات الشركة أولًا.</p> : selectedCompanyAccount?.accountType === "other" ? <p className="mt-2 text-xs text-rose-200">نوع هذا الحساب غير مدعوم كطريقة تحصيل؛ اختر حسابًا نقديًا أو إلكترونيًا مدعومًا.</p> : selectedCompanyAccount ? <p className="mt-2 text-xs text-amber-100">سيُسجل التحصيل في حساب <strong>{selectedCompanyAccount.name}</strong>.</p> : <p className="mt-2 text-xs text-slate-400">اختيار الحساب إلزامي؛ سيظهر الرصيد والحركة على الحساب الذي تحدده.</p>}
    </div>
    <div className="space-y-1" ref={subscriberPickerRef}>
      <Field label="المشترك">
        <div className="relative">
          <div className="relative">
            <input
              aria-label="البحث واختيار المشترك للتحصيل"
              aria-autocomplete="list"
              aria-expanded={subscriberPickerOpen}
              aria-controls="collection-subscriber-options"
              role="combobox"
              value={subscriberPickerOpen ? subscriberSearch : selectedSubscriber ? `${selectedSubscriber.fullName} — ${selectedSubscriber.subscriberNo ?? ""}${selectedSubscriber.phone ? ` · ${selectedSubscriber.phone}` : ""}` : subscriberSearch}
              onFocus={() => { setSubscriberPickerOpen(true); setSubscriberSearch(""); }}
              onChange={(event) => {
                setSubscriberSearch(event.target.value);
                setSubscriberPickerOpen(true);
                setSelectedSubscriberId(0);
                setSelectedInvoiceIds([]);
                setCollectionAmount("");
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setSubscriberPickerOpen(false);
                } else if (event.key === "Enter" && subscriberPickerOpen && searchedSubscribers.length) {
                  event.preventDefault();
                  chooseSubscriber(Number(searchedSubscribers[0].id));
                }
              }}
              className={`${inputClass} pr-10`}
              placeholder="ابحث واختر بالاسم أو رقم المشترك أو الهاتف..."
              autoComplete="off"
            />
            <button type="button" aria-label={subscriberPickerOpen ? "إغلاق قائمة المشتركين" : "فتح قائمة المشتركين"} onClick={() => { setSubscriberPickerOpen((open) => !open); setSubscriberSearch(""); }} className="absolute inset-y-0 left-0 flex w-10 items-center justify-center text-slate-400 hover:text-white">
              <ChevronDown className={`h-4 w-4 transition-transform ${subscriberPickerOpen ? "rotate-180" : ""}`} />
            </button>
          </div>
          {subscriberPickerOpen ? <div id="collection-subscriber-options" role="listbox" aria-label="نتائج المشتركين" className="absolute inset-x-0 top-full z-30 mt-1 max-h-64 overflow-y-auto rounded-xl border border-white/10 bg-[#111823] p-1 shadow-2xl">
            {searchedSubscribers.length ? searchedSubscribers.map((subscriber: any) => <button
              key={subscriber.id}
              type="button"
              role="option"
              aria-selected={Number(subscriber.id) === selectedSubscriberId}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => chooseSubscriber(Number(subscriber.id))}
              className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-right hover:bg-white/[.06] ${Number(subscriber.id) === selectedSubscriberId ? "bg-white/[.05]" : ""}`}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-white">{subscriber.fullName}</span>
                <span className="mt-1 block truncate text-xs text-slate-400" dir="ltr">{subscriber.subscriberNo ?? "بدون رقم مرجعي"}{subscriber.phone ? ` · ${subscriber.phone}` : ""}</span>
              </span>
              {Number(subscriber.id) === selectedSubscriberId ? <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" /> : null}
            </button>) : <p className="px-3 py-5 text-center text-sm text-slate-400">لا توجد نتائج مطابقة. جرّب الاسم أو جزءًا من رقم الهاتف أو الرقم المرجعي.</p>}
            {searchedSubscribers.length ? <p className="border-t border-white/8 px-3 py-2 text-[11px] text-slate-500">{subscriberSearch.trim() ? `تم العثور على ${searchedSubscribers.length} نتيجة مطابقة.` : "اكتب للبحث أو اختر مشتركًا من القائمة."}</p> : null}
          </div> : null}
        </div>
      </Field>
      <input type="hidden" name="subscriberId" value={selectedSubscriberId || ""} />
    </div><div><label className="text-xs text-slate-400">الفواتير غير المسددة</label><div className="mt-1 rounded-xl border border-white/10 bg-white/[.02] p-3">{selectedSubscriberId && unpaidInvoicesForSubscriber.length?<><div className="mb-2 flex items-center justify-between gap-2 text-xs"><span className="text-slate-500">{selectedInvoiceIds.length} محددة من {unpaidInvoicesForSubscriber.length}</span><Button type="button" size="sm" variant="ghost" onClick={()=>setSelectedInvoiceIds(selectedInvoiceIds.length===unpaidInvoicesForSubscriber.length?[]:unpaidInvoicesForSubscriber.map((x:any)=>Number(x.id)))} className="text-[#F5B800]">{selectedInvoiceIds.length===unpaidInvoicesForSubscriber.length?"إلغاء تحديد الكل":"تحديد الكل"}</Button></div><div className="max-h-48 space-y-1 overflow-auto">{unpaidInvoicesForSubscriber.map((x:any)=><label key={x.id} className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 hover:bg-white/[.03]"><input type="checkbox" checked={selectedInvoiceIds.includes(Number(x.id))} onChange={()=>setSelectedInvoiceIds((ids)=>ids.includes(Number(x.id))?ids.filter((id)=>id!==Number(x.id)):[...ids,Number(x.id)])} className="accent-[#F5B800]" /><span className="flex-1 text-sm text-white" dir="ltr">{x.invoiceNo}</span><span className="text-xs text-rose-300">{formatValue(x.balanceDue,2)}</span></label>)}</div></>:<p className="py-3 text-xs text-slate-500">{selectedSubscriberId?"لا توجد فواتير غير مسددة لهذا المشترك.":"اختر المشترك أولاً."}</p>}</div></div><Field label="رقم الإيصال"><input required name="paymentNo" value={paymentNo} onChange={(event) => setPaymentNo(event.target.value)} className={inputClass} dir="ltr" /></Field><Field label="المبلغ"><input required name="amount" type="number" min="0.01" step="0.01" value={collectionAmount} onChange={(event) => setCollectionAmount(event.target.value)} className={inputClass} dir="ltr" /></Field>{canDiscount ? <div className="grid gap-3 rounded-xl border border-white/8 p-3 sm:grid-cols-2"><Field label="خصم يدوي (اختياري)"><input name="manualDiscountAmount" type="number" min="0" step="0.01" defaultValue="0" className={inputClass} dir="ltr" /><span className="mt-1 block text-[11px] leading-5 text-slate-500">يقلل رصيد الفاتورة ولا يُحتسب مبلغًا نقديًا محصّلًا. لا يتجاوز الرصيد المتبقي.</span></Field><Field label="سبب الخصم (إلزامي عند إدخال خصم)"><input name="manualDiscountReason" maxLength={300} className={inputClass} placeholder="مثال: تسوية متفق عليها" /></Field></div> : null}<input type="hidden" name="method" value={selectedCompanyAccount?.accountType ?? ""} />{selectedCompanyAccount && selectedCompanyAccount.accountType !== "cash" && <div className="grid gap-3 rounded-xl border border-[#F5B800]/20 bg-[#F5B800]/[.04] p-3 sm:grid-cols-2"><div className="sm:col-span-2 text-xs leading-6 text-amber-200">نوع الحساب المستقبِل المحدد: <strong>{paymentMethodLabel[selectedCompanyAccount.accountType] ?? selectedCompanyAccount.accountType}</strong>. أدخل الحساب الذي جاءت منه الدفعة ونوعه.</div><Field label="الحساب المحوِّل منه"><input required name="transferFromAccount" className={inputClass} dir="ltr" placeholder="+97059xxxxxxx" /></Field><Field label="نوع الحساب المحوِّل"><select required name="transferFromType" className={selectClass}><option value="">اختر النوع</option><option value="jawwal_pay">جوال Pay</option><option value="palpay">PalPay</option><option value="bank_of_palestine">بنك فلسطين</option></select></Field></div>}<Field label="مرجع العملية"><input name="reference" className={inputClass} placeholder="رقم التحويل أو العملية — اختياري" /></Field><div><input id="payment-receipt-image" type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={(event) => setReceiptFile(event.target.files?.[0] ?? null)} /><label htmlFor="payment-receipt-image" className="flex cursor-pointer items-center justify-between rounded-xl border border-dashed border-white/15 bg-white/[.015] p-3 transition hover:border-[#F5B800]/50"><span className="flex items-center gap-2 text-sm text-slate-300"><ImagePlus className="h-4 w-4 text-[#F5B800]" />{receiptFile ? receiptFile.name : "إرفاق صورة إيصال الدفع (اختياري)"}</span><span className="text-xs text-slate-500">JPG · PNG · WebP · حتى 7MB — تُضغط تلقائيًا قبل الرفع</span></label></div><div className="grid gap-2 sm:grid-cols-2"><Button type="button" variant="outline" onClick={() => resetCollectionForm()} className="border-white/10 text-slate-300">إفراغ الحقول</Button><Button type="submit" disabled={pending || !subscribers.length || !companyAccountId || accountsQuery.isLoading || accountsQuery.isError || selectedCompanyAccount?.accountType === "other"} className="bg-[#F5B800] font-bold text-[#0D1117] hover:bg-[#ffd23f]">تسجيل الدفعة</Button></div><p className="text-xs leading-5 text-amber-100">دون اتصال: تُحفظ الدفعة وصورة الإيصال محلياً ضمن مسودة محكومة بالمستخدم، ولا تُرفع الصورة ولا يتغير الرصيد ولا يصدر إيصال رسمي قبل قبول الخادم للمزامنة.</p></form> : <Empty text="دورك يتيح مراجعة التحصيلات فقط؛ تسجيل الدفعات متاح للمالك والمدير والمحاسب والمحصل." />}</SectionCard>
    <SectionCard title={`الدفعات (${filteredPayments.length} من ${payments.length})`} className="w-full min-w-0"><div className="mb-4 grid gap-3 rounded-xl border border-white/8 bg-white/[.018] p-3 sm:grid-cols-2 xl:grid-cols-4">
      <label className="text-xs text-slate-400">بحث برقم الحساب أو الإيصال<input aria-label="بحث دفعات برقم الحساب" value={paymentSearch} onChange={(event) => setPaymentSearch(event.target.value)} className={`${inputClass} mt-1 w-full`} placeholder="رقم الحساب المحوِّل أو المستقبِل" /></label>
      <label className="text-xs text-slate-400">الفترة الزمنية<select aria-label="الفترة الزمنية للدفعات" value={paymentPeriod} onChange={(event) => setPaymentPeriod(event.target.value as typeof paymentPeriod)} className={`${inputClass} mt-1 w-full`}><option value="today">اليوم</option><option value="current_cycle">هذه الدورة</option><option value="month_end">آخر الشهر</option><option value="custom">مخصص</option></select></label>
      {paymentPeriod === "custom" ? <><label className="text-xs text-slate-400">من تاريخ<input aria-label="بداية نطاق الدفعات" type="date" value={paymentStartDate} max={paymentEndDate || undefined} onChange={(event) => setPaymentStartDate(event.target.value)} className={`${inputClass} mt-1 w-full`} dir="ltr" /></label><label className="text-xs text-slate-400">إلى تاريخ<input aria-label="نهاية نطاق الدفعات" type="date" value={paymentEndDate} min={paymentStartDate || undefined} onChange={(event) => setPaymentEndDate(event.target.value)} className={`${inputClass} mt-1 w-full`} dir="ltr" /></label></> : null}
      <label className="text-xs text-slate-400">نوع الحساب المستقبل<select aria-label="نوع الحساب المستقبل" value={paymentReceiverType} onChange={(event) => { setPaymentReceiverType(event.target.value); setPaymentReceiverAccountId("all"); }} className={`${inputClass} mt-1 w-full`}><option value="all">كل الأنواع</option>{receiverTypes.map((type) => <option key={type} value={type}>{paymentMethodLabel[type] ?? type}</option>)}</select></label>
      <label className="text-xs text-slate-400">الحساب المستقبل<select aria-label="الحساب المستقبل المحدد" value={paymentReceiverAccountId} onChange={(event) => setPaymentReceiverAccountId(event.target.value)} className={`${inputClass} mt-1 w-full`}><option value="all">كل الحسابات</option>{receiverAccountsForType.map((account: any) => <option key={account.id} value={String(account.id)}>{account.name}{account.phoneNumber ? ` — ${account.phoneNumber}` : ""}</option>)}</select></label>
      <label className="text-xs text-slate-400">نوع الحساب المحوَّل منه<select aria-label="نوع الحساب المحول منه" value={paymentProvider} onChange={(event) => setPaymentProvider(event.target.value)} className={`${inputClass} mt-1 w-full`}><option value="all">كل الأنواع</option>{REPORT_PAYMENT_METHOD_OPTIONS.filter((option) => option.value !== "all").map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label>
      <div className="flex flex-wrap items-end gap-2"><Button type="button" size="sm" variant="outline" onClick={() => { setPaymentSearch(""); setPaymentProvider("all"); setPaymentReceiverType("all"); setPaymentReceiverAccountId("all"); setPaymentPeriod("current_cycle"); setPaymentStartDate(""); setPaymentEndDate(""); }} className="border-white/10 text-slate-200 hover:bg-white/5">مسح الفلاتر</Button><Button type="button" size="sm" onClick={() => void exportPaymentsExcel()} disabled={!filteredPayments.length} className="bg-emerald-500 font-bold text-white hover:bg-emerald-400">Excel</Button><Button type="button" size="sm" onClick={exportPaymentsPdf} disabled={!filteredPayments.length} variant="outline" className="border-rose-400/35 text-rose-200 hover:bg-rose-400/10">PDF</Button></div>
    </div>{filteredPayments.length ? <div className="w-full min-w-0 overflow-x-auto rounded-xl border border-white/8"><table className="w-full min-w-[1040px] table-fixed text-xs"><thead className="text-right text-xs text-slate-500"><tr><th className="w-40 px-2 py-2 text-center">المشترك</th><th className="w-20 px-2 py-2 text-center">المبلغ</th><th className="w-36 px-2 py-2 text-center">الحساب المحوَّل منه</th><th className="w-40 px-2 py-2 text-center">الحساب المستقبل</th><th className="w-32 px-2 py-2 text-center">الفاتورة / الدورة</th><th className="w-20 px-2 py-2 text-center">صورة الإيصال</th><th className="w-44 px-2 py-2">إجراءات</th><th className="w-20 px-2 py-2">تصحيح</th></tr></thead><tbody>{filteredPayments.map((x: any) => { const invoice = invoiceById.get(Number(x.payment.invoiceId)); const partial = invoice?.status === "partially_paid"; const receiptImageUrl = x.payment.receiptImageUrl as string | undefined; return <tr key={x.payment.id} className="border-t border-white/7 align-top"><td className="px-2 py-3 text-center"><div className="flex min-w-0 flex-col items-center gap-1"><span className="w-full break-words text-center text-xs font-bold leading-4 text-white">{x.subscriber.fullName}</span><span className="w-full break-all text-center text-[10px] font-normal leading-4 text-slate-500" dir="ltr">{x.subscriber.phone ?? "—"}</span></div></td><td className="whitespace-nowrap px-2 py-3 text-center tabular-nums">{formatValue(x.payment.amount, 2)}</td><td className="px-2 py-3 text-center text-xs text-slate-300"><div className="flex min-w-0 flex-col items-center gap-1"><span className="w-full break-words text-center leading-5">{paymentMethodLabel[x.payment.transferFromType] ?? x.payment.transferFromType ?? "نقدي"}</span><span className="w-full break-all text-center font-mono text-[11px] leading-4 text-slate-500" dir="ltr">{x.payment.transferFromAccount ?? "—"}</span></div></td><td className="px-3 py-4 text-center text-xs text-slate-300"><div className="flex min-w-0 flex-col items-center gap-1"><span className="w-full break-words text-center font-mono text-[11px] leading-4" dir="ltr">{x.payment.transferToAccount ?? "—"}</span><span className="w-full break-words text-center leading-5">{paymentMethodLabel[x.payment.transferToType] ?? x.payment.transferToType ?? "—"}</span></div></td><td className="px-2 py-3 text-center text-xs text-slate-400"><div className="flex min-w-0 flex-col items-center gap-1"><span className="w-full whitespace-nowrap text-center font-mono text-xs leading-4 text-[#F5B800]" dir="ltr">{x.invoiceNo ?? "—"}</span><span className="w-full break-words text-center text-[11px] leading-4 text-slate-500">{invoice?.billingPeriod ?? invoice?.cycleLabel ?? "—"}</span></div></td><td className="px-1 py-2 text-center">{receiptImageUrl ? canCollect ? <Button size="sm" variant="outline" onClick={() => setPreviewPayment({ url: receiptImageUrl, paymentNo: x.payment.paymentNo })} className="border-emerald-400/35 text-emerald-200 hover:bg-emerald-400/10 hover:text-emerald-100"><Eye className="ml-1 h-3.5 w-3.5" />عرض</Button> : <span className="text-xs font-bold text-emerald-300">مرفقة</span> : <span className="text-xs text-slate-600">—</span>}</td><td className="px-1 py-2">{partial ? <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" className="border-amber-400/35 text-amber-200 hover:bg-amber-400/10 hover:text-amber-100" onClick={() => printPartialPaymentReceipt({ payment: x.payment, invoice, subscriber: x.subscriber, siteName })}><Printer className="ml-1 h-3.5 w-3.5" />طباعة</Button>{canSendReceipts ? <><Button size="sm" disabled={sendingReceipt} variant="outline" className="border-sky-400/35 text-sky-200 hover:bg-sky-400/10 hover:text-sky-100" onClick={() => onSendReceipt({ siteId, paymentId: x.payment.id, channel: "sms" })}><Send className="ml-1 h-3.5 w-3.5" />SMS</Button><span className="self-center text-[11px] text-slate-500">إرسال إيصال WhatsApp غير متاح حاليًا</span></> : <span className="self-center text-xs text-slate-600">الإرسال لصاحب المولد فقط</span>}</div> : <span className="text-xs text-slate-600">يتاح للدفعة الجزئية</span>}</td><td className="px-1 py-2 text-center"><Button size="sm" variant="ghost" className="text-orange-300 hover:bg-orange-400/10" onClick={() => window.location.assign(`/financial-settlements?entityType=payment&entityId=${x.payment.id}`)}>تصحيح</Button></td></tr>; })}</tbody></table></div> : <Empty text="لا توجد دفعات مسجلة. ستظهر هنا كل عمليات التحصيل النقدية والإلكترونية." />}</SectionCard>
    <Dialog open={Boolean(previewPayment)} onOpenChange={(open) => !open && setPreviewPayment(null)}><DialogContent className="max-w-3xl border-white/10 bg-[#111823] text-white"><DialogHeader><DialogTitle>صورة إيصال الدفع <span className="font-display text-sm text-[#F5B800]" dir="ltr">{previewPayment?.paymentNo}</span></DialogTitle></DialogHeader>{previewPayment ? <img src={previewPayment.url} alt={`صورة إيصال الدفع ${previewPayment.paymentNo}`} className="max-h-[70vh] w-full rounded-xl border border-white/10 object-contain" /> : null}</DialogContent></Dialog>
  </div>;
}

function CollectorSessionsPanel({ siteId }: { siteId: number }) {
  const utils = trpc.useUtils();
  const accessQuery = trpc.powerhub.staff.myAccess.useQuery({ siteId });
  const role = accessQuery.data?.role;
  const enabled = Boolean(role && ["owner", "manager", "accountant", "collector"].includes(role));
  const sessionsQuery = trpc.powerhub.collectorSessions.list.useQuery({ siteId }, { enabled });
  const currentQuery = trpc.powerhub.collectorSessions.current.useQuery({ siteId }, { enabled: role === "collector" });
  const refreshSessions = async () => { await Promise.all([utils.powerhub.collectorSessions.list.invalidate({ siteId }), utils.powerhub.collectorSessions.current.invalidate({ siteId }), utils.powerhub.payments.list.invalidate({ siteId }), utils.powerhub.dashboard.summary.invalidate({ siteId }), utils.powerhub.dashboard.financialOverview.invalidate({ siteId, scope: "branch" }), utils.powerhub.dashboard.periodMetrics.invalidate({ siteId, scope: "branch" }), utils.powerhub.audit.list.invalidate({ siteId })]); };
  const openSession = trpc.powerhub.collectorSessions.open.useMutation({ onSuccess: async () => { await refreshSessions(); toast.success("تم فتح جلسة التحصيل."); }, onError: (error) => toast.error(error.message) });
  const closeSession = trpc.powerhub.collectorSessions.close.useMutation({ onSuccess: async (result) => { await refreshSessions(); toast.success(`تم الإغلاق. الفرق النقدي: ${formatValue(result.varianceAmount, 2)}`); }, onError: (error) => toast.error(error.message) });
  const current = currentQuery.data;
  const sessions = sessionsQuery.data ?? [];
  if (!enabled) return null;
  return <div className={role === "collector" ? "grid gap-6 xl:grid-cols-[.78fr_1.22fr]" : "space-y-6"}>{role === "collector" ? <SectionCard title="جلسة المحصل الحالية">{current ? <form className="space-y-4" onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = new FormData(event.currentTarget); closeSession.mutate({ siteId, sessionId: current.id, declaredCash: Number(form.get("declaredCash")), notes: String(form.get("notes") || "") || undefined }); }}><div className="rounded-xl border border-emerald-400/15 bg-emerald-400/5 p-4"><p className="text-xs font-bold text-emerald-300">جلسة مفتوحة</p><p className="mt-2 text-sm text-slate-300">رصيد الافتتاح: <strong className="font-display text-white">{formatValue(current.openingCash, 2)}</strong></p><p className="mt-1 text-xs text-slate-500">لن تُحتسب دفعاتك النقدية في الإغلاق إلا ضمن هذه الجلسة.</p></div><Field label="النقد المسلم عند الإغلاق"><input required name="declaredCash" type="number" min="0" step="0.01" className={inputClass} dir="ltr" /></Field><Field label="ملاحظة الإغلاق"><input name="notes" className={inputClass} placeholder="اختياري" /></Field><Button disabled={closeSession.isPending} className="w-full bg-[#F5B800] font-bold text-[#0D1117] hover:bg-[#ffd23f]">إغلاق الجلسة</Button></form> : <form className="space-y-4" onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = new FormData(event.currentTarget); openSession.mutate({ siteId, openingCash: Number(form.get("openingCash") || 0), notes: String(form.get("notes") || "") || undefined }); }}><p className="text-sm leading-6 text-slate-400">افتح جلسة قبل تسجيل دفعاتك الميدانية؛ ستربط دفعاتك بهذه الجلسة تلقائياً.</p><Field label="رصيد الافتتاح النقدي"><input required name="openingCash" defaultValue="0" type="number" min="0" step="0.01" className={inputClass} dir="ltr" /></Field><Field label="ملاحظة الافتتاح"><input name="notes" className={inputClass} placeholder="اختياري" /></Field><Button disabled={openSession.isPending} className="w-full bg-[#F5B800] font-bold text-[#0D1117] hover:bg-[#ffd23f]">فتح جلسة تحصيل</Button></form>}</SectionCard> : null}<SectionCard title={`سجل جلسات التحصيل (${sessions.length})`}>{sessions.length ? <div className="overflow-x-auto"><table className="w-full min-w-[680px] text-sm"><thead className="text-right text-xs text-slate-500"><tr><th className="pb-3">المحصل</th><th className="pb-3">الافتتاح</th><th className="pb-3">المتوقع</th><th className="pb-3">المصرح</th><th className="pb-3">الفرق</th><th className="pb-3">الحالة</th></tr></thead><tbody>{sessions.map((row) => <tr className="border-t border-white/7" key={row.session.id}><td className="py-3 font-bold text-white">{row.collector.name || row.collector.email || `مستخدم #${row.collector.id}`}</td><td className="py-3">{formatValue(row.session.openingCash, 2)}</td><td className="py-3 text-[#F5B800]">{formatValue(row.session.expectedCash, 2)}</td><td className="py-3">{row.session.declaredCash === null ? "—" : formatValue(row.session.declaredCash, 2)}</td><td className="py-3">{row.session.varianceAmount === null ? "—" : <span className={Number(row.session.varianceAmount) === 0 ? "text-emerald-400" : "text-rose-300"}>{formatValue(row.session.varianceAmount, 2)}</span>}</td><td className="py-3"><Badge className={row.session.status === "open" ? "bg-sky-400/10 text-sky-300" : "bg-emerald-400/10 text-emerald-400"}>{row.session.status === "open" ? "مفتوحة" : "مغلقة"}</Badge></td></tr>)}</tbody></table></div> : <Empty text="لا توجد جلسات تحصيل مسجلة لهذه المحطة حتى الآن." />}</SectionCard></div>;
}

type ExpensePeriod = "today" | "cycle" | "monthEnd" | "custom";

function expenseDateKey(value: string | Date) {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Gaza", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return part("year") + "-" + part("month") + "-" + part("day");
}

function useExpenseHistoryFilters(siteId: number, canManageExpenses: boolean, managedAccounts: any[] = []) {
  const [expenseAccountFilter, setExpenseAccountFilter] = useState("");
  const [period, setPeriod] = useState<ExpensePeriod>("cycle");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  // View-only account options expose names and types only, never balances or transaction history.
  const readOnlyAccountsQuery = trpc.powerhub.expenses.filterAccounts.useQuery({ siteId }, { enabled: !canManageExpenses });
  const accounts = canManageExpenses ? managedAccounts : readOnlyAccountsQuery.data ?? [];
  const cycleBoundsQuery = trpc.powerhub.readingCycle.currentBounds.useQuery({ siteId }, { enabled: period === "cycle" });
  const currentDate = expenseDateKey(new Date());
  const year = Number(currentDate.slice(0, 4));
  const month = Number(currentDate.slice(5, 7));
  const firstOfMonth = String(year) + "-" + String(month).padStart(2, "0") + "-01";
  const lastOfMonth = expenseDateKey(new Date(Date.UTC(year, month, 0, 12)));
  const cycleStart = cycleBoundsQuery.data ? expenseDateKey(cycleBoundsQuery.data.startAt) : "";
  const cycleEnd = cycleBoundsQuery.data ? expenseDateKey(cycleBoundsQuery.data.endAt) : "";
  const startDate = period === "today" ? currentDate : period === "cycle" ? cycleStart : period === "monthEnd" ? firstOfMonth : period === "custom" ? customStart : undefined;
  const endDate = period === "today" ? currentDate : period === "cycle" ? cycleEnd : period === "monthEnd" ? lastOfMonth : period === "custom" ? customEnd : undefined;
  const customRangeValid = period !== "custom" || Boolean(customStart && customEnd && customStart <= customEnd);
  const cycleRangeReady = period !== "cycle" || Boolean(cycleBoundsQuery.data && cycleStart && cycleEnd && cycleStart <= cycleEnd && !cycleBoundsQuery.isError);
  const filtersReady = customRangeValid && cycleRangeReady;
  const expenseQueryInput = {
    siteId,
    limit: 100,
    ...(startDate && endDate && startDate <= endDate ? { startDate, endDate } : {}),
    ...(expenseAccountFilter ? { companyAccountId: Number(expenseAccountFilter) } : {}),
  };
  const expensesQuery = trpc.powerhub.expenses.page.useQuery(expenseQueryInput, { enabled: filtersReady });
  return {
    period, setPeriod, expenseAccountFilter, setExpenseAccountFilter, customStart, setCustomStart, customEnd, setCustomEnd,
    accounts, accountsLoading: !canManageExpenses && readOnlyAccountsQuery.isLoading,
    accountsError: !canManageExpenses && readOnlyAccountsQuery.isError,
    refetchAccounts: readOnlyAccountsQuery.refetch,
    cycleBoundsQuery, cycleRangeReady, customRangeValid, filtersReady, expensesQuery,
  };
}

function ExpenseHistoryPanel({ history, canCorrect = true }: { history: ReturnType<typeof useExpenseHistoryFilters>; canCorrect?: boolean }) {
  const expenses = history.expensesQuery.data?.items ?? [];
  return <SectionCard title={"سجل المصروفات (" + expenses.length + ")"}>
    <div className="mb-4 grid gap-3 sm:grid-cols-2">
      <Field label="الفترة الزمنية">
        <select aria-label="فلتر فترة المصروفات" value={history.period} onChange={(event) => history.setPeriod(event.target.value as ExpensePeriod)} className={selectClass}>
          <option value="today">اليوم</option>
          <option value="cycle">هذه الدورة</option>
          <option value="monthEnd">حتى آخر الشهر</option>
          <option value="custom">مخصص</option>
        </select>
      </Field>
      <Field label="الحساب المصروف منه">
        <select aria-label="فلتر الحساب المصروف منه" value={history.expenseAccountFilter} onChange={(event) => history.setExpenseAccountFilter(event.target.value)} className={selectClass}>
          <option value="">كل حسابات الصرف</option>
          {history.accounts.map((account: any) => <option key={account.id} value={account.id}>{account.name} — {account.accountType ?? account.account_type ?? "حساب"}</option>)}
        </select>
      </Field>
    </div>
    {history.period === "custom" ? <div className="mb-4 grid gap-3 sm:grid-cols-2">
      <Field label="من تاريخ"><input aria-label="بداية فترة المصروفات" type="date" value={history.customStart} max={history.customEnd || undefined} onChange={(event) => history.setCustomStart(event.target.value)} className={inputClass} /></Field>
      <Field label="إلى تاريخ"><input aria-label="نهاية فترة المصروفات" type="date" value={history.customEnd} min={history.customStart || undefined} onChange={(event) => history.setCustomEnd(event.target.value)} className={inputClass} /></Field>
    </div> : null}
    {history.period === "custom" && !history.customRangeValid ? <p className="mb-3 text-sm text-amber-300">حدد تاريخ البداية والنهاية بصورة صحيحة لعرض المصروفات.</p> : null}
    {history.accountsError ? <div className="mb-3 rounded-lg border border-rose-400/20 p-3 text-sm text-rose-200">تعذر تحميل خيارات حساب الصرف. <Button size="sm" variant="outline" onClick={() => void history.refetchAccounts()}>إعادة المحاولة</Button></div> : null}
    {history.period === "cycle" && !history.cycleRangeReady && history.cycleBoundsQuery.isLoading ? <div className="mb-3 text-sm text-slate-400">جارٍ تحديد حدود دورة الفوترة...</div> : null}
    {history.period === "cycle" && !history.cycleRangeReady && !history.cycleBoundsQuery.isLoading ? <div className="mb-3 rounded-lg border border-rose-400/20 p-3 text-sm text-rose-200">تعذر تحديد حدود دورة الفوترة. <Button size="sm" variant="outline" onClick={() => void history.cycleBoundsQuery.refetch()}>إعادة المحاولة</Button></div> : null}
    {history.period === "custom" && !history.customRangeValid ? null
      : history.period === "cycle" && !history.cycleRangeReady ? null
      : history.expensesQuery.isLoading ? <div className="grid min-h-24 place-items-center"><Loader2 className="h-5 w-5 animate-spin text-[#F5B800]" /></div>
      : history.expensesQuery.isError ? <div className="rounded-lg border border-rose-400/20 p-4 text-sm text-rose-200">تعذر تحميل سجل المصروفات. <Button size="sm" variant="outline" onClick={() => void history.expensesQuery.refetch()}>إعادة المحاولة</Button></div>
      : expenses.length ? <div className="space-y-2">{expenses.map((x: any) => {
        const account = history.accounts.find((item: any) => item.id === x.companyAccountId);
        return <div key={x.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/7 bg-white/[0.018] px-4 py-3">
          <div className="min-w-0 flex-1"><p className="break-words font-bold text-white">{x.description}</p><p className="mt-1 text-xs leading-5 text-slate-400">{x.category} · {formatReportDate(x.occurredAt)} · الحساب المصروف منه: {account?.name ?? (x.companyAccountId ? "حساب #" + x.companyAccountId : "غير محدد")}</p></div>
          <span className="whitespace-nowrap font-display font-bold text-[#F5B800]">{formatValue(x.amount, 2)}</span>
          {canCorrect ? <Button size="sm" variant="ghost" className="text-orange-300 hover:bg-orange-400/10" onClick={() => window.location.assign("/financial-settlements?entityType=expense&entityId=" + x.id)}>تصحيح</Button> : null}
        </div>;
      })}</div> : <Empty text="لا توجد مصروفات ضمن الفترة والحساب المحددين." />}
  </SectionCard>;
}

function ExpensesModule({ siteId, generators, summary, pending, onSubmit }: any) {
  const accountsQuery = trpc.powerhub.companyAccounts.list.useQuery({ siteId });
  const accounts = accountsQuery.data ?? [];
  const [accountId, setAccountId] = useState("");
  const history = useExpenseHistoryFilters(siteId, true, accounts);
  const selectedAccount = accounts.find((account: any) => account.id === Number(accountId));

  return <div className="space-y-6">
    <div className="grid gap-4 sm:grid-cols-3">
      <div className="rounded-xl border border-white/8 bg-[#111823] p-5"><p className="text-sm text-slate-400">إجمالي المصروفات</p><p className="mt-3 font-display text-3xl font-extrabold text-white">{formatValue(summary?.financial.expenses, 2)}</p></div>
      <div className="rounded-xl border border-white/8 bg-[#111823] p-5"><p className="text-sm text-slate-400">التحصيل</p><p className="mt-3 font-display text-3xl font-extrabold text-emerald-400">{formatValue(summary?.financial.collected, 2)}</p></div>
      <div className="rounded-xl border border-[#F5B800]/20 bg-[#111823] p-5"><p className="text-sm text-slate-400">صافي التدفق التشغيلي</p><p className="mt-3 font-display text-3xl font-extrabold text-[#F5B800]">{formatValue(summary?.financial.operatingProfit, 2)}</p></div>
    </div>
    <div className="grid gap-6 xl:grid-cols-[.8fr_1.2fr]">
      <SectionCard title="إضافة مصروف">
        <form className="space-y-4" onSubmit={async (e: FormEvent<HTMLFormElement>) => {
          e.preventDefault();
          if (pending) return;
          const form = e.currentTarget;
          const f = new FormData(form);
          const selectedAccountId = Number(f.get("companyAccountId"));
          const description = String(f.get("description") ?? "").trim();
          const amount = Number(f.get("amount"));
          if (!Number.isInteger(selectedAccountId) || selectedAccountId <= 0) { toast.error("اختر حساب الصرف من حسابات الشركة."); return; }
          if (description.length < 2) { toast.error("اكتب وصفاً للمصروف من حرفين على الأقل."); return; }
          if (!Number.isFinite(amount) || amount <= 0) { toast.error("أدخل مبلغ مصروف صحيحاً أكبر من صفر."); return; }
          try {
            await onSubmit({ siteId, generatorId: f.get("generator") ? Number(f.get("generator")) : undefined, companyAccountId: selectedAccountId, category: String(f.get("category")), description, amount, referenceNo: String(f.get("reference") || "").trim() || undefined });
            form.reset();
            setAccountId("");
          } catch {
            // Keep the form intact after a server error so the user can retry.
          }
        }}>
          <Field label="حساب الصرف من حسابات الشركة">
            <select required name="companyAccountId" value={accountId} onChange={(event) => setAccountId(event.target.value)} className={selectClass}>
              <option value="">اختر الحساب الذي تم الصرف منه</option>
              {accounts.map((account: any) => <option key={account.id} value={account.id}>{account.name} — الرصيد {formatValue(account.balance, 2)} ش</option>)}
            </select>
          </Field>
          {selectedAccount ? <p className="rounded-lg bg-rose-400/10 px-3 py-2 text-xs text-rose-100">سيُخصم مبلغ المصروف من <strong>{selectedAccount.name}</strong> ويسجل كسحب في كشف الحساب، ولا يمكن إتمام العملية إذا كان الرصيد غير كافٍ.</p> : <p className="rounded-lg bg-white/[.03] px-3 py-2 text-xs text-slate-500">يجب تحديد الحساب الذي خرجت منه قيمة المصروف حتى تتطابق المصروفات مع حركة الحسابات.</p>}
          <Field label="فئة المصروف"><select name="category" className={selectClass}><option value="fuel">وقود</option><option value="maintenance">صيانة</option><option value="payroll">رواتب</option><option value="parts">قطع غيار</option><option value="transport">نقل</option><option value="other">أخرى</option></select></Field>
          <Field label="المولد"><select name="generator" className={selectClass}><option value="">مصروف عام</option>{generators.map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
          <Field label="الوصف"><input required name="description" className={inputClass} placeholder="مثال: تعبئة ديزل" /></Field>
          <Field label="المبلغ"><input required name="amount" type="number" min="0.01" step="0.01" className={inputClass} dir="ltr" /></Field>
          <Field label="مرجع"><input name="reference" className={inputClass} placeholder="اختياري" /></Field>
          <Button type="submit" disabled={pending || accountsQuery.isLoading || accountsQuery.isError || !accounts.length} className="w-full bg-[#F5B800] font-bold text-[#0D1117] hover:bg-[#ffd23f]">{pending ? <><Loader2 className="ml-2 h-4 w-4 animate-spin" />جارٍ حفظ المصروف...</> : accountsQuery.isLoading ? "جاري تحميل الحسابات..." : accountsQuery.isError ? "تعذر تحميل حسابات الصرف" : !accounts.length ? "لا توجد حسابات متاحة للصرف" : "حفظ المصروف"}</Button>
        </form>
      </SectionCard>
      <ExpenseHistoryPanel history={history} />
    </div>
  </div>;
}

function ExpensesReadOnlyModule({ siteId, summary }: any) {
  const history = useExpenseHistoryFilters(siteId, false);
  return <div className="space-y-6">
    <div className="grid gap-4 sm:grid-cols-3">
      <div className="rounded-xl border border-white/8 bg-[#111823] p-5"><p className="text-sm text-slate-400">إجمالي المصروفات</p><p className="mt-3 font-display text-3xl font-extrabold text-white">{formatValue(summary?.financial.expenses, 2)}</p></div>
      <div className="rounded-xl border border-white/8 bg-[#111823] p-5"><p className="text-sm text-slate-400">التحصيل</p><p className="mt-3 font-display text-3xl font-extrabold text-emerald-400">{formatValue(summary?.financial.collected, 2)}</p></div>
      <div className="rounded-xl border border-[#F5B800]/20 bg-[#111823] p-5"><p className="text-sm text-slate-400">الربح التشغيلي</p><p className="mt-3 font-display text-3xl font-extrabold text-[#F5B800]">{formatValue(summary?.financial.operatingProfit, 2)}</p></div>
    </div>
    <ExpenseHistoryPanel history={history} canCorrect={false} />
  </div>;
}

function ReportsModule({ summary }: { summary: any }) { return <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{[{ label: "الاستهلاك المفوتر", value: `${formatValue(summary?.energyKwh, 3)} kWh` }, { label: "إجمالي الفوترة", value: formatValue(summary?.financial.invoiced, 2) }, { label: "الأرصدة المستحقة", value: formatValue(summary?.financial.outstanding, 2) }, { label: "الربح التشغيلي", value: formatValue(summary?.financial.operatingProfit, 2) }].map((x) => <div key={x.label} className="rounded-2xl border border-white/8 bg-[#111823] p-5"><p className="text-sm text-slate-400">{x.label}</p><p className="mt-4 font-display text-2xl font-extrabold text-white">{x.value}</p></div>)}</div>; }

function NotificationsModule({ data }: any) { return <SectionCard title={`سجل الإشعارات (${data.length})`}>{data.length ? <div className="overflow-x-auto"><table className="w-full min-w-[650px] text-sm"><thead className="text-right text-xs text-slate-500"><tr><th className="pb-3">المشترك</th><th className="pb-3">القناة</th><th className="pb-3">الحدث</th><th className="pb-3">الحالة</th><th className="pb-3">المحاولات</th></tr></thead><tbody>{data.map((x: any) => <tr key={x.notification.id} className="border-t border-white/7"><td className="py-3 font-bold text-white">{x.subscriber.fullName}</td><td className="py-3">{x.notification.channel}</td><td className="py-3">{x.notification.eventType}</td><td className="py-3"><Badge className="bg-white/5 text-slate-300">{x.notification.status}</Badge></td><td className="py-3">{x.notification.attempts}</td></tr>)}</tbody></table></div> : <Empty text="لم تُنشأ إشعارات بعد. عند ربط مزود WhatsApp أو SMS ستظهر حالات الإرسال والتسليم هنا." />}</SectionCard>; }

const auditActionLabels: Record<string,string> = { platform_admin_create_generator_owner_subscription:"إنشاء اشتراك صاحب مولد من إدارة المنصة", platform_admin_update_subscription:"تحديث اشتراك من إدارة المنصة", renew_subscription_with_addons:"تجديد الاشتراك مع الإضافات", create:"إنشاء", update:"تحديث", approve:"اعتماد", issue:"إصدار", configure:"تغيير الإعدادات", automatic_opening_baseline_approval:"اعتماد القراءة الافتتاحية تلقائياً", bulk_import:"استيراد جماعي", bulk_import_create:"إنشاء من استيراد جماعي", create_with_opening_reading:"إنشاء مشترك مع قراءة افتتاحية", delete:"حذف", deposit:"إيداع", enable:"تفعيل", grant_addon:"منح إضافة", status_change:"تغيير الحالة", sync_cycle:"مزامنة دورة", sync_error:"خطأ في المزامنة", update_payment_documentation_visibility:"تحديث ظهور توثيق الدفع", update_portal_logo:"تحديث شعار بوابة المشترك", update_report_branding:"تحديث هوية التقارير", create_share_link:"إنشاء رابط مشاركة", update_opening_balance:"تحديث الرصيد الافتتاحي", update_phone:"تحديث رقم الجوال", update_sites:"تحديث الفروع المرتبطة", mobile_create:"إنشاء من التطبيق الميداني", automatic_invoice_issue:"إصدار فاتورة تلقائياً" };
const auditEntityLabels: Record<string,string> = { site:"فرع", tenant:"مساحة مولد", subscriber:"مشترك", subscriber_import:"استيراد مشتركين", meter_reading:"قراءة عداد", reading_cycle:"دورة القراءة والفوترة", tariff:"تعرفة", invoice:"فاتورة", payment:"دفعة", expense:"مصروف", company_account:"حساب مالي", financial_settlement:"تسوية مالية", staff_profile:"حساب موظف", chat_conversation:"محادثة دعم", mobile_sync_event:"حدث مزامنة ميدانية", site_portal_settings:"إعدادات بوابة المشترك", tenant_addon_request:"طلب إضافة", tenant_feature_entitlement:"صلاحية ميزة", tenant_owner_profile:"ملف صاحب المولد", tenant_subscription:"اشتراك صاحب المولد" };

function AuditModule({ data }: any) { return <SectionCard title={`سجل التدقيق (${data.length})`}>{data.length ? <div className="overflow-x-auto"><table className="w-full min-w-[660px] text-sm"><thead className="text-right text-xs text-slate-500"><tr><th className="pb-3">العملية</th><th className="pb-3">الكيان</th><th className="pb-3">المعرف</th><th className="pb-3">التوقيت</th></tr></thead><tbody>{data.map((x: any) => <tr key={x.id} className="border-t border-white/7"><td className="py-3 font-bold text-white">{auditActionLabels[x.action] ?? "عملية غير مصنفة"}</td><td className="py-3 text-slate-400">{auditEntityLabels[x.entityType] ?? "عنصر غير مصنف"}</td><td className="py-3 font-display text-xs text-[#F5B800]" dir="ltr">{x.entityId}</td><td className="py-3 text-slate-400">{new Date(x.createdAt).toLocaleString("ar")}</td></tr>)}</tbody></table></div> : <Empty text="سيسجل PowerHub هنا إنشاء وتعديل واعتماد السجلات المالية والتشغيلية بعد بدء الاستخدام." />}</SectionCard>; }
