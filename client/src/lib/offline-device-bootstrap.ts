import { openOfflineWorkspaceDatabase, OFFLINE_WORKSPACE_DATABASE_VERSION } from "./offline-workspace-db";
import type { OfflineNumberKind } from "./offline-number-ranges";
import type { DeltaEntityType } from "./offline-delta-sync";

export const DEVICE_BOOTSTRAP_VERSION = 1;
export const DEVICE_BOOTSTRAP_DELTA_WAIT_MS = 12_000;

export type DeviceBootstrapScope = {
  userId: number;
  tenantId: number;
  siteId: number;
  deviceId: string;
  localSchemaVersion: number;
  bootstrapVersion?: number;
};
export type DeviceBootstrapNumberRange = { numberKind: OfflineNumberKind; partitionKey: string };
export type DeviceBootstrapPlan = {
  numberRanges: DeviceBootstrapNumberRange[];
  snapshotEntityTypes: DeltaEntityType[];
};
export type DeviceBootstrapCheckpoint = {
  scopeKey: string;
  userId: number;
  tenantId: number;
  siteId: number;
  deviceId: string;
  localSchemaVersion: number;
  bootstrapVersion: number;
  status: "in_progress" | "ready";
  isBootstrapped: boolean;
  plan: DeviceBootstrapPlan | null;
  completedRangeKeys: string[];
  rangeRequestIds: Record<string, string>;
  snapshotCompleted: boolean;
  snapshotEntityTypes: DeltaEntityType[];
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  lastErrorName: string | null;
};
export interface DeviceBootstrapCheckpointStore {
  get(scopeKey: string): Promise<DeviceBootstrapCheckpoint | undefined>;
  put(checkpoint: DeviceBootstrapCheckpoint): Promise<void>;
}
export type DeviceBootstrapDriver = {
  resolvePlan(scope: DeviceBootstrapScope): Promise<DeviceBootstrapPlan>;
  hasAvailableNumberRange(scope: DeviceBootstrapScope, range: DeviceBootstrapNumberRange): Promise<boolean>;
  reserveNumberRange(scope: DeviceBootstrapScope, range: DeviceBootstrapNumberRange, requestId: string): Promise<void>;
  persistInitialSnapshot(scope: DeviceBootstrapScope, entityTypes: readonly DeltaEntityType[]): Promise<readonly DeltaEntityType[]>;
  hasDeltaCursors(scope: DeviceBootstrapScope, entityTypes: readonly DeltaEntityType[]): Promise<boolean>;
  waitForDeltaCursors(scope: DeviceBootstrapScope, entityTypes: readonly DeltaEntityType[], timeoutMs: number): Promise<boolean>;
};
export type DeviceBootstrapResult = { status: "ready" | "pending_delta"; checkpoint: DeviceBootstrapCheckpoint };

const validNumberKinds = new Set<OfflineNumberKind>(["subscriber", "invoice"]);
const validEntities = new Set<DeltaEntityType>([
  "sites", "subscribers", "generators", "readings", "tariffs", "invoices", "payments", "expenses", "company_accounts", "company_accounts_all",
]);
const inProcessLocks = new Map<string, Promise<void>>();

