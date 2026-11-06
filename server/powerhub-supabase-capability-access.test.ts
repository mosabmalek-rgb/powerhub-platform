import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  from: vi.fn(),
  requireTenantSubscription: vi.fn(),
}));

vi.mock("./supabase-admin", () => ({
  supabaseAdmin: () => ({ from: state.from }),
}));
vi.mock("./subscription-access", () => ({
  requireTenantSubscription: state.requireTenantSubscription,
}));
vi.mock("./storage", () => ({ storageGet: vi.fn() }));
vi.mock("./financial-overview-utils", () => ({ buildFinancialOverview: vi.fn() }));
vi.mock("./tenant-search-telemetry", () => ({ recordTenantSearchMetric: vi.fn() }));

type QueryResult = { data: any; error: any };

function queryBuilder(result: QueryResult) {
  const builder: Record<string, any> = {};
  builder.select = vi.fn(() => builder);
  builder.eq = vi.fn(() => builder);
  builder.or = vi.fn(() => builder);
  builder.is = vi.fn(() => builder);
  builder.maybeSingle = vi.fn(async () => result);
  builder.in = vi.fn(async () => result);
  return builder;
}

const activeUser = { role: "user", platform_role: null, account_status: "active" };
const activeSite = {
  id: 7,
  tenant_id: 44,
  name: "Staging Test Site",
  code: "STG-7",
  city: null,
  address: null,
  status: "active",
  anomaly_alert_percent: 10,
  invoice_due_days: 14,
  invoice_due_hours: 336,
  created_at: "2026-11-01T00:00:00.000Z",
  tenants: { name: "Staging Test Tenant" },
};
const activeOwnerMembership = {
  role: "owner",
  expires_at: null,
  tenant_member_capability_overrides: [],
};

describe("Supabase site capability policy resolver", () => {
  let userRow: any;
  let siteRow: any;
  let membershipRow: any;
  let policyResult: QueryResult;
  let policyQuery: ReturnType<typeof queryBuilder>;

  beforeEach(() => {
    userRow = { ...activeUser };
    siteRow = { ...activeSite };
    membershipRow = { ...activeOwnerMembership };
    policyResult = { data: [], error: null };
    policyQuery = queryBuilder(policyResult);

    state.requireTenantSubscription.mockReset().mockResolvedValue(undefined);
    state.from.mockReset().mockImplementation((table: string) => {
      if (table === "users") return queryBuilder({ data: userRow, error: null });
      if (table === "sites") return queryBuilder({ data: siteRow, error: null });
      if (table === "tenant_members") return queryBuilder({ data: membershipRow, error: null });
      if (table === "platform_role_policies") {
        policyQuery = queryBuilder(policyResult);
        return policyQuery;
      }
      throw new Error(`Unexpected Supabase table access in test: ${table}`);
    });
  });

  it("preserves default-allow behavior when no platform role policy row exists", async () => {
    const { resolveSupabaseSiteCapabilityAccess } = await import("./powerhub-supabase");

    const access = await resolveSupabaseSiteCapabilityAccess(55, 7, ["viewInventory"]);

    expect(access.allowedCapabilities).toEqual(["viewInventory"]);
    expect(policyQuery.in).toHaveBeenCalledWith("capability", ["viewInventory"]);
    expect(state.requireTenantSubscription).toHaveBeenCalledWith(44, expect.any(Date), {
      allowReadOnlyRetention: true,
    });
  });

  it("falls through to a granted alternate capability when the primary one is explicitly denied", async () => {
    policyResult = {
      data: [{ capability: "viewInventory", is_allowed: false }],
      error: null,
    };
    const { resolveSupabaseSiteCapabilityAccess } = await import("./powerhub-supabase");

    const access = await resolveSupabaseSiteCapabilityAccess(
      55,
      7,
      ["viewInventory", "viewInventoryReports"],
    );

    expect(access.allowedCapabilities).toEqual(["viewInventoryReports"]);
    expect(policyQuery.in).toHaveBeenCalledWith(
      "capability",
      ["viewInventory", "viewInventoryReports"],
    );
  });

  it("rejects when every granted alternative is explicitly denied", async () => {
    policyResult = {
      data: [
        { capability: "viewInventory", is_allowed: false },
        { capability: "viewInventoryReports", is_allowed: false },
      ],
      error: null,
    };
    const { requireSupabaseSiteAnyCapability } = await import("./powerhub-supabase");

    await expect(requireSupabaseSiteAnyCapability(
      55,
      7,
      ["viewInventory", "viewInventoryReports"],
    )).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("fails closed when the platform policy query fails", async () => {
    policyResult = { data: null, error: { message: "policy lookup failed" } };
    const { requireSupabaseSiteAnyCapability } = await import("./powerhub-supabase");

    await expect(requireSupabaseSiteAnyCapability(
      55,
      7,
      ["viewInventory"],
    )).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
  });

  it("does not query tenant role policies for an active platform administrator", async () => {
    userRow = { role: "admin", platform_role: "platform_owner", account_status: "active" };
    const { resolveSupabaseSiteCapabilityAccess } = await import("./powerhub-supabase");

    const access = await resolveSupabaseSiteCapabilityAccess(55, 7, ["viewInventory"]);

    expect(access.isPlatformAdmin).toBe(true);
    expect(access.allowedCapabilities).toEqual(["viewInventory"]);
    expect(state.from).not.toHaveBeenCalledWith("tenant_members");
    expect(state.from).not.toHaveBeenCalledWith("platform_role_policies");
  });

  it("rejects an empty capability list instead of silently authorizing it", async () => {
    const { resolveSupabaseSiteCapabilityAccess } = await import("./powerhub-supabase");

    await expect(resolveSupabaseSiteCapabilityAccess(55, 7, []))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(state.from).not.toHaveBeenCalled();
  });
});
