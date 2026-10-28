import { describe, expect, it, vi } from "vitest";
import { estimatePowerHubDeviceClockOffsetMs, getPowerHubClockDiagnostics, isDeviceClockOffsetOutsideTolerance, nextPowerHubReachabilityState, probePowerHubConnectivity, resetPowerHubClockObservation, subscribeBrowserNetworkStatus, POWERHUB_DEVICE_CLOCK_SKEW_THRESHOLD_MS } from "./offline-connectivity";

describe("PowerHub connectivity probe", () => {
  it("trusts a successful origin check even when the browser reports offline", async () => {
    const fetcher = vi.fn(async () => new Response("ok", { status: 200 }));
    await expect(probePowerHubConnectivity(fetcher, false)).resolves.toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("requires a successful response from the PowerHub health endpoint", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input).toBe("/api/health");
      expect(init?.cache).toBe("no-store");
      expect(init?.credentials).toBe("same-origin");
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    });
    await expect(probePowerHubConnectivity(fetcher, true)).resolves.toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("retries a transient failure before classifying PowerHub as offline", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response("temporary error", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "ok" }), { status: 200 }));

    await expect(probePowerHubConnectivity(fetcher, true)).resolves.toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("treats persistent server errors and network failures as unavailable", async () => {
    const serverError = vi.fn(async () => new Response("unavailable", { status: 503 }));
    await expect(probePowerHubConnectivity(serverError, true)).resolves.toBe(false);
    expect(serverError).toHaveBeenCalledTimes(2);

    const networkError = vi.fn(async () => { throw new Error("network unavailable"); });
    await expect(probePowerHubConnectivity(networkError, true)).resolves.toBe(false);
    expect(networkError).toHaveBeenCalledTimes(2);
  });
});


describe("PowerHub device clock observation", () => {
  it("estimates clock offset from server Date and rejects malformed samples", () => {
    const start = Date.parse("2026-10-28T20:00:00.000Z"); const end = Date.parse("2026-10-28T20:00:02.000Z");
    const offset = estimatePowerHubDeviceClockOffsetMs("Wed, 28 Oct 2026 18:00:00 GMT", start, end);
    expect(offset).toBeGreaterThanOrEqual(7_200_000); expect(offset).toBeLessThanOrEqual(7_201_000);
    expect(isDeviceClockOffsetOutsideTolerance(offset)).toBe(true);
    expect(isDeviceClockOffsetOutsideTolerance(POWERHUB_DEVICE_CLOCK_SKEW_THRESHOLD_MS)).toBe(false);
    expect(isDeviceClockOffsetOutsideTolerance(-POWERHUB_DEVICE_CLOCK_SKEW_THRESHOLD_MS - 1)).toBe(true);
    expect(estimatePowerHubDeviceClockOffsetMs(null, start, end)).toBeNull();
  });
  it("records clock offset from a successful health response", async () => {
    const spy = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-28T20:00:00.000Z"));
    try {
      const fetcher = vi.fn(async () => new Response("ok", { status: 200, headers: { date: "Wed, 28 Oct 2026 18:00:00 GMT" } }));
      await expect(probePowerHubConnectivity(fetcher, true)).resolves.toBe(true);
      expect(getPowerHubClockDiagnostics()).toMatchObject({ sampleAvailable: true, localMinusServerMs: 7_200_000, skewDetected: true });
    } finally { spy.mockRestore(); }
  });

  it("clears a stale skew observation so a corrected clock is decided by a fresh server sample", async () => {
    resetPowerHubClockObservation();
    const skewedTime = Date.parse("2026-10-28T20:00:00.000Z");
    const spy = vi.spyOn(Date, "now").mockReturnValue(skewedTime);
    try {
      await probePowerHubConnectivity(vi.fn(async () =>
        new Response("ok", { status: 200, headers: { date: "Wed, 28 Oct 2026 18:00:00 GMT" } })), true);
      expect(getPowerHubClockDiagnostics().skewDetected).toBe(true);

      resetPowerHubClockObservation();
      expect(getPowerHubClockDiagnostics()).toMatchObject({ sampleAvailable: false, localMinusServerMs: null, skewDetected: false });

      spy.mockReturnValue(Date.parse("2026-10-28T18:00:00.000Z"));
      await probePowerHubConnectivity(vi.fn(async () =>
        new Response("ok", { status: 200, headers: { date: "Wed, 28 Oct 2026 18:00:00 GMT" } })), true);
      expect(getPowerHubClockDiagnostics()).toMatchObject({ sampleAvailable: true, skewDetected: false });
    } finally {
      spy.mockRestore();
      resetPowerHubClockObservation();
    }
  });
});

describe("browser network status", () => {
  it("tracks browser online/offline events independently of health endpoint probes", () => {
    const target = new EventTarget();
    let online = true;
    const states: boolean[] = [];
    const unsubscribe = subscribeBrowserNetworkStatus(
      (value) => states.push(value),
      target as Window,
      () => online,
    );

    expect(states.at(-1)).toBe(true);
    online = false;
    target.dispatchEvent(new Event("offline"));
    expect(states.at(-1)).toBe(false);
    online = true;
    target.dispatchEvent(new Event("online"));
    expect(states.at(-1)).toBe(true);

    const countBeforeCleanup = states.length;
    unsubscribe();
    online = false;
    target.dispatchEvent(new Event("offline"));
    expect(states).toHaveLength(countBeforeCleanup);
  });
});


describe("PowerHub stable reachability state", () => {
  it("does not classify cold-start failures as offline before enough cycles and sustained failure", () => {
    expect(nextPowerHubReachabilityState(null, 0, false, 0)).toEqual({
      reachable: null,
      consecutiveFailures: 1,
    });
    expect(nextPowerHubReachabilityState(null, 1, false, 12_000)).toEqual({
      reachable: null,
      consecutiveFailures: 2,
    });
    expect(nextPowerHubReachabilityState(null, 2, false, 7_999)).toEqual({
      reachable: null,
      consecutiveFailures: 3,
    });
    expect(nextPowerHubReachabilityState(null, 2, false, 8_000)).toEqual({
      reachable: false,
      consecutiveFailures: 3,
    });
    expect(nextPowerHubReachabilityState(true, 0, false, 0)).toEqual({
      reachable: true,
      consecutiveFailures: 1,
    });
  });

  it("requires a sustained failure window after PowerHub was previously reachable", () => {
    expect(nextPowerHubReachabilityState(true, 1, false, 7_999)).toEqual({
      reachable: true,
      consecutiveFailures: 2,
    });
    expect(nextPowerHubReachabilityState(true, 1, false, 8_000)).toEqual({
      reachable: false,
      consecutiveFailures: 2,
    });
    expect(nextPowerHubReachabilityState(false, 3, true, 0)).toEqual({
      reachable: true,
      consecutiveFailures: 0,
    });
  });

  it("restores reachability immediately after a successful probe", () => {
    expect(nextPowerHubReachabilityState(false, 5, true)).toEqual({
      reachable: true,
      consecutiveFailures: 0,
    });
  });
});
