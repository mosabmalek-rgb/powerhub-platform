import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TRPCError } from "@trpc/server";

const state = vi.hoisted(() => ({
  access: vi.fn(),
  capabilityAccess: vi.fn(),
  from: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("./powerhub-supabase", () => ({
  requireSupabaseSiteRole: state.access,
  resolveSupabaseSiteCapabilityAccess: state.capabilityAccess,
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
      state.capabilityAccess.mockReset().mockResolvedValue({ tenantId: 20, allowedCapabilities: [] });

      const { powerhubMaintenanceRouter } = await import("./powerhub-maintenance-router");
      const route = (powerhubMaintenanceRouter as any)._def.record[procedure];

      await expect(route._def.resolver({ ctx: { user: { id: 701 } }, input }))
        .rejects.toMatchObject({ code: "FORBIDDEN" });

      const usesEffectivePolicy = [
        "listGenerators", "listWorkOrders", "listPreventivePlans", "listParts", "addPart", "transitionWorkOrder",
      ].includes(procedure);
      if (usesEffectivePolicy) {
        expect(state.capabilityAccess).toHaveBeenCalledWith(701, input.siteId, expect.arrayContaining([capability]));
        expect(state.access).not.toHaveBeenCalled();
      } else {
        expect(state.access).toHaveBeenCalledWith(701, input.siteId, expect.any(Array), capability);
        expect(state.capabilityAccess).not.toHaveBeenCalled();
      }
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
      state.access.mockReset();
      state.capabilityAccess.mockReset().mockResolvedValue({ tenantId: 20, allowedCapabilities: [] });

      const { powerhubMaintenanceRouter } = await import("./powerhub-maintenance-router");
      const route = (powerhubMaintenanceRouter as any)._def.record[procedure];

      await expect(route._def.resolver({ ctx: { user: { id: 701 } }, input }))
        .rejects.toMatchObject({ code: "FORBIDDEN" });

      expect(state.capabilityAccess).toHaveBeenCalledWith(701, input.siteId, [
        "viewInventory", "manageMaintenance", "viewInventoryReports", "manageExpenses",
      ]);
      expect(state.access).not.toHaveBeenCalled();
      expect(state.from).not.toHaveBeenCalled();
      expect(state.rpc).not.toHaveBeenCalled();
    }
  });

  it("tracks every maintenance mutation in the primary capability-denial matrix", () => {
    const routerSource = readFileSync(resolve(process.cwd(), "server/powerhub-maintenance-router.ts"), "utf8");
    const declarations = [...routerSource.matchAll(/^  ([A-Za-z_][A-Za-z0-9_]*): protectedProcedure/gm)];
    expect(routerSource).toContain('import { router, protectedProcedure } from "./_core/trpc";');
    expect(routerSource).not.toContain("authenticatedProcedure");
    expect(routerSource.match(/: protectedProcedure/g)?.length).toBe(13);

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
    state.access.mockReset();
    state.capabilityAccess.mockReset().mockResolvedValue({
      tenantId: 20, allowedCapabilities: ["manageMaintenance"],
    });

    const { powerhubMaintenanceRouter } = await import("./powerhub-maintenance-router");
    const route = (powerhubMaintenanceRouter as any)._def.record.addPart;

    await expect(route._def.resolver({
      ctx: { user: { id: 701 } },
      input: { siteId: 7, workOrderId: 8, itemId: 4, warehouseId: 5, quantity: 1, operationKey: "maint:part:02" },
    })).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(state.capabilityAccess).toHaveBeenCalledWith(701, 7, [
      "manageMaintenance", "issueInventory", "viewInventoryReports", "manageExpenses",
    ]);
    expect(state.access).not.toHaveBeenCalled();
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
      state.access.mockReset();
      state.capabilityAccess.mockReset().mockResolvedValue({
        tenantId: 20, allowedCapabilities: ["manageMaintenance"],
      });

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

      expect(state.capabilityAccess).toHaveBeenCalledWith(701, 7, [
        "manageMaintenance", "issueInventory", "viewInventoryReports", "manageExpenses",
      ]);
      expect(state.access).not.toHaveBeenCalled();
      expect(state.rpc).not.toHaveBeenCalled();
      expect(state.from).not.toHaveBeenCalled();
    },
  ); 
  it("tracks the secondary permissions that gate stock issue and maintenance cost posting", () => {
    const testSource = readFileSync(resolve(process.cwd(), "server/powerhub-maintenance-router.test.ts"), "utf8");
    const routerSource = readFileSync(resolve(process.cwd(), "server/powerhub-maintenance-router.ts"), "utf8");
    expect(routerSource).toContain('!access.allowedCapabilities.includes("issueInventory")');
    expect(routerSource).toContain('!access.allowedCapabilities.includes("manageExpenses")');
    expect(testSource).toContain("requires issueInventory in addition to manageMaintenance before adding a part");
    expect(testSource).toContain("denies $action cost changes without manageExpenses");
    expect(testSource).toContain('{ action: "complete", laborCost: 75 }');
    expect(testSource).toContain('{ action: "correct_completion", externalServiceCost: 25 }');
  });

});

describe("maintenance compound RPC rollback retry", () => {
  const input = { siteId: 7, workOrderId: 8, itemId: 4, warehouseId: 5, quantity: 2, operationKey: "maint:stable-retry" };

  it("retries the complete scoped part issue and preserves cost redaction", async () => {
    state.capabilityAccess.mockReset().mockResolvedValue({
      tenantId: 20, allowedCapabilities: ["manageMaintenance", "issueInventory"],
    });
    state.rpc.mockReset().mockResolvedValueOnce({ data: null, error: { code: "40P01", message: "deadlock detected" } })
      .mockResolvedValueOnce({ data: [{ part_id: 90, stock_movement_id: 91, quantity: 2, unit_cost: 3, total_cost_amount: 6, replayed: false }], error: null });
    const { powerhubMaintenanceRouter } = await import("./powerhub-maintenance-router");
    const route = (powerhubMaintenanceRouter as any)._def.record.addPart;
    const result = await route._def.resolver({ ctx: { user: { id: 701 } }, input });
    expect(state.rpc).toHaveBeenCalledTimes(2);
    const args = { p_tenant_id: 20, p_site_id: 7, p_user_id: 701, p_work_order_id: 8,
      p_item_id: 4, p_warehouse_id: 5, p_quantity: 2, p_notes: null, p_operation_key: input.operationKey };
    for (const call of state.rpc.mock.calls) expect(call).toEqual(["powerhub_maintenance_add_part", args]);
    expect(result).toEqual([{ part_id: 90, stock_movement_id: 91, quantity: 2, unit_cost: null, total_cost_amount: null, replayed: false }]);
  });

  it("does not retry insufficient stock or change the existing error mapping", async () => {
    state.capabilityAccess.mockReset().mockResolvedValue({
      tenantId: 20, allowedCapabilities: ["manageMaintenance", "issueInventory"],
    });
    state.rpc.mockReset().mockResolvedValue({ data: null, error: { code: "P0001", message: "INSUFFICIENT_STOCK" } });
    const { powerhubMaintenanceRouter } = await import("./powerhub-maintenance-router");
    const route = (powerhubMaintenanceRouter as any)._def.record.addPart;
    await expect(route._def.resolver({ ctx: { user: { id: 701 } }, input }))
      .rejects.toMatchObject({ code: "BAD_REQUEST", message: "INSUFFICIENT_STOCK" });
    expect(state.rpc).toHaveBeenCalledTimes(1);
  });
});


describe("maintenance part issue operation key contract", () => {
  it("matches the historical SQL limit and keeps other maintenance writers unchanged", async () => {
    const sql = readFileSync(resolve(process.cwd(), "supabase/migrations/20261023090000_powerhub_generator_maintenance.sql"), "utf8");
    const definition = sql.split("create or replace function public.powerhub_maintenance_add_part(")[1].split("create or replace function")[0];
    expect(definition).toContain("length(btrim(p_operation_key)) not between 1 and 150");
    const { powerhubMaintenanceRouter } = await import("./powerhub-maintenance-router");
    const routes = (powerhubMaintenanceRouter as any)._def.record;
    const schema = routes.addPart._def.inputs.at(-1);
    const base = { siteId: 7, workOrderId: 8, itemId: 4, warehouseId: 5, quantity: 1 };
    expect(schema.safeParse({ ...base, operationKey: "x".repeat(150) }).success).toBe(true);
    expect(schema.safeParse({ ...base, operationKey: "x".repeat(151) }).success).toBe(false);
    expect(schema.safeParse({ ...base, operationKey: "x".repeat(7) }).success).toBe(false);
    const assign = routes.assignSupplier._def.inputs.at(-1);
    expect(assign.safeParse({ siteId: 7, workOrderId: 8, supplierId: 12, operationKey: "x".repeat(180) }).success).toBe(true);
  });
});
