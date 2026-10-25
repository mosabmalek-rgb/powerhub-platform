import { useAuth } from "@/_core/hooks/useAuth";
import DashboardLayout from "@/components/DashboardLayout";
import BranchAnomalySettings from "@/components/BranchAnomalySettings";
import BulkReadingEntry from "@/components/BulkReadingEntry";
import ReadingWorkflowPanel from "@/components/ReadingWorkflowPanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { startLogin } from "@/const";
import { useBranchFilter } from "@/hooks/useBranchFilter";
import { enqueueReading, enqueueReadingWithInvoiceNumber, isQueuedReadingReadyForSync, listQueuedReadings, removeQueuedReading, type QueuedReading } from "@/lib/offline-reading-queue";
import { getPowerHubDeviceId } from "@/lib/offline-auth";
import { hasAvailableOfflineNumberGrant, persistOfflineNumberGrant } from "@/lib/offline-number-ranges";
import { listOfflineWork, requeueOfflineWorkForManualRetry, updateOfflineWork, type QueuedOfflineWork, type ReadingCreateDraft } from "@/lib/offline-work-queue";
import { listSyncMetadata, upsertSyncMetadata } from "@/lib/offline-sync-metadata";
import { classifySyncResult, isManualSyncRecoveryRequired, SYNC_MAX_ATTEMPTS, type SyncMetadata } from "@/lib/offline-sync-engine";
import { executeReadyOperations, type SyncTransportResult } from "@/lib/offline-sync-executor";
import { withOfflineSyncLock } from "@/lib/offline-sync-lock";
import { removeOfflineConflict, upsertOfflineConflict } from "@/lib/offline-workspace-db";
import { trpc } from "@/lib/trpc";
import { downloadReportHtmlAsPdf } from "@/lib/report-pdf";
import { formatReportDate } from "@/lib/report-design-system";
import { loadExcelJS } from "@/lib/lazy-report-deps";
import { can } from "@shared/powerhub-rbac";
import { Camera, CloudOff, Download, FileSpreadsheet, Gauge, Loader2, RotateCw, Send, Trash2, Wifi } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePowerHubConnectivity } from "@/lib/offline-connectivity";
import { toast } from "sonner";
import { useLocation } from "wouter";

const inputClass = "h-10 w-full rounded-xl border border-white/10 bg-white/[0.025] px-3 text-sm text-white outline-none transition placeholder:text-slate-600 focus:border-[#F5B800]/70 focus:ring-2 focus:ring-[#F5B800]/15";

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return <Card className="border-white/8 bg-[#111823] shadow-panel"><CardContent className="p-0"><div className="border-b border-white/8 px-5 py-4"><h2 className="font-bold text-white">{title}</h2></div><div className="p-5">{children}</div></CardContent></Card>;
}

function ReadingTableSkeleton() {
  return <div role="status" aria-label="جارٍ تحميل القراءات" className="space-y-3 py-2">{Array.from({ length: 5 }, (_, index) => <div key={index} className="grid grid-cols-6 items-center gap-4 border-b border-white/7 py-3"><Skeleton className="h-4 w-28" /><Skeleton className="h-4 w-20" /><Skeleton className="h-4 w-16" /><Skeleton className="h-4 w-20" /><Skeleton className="h-6 w-20 rounded-full" /><Skeleton className="h-8 w-16 rounded-lg" /></div>)}</div>;
}

