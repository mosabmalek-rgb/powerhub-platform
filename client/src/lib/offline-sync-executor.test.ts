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
    payload: { fullName: id, phone: "", subscriptionType: "residential" },
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

  it("preserves server-applied metadata for local reconciliation", async () => {
    const a = item("a", 1);

    const [result] = await executeReadyOperations({
      items: [a],
      metadataByOperationId: new Map([[a.clientOperationId, createSyncMetadata(a, 0)]]),
      transport: async () => ({ outcome: "applied", appliedEntityId: 123, appliedLabel: "SUB-000123" }),
      now: 100,
    });

    expect(result.outcome).toBe("applied");
    expect(result.transportResult).toMatchObject({ appliedEntityId: 123, appliedLabel: "SUB-000123" });
    expect(result.metadata.nextAttemptAt).toBe(Number.POSITIVE_INFINITY);
  });

  it("does not turn a local reconciliation failure into a retryable server result", async () => {
    const a = item("a", 1);
    const transport = vi.fn(async () => ({ outcome: "already_applied" as const, appliedEntityId: 456, appliedLabel: "SUB-000456" }));

    const [result] = await executeReadyOperations({
      items: [a],
      metadataByOperationId: new Map([[a.clientOperationId, createSyncMetadata(a, 0)]]),
      transport,
      now: 100,
    });

    expect(result.outcome).toBe("already_applied");
    expect(result.transportResult).toMatchObject({ appliedEntityId: 456, appliedLabel: "SUB-000456" });
    expect(result.metadata.nextAttemptAt).toBe(Number.POSITIVE_INFINITY);
    expect(transport).toHaveBeenCalledTimes(1);
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
