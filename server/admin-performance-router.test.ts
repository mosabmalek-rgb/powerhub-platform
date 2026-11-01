import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("./supabase-admin", () => ({
  supabaseAdmin: () => ({ rpc: state.rpc }),
}));

import { adminPerformanceRouter } from "./admin-performance-router";

const baseUser = {
  id: 7,
  openId: "platform-admin",
  name: "Platform Admin",
  email: "admin@example.test",
  loginMethod: "supabase",
  role: "admin" as const,
  platformRole: "platform_admin",
  accountStatus: "active",
  createdAt: new Date(),
  updatedAt: new Date(),
  lastSignedIn: new Date(),
};

const metrics = {
  generatedAt: "2026-11-02T10:00:00.000Z",
  database: { name: "powerhub", sizeBytes: 1024, sizeMiB: 0.01 },
  connections: { clientBackends: 2, active: 1, idleInTransaction: 0, maxConnections: 60 },
  cacheHitRatioPercent: 99.5,
  transactions: { commits: 100, rollbacks: 2, deadlocks: 0, tempFiles: 1, tempBytes: 4096, statsResetAt: null },
  topTables: [{
    schemaName: "public",
    tableName: "subscribers",
    totalBytes: 8192,
    indexBytes: 2048,
    liveRowsEstimate: 20,
    deadRowsEstimate: 1,
  }],
};

afterEach(() => vi.clearAllMocks());

describe("platform performance metrics authorization and contract", () => {
  it("rejects tenant users before calling the service-role RPC", async () => {
    const caller = adminPerformanceRouter.createCaller({
      user: { ...baseUser, role: "user", platformRole: null },
      req: {} as never,
      res: {} as never,
    });
    await expect(caller.performanceMetrics()).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("rejects finance and support platform roles from infrastructure metrics", async () => {
    for (const platformRole of ["finance_admin", "platform_support"] as const) {
      const caller = adminPerformanceRouter.createCaller({
        user: { ...baseUser, platformRole },
        req: {} as never,
        res: {} as never,
      });
      await expect(caller.performanceMetrics()).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("returns schema-validated metrics only to an active platform admin", async () => {
    state.rpc.mockResolvedValue({ data: metrics, error: null });
    const caller = adminPerformanceRouter.createCaller({
      user: baseUser,
      req: {} as never,
      res: {} as never,
    });
    await expect(caller.performanceMetrics()).resolves.toEqual(metrics);
    expect(state.rpc).toHaveBeenCalledWith("powerhub_admin_get_performance_metrics");
  });

  it("fails closed when the RPC is missing or returns an invalid payload", async () => {
    state.rpc
      .mockResolvedValueOnce({ data: null, error: { message: "function not found" } })
      .mockResolvedValueOnce({ data: { ...metrics, connections: null }, error: null });
    const caller = adminPerformanceRouter.createCaller({
      user: baseUser,
      req: {} as never,
      res: {} as never,
    });
    await expect(caller.performanceMetrics()).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    await expect(caller.performanceMetrics()).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
  });
});