export default function MeterReadingsPage() {
  const [, setLocation] = useLocation();
  const { isAuthenticated, loading, user } = useAuth();
  const utils = trpc.useUtils();
  const reserveOfflineInvoiceNumbers = trpc.powerhub.offlineNumbering.reserve.useMutation();
  const sitesQuery = trpc.powerhub.sites.list.useQuery(undefined, { enabled: isAuthenticated });
  const { branchId: siteId, setBranchId: setSiteId } = useBranchFilter(sitesQuery.data);
  const [queuedReadings, setQueuedReadings] = useState<QueuedReading[]>([]);
  const { isOnline, reconnectGeneration } = usePowerHubConnectivity();
  const lastAutoSyncGeneration = useRef(0);
  const [readingSearch, setReadingSearch] = useState("");
  const [readingStatus, setReadingStatus] = useState<"all" | "pending_review" | "approved">("all");
  const [readingPage, setReadingPage] = useState(1);
  const [readingPageSize, setReadingPageSize] = useState<10 | 20 | 50>(10);
  const [exportStartDate, setExportStartDate] = useState("");
  const [exportEndDate, setExportEndDate] = useState("");
  const [invoiceSendStatus, setInvoiceSendStatus] = useState<"all" | "sent" | "unsent">("unsent");
  const [selectedInvoiceIds, setSelectedInvoiceIds] = useState<number[]>([]);
  const [selectedReadingImage, setSelectedReadingImage] = useState<string | null>(null);
  const pdfRef = useRef<HTMLDivElement>(null);

  const enabled = Boolean(isAuthenticated && siteId);
  const subscribersQuery = trpc.powerhub.subscribers.list.useQuery({ siteId: siteId ?? 0 }, { enabled });
  const readingsQuery = trpc.powerhub.readings.page.useQuery({ siteId: siteId ?? 0, limit: 200 }, { enabled });
  const invoicesQuery = trpc.powerhub.invoices.page.useQuery({ siteId: siteId ?? 0, limit: 200 }, { enabled });
  const readings = readingsQuery.data?.items ?? [];
  const invoices = invoicesQuery.data?.items ?? [];
  const invoiceNotificationsQuery = trpc.powerhub.notifications.list.useQuery({ siteId: siteId ?? 0, eventType: "invoice_issued" }, { enabled });
  const accessQuery = trpc.powerhub.staff.myAccess.useQuery({ siteId: siteId ?? 0 }, { enabled });
  const anomalyQuery = trpc.powerhub.sites.anomalyAlert.useQuery({ siteId: siteId ?? 0 }, { enabled });
  const role = accessQuery.data?.role;
  const permissions = accessQuery.data?.permissions;
  const canRecordReading = can(role, "recordReadings", permissions);
  const canApproveReading = can(role, "approveReadings", permissions);
  const canIssueInvoice = can(role, "issueInvoices", permissions);
  const canCreateAndInvoiceReading = canRecordReading && canApproveReading && canIssueInvoice;
  const canSendInvoiceSms = can(role, "manageMessaging", permissions);
  const canSettleLegacyReading = canApproveReading && canIssueInvoice;
  const currentSite = useMemo(() => sitesQuery.data?.find((site) => site.id === siteId), [siteId, sitesQuery.data]);
  useEffect(() => {
    if (!isAuthenticated || !canIssueInvoice || !["owner", "manager", "accountant"].includes(role ?? "") || !siteId || !user?.id || !currentSite?.tenantId || !isOnline) return;
    let cancelled = false;
    void (async () => {
      const deviceId = await getPowerHubDeviceId();
      const scope = { userId: Number(user.id), tenantId: Number(currentSite.tenantId), siteId, deviceId };
      const partitionKey = String(new Date().getUTCFullYear());
      if (await hasAvailableOfflineNumberGrant(scope, "invoice", partitionKey)) return;
      const grant = await reserveOfflineInvoiceNumbers.mutateAsync({
        siteId, requestId: crypto.randomUUID(), numberKind: "invoice", partitionKey, count: 50, ttlMinutes: 43_200,
      });
      if (cancelled) return;
      await persistOfflineNumberGrant(grant);
    })().catch((error) => {
      if (!cancelled) console.warn("[PowerHub] could not prefetch offline invoice numbers", error);
    });
    return () => { cancelled = true; };
  }, [isAuthenticated, canIssueInvoice, role, siteId, user?.id, currentSite?.tenantId, isOnline, reserveOfflineInvoiceNumbers.mutateAsync]);

  const loadQueuedReadings = useCallback(async () => {
    if (!siteId || !user?.id) return [];
    try {
      const records = await listQueuedReadings({ userId: user.id, siteId });
      setQueuedReadings(records);
      return records;
    } catch {
      toast.error("تعذر قراءة طابور العمل دون اتصال على هذا الجهاز.");
      return [];
    }
  }, [siteId, user?.id]);
  useEffect(() => { void loadQueuedReadings(); }, [loadQueuedReadings]);
  const refresh = async () => {
    const refreshSiteId = siteId ?? 0;
    await Promise.all([
      utils.powerhub.subscribers.list.invalidate({ siteId: refreshSiteId }),
      utils.powerhub.readings.page.invalidate({ siteId: refreshSiteId, limit: 200 }),
      // Refresh the list used by collection entry as well as the 200-row reading workflow view.
      // Site-scoped invalidation avoids refetching invoice lists for unrelated branches.
      utils.powerhub.invoices.page.invalidate({ siteId: refreshSiteId, limit: 100 }),
      utils.powerhub.invoices.page.invalidate({ siteId: refreshSiteId, limit: 200 }),
      utils.powerhub.dashboard.summary.invalidate({ siteId: refreshSiteId }),
      utils.powerhub.audit.list.invalidate({ siteId: refreshSiteId }),
    ]);
    await loadQueuedReadings();
  };
  const addReading = trpc.powerhub.readings.create.useMutation();
  const readingImage = trpc.powerhub.readings.getImage.useMutation({ onSuccess: (result) => setSelectedReadingImage(result.url), onError: (error) => toast.error(error.message) });
  const sendPendingSms = trpc.powerhub.notifications.sendPendingSms.useMutation({ onSuccess: async (result) => { await utils.powerhub.notifications.list.invalidate(); toast.success("تم تجهيز " + result.submitted + " رسالة للإرسال."); }, onError: (error) => toast.error(error.message) });

  const smsStatusByInvoiceId = useMemo(() => { const map = new Map<number, string>(); for (const row of invoiceNotificationsQuery.data ?? []) { if (row.notification.invoiceId && row.notification.channel === "sms") map.set(row.notification.invoiceId, row.notification.status); } return map; }, [invoiceNotificationsQuery.data]);
  const invoiceCandidates = useMemo(() => invoices.filter((invoice) => invoice.readingId && readings.some((row) => row.reading.id === invoice.readingId && row.reading.status === "approved") && !["draft", "cancelled"].includes(invoice.status)), [invoices, readings]);
  const filteredInvoiceCandidates = useMemo(() => invoiceCandidates.filter((invoice) => invoiceSendStatus === "all" || (invoiceSendStatus === "sent" ? ["sent", "delivered"].includes(smsStatusByInvoiceId.get(invoice.id) ?? "") : !["sent", "delivered"].includes(smsStatusByInvoiceId.get(invoice.id) ?? ""))), [invoiceCandidates, invoiceSendStatus, smsStatusByInvoiceId]);
  const readyInvoiceIds = useMemo(() => filteredInvoiceCandidates.map((invoice) => invoice.id), [filteredInvoiceCandidates]);
  useEffect(() => {
    setSelectedInvoiceIds((current) => {
      const retained = current.filter((id) => readyInvoiceIds.includes(id));
      return retained.length === current.length ? current : retained;
    });
  }, [readyInvoiceIds]);

  const filteredReadings = useMemo(() => {
    const term = readingSearch.trim().toLocaleLowerCase();
    return [...readings].filter((row) => (!term || `${row.subscriber.fullName} ${row.subscriber.subscriberNo}`.toLocaleLowerCase().includes(term)) && (readingStatus === "all" || row.reading.status === readingStatus)).sort((a, b) => +new Date(b.reading.readingAt) - +new Date(a.reading.readingAt));
  }, [readingSearch, readingStatus, readings]);
  const totalPages = Math.max(1, Math.ceil(filteredReadings.length / readingPageSize));
  const pageReadings = filteredReadings.slice((readingPage - 1) * readingPageSize, readingPage * readingPageSize);
  const exportReadings = useMemo(() => filteredReadings.filter((row) => { const date = new Date(row.reading.readingAt).toISOString().slice(0, 10); return (!exportStartDate || date >= exportStartDate) && (!exportEndDate || date <= exportEndDate); }), [exportEndDate, exportStartDate, filteredReadings]);
  const exportRows = (rows: typeof filteredReadings) => rows.map((row) => [row.subscriber.fullName, row.subscriber.subscriberNo, Number(row.reading.readingValue).toFixed(3), Number(row.reading.consumptionKwh ?? 0).toFixed(3), row.reading.status === "approved" ? "معتمدة" : "بانتظار المراجعة", formatReportDate(row.reading.readingAt)]);
  const download = (blob: Blob, filename: string) => { const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = filename; link.click(); URL.revokeObjectURL(url); };
  const downloadCsv = () => { const rows = [["المشترك", "الرقم المرجعي", "القراءة", "الاستهلاك kWh", "الحالة", "التاريخ"], ...exportRows(exportReadings)]; const csv = "\uFEFF" + rows.map((row) => row.map((value) => `"${String(value).replaceAll("\"", "\"\"")}"`).join(",")).join("\n"); download(new Blob([csv], { type: "text/csv;charset=utf-8" }), `powerhub-subscriber-readings-${new Date().toISOString().slice(0, 10)}.csv`); };
  const downloadExcel = async () => { try { const { default: ExcelJS } = await loadExcelJS(); const workbook = new ExcelJS.Workbook(); workbook.creator = "PowerHub"; const sheet = workbook.addWorksheet("قراءات المشتركين", { views: [{ rightToLeft: true }] }); sheet.addRow(["المشترك", "الرقم المرجعي", "القراءة", "الاستهلاك kWh", "الحالة", "التاريخ"]); exportRows(exportReadings).forEach((row) => sheet.addRow(row)); sheet.columns = [{ width: 28 }, { width: 22 }, { width: 16 }, { width: 18 }, { width: 20 }, { width: 18 }]; const header = sheet.getRow(1); header.font = { bold: true, color: { argb: "FFFFFFFF" } }; header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0D1117" } }; const buffer = await workbook.xlsx.writeBuffer(); download(new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), `powerhub-subscriber-readings-${new Date().toISOString().slice(0, 10)}.xlsx`); } catch { toast.error("تعذر تجهيز ملف Excel."); } };
  const downloadPdf = async () => { if (!pdfRef.current || !exportReadings.length) { toast.error("لا توجد قراءات ضمن النطاق المحدد."); return; } try { await downloadReportHtmlAsPdf(pdfRef.current, `قراءات-المشتركين-${new Date().toISOString().slice(0, 10)}.pdf`, { title: "تقرير قراءات المشتركين من PowerHub" }); } catch (error) { toast.error(error instanceof Error ? error.message : "تعذر إنشاء ملف PDF."); } };
  const queueReading = async (reading: Omit<QueuedReading, "id" | "createdAt" | "status" | "userId" | "attempts" | "nextAttemptAt" | "lastErrorCode" | "lastErrorKind" | "error">): Promise<string | undefined> => {
    if (!user?.id) throw new Error("تعذر تحديد المستخدم الحالي لحفظ القراءة.");
    const queuedReading = { ...reading, userId: user.id, ...(currentSite?.tenantId ? { tenantId: currentSite.tenantId } : {}) };
    let formattedInvoiceNumber: string | undefined;
    const partitionKey = String(new Date(reading.readingAt).getUTCFullYear());
    if (currentSite?.tenantId && siteId) {
      const deviceId = await getPowerHubDeviceId();
      const scope = { userId: Number(user.id), tenantId: Number(currentSite.tenantId), siteId, deviceId };
      if (await hasAvailableOfflineNumberGrant(scope, "invoice", partitionKey)) {
        try {
          const result = await enqueueReadingWithInvoiceNumber(queuedReading, scope, partitionKey);
          formattedInvoiceNumber = result.formattedInvoiceNumber;
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || (error as { code?: string }).code !== "NO_RESERVED_OFFLINE_INVOICE_NUMBER") throw error;
          await enqueueReading(queuedReading);
        }
      } else {
        await enqueueReading(queuedReading);
      }
    } else {
      await enqueueReading(queuedReading);
    }
    await loadQueuedReadings();
    return formattedInvoiceNumber;
  };

  const syncQueuedReadings = async (records: QueuedReading[] = queuedReadings, allowUncertainRecovery = true) => {
    if (!isOnline) { toast.error("لا يمكن المزامنة قبل عودة الاتصال."); return; }
    if (!user?.id || !siteId) return;
    const lockResult = await withOfflineSyncLock({ userId: user.id, siteId }, async () => {
      await syncQueuedReadingsUnlocked(records, allowUncertainRecovery);
    });
    if (!lockResult.acquired) toast.info("مزامنة هذا الفرع تعمل بالفعل في تبويب آخر.");
  };

  const syncQueuedReadingsUnlocked = async (
    records: QueuedReading[] = queuedReadings,
    allowUncertainRecovery = false,
  ) => {
    if (!isOnline || !user?.id || !siteId) return;
    let workingRecords = records;
    if (allowUncertainRecovery) {
      let recovered = 0;
      for (const item of records.filter((entry) =>
        isManualSyncRecoveryRequired({ outcome: entry.syncOutcome, attempts: entry.attempts }) &&
        (entry.status === "pending" || entry.status === "failed"),
      )) {
        if (await requeueOfflineWorkForManualRetry({
          id: item.id,
          clientOperationId: item.clientOperationId,
          userId: item.userId,
          siteId: item.siteId,
        })) recovered += 1;
      }
      if (recovered) workingRecords = await loadQueuedReadings();
    }
    const now = Date.now();
    const ready = workingRecords.filter((item) => isQueuedReadingReadyForSync(item, now, allowUncertainRecovery));
    if (!ready.length) {
      const waiting = records.filter((item) => item.status === "failed" && item.lastErrorKind === "retryable" && item.nextAttemptAt > now).length;
      if (waiting) toast.message(`توجد ${waiting} قراءة مؤجلة وفق سياسة إعادة المحاولة. ستصبح قابلة للمزامنة بعد انتهاء مهلة الانتظار.`);
      else toast.message("لا توجد قراءات مستحقة للمزامنة حالياً.");
      return;
    }
    const requested = new Set(ready.map((record) => record.clientOperationId));
    const [allItems, storedMetadata] = await Promise.all([
      listOfflineWork({ userId: user.id, siteId }),
      listSyncMetadata({ userId: user.id, siteId }),
    ]);
    const pendingItems = allItems.filter((item) =>
      item.kind === "reading_create" && requested.has(item.clientOperationId) &&
      (item.status === "pending" || item.status === "failed")
    );
    const metadataByOperationId = new Map<string, SyncMetadata>();
    for (const item of pendingItems) {
      const stored = storedMetadata.find((row) => row.operationId === item.clientOperationId);
      if (!stored) {
        await updateOfflineWork(item.id, {
          status: "failed",
          error: "حالة مزامنة القراءة المحلية مفقودة؛ أُوقفت إعادة الإرسال تلقائيًا. تحقّق من الخادم قبل إعادة إنشاء القراءة.",
        });
        continue;
      }
      const metadata: SyncMetadata = {
        operationId: stored.operationId, dependsOn: stored.dependsOn,
        attempts: stored.attempts, nextAttemptAt: stored.nextAttemptAt, outcome: stored.outcome,
        ...(stored.lastError ? { lastError: stored.lastError } : {}),
      };
      metadataByOperationId.set(item.clientOperationId, metadata);
    }

    const missingMetadataCount = pendingItems.filter((item) => !metadataByOperationId.has(item.clientOperationId)).length;
    if (missingMetadataCount) toast.error(`توجد ${missingMetadataCount} قراءة بلا حالة مزامنة موثوقة؛ لم تُرسل تلقائيًا.`);
    const syncItems = pendingItems.filter((item) => metadataByOperationId.has(item.clientOperationId));
    const serverResults = new Map<string, { id?: number; replayed: boolean; invoiceNo?: string }>();
    const errorCodes = new Map<string, string>();
    const results = await executeReadyOperations({
      items: syncItems, metadataByOperationId,
      completedIds: new Set(allItems.filter((item) => item.status === "applied").map((item) => item.clientOperationId)),
      now,
      transport: async (item: QueuedOfflineWork): Promise<SyncTransportResult> => {
        const payload = item.payload as ReadingCreateDraft;
        try {
          const response = await addReading.mutateAsync({
            siteId: item.siteId, subscriberId: payload.subscriberId,
            readingValue: payload.readingValue, readingAt: new Date(payload.readingAt),
            captureMethod: payload.captureMethod, imageData: payload.imageData, imageMime: payload.imageMime,
            notes: payload.notes, isReadingReset: payload.isReadingReset,
            overrideSameDay: payload.overrideSameDay, fieldVerified: payload.fieldVerified,
            clientOperationId: item.clientOperationId, offlineInvoiceNumberClaim: payload.offlineInvoiceNumberClaim,
          });
          const replayed = Boolean((response as { replayed?: boolean }).replayed);
          const entityId = Number((response as { id?: number }).id);
          const invoiceNo = typeof (response as { invoiceNo?: unknown }).invoiceNo === "string" ? (response as { invoiceNo: string }).invoiceNo : undefined;
          serverResults.set(item.clientOperationId, {
            ...(Number.isSafeInteger(entityId) && entityId > 0 ? { id: entityId } : {}), replayed,
            ...(invoiceNo ? { invoiceNo } : {}),
          });
          return { outcome: replayed ? "already_applied" : "applied" };
        } catch (error) {
          const code = (error as { data?: { code?: string } }).data?.code;
          if (code) errorCodes.set(item.clientOperationId, code);
          const classified = classifySyncResult(code);
          return { outcome: classified === "applied" ? "retryable" : classified, ...(code ? { errorCode: code } : {}),
            message: error instanceof Error ? error.message : "تعذر مزامنة القراءة مؤقتاً." };
        }
      },
    });

    const latestMetadata = await listSyncMetadata({ userId: user.id, siteId });
    for (const result of results) {
      const item = result.item;
      const previous = latestMetadata.find((row) => row.operationId === item.clientOperationId);
      const errorCode = errorCodes.get(item.clientOperationId) ?? previous?.lastErrorCode;
      await upsertSyncMetadata({
        operationId: item.clientOperationId, userId: item.userId,
        ...(item.tenantId !== undefined ? { tenantId: item.tenantId } : {}),
        siteId: item.siteId, kind: item.kind, dependsOn: result.metadata.dependsOn,
        attempts: result.metadata.attempts, nextAttemptAt: result.metadata.nextAttemptAt,
        outcome: result.outcome, ...(result.metadata.lastError ? { lastError: result.metadata.lastError } : {}),
        ...(errorCode ? { lastErrorCode: errorCode } : {}), updatedAt: Date.now(),
      });
      if (result.outcome === "applied" || result.outcome === "already_applied") {
        const server = serverResults.get(item.clientOperationId);
        const payload = item.payload as ReadingCreateDraft;
        await updateOfflineWork(item.id, {
          status: "applied", error: undefined,
          ...(server?.id ? { appliedEntityId: server.id } : {}),
          appliedLabel: server?.invoiceNo ? `فاتورة ${server.invoiceNo} · قراءة للمشترك #${payload.subscriberId}` : `قراءة للمشترك #${payload.subscriberId}`,
          payload: { ...payload, imageData: undefined, imageMime: undefined, offlineInvoiceNumberClaim: undefined },
        });
        await removeOfflineConflict(item.userId, item.clientOperationId);
      } else if (result.outcome === "conflict") {
        const message = result.metadata.lastError ?? "تعارض قراءة يحتاج إلى مراجعة.";
        await updateOfflineWork(item.id, { status: "conflict", error: message });
        await upsertOfflineConflict({
          userId: item.userId, ...(item.tenantId !== undefined ? { tenantId: item.tenantId } : {}),
          siteId: item.siteId, operationId: item.clientOperationId, kind: item.kind,
          outcome: "conflict", message, createdAt: item.createdAt, updatedAt: Date.now(),
          localPayload: item.payload,
        });
      } else {
        const message = result.metadata.lastError ?? (result.outcome === "rejected" ? "رفض الخادم القراءة." : "تعذر مزامنة القراءة مؤقتاً.");
        await updateOfflineWork(item.id, { status: "failed", error: message });
        await removeOfflineConflict(item.userId, item.clientOperationId);
      }
    }
    await refresh();
    await loadQueuedReadings();
    const completed = results.filter((result) => result.outcome === "applied" || result.outcome === "already_applied").length;
    const retryable = results.filter((result) => result.outcome === "retryable").length;
    const conflicts = results.filter((result) => result.outcome === "conflict").length;
    const rejected = results.filter((result) => result.outcome === "rejected").length;
    if (completed) toast.success(`اكتملت مزامنة ${completed} قراءة.`);
    if (retryable) toast.warning(`توجد ${retryable} قراءة مؤجلة لإعادة المحاولة.`);
    if (conflicts) toast.error(`توجد ${conflicts} قراءة متعارضة تحتاج إلى مراجعة.`);
    if (rejected) toast.error(`رفض الخادم ${rejected} قراءة؛ راجع سبب الرفض قبل المحاولة مجدداً.`);
  };

  useEffect(() => {
    if (!isOnline || reconnectGeneration === 0 || lastAutoSyncGeneration.current === reconnectGeneration) return;
    lastAutoSyncGeneration.current = reconnectGeneration;
    void loadQueuedReadings().then((records) => {
      if (records.length) void syncQueuedReadings(records, false);
    });
  }, [isOnline, reconnectGeneration, loadQueuedReadings]);

  if (loading) return <DashboardLayout><div className="grid min-h-[60vh] place-items-center"><Loader2 className="h-7 w-7 animate-spin text-[#F5B800]" /></div></DashboardLayout>;
  if (!isAuthenticated) return <DashboardLayout><div className="mx-auto mt-12 max-w-xl rounded-[28px] border border-[#F5B800]/20 bg-[#111823] p-8 text-center shadow-panel"><Gauge className="mx-auto h-8 w-8 text-[#F5B800]" /><h1 className="mt-5 text-xl font-extrabold text-white">سجّل الدخول لتسجيل القراءات</h1><p className="mt-3 leading-7 text-slate-400">تحتاج قراءة المشترك وصورتها إلى مستخدم مصرح له وفرع محدد.</p><Button onClick={() => startLogin()} className="mt-6 bg-[#F5B800] font-bold text-[#0D1117] hover:bg-[#ffd23f]">تسجيل الدخول</Button></div></DashboardLayout>;
  if (!sitesQuery.data?.length) return <DashboardLayout><div className="mx-auto mt-12 max-w-xl rounded-[28px] border border-white/10 bg-[#111823] p-8 text-center shadow-panel"><h1 className="text-xl font-extrabold text-white">أنشئ فرعاً أولاً</h1><p className="mt-3 text-slate-400">المشتركون والقراءات مرتبطون بفرع الخدمة.</p><Button onClick={() => setLocation("/subscribers")} className="mt-6 bg-[#F5B800] font-bold text-[#0D1117] hover:bg-[#ffd23f]">فتح المشتركين</Button></div></DashboardLayout>;

  return <DashboardLayout><div className="space-y-6 pb-12"><header className="flex flex-col gap-4 rounded-[24px] border border-white/8 bg-[#111823]/80 p-5 shadow-panel sm:flex-row sm:items-center sm:justify-between"><div><div className="flex items-center gap-2 text-sm font-bold text-[#F5B800]"><Gauge className="h-4 w-4" />قراءات المنصة</div><h1 className="mt-1 text-2xl font-extrabold text-white">إضافة قراءة</h1><p className="mt-2 text-sm text-slate-400">تُحفظ قراءة المنصة وتُعتمد وتصدر فاتورتها تلقائيًا؛ أما قراءات التطبيق الميداني فتُراجع جماعيًا من تبويب الميدان.</p></div><div className="flex items-center gap-3"><span className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold ${isOnline ? "bg-emerald-400/10 text-emerald-300" : "bg-amber-400/10 text-amber-300"}`}>{isOnline ? <Wifi className="h-3.5 w-3.5" /> : <CloudOff className="h-3.5 w-3.5" />}{isOnline ? "متصل" : "دون اتصال"}</span><select aria-label="فلتر الفرع الموحد" value={siteId ?? ""} onChange={(event) => setSiteId(Number(event.target.value))} className={inputClass}>{sitesQuery.data.map((site) => <option className="bg-[#111823]" key={site.id} value={site.id}>{site.name}</option>)}</select></div></header>
    {canCreateAndInvoiceReading && user?.id ? <><ReadingWorkflowPanel userId={user.id} siteId={siteId!} role={role} anomalyAlertPercent={anomalyQuery.data?.anomalyAlertPercent ?? 50} subscribers={subscribersQuery.data ?? []} readings={readings} isOnline={isOnline} onQueueReading={queueReading} onSaved={refresh} /><BulkReadingEntry siteId={siteId!} subscribers={subscribersQuery.data ?? []} readings={readings} onSaved={refresh} /></> : null}
    {canRecordReading && !canCreateAndInvoiceReading ? <Panel title="تسجيل قراءة المنصة"><p className="text-sm leading-6 text-amber-200">تسجيل قراءة المنصة يتطلب صلاحيات تسجيل القراءة واعتمادها وإصدار الفاتورة. استخدم تبويب «الميدان والمزامنة» لقراءات التطبيق الميداني.</p></Panel> : null}
    <BranchAnomalySettings siteId={siteId!} canEdit={role === "owner"} currentPercent={anomalyQuery.data?.anomalyAlertPercent ?? 50} />
    {canSendInvoiceSms && <Panel title="إرسال فواتير القراءات عبر SMS"><div className="space-y-3"><div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-slate-300">حدد الفواتير المعتمدة غير المرسلة، ثم جهزها للإرسال إلى أرقام المشتركين المسجلة.</p><Button disabled={sendPendingSms.isPending || !selectedInvoiceIds.length} onClick={() => sendPendingSms.mutate({ siteId: siteId!, invoiceIds: selectedInvoiceIds, includeFailed: false })} className="bg-sky-400 text-[#0D1117] hover:bg-sky-300"><Send className="ml-2 h-4 w-4" />إرسال المحدد ({selectedInvoiceIds.length})</Button></div><label className="text-xs text-slate-400">حالة الإرسال<select value={invoiceSendStatus} onChange={(event) => { setInvoiceSendStatus(event.target.value as typeof invoiceSendStatus); setSelectedInvoiceIds([]); }} className={`${inputClass} mt-1 max-w-48`}><option value="unsent">لم يتم الإرسال</option><option value="sent">تم الإرسال</option><option value="all">كل الحالات</option></select></label>{filteredInvoiceCandidates.length ? <div className="max-h-56 divide-y divide-white/8 overflow-auto rounded-xl border border-white/8">{filteredInvoiceCandidates.map((invoice) => <label key={invoice.id} className="flex cursor-pointer items-center gap-3 px-4 py-3 text-sm hover:bg-white/[.03]"><input type="checkbox" checked={selectedInvoiceIds.includes(invoice.id)} onChange={() => setSelectedInvoiceIds((current) => current.includes(invoice.id) ? current.filter((id) => id !== invoice.id) : [...current, invoice.id])} className="accent-[#F5B800]" /><strong className="flex-1 text-white" dir="ltr">{invoice.invoiceNo}</strong><span className="text-xs text-slate-400">{invoice.billingPeriod}</span></label>)}</div> : <p className="text-sm text-slate-500">لا توجد فواتير معتمدة مطابقة للفلتر.</p>}</div></Panel>}
    <Panel title={`سجل القراءات — ${currentSite?.name ?? ""}`}><div className="mb-4 grid gap-3 rounded-xl border border-white/8 bg-white/[.018] p-3 md:grid-cols-[1.5fr_1fr_1fr_auto]"><label className="text-xs text-slate-400">بحث<input aria-label="بحث القراءات" value={readingSearch} onChange={(event) => { setReadingSearch(event.target.value); setReadingPage(1); }} className={`${inputClass} mt-1`} placeholder="اسم المشترك أو الرقم المرجعي" /></label><label className="text-xs text-slate-400">حالة القراءة<select value={readingStatus} onChange={(event) => { setReadingStatus(event.target.value as typeof readingStatus); setReadingPage(1); }} className={`${inputClass} mt-1`}><option value="all">كل الحالات</option><option value="pending_review">بانتظار المراجعة</option><option value="approved">معتمدة</option></select></label><label className="text-xs text-slate-400">السجلات في الصفحة<select value={readingPageSize} onChange={(event) => { setReadingPageSize(Number(event.target.value) as 10 | 20 | 50); setReadingPage(1); }} className={`${inputClass} mt-1`}><option value="10">10</option><option value="20">20</option><option value="50">50</option></select></label><Button variant="outline" onClick={() => { setReadingSearch(""); setReadingStatus("all"); setReadingPage(1); }} className="self-end border-white/15 text-slate-300">مسح الفلاتر</Button></div><div className="mb-4 flex flex-wrap items-end gap-2"><label className="text-xs text-slate-400">من تاريخ<input type="date" value={exportStartDate} onChange={(event) => setExportStartDate(event.target.value)} className={`${inputClass} mt-1`} /></label><label className="text-xs text-slate-400">إلى تاريخ<input type="date" value={exportEndDate} onChange={(event) => setExportEndDate(event.target.value)} className={`${inputClass} mt-1`} /></label><Button type="button" onClick={downloadCsv} disabled={!exportReadings.length} variant="outline" className="border-white/10 text-slate-200"><Download className="ml-2 h-4 w-4" />CSV</Button><Button type="button" onClick={() => void downloadExcel()} disabled={!exportReadings.length} variant="outline" className="border-[#F5B800]/35 text-[#F5B800]"><FileSpreadsheet className="ml-2 h-4 w-4" />Excel</Button><Button type="button" onClick={() => void downloadPdf()} disabled={!exportReadings.length} variant="outline" className="border-rose-300/30 text-rose-200"><FileSpreadsheet className="ml-2 h-4 w-4" />PDF</Button></div><div className="overflow-x-auto">{readingsQuery.isLoading ? <ReadingTableSkeleton /> : pageReadings.length ? <table className="w-full min-w-[720px] text-sm"><thead className="text-right text-xs text-slate-500"><tr><th className="pb-3">المشترك</th><th className="pb-3">الرقم المرجعي</th><th className="pb-3">القراءة</th><th className="pb-3">الاستهلاك</th><th className="pb-3">الحالة</th><th className="pb-3">الصورة</th><th className="pb-3">إجراء</th></tr></thead><tbody>{pageReadings.map((row) => <tr key={row.reading.id} className="border-t border-white/7"><td className="py-3 font-bold text-white">{row.subscriber.fullName}</td><td className="py-3 text-slate-400" dir="ltr">{row.subscriber.subscriberNo}</td><td className="py-3">{Number(row.reading.readingValue).toFixed(3)}</td><td className="py-3 text-[#F5B800]">{Number(row.reading.consumptionKwh ?? 0).toFixed(3)} kWh</td><td className="py-3"><Badge className={row.reading.status === "approved" ? "bg-emerald-400/10 text-emerald-400" : "bg-sky-400/10 text-sky-400"}>{row.reading.status === "pending_review" ? "بانتظار المراجعة" : row.reading.status === "approved" ? "معتمدة" : row.reading.status}</Badge></td><td className="py-3">{row.reading.imageKey ? <Button type="button" size="sm" variant="outline" disabled={readingImage.isPending} onClick={() => readingImage.mutate({ siteId: siteId!, readingId: row.reading.id })} className="border-[#F5B800]/30 text-[#F5B800]"><Camera className="ml-1 h-3.5 w-3.5"/>عرض الصورة</Button> : <span className="text-xs text-slate-600">لا توجد صورة</span>}</td><td className="py-3">{row.reading.status === "pending_review" ? <span className="text-xs text-slate-500">قراءة معلّقة قديمة؛ تُراجع حسب مصدرها من المسار المختص</span> : "—"}</td></tr>)}</tbody></table> : <div className="rounded-xl border border-dashed border-white/10 px-4 py-10 text-center text-sm text-slate-500"><Camera className="mx-auto mb-3 h-5 w-5 text-[#F5B800]" />لا توجد قراءات بعد. اختر مشتركاً وسجل أول قراءة.</div>}</div>{totalPages > 1 && <div className="mt-4 flex items-center justify-between border-t border-white/8 pt-4"><Button size="sm" variant="outline" disabled={readingPage === 1} onClick={() => setReadingPage((page) => page - 1)}>السابق</Button><span className="text-xs text-slate-400">صفحة {readingPage} من {totalPages}</span><Button size="sm" variant="outline" disabled={readingPage === totalPages} onClick={() => setReadingPage((page) => page + 1)}>التالي</Button></div>}</Panel>
    <Panel title="طابور المزامنة الميداني"><div className="flex flex-col gap-4"><div className="flex flex-col gap-3 rounded-xl border border-white/8 bg-white/[.018] p-4 sm:flex-row sm:items-center sm:justify-between"><div><p className="font-bold text-white">{queuedReadings.length} قراءة محلية</p><p className="mt-1 text-xs text-slate-500">الطابور معزول بالحساب والفرع. القراءات الفاشلة تعود وفق Backoff ولا يعاد إرسالها قبل موعد المحاولة التالية.</p></div><Button variant="outline" disabled={!isOnline || addReading.isPending || !queuedReadings.some((record) => isQueuedReadingReadyForSync(record, Date.now(), true))} onClick={() => void syncQueuedReadings()} className="border-[#F5B800]/30 text-[#F5B800]"><RotateCw className="ml-2 h-4 w-4" />مزامنة الآن</Button></div>{queuedReadings.length ? <div className="space-y-2">{queuedReadings.map((record) => <div key={record.id} className="flex items-center justify-between gap-3 rounded-xl border border-white/7 bg-white/[0.015] p-4"><div><p className="font-bold text-white">مشترك #{record.subscriberId} · {record.readingValue} kWh</p><p className="mt-1 text-xs text-slate-500">{new Date(record.createdAt).toLocaleString("ar-IQ")}{record.lastErrorKind === "retryable" && record.nextAttemptAt > Date.now() ? ` · المحاولة التالية بعد ${new Date(record.nextAttemptAt).toLocaleTimeString("ar-PS", { hour: "2-digit", minute: "2-digit" })}` : ""}{record.error ? ` · ${record.error}` : ""}</p></div><div className="flex items-center gap-2"><Badge className={record.status === "pending" ? "bg-amber-400/10 text-amber-300" : record.status === "conflict" ? "bg-rose-400/10 text-rose-300" : record.lastErrorKind === "retryable" ? "bg-amber-400/10 text-amber-200" : "bg-slate-400/10 text-slate-300"}>{record.status === "pending" ? "بانتظار المزامنة" : record.status === "conflict" ? "يتطلب مراجعة" : record.lastErrorKind === "retryable" ? "مؤجل لإعادة المحاولة" : "فشل يحتاج مراجعة"}</Badge>{record.status !== "pending" ? <Button aria-label="حذف القراءة المحلية" size="icon" variant="ghost" onClick={() => void removeQueuedReading(record.id).then(loadQueuedReadings)} className="h-8 w-8 text-slate-400 hover:bg-rose-400/10 hover:text-rose-200"><Trash2 className="h-3.5 w-3.5" /></Button> : null}</div></div>)}</div> : <p className="py-3 text-center text-sm text-slate-500">لا توجد عمليات محلية لهذا الفرع والحساب.</p>}</div></Panel>
    <Dialog open={Boolean(selectedReadingImage)} onOpenChange={(open) => { if (!open) setSelectedReadingImage(null); }}><DialogContent dir="rtl" className="max-w-3xl border-white/10 bg-[#111823] text-white"><DialogHeader><DialogTitle>صورة القراءة المرفقة</DialogTitle></DialogHeader>{selectedReadingImage ? <img src={selectedReadingImage} alt="الصورة المرفقة مع قراءة العداد" className="max-h-[75vh] w-full rounded-xl bg-black/20 object-contain" /> : null}</DialogContent></Dialog>
    <div ref={pdfRef} className="pointer-events-none absolute -left-[9999px] top-0 w-[760px] bg-white p-8 text-right text-black" dir="rtl"><h1>PowerHub — تقرير قراءات المشتركين</h1><p>الفرع: {currentSite?.name ?? ""}</p><table className="w-full border-collapse text-sm"><thead><tr><th>المشترك</th><th>المرجع</th><th>القراءة</th><th>الاستهلاك</th><th>الحالة</th></tr></thead><tbody>{exportReadings.map((row) => <tr key={row.reading.id}><td>{row.subscriber.fullName}</td><td>{row.subscriber.subscriberNo}</td><td>{row.reading.readingValue}</td><td>{row.reading.consumptionKwh}</td><td>{row.reading.status}</td></tr>)}</tbody></table></div>
  </div></DashboardLayout>;
}
