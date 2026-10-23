import { describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";

const state = vi.hoisted(() => ({
  access: vi.fn(),
  from: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("./powerhub-supabase", () => ({
  requireSupabaseSiteRole: state.access,
}));

vi.mock("./supabase-admin", () => ({
  supabaseAdmin: () => ({ from: state.from, rpc: state.rpc }),
}));

const deniedCases = [
  { procedure: "listAssignableSuppliers", capability: "manageMaintenance", input: { siteId: 7 } },
  { procedure: "reportByGenerator", capability: "viewInventoryReports", input: { siteId: 7, fromDate: "2026-10-01", toDate: "2026-10-23" } },
  { procedure: "assignSupplier", capability: "manageMaintenance", input: { siteId: 7, workOrderId: 8, supplierId: 12, operationKey: "maint:assign:01" } },
  { procedure: "evaluateDuePlans", capability: "manageMaintenance", input: { siteId: 7 } },
  { procedure: "createWorkOrder", capability: "manageMaintenance", input: { siteId: 7, generatorId: 12, orderType: "breakdown", title: "Engine failure", priority: "high", operationKey: "maint:create:01" } },
  { procedure: "addPart", capability: "manageMaintenance", input: { siteId: 7, workOrderId: 8, itemId: 4, warehouseId: 5, quantity: 1, operationKey: "maint:part:01" } },
  { procedure: "reopenCompletedWorkOrder", capability: "manageMaintenance", input: { siteId: 7, workOrderId: 8, reason: "Repeated engine failure", operationKey: "maint:reopen:01" } },
  { procedure: "transitionWorkOrder", capability: "manageMaintenance", input: { siteId: 7, workOrderId: 8, action: "start", operationKey: "maint:transition:01" } },
  { procedure: "createPreventivePlan", capability: "manageMaintenance", input: { siteId: 7, generatorId: 12, planCode: "OIL-30", title: "Periodic oil service", intervalDays: 30, nextDueAt: "2026-11-22T00:00:00.000Z", operationKey: "maint:plan:01" } },
] as const;

describe("PowerHub maintenance router capability denials", () => {
  it.each(deniedCases)(
    "denies $procedure before a database call when $capability is missing",
    async ({ procedure, capability, input }) => {
      state.from.mockClear();
      state.rpc.mockClear();
      state.access.mockReset().mockRejectedValue(new TRPCError({ code: "FORBIDDEN", message: "forbidden" }));

      const { powerhubMaintenanceRouter } = await import("./powerhub-maintenance-router");
      const route = (powerhubMaintenanceRouter as any)._def.record[procedure];

      await expect(route._def.resolver({ ctx: { user: { id: 701 } }, input }))
        .rejects.toMatchObject({ code: "FORBIDDEN" });

      expect(state.access).toHaveBeenCalledWith(701, input.siteId, expect.any(Array), capability);
      expect(state.from).not.toHaveBeenCalled();
      expect(state.rpc).not.toHaveBeenCalled();
    },
  );

  it("requires issueInventory in addition to manageMaintenance before adding a part", async () => {
    state.from.mockClear();
    state.rpc.mockClear();
    state.access.mockReset().mockResolvedValue({ tenantId: 20, permissions: ["manageMaintenance"] });

    const { powerhubMaintenanceRouter } = await import("./powerhub-maintenance-router");
    const route = (powerhubMaintenanceRouter as any)._def.record.addPart;

    await expect(route._def.resolver({
      ctx: { user: { id: 701 } },
      input: { siteId: 7, workOrderId: 8, itemId: 4, warehouseId: 5, quantity: 1, operationKey: "maint:part:02" },
    })).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(state.access).toHaveBeenCalledWith(701, 7, expect.any(Array), "manageMaintenance");
    expect(state.from).not.toHaveBeenCalled();
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it.each([
    { action: "complete", laborCost: 75 },
    { action: "correct_completion", externalServiceCost: 25 },
  ] as const)(
    "denies $action cost changes without manageExpenses",
    async ({ action, laborCost, externalServiceCost }) => {
      state.from.mockClear();
      state.rpc.mockClear();
      state.access.mockReset().mockResolvedValue({ tenantId: 20, permissions: ["manageMaintenance"] });

      const { powerhubMaintenanceRouter } = await import("./powerhub-maintenance-router");
      const route = (powerhubMaintenanceRouter as any)._def.record.transitionWorkOrder;

      await expect(route._def.resolver({
        ctx: { user: { id: 701 } },
        input: {
          siteId: 7, workOrderId: 8, action, operationKey: "maint:cost:01",
          ...(laborCost === undefined ? {} : { laborCost }),
          ...(externalServiceCost === undefined ? {} : { externalServiceCost }),
        },
      })).rejects.toMatchObject({ code: "FORBIDDEN" });

      expect(state.access).toHaveBeenCalledWith(701, 7, expect.any(Array), "manageMaintenance");
      expect(state.rpc).not.toHaveBeenCalled();
      expect(state.from).not.toHaveBeenCalled();
    },
  );
});
