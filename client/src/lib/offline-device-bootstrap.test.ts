import { describe, expect, it, vi } from "vitest";
import {
  bootstrapDeviceContext,
  deviceBootstrapScopeKey,
  type DeviceBootstrapCheckpoint,
  type DeviceBootstrapCheckpointStore,
  type DeviceBootstrapDriver,
  type DeviceBootstrapPlan,
  type DeviceBootstrapScope,
} from "./offline-device-bootstrap";

const scope: DeviceBootstrapScope = {
  userId: 17, tenantId: 23, siteId: 4,
  deviceId: "b0d7f3f1-3d40-4c2b-9f61-8e9a2fddcc12",
  localSchemaVersion: 5,
};
const plan: DeviceBootstrapPlan = {
  numberRanges: [
    { numberKind: "subscriber", partitionKey: "global" },
    { numberKind: "invoice", partitionKey: "2026" },
  ],
  snapshotEntityTypes: ["sites", "subscribers", "generators", "tariffs"],
};
function makeStore(): DeviceBootstrapCheckpointStore & { rows: Map<string, DeviceBootstrapCheckpoint> } {
  const rows = new Map<string, DeviceBootstrapCheckpoint>();
  return { rows, get: async (key) => rows.get(key), put: async (value) => { rows.set(value.scopeKey, structuredClone(value)); } };
}
function makeDriver(overrides: Partial<DeviceBootstrapDriver> = {}) {
  let cursorsReady = false;
  const calls = {
    resolvePlan: vi.fn(async () => plan),
    hasAvailableNumberRange: vi.fn(async () => false),
    reserveNumberRange: vi.fn(async () => undefined),
    persistInitialSnapshot: vi.fn(async (_scope: DeviceBootstrapScope, entities: readonly DeviceBootstrapPlan["snapshotEntityTypes"][number][]) => [...entities]),
    hasDeltaCursors: vi.fn(async () => cursorsReady),
    waitForDeltaCursors: vi.fn(async () => cursorsReady),
  };
  return { driver: { ...calls, ...overrides } as DeviceBootstrapDriver, calls, setCursorsReady(value: boolean) { cursorsReady = value; } };
}
describe("first-device bootstrap coordinator", () => {
  it("saves idempotency keys before reservations and resumes without duplicate snapshots", async () => {
    const store = makeStore();
    let nextId = 0;
    let failFirst = true;
    const requestIds: string[] = [];
    const reserve = vi.fn(async (_scope: DeviceBootstrapScope, _range: DeviceBootstrapPlan["numberRanges"][number], requestId: string) => {
      requestIds.push(requestId);
      if (failFirst) { failFirst = false; throw Object.assign(new Error("ambiguous network result"), { name: "TransientNetworkError" }); }
    });
    const mock = makeDriver({ reserveNumberRange: reserve });
    await expect(bootstrapDeviceContext({
      scope, driver: mock.driver, store, now: () => 1_800_000_000_000,
      createRequestId: () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}`,
    })).rejects.toThrow("ambiguous network result");
    const saved = await store.get(deviceBootstrapScopeKey(scope));
    expect(saved?.isBootstrapped).toBe(false);
    const storedRequestId = saved?.rangeRequestIds["subscriber:global"];
    expect(storedRequestId).toBeDefined();
    mock.setCursorsReady(true);
    const result = await bootstrapDeviceContext({
      scope, driver: mock.driver, store, now: () => 1_800_000_010_000,
      createRequestId: () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}`,
    });
    expect(result.status).toBe("ready");
    expect(requestIds[0]).toBe(storedRequestId);
    expect(reserve).toHaveBeenCalledTimes(3);
    expect(mock.calls.resolvePlan).toHaveBeenCalledTimes(1);
    expect(mock.calls.persistInitialSnapshot).toHaveBeenCalledTimes(1);
    const repeated = await bootstrapDeviceContext({ scope, driver: mock.driver, store });
    expect(repeated.status).toBe("ready");
    expect(mock.calls.resolvePlan).toHaveBeenCalledTimes(1);
    expect(mock.calls.persistInitialSnapshot).toHaveBeenCalledTimes(1);
  });

  it("does not mark bootstrap complete before required Delta cursors exist", async () => {
    const store = makeStore();
    const wait = vi.fn(async () => false);
    const hasCursors = vi.fn(async () => false);
    const mock = makeDriver({ hasDeltaCursors: hasCursors, waitForDeltaCursors: wait });
    const pending = await bootstrapDeviceContext({ scope, driver: mock.driver, store, deltaWaitMs: 1 });
    expect(pending.status).toBe("pending_delta");
    expect(pending.checkpoint.isBootstrapped).toBe(false);
    expect(pending.checkpoint.snapshotCompleted).toBe(true);
    hasCursors.mockResolvedValue(true);
    const ready = await bootstrapDeviceContext({ scope, driver: mock.driver, store });
    expect(ready.status).toBe("ready");
    expect(ready.checkpoint.isBootstrapped).toBe(true);
    expect(mock.calls.persistInitialSnapshot).toHaveBeenCalledTimes(1);
  });

  it("keeps checkpoint scope isolated by user, site, device and local schema", () => {
    expect(deviceBootstrapScopeKey(scope)).not.toBe(deviceBootstrapScopeKey({ ...scope, userId: 18 }));
    expect(deviceBootstrapScopeKey(scope)).not.toBe(deviceBootstrapScopeKey({ ...scope, siteId: 5 }));
    expect(deviceBootstrapScopeKey(scope)).not.toBe(deviceBootstrapScopeKey({ ...scope, deviceId: "c9b1722f-857c-43b2-9f95-d640e5ca24bb" }));
    expect(deviceBootstrapScopeKey(scope)).not.toBe(deviceBootstrapScopeKey({ ...scope, localSchemaVersion: 6 }));
  });

  it("leaves bootstrap incomplete if the snapshot driver omits a required entity", async () => {
    const store = makeStore();
    const mock = makeDriver({ persistInitialSnapshot: vi.fn(async () => ["sites" as const]) });
    await expect(bootstrapDeviceContext({ scope, driver: mock.driver, store })).rejects.toThrow("لم تُحفظ كل مجالات");
    expect((await store.get(deviceBootstrapScopeKey(scope)))?.isBootstrapped).toBe(false);
  });
});
