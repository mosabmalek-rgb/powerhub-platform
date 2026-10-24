import { describe, expect, it, vi } from "vitest";
import { withOfflineSyncLock, type OfflineSyncLockManager } from "./offline-sync-lock";

const scope = { userId: 7, tenantId: 3, siteId: 2 };

describe("offline sync cross-tab lock", () => {
  it("uses a scoped exclusive browser lock and runs work only when acquired", async () => {
    const request = vi.fn(async (_name: string, _options: { mode: "exclusive"; ifAvailable: true }, callback: (lock: unknown | null) => Promise<unknown>) => callback({}));
    const manager = { request } as OfflineSyncLockManager;
    const task = vi.fn(async () => "synced");
    await expect(withOfflineSyncLock(scope, task, manager)).resolves.toEqual({ acquired: true, value: "synced" });
    expect(request).toHaveBeenCalledWith("powerhub:offline-sync:7:3:2", { mode: "exclusive", ifAvailable: true }, expect.any(Function));
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("does not run the task if another tab owns the browser lock", async () => {
    const manager = {
      request: async (_name: string, _options: { mode: "exclusive"; ifAvailable: true }, callback: (lock: unknown | null) => Promise<unknown>) => callback(null),
    } as OfflineSyncLockManager;
    const task = vi.fn(async () => "must-not-run");
    await expect(withOfflineSyncLock(scope, task, manager)).resolves.toEqual({ acquired: false });
    expect(task).not.toHaveBeenCalled();
  });

  it("uses a single-flight fallback when Web Locks are unavailable", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const task = vi.fn(async () => { await gate; return "done"; });
    const first = withOfflineSyncLock(scope, task, undefined);
    await Promise.resolve();
    await expect(withOfflineSyncLock(scope, task, undefined)).resolves.toEqual({ acquired: false });
    release();
    await expect(first).resolves.toEqual({ acquired: true, value: "done" });
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid scopes before running work", async () => {
    const task = vi.fn(async () => undefined);
    await expect(withOfflineSyncLock({ userId: 0, siteId: 2 }, task, undefined)).rejects.toThrow("نطاق قفل المزامنة غير صالح");
    expect(task).not.toHaveBeenCalled();
  });
});
