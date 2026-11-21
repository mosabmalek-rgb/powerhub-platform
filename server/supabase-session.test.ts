import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ getClaims: vi.fn(), syncUser: vi.fn() }));

vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ auth: { getClaims: state.getClaims } }) }));
vi.mock("./supabase-profile", () => ({ syncSupabaseProfile: state.syncUser }));

import { authenticateSupabaseRequest } from "./_core/supabase-auth";

function structurallyValidTestJwt(subject: string): string {
  const base64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return [base64url({ alg: "HS256", typ: "JWT" }),
    base64url({ sub: subject, exp: Math.floor(Date.now() / 1000) + 3600 }),
    Buffer.alloc(32, 7).toString("base64url")].join(".");
}

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
    state.getClaims.mockResolvedValue({ data: { claims: { sub: "supabase-user-id", email: "admin@powerhub.test", role: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600, user_metadata: { name: "مدير المنصة" } } }, error: null });
    state.syncUser.mockResolvedValue(synchronizedUser);

    await expect(authenticateSupabaseRequest({ headers: { authorization: `Bearer ${structurallyValidTestJwt("signed-claims")}` } } as never)).resolves.toEqual(synchronizedUser);
    expect(state.getClaims).toHaveBeenCalledWith(structurallyValidTestJwt("signed-claims"));
    expect(state.syncUser).toHaveBeenCalledWith({ id: "supabase-user-id", email: "admin@powerhub.test", name: "مدير المنصة" }, {});
  });


  it("coalesces simultaneous verification for a token and reuses only a short-lived verified result", async () => {
    const synchronizedUser = { id: 4, openId: "burst-user-id", email: "burst@powerhub.test", role: "user" };
    const claims = { sub: "burst-user-id", email: "burst@powerhub.test", role: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 };
    state.getClaims.mockResolvedValue({ data: { claims }, error: null });
    state.syncUser.mockResolvedValue(synchronizedUser);
    const request = { headers: { authorization: `Bearer ${structurallyValidTestJwt("burst")}` } } as never;
    const result = await Promise.all(Array.from({ length: 10 }, () => authenticateSupabaseRequest(request)));
    expect(result).toHaveLength(10);
    expect(state.getClaims).toHaveBeenCalledTimes(1);
    // Verifying a JWT is cached; application identity remains checked on every request.
    expect(state.syncUser).toHaveBeenCalledTimes(10);
    await authenticateSupabaseRequest(request);
    expect(state.getClaims).toHaveBeenCalledTimes(1);
    expect(state.syncUser).toHaveBeenCalledTimes(11);
  });

  it("rejects expired claims even if the SDK mock returns them as verified", async () => {
    state.getClaims.mockResolvedValue({ data: { claims: {
      sub: "expired-user", email: "expired@powerhub.test", role: "authenticated",
      exp: Math.floor(Date.now() / 1000) - 10,
    } }, error: null });
    await expect(authenticateSupabaseRequest({ headers: {
      authorization: `Bearer ${structurallyValidTestJwt("expired-sdk-claims")}`,
    } } as never)).rejects.toThrow("Invalid Supabase access token");
    expect(state.syncUser).not.toHaveBeenCalled();
  });

  it("rejects verified tokens that do not represent an authenticated user", async () => {
    state.getClaims.mockResolvedValue({ data: { claims: { sub: "supabase-user-id", email: "admin@powerhub.test", role: "anon", exp: Math.floor(Date.now() / 1000) + 3600 } }, error: null });
    await expect(authenticateSupabaseRequest({ headers: { authorization: `Bearer ${structurallyValidTestJwt("anon-role")}` } } as never)).rejects.toThrow("Invalid Supabase access token");
    expect(state.syncUser).not.toHaveBeenCalled();
  });

  it("keeps transient Auth failures distinct from a signed-out user", async () => {
    state.getClaims.mockResolvedValue({ data: { claims: null }, error: { status: 503, code: "unexpected_failure" } });
    await expect(authenticateSupabaseRequest({ headers: { authorization: `Bearer ${structurallyValidTestJwt("auth-unavailable")}` } } as never)).rejects.toThrow("temporarily unavailable");
    expect(state.syncUser).not.toHaveBeenCalled();
  });
});
