import type { QueuedOfflineWork } from "./offline-work-queue";

export type SyncOutcome = "pending" | "syncing" | "applied" | "already_applied" | "conflict" | "retryable" | "rejected";

export type SyncMetadata = {
  operationId: string;
  dependsOn: string[];
  attempts: number;
  nextAttemptAt: number;
  outcome?: SyncOutcome;
  lastError?: string;
};

export type SyncPlanItem = {
  item: QueuedOfflineWork;
  metadata: SyncMetadata;
};

export const SYNC_MAX_ATTEMPTS = 5;
export const SYNC_BASE_DELAY_MS = 1_000;
export const SYNC_MAX_DELAY_MS = 5 * 60_000;

export function createSyncMetadata(item: QueuedOfflineWork, now = Date.now()): SyncMetadata {
  return {
    operationId: item.clientOperationId,
    dependsOn: [],
    attempts: 0,
    nextAttemptAt: now,
    outcome: "pending",
  };
}

export function isDependencySatisfied(
  dependencyId: string,
  completedIds: ReadonlySet<string>,
): boolean {
  return completedIds.has(dependencyId);
}

export function areDependenciesSatisfied(
  dependencies: readonly string[],
  completedIds: ReadonlySet<string>,
): boolean {
  return dependencies.every((dependencyId) => isDependencySatisfied(dependencyId, completedIds));
}

export function planReadyOperations(
  items: readonly QueuedOfflineWork[],
  metadataByOperationId: ReadonlyMap<string, SyncMetadata>,
  completedIds: ReadonlySet<string>,
  now = Date.now(),
): SyncPlanItem[] {
  return items
    .flatMap((item) => {
      // Missing persisted metadata is ambiguous after a crash. Fail closed:
      // never turn it into a fresh pending operation and replay it automatically.
      const metadata = metadataByOperationId.get(item.clientOperationId);
      return metadata ? [{ item, metadata }] : [];
    })
    .filter(({ item, metadata }) => {
      // Queue status can lag behind the persisted sync result after a crash or
      // partial IndexedDB write. Never resubmit terminal failures just because
      // the queue row still says "pending".
      if (metadata.outcome === "conflict" || metadata.outcome === "rejected" || metadata.outcome === "applied" || metadata.outcome === "already_applied") {
        return false;
      }
      if (metadata.outcome === "retryable") {
        return shouldRetry(metadata) && (item.status === "pending" || item.status === "failed");
      }
      // A persisted "syncing" state survives crashes in older clients. The caller
      // must hold the scoped sync lock before planning, so no live worker owns it.
      // Resume with the same operation ID; server idempotency resolves uncertain commits.
      if (metadata.outcome === "syncing") {
        return metadata.attempts < SYNC_MAX_ATTEMPTS &&
          (item.status === "pending" || item.status === "failed");
      }
      return item.status === "pending" && metadata.outcome === "pending";
    })
    .filter(({ metadata }) => metadata.outcome === "syncing" || metadata.nextAttemptAt <= now)
    .filter(({ metadata }) => areDependenciesSatisfied(metadata.dependsOn, completedIds))
    .sort((a, b) => a.item.createdAt - b.item.createdAt);
}

export function classifySyncResult(errorCode?: string): SyncOutcome {
  switch (errorCode) {
    case "CONFLICT":
      return "conflict";
    case "UNAUTHORIZED":
    case "FORBIDDEN":
    case "BAD_REQUEST":
    case "NOT_FOUND":
    case "VALIDATION_FAILED":
    case "PRECONDITION_FAILED":
      return "rejected";
    case "TIMEOUT":
    case "RATE_LIMITED":
    case "INTERNAL_SERVER_ERROR":
    case "SERVICE_UNAVAILABLE":
      return "retryable";
    // This function classifies failed/ambiguous transports, never successful responses.
    // Unknown or missing codes must fail closed; callers confirm success separately.
    default:
      return "retryable";
  }
}

export function computeBackoffDelay(
  attempts: number,
  random = Math.random(),
): number {
  const exponent = Math.max(0, attempts - 1);
  const base = Math.min(SYNC_MAX_DELAY_MS, SYNC_BASE_DELAY_MS * 2 ** exponent);
  const jitter = 0.75 + random * 0.5;
  return Math.min(SYNC_MAX_DELAY_MS, Math.round(base * jitter));
}

export function scheduleRetry(
  metadata: SyncMetadata,
  now = Date.now(),
  random = Math.random(),
): SyncMetadata {
  const attempts = metadata.attempts + 1;
  if (attempts >= SYNC_MAX_ATTEMPTS) {
    return {
      ...metadata,
      attempts,
      nextAttemptAt: Number.POSITIVE_INFINITY,
      outcome: "retryable",
    };
  }

  return {
    ...metadata,
    attempts,
    nextAttemptAt: now + computeBackoffDelay(attempts, random),
    outcome: "retryable",
  };
}

/** Manual retry is safe only when the last server/transport result was explicitly transient. */
export function canManuallyRetry(metadata: Pick<SyncMetadata, "outcome"> | undefined): boolean {
  return metadata?.outcome === "retryable";
}

export function shouldRetry(metadata: SyncMetadata): boolean {
  return metadata.attempts < SYNC_MAX_ATTEMPTS && Number.isFinite(metadata.nextAttemptAt);
}

export function markCompleted(metadata: SyncMetadata): SyncMetadata {
  return { ...metadata, nextAttemptAt: Number.POSITIVE_INFINITY, lastError: undefined };
}
