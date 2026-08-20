import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ getUser: vi.fn(), syncUser: vi.fn() }));

vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ auth: { getUser: state.getUser } }) }));
vi.mock("./db", () => ({ syncSupabaseUser: state.syncUser }));

import { sdk } from "./_core/sdk";

describe("Supabase session authentication", () => {
  beforeEach(() => {
    process.env.VITE_SUPABASE_URL = "https://vvcdiqcyhaloxesvpppc.supabase.co";
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY = "test-public-key";
    state.getUser.mockReset();
    state.syncUser.mockReset();
  });

  it("rejects a request without a Supabase bearer token", async () => {
    await expect(sdk.authenticateRequest({ headers: {} } as never)).rejects.toThrow("Missing Supabase access token");
  });

  it("verifies the Supabase token then synchronizes the user by Supabase id and email", async () => {
    const synchronizedUser = { id: 4, openId: "supabase-user-id", email: "admin@powerhub.test", role: "admin" };
    state.getUser.mockResolvedValue({ data: { user: { id: "supabase-user-id", email: "admin@powerhub.test", user_metadata: { name: "مدير المنصة" } } }, error: null });
    state.syncUser.mockResolvedValue(synchronizedUser);

    await expect(sdk.authenticateRequest({ headers: { authorization: "Bearer supabase-token" } } as never)).resolves.toEqual(synchronizedUser);
    expect(state.syncUser).toHaveBeenCalledWith({ id: "supabase-user-id", email: "admin@powerhub.test", name: "مدير المنصة" });
  });
});
