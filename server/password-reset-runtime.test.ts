import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  rpc: vi.fn(),
  supabaseAdmin: vi.fn(),
}));

vi.mock("./supabase-admin", () => ({
  supabaseAdmin: state.supabaseAdmin,
}));

import { completePasswordResetWithRetry } from "./password-reset-runtime";

afterEach(() => {
  state.rpc.mockReset();
  state.supabaseAdmin.mockReset();
});

describe("password reset completion", () => {
  it("retries the same completion intent and never generates or changes a password", async () => {
    const rpc = state.rpc
      .mockResolvedValueOnce({ data: null, error: { message: "temporary network failure" } })
      .mockResolvedValueOnce({ data: [{ success: true, intent_status: "completed" }], error: null });
    state.supabaseAdmin.mockReturnValue({ rpc });

    await expect(completePasswordResetWithRetry(42, 7, true)).resolves.toEqual({ ok: true, error: null });

    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenNthCalledWith(1, "powerhub_complete_password_reset", {
      p_intent_id: 42,
      p_actor_user_id: 7,
      p_success: true,
      p_failure_reason: null,
    });
    expect(rpc).toHaveBeenNthCalledWith(2, "powerhub_complete_password_reset", {
      p_intent_id: 42,
      p_actor_user_id: 7,
      p_success: true,
      p_failure_reason: null,
    });
  });

  it("returns failure after two unsuccessful completion attempts", async () => {
    const rpc = state.rpc
      .mockResolvedValueOnce({ data: null, error: { message: "database unavailable" } })
      .mockResolvedValueOnce({ data: null, error: { message: "database still unavailable" } });
    state.supabaseAdmin.mockReturnValue({ rpc });

    await expect(completePasswordResetWithRetry(42, 7, true)).resolves.toEqual({
      ok: false,
      error: { message: "database still unavailable" },
    });

    expect(rpc).toHaveBeenCalledTimes(2);
  });
});
