import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ getClaims: vi.fn(), syncUser: vi.fn() }));

vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ auth: { getClaims: state.getClaims } }) }));
vi.mock("./supabase-profile", () => ({ syncSupabaseProfile: state.syncUser }));

import { authenticateSupabaseRequest } from "./_core/supabase-auth";

describe("Supabase session authentication", () => {
  beforeEach(() => {
    process.env.VITE_SUPABASE_URL = "https://powerhub-ci.supabase.co";
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY = "test-public-key";
    state.getClaims.mockReset();
    state.syncUser.mockReset();
  });

  it("rejects a request without a Supabase bearer token", async () => {
    await expect(authenticateSupabaseRequest({ headers: {} } as never)).rejects.toThrow("Missing Supabase access token");
    expect(state.getClaims).not.toHaveBeenCalled();
  });

  it("verifies the signed Supabase claims then synchronizes the user by id and email", async () => {
    const synchronizedUser = { id: 4, openId: "supabase-user-id", email: "admin@powerhub.test", role: "admin" };
    state.getClaims.mockResolvedValue({ data: { claims: { sub: "supabase-user-id", email: "admin@powerhub.test", role: "authenticated", user_metadata: { name: "مدير المنصة" } } }, error: null });
    state.syncUser.mockResolvedValue(synchronizedUser);

    await expect(authenticateSupabaseRequest({ headers: { authorization: "Bearer supabase-token" } } as never)).resolves.toEqual(synchronizedUser);
    expect(state.getClaims).toHaveBeenCalledWith("supabase-token");
    expect(state.syncUser).toHaveBeenCalledWith({ id: "supabase-user-id", email: "admin@powerhub.test", name: "مدير المنصة" });
  });

  it("rejects verified tokens that do not represent an authenticated user", async () => {
    state.getClaims.mockResolvedValue({ data: { claims: { sub: "supabase-user-id", email: "admin@powerhub.test", role: "anon" } }, error: null });
    await expect(authenticateSupabaseRequest({ headers: { authorization: "Bearer anon-token" } } as never)).rejects.toThrow("Invalid Supabase access token");
    expect(state.syncUser).not.toHaveBeenCalled();
  });

  it("keeps transient Auth failures distinct from a signed-out user", async () => {
    state.getClaims.mockResolvedValue({ data: { claims: null }, error: { status: 503, code: "unexpected_failure" } });
    await expect(authenticateSupabaseRequest({ headers: { authorization: "Bearer auth-unavailable" } } as never)).rejects.toThrow("temporarily unavailable");
    expect(state.syncUser).not.toHaveBeenCalled();
  });
});
