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

  it("pauses fully in the backgroun¶»§q«^