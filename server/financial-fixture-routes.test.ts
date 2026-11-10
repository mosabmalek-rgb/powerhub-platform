import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";

const state = vi.hoisted(() => ({ access: vi.fn(), rpc: vi.fn(), from: vi.fn() }));
vi.mock("./powerhub-supabase", async (original) => ({
  ...await original<typeof import("./powerhub-supabase")>(),
  requireSupabaseSiteRole: state.access,
}));
vi.mock("./supabase-admin", async (original) => ({
  ...await original<typeof import("./supabase-admin")>(),
  supabaseAdmin: () => ({ from: state.from, rpc: state.rpc }),
}));
import { powerhubRouter } from "./powerhub";

const staging = "https://iyuryuhaylhisjfcrwkz.supabase.co";
const actor = { id: 777, openId: "synthetic-fixture-actor", role: "admin",
  platformRole: "platform_owner", accountStatus: "active", mustChangePassword: false };
const caller = (user: typeof actor | null = actor) => powerhubRouter.createCaller({
  user, req: {}, res: {},
} as never).reports;
const procedures = ["financialGLFixtureStatus", "financialGLFixturePrepare", "financialGLFixtureReview"] as const;
const input = { siteId: 1, manifestId: 33, acknowledgedIndependentReview: true as const };

beforeEach(() => {
  vi.stubEnv("SUPABASE_URL", staging);
  vi.stubEnv("VITE_SUPABASE_URL", staging);
  state.access.mockReset().mockResolvedValue({ tenantId: 1 });
  state.rpc.mockReset();
  state.from.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

describe("authenticated Staging fixture routes", () => {
  it.each(procedures)("%s denies anonymous callers before privileged access", async (name) => {
    await expect(caller(null)[name](input)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(state.rpc).not.toHaveBeenCalled();
    expect(state.from).not.toHaveBeenCalled();
  });
  it.each(procedures)("%s enforces the financial capability before privileged access", async (name) => {
    state.access.mockRejectedValue(new TRPCError({ code: "FORBIDDEN" }));
    await expect(caller()[name](input)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(state.access).toHaveBeenCalledWith(777, 1,
      ["owner", "manager", "accountant"], "manageExpenses");
    expect(state.rpc).not.toHaveBeenCalled();
    expect(state.from).not.toHaveBeenCalled();
  });
  it.each(procedures)("%s rejects a different resolved tenant", async (name) => {
    state.access.mockResolvedValue({ tenantId: 2 });
    await expect(caller()[name](input)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(state.rpc).not.toHaveBeenCalled();
    expect(state.from).not.toHaveBeenCalled();
  });
  it.each(procedures)("%s rejects a different site", async (name) => {
    await expect(caller()[name]({ ...input, siteId: 2 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(state.rpc).not.toHaveBeenCalled();
    expect(state.from).not.toHaveBeenCalled();
  });
  it.each(procedures)("%s rejects Production configuration", async (name) => {
    vi.stubEnv("SUPABASE_URL", "https://vvcdiqcyhaloxesvpppc.supabase.co");
    await expect(caller()[name](input)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(state.rpc).not.toHaveBeenCalled();
    expect(state.from).not.toHaveBeenCalled();
  });
  it("derives the preparer from the authenticated identity and strips spoofed input", async () => {
    state.rpc.mockResolvedValue({ data: 33, error: null });
    await expect(caller().financialGLFixturePrepare({
      ...input, actorId: 888, tenantId: 2,
    } as never)).resolves.toMatchObject({ manifestId: 33, accountingCertification: "NOT_CERTIFIED" });
    expect(state.rpc).toHaveBeenCalledExactlyOnceWith("powerhub_financial_gl_fixture_manifest_prepare", {
      p_tenant_id: 1, p_site_id: 1, p_actor_id: 777,
    });
  });
  it("requires explicit independent-review acknowledgement before invoking the RPC", async () => {
    await expect(caller().financialGLFixtureReview({ ...input,
      acknowledgedIndependentReview: false,
    } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(state.rpc).not.toHaveBeenCalled();
  });
  it("does not expose successful approval when post-review content verification fails", async () => {
    state.rpc.mockResolvedValueOnce({ data: { manifestId: 33, status: "verified" }, error: null })
      .mockResolvedValueOnce({ data: { verified: false, reason: "COHORT_CONTENT_OR_BALANCE_DRIFT" }, error: null });
    await expect(caller().financialGLFixtureReview(input)).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    expect(state.rpc.mock.calls[0]).toEqual(["powerhub_financial_gl_fixture_manifest_review", {
      p_tenant_id: 1, p_site_id: 1, p_id: 33, p_reviewer_id: 777,
    }]);
  });
  it("preserves the database self-review rejection", async () => {
    state.rpc.mockResolvedValue({ data: null, error: { message: "GL_FIXTURE_SELF_REVIEW" } });
    await expect(caller().financialGLFixtureReview(input)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(state.rpc).toHaveBeenCalledTimes(1);
  });
});
