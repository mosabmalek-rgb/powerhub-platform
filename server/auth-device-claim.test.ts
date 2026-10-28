import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claimPowerHubDevice, POWERHUB_DEVICE_CLAIM_TIMEOUT_MS } from "./auth-device-claim";
import { supabaseAdmin } from "./supabase-admin";

vi.mock("./supabase-admin", () => ({
  supabaseAdmin: vi.fn(),
}));

const mockedSupabaseAdmin = vi.mocked(supabaseAdmin);
const input = {
  operation: "auth.me" as const,
  userId: "auth-user-id-not-for-logs",
  deviceId: "11111111-1111-4111-8111-111111111111",
  rpcErrorMessage: "device claim failed",
  timeoutMessage: "device claim timed out",
};

function abortable<T>(promise: Promise<T>) {
  let observedSignal: AbortSignal | undefined;
  const request = promise as Promise<T> & { abortSignal: (signal: AbortSignal) => Promise<T> };
  request.abortSignal = vi.fn((signal: AbortSignal) => {
    observedSignal = signal;
    return request;
  });
  return { request, getSignal: () => observedSignal };
}

function mockRpcResponse(response: unknown) {
  const rpc = vi.fn().mockReturnValue(response);
  mockedSupabaseAdmin.mockReturnValue({ rpc } as unknown as ReturnType<typeof supabaseAdmin>);
  return rpc;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("claimPowerHubDevice", () => {
  it("accepts a successful lease response and renews the expected user/device lease", async () => {
    const { request } = abortable(Promise.resolve({ data: [{ allowed: true }], error: null }));
    const rpc = mockRpcResponse(request);

    await expect(claimPowerHubDevice(input)).resolves.toBeUndefined();

    expect(rpc).toHaveBeenCalledWith("powerhub_claim_user_device", {
      p_user_id: input.userId,
      p_device_id: input.deviceId,
      p_lease_until: expect.any(String),
    });
  });

  it("preserves a device conflict as FORBIDDEN", async () => {
    mockRpcResponse({ data: [{ allowed: false }], error: null });

    await expect(claimPowerHubDevice(input)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("aborts a stalled claim and reports a bounded gateway timeout", async () => {
    vi.useFakeTimers();
    const { request, getSignal } = abortable(new Promise((resolve) => {
      setTimeout(() => resolve({ data: [{ allowed: true }], error: null }), 60_000);
    }));
    mockRpcResponse(request);

    // Attach the rejection assertion before advancing fake timers so Vitest
    // observes the expected timeout rejection immediately (no unhandled promise).
    const rejection = expect(claimPowerHubDevice(input)).rejects.toMatchObject({
      code: "GATEWAY_TIMEOUT",
      message: input.timeoutMessage,
    });
    await vi.advanceTimersByTimeAsync(POWERHUB_DEVICE_CLAIM_TIMEOUT_MS + 1);
    await rejection;
    expect(getSignal()?.aborted).toBe(true);
  });
});
