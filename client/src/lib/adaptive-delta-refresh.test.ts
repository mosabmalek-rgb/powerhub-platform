import { afterEach, describe, expect, it, vi } from "vitest";
import { AdaptiveDeltaRefreshManager } from "./adaptive-delta-refresh";

function harness() {
  let visible = true;
  let online = true;
  let listeners: { online: () => void; offline: () => void; visible: () => void; hidden: () => void } | null = null;
  const remove = vi.fn(() => { listeners = null; });
  const manager = new AdaptiveDeltaRefreshManager({
    isVisible: () => visible,
    isOnline: () => online,
    random: () => 0.5,
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id) => globalThis.clearTimeout(id),
    subscribe: (events) => { listeners = events; return remove; },
  });
  return {
    manager, remove,
    visibility(value: boolean) { visible = value; (value ? listeners?.visible : listeners?.hidden)?.(); },
    network(value: boolean) { online = value; (value ? listeners?.online : listeners?.offline)?.(); },
  };
}

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("AdaptiveDeltaRefreshManager", () => {
  it("polls every 30 seconds while visible and online", async () => {
    vi.useFakeTimers();
    const { manager } = harness();
    const check = vi.fn();
    const stop = manager.register("u1:t1:s1:dashboard", check);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(check).toHaveBeenCalledTimes(1);
    stop();
  });

  it("pauses fully in the background and checks immediately on return", async () => {
    vi.useFakeTimers();
    const h = harness();
    const check = vi.fn();
    const stop = h.manager.register("scope:visibility", check);
    h.visibility(false);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(check).not.toHaveBeenCalled();
    h.visibility(true);
    await Promise.resolve();
    expect(check).toHaveBeenCalledTimes(1);
    stop();
  });

  it("pauses offline and checks immediately after reconnect", async () => {
    vi.useFakeTimers();
    const h = harness();
    const check = vi.fn();
    const stop = h.manager.register("scope:online", check);
    h.network(false);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(check).not.toHaveBeenCalled();
    h.network(true);
    await Promise.resolve();
    expect(check).toHaveBeenCalledTimes(1);
    stop();
  });

  it("coalesces bursts of invalidations", async () => {
    vi.useFakeTimers();
    const { manager } = harness();
    const check = vi.fn();
    const stop = manager.register("scope:burst", check);
    manager.invalidate("scope:burst");
    manager.invalidate("scope:burst");
    manager.invalidate("scope:burst");
    await vi.advanceTimersByTimeAsync(249);
    expect(check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(check).toHaveBeenCalledTimes(1);
    stop();
  });

  it("allows only one in-flight check and performs one pending check", async () => {
    vi.useFakeTimers();
    const { manager } = harness();
    let release!: () => void;
    const check = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const stop = manager.register("scope:single-flight", check);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(check).toHaveBeenCalledTimes(1);
    manager.invalidate("scope:single-flight");
    manager.invalidate("scope:single-flight");
    expect(manager.getScopeState("scope:single-flight")).toMatchObject({ inFlight: true, pending: true });
    release();
    await vi.advanceTimersByTimeAsync(250);
    expect(check).toHaveBeenCalledTimes(2);
    stop();
    release();
  });

  it("uses a single 60-120 second fallback timer after Realtime disconnects", async () => {
    vi.useFakeTimers();
    const { manager } = harness();
    const check = vi.fn();
    const stop = manager.register("scope:fallback", check);
    manager.setRealtimeStatus("scope:fallback", "disconnected");
    await vi.advanceTimersByTimeAsync(89_999);
    expect(check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(check).toHaveBeenCalledTimes(1);
    stop();
  });

  it("stops periodic polling while connected and verifies immediately on recovery", async () => {
    vi.useFakeTimers();
    const { manager } = harness();
    const check = vi.fn();
    const stop = manager.register("scope:realtime", check);
    manager.setRealtimeStatus("scope:realtime", "connected");
    await Promise.resolve();
    expect(check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(check).toHaveBeenCalledTimes(1);
    manager.setRealtimeStatus("scope:realtime", "disconnected");
    manager.setRealtimeStatus("scope:realtime", "connected");
    await Promise.resolve();
    expect(check).toHaveBeenCalledTimes(2);
    stop();
  });

  it("isolates scopes and invalidations", async () => {
    vi.useFakeTimers();
    const { manager } = harness();
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = manager.register("tenant:1:site:7:fuel", first);
    const stopSecond = manager.register("tenant:2:site:7:fuel", second);
    manager.invalidate("tenant:1:site:7:fuel");
    await vi.advanceTimersByTimeAsync(250);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    stopFirst();
    stopSecond();
  });

  it("backs off after failed checks", async () => {
    vi.useFakeTimers();
    const { manager } = harness();
    const check = vi.fn().mockRejectedValue(new Error("temporary"));
    const stop = manager.register("scope:retry", check);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(check).toHaveBeenCalledTimes(1);
    expect(manager.getScopeState("scope:retry")).toMatchObject({ failures: 1, hasTimer: true });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(check).toHaveBeenCalledTimes(2);
    stop();
  });

  it("cleans up the timer and shared event listeners after the last registration", () => {
    vi.useFakeTimers();
    const h = harness();
    const stop = h.manager.register("scope:cleanup", vi.fn());
    stop();
    expect(h.manager.getScopeState("scope:cleanup")).toBeNull();
    expect(h.remove).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
