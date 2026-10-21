import { describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";

const state = vi.hoisted(() => ({
  access: vi.fn(),
  from: vi.fn(),
}));

vi.mock("./powerhub-supabase", () => ({
  requireSupabaseSiteRole: state.access,
}));

vi.mock("./supabase-admin", () => ({
  supabaseAdmin: () => ({ from: state.from }),
}));

describe("PowerHub inventory catalog and supplier API", () => {
  it("checks the individual inventory-management capability before inserting a catalog item", async () => {
    state.from.mockClear();
    state.access.mockReset().mockRejectedValue(new TRPCError({ code: "FORBIDDEN", message: "forbidden" }));
    const { powerhubInventoryRouter } = await import("./powerhub-inventory-router");
    const mutation = (powerhubInventoryRouter as any)._def.record.createItem;

    await expect(mutation._def.resolver({
      ctx: { user: { id: 99 } },
      input: {
        siteId: 3,
        name: "Diesel",
        category: "fuel",
        baseUnit: "liter",
        reorderPoint: 20,
      },
    })).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(state.access).toHaveBeenCalledWith(99, 3, expect.any(Array), "manageInventoryItems");
    expect(state.from).not.toHaveBeenCalled();
  });

  it("requires supplier-directory visibility before reading supplier data", async () => {
    state.from.mockClear();
    state.access.mockReset().mockRejectedValue(new TRPCError({ code: "FORBIDDEN", message: "forbidden" }));
    const { powerhubInventoryRouter } = await import("./powerhub-inventory-router");
    const query = (powerhubInventoryRouter as any)._def.record.listSuppliers;

    await expect(query._def.resolver({
      ctx: { user: { id: 22 } },
      input: { siteId: 7 },
    })).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(state.access).toHaveBeenCalledWith(22, 7, expect.any(Array), "viewSuppliers");
    expect(state.from).not.toHaveBeenCalled();
  });

  it("requires supplier-management capability before creating a supplier", async () => {
    state.from.mockClear();
    state.access.mockReset().mockRejectedValue(new TRPCError({ code: "FORBIDDEN", message: "forbidden" }));
    const { powerhubInventoryRouter } = await import("./powerhub-inventory-router");
    const mutation = (powerhubInventoryRouter as any)._def.record.createSupplier;

    await expect(mutation._def.resolver({
      ctx: { user: { id: 12 } },
      input: { siteId: 4, name: "Supplier A" },
    })).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(state.access).toHaveBeenCalledWith(12, 4, expect.any(Array), "manageSuppliers");
    expect(state.from).not.toHaveBeenCalled();
  });
});
