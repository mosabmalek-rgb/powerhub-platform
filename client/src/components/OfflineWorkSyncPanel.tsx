import { listOfflineConflicts, removeOfflineConflict, upsertOfflineConflict, type OfflineConflictRecord } from "@/lib/offline-workspace-db";
import { listDeltaSyncStatuses, type DeltaSyncStatusRecord } from "@/lib/offline-delta-sync";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { listOfflineWork, removeOfflineWork, updateOfflineWork, type QueuedOfflineWork } from "@/lib/offline-work-queue";
import { listSyncMetadata, upsertSyncMetadata } from "@/lib/offline-sync-metadata";
import { createSyncMetadata, type SyncMetadata } from "@/lib/offline-sync-engine";
import { executeReadyOperations, type SyncTransportResult } from "@/lib/offline-sync-executor";
import { withOfflineSyncLock } from "@/lib/offline-sync-lock";
import { getOfflineSyncRefreshTargets } from "@/lib/offline-sync-refresh";
import { syncGeneratorCreate, syncGeneratorUpdate } from "@/lib/offline-generator-sync";
import { trpc } from "@/lib/trpc";
import { AlertTriangle, CheckCircle2, CloudOff, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePowerHubConnectivity } from "@/lib/offline-connectivity";
import { toast } from "sonner";

const labelByKind = { subscriber_create: "إضافة مشترك", subscriber_update: "تعديل مشترك", generator_create: "إضافة مولد", generator_update: "تعديل مولد", invoice_issue: "إصدار فاتورة", payment_create: "تحصيل معلق", payment_documentation_submit: "توثيق دفع إلكتروني", payment_documentation_approve: "اعتماد توثيق دفع", reading_create: "قراءة ميدانية معلقة" } as const;
const labelByStatus = { pending: "بانتظار المزامنة", failed: "فشل يحتاج مراجعة", conflict: "يتطلب مراجعة", applied: "تمت المزامنة" } as const;

function getErrorCode(error: unknown) { return (error as { data?: { code?: string } } | null)?.data?.code; }
function getErrorMessage(error: unknown) { return error instanceof Error ? error.message : "تعذر مزامنة العملية."; }

