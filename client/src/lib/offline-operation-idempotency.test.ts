import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalizeOperationPayload,
  fingerprintOperationPayload,
  getStableOperationKey,
  runWithStableOperationKey,
} from "./offline-operation-idempotency";

describe("durable operation idempotency identity", () => {
  it("canonicalizes objects independently of insertion order while preserving array order", () => {
    expect(canonicalizeOperationPayload({ b: 2, a: { y: 1, x: 0 } }))
      .toBe(canonicalizeOperationPayload({ a: { x: 0, y: 1 }, b: 2 }));
    expect(canonicalizeOperationPayload({ values: [1, 2] }))
      .not.toBe(canonicalizeOperationPayload({ values: [2, 1] }));
  });

  it("normalizes omitted object properties and rejects non-serializable or non-finite values", () => {
    expect(canonicalizeOperationPayload({ value: 1, omitted: undefined })).toBe('{"value":1}');
    expect(() => canonicalizeOperationPayload({ amount: Number.NaN })).toThrow();
    expect(() => canonicalizeOperationPayload({ amount: Number.POSITIVE_INFINITY })).toThrow();
    expect(() => canonicalizeOperationPayload({ date: new Date("2026-10-31T00:00:00Z") })).toThrow();
    expect(() => canonicalizeOperationPayload({ callback: () => undefined })).toThrow();
  });

  it("produces a deterministic SHA-256 fingerprint without storing the source payload", async () => {
    const first = await fingerprintOperationPayload({ amount: 12.5, currency: "ILS" });
    const second = await fingerprintOperationPayload({ currency: "ILS", amount: 12.5 });
    const changed = await fingerprintOperationPayload({ amount: 12.51, currency: "ILS" });
    expect(first).toBe(second);
    expect(first).not.toBe(changed);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it("fails closed when IndexedDB cannot preserve the operation across reloads", async () => {
    vi.stubGlobal("indexedDB", undefined);
    const scope = { userId: 7, siteId: 3, kind: "fuel_fill", payload: { litres: 12 } };
    await expect(getStableOperationKey(scope)).rejects.toThrow("التخزين المحلي الآمن غير متاح");
    const action = vi.fn(async () => "sent");
    await expect(runWithStableOperationKey(scope, action)).rejects.toThrow("التخزين المحلي الآمن غير متاح");
    expect(action).not.toHaveBeenCalled();
  });

  afterEach(() => vi.unstubAllGlobals());
});
