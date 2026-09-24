import { describe, expect, it, vi } from "vitest";

const rpcMock = vi.fn();

vi.mock("./supabase-admin", () => ({
  supabaseAdmin: () => ({ rpc: rpcMock }),
}));

describe("auth.releaseDevice stale-lock recovery", () => {
  it("can be invoked with a different device id without running single-device enforcement", async () => {
    rpcMock.mockResolvedValueOnce({ data: true, error: null });

    const { appRouter } = await import("./routers");
    const ctx = {
      user: {
        id: 81,
        openId: "auth-user-1",
        email: "user@example.test",
        name: "Test User",
        role: "user",
        createdAt: new Date(),
        updatedAt: new Date(),
        lastSignedIn: new Date(),
        accountStatus: "active",
      },
      req: {
        headers: { "x-powerhub-device-id": "11111111-1111-1111-1111-111111111111" },
      },
      res: {},
    } as any;

    const result = await appRouter.createCaller(ctx).auth.releaseDevice();

    expect(result).toEqual({ released: true });
    expect(rpcMock).toHaveBeenCalledWith("powerhub_release_user_device", {
      p_user_id: "auth-user-1",
      p_device_id: "11111111-1111-1111-1111-111111111111",
    });
  });
});
