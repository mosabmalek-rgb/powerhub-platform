import { describe, expect, it, vi } from "vitest";
import { executeReadyOperations } from "./offline-sync-executor";
import type { QueuedOfflineWork } from "./offline-work-queue";
import { createSyncMetadata } from "./offline-sync-engine";

function item(id: string, createdAt: number): QueuedOfflineWork {
  return {
    id,
    clientOperationId: id,
    userId: 7,
    siteId: 11,
    kind: "subscriber_create",
    payload: { name: id, phone: "", subscriptionType: "residential" },
    createdAt,
    updatedAt: createdAt,
    status: "pending",
  };
}

describe("executeReadyOperations", () => {
  it("executes a dependency chain sequentially in one run", async () => {
    const a = item("a", 1);
    const b = item("b", 2);
    const c = item("c", 3);
    const metadata = new Map([
      [a.clientOperationId, createSyncMetadata(a, 0)],
      [b.clientOperationId, { ...createSyncMetadata(b, 0), dependsOn: [a.clientOperationId] }],
      [c.clientOperationId, { ...createSyncMetadata(c, 0), dependsOn: [b.clientOperationId] }],
    ]);
    const calls: string[] = [];

    const results = await executeReadyOperations({
      items: [c, b, a],
      metadataByOperationId: metadata,
      transport: async (operation) => {
        calls.push(operation.clientOperationId);
        return { outcome: "applied" };
      },
      now: 100,
    });

    expect(calls).toEqual(["a", "b", "c"]);
    expect(results.map((result) => result.outcome)).toEqual(["applied", "applied", "applied"]);
  });

  it("does not submit an already completed operation", async () => {
    const a = item("a", 1);
    const transport = vi.fn(async () => ({ outcome: "applied" as const }));

    const results = await executeReadyOperations({
      items: [a],
      metadataByOperationId: new Map([[a.clientOperationId, createSyncMetadata(a, 0)]]),
      completedIds: new Set([a.clientOperationId]),
      transport,
      now: 100,
    });

    expect(results).toEqual([]);
    expect(transport).not.toHaveBeenCalled();
  });

  it("treats already_applied as terminal success", async () => {
    const a = item("a", 1);

    const [result] = await executeReadyOperations({
      items: [a],
      metadataByOperationId: new Map([[a.clientOperationId, createSyncMetadata(a, 0)]]),
      transport: async () => ({ outcome: "already_applied" }),
      now: 100,
    });

    expect(result.outcome).toBe("already_applied");
    expect(result.metadata.nextAttemptAt).toBe(Number.POSITIVE_INFINITY);
  });

  it("never dispatches a queue row with a persisted terminal outcome", async () => {
    const outcomes = ["conflict", "rejected", "applied", "already_applied"] as const;

    for (const outcome of outcomes) {
      const queued = item(`terminal-${outcome}`, 1);
      const transport = vi.fn(async () => ({ outcome: "applied" as const }));
      const metadata = new Map([[queued.clientOperationId, {
        ...createSyncMetadata(queued, 0),
        outcome,
        nextAttemptAt: 0,
      }]]);

      const results = await executeReadyOperations({
        items: [queued],
        metadataByOperationId: metadata,
        transport,
        now: 100,
      });

      expect(results).toHaveLength(1);
      expect(results[0].outcome).toBe(outcome);
      expect(results[0].metadata.nextAttemptAt).toBe(Number.POSITIVE_INFINITY);
      expect(transport).not.toHaveBeenCalled();
    }
  });

  it("does not dispatch work when its persisted metadata is missing", async () => {
    const queued = item("missing-metadata", 1);
    const transport = vi.fn(async () => ({ outcome: "applied" as const }));
    const results = await executeReadyOperations({
      items: [queued], metadataByOperationId: new Map(), transport, now: 100,
    });
    expect(results).toEqual([]);
    expect(transport).not.toHaveBeenCalled();
  });

  it("recovers a persisted syncing operation through idempotent transport after a crash", async () => {
    const queued = item("interrupted-sync", 1);
    const transport = vi.fn(async () => ({ outcome: "already_applied" as const }));
    const results = await executeReadyOperations({
      items: [queued],
      metadataByOperationId: new Map([[queued.clientOperationId, {
        ...createSyncMetadata(queued, 0),
        outcome: "syncing" as const,
        attempts: 1,
        nextAttemptAt: Number.POSITIVE_INFINITY,
      }]]),
      transport,
      now: 100,
    });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(1);
    expect(results[0].outcome).toBe("already_applied");
  });

  it("dispatches retryable work only when due and while retry budget remains", async () => {
    const queued = { ...item("retryable", 1), status: "failed" as const };
    const retryMetadata = {
      ...createSyncMetadata(queued, 0),
      outcome: "retryable" as const,
      attempts: 1,
      nextAttemptAt: 200,
    };
    const transport = vi.fn(async () => ({ outcome: "retryable" as const, message: "temporary" }));

    const earlyResults = await executeReadyOperations({
      items: [queued],
      metadataByOperationId: new Map([[queued.clientOperationId, retryMetadata]]),
      transport,
      now: 199,
    });
    expect(earlyResults).toEqual([]);
    expect(transport).not.toHaveBeenCalled();

    const dueResults = await executeReadyOperations({
      items: [queued],
      metadataByOperationId: new Map([[queued.clientOperationId, retryMetadata]]),
      transport,
      now: 200,
      random: () => 0.5,
    });
    expect(dueResults).toHaveLength(1);
    expect(transport).toHaveBeenCalledTimes(1);

    transport.mockClear();
    const exhaustedResults = await executeReadyOperations({
      items: [queued],
      metadataByOperationId: new Map([[queued.clientOperationId, {
        ...retryMetadata,
        attempts: 5,
      }]]),
      transport,
      now: 200,
    });
    expect(exhaustedResults).toEqual([]);
    expect(transport).not.toHaveBeenCalled();
  });

  it("schedules only retryable failures", async () => {
    const retry = item("retry", 1);
    const rejected = item("rejected", 2);
    const metadata = new Map([
      [retry.clientOperationId, createSyncMetadata(retry, 0)],
      [rejected.clientOperationId, createSyncMetadata(rejected, 0)],
    ]);

    const results = await executeReadyOperations({
      items: [retry, rejected],
      metadataByOperationId: metadata,
      transport: async (operation) =>
        operation.clientOperationId === "retry"
          ? { outcome: "retryable", message: "temporary" }
          : { outcome: "rejected", message: "invalid" },
      now: 100,
      random: () => 0.5,
    });

    expect(results[0].metadata.attempts).toBe(1);
    expect(results[0].metadata.nextAttemptAt).toBeGreaterThan(100);
    expect(results[1].metadata.attempts).toBe(0);
  });

  it("retries an ambiguous lost response with the same operation ID and accepts server replay", async () => {
    const queued = item("uncertain-payment", 1);
    const committedOperationIds = new Set<string>();
    const firstTransport = vi.fn(async (operation: QueuedOfflineWork) => {
      // Simulate the server committing before the response is lost.
      committedOperationIds.add(operation.clientOperationId);
      throw new Error("response lost after server commit");
    });

    const [first] = await executeReadyOperations({
      items: [queued],
      metadataByOperationId: new Map([[queued.clientOperationId, createSyncMetadata(queued, 0)]]),
      transport: firstTransport,
      now: 100,
      random: () => 0.5,
    });

    expect(first.outcome).toBe("retryable");
    expect(first.metadata.attempts).toBe(1);
    expect(first.metadata.nextAttemptAt).toBeGreaterThan(100);
    expect(firstTransport).toHaveBeenCalledTimes(1);
    expect(committedOperationIds.size).toBe(1);

    const retryTransport = vi.fn(async (operation: QueuedOfflineWork) => {
      expect(operation.clientOperationId).toBe(queued.clientOperationId);
      if (committedOperationIds.has(operation.clientOperationId)) {
        return { outcome: "already_applied" as const };
      }
      committedOperationIds.add(operation.clientOperationId);
      return { outcome: "applied" as const };
    });
    const [replayed] = await executeReadyOperations({
      items: [{ ...queued, status: "failed" as const }],
      metadataByOperationId: new Map([[queued.clientOperationId, first.metadata]]),
      transport: retryTransport,
      now: first.metadata.nextAttemptAt,
      random: () => 0.5,
    });

    expect(replayed.outcome).toBe("already_applied");
    expect(replayed.item.clientOperationId).toBe(queued.clientOperationId);
    expect(retryTransport).toHaveBeenCalledTimes(1);
    expect(committedOperationIds.size).toBe(1);
  });

  it("stops the executor after a late server response crosses an identity boundary", async () => {
    const first = item("first", 1);
    const second = item("second", 2);
    let current = true;
    let resolveFirst!: (value: { outcome: "applied" }) => void;
    const pendingFirst = new Promise<{ outcome: "applied" }>((resolve) => { resolveFirst = resolve; });
    const calls: string[] = [];

    const run = executeReadyOperations({
      items: [first, second],
      metadataByOperationId: new Map([
        [first.clientOperationId, createSyncMetadata(first, 0)],
        [second.clientOperationId, createSyncMetadata(second, 0)],
      ]),
      transport: async (operation) => {
        calls.push(operation.clientOperationId);
        return operation.clientOperationId === first.clientOperationId
          ? pendingFirst
          : { outcome: "applied" as const };
      },
      isCurrent: () => current,
      now: 100,
    });

    await Promise.resolve();
    expect(calls).toEqual(["first"]);
    current = false;
    resolveFirst({ outcome: "applied" });

    await expect(run).rejects.toMatchObject({
      name: "PowerHubOfflineSyncRunSupersededError",
    });
    expect(calls).toEqual(["first"]);
  });

  it("maps transport error codes through the central classifier", async () => {
    const a = item("a", 1);

    const [result] = await executeReadyOperations({
      items: [a],
      metadataByOperationId: new Map([[a.clientOperationId, createSyncMetadata(a, 0)]]),
      transport: async () => ({ outcome: "applied", errorCode: "CONFLICT" }),
      now: 100,
    });

    expect(result.outcome).toBe("conflict");
    expect(result.metadata.lastError).toBeUndefined();
  });
});