export function deviceBootstrapScopeKey(scope: DeviceBootstrapScope): string {
  return [scope.userId, scope.tenantId, scope.siteId, scope.deviceId, scope.localSchemaVersion,
    scope.bootstrapVersion ?? DEVICE_BOOTSTRAP_VERSION].join(":");
}
export function deviceBootstrapRangeKey(range: DeviceBootstrapNumberRange): string {
  return `${range.numberKind}:${range.partitionKey}`;
}
function assertScope(scope: DeviceBootstrapScope): void {
  if (![scope.userId, scope.tenantId, scope.siteId, scope.localSchemaVersion].every((value) => Number.isSafeInteger(value) && value > 0) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(scope.deviceId)) {
    throw new Error("نطاق تهيئة الجهاز غير صالح.");
  }
  if (!Number.isSafeInteger(scope.bootstrapVersion ?? DEVICE_BOOTSTRAP_VERSION) ||
      (scope.bootstrapVersion ?? DEVICE_BOOTSTRAP_VERSION) < 1) throw new Error("إصدار تهيئة الجهاز غير صالح.");
}
function validatePlan(plan: DeviceBootstrapPlan): DeviceBootstrapPlan {
  if (!plan || !Array.isArray(plan.numberRanges) || !Array.isArray(plan.snapshotEntityTypes)) {
    throw new Error("خطة تهيئة الجهاز غير صالحة.");
  }
  const ranges = new Set<string>();
  for (const range of plan.numberRanges) {
    if (!range || !validNumberKinds.has(range.numberKind) || typeof range.partitionKey !== "string" ||
        !range.partitionKey.length || range.partitionKey.length > 16) throw new Error("نطاق الأرقام المطلوب للتهيئة غير صالح.");
    const key = deviceBootstrapRangeKey(range);
    if (ranges.has(key)) throw new Error("تحتوي خطة التهيئة على نطاق أرقام مكرر.");
    ranges.add(key);
    if ((range.numberKind === "subscriber" && range.partitionKey !== "global") ||
        (range.numberKind === "invoice" && !/^\d{4}$/.test(range.partitionKey))) {
      throw new Error("مفتاح تقسيم نطاق الأرقام غير صالح.");
    }
  }
  const entities = new Set<DeltaEntityType>();
  for (const entityType of plan.snapshotEntityTypes) {
    if (!validEntities.has(entityType)) throw new Error("تحتوي خطة التهيئة على مجال Delta غير معروف.");
    entities.add(entityType);
  }
  if (!entities.size) throw new Error("لا يوجد مجال بيانات مطلوب للتهيئة.");
  return { numberRanges: plan.numberRanges.map((range) => ({ ...range })), snapshotEntityTypes: [...entities] };
}
function createCheckpoint(scope: DeviceBootstrapScope, scopeKey: string, now: number): DeviceBootstrapCheckpoint {
  return {
    scopeKey, userId: scope.userId, tenantId: scope.tenantId, siteId: scope.siteId, deviceId: scope.deviceId,
    localSchemaVersion: scope.localSchemaVersion, bootstrapVersion: scope.bootstrapVersion ?? DEVICE_BOOTSTRAP_VERSION,
    status: "in_progress", isBootstrapped: false, plan: null, completedRangeKeys: [], rangeRequestIds: {},
    snapshotCompleted: false, snapshotEntityTypes: [], createdAt: now, updatedAt: now, completedAt: null, lastErrorName: null,
  };
}
function isCheckpointForScope(value: DeviceBootstrapCheckpoint | undefined, scope: DeviceBootstrapScope, scopeKey: string): value is DeviceBootstrapCheckpoint {
  return Boolean(value && value.scopeKey === scopeKey && value.userId === scope.userId && value.tenantId === scope.tenantId &&
    value.siteId === scope.siteId && value.deviceId === scope.deviceId && value.localSchemaVersion === scope.localSchemaVersion &&
    value.bootstrapVersion === (scope.bootstrapVersion ?? DEVICE_BOOTSTRAP_VERSION) &&
    Array.isArray(value.completedRangeKeys) && value.rangeRequestIds && typeof value.rangeRequestIds === "object" &&
    Array.isArray(value.snapshotEntityTypes));
}
function createRequestId(): string {
  if (typeof crypto === "undefined" || typeof crypto.randomUUID !== "function") throw new Error("تعذر إنشاء معرّف طلب تهيئة ثابت.");
  return crypto.randomUUID();
}
async function withFallbackLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = inProcessLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  inProcessLocks.set(key, gate);
  await previous;
  try { return await work(); }
  finally {
    release();
    if (inProcessLocks.get(key) === gate) inProcessLocks.delete(key);
  }
}
async function withDeviceBootstrapLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  return locks?.request ? locks.request(`powerhub:device-bootstrap:${key}`, { mode: "exclusive" }, work) : withFallbackLock(key, work);
}
const indexedDbCheckpointStore: DeviceBootstrapCheckpointStore = {
  async get(scopeKey) {
    const db = await openOfflineWorkspaceDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("bootstrapState", "readonly");
      const request = tx.objectStore("bootstrapState").get(scopeKey);
      let value: DeviceBootstrapCheckpoint | undefined;
      request.onsuccess = () => { value = request.result as DeviceBootstrapCheckpoint | undefined; };
      request.onerror = () => { try { tx.abort(); } catch { /* no-op */ } };
      tx.oncomplete = () => { db.close(); resolve(value); };
      tx.onerror = () => { db.close(); reject(tx.error ?? request.error ?? new Error("تعذر قراءة نقطة تهيئة الجهاز.")); };
      tx.onabort = () => { db.close(); reject(tx.error ?? request.error ?? new Error("أُلغيت قراءة نقطة تهيئة الجهاز.")); };
    });
  },
  async put(checkpoint) {
    const db = await openOfflineWorkspaceDatabase();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction("bootstrapState", "readwrite");
      tx.objectStore("bootstrapState").put(checkpoint);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error ?? new Error("تعذر حفظ نقطة تهيئة الجهاز.")); };
      tx.onabort = () => { db.close(); reject(tx.error ?? new Error("أُلغيت كتابة نقطة تهيئة الجهاز.")); };
    });
  },
};
async function saveCheckpoint(store: DeviceBootstrapCheckpointStore, checkpoint: DeviceBootstrapCheckpoint, now: () => number) {
  checkpoint.updatedAt = now();
  await store.put(checkpoint);
}
export async function getDeviceBootstrapCheckpoint(scope: DeviceBootstrapScope, store = indexedDbCheckpointStore) {
  assertScope(scope);
  const key = deviceBootstrapScopeKey(scope);
  const record = await store.get(key);
  return isCheckpointForScope(record, scope, key) ? record : undefined;
}

