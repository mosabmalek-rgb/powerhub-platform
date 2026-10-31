import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  channel: null as any,
  broadcastHandler: null as ((message: any) => void) | null,
  statusHandler: null as ((status: string) => void) | null,
  channel: vi.fn(),
  removeChannel: vi.fn(),
  setAuth: vi.fn(),
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    channel: mockState.channel,
    removeChannel: mockState.removeChannel,
    realtime: { setAuth: mockState.setAuth },
  },
}));

import {
  getAdaptiveDeltaRealtimeTopicCount,
  subscribeAdaptiveDeltaTopic,
} from "./adaptive-delta-realtime";

function setupChannel() {
  const fakeChannel = {
    on: vi.fn((_type: string, _filter: unknown, handler: (message: any) => void) => {
      mockState.broadcastHandler = handler;
      return fakeChannel;
    }),
    subscribe: vi.fn((handler: (status: string) => void) => {
      mockState.statusHandler = handler;
      handler("SUBSCRIBED");
      return fakeChannel;
    }),
  };
  mockState.channel.mockReturnValue(fakeChannel);
  mockState.removeChannel.mockResolvedValue("ok");
  mockState.setAuth.mockResolvedValue(undefined);
  return fakeChannel;
}

beforeEach(() => {
  mockState.channel.mockReset();
  mockState.removeChannel.mockReset();
  mockState.setAuth.mockReset();
  mockState.broadcastHandler = null;
  mockState.statusHandler = null;
  setupChannel();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("adaptive Delta private Realtime channel", () => {
  it("shares one private channel across listeners and replays current connection state", async () => {
    const channel = setupChannel();
    const first = { onStatus: vi.fn(), onInvalidate: vi.fn() };
    const second = { onStatus: vi.fn(), onInvalidate: vi.fn() };
    const stopFirst = subscribeAdaptiveDeltaTopic("powerhub:tenant:10:site:100", first);

    await Promise.resolve();
    await Promise.resolve();
    expect(mockState.channel).toHaveBeenCalledTimes(1);
    expect(mockState.channel).toHaveBeenCalledWith("powerhub:tenant:10:site:100", { config: { private: true } });
    expect(mockState.setAuth).toHaveBeenCalledTimes(1);
    expect(channel.subscribe).toHaveBeenCalledTimes(1);
    expect(first.onStatus).toHaveBeenLastCalledWith("connected");

    const stopSecond = subscribeAdaptiveDeltaTopic("powerhub:tenant:10:site:100", second);
    expect(mockState.channel).toHaveBeenCalledTimes(1);
    expect(channel.subscribe).toHaveBeenCalledTimes(1);
    expect(second.onStatus).toHaveBeenLastCalledWith("connected");
    expect(getAdaptiveDeltaRealtimeTopicCount()).toBe(1);

    stopFirst();
    expect(mockState.removeChannel).not.toHaveBeenCalled();
    stopSecond();
    expect(mockState.removeChannel).toHaveBeenCalledTimes(1);
    expect(getAdaptiveDeltaRealtimeTopicCount()).toBe(0);
  });

  it("accepts only the versioned invalidation marker and fans it out to local listeners", async () => {
    setupChannel();
    const first = { onStatus: vi.fn(), onInvalidate: vi.fn() };
    const second = { onStatus: vi.fn(), onInvalidate: vi.fn() };
    const stopFirst = subscribeAdaptiveDeltaTopic("powerhub:tenant:10:site:100", first);
    const stopSecond = subscribeAdaptiveDeltaTopic("powerhub:tenant:10:site:100", second);
    await Promise.resolve();
    await Promise.resolve();

    mockState.broadcastHandler?.({ payload: { version: 2 } });
    mockState.broadcastHandler?.({ payload: { version: 1, row_data: { amount: 99 } } });
    expect(first.onInvalidate).toHaveBeenCalledTimes(1);
    expect(second.onInvalidate).toHaveBeenCalledTimes(1);

    stopFirst();
    stopSecond();
  });

  it("propagates disconnect and recovery to all listeners", async () => {
    setupChannel();
    const first = { onStatus: vi.fn(), onInvalidate: vi.fn() };
    const second = { onStatus: vi.fn(), onInvalidate: vi.fn() };
    const stopFirst = subscribeAdaptiveDeltaTopic("powerhub:tenant:10:all", first);
    const stopSecond = subscribeAdaptiveDeltaTopic("powerhub:tenant:10:all", second);
    await Promise.resolve();
    await Promise.resolve();

    mockState.statusHandler?.("CHANNEL_ERROR");
    expect(first.onStatus).toHaveBeenLastCalledWith("disconnected");
    expect(second.onStatus).toHaveBeenLastCalledWith("disconnected");
    mockState.statusHandler?.("SUBSCRIBED");
    expect(first.onStatus).toHaveBeenLastCalledWith("connected");
    expect(second.onStatus).toHaveBeenLastCalledWith("connected");

    stopFirst();
    stopSecond();
  });

  it("rejects malformed or unbounded topics before opening a channel", () => {
    const listener = { onStatus: vi.fn(), onInvalidate: vi.fn() };
    const stop = subscribeAdaptiveDeltaTopic("powerhub:tenant:999999999999999999999:all", listener);
    expect(mockState.channel).not.toHaveBeenCalled();
    expect(listener.onStatus).toHaveBeenCalledWith("disconnected");
    stop();
    expect(getAdaptiveDeltaRealtimeTopicCount()).toBe(0);
  });

  it("cleans up each topic independently", () => {
    const first = { onStatus: vi.fn(), onInvalidate: vi.fn() };
    const second = { onStatus: vi.fn(), onInvalidate: vi.fn() };
    const stopFirst = subscribeAdaptiveDeltaTopic("powerhub:tenant:10:site:100", first);
    const stopSecond = subscribeAdaptiveDeltaTopic("powerhub:tenant:20:site:200", second);
    expect(getAdaptiveDeltaRealtimeTopicCount()).toBe(2);
    stopFirst();
    expect(getAdaptiveDeltaRealtimeTopicCount()).toBe(1);
    expect(mockState.removeChannel).toHaveBeenCalledTimes(1);
    stopSecond();
    expect(getAdaptiveDeltaRealtimeTopicCount()).toBe(0);
    expect(mockState.removeChannel).toHaveBeenCalledTimes(2);
  });
});
