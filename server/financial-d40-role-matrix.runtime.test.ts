import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

// D40: behavioral authorization tests of the real site-access resolver.
// Only the service-role snapshot transport is mocked; no auth token, device
// claim, RLS policy or live PostgreSQL result is impersonated.
const state = vi.hoisted(() => ({
  rpc: vi.fn(),
  snapshots: new Map<number, any>(),
  error: null as { message: string } | null,
}));
vi.mock("./supabase-admin", () => ({ supabaseAdmin: () => ({ rpc: state.rpc }) }));
vi.mock("./storage", () => ({ storageGet: vi.fn() }));
vi.mock("./financial-overview-utils", () => ({ buildFinancialOverview: vi.fn() }));
vi.mock("./tenant-search-telemetry", () => ({ recordTenantSearchMetric: vi.fn() }));

const reportRoles = ["owner", "manager", "accountant", "viewer"] as const;
const reportCapability = "viewFinancialReports" as const;
const future = "2100-01-01T00:00:00.000Z";

function snapshot(tenantId: number, role = "accountant", profileSite: number | null = 7) {
  return {
    user: { role: "user", platform_role: null as string | null, account_status: "active" },
    site: { tenant_id: tenantId, status: "active", invoice_due_days: 14, invoice_due_hours: 336 },
    membership: { role: "member", is_active: true, membership_status: "active", expires_at: null },
    subscription: { status: "active", ends_at: future, read_only_until: null },
    member_overrides: [] as any[],
    staff_profiles: [{
      id: 701, site_id: profileSite, role, permissions: null as string[] | null,
      custom_role_id: null as number | null,
      suspension_started_at: null as string | null, suspension_ends_at: null as string | null,
    }],
    staff_overrides: [] as any[],
    custom_roles: [] as any[],
    role_policies: [] as any[],
  };
}

async function financialRead(siteId: number, userId = 55) {
  const { requireSupabaseSiteRole } = await import("./powerhub-supabase");
  return requireSupabaseSiteRole(userId, siteId, [...reportRoles], reportCapability);
}

