import { useAuth } from "@/_core/hooks/useAuth";
import DashboardLayout from "@/components/DashboardLayout";
import { OfflineWorkSyncPanel } from "@/components/OfflineWorkSyncPanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { startLogin } from "@/const";
import { useBranchFilter } from "@/hooks/useBranchFilter";
import { trpc } from "@/lib/trpc";
import { copyTextSafely } from "@/lib/clipboard";
import { filterInvoicesByPaymentStatus, invoiceStatusMeta, type PaymentStatusFilter, summarizeOutstandingInvoices } from "@/lib/invoice-collection-presentation";
import { groupInvoiceSmsStatuses, invoiceSmsStatusLabel, isInvoiceSmsEligibleForNewQueue, type InvoiceSmsQueryState } from "@/lib/billing-notification-state";
import { can } from "@shared/powerhub-rbac";
import { BellRing, Copy, ExternalLink, History, Loader2, ReceiptText, RefreshCw, Send, Settings2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";

const inputClass = "h-10 w-full rounded-xl border border-white/10 bg-white/[0.025] px-3 text-sm text-white outline-none transition placeholder:text-slate-600 focus:border-[#F5B800]/70 focus:ring-2 focus:ring-[#F5B800]/15";
function Panel({ title, children }: { title: string; children: React.ReactNode }) { return <Card className="border-white/8 bg-[#111823] shadow-panel"><CardContent className="p-0"><div className="border-b border-white/8 px-5 py-4"><h2 className="font-bold text-white">{title}</h2></div><div className="p-5">{children}</div></CardContent></Card>; }
function money(value: unknown) { return new Intl.NumberFormat("ar", { maximumFractionDigits: 2 }).format(Number(value ?? 0)); }
function dateTime(value: Date | string) { return new Intl.DateTimeFormat("ar", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }

function dateKeyInGaza(value: Date | string = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Gaza", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(value));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
function shiftDateKey(key: string, days: number) {
  const [year, month, day] = key.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}
function monthAnchor(year: number, monthIndex: number, anchor: number) {
  const first = new Date(Date.UTC(year, monthIndex, 1));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  const day = anchor === 30 && first.getUTCMonth() === 1 ? 28 : Math.min(anchor, lastDay);
  return `${first.getUTCFullYear()}-${String(first.getUTCMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
function currentCycleStartKey(config: { cycleType: string; weeklyStartDay: number; monthlyStartDay: number } | undefined, now = new Date()) {
  const today = dateKeyInGaza(now);
  const [year, month, day] = today.split("-").map(Number);
  const monthIndex = month - 1;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const previousMonth = new Date(Date.UTC(year, monthIndex - 1, 1));
  const previousAnchor = (anchor: number) => monthAnchor(previousMonth.getUTCFullYear(), previousMonth.getUTCMonth(), anchor);
  if (!config || config.cycleType === "MONTHLY") {
    const anchor = config?.monthlyStartDay === 30 ? 30 : 1;
    const thisStart = monthAnchor(year, monthIndex, anchor);
    return today < thisStart ? previousAnchor(anchor) : thisStart;
  }
  if (config.cycleType === "WEEKLY") {
    const utcDay = new Date(Date.UTC(year, monthIndex, day)).getUTCDay();
    const startWeekday = config.weeklyStartDay === 7 ? 6 : config.weeklyStartDay - 1;
    return shiftDateKey(today, -((utcDay - startWeekday + 7) % 7));
  }
  if (config.cycleType === "EVERY_10_DAYS") {
    if (config.monthlyStartDay === 1) return `${today.slice(0, 8)}${String(day <= 10 ? 1 : day <= 20 ? 11 : 21).padStart(2, "0")}`;
    if (day >= 30 || (month === 2 && day >= 28)) return monthAnchor(year, monthIndex, 30);
    if (day >= 20) return `${today.slice(0, 8)}20`;
    if (day >= 10) return `${today.slice(0, 8)}10`;
    return previousAnchor(30);
  }
  if (config.monthlyStartDay === 1) return `${today.slice(0, 8)}${String(day <= 15 ? 1 : 16).padStart(2, "0")}`;
  if (day >= 30 || (month === 2 && day >= 28)) return monthAnchor(year, monthIndex, 30);
  if (day >= 15) return `${today.slice(0, 8)}15`;
  return previousAnchor(30);
}

function bulkSendSummary(metadata: unknown) {
  const value = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata as Record<string, unknown> : {};
  const requested = Number(value.requested ?? value.processed ?? 0);
  const submitted = Number(value.submitted ?? value.successful ?? 0);
  const failed = Number(value.failed ?? 0);
  const needsReview = Number(value.needsReview ?? value.needs_review ?? 0);
  return { requested, submitted, failed, needsReview };
}
function notifyInvoiceDispatch(result: { requested: number; submitted: number; failed: number; needsReview?: number }, subject: string, emptyMessage: string) {
  const needsReview = Number(result.needsReview ?? 0);
  const message = `تمت معالجة ${result.requested} ${subject}: ${result.submitted} مرسلة، ${result.failed} غير مرسلة${needsReview ? `، ${needsReview} تحتاج مراجعة` : ""}.`;
  if (result.failed > 0 || needsReview > 0) toast.warning(message);
  else if (result.submitted > 0) toast.success(message);
  else toast.info(emptyMessage);
}
const statusToneClass = { emerald: "border-emerald-400/25 bg-emerald-400/10 text-emerald-300", amber: "border-amber-400/25 bg-amber-400/10 text-amber-200", rose: "border-rose-400/25 bg-rose-400/10 text-rose-300", slate: "border-white/10 bg-white/5 text-slate-300", sky: "border-sky-400/25 bg-sky-400/10 text-sky-300" } as const;

export default function BillingPage() {
  const { isAuthenticated, loading, user } = useAuth();
  const [, setLocation] = useLocation();
  const utils = trpc.useUtils();
  const sitesQuery = trpc.powerhub.sites.list.useQuery(undefined, { enabled: isAuthenticated });
  const { branchId: siteId, setBranchId: setSiteId } = useBranchFilter(sitesQuery.data);
  const [paymentStatusFilter, setPaymentStatusFilter] = useState<PaymentStatusFilter>("all");
  const [deliveryFilter, setDeliveryFilter] = useState<"all" | "unsent">("all");
  const [invoiceDateFilter, setInvoiceDateFilter] = useState<"cycle" | "today" | "yesterday" | "last7" | "lastMonth" | "custom">("cycle");
  const [invoiceDateFrom, setInvoiceDateFrom] = useState("");
  const [invoiceDateTo, setInvoiceDateTo] = useState("");
  const [selectedInvoiceIds, setSelectedInvoiceIds] = useState<Set<number>>(new Set());
  const [invoiceCursors, setInvoiceCursors] = useState<Array<string | undefined>>([undefined]);
  const currentInvoiceCursor = invoiceCursors[invoiceCursors.length - 1];
  const resetInvoicePage = () => {
    setInvoiceCursors([undefined]);
    setSelectedInvoiceIds(new Set());
  };
  const [bulkSendFrom, setBulkSendFrom] = useState("");
  const [bulkSendTo, setBulkSendTo] = useState("");
  const [selectedBulkSendId, setSelectedBulkSendId] = useState<number | null>(null);
  const [previewInvoiceOpen, setPreviewInvoiceOpen] = useState(false);
  const [previewInvoiceUrl, setPreviewInvoiceUrl] = useState<string | null>(null);
  const [previewInvoiceStatus, setPreviewInvoiceStatus] = useState<"loading" | "ready" | "error">("loading");
  const [previewReloadCount, setPreviewReloadCount] = useState(0);
  const previewIframeRef = useRef<HTMLIFrameElement | null>(null);
  const previewInvoiceStatusRef = useRef<"loading" | "ready" | "error">("loading");
  const createInvoiceLinkStartedAt = useRef<number | null>(null);
  const previewInvoiceStartedAt = useRef<number | null>(null);
  const updatePreviewStatus = (status: "loading" | "ready" | "error") => {
    previewInvoiceStatusRef.current = status;
    setPreviewInvoiceStatus(status);
  };
  const enabled = Boolean(isAuthenticated && siteId);
  const readingCycleQuery = trpc.powerhub.readingCycle.get.useQuery({ siteId: siteId ?? 0 }, { enabled });
  const accessQuery = trpc.powerhub.staff.myAccess.useQuery({ siteId: siteId ?? 0 }, { enabled });
  const canIssue = can(accessQuery.data?.role, "issueInvoices");
  const canManageMessaging = can(accessQuery.data?.role, "manageMessaging");
  const invoicesQuery = trpc.powerhub.invoices.page.useQuery({ siteId: siteId ?? 0, limit: 100, cursor: currentInvoiceCursor }, { enabled });
  const subscribersQuery = trpc.powerhub.subscribers.list.useQuery({ siteId: siteId ?? 0 }, { enabled });
  const invoiceNotificationsQuery = trpc.powerhub.notifications.list.useQuery({
    siteId: siteId ?? 0, eventType: "invoice_issued", channel: "sms",
    invoiceIds: invoicesQuery.data?.items.map((invoice) => invoice.id) ?? [],
  }, { enabled: enabled && invoicesQuery.isSuccess });
  const dueInvoiceNotificationCountQuery = trpc.powerhub.notifications.countDueInvoiceNotifications.useQuery(
    { siteId: siteId ?? 0 }, { enabled: enabled && canManageMessaging },
  );
  const bulkInvoiceSendsQuery = trpc.powerhub.notifications.listBulkInvoiceSends.useQuery({ siteId: siteId ?? 0, from: bulkSendFrom || undefined, to: bulkSendTo || undefined }, { enabled: enabled && canManageMessaging });
  const bulkInvoiceSendDetailsQuery = trpc.powerhub.notifications.bulkInvoiceSendDetails.useQuery({ siteId: siteId ?? 0, auditLogId: selectedBulkSendId ?? 0 }, { enabled: enabled && canManageMessaging && selectedBulkSendId !== null });
  const createLink = trpc.powerhub.invoices.createShareLink.useMutation({
    onMutate: () => { createInvoiceLinkStartedAt.current = performance.now(); },
    onSuccess: async (result) => {
      const url = `${window.location.origin}${result.path}`;
      const copied = await copyTextSafely(url);
      const durationMs = Math.round(performance.now() - (createInvoiceLinkStartedAt.current ?? performance.now()));
      if (durationMs >= 500) console.warn("[PowerHub UI latency]", { operation: "invoices.copyShareLink", durationMs, copySucceeded: copied });
      copied ? toast.success("تم نسخ رابط الفاتورة إلى الحافظة.") : toast.error("تعذر نسخ الرابط. انسخه يدوياً.");
    },
    onError: (error) => toast.error(error.message),
  });
  const openInvoice = trpc.powerhub.invoices.createShareLink.useMutation({
    onMutate: () => { previewInvoiceStartedAt.current = performance.now(); },
    onSuccess: (result) => {
      const createDurationMs = Math.round(performance.now() - (previewInvoiceStartedAt.current ?? performance.now()));
      if (createDurationMs >= 500) console.warn("[PowerHub UI latency]", { operation: "invoices.showPreview.createShareLink", durationMs: createDurationMs });
      previewInvoiceStartedAt.current = performance.now();
      updatePreviewStatus("loading");
      setPreviewReloadCount(0);
      setPreviewInvoiceUrl(`${window.location.origin}${result.path}`);
    },
    onError: (error) => toast.error(error.message),
  });

  useEffect(() => {
    if (!previewInvoiceUrl) return;
    updatePreviewStatus("loading");

    let settled = false;
    const sendReadyPing = () => {
      previewIframeRef.current?.contentWindow?.postMessage(
        { type: "powerhub-public-invoice-parent-ready" },
        window.location.origin,
      );
    };

    // The iframe app may finish its React effects before this parent effect
    // subscribes to messages. Repeat a same-origin readiness ping until the
    // child acknowledges success/error, avoiding a lost one-shot postMessage.
    const readyPing = window.setInterval(() => {
      if (!settled) sendReadyPing();
    }, 300);
    sendReadyPing();

    // PublicInvoice gives its own bounded loading result at 16s. Keep the
    // parent fallback later so a slow-but-live iframe can report that result.
    const timeout = window.setTimeout(() => {
      if (settled || previewInvoiceStatusRef.current !== "loading") return;
      settled = true;
      window.clearInterval(readyPing);
      updatePreviewStatus("error");
      const startedAt = previewInvoiceStartedAt.current;
      console.warn("[PowerHub UI latency]", {
        operation: "invoices.showPreview",
        status: "timeout",
        durationMs: startedAt === null ? 18_000 : Math.round(performance.now() - startedAt),
      });
    }, 18_000);

    const handlePreviewMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (event.source !== previewIframeRef.current?.contentWindow) return;
      if (event.data?.type !== "powerhub-public-invoice-status") return;
      if (event.data.status !== "loaded" && event.data.status !== "error") return;
      if (settled) return;

      settled = true;
      window.clearInterval(readyPing);
      window.clearTimeout(timeout);
      updatePreviewStatus(event.data.status === "loaded" ? "ready" : "error");
      if (event.data.status === "loaded" && previewInvoiceStartedAt.current !== null) {
        const durationMs = Math.round(performance.now() - previewInvoiceStartedAt.current);
        if (durationMs >= 500) console.warn("[PowerHub UI latency]", { operation: "invoices.showPreview", durationMs });
      }
    };

    window.addEventListener("message", handlePreviewMessage);
    return () => {
      settled = true;
      window.clearInterval(readyPing);
      window.clearTimeout(timeout);
      window.removeEventListener("message", handlePreviewMessage);
    };
  }, [previewInvoiceUrl, previewReloadCount]);
  const retryFailedInvoiceNotification = trpc.powerhub.notifications.retryFailedInvoiceNotification.useMutation({ onSuccess: async (result) => { await Promise.all([utils.powerhub.notifications.list.invalidate(), utils.powerhub.notifications.countDueInvoiceNotifications.invalidate(), utils.powerhub.notifications.bulkInvoiceSendDetails.invalidate(), utils.powerhub.notifications.listBulkInvoiceSends.invalidate(), utils.powerhub.audit.list.invalidate()]); toast.success(result.status === "submitted" ? "تم إرسال SMS بنجاح." : "تعذر إرسال SMS؛ راجع سبب الفشل."); }, onError: (error) => toast.error(error.message) });
  const retryFailedInvoiceNotifications = trpc.powerhub.notifications.retryFailedInvoiceNotifications.useMutation({ onSuccess: async (result) => { await Promise.all([utils.powerhub.notifications.list.invalidate(), utils.powerhub.notifications.countDueInvoiceNotifications.invalidate(), utils.powerhub.notifications.bulkInvoiceSendDetails.invalidate(), utils.powerhub.notifications.listBulkInvoiceSends.invalidate(), utils.powerhub.audit.list.invalidate()]); toast.success(`تمت معالجة ${result.requested} رسالة: ${result.submitted} مرسلة و${result.failed} غير مرسلة.`); }, onError: (error) => toast.error(error.message) });
  const sendDeferred = trpc.powerhub.notifications.sendDeferredInvoices.useMutation({ onSuccess: async (result) => { setSelectedInvoiceIds(new Set()); await Promise.all([utils.powerhub.notifications.list.invalidate(), utils.powerhub.notifications.countDueInvoiceNotifications.invalidate(), utils.powerhub.notifications.listBulkInvoiceSends.invalidate(), utils.powerhub.invoices.page.invalidate(), utils.powerhub.audit.list.invalidate()]); notifyInvoiceDispatch(result, "رسالة", "لا توجد رسائل SMS مؤجلة مستحقة للإرسال."); }, onError: (error) => toast.error(error.message) });
  const sendAllEligible = trpc.powerhub.notifications.sendAllEligibleInvoiceSms.useMutation({ onSuccess: async (result) => { setSelectedInvoiceIds(new Set()); await Promise.all([utils.powerhub.notifications.list.invalidate(), utils.powerhub.notifications.countDueInvoiceNotifications.invalidate(), utils.powerhub.notifications.listBulkInvoiceSends.invalidate(), utils.powerhub.invoices.page.invalidate(), utils.powerhub.audit.list.invalidate()]); notifyInvoiceDispatch(result, "فاتورة مؤهلة", "لا توجد فواتير مؤهلة للإرسال حالياً."); }, onError: (error) => toast.error(error.message) });
  const sendSelected = trpc.powerhub.notifications.sendBulkInvoiceSms.useMutation({ onSuccess: async (result) => { setSelectedInvoiceIds(new Set()); await Promise.all([utils.powerhub.notifications.list.invalidate(), utils.powerhub.notifications.countDueInvoiceNotifications.invalidate(), utils.powerhub.notifications.listBulkInvoiceSends.invalidate(), utils.powerhub.invoices.page.invalidate(), utils.powerhub.audit.list.invalidate()]); notifyInvoiceDispatch(result, "رسالة", "لم توجد رسائل قابلة للإرسال."); }, onError: (error) => toast.error(error.message) });
  const invoices = invoicesQuery.data?.items ?? [];
  const subscriberNameById = new Map((subscribersQuery.data ?? []).map((subscriber) => [Number(subscriber.id), subscriber.fullName]));
  const notificationsByInvoice = useMemo(
    () => groupInvoiceSmsStatuses(invoiceNotificationsQuery.data ?? []),
    [invoiceNotificationsQuery.data],
  );
  const invoiceSmsQueryState: InvoiceSmsQueryState = invoiceNotificationsQuery.isError
    ? "error"
    : invoiceNotificationsQuery.isSuccess ? "ready" : "loading";
  // An invoice with an existing SMS record must follow that record's retry/review/schedule path.
  const isUnsent = (invoiceId: number) => isInvoiceSmsEligibleForNewQueue(
    notificationsByInvoice.get(invoiceId) ?? [], invoiceSmsQueryState,
  );
  const deferredNotificationCount = dueInvoiceNotificationCountQuery.data?.count ?? 0;
  const outstandingSummary = summarizeOutstandingInvoices(invoices);
  const todayKey = dateKeyInGaza();
  const currentCycleStart = currentCycleStartKey(readingCycleQuery.data);
  const visibleInvoices = filterInvoicesByPaymentStatus(invoices, paymentStatusFilter).filter((invoice) => {
    if (deliveryFilter === "unsent" && !isUnsent(invoice.id)) return false;
    const issueKey = dateKeyInGaza(invoice.issueDate);
    if (invoiceDateFilter === "today") return issueKey === todayKey;
    if (invoiceDateFilter === "yesterday") return issueKey === shiftDateKey(todayKey, -1);
    if (invoiceDateFilter === "last7") return issueKey >= shiftDateKey(todayKey, -6) && issueKey <= todayKey;
    if (invoiceDateFilter === "lastMonth") return issueKey >= shiftDateKey(todayKey, -29) && issueKey <= todayKey;
    if (invoiceDateFilter === "custom") return (!invoiceDateFrom || issueKey >= invoiceDateFrom) && (!invoiceDateTo || issueKey <= invoiceDateTo);
    const cycleStart = invoice.cycleStartAt ? dateKeyInGaza(invoice.cycleStartAt) : null;
    return cycleStart ? cycleStart === currentCycleStart : issueKey >= currentCycleStart && issueKey <= todayKey;
  });
  const selectableVisibleInvoiceIds = visibleInvoices.filter((invoice) => isUnsent(invoice.id)).map((invoice) => invoice.id);
  const allVisibleUnsentSelected = selectableVisibleInvoiceIds.length > 0 && selectableVisibleInvoiceIds.every((invoiceId) => selectedInvoiceIds.has(invoiceId));
  const sendAllDeferred = () => {
    if (!siteId || !deferredNotificationCount || !window.confirm(`سيتم معالجة ${deferredNotificationCount} رسالة SMS مستحقة الآن عبر القنوات المهيأة. هل تريد المتابعة؟`)) return;
    sendDeferred.mutate({ siteId });
  };
  const toggleInvoiceSelection = (invoiceId: number) => setSelectedInvoiceIds((current) => { const next = new Set(current); next.has(invoiceId) ? next.delete(invoiceId) : next.add(invoiceId); return next; });
  const toggleAllVisibleUnsent = () => setSelectedInvoiceIds((current) => { const next = new Set(current); if (allVisibleUnsentSelected) selectableVisibleInvoiceIds.forEach((invoiceId) => next.delete(invoiceId)); else selectableVisibleInvoiceIds.forEach((invoiceId) => next.add(invoiceId)); return next; });
  const sendSelectedInvoices = () => {
    if (!siteId || !selectedInvoiceIds.size || sendSelected.isPending || sendDeferred.isPending || sendAllEligible.isPending ||
      !window.confirm(`سيتم إرسال إشعارات ${selectedInvoiceIds.size} فاتورة محددة لا تملك إشعار SMS مسجلاً الآن. الفواتير المجدولة أو الفاشلة أو التي تحتاج مراجعة ستبقى في مسارها الحالي. هل تريد المتابعة؟`)) return;
    sendSelected.mutate({ siteId, invoiceIds: Array.from(selectedInvoiceIds) });
  };
  const sendAllEligibleInvoices = () => {
    if (!siteId || sendAllEligible.isPending || sendDeferred.isPending || sendSelected.isPending ||
      !window.confirm("سيجهّز النظام إشعارات SMS للفواتير الصادرة التي لا تملك إشعاراً، ثم يعالج الرسائل المستحقة الآن على دفعات آمنة. ستبقى الرسائل المجدولة للمستقبل والفاشلة والتي تحتاج مراجعة دون تغيير. هل تريد المتابعة؟")) return;
    sendAllEligible.mutate({ siteId });
  };
  const clearBulkSendDateFilters = () => { setBulkSendFrom(""); setBulkSendTo(""); };
  const detailItems = bulkInvoiceSendDetailsQuery.data?.items ?? [];
  const detailSuccessful = detailItems.filter((item) => ["submitted", "delivered", "read"].includes(item.status)).length;
  const detailFailed = detailItems.filter((item) => item.status === "failed").length;
  const detailFailedSms = detailItems.filter((item) => item.status === "failed" && item.channel === "sms").length;
  const detailNeedsReview = detailItems.filter((item) => item.status === "needs_review").length;
  const detailPending = Math.max(0, detailItems.length - detailSuccessful - detailFailed - detailNeedsReview);
  const detailSuccessPercent = detailItems.length ? Math.round((detailSuccessful / detailItems.length) * 100) : 0;
  const detailFailedPercent = detailItems.length ? Math.round((detailFailed / detailItems.length) * 100) : 0;
  const detailNeedsReviewPercent = detailItems.length ? Math.round((detailNeedsReview / detailItems.length) * 100) : 0;
  const detailPendingPercent = Math.max(0, 100 - detailSuccessPercent - detailFailedPercent - detailNeedsReviewPercent);
  const retryAllFailedDetails = () => {
    if (!siteId || !detailFailedSms || retryFailedInvoiceNotifications.isPending || !window.confirm(`سيتم إعادة إرسال ${detailFailedSms} رسالة SMS فاشلة ضمن هذه العملية. هل تريد المتابعة؟`)) return;
    retryFailedInvoiceNotifications.mutate({ siteId, notificationIds: detailItems.filter((item) => item.status === "failed" && item.channel === "sms").map((item) => item.notificationId) });
  };

  if (loading) return <DashboardLayout><div className="grid min-h-[60vh] place-items-center"><Loader2 className="h-7 w-7 animate-spin text-[#F5B800]" /></div></DashboardLayout>;
  if (!isAuthenticated) return <DashboardLayout><div className="mx-auto mt-12 max-w-xl rounded-[28px] border border-[#F5B800]/20 bg-[#111823] p-8 text-center shadow-panel"><ReceiptText className="mx-auto h-8 w-8 text-[#F5B800]" /><h1 className="mt-5 text-xl font-extrabold text-white">سجّل الدخول لإدارة الفواتير</h1><p className="mt-3 leading-7 text-slate-400">الفوترة والتحصيل عمليات مالية تتطلب حساباً مصرحاً له.</p><Button onClick={() => startLogin()} className="mt-6 bg-[#F5B800] font-bold text-[#0D1117] hover:bg-[#ffd23f]">تسجيل الدخول</Button></div></DashboardLayout>;
  if (!sitesQuery.data?.length) return <DashboardLayout><div className="mx-auto mt-12 max-w-xl rounded-[28px] border border-white/10 bg-[#111823] p-8 text-center text-slate-400">أنشئ محطة أولاً لإدارة الفواتير.</div></DashboardLayout>;

  return <DashboardLayout><div className="space-y-6 pb-12"><header className="flex flex-col gap-4 rounded-[24px] border border-white/8 bg-[#111823]/80 p-5 shadow-panel sm:flex-row sm:items-center sm:justify-between"><div><div className="flex items-center gap-2 text-sm font-bold text-[#F5B800]"><ReceiptText className="h-4 w-4" />الدورة المالية</div><h1 className="mt-1 text-2xl font-extrabold text-white">الفواتير</h1><p className="mt-2 text-sm text-slate-400">راجع الفواتير الصادرة، وفلاترها، وحالات السداد والإشعارات. تصدر الفاتورة تلقائياً بعد اعتماد القراءة وفق مسار التشغيل.</p></div><select aria-label="فلتر الفرع الموحد" value={siteId ?? ""} onChange={(event) => { setSiteId(Number(event.target.value)); resetInvoicePage(); setSelectedBulkSendId(null); }} className={inputClass}>{sitesQuery.data.map((site) => <option className="bg-[#111823]" key={site.id} value={site.id}>{site.name}</option>)}</select></header>
    <section className="grid gap-4 sm:grid-cols-3"><Card className="border-rose-400/20 bg-rose-400/[.055]"><CardContent className="p-5"><p className="text-sm text-rose-100/75">الأرصدة المتبقية في الصفحة الحالية</p><p className="mt-3 text-3xl font-extrabold text-rose-200">{money(outstandingSummary.outstanding)}</p></CardContent></Card><Card className="border-amber-400/20 bg-amber-400/[.055]"><CardContent className="p-5"><p className="text-sm text-amber-100/75">الفواتير المدفوعة جزئياً في الصفحة</p><p className="mt-3 text-3xl font-extrabold text-amber-200">{outstandingSummary.partiallyPaidCount}</p><p className="mt-2 text-xs text-amber-100/65">تحتاج متابعة الرصيد المتبقي</p></CardContent></Card><Card className="border-sky-400/20 bg-sky-400/[.055]"><CardContent className="p-5"><p className="text-sm text-sky-100/75">رسائل SMS المستحقة للإرسال</p><p className="mt-3 text-3xl font-extrabold text-sky-200">{dueInvoiceNotificationCountQuery.isLoading ? "…" : deferredNotificationCount}</p><p className="mt-2 text-xs text-sky-100/65">حان موعد معالجتها ولم تُحسم بعد؛ يمكنك معالجتها يدوياً عند الحاجة.</p></CardContent></Card></section>
    <div className="space-y-6"><Panel title={`الفواتير الصادرة (${visibleInvoices.length}${paymentStatusFilter === "all" && deliveryFilter === "all" ? "" : ` من ${invoices.length}`})`}><div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/8 bg-white/[.018] p-3"><div><p className="text-sm font-bold text-white">فلاتر الفواتير</p><p className="mt-1 text-xs text-slate-500">فلتر الفترة والسداد وحالة SMS. أدوات الإرسال في قسم مستقل أسفل القائمة.</p></div><Button type="button" size="sm" variant="outline" onClick={() => setLocation("/notifications")} className="border-[#F5B800]/35 text-[#F5B800] hover:bg-[#F5B800]/10"><Settings2 className="ml-1 h-3.5 w-3.5" />إعدادات الرسائل والقوالب</Button></div><div className="mb-4"><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><label className="text-xs text-slate-400">فترة الفواتير<select aria-label="فلتر فترة الفواتير" value={invoiceDateFilter} onChange={(event) => { setInvoiceDateFilter(event.target.value as typeof invoiceDateFilter); resetInvoicePage(); }} className={`${inputClass} mt-1`}><option value="cycle">الدورة الحالية</option><option value="today">اليوم</option><option value="yesterday">أمس</option><option value="last7">آخر 7 أيام</option><option value="lastMonth">آخر شهر</option><option value="custom">مخصص</option></select></label><label className="text-xs text-slate-400">حالة السداد<select value={paymentStatusFilter} onChange={(event) => { setPaymentStatusFilter(event.target.value as PaymentStatusFilter); resetInvoicePage(); }} className={`${inputClass} mt-1`}><option className="bg-[#111823]" value="all">كل الفواتير</option><option className="bg-[#111823]" value="paid">مدفوعة بالكامل</option><option className="bg-[#111823]" value="partially_paid">مدفوعة جزئياً</option><option className="bg-[#111823]" value="unpaid">غير مدفوعة</option></select></label><label className="text-xs text-slate-400">إشعار الفاتورة<select value={deliveryFilter} onChange={(event) => { setDeliveryFilter(event.target.value as "all" | "unsent"); resetInvoicePage(); }} className={`${inputClass} mt-1`}><option className="bg-[#111823]" value="all">كل حالات الإشعار</option><option className="bg-[#111823]" value="unsent">لا يوجد إشعار SMS مسجّل</option></select></label>{invoiceDateFilter === "custom" && <><label className="text-xs text-slate-400">من تاريخ<input aria-label="بداية فترة الفواتير" type="date" value={invoiceDateFrom} max={invoiceDateTo || undefined} onChange={(event) => { setInvoiceDateFrom(event.target.value); resetInvoicePage(); }} className={`${inputClass} mt-1`} dir="ltr" /></label><label className="text-xs text-slate-400">إلى تاريخ<input aria-label="نهاية فترة الفواتير" type="date" value={invoiceDateTo} min={invoiceDateFrom || undefined} onChange={(event) => { setInvoiceDateTo(event.target.value); resetInvoicePage(); }} className={`${inputClass} mt-1`} dir="ltr" /></label></>}</div></div>{visibleInvoices.length ? <div className="overflow-x-auto"><table className="w-full min-w-[1040px] text-xs"><thead className="text-right text-xs text-slate-500"><tr><th className="px-2 pb-3 text-right">اسم المشترك</th><th className="px-2 pb-3 text-center">رقم الفاتورة</th><th className="px-3 pb-3 text-center">الفترة</th><th className="px-3 pb-3 text-center">الاستهلاك</th><th className="pb-3">الإجمالي / المدفوع</th><th className="pb-3">المتبقي</th><th className="pb-3">حالة SMS</th><th className="pb-3">الحالة</th><th className="pb-3">مشاركة</th></tr></thead><tbody>{visibleInvoices.map((invoice) => { const status = invoiceStatusMeta(invoice.status); const paidPercent = Number(invoice.totalAmount) ? Math.min(100, Math.round((Number(invoice.paidAmount) / Number(invoice.totalAmount)) * 100)) : 0; const notificationStates = notificationsByInvoice.get(invoice.id) ?? []; const notificationLabel = invoiceSmsStatusLabel(notificationStates, invoiceSmsQueryState); const selectable = isUnsent(invoice.id) && !invoiceNotificationsQuery.isLoading && !invoiceNotificationsQuery.isError; return <tr className="border-t border-white/7" key={invoice.id}><td className="px-2 py-3 font-medium leading-4 text-white">{subscriberNameById.get(Number(invoice.subscriberId)) ?? "مشترك"}</td><td className="px-2 py-3 text-center align-top"><div className="mx-auto flex w-full min-w-0 flex-col items-center gap-1"><input aria-label={`تحديد الفاتورة ${invoice.invoiceNo}`} type="checkbox" disabled={!canManageMessaging || !selectable} checked={selectedInvoiceIds.has(invoice.id)} onChange={() => toggleInvoiceSelection(invoice.id)} className="h-3.5 w-3.5 accent-[#F5B800] disabled:cursor-not-allowed disabled:opacity-30" /><span className="w-full whitespace-nowrap text-center font-mono text-xs font-bold leading-4 tabular-nums text-[#F5B800]" dir="ltr">{invoice.invoiceNo}</span></div></td><td className="px-3 py-3 text-center text-slate-300">{invoice.billingPeriod}</td><td className="px-3 py-3 text-center">{money(invoice.consumptionKwh)} kWh</td><td className="py-3 text-white">{money(invoice.totalAmount)} <span className="text-slate-600">/</span> <span className="text-emerald-300">{money(invoice.paidAmount)}</span></td><td className={`py-3 font-bold ${Number(invoice.balanceDue) === 0 ? "text-emerald-300" : "text-rose-300"}`}>{money(invoice.balanceDue)}<span className="mr-2 text-[10px] font-normal text-slate-500">{paidPercent}%</span></td><td className="py-3"><Badge className={notificationLabel === "مرسل" ? "bg-emerald-500/15 text-emerald-300" : notificationLabel === "في قائمة الانتظار" ? "bg-sky-500/15 text-sky-300" : notificationLabel === "فشل" ? "bg-rose-500/15 text-rose-300" : notificationLabel === "تحتاج مراجعة" ? "bg-amber-500/15 text-amber-200" : "bg-slate-500/15 text-slate-300"}>{notificationLabel}</Badge></td><td className="py-3"><Badge className={statusToneClass[status.tone]}>{status.label}</Badge></td><td className="py-3">{canIssue ? <div className="flex flex-wrap gap-1"><Button size="sm" variant="ghost" disabled={createLink.isPending} onClick={() => createLink.mutate({ siteId: siteId!, invoiceId: invoice.id })} className="text-[#F5B800] hover:bg-[#F5B800]/10 hover:text-[#ffd23f]"><Copy className="ml-1 h-3.5 w-3.5" />نسخ رابط الفاتورة</Button><Button size="sm" variant="ghost" disabled={openInvoice.isPending} onClick={() => { setPreviewInvoiceOpen(true); updatePreviewStatus("loading"); openInvoice.mutate({ siteId: siteId!, invoiceId: invoice.id }); }} className="text-sky-300 hover:bg-sky-400/10"><ExternalLink className="ml-1 h-3.5 w-3.5" />إظهار الفاتورة</Button></div> : <span className="text-xs text-slate-600">—</span>}</td></tr>; })}</tbody></table></div> : <div className="rounded-xl border border-dashed border-white/10 bg-white/[.015] px-4 py-10 text-center text-sm text-slate-500">لا توجد فواتير مطابقة في هذه الصفحة. جرّب الانتقال إلى الصفحة التالية أو تخفيف الفلاتر.</div>}</Panel><div className="flex flex-col gap-3 rounded-xl border border-white/8 bg-white/[.018] p-3 sm:flex-row sm:items-center sm:justify-between"><p className="text-xs text-slate-400">الصفحة ${invoiceCursors.length} · ${visibleInvoices.length} فاتورة مطابقة في هذه الصفحة. الإجماليات أعلاه تخص السجلات المعروضة حاليًا.</p><div className="flex gap-2"><Button type="button" size="sm" variant="outline" disabled={invoiceCursors.length <= 1 || invoicesQuery.isFetching} onClick={() => setInvoiceCursors((cursors) => cursors.length > 1 ? cursors.slice(0, -1) : cursors)}>السابق</Button><Button type="button" size="sm" variant="outline" disabled={!invoicesQuery.data?.hasNext || invoicesQuery.isFetching} onClick={() => { const next = invoicesQuery.data?.nextCursor; if (next) setInvoiceCursors((cursors) => [...cursors, next]); }}>التالي</Button></div></div>
      {canManageMessaging && <Panel title="إشعارات الفواتير"><div className="mb-4 rounded-xl border border-white/8 bg-white/[.018] p-3"><p className="text-sm font-bold text-white">إدارة رسائل SMS المرتبطة بالفواتير</p><p className="mt-1 text-xs leading-6 text-slate-400">الفواتير التي لا تملك إشعار SMS فقط يمكن إضافتها هنا. الرسائل الفاشلة تعاد من مسار إعادة المحاولة، والرسائل التي تحتاج مراجعة تبقى في مركز الرسائل. لن تُرسل الرسائل المجدولة قبل موعدها.</p><Button type="button" size="sm" variant="outline" onClick={() => setLocation("/notifications")} className="mt-3 border-white/10 text-slate-200"><Settings2 className="ml-1 h-3.5 w-3.5" />فتح مركز الرسائل</Button></div><div className="flex flex-wrap gap-2"><Button type="button" size="sm" disabled={!selectedInvoiceIds.size || sendSelected.isPending || sendDeferred.isPending || sendAllEligible.isPending || !canManageMessaging} onClick={sendSelectedInvoices} className="bg-emerald-400 text-[#0D1117] hover:bg-emerald-300">{sendSelected.isPending ? <Loader2 className="ml-1 h-3.5 w-3.5 animate-spin" /> : <Send className="ml-1 h-3.5 w-3.5" />}إرسال المحددة التي لا تملك إشعارًا ({selectedInvoiceIds.size})</Button><Button type="button" size="sm" disabled={!deferredNotificationCount || dueInvoiceNotificationCountQuery.isLoading || sendDeferred.isPending || sendSelected.isPending || sendAllEligible.isPending || !canManageMessaging} onClick={sendAllDeferred} className="bg-sky-400 text-[#0D1117] hover:bg-sky-300">{sendDeferred.isPending ? <Loader2 className="ml-1 h-3.5 w-3.5 animate-spin" /> : <Send className="ml-1 h-3.5 w-3.5" />}إرسال الرسائل المستحقة الآن ({deferredNotificationCount})</Button><Button type="button" size="sm" disabled={sendAllEligible.isPending || sendDeferred.isPending || sendSelected.isPending || !canManageMessaging} onClick={sendAllEligibleInvoices} className="bg-violet-400 text-[#0D1117] hover:bg-violet-300">{sendAllEligible.isPending ? <Loader2 className="ml-1 h-3.5 w-3.5 animate-spin" /> : <Send className="ml-1 h-3.5 w-3.5" />}تجهيز وإرسال كل الفواتير المؤهلة</Button></div></Panel>}
      {canManageMessaging && <Panel title="سجل الإرسال الجماعي"><div className="mb-4 flex items-start gap-3 rounded-xl border border-[#F5B800]/15 bg-[#F5B800]/[.055] p-3 text-sm text-amber-100"><History className="mt-0.5 h-4 w-4 shrink-0 text-[#F5B800]" /><p>اضغط أي عملية لعرض فواتيرها وحالة كل إشعار. يعرض السجل آخر 20 عملية مطابقة للنطاق الزمني.</p></div><div className="mb-4 grid gap-3 rounded-xl border border-white/8 bg-white/[.018] p-3 sm:grid-cols-[1fr_1fr_auto]"><label className="text-xs text-slate-400">من تاريخ<input aria-label="بداية نطاق سجل الإرسال" type="date" value={bulkSendFrom} max={bulkSendTo || undefined} onChange={(event) => setBulkSendFrom(event.target.value)} className={`${inputClass} mt-1`} dir="ltr" /></label><label className="text-xs text-slate-400">إلى تاريخ<input aria-label="نهاية نطاق سجل الإرسال" type="date" value={bulkSendTo} min={bulkSendFrom || undefined} onChange={(event) => setBulkSendTo(event.target.value)} className={`${inputClass} mt-1`} dir="ltr" /></label><div className="flex items-end"><Button type="button" size="sm" variant="outline" onClick={clearBulkSendDateFilters} disabled={!bulkSendFrom && !bulkSendTo} className="w-full border-white/10 text-slate-200 hover:bg-white/5">مسح الفلتر</Button></div></div>{bulkInvoiceSendsQuery.isLoading ? <div className="flex items-center gap-2 py-5 text-sm text-slate-400"><Loader2 className="h-4 w-4 animate-spin text-[#F5B800]" />جارٍ تحميل سجل الإرسال…</div> : bulkInvoiceSendsQuery.data?.length ? <div className="overflow-x-auto"><table className="w-full min-w-[700px] text-xs"><thead className="text-right text-xs text-slate-500"><tr><th className="pb-3">المنفّذ</th><th className="pb-3">وقت الإرسال</th><th className="pb-3">الطريقة</th><th className="pb-3">الفواتير</th><th className="pb-3">النتيجة</th></tr></thead><tbody>{bulkInvoiceSendsQuery.data.map((entry) => { const summary = bulkSendSummary(entry.metadata); const actor = entry.executorName || entry.executorEmail || `مستخدم #${entry.executorId ?? "—"}`; return <tr className="cursor-pointer border-t border-white/7 transition-colors hover:bg-[#F5B800]/[.045] focus-within:bg-[#F5B800]/[.045]" key={entry.id} onClick={() => setSelectedBulkSendId(entry.id)}><td className="py-3 font-bold text-white"><button type="button" onClick={() => setSelectedBulkSendId(entry.id)} className="text-right underline-offset-4 hover:text-[#F5B800] hover:underline focus:outline-none focus-visible:text-[#F5B800]">{actor}</button></td><td className="py-3 text-slate-300" dir="rtl">{dateTime(entry.createdAt)}</td><td className="py-3"><Badge className="bg-sky-400/10 text-sky-300">{entry.action === "send_invoice_sms_batch" ? "SMS جماعي" : "إشعارات الفواتير"}</Badge></td><td className="py-3 text-white">{summary.requested}</td><td className="py-3"><span className="text-emerald-300">{summary.submitted} معالج</span><span className="mx-2 text-slate-600">/</span><span className={summary.failed ? "text-rose-300" : "text-slate-400"}>{summary.failed} متعذر</span>{summary.needsReview ? <span className="mr-2 font-semibold text-amber-200">{summary.needsReview} تحتاج مراجعة</span> : null}</td></tr>; })}</tbody></table></div> : <div className="rounded-xl border border-dashed border-white/10 bg-white/[.015] px-4 py-8 text-center text-sm text-slate-500">لا توجد عمليات إرسال جماعي مطابقة للنطاق الزمني المحدد.</div>}</Panel>}
      <Dialog open={previewInvoiceOpen} onOpenChange={(open) => { setPreviewInvoiceOpen(open); if (!open) { setPreviewInvoiceUrl(null); updatePreviewStatus("loading"); } }}>
        <DialogContent dir="rtl" className="flex h-[92vh] max-h-[92vh] max-w-6xl flex-col overflow-hidden border-white/10 bg-[#111823] p-0 text-white">
          <DialogHeader className="border-b border-white/10 px-5 py-3">
            <DialogTitle>معاينة الفاتورة</DialogTitle>
            <DialogDescription className="text-slate-400">تظهر الفاتورة هنا فوق الصفحة الحالية دون فتح نافذة أو تبويب جديد.</DialogDescription>
          </DialogHeader>
          {!previewInvoiceUrl ? (
            <div role="status" aria-live="polite" className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-[#0D1117] px-6 py-10 text-center">
              <Loader2 className="h-8 w-8 animate-spin text-[#F5B800]" />
              <p className="text-sm text-slate-300">جارٍ تجهيز رابط الفاتورة…</p>
            </div>
          ) : previewInvoiceStatus === "error" ? (
            <div role="alert" className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 bg-[#0D1117] px-6 py-10 text-center">
              <ReceiptText className="h-10 w-10 text-[#F5B800]" />
              <h3 className="text-lg font-bold text-white">تعذر تحميل الفاتورة</h3>
              <p className="max-w-lg text-sm leading-7 text-slate-400">لم تصل نتيجة تحميل بيانات الفاتورة. يمكنك إعادة المحاولة أو فتح الرابط في صفحة مستقلة.</p>
              <div className="flex flex-wrap justify-center gap-3">
                <Button type="button" className="bg-[#F5B800] font-bold text-[#0D1117] hover:bg-[#ffd23f]" onClick={() => { previewInvoiceStartedAt.current = performance.now(); updatePreviewStatus("loading"); setPreviewReloadCount((count) => count + 1); }}>إعادة المحاولة</Button>
                <Button type="button" variant="outline" className="border-white/15 text-white hover:bg-white/5 hover:text-white" onClick={() => window.open(previewInvoiceUrl, "_blank", "noopener,noreferrer")}>فتح في صفحة مستقلة</Button>
              </div>
            </div>
          ) : previewInvoiceUrl ? (
            <iframe title="معاينة الفاتورة" key={previewReloadCount} ref={previewIframeRef} src={previewInvoiceUrl} className="h-full min-h-0 w-full flex-1 bg-[#0D1117]" referrerPolicy="strict-origin-when-cross-origin" />
          ) : null}
        </DialogContent>
      </Dialog>
      <Dialog open={selectedBulkSendId !== null} onOpenChange={(open) => !open && setSelectedBulkSendId(null)}><DialogContent dir="rtl" className="max-h-[90vh] max-w-6xl overflow-y-auto border-white/10 bg-[#111823] text-white"><DialogHeader><DialogTitle>تفاصيل عملية الإرسال الجماعي</DialogTitle><DialogDescription className="text-slate-400">قائمة الفواتير المشمولة وحالة كل إشعار ضمن هذه العملية.</DialogDescription></DialogHeader>{bulkInvoiceSendDetailsQuery.isLoading ? <div className="flex items-center gap-2 py-10 text-sm text-slate-400"><Loader2 className="h-4 w-4 animate-spin text-[#F5B800]" />جارٍ تحميل تفاصيل العملية…</div> : detailItems.length ? <><div className="rounded-xl border border-white/8 bg-white/[.018] p-4"><div className="mb-3 flex flex-wrap items-center justify-between gap-3"><div><p className="font-bold text-white">تقدم نتائج الإرسال</p><p className="mt-1 text-xs text-slate-400">{detailSuccessful} ناجح، {detailFailed} متعذر{detailNeedsReview ? `، ${detailNeedsReview} تحتاج مراجعة` : ""}{detailPending ? `، ${detailPending} قيد المعالجة` : ""} من أصل {detailItems.length} إشعار.</p></div><Button type="button" size="sm" disabled={!detailFailedSms || retryFailedInvoiceNotifications.isPending} onClick={retryAllFailedDetails} className="bg-rose-400/15 text-rose-100 hover:bg-rose-400/25"><RefreshCw className={`ml-1 h-3.5 w-3.5 ${retryFailedInvoiceNotifications.isPending ? "animate-spin" : ""}`} />إعادة إرسال SMS الفاشل ({detailFailedSms})</Button></div><div aria-label="تقدم نجاح وفشل عملية الإرسال" aria-valuemin={0} aria-valuemax={100} aria-valuenow={detailSuccessPercent} role="progressbar" className="flex h-3 w-full overflow-hidden rounded-full bg-white/10"><div className="bg-emerald-400 transition-all" style={{ width: `${detailSuccessPercent}%` }} /><div className="bg-rose-400 transition-all" style={{ width: `${detailFailedPercent}%` }} /><div className="bg-amber-400 transition-all" style={{ width: `${detailNeedsReviewPercent}%` }} /><div className="bg-slate-500 transition-all" style={{ width: `${detailPendingPercent}%` }} /></div><div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs"><span className="text-emerald-300">نسبة النجاح: {detailSuccessPercent}%</span><span className="text-rose-300">نسبة التعذر: {detailFailedPercent}%</span>{detailNeedsReview ? <span className="font-semibold text-amber-200">تحتاج مراجعة: {detailNeedsReviewPercent}%</span> : null}{detailPending ? <span className="text-slate-400">قيد المعالجة: {detailPendingPercent}%</span> : null}</div></div><div className="overflow-x-auto rounded-xl border border-white/8"><table className="w-full min-w-[980px] text-right text-sm"><thead className="sticky top-0 bg-[#18212e] text-xs text-slate-400"><tr><th className="px-4 py-3">الفاتورة</th><th className="px-4 py-3">المشترك</th><th className="px-4 py-3">القناة</th><th className="px-4 py-3">الحالة</th><th className="px-4 py-3">سبب التعذر</th><th className="px-4 py-3">إجراءات</th></tr></thead><tbody className="divide-y divide-white/7">{detailItems.map((item) => <tr key={item.notificationId}><td className="px-4 py-3"><Button type="button" size="sm" variant="ghost" disabled={!canIssue || openInvoice.isPending} onClick={() => openInvoice.mutate({ siteId: siteId!, invoiceId: item.invoiceId })} className="font-display font-bold text-[#F5B800] hover:bg-[#F5B800]/10 hover:text-[#ffd23f]" dir="ltr"><ExternalLink className="ml-1 h-3.5 w-3.5" />{item.invoiceNo}</Button></td><td className="px-4 py-3 text-white">{item.subscriberName}</td><td className="px-4 py-3"><Badge className={item.channel === "sms" ? "bg-sky-400/10 text-sky-300" : "bg-emerald-400/10 text-emerald-300"}>{item.channel === "sms" ? "SMS" : "WhatsApp"}</Badge></td><td className="px-4 py-3"><Badge className={item.status === "failed" ? "bg-rose-500/15 text-rose-300" : item.status === "needs_review" ? "bg-amber-500/15 text-amber-200" : ["delivered", "read", "submitted"].includes(item.status) ? "bg-emerald-500/15 text-emerald-300" : "bg-slate-500/15 text-slate-300"}>{item.status === "failed" ? "غير مرسلة" : item.status === "needs_review" ? "تحتاج مراجعة" : ["submitted", "delivered", "read"].includes(item.status) ? "مرسلة" : item.status === "pending" ? "مؤجل" : "قيد المعالجة"}</Badge></td><td className="px-4 py-3 text-xs text-rose-200">{item.lastError ?? "—"}</td><td className="px-4 py-3">{item.status === "failed" && item.channel === "sms" ? <Button type="button" size="sm" disabled={retryFailedInvoiceNotification.isPending || retryFailedInvoiceNotifications.isPending} onClick={() => retryFailedInvoiceNotification.mutate({ siteId: siteId!, notificationId: item.notificationId })} className="bg-rose-400/15 text-rose-100 hover:bg-rose-400/25"><RefreshCw className={`ml-1 h-3.5 w-3.5 ${retryFailedInvoiceNotification.isPending ? "animate-spin" : ""}`} />إعادة إرسال SMS</Button> : <span className="text-xs text-slate-600">—</span>}</td></tr>)}</tbody></table></div></> : <div className="rounded-xl border border-dashed border-white/10 bg-white/[.015] px-4 py-10 text-center text-sm text-slate-500">لا توجد إشعارات قابلة للعرض لهذه العملية؛ قد تكون العملية القديمة لا تحتوي معرفات رسائل قابلة للاسترجاع.</div>}</DialogContent></Dialog></div></div></DashboardLayout>;
}
