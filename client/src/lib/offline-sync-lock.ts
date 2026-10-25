export type OfflineSyncLockScope = {
  userId: number;
  siteId: number;
  tenantId?: number;
};

export type OfflineSyncLockManager = {
  request<T>(
    name: string,
    options: { mode: "exclusive"; ifAvailable: true },
    callback: (lock: unknown | null) => Promise<T>,
  ): Promise<T>;
};

const inProcessRuns = new Map<string, Promise<unknown>>();

function scopeKey(scope: OfflineSyncLockScope) {
  if (!Number.isSafeInteger(scope.userId) || scope.userId < 1 ||
      !Number.isSafeInteger(scope.siteId) || scope.siteId < 1 ||
      (scope.tenantId !== undefined && (!Number.isSafeInteger(scope.tenantId) || scope.tenantId < 1))) {
    throw new Error("نطاق قفل المزامنة غير صالح.");
  }
  return `powerhub:offline-sync:${scope.userId}:${scope.tenantId ?? "unknown"}:${scope.siteId}`;
}

function browserLockManager(): OfflineSyncLockManager | undefined {
  if (typeof navigator === "undefined" || !("locks" in navigator)) return undefined;
  return (navigator as Navigator & { locks?: OfflineSyncLockManager }).locks;
}

/**
 * Prevents two tabs from replaying the same outbox scope at the same time.
 * Web Locks coordinate tabs when supported; a process-local single-flight is
 * retained as a safe fallback for unsupported browsers and tests.
 */
export async function withOfflineSyncLock<T>(
  scope: OfflineSyncLockScope,
  task: () => Promise<T>,
  lockManager: OfflineSyncLockManager | undefined = browserLockManager(),
): Promise<{ acquired: boolean; value?: T }> {
  const key = scopeKey(scope);
  if (lockManager) {
    return lockManager.request(key, { mode: "exclusive", ifAvailable: true }, async (lock) => {
      if (!lock) return { acquired: false };
      return { acquired: true, value: await task() };
    });
  }

  if (inProcessRuns.has(key)) return { acquired: false };
  const run = Promise.resolve().then(task);
  inProcessRuns.set(key, run);
  try {
    return { acquired: true, value: await run };
  } finally {
    if (inProcessRuns.get(key) === run) inProcessRuns.delete(key);
  }
}
