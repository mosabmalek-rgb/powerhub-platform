import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("./supabase-admin", () => ({
  supabaseAdmin: () => ({ rpc: state.rpc }),
}));

import { recordTenantSearchMetric } from "./tenant-search-telemetry";

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("tenant subscriber-search telemetry", () => {
  it("records only the server-derived tenant scope and result count", async () => {
    state.rpc.mockResolvedValue({ error: null });
    await recordTenantSearchMetric(101, 7);
    expect(state.rpc).toHaveBeenCalledWith("powerhub_record_tenant_search_metric", {
      p_tenant_id: 101,
      p_result_count: 7,
    });
  });

  it("ignores invalid scopes and counts without making an RPC", async () => {
    await recordTenantSearchMetric(0, 1);
    await recordTenantSearchMetric(101, 26);
    await recordTenantSearchMetric(101, -1);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("logs only the stable error code when telemetry fails", async () => {
    state.rpc.mockResolvedValue({ error: { code: "42501", message: "sensitive query or tenant detail" } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await recordTenantSearchMetric(101, 0);
    expect(warn).toHaveBeenCalledWith(
      "[PowerHub subscriber search] Aggregate tenant telemetry recording failed.",
      { code: "42501" },
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("sensitive query or tenant detail");
  });

  it("does not propagate transport failures to the directory request", async () => {
    state.rpc.mockRejectedValue(new Error("sensitive transport detail"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(recordTenantSearchMetric(101, 2)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith("[PowerHub subscriber search] Aggregate tenant telemetry request failed.");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("sensitive transport detail");
  });
});
