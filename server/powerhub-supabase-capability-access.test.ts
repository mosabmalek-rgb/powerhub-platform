import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  rpc: vi.fn(),
  user: { role: "user", platform_role: null as string | null, account_status: "active" },
  member: { role: "owner", expires_at: null as string | null, is_active: true, membership_status: "active" },
  subscription: { status: "active", ends_at: "2100-01-01T00:00:00Z", read_only_until: null },
  policy: [] as { role: string; capability: string; is_allowed: boolean }[],
  rpcError: null as { message: string } | null,
}));

vi.mock("./supabase-admin", () => ({ supabaseAdmin: () => ({ rpc: state.rpc }) }));
vi.mock("./storage", () => ({ storageGet: vi.fn() }));
vi.mock("./financial-overview-utils", () => ({ buildFinancialOverview: vi.fn() }));
vi.mock("./tenant-search-telemetry", () => ({ recordTenantSearchMetric: vi.fn() }));

describe("B5.20 one-RPC fresh tenant/site authorization", () => {
  beforeEach(() => {
    state.user = { role: "user", platform_role: null, account_status: "active" };
    state.member = { role: "owner", expires_at: null, is_active: true, membership_status: "active" };
    state.subscription = { status: "active", ends_at: "2100-01-01T00:00:00Z", read_only_until: null };
    state.policy = [];
    state.rpcError = null;
    state.rpc.mockReset().mockImplementation(async (name: string, args: { p_user_id: number; p_site_id: number }) => {
      if (name !== "powerhub_site_access_snapshot") throw new Error("Unexpected RPC: " + name);
      return { data: state.rpcError ? null : {
        user: { ...state.user },
        site: args.p_site_id === 7 ? { tenant_id: 44, status: "active", invoice_due_days: 14, invoice_due_hours: 336 } : null,
        membership: { ...state.member }, subscription: { ...state.subscription },
        member_overrides: [], staff_profiles: [], staff_overrides: [], custom_roles: [],
        role_policies: state.policy.map((row) => ({ ...row })),
      }, error: state.rpcError };
    });
  });

  it("permits an owner by default and makes only one network authorization call", async () => {
    const { resolveSupabaseSiteCapabilityAccess } = await import("./powerhub-supabase");
    const access = await resolveSupabaseSiteCapabilityAccess(55, 7, ["viewInventory"]);
    expect(access.allowedCapabilities).toEqual(["viewInventory"]);
    expect(state.rpc).toHaveBeenCalledOnce();
    expect(state.rpc).toHaveBeenCalledWith("powerhub_site_access_snapshot", {
      p_user_id: 55, p_site_id: 7,
    });
  });

  it("rejects the denied ability but retains the independently allowed alternative", async () => {
    state.policy = [{ role: "owner", capability: "viewInventory", is_allowed: false }];
    const { resolveSupabaseSiteCapabilityAccess } = await import("./powerhub-supabase");
    const access = await resolveSupabaseSiteCapabilityAccess(55, 7, ["viewInventory", "viewInventoryReports"]);
    expect(access.allowedCapabilities).toEqual(["viewInventoryReports"]);
    expect(state.rpc).toHaveBeenCalledTimes(1);
  });

  it("rejects all capabilities denied by platform policy", async () => {
    state.policy = [
      { role: "owner", capability: "viewInventory", is_allowed: false },
      { role: "owner", capability: "viewInventoryReports", is_allowed: false },
    ];
    const { requireSupabaseSiteAnyCapability } = await import("./powerhub-supabase");
    await expect(requireSupabaseSiteAnyCapability(55, 7, ["viewInventory", "viewInventoryReports"]))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("fails closed when the fresh RPC fails", async () => {
    state.rpcError = { message: "policy lookup failed" };
    const { requireSupabaseSiteAnyCapability } = await import("./powerhub-supabase");
    await expect(requireSupabaseSiteAnyCapability(55, 7, ["viewInventory"]))
      .rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
  });

  it("keeps the active platform-administrator boundary", async () => {
    state.user = { role: "admin", platform_role: "platform_owner", account_status: "active" };
    const { resolveSupabaseSiteCapabilityAccess } = await import("./powerhub-supabase");
    const access = await resolveSupabaseSiteCapabilityAccess(55, 7, ["viewInventory"]);
    expect(access.isPlatformAdmin).toBe(true);
    expect(access.allowedCapabilities).toEqual(["viewInventory"]);
    expect(state.rpc).toHaveBeenCalledOnce();
  });

  it("rejects disabled user, expired membership and disabled subscription immediately", async () => {
    const { resolveSupabaseSiteCapabilityAccess } = await import("./powerhub-supabase");
    state.user.account_status = "disabled";
    await expect(resolveSupabaseSiteCapabilityAccess(55, 7, ["viewInventory"]))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    state.user.account_status = "active";
    state.member.expires_at = "2000-01-01T00:00:00Z";
    await expect(resolveSupabaseSiteCapabilityAccess(55, 7, ["viewInventory"]))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    state.member.expires_at = null;
    state.subscription.status = "suspended";
    await expect(resolveSupabaseSiteCapabilityAccess(55, 7, ["viewInventory"]))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(state.rpc).toHaveBeenCalledTimes(3);
  });

  it("reads newly revoked capability on the very next request, without a rights cache", async () => {
    const { resolveSupabaseSiteCapabilityAccess } = await import("./powerhub-supabase");
    const first = await resolveSupabaseSiteCapabilityAccess(55, 7, ["viewInventory"]);
    expect(first.allowedCapabilities).toEqual(["viewInventory"]);
    state.policy = [{ role: "owner", capability: "viewInventory", is_allowed: false }];
    const next = await resolveSupabaseSiteCapabilityAccess(55, 7, ["viewInventory"]);
    expect(next.allowedCapabilities).toEqual([]);
    expect(state.rpc).toHaveBeenCalledTimes(2);
  });

  it("rejects an empty capability list without calling the database", async () => {
    const { resolveSupabaseSiteCapabilityAccess } = await import("./powerhub-supabase");
    await expect(resolveSupabaseSiteCapabilityAccess(55, 7, []))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(state.rpc).not.toHaveBeenCalled();
  });
});
