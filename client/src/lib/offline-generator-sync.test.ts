import { beforeEach, describe, expect, it, vi } from "vitest";

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock("@/lib/supabase", () => ({
  supabase: { rpc },
}));

describe("offline generator sync transport", () => {
  beforeEach(() => {
    rpc.mockReset();
  });

  it("maps create input to the authenticated sync RPC and preserves replay flag", async () => {
    rpc.mockResolvedValueOnce({
      data: [{ id: "41", name: "Generator A", replayed: true }],
      error: null,
    });

    const { syncGeneratorCreate } = await import("./offline-generator-sync");
    const result = await syncGeneratorCreate({
      siteId: 7,
      code: "GEN-01",
      name: "Generator A",
      serialNumber: "SN-01",
      ratedCapacityKw: "125.500",
      fuelType: "diesel",
      clientOperationId: "op-create-1",
    });

    expect(rpc).toHaveBeenCalledWith("powerhub_sync_generator_create", {
      p_site_id: 7,
      p_code: "GEN-01",
      p_name: "Generator A",
      p_serial_number: "SN-01",
      p_rated_capacity_kw: "125.500",
      p_fuel_type: "diesel",
      p_client_operation_id: "op-create-1",
    });
    expect(result).toEqual({ id: 41, name: "Generator A", replayed: true });
  });

  it("maps update input and converts updated_at to a Date", async () => {
    rpc.mockResolvedValueOnce({
      data: [{ id: 41, name: "Generator A2", updated_at: "2026-09-09T18:00:00.000Z", replayed: false }],
      error: null,
    });

    const { syncGeneratorUpdate } = await import("./offline-generator-sync");
    const result = await syncGeneratorUpdate({
      siteId: 7,
      generatorId: 41,
      name: "Generator A2",
      ratedCapacityKw: "130",
      fuelLevelLiters: "72.5",
      operatingHours: "1040.25",
      status: "active",
      expectedUpdatedAt: "2026-09-09T17:00:00.000Z",
      clientOperationId: "op-update-1",
    });

    expect(rpc).toHaveBeenCalledWith("powerhub_sync_generator_update", {
      p_site_id: 7,
      p_generator_id: 41,
      p_name: "Generator A2",
      p_rated_capacity_kw: "130",
      p_fuel_level_liters: "72.5",
      p_operating_hours: "1040.25",
      p_status: "active",
      p_expected_updated_at: "2026-09-09T17:00:00.000Z",
      p_client_operation_id: "op-update-1",
    });
    expect(result.id).toBe(41);
    expect(result.name).toBe("Generator A2");
    expect(result.replayed).toBe(false);
    expect(result.updatedAt).toEqual(new Date("2026-09-09T18:00:00.000Z"));
  });

  it.each([
    ["GENERATOR_VERSION_CONFLICT: stale", "CONFLICT"],
    ["GENERATOR_MANAGEMENT_FORBIDDEN", "FORBIDDEN"],
    ["GENERATOR_OUT_OF_SCOPE", "NOT_FOUND"],
    ["SITE_OUT_OF_SCOPE", "NOT_FOUND"],
  ])("classifies %s without treating it as a generic success", async (message, expectedCode) => {
    rpc.mockResolvedValueOnce({ data: null, error: { message } });

    const { syncGeneratorUpdate } = await import("./offline-generator-sync");
    await expect(
      syncGeneratorUpdate({
        siteId: 7,
        generatorId: 41,
        name: "Generator A2",
        ratedCapacityKw: "130",
        fuelLevelLiters: "72.5",
        operatingHours: "1040.25",
        status: "active",
        expectedUpdatedAt: "2026-09-09T17:00:00.000Z",
        clientOperationId: `op-${expectedCode}`,
      }),
    ).rejects.toMatchObject({ data: { code: expectedCode } });
  });

  it("rejects an empty RPC response instead of marking the operation applied", async () => {
    rpc.mockResolvedValueOnce({ data: [], error: null });

    const { syncGeneratorCreate } = await import("./offline-generator-sync");
    await expect(
      syncGeneratorCreate({
        siteId: 7,
        code: "GEN-01",
        name: "Generator A",
        ratedCapacityKw: "125",
        fuelType: "diesel",
        clientOperationId: "op-empty",
      }),
    ).rejects.toThrow("تعذر إتمام مزامنة إنشاء المولد.");
  });
});
