import { describe, expect, it, vi } from "vitest";
import { nextPowerHubReachabilityState, probePowerHubConnectivity, subscribeBrowserNetworkStatus } from "./offline-connectivity";

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
  it("does not classify one failed probe cycle as offline", () => {
    expect(nextPowerHubReachabilityState(null, 0, false)).toEqual({
      reachable: null,
      consecutiveFailures: 1,
    });
    expect(nextPowerHubReachabilityState(true, 0, false)).toEqual({
      reachable: true,
      consecutiveFailures: 1,
    });
  });

  it("declares the origin unavailable only after repeated failed probe cycles", () => {
    expect(nextPowerHubReachabilityState(null, 1, false)).toEqual({
      reachable: false,
      consecutiveFailures: 2,
    });
    expect(nextPowerHubReachabilityState(true, 1, false)).toEqual({
      reachable: false,
      consecutiveFailures: 2,
    });
  });

  it("restores reachability immediately after a successful probe", () => {
    expect(nextPowerHubReachabilityState(false, 5, true)).toEqual({
      reachable: true,
      consecutiveFailures: 0,
    });
  });
});
