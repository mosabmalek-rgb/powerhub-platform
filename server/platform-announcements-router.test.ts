import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(() => { throw new Error("unreadCount must use one SQL RPC, not fan out queries"); }),
  client: {} as { rpc: typeof state.rpc; from: typeof state.from },
}));

state.client = { rpc: state.rpc, from: state.from } as never;

vi.mock("./supabase-admin", () => ({ supabaseAdmin: () => state.client }));

import { platformAnnouncementsRouter } from "./platform-announcements-router";

const context = {
  user: { id: 42, role: "owner", platformRole: null, accountStatus: "active" } as never,
  req: {} as never,
  res: {} as never,
};

describe("platform announcement unread counter", () => {
  beforeEach(() => state.rpc.mockReset());

  it("uses one server-only SQL RPC scoped to the authenticated user", async () => {
    state.rpc.mockResolvedValueOnce({ data: 7, error: null });
    const caller = platformAnnouncementsRouter.createCaller(context);

    await expect(caller.inbox.unreadCount()).resolves.toBe(7);
    expect(state.rpc).toHaveBeenCalledTimes(1);
    expect(state.rpc).toHaveBeenCalledWith("powerhub_platform_announcement_unread_count_for_user", {
      p_user_id: 42,
    });
    expect(state.from).not.toHaveBeenCalled();
  });

  it("fails closed when the database counter fails", async () => {
    state.rpc.mockResolvedValueOnce({ data: null, error: { message: "database unavailable" } });
    const caller = platformAnnouncementsRouter.createCaller(context);

    await expect(caller.inbox.unreadCount()).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
  });

  it("normalizes invalid negative counts to zero", async () => {
    state.rpc.mockResolvedValueOnce({ data: -1, error: null });
    const caller = platformAnnouncementsRouter.createCaller(context);

    await expect(caller.inbox.unreadCount()).resolves.toBe(0);
  });
});
