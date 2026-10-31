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
  { procedure: "listGenerators", capability: "viewInventory", input: { siteId: 7 } },
  { procedure: "listWorkOrders", capability: "viewInventory", input: { siteId: 7 } },
  { procedure: "listPreventivePlans", capability: "viewInventory", input: { siteId: 7 } },
  { procedure: "listParts", capability: "viewInventory", input: { siteId: 7, workOrderId: 8 } },
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

  it("denies every maintenance read route before querying when neither inventory view nor maintenance access is granted", async () => {
    const readCases = [
      { procedure: "listGenerators", input: { siteId: 7 } },
      { procedure: "listWorkOrders", input: { siteId: 7 } },
      { procedure: "listPreventivePlans", input: { siteId: 7 } },
      { procedure: "listParts", input: { siteId: 7, workOrderId: 8 } },
    ] as const;

    for (const { procedure, input } of readCases) {
      state.from.mockClear();
      state.rpc.mockClear();
      state.access.mockReset().mockRejectedValue(new TRPCError({ code: "FORBIDDEN", message: "forbidden" }));

      const { powerhubMaintenanceRouter } = await import("./powerhub-maintenance-router");
      const route = (powerhubMaintenanceRouter as any)._def.record[procedure];

      await expect(route._def.resolver({ ctx: { user: { id: 701 } }, input }))
        .rejects.toMatchObject({ code: "FORBIDDEN" });

      expect(state.access).toHaveBeenNthCalledWith(1, 701, input.siteId, expect.any(Array), "viewInventory");
      expect(state.access).toHaveBeenNthCalledWith(2, 701, input.siteId, expect.any(Array), "manageMaintenance");
      expect(state.from).not.toHaveBeenCalled();
      expect(state.rpc).not.toHaveBeenCalled();
    }
  });

  it("tracks every maintenance mutation in the primary capability-denial matrix", () => {
    const routerSource = readFileSync(resolve(process.cwd(), "server/powerhub-maintenance-router.ts"), "utf8");
    const declarations = [...routerSource.matchAll(/^  ([A-Za-z_][A-Za-z0-9_]*): authenticatedProcedure/gm)];
    const mutationProcedures = declarations.filter((declaration, index) => {
      const end = declarations[index + 1]?.index ?? routerSource.length;
      return routerSource.slice(declaration.index, end).includes(".mutation(");
    }).map((declaration) => declaration[1]).sort();
    const deniedMutationProcedures = deniedCases
      .filter((entry) => mutationProcedures.includes(entry.procedure))
      .map((entry) => entry.procedure)
      .sort();

    expect(new Set(deniedMutationProcedures).size).toBe(deniedMutationProcedures.length);
    expect(deniedMutationProcedures).toEqual(mutationProcedures);
    expect(deniedCases.some((entry) => entry.procedure === "addPart" && entry.capability === "manageMaintenance")).toBe(true);
    expect(deniedCases.some((entry) => entry.procedure === "transitionWorkOrder" && entry.capability === "manageMaintenance")).toBe(true);
  });

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
  it("tracks the secondary permissions that gate stock issue and maintenance cost posting", () => {
    const testSource = readFileSync(resolve(process.cwd(), "server/powerhub-maintenance-router.test.ts"), "utf8");
    const routerSource = readFileSync(resolve(process.cwd(), "server/powerhub-maintenance-router.ts"), "utf8");
    expect(routerSource).toContain('!access.permissions.includes("issueInventory")');
    expect(routerSource).toContain('!access.permissions.includes("manageExpenses")');
    expect(testSource).toContain("requires issueInventory in addition to manageMaintenance before adding a part");
    expect(testSource).toContain("denies $action cost changes without manageExpenses");
    expect(testSource).toContain('{ action: "complete", laborCost: 75 }');
    expect(testSource).toContain('{ action: "correct_completion", externalServiceCost: 25 }');
  });

});