describe("D40 financial-report role/capability matrix — code execution", () => {
  beforeEach(() => {
    state.snapshots.clear();
    state.error = null;
    state.snapshots.set(7, snapshot(44));
    state.rpc.mockReset().mockImplementation(async (
      name: string, args: { p_user_id: number; p_site_id: number },
    ) => {
      if (name !== "powerhub_site_access_snapshot") throw new Error("UNEXPECTED_AUTH_RPC");
      const value = state.snapshots.get(args.p_site_id);
      return { data: state.error ? null : (value ? structuredClone(value) : null), error: state.error };
    });
  });

  it("grants a real accountant role only for the assigned site and fetches a fresh snapshot", async () => {
    const access = await financialRead(7);
    expect(access).toMatchObject({ role: "accountant", tenantId: 44 });
    expect(access.permissions).toContain(reportCapability);
    expect(state.rpc).toHaveBeenCalledOnce();
    expect(state.rpc).toHaveBeenCalledWith(
      "powerhub_site_access_snapshot", { p_user_id: 55, p_site_id: 7 },
    );
  });

  it("denies a branch-restricted accountant at another branch of the SAME tenant and a foreign tenant", async () => {
    const anotherBranch = snapshot(44);
    anotherBranch.staff_profiles = [];
    state.snapshots.set(8, anotherBranch);
    const foreignTenant = snapshot(88);
    foreignTenant.membership = null as any;
    foreignTenant.staff_profiles = [];
    state.snapshots.set(9, foreignTenant);

    await expect(financialRead(7)).resolves.toMatchObject({ tenantId: 44 });
    await expect(financialRead(8)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(financialRead(9)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(state.rpc).toHaveBeenCalledTimes(3);
    expect(state.rpc).toHaveBeenNthCalledWith(2,
      "powerhub_site_access_snapshot", { p_user_id: 55, p_site_id: 8 });
    expect(state.rpc).toHaveBeenNthCalledWith(3,
      "powerhub_site_access_snapshot", { p_user_id: 55, p_site_id: 9 });
  });

  it("permits an explicitly tenant-wide accountant assignment only across its own tenant", async () => {
    state.snapshots.set(7, snapshot(44, "accountant", null));
    state.snapshots.set(8, snapshot(44, "accountant", null));
    const foreign = snapshot(88, "accountant", null);
    foreign.membership = null as any;
    foreign.staff_profiles = [];
    state.snapshots.set(9, foreign);
    await expect(financialRead(7)).resolves.toMatchObject({ tenantId: 44 });
    await expect(financialRead(8)).resolves.toMatchObject({ tenantId: 44 });
    await expect(financialRead(9)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("does not give viewers or collectors financial data without an explicit grant", async () => {
    state.snapshots.set(7, snapshot(44, "viewer"));
    await expect(financialRead(7)).rejects.toMatchObject({ code: "FORBIDDEN" });
    state.snapshots.set(7, snapshot(44, "collector"));
    await expect(financialRead(7)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(state.rpc).toHaveBeenCalledTimes(2);
  });

  it("honors an explicit viewer grant and then rejects its removal on the next request", async () => {
    const viewer = snapshot(44, "viewer");
    viewer.staff_profiles[0].permissions = [reportCapability];
    state.snapshots.set(7, viewer);
    await expect(financialRead(7)).resolves.toMatchObject({ role: "viewer" });
    viewer.staff_profiles[0].permissions = [];
    await expect(financialRead(7)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(state.rpc).toHaveBeenCalledTimes(2);
  });

  it("treats an explicit empty accountant permission list as a denial (no role-default fallback)", async () => {
    const accountant = snapshot(44);
    accountant.staff_profiles[0].permissions = [];
    state.snapshots.set(7, accountant);
    await expect(financialRead(7)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("checks live custom-role permissions and immediately refuses deactivation/revocation", async () => {
    const accountant = snapshot(44);
    accountant.staff_profiles[0].custom_role_id = 99;
    accountant.custom_roles = [{ id: 99, permissions: [reportCapability] }];
    state.snapshots.set(7, accountant);
    await expect(financialRead(7)).resolves.toMatchObject({ tenantId: 44 });
    accountant.custom_roles = []; // inactive/missing role no longer in service-role snapshot
    await expect(financialRead(7)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(state.rpc).toHaveBeenCalledTimes(2);
  });

  it("applies staff-level DENY even to an accountant and platform policy DENY after restoration", async () => {
    const accountant = snapshot(44);
    accountant.staff_overrides = [{ profile_id: 701, capability: reportCapability, is_allowed: false }];
    state.snapshots.set(7, accountant);
    await expect(financialRead(7)).rejects.toMatchObject({ code: "FORBIDDEN" });
    accountant.staff_overrides = [];
    await expect(financialRead(7)).resolves.toMatchObject({ tenantId: 44 });
    accountant.role_policies = [{ role: "accountant", capability: reportCapability, is_allowed: false }];
    await expect(financialRead(7)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(state.rpc).toHaveBeenCalledTimes(3);
  });

  it("does not exempt a tenant owner from a financial capability override or deny policy", async () => {
    const owner = snapshot(44);
    owner.membership.role = "owner";
    owner.staff_profiles = [];
    owner.member_overrides = [{ capability: reportCapability, is_allowed: false }];
    state.snapshots.set(7, owner);
    await expect(financialRead(7)).rejects.toMatchObject({ code: "FORBIDDEN" });
    owner.member_overrides = [];
    await expect(financialRead(7)).resolves.toMatchObject({ role: "owner" });
    owner.role_policies = [{ role: "owner", capability: reportCapability, is_allowed: false }];
    await expect(financialRead(7)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("denies a suspended staff profile, expired membership and inactive tenant subscription", async () => {
    const a = snapshot(44);
    a.staff_profiles[0].suspension_started_at = "2000-01-01T00:00:00.000Z";
    a.staff_profiles[0].suspension_ends_at = future;
    state.snapshots.set(7, a);
    await expect(financialRead(7)).rejects.toMatchObject({ code: "FORBIDDEN" });
    a.staff_profiles[0].suspension_started_at = null;
    a.staff_profiles[0].suspension_ends_at = null;
    a.membership.expires_at = "2000-01-01T00:00:00.000Z";
    await expect(financialRead(7)).rejects.toMatchObject({ code: "FORBIDDEN" });
    a.membership.expires_at = null;
    a.subscription.status = "suspended";
    await expect(financialRead(7)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(state.rpc).toHaveBeenCalledTimes(3);
  });

  it("rejects a disabled identity and a support-role admin without tenant membership", async () => {
    const a = snapshot(44);
    a.user.account_status = "disabled";
    state.snapshots.set(7, a);
    await expect(financialRead(7)).rejects.toMatchObject({ code: "FORBIDDEN" });
    a.user.account_status = "active";
    a.user.role = "admin";
    a.user.platform_role = "platform_support";
    a.membership = null as any;
    a.staff_profiles = [];
    await expect(financialRead(7)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("fails closed on a malformed snapshot and service RPC error, never inventing report access", async () => {
    state.snapshots.set(7, { user: { role: "user", account_status: "active" }, site: null });
    await expect(financialRead(7)).rejects.toMatchObject({ code: "NOT_FOUND" });
    state.error = { message: "snapshot unavailable" };
    await expect(financialRead(7)).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    expect(state.rpc).toHaveBeenCalledTimes(2);
  });

  it("does not coalesce two independent authorization calls or share a revoked result", async () => {
    const { requireSupabaseSiteRole } = await import("./powerhub-supabase");
    const allowed = snapshot(44);
    const denied = snapshot(44);
    denied.staff_overrides = [{ profile_id: 701, capability: reportCapability, is_allowed: false }];
    state.rpc.mockReset()
      .mockResolvedValueOnce({ data: allowed, error: null })
      .mockResolvedValueOnce({ data: denied, error: null });
    const requests = await Promise.allSettled([
      requireSupabaseSiteRole(55, 7, [...reportRoles], reportCapability),
      requireSupabaseSiteRole(55, 7, [...reportRoles], reportCapability),
    ]);
    expect(requests[0].status).toBe("fulfilled");
    expect(requests[1].status).toBe("rejected");
    if (requests[1].status === "rejected")
      expect(requests[1].reason).toMatchObject({ code: "FORBIDDEN" });
    expect(state.rpc).toHaveBeenCalledTimes(2);
  });
});

describe("E48 permission-only approval and tenant/site isolation — code execution", () => {
  beforeEach(() => {
    state.snapshots.clear();
    state.error = null;
    const base = snapshot(44, "accountant");
    base.staff_profiles[0].permissions = ["approvePaymentDocumentation"];
    state.snapshots.set(7, base);
    state.rpc.mockReset().mockImplementation(async (
      name: string, args: { p_user_id: number; p_site_id: number },
    ) => {
      if (name !== "powerhub_site_access_snapshot") throw new Error("UNEXPECTED_AUTH_RPC");
      const value = state.snapshots.get(args.p_site_id);
      return { data: state.error ? null : (value ? structuredClone(value) : null), error: state.error };
    });
  });

  const approveOnly = async (siteId: number) => {
    const { requireSupabaseSiteRole } = await import("./powerhub-supabase");
    return requireSupabaseSiteRole(55, siteId, [], "approvePaymentDocumentation");
  };
  const collect = async (siteId: number) => {
    const { requireSupabaseSiteRole } = await import("./powerhub-supabase");
    return requireSupabaseSiteRole(55, siteId, [], "collectPayments");
  };

  it("permits approval without enabling collection or inheriting accountant defaults", async () => {
    await expect(approveOnly(7)).resolves.toMatchObject({ role: "accountant", tenantId: 44 });
    await expect(collect(7)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(state.rpc).toHaveBeenCalledTimes(2);
  });

  it("denies the assigned staff on sibling and foreign tenant branches", async () => {
    const sibling = snapshot(44);
    sibling.staff_profiles = [];
    state.snapshots.set(8, sibling);
    const foreign = snapshot(88);
    foreign.staff_profiles = [];
    foreign.membership = null as any;
    state.snapshots.set(9, foreign);
    await expect(approveOnly(7)).resolves.toMatchObject({ tenantId: 44 });
    await expect(approveOnly(8)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(approveOnly(9)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("allows an explicitly tenant-wide profile within its tenant, not outside", async () => {
    const withinTenant = snapshot(44);
    withinTenant.staff_profiles[0].site_id = null;
    withinTenant.staff_profiles[0].permissions = ["approvePaymentDocumentation"];
    state.snapshots.set(7, withinTenant);
    state.snapshots.set(8, structuredClone(withinTenant));
    const foreign = snapshot(88);
    foreign.staff_profiles = [];
    foreign.membership = null as any;
    state.snapshots.set(9, foreign);
    await expect(approveOnly(7)).resolves.toMatchObject({ tenantId: 44 });
    await expect(approveOnly(8)).resolves.toMatchObject({ tenantId: 44 });
    await expect(approveOnly(9)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("observes revocation on the next request and never reconstructs the role defaults", async () => {
    await expect(approveOnly(7)).resolves.toMatchObject({ role: "accountant" });
    const revoked = state.snapshots.get(7);
    revoked.staff_profiles[0].permissions = [];
    await expect(approveOnly(7)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(state.rpc).toHaveBeenCalledTimes(2);
  });

  it("fails closed on a snapshot transport error, not stale approval grants", async () => {
    await expect(approveOnly(7)).resolves.toMatchObject({ tenantId: 44 });
    state.error = { message: "RPC unavailable" };
    await expect(approveOnly(7)).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    expect(state.rpc).toHaveBeenCalledTimes(2);
  });
});

describe("E48 payment-documentation route contract — code inspection, not HTTPS", () => {
  const source = readFileSync("server/powerhub.ts", "utf8");
  const paymentRoutes = source.slice(source.indexOf("  paymentDocumentation: router({"));
  it.each(["recipientAccounts", "list", "revision", "approve", "receiptUrl", "reject"])(
    "%s checks the approval capability before accessing private data or service-role RPCs",
    (name) => {
      const start = paymentRoutes.indexOf(name + ": protectedProcedure");
      expect(start, name).toBeGreaterThan(-1);
      const route = paymentRoutes.slice(start, start + 1400);
      expect(route).toContain("requireSupabaseSiteRole(ctx.user.id, input.siteId, [], \"approvePaymentDocumentation\")");
    },
  );
  it("requires collection rights for submitting documentation, not merely approval rights", () => {
    const start = paymentRoutes.indexOf("submit: protectedProcedure");
    expect(start).toBeGreaterThan(-1);
    const route = paymentRoutes.slice(start, start + 1200);
    expect(route).toContain('requireSupabaseSiteRole(ctx.user.id, input.siteId, recordRoles, "collectPayments")');
    expect(route).not.toContain('requireSupabaseSiteRole(ctx.user.id, input.siteId, [], "approvePaymentDocumentation")');
  });
});

describe("D40 HTTP financial route guards — source contract, not live HTTPS", () => {
  const source = readFileSync("server/powerhub.ts", "utf8");
  it.each([
    "accrualCloseReadiness",
    "financialGLTrialBalance",
    "financialGLSiteStatements",
    "financialGLSubledgerReconciliation",
    "financialGLCompanyMovementAudit",
  ])("%s authorizes site and financial capability before a service-role RPC", (name) => {
    const start = source.indexOf(name + ": protectedProcedure");
    expect(start).toBeGreaterThan(-1);
    const beforeRpc = source.slice(start, start + 550);
    expect(beforeRpc).toContain("requireSupabaseSiteRole(ctx.user.id,input.siteId,");
    expect(beforeRpc).toContain('"viewFinancialReports"');
    expect(beforeRpc).not.toContain("input.tenantId");
  });
});
