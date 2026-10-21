import { describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";

const state = vi.hoisted(() => ({
  access: vi.fn(),
  siteAccess: vi.fn(),
  from: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("./powerhub-supabase", () => ({
  requireSupabaseSiteRole: state.access,
  resolveSupabaseSiteAccess: state.siteAccess,
}));

vi.mock("./supabase-admin", () => ({
  supabaseAdmin: () => ({ from: state.from, rpc: state.rpc }),
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

  it("requires purchase visibility before reading the purchase ledger", async () => {
    state.from.mockClear();
    state.siteAccess.mockReset().mockResolvedValue({ tenantId: 2, role: "technician", permissions: [], usesPermissionOverride: false });
    const { powerhubInventoryRouter } = await import("./powerhub-inventory-router");
    const query = (powerhubInventoryRouter as any)._def.record.listPurchases;

    await expect(query._def.resolver({ ctx: { user: { id: 45 } }, input: { siteId: 6 } }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(state.siteAccess).toHaveBeenCalledWith(45, 6);
    expect(state.from).not.toHaveBeenCalled();
  });

  it("requires createPurchases before calling the purchase draft RPC", async () => {
    state.rpc.mockClear();
    state.access.mockReset().mockRejectedValue(new TRPCError({ code: "FORBIDDEN", message: "forbidden" }));
    const { powerhubInventoryRouter } = await import("./powerhub-inventory-router");
    const mutation = (powerhubInventoryRouter as any)._def.record.createPurchase;
    await expect(mutation._def.resolver({
      ctx: { user: { id: 45 } },
      input: { siteId: 6, supplierId: 2, warehouseId: 3, operationKey: "purchase:test:1",
        lines: [{ itemId: 9, quantity: 2, unit: "liter", unitsToBaseFactor: 1, unitPrice: 4, discountAmount: 0, taxAmount: 0 }] },
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(state.access).toHaveBeenCalledWith(45, 6, expect.any(Array), "createPurchases");
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("forwards a purchase draft and stable idempotency key to the atomic RPC", async () => {
    state.access.mockReset().mockResolvedValue({ tenantId: 44 });
    state.rpc.mockReset().mockResolvedValue({ data: [{ purchase_id: 71, purchase_number: "PUR-20261021-000001", replayed: false }], error: null });
    const { powerhubInventoryRouter } = await import("./powerhub-inventory-router");
    const mutation = (powerhubInventoryRouter as any)._def.record.createPurchase;
    const result = await mutation._def.resolver({
      ctx: { user: { id: 45 } },
      input: {
        siteId: 6, supplierId: 2, warehouseId: 3, supplierInvoiceNo: "INV-71",
        invoiceDate: "2026-10-21", paymentTermsDays: 30, operationKey: "purchase:test:stable-key",
        lines: [{ itemId: 9, quantity: 2.5, unit: "case", unitsToBaseFactor: 4,
          unitPrice: 20.25, discountAmount: 1, taxAmount: 0.5, notes: "test line" }],
      },
    });
    expect(result.purchase_id).toBe(71);
    expect(state.rpc).toHaveBeenCalledWith("powerhub_inventory_create_purchase", expect.objectContaining({
      p_tenant_id: 44, p_site_id: 6, p_user_id: 45, p_operation_key: "purchase:test:stable-key",
      p_lines: [{ item_id: 9, quantity: 2.5, unit: "case", units_to_base_factor: 4,
        unit_price: 20.25, discount_amount: 1, tax_amount: 0.5, notes: "test line" }],
    }));
  });

  it("requires approval capability before confirming a purchase", async () => {
    state.rpc.mockClear();
    state.access.mockReset().mockRejectedValue(new TRPCError({ code: "FORBIDDEN", message: "forbidden" }));
    const { powerhubInventoryRouter } = await import("./powerhub-inventory-router");
    const mutation = (powerhubInventoryRouter as any)._def.record.confirmPurchase;
    await expect(mutation._def.resolver({
      ctx: { user: { id: 12 } }, input: { siteId: 8, purchaseId: 71 },
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(state.access).toHaveBeenCalledWith(12, 8, expect.any(Array), "approvePurchases");
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("requires receiving capability before recording a stock receipt", async () => {
    state.rpc.mockClear();
    state.access.mockReset().mockRejectedValue(new TRPCError({ code: "FORBIDDEN", message: "forbidden" }));
    const { powerhubInventoryRouter } = await import("./powerhub-inventory-router");
    const mutation = (powerhubInventoryRouter as any)._def.record.receivePurchase;
    await expect(mutation._def.resolver({
      ctx: { user: { id: 13 } },
      input: { siteId: 8, purchaseId: 71, operationKey: "receipt:test:1",
        lines: [{ purchaseLineId: 91, quantity: 2 }] },
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(state.access).toHaveBeenCalledWith(13, 8, expect.any(Array), "receiveInventory");
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("requires manageSupplierPayments before querying company-account options", async () => {
    state.from.mockClear();
    state.access.mockReset().mockRejectedValue(new TRPCError({ code: "FORBIDDEN", message: "forbidden" }));
    const { powerhubInventoryRouter } = await import("./powerhub-inventory-router");
    const query = (powerhubInventoryRouter as any)._def.record.listSupplierPaymentOptions;
    await expect(query._def.resolver({
      ctx: { user: { id: 80 } }, input: { siteId: 7 },
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(state.access).toHaveBeenCalledWith(80, 7, expect.any(Array), "manageSupplierPayments");
    expect(state.from).not.toHaveBeenCalled();
  });

  it("requires manageSupplierPayments before calling the atomic supplier-payment RPC", async () => {
    state.rpc.mockClear();
    state.access.mockReset().mockRejectedValue(new TRPCError({ code: "FORBIDDEN", message: "forbidden" }));
    const { powerhubInventoryRouter } = await import("./powerhub-inventory-router");
    const mutation = (powerhubInventoryRouter as any)._def.record.recordSupplierPayment;
    await expect(mutation._def.resolver({
      ctx: { user: { id: 81 } },
      input: {
        siteId: 7, purchaseId: 92, companyAccountId: 100, amount: 10.25,
        paymentDate: "2026-10-21", operationKey: "supplier-payment:unauthorized",
      },
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(state.access).toHaveBeenCalledWith(81, 7, expect.any(Array), "manageSupplierPayments");
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("forwards the selected account and stable operation key to the atomic payment RPC", async () => {
    state.access.mockReset().mockResolvedValue({ tenantId: 44 });
    state.rpc.mockReset().mockResolvedValue({ data: [{
      payment_id: 501, purchase_id: 92, company_account_id: 100, account_transaction_id: 701,
      amount: "10.25", payment_date: "2026-10-21", paid_amount: "35.25",
      outstanding_amount: "64.75", account_balance: "489.75", replayed: false,
    }], error: null });
    const { powerhubInventoryRouter } = await import("./powerhub-inventory-router");
    const mutation = (powerhubInventoryRouter as any)._def.record.recordSupplierPayment;
    const result = await mutation._def.resolver({
      ctx: { user: { id: 82 } },
      input: {
        siteId: 7, purchaseId: 92, companyAccountId: 100, amount: 10.25,
        paymentDate: "2026-10-21", referenceNo: "BANK-1025", notes: "partial payment",
        operationKey: "supplier-payment:stable-key",
      },
    });
    expect(result.payment_id).toBe(501);
    expect(state.access).toHaveBeenCalledWith(82, 7, expect.any(Array), "manageSupplierPayments");
    expect(state.rpc).toHaveBeenCalledWith("powerhub_inventory_record_supplier_payment", {
      p_tenant_id: 44, p_site_id: 7, p_user_id: 82, p_purchase_id: 92,
      p_company_account_id: 100, p_amount: 10.25, p_payment_date: "2026-10-21",
      p_reference_no: "BANK-1025", p_notes: "partial payment",
      p_operation_key: "supplier-payment:stable-key",
    });
  });

  it("maps insufficient account balance from the RPC to a failed payment result", async () => {
    state.access.mockReset().mockResolvedValue({ tenantId: 44 });
    state.rpc.mockReset().mockResolvedValue({ data: null, error: { code: "P0001", message: "INSUFFICIENT_ACCOUNT_BALANCE" } });
    const { powerhubInventoryRouter } = await import("./powerhub-inventory-router");
    const mutation = (powerhubInventoryRouter as any)._def.record.recordSupplierPayment;
    await expect(mutation._def.resolver({
      ctx: { user: { id: 83 } },
      input: { siteId: 7, purchaseId: 92, companyAccountId: 100, amount: 10,
        operationKey: "supplier-payment:insufficient" },
    })).rejects.toMatchObject({ code: "BAD_REQUEST", message: "رصيد حساب الشركة لا يكفي لهذه الدفعة." });
  });

});