/** This coordinator runs after online auth; it never gates initial render or authorizes requests. */
export async function bootstrapDeviceContext(input: {
  scope: DeviceBootstrapScope;
  driver: DeviceBootstrapDriver;
  store?: DeviceBootstrapCheckpointStore;
  now?: () => number;
  createRequestId?: () => string;
  deltaWaitMs?: number;
}): Promise<DeviceBootstrapResult> {
  assertScope(input.scope);
  const { scope, driver } = input;
  const store = input.store ?? indexedDbCheckpointStore;
  const now = input.now ?? Date.now;
  const requestIdFactory = input.createRequestId ?? createRequestId;
  const key = deviceBootstrapScopeKey(scope);
  return withDeviceBootstrapLock(key, async () => {
    let checkpoint = await store.get(key);
    if (!isCheckpointForScope(checkpoint, scope, key)) {
      checkpoint = createCheckpoint(scope, key, now());
      await saveCheckpoint(store, checkpoint, now);
    }
    try {
      if (checkpoint.plan) checkpoint.plan = validatePlan(checkpoint.plan);
      if (checkpoint.isBootstrapped && checkpoint.plan && checkpoint.snapshotCompleted &&
          checkpoint.snapshotEntityTypes.length > 0 &&
          await driver.hasDeltaCursors(scope, checkpoint.snapshotEntityTypes)) {
        return { status: "ready", checkpoint };
      }
      if (checkpoint.isBootstrapped) {
        checkpoint.isBootstrapped = false;
        checkpoint.status = "in_progress";
        checkpoint.completedAt = null;
        await saveCheckpoint(store, checkpoint, now);
      }
      if (!checkpoint.plan) {
        checkpoint.plan = validatePlan(await driver.resolvePlan(scope));
        checkpoint.snapshotEntityTypes = [...checkpoint.plan.snapshotEntityTypes];
        await saveCheckpoint(store, checkpoint, now);
      }

      for (const range of checkpoint.plan.numberRanges) {
        const rangeKey = deviceBootstrapRangeKey(range);
        if (checkpoint.completedRangeKeys.includes(rangeKey)) continue;
        if (!(await driver.hasAvailableNumberRange(scope, range))) {
          let requestId = checkpoint.rangeRequestIds[rangeKey];
          if (!requestId) {
            requestId = requestIdFactory();
            checkpoint.rangeRequestIds[rangeKey] = requestId;
            // Save idempotency key first, so a lost response can replay the exact server request.
            await saveCheckpoint(store, checkpoint, now);
          }
          await driver.reserveNumberRange(scope, range, requestId);
        }
        checkpoint.completedRangeKeys = [...new Set([...checkpoint.completedRangeKeys, rangeKey])];
        await saveCheckpoint(store, checkpoint, now);
      }
      if (!checkpoint.snapshotCompleted) {
        const persisted = new Set(await driver.persistInitialSnapshot(scope, checkpoint.snapshotEntityTypes));
        const missing = checkpoint.snapshotEntityTypes.filter((entity) => !persisted.has(entity));
        if (missing.length) throw Object.assign(new Error("لم تُحفظ كل مجالات لقطة التهيئة محليًا."), { name: "PowerHubBootstrapSnapshotIncompleteError" });
        checkpoint.snapshotCompleted = true;
        checkpoint.snapshotEntityTypes = [...persisted];
        await saveCheckpoint(store, checkpoint, now);
      }
      const waitMs = input.deltaWaitMs ?? DEVICE_BOOTSTRAP_DELTA_WAIT_MS;
      if (!(await driver.hasDeltaCursors(scope, checkpoint.snapshotEntityTypes))) {
        await driver.waitForDeltaCursors(scope, checkpoint.snapshotEntityTypes, waitMs);
      }
      if (!(await driver.hasDeltaCursors(scope, checkpoint.snapshotEntityTypes))) {
        checkpoint.isBootstrapped = false;
        checkpoint.status = "in_progress";
        checkpoint.completedAt = null;
        checkpoint.lastErrorName = "PowerHubBootstrapDeltaPendingError";
        await saveCheckpoint(store, checkpoint, now);
        return { status: "pending_delta", checkpoint };
      }
      checkpoint.isBootstrapped = true;
      checkpoint.status = "ready";
      checkpoint.completedAt = now();
      checkpoint.lastErrorName = null;
      await saveCheckpoint(store, checkpoint, now);
      return { status: "ready", checkpoint };
    } catch (error) {
      checkpoint.isBootstrapped = false;
      checkpoint.status = "in_progress";
      checkpoint.completedAt = null;
      checkpoint.lastErrorName = error instanceof Error ? error.name : "UnknownError";
      await saveCheckpoint(store, checkpoint, now).catch(() => undefined);
      throw error;
    }
  });
}
export const DEVICE_BOOTSTRAP_LOCAL_SCHEMA_VERSION = OFFLINE_WORKSPACE_DATABASE_VERSION;