export function OfflineWorkSyncPanel({ siteId, userId, compact = false }: { siteId: number; userId: number; compact?: boolean }) {
  const utils = trpc.useUtils();
  const [items, setItems] = useState<QueuedOfflineWork[]>([]);
  const [deltaStatuses, setDeltaStatuses] = useState<DeltaSyncStatusRecord[]>([]);
  const [conflictRecords, setConflictRecords] = useState<OfflineConflictRecord[]>([]);
  const { isOnline, reconnectGeneration } = usePowerHubConnectivity();
  const [syncing, setSyncing] = useState(false);
  const lastAutoSyncGeneration = useRef(0);
  const load = useCallback(async () => {
    try { setItems(await listOfflineWork({ userId, siteId })); }
    catch { toast.error("تعذر قراءة مسودات العمل المحلي على هذا الجهاز."); }
    try { setDeltaStatuses(await listDeltaSyncStatuses({ userId, siteId })); }
    catch { setDeltaStatuses([]); }
    try { setConflictRecords(await listOfflineConflicts({ userId, siteId })); }
    catch { setConflictRecords([]); }
  }, [siteId, userId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const onStatusChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ userId?: number; siteId?: number }>).detail;
      if (detail?.userId === userId && detail?.siteId === siteId) void load();
    };
    window.addEventListener("powerhub:delta-sync-status-changed", onStatusChanged);
    return () => window.removeEventListener("powerhub:delta-sync-status-changed", onStatusChanged);
  }, [load, siteId, userId]);

  const createSubscriber = trpc.powerhub.subscribers.create.useMutation();
  const updateSubscriber = trpc.powerhub.subscribers.update.useMutation();
  const issueInvoice = trpc.powerhub.invoices.createFromReading.useMutation();
  const createPayment = trpc.powerhub.payments.create.useMutation();
  const submitPaymentDocumentation = trpc.powerhub.paymentDocumentation.submit.useMutation();
  const approvePaymentDocumentation = trpc.powerhub.paymentDocumentation.approve.useMutation();
  const createReading = trpc.powerhub.readings.create.useMutation();

  const refresh = async (results: readonly { item: QueuedOfflineWork; outcome: string }[]) => {
    const targets = new Set(getOfflineSyncRefreshTargets(results));
    const refreshes: Promise<unknown>[] = [];

    if (targets.has("subscribers")) {
      refreshes.push(
        utils.powerhub.subscribers.list.invalidate({ siteId }),
        utils.powerhub.subscribers.directoryPage.invalidate({ siteId }),
      );
    }
    if (targets.has("subscriber-quota")) {
      refreshes.push(utils.powerhub.subscribers.quota.invalidate({ siteId }));
    }
    if (targets.has("generators")) {
      refreshes.push(utils.powerhub.generators.list.invalidate({ siteId }));
    }
    if (targets.has("readings")) {
      refreshes.push(utils.powerhub.readings.page.invalidate({ siteId, limit: 200 }));
    }
    if (targets.has("invoices")) {
      refreshes.push(utils.powerhub.invoices.list.invalidate({ siteId }));
    }
    if (targets.has("invoice-pages")) {
      refreshes.push(
        utils.powerhub.invoices.page.invalidate({ siteId, limit: 100 }),
        utils.powerhub.invoices.page.invalidate({ siteId, limit: 200 }),
      );
    }
    if (targets.has("payments")) {
      refreshes.push(utils.powerhub.payments.list.invalidate({ siteId }));
    }
    if (targets.has("dashboard-summary")) {
      refreshes.push(utils.powerhub.dashboard.summary.invalidate({ siteId }));
    }
    if (targets.has("financial-dashboard")) {
      refreshes.push(
        utils.powerhub.dashboard.financialOverview.invalidate({ siteId, scope: "branch" }),
        utils.powerhub.dashboard.periodMetrics.invalidate({ siteId, scope: "branch" }),
      );
    }
    if (targets.has("audit")) {
      refreshes.push(utils.powerhub.audit.list.invalidate({ siteId }));
    }
    await Promise.all(refreshes);
  };

  const buildMetadata = async (pendingItems: QueuedOfflineWork[]) => {
    const stored = await listSyncMetadata({ userId, siteId });
    const metadataByOperationId = new Map<string, SyncMetadata>();
    for (const item of pendingItems) {
      const existing = stored.find((record) => record.operationId === item.clientOperationId);
      const metadata = existing ? { operationId: existing.operationId, dependsOn: existing.dependsOn, attempts: existing.attempts, nextAttemptAt: existing.nextAttemptAt, ...(existing.outcome ? { outcome: existing.outcome } : {}), ...(existing.lastError ? { lastError: existing.lastError } : {}) } : createSyncMetadata(item);
      metadataByOperationId.set(item.clientOperationId, metadata);
      if (!existing) await upsertSyncMetadata({ ...metadata, userId, siteId: item.siteId, kind: item.kind, outcome: "pending", updatedAt: Date.now() });
    }
    return metadataByOperationId;
  };

  const transport = async (item: QueuedOfflineWork): Promise<SyncTransportResult> => {
    try {
      if (item.kind === "subscriber_create") {
        const payload = item.payload as import("@/lib/offline-work-queue").SubscriberCreateDraft;
        const result = await createSubscriber.mutateAsync({ siteId: item.siteId, ...payload, clientOperationId: item.clientOperationId });
        await updateOfflineWork(item.id, { status: "applied", error: undefined, appliedEntityId: result.id, appliedLabel: result.subscriberNo });
        return { outcome: "applied" };
      }
      if (item.kind === "subscriber_update") {
        const payload = item.payload as import("@/lib/offline-work-queue").SubscriberUpdateDraft;
        await updateSubscriber.mutateAsync({ siteId: item.siteId, id: payload.subscriberId, fullName: payload.fullName, phone: payload.phone, address: payload.address, subscriptionType: payload.subscriptionType, serviceStatus: payload.serviceStatus, expectedUpdatedAt: new Date(payload.expectedUpdatedAt), clientOperationId: item.clientOperationId });
        await updateOfflineWork(item.id, { status: "applied", error: undefined, appliedEntityId: payload.subscriberId, appliedLabel: payload.fullName });
        return { outcome: "applied" };
      }
      if (item.kind === "generator_create") {
        const payload = item.payload as import("@/lib/offline-work-queue").GeneratorCreateDraft;
        const result = await syncGeneratorCreate({ siteId: item.siteId, ...payload, clientOperationId: item.clientOperationId });
        await updateOfflineWork(item.id, { status: "applied", error: undefined, appliedEntityId: result.id, appliedLabel: result.name });
        return { outcome: "applied" };
      }
      if (item.kind === "generator_update") {
        const payload = item.payload as import("@/lib/offline-work-queue").GeneratorUpdateDraft;
        const result = await syncGeneratorUpdate({ siteId: item.siteId, generatorId: payload.generatorId, name: payload.name, ratedCapacityKw: payload.ratedCapacityKw, fuelLevelLiters: payload.fuelLevelLiters, operatingHours: payload.operatingHours, status: payload.status, expectedUpdatedAt: payload.expectedUpdatedAt, clientOperationId: item.clientOperationId });
        await updateOfflineWork(item.id, { status: "applied", error: undefined, appliedEntityId: result.id, appliedLabel: result.name });
        return { outcome: "applied" };
      }
      if (item.kind === "reading_create") {
        const payload = item.payload as import("@/lib/offline-work-queue").ReadingCreateDraft;
        const result = await createReading.mutateAsync({
          siteId: item.siteId, subscriberId: payload.subscriberId,
          readingValue: payload.readingValue, readingAt: new Date(payload.readingAt),
          captureMethod: payload.captureMethod, imageData: payload.imageData, imageMime: payload.imageMime,
          notes: payload.notes, isReadingReset: payload.isReadingReset, overrideSameDay: payload.overrideSameDay,
          fieldVerified: payload.fieldVerified, clientOperationId: item.clientOperationId,
        });
        await updateOfflineWork(item.id, {
          status: "applied", error: undefined, appliedEntityId: Number(result.id),
          appliedLabel: `قراءة للمشترك #${payload.subscriberId}`,
          payload: { ...payload, imageData: undefined, imageMime: undefined },
        });
        return { outcome: result.replayed ? "already_applied" : "applied" };
      }
      if (item.kind === "invoice_issue") {
        const payload = item.payload as import("@/lib/offline-work-queue").InvoiceIssueDraft;
        const result = await issueInvoice.mutateAsync({ siteId: item.siteId, ...payload, dueDate: new Date(payload.dueDate), clientOperationId: item.clientOperationId });
        await updateOfflineWork(item.id, { status: "applied", error: undefined, appliedEntityId: result.id, appliedLabel: result.invoiceNo });
        return { outcome: "applied" };
      }
      if (item.kind === "payment_create") {
        const payload = item.payload as import("@/lib/offline-work-queue").PaymentDraft;
        const result = await createPayment.mutateAsync({ siteId: item.siteId, ...payload, clientOperationId: item.clientOperationId });
        const { receiptImageData: _receiptImageData, receiptImageMime: _receiptImageMime, ...sanitizedPayload } = payload;
        await updateOfflineWork(item.id, { status: "applied", error: undefined, appliedEntityId: result.id, appliedLabel: payload.paymentNo, payload: sanitizedPayload });
        return { outcome: "applied" };
      }
      if (item.kind === "payment_documentation_approve") {
        const payload = item.payload as import("@/lib/offline-work-queue").PaymentDocumentationApprovalDraft;
        const result = await approvePaymentDocumentation.mutateAsync({ siteId: item.siteId, requestId: payload.requestId });
        await updateOfflineWork(item.id, { status: "applied", error: undefined, appliedEntityId: Number(result.paymentId), appliedLabel: `طلب #${payload.requestId} — حركة #${result.paymentId}` });
        return { outcome: "applied" };
      }
      const payload = item.payload as import("@/lib/offline-work-queue").PaymentDocumentationDraft;
      const result = await submitPaymentDocumentation.mutateAsync({
        siteId: item.siteId, subscriberId: payload.subscriberId, invoiceId: payload.invoiceId,
        destinationAccountId: payload.destinationAccountId, paymentAmount: payload.paymentAmount,
        paymentMethod: payload.paymentMethod, senderPhone: payload.senderPhone, referenceNo: payload.referenceNo,
        receiptImageData: payload.receiptImageData, receiptImageMime: payload.receiptImageMime,
        clientOperationId: item.clientOperationId,
      });
      await updateOfflineWork(item.id, {
        status: "applied", error: undefined, appliedEntityId: result.id,
        appliedLabel: `طلب توثيق #${result.id} — بانتظار المراجعة`,
        payload: { ...payload, receiptImageData: undefined, receiptImageMime: undefined },
      });
      return { outcome: result.replayed ? "already_applied" : "applied" };
    } catch (error) {
      return { outcome: "retryable", errorCode: getErrorCode(error), message: getErrorMessage(error) };
    }
  };

  const syncPending = async () => {
    if (!isOnline) return toast.error("تحتاج إلى اتصال قبل مزامنة المسودات.");
    if (syncing) return;
    const lockResult = await withOfflineSyncLock({ userId, siteId }, async () => {
      setSyncing(true);
      try {
        const allItems = await listOfflineWork({ userId, siteId });
        const pendingItems = allItems.filter((item) => item.status === "pending" || item.status === "failed");
        if (!pendingItems.length) return;
        const metadataByOperationId = await buildMetadata(pendingItems);
        const completedIds = new Set(allItems.filter((item) => item.status === "applied").map((item) => item.clientOperationId));
        const results = await executeReadyOperations({ items: pendingItems, metadataByOperationId, completedIds, transport, now: Date.now() });
        const storedAfter = await listSyncMetadata({ userId, siteId });
        for (const result of results) {
          const current = storedAfter.find((row) => row.operationId === result.item.clientOperationId);
          await upsertSyncMetadata({ operationId: result.item.clientOperationId, userId, siteId: result.item.siteId, kind: result.item.kind, dependsOn: result.metadata.dependsOn, attempts: result.metadata.attempts, nextAttemptAt: result.metadata.nextAttemptAt, outcome: result.outcome, ...(result.metadata.lastError ? { lastError: result.metadata.lastError } : {}), updatedAt: Date.now(), ...(current?.tenantId !== undefined ? { tenantId: current.tenantId } : {}) });
          if (result.outcome === "conflict") {
            await upsertOfflineConflict({
              userId,
              ...(current?.tenantId !== undefined ? { tenantId: current.tenantId } : {}),
              siteId: result.item.siteId,
              operationId: result.item.clientOperationId,
              kind: result.item.kind,
              outcome: "conflict",
              message: result.metadata.lastError ?? "تعارض يحتاج إلى مراجعة قبل إعادة الإرسال.",
              createdAt: result.item.createdAt,
              updatedAt: Date.now(),
              localPayload: result.item.payload,
            });
          } else if (result.outcome === "applied" || result.outcome === "already_applied") {
            await removeOfflineConflict(userId, result.item.clientOperationId);
          }
          if (result.outcome === "retryable") await updateOfflineWork(result.item.id, { status: "failed", error: result.metadata.lastError ?? "تعذر مزامنة العملية مؤقتاً." });
          else if (result.outcome === "conflict") await updateOfflineWork(result.item.id, { status: "conflict", error: result.metadata.lastError ?? "تعارض يحتاج إلى مراجعة." });
          else if (result.outcome === "rejected") await updateOfflineWork(result.item.id, { status: "failed", error: result.metadata.lastError ?? "رفض الخادم العملية." });
        }
        await refresh(results);
        const successfulSubscriberChanges = results.filter((result) =>
          (result.item.kind === "subscriber_create" || result.item.kind === "subscriber_update") &&
          (result.outcome === "applied" || result.outcome === "already_applied"),
        );
        if (typeof window !== "undefined") {
          for (const changedSiteId of new Set(successfulSubscriberChanges.map((result) => result.item.siteId))) {
            window.dispatchEvent(new CustomEvent("powerhub:subscriber-directory-changed", { detail: { siteId: changedSiteId } }));
          }
          for (const result of successfulSubscriberChanges) {
            if (result.item.kind === "subscriber_create" &&
                (result.item.payload as import("@/lib/offline-work-queue").SubscriberCreateDraft).offlineNumberClaim) {
              window.dispatchEvent(new CustomEvent("powerhub:offline-number-grant-refresh", { detail: { siteId: result.item.siteId, userId } }));
            }
          }
        }
        const retriable = results.filter((r) => r.outcome === "retryable").length;
        const conflicts = results.filter((r) => r.outcome === "conflict").length;
        const completed = results.filter((r) => r.outcome === "applied" || r.outcome === "already_applied").length;
        if (completed) toast.success(`اكتملت مزامنة ${completed} عملية.`);
        if (retriable) toast.warning(`توجد ${retriable} عملية مؤجلة لإعادة المحاولة.`);
        if (conflicts) toast.error(`توجد ${conflicts} عملية متعارضة تحتاج إلى مراجعة.`);
      } catch (error) { toast.error(getErrorMessage(error)); }
      finally {
        setSyncing(false);
        await load();
      }
    });
    if (!lockResult.acquired) toast.info("المزامنة تعمل بالفعل في تبويب آخر لهذا الفرع.");
  };

  const retryFailedAndSync = async () => {
    if (!isOnline) return toast.error("تحتاج إلى اتصال قبل إعادة المحاولة.");
    try {
      const [allItems, metadataRows] = await Promise.all([
        listOfflineWork({ userId, siteId }),
        listSyncMetadata({ userId, siteId }),
      ]);
      const now = Date.now();
      for (const item of allItems.filter((entry) => entry.status === "failed")) {
        const metadata = metadataRows.find((row) => row.operationId === item.clientOperationId);
        // Only retry transient failures. Validation/auth rejection and conflicts
        // remain blocked until the underlying issue is reviewed.
        // A missing metadata row is ambiguous, not proof of a transient error.
        // Only an explicitly classified retryable result may be re-queued.
        if (!metadata || metadata.outcome !== "retryable") continue;
        if (metadata) {
          const { lastError: previousError, ...baseMetadata } = metadata;
          void previousError;
          await upsertSyncMetadata({
            ...baseMetadata,
            attempts: 0,
            nextAttemptAt: now,
            outcome: "pending",
            updatedAt: now,
          });
        }
        await updateOfflineWork(item.id, { status: "pending", error: undefined });
      }
      await load();
      await syncPending();
    } catch (error) {
      toast.error(getErrorMessage(error));
    }
  };

  useEffect(() => {
    if (!isOnline || reconnectGeneration === 0 || lastAutoSyncGeneration.current === reconnectGeneration) return;
    lastAutoSyncGeneration.current = reconnectGeneration;
    void load();
    void syncPending();
  }, [isOnline, reconnectGeneration, load]);

  const pending = items.filter((item) => item.status === "pending" || (item.status === "failed"));
  const unresolved = items.filter((item) => item.status !== "applied");
  if (compact && !items.length) return null;
  return <Card className="border-[#F5B800]/20 bg-[#111823] shadow-panel"><CardContent className="p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex items-center gap-2 text-sm font-bold text-[#F5B800]"><CloudOff className="h-4 w-4" />مركز مزامنة المسودات</div><p className="mt-1 text-xs leading-5 text-slate-400">تُحفظ المسودات محلياً أولاً. لا يصدر رقم فاتورة ولا يتغير سجل مالي قبل قبول الخادم للعملية؛ والتحصيل المعلق لا يملك إيصالاً رسمياً قبل قبول المزامنة.</p>
    <div className="mt-2 space-y-1 text-xs text-slate-400" aria-live="polite">
      <p>{deltaStatuses.some((row) => row.lastSyncedAt !== null)
        ? `آخر مزامنة تفاضلية ناجحة: ${new Date(Math.max(...deltaStatuses.map((row) => row.lastSyncedAt ?? 0))).toLocaleString("ar-IQ")}`
        : "لم تُسجل مزامنة تفاضلية ناجحة لهذا الفرع بعد."}
        {" · "}نطاقات متعثرة: {deltaStatuses.filter((row) => row.outcome === "failed").length}
        {" · "}تعارضات محفوظة: {conflictRecords.length}
      </p>
      {deltaStatuses.filter((row) => row.outcome === "failed" && row.lastError).slice(0, 2).map((row) =>
        <p key={row.entityType} className="text-rose-200">{row.entityType}: {row.lastError}</p>
      )}
      {conflictRecords.slice(0, 2).map((row) =>
        <p key={row.operationId} className="text-amber-200">{row.kind}: {row.message}</p>
      )}
    </div></div><div className="flex items-center gap-2"><Badge className={isOnline ? "bg-emerald-400/10 text-emerald-300" : "bg-amber-400/10 text-amber-200"}>{isOnline ? "متصل" : "دون اتصال"}</Badge><Button size="sm" disabled={!isOnline || !pending.length || syncing} onClick={() => void retryFailedAndSync()} className="bg-[#F5B800] text-[#0D1117] hover:bg-[#ffd23f]"><RefreshCw className={`ml-1.5 h-3.5 w-3.5 ${syncing ? "animate-spin" : ""}`} />مزامنة المعلقة ({pending.length})</Button></div></div>
    {items.length ? <div className="mt-4 space-y-2">{items.map((item) => <div key={item.id} className="flex flex-col gap-3 rounded-xl border border-white/8 bg-white/[.018] p-3 sm:flex-row sm:items-center sm:justify-between"><div><p className="font-bold text-sm text-white">{labelByKind[item.kind]} {item.appliedLabel ? `— ${item.appliedLabel}` : ""}</p>{item.kind === "subscriber_create" && item.status !== "applied" ? ((item.payload as import("@/lib/offline-work-queue").SubscriberCreateDraft).offlineNumberClaim?.formattedNumber ? <p className="mt-1 text-xs text-amber-200">رقم محجوز محليًا: {(item.payload as import("@/lib/offline-work-queue").SubscriberCreateDraft).offlineNumberClaim?.formattedNumber} — بانتظار اعتماد الخادم</p> : null) : null}<p className="mt-1 text-xs text-slate-500">{new Date(item.createdAt).toLocaleString("ar-IQ")} · {labelByStatus[item.status]}</p>{item.error ? <p className="mt-1 max-w-2xl text-xs text-rose-200">{item.error}</p> : null}</div><div className="flex items-center gap-2"><Badge className={item.status === "applied" ? "bg-emerald-400/10 text-emerald-300" : item.status === "conflict" ? "bg-rose-400/10 text-rose-200" : item.status === "failed" ? "bg-amber-400/10 text-amber-200" : "bg-sky-400/10 text-sky-200"}>{item.status === "conflict" ? <AlertTriangle className="ml-1 h-3 w-3" /> : item.status === "applied" ? <CheckCircle2 className="ml-1 h-3 w-3" /> : null}{labelByStatus[item.status]}</Badge>{["pending", "failed"].includes(item.status) ? <Button size="sm" variant="outline" disabled={!isOnline || syncing} onClick={() => void retryFailedAndSync()} className="border-white/15 text-slate-100"><RefreshCw className="ml-1 h-3 w-3" />مزامنة</Button> : null}<Button aria-label={`حذف مسودة ${labelByKind[item.kind]}`} size="icon" variant="ghost" disabled={syncing} onClick={() => void removeOfflineWork(item.id).then(() => removeOfflineConflict(userId, item.clientOperationId)).then(load)} className="h-8 w-8 text-slate-400 hover:bg-rose-400/10 hover:text-rose-200"><Trash2 className="h-3.5 w-3.5" /></Button></div></div>)}</div> : <p className="mt-4 rounded-xl border border-dashed border-white/10 px-4 py-5 text-center text-sm text-slate-500">لا توجد مسودات محلية في هذا الفرع.</p>}
    {unresolved.some((item) => item.status === "conflict") ? <p className="mt-3 text-xs leading-5 text-amber-100">تحذير: التعارض لا يدمج تلقائياً. احذف المسودة بعد مراجعة السجل الحالي وأنشئ تعديلاً جديداً من بيانات الخادم.</p> : null}</CardContent></Card>;
}
