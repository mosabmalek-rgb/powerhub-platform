import type { QueuedOfflineWork } from "./offline-work-queue";
import {
  classifySyncResult,
  markCompleted,
  planReadyOperations,
  scheduleRetry,
  type SyncMetadata,
  type SyncOutcome,
} from "./offline-sync-engine";

export type SyncTransportResult = {
  outcome: SyncOutcome;
  errorCode?: string;
  message?: string;
};

export type SyncTransport = (
  item: QueuedOfflineWork,
  metadata: SyncMetadata,
) => Promise<SyncTransportResult>;

export type SyncExecutionResult = {
  item: QueuedOfflineWork;
  metadata: SyncMetadata;
  outcome: SyncOutcome;
};

export async function executeReadyOperations({
  items,
  metadataByOperationId,
  completedIds,
  transport,
  now = Date.now(),
  random = Math.random,
}: {
  items: readonly QueuedOfflineWork[];
  metadataByOperationId: ReadonlyMap<string, SyncMetadata>;
  completedIds?: ReadonlySet<string>;
  transport: SyncTransport;
  now?: number;
  random?: () => number;
}): Promise<SyncExecutionResult[]> {
  const completed = new Set(completedIds ?? []);
  const results: SyncExecutionResult[] = [];
  const plan = planReadyOperations(items, metadataByOperationId, completed, now);

  for (const { item, metadata } of plan) {
    const inFlightMetadata: SyncMetadata = { ...metadata, outcome: "syncing" };
    let transportResult: SyncTransportResult;

    try {
      transportResult = await transport(item, inFlightMetadata);
    } catch (error) {
      transportResult = {
        outcome: "retryable",
        errorCode: error instanceof Error ? "INTERNAL_SERVER_ERROR" : "UNKNOWN_ERROR",
        message: error instanceof Error ? error.message : "Unknown sync transport failure",
      };
    }

    const outcome = transportResult.errorCode
      ? classifySyncResult(transportResult.errorCode)
      : transportResult.outcome;

    if (outcome === "applied" || outcome === "already_applied") {
      const completedMetadata = {
        ...markCompleted(inFlightMetadata),
        outcome,
        lastError: undefined,
      };
      completed.add(item.clientOperationId);
      results.push({ item, metadata: completedMetadata, outcome });
      continue;
    }

    if (outcome === "retryable") {
      results.push({
        item,
        metadata: {
          ...scheduleRetry(
            { ...inFlightMetadata, lastError: transportResult.message },
            now,
            random(),
          ),
          outcome: "retryable",
        },
        outcome,
      });
      continue;
    }

    results.push({
      item,
      metadata: {
        ...inFlightMetadata,
        outcome,
        lastError: transportResult.message,
      },
      outcome,
    });
  }

  return results;
}
