import {
  isSyncMetadataCompatibleWithWorkItem,
  type QueuedOfflineWork,
} from "./offline-work-queue";
import type { SyncMetadataRecord } from "./offline-sync-metadata";

type WorkStatusOutcome = SyncMetadataRecord["outcome"] | "missing";
type WorkStatusTone = "success" | "warning" | "error" | "pending";

const STATUS_PRESENTATION: Record<WorkStatusOutcome, { label: string; tone: WorkStatusTone }> = {
  pending: { label: "بانتظار مزامنة الخادم", tone: "pending" },
  syncing: { label: "التحقق من نتيجة إرسال سابق", tone: "warning" },
  applied: { label: "أكد الخادم نجاح العملية", tone: "success" },
  already_applied: { label: "أكد الخادم أن العملية نُفذت سابقًا", tone: "success" },
  conflict: { label: "تعارض — مراجعة مطلوبة", tone: "error" },
  retryable: { label: "فشل مؤقت — إعادة المحاولة متاحة", tone: "warning" },
  rejected: { label: "رفض الخادم — التصحيح مطلوب", tone: "error" },
  missing: { label: "حالة مزامنة غير موثوقة — أُوقفت الإعادة", tone: "error" },
};

const BADGE_CLASSES: Record<WorkStatusTone, string> = {
  success: "bg-emerald-400/10 text-emerald-300",
  warning: "bg-amber-400/10 text-amber-200",
  error: "bg-rose-400/10 text-rose-200",
  pending: "bg-sky-400/10 text-sky-200",
};

type WorkStatusItem = Pick<
  QueuedOfflineWork,
  "clientOperationId" | "userId" | "tenantId" | "siteId" | "kind" | "status"
>;

export function getOfflineWorkStatusPresentation(
  item: WorkStatusItem,
  metadata?: SyncMetadataRecord,
  now = Date.now(),
) {
  const compatibleMetadata = isSyncMetadataCompatibleWithWorkItem(item, metadata)
    ? metadata
    : undefined;
  const outcome: WorkStatusOutcome = compatibleMetadata
    ? compatibleMetadata.outcome
    : item.status === "applied"
      ? "applied"
      : item.status === "conflict"
        ? "conflict"
        : "missing";
  const status = STATUS_PRESENTATION[outcome];
  const queueNeedsReconciliation = Boolean(compatibleMetadata && (
    ((outcome === "applied" || outcome === "already_applied") && item.status !== "applied") ||
    (outcome === "conflict" && item.status !== "conflict") ||
    (outcome === "rejected" && item.status !== "failed")
  ));
  const eligibleQueueState = item.status === "pending" || item.status === "failed";
  const canSync = Boolean(compatibleMetadata && eligibleQueueState && (
    (outcome === "pending" && item.status === "pending") ||
    outcome === "syncing" ||
    (outcome === "retryable" && (
      item.status === "failed" || compatibleMetadata.nextAttemptAt <= now
    )) ||
    queueNeedsReconciliation
  ));
  const canRetry = Boolean(
    compatibleMetadata &&
    item.status === "failed" &&
    outcome === "retryable",
  );
  const actionLabel = queueNeedsReconciliation
    ? "تسوية الحالة"
    : canRetry
      ? "إعادة محاولة"
      : "مزامنة";

  return {
    outcome,
    label: status.label,
    tone: status.tone,
    badgeClass: BADGE_CLASSES[status.tone],
    message: compatibleMetadata?.lastError,
    canSync,
    canRetry,
    actionLabel,
  };
}
