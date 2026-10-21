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

  it("requires viewInventory or viewInventoryReports before querying stock balances", async () => {
    state.rpc.mockClear();
    state.siteAccess.mockReset().mockResolvedValue({
      tenantId: 44, role: "technician", permissions: [], usesPermissionOverride: false,
    });
    const { powerhubInventoryRouter } = await import("./powerhub-inventory-router");
    const query = (powerhubInventoryRouter as any)._def.record.stockOverview;
    await expect(query._def.resolver({
      ctx: { user: { id: 84 } }, input: { siteId: 7 },
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(state.siteAccess).toHaveBeenCalledWith(84, 7);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("returns tenant-scoped stock overview through the read RPC", async () => {
    state.siteAccess.mockReset().mockResolvedValue({
      tenantId: 44, role: "manager", permissions: ["viewInventory"], usesPermissionOverride: false,
    });
    state.rpc.mockReset().mockResolvedValue({
      data: [{
        warehouse_id: 3, item_id: 9, on_hand_quantity: "12.500",
        stock_value: "87.50", average_unit_cost: "7.00", below_reorder_point: false,
      }],
      error: null,
    });
    const { powerhubInventoryRouter } = await import("./powerhub-inventory-router");
    const query = (powerhubInventoryRouter as any)._def.record.stockOverview;
    const result = await query._def.resolver({
      ctx: { user: { id: 85 } }, input: { siteId: 7 },
    });
    expect(result).toMatchObject([{ warehouse_id: 3, item_id: 9, on_hand_quantity: "12.500" }]);
    expect(result[0]).not.toHaveProperty("stock_value");
    expect(result[0]).not.toHaveProperty("average_unit_cost");
    expect(state.rpc).toHaveBeenCalledWith("powerhub_inventory_stock_overview", {
      p_tenant_id: 44, p_site_id: 7,
    });
  });

  it("requires issueInventory before recording an issue and sends the stable key to the atomic RPC", async () => {
    state.access.mockReset().mockRejectedValue(new TRPCError({ code: "FORBIDDEN", message: "forbidden" }));
    state.rpc.mockClear();
    const { powerhubInventoryRouter } = await import("./powerhub-inventory-router");
    const mutation = (powerhubInventoryRouter as any)._def.record.recordStockMovement;
    const input = {
      siteId: 7, warehouseId: 3, itemId: 9, movementType: "issue",
      quantity: 1.25, referenceNo: "ISSUE-25", notes: "test issue", operationKey: "stock:test:issue-1",
    };
    await expect(mutation._def.resolver({
      ctx: { user: { id: 86 } }, input,
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(state.access).toHaveBeenCalledWith(86, 7, expect.any(Array), "issueInventory");
    expect(state.rpc).not.toHaveBeenCalled();

    state.access.mockReset().mockResolvedValue({ tenantId: 44 });
    state.rpc.mockReset().mockResolvedValue({
      data: [{ movement_id: 901, movement_type: "issue", quantity: "1.250", replayed: false }],
      error: null,
    });
    await expect(mutation._def.resolver({
      ctx: { user: { id: 86 } }, input,
    })).resolves.toMatchObject({ movement_id: 901, replayed: false });
    expect(state.rpc).toHaveBeenCalledWith("powerhub_inventory_record_stock_movement", {
      p_tenant_id: 44, p_site_id: 7, p_user_id: 86,
      p_warehouse_id: 3, p_item_id: 9, p_movement_type: "issue",
      p_quantity: 1.25, p_unit_cost: null, p_generator_id: null,
      p_reference_no: "ISSUE-25", p_notes: "test issue",
      p_operation_key: "stock:test:issue-1",
    });
  });

  it("accepts opening balances only through adjustment permission and forwards explicit cost", async () => {
    state.access.mockReset().mockResolvedValue({ tenantId: 44 });
    state.rpc.mockReset().mockResolvedValue({ data: [{
      movement_id: 902, movement_type: "opening_balance", quantity: "8.000",
      unit_cost: "4.2500", total_cost_amount: "34.00", operation_key: "stock:opening:1", replayed: false,
    }], error: null });
    const { powerhubInventoryRouter } = await import("./powerhub-inventory-router");
    const mutation = (powerhubInventoryRouter as any)._def.record.recordStockMovement;
    const input = {
      siteId: 7, warehouseId: 3, itemId: 91, movementType: "opening_balance",
      quantity: 8, unitCost: 4.25, notes: "رصيد أول المدة بعد الجرد",
      operationKey: "stock:opening:1",
    };
    const result = await mutation._def.resolver({ ctx: { user: { id: 89 } }, input });
    expect(result).toMatchObject({ movement_id: 902, movement_type: "opening_balance", replayed: false });
    expect(state.access).toHaveBeenCalledWith(89, 7, expect.any(Array), "adjustInventory");
    expect(state.rpc).toHaveBeenCalledWith("powerhub_inventory_record_stock_movement", {
      p_tenant_id: 44, p_site_id: 7, p_user_id: 89, p_warehouse_id: 3, p_item_id: 91,
      p_movement_type: "opening_balance", p_quantity: 8, p_unit_cost: 4.25,
      p_generator_id: null, p_reference_no: null, p_notes: "رصيد أول المدة بعد الجرد",
      p_operation_key: "stock:opening:1",
    });
  });

  it("requires manageFuelAndConsumption before recording fuel use", async () => {
    state.access.mockReset().mockRejectedValue(new TRPCError({ code: "FORBIDDEN", message: "forbidden" }));
    state.rpc.mockClear();
    const { powerhubInventoryRouter } = await import("./powerhub-inventory-router");
    const mutation = (powerhubInventoryRouter as any)._def.record.recordStockMovement;
    await expect(mutation._def.resolver({
      ctx: { user: { id: 87 } },
      input: {
        siteId: 7, warehouseId: 3, itemId: 9, movementType: "fuel_consumption",
        quantity: 0.5, generatorId: 22, operationKey: "stock:test:fuel",
      },
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(state.access).toHaveBeenCalledWith(87, 7, expect.any(Array), "manageFuelAndConsumption");
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("does not expose unit or total stock valuation to users without inventory-report permission", async () => {
    state.siteAccess.mockReset().mockResolvedValue({
      tenantId: 44, role: "technician", permissions: ["viewInventory"], usesPermissionOverride: false,
    });
    state.rpc.mockReset().mockResolvedValue({
      data: [{
        movement_id: 901, warehouse_id: 3, item_id: 9, movement_type: "issue",
        quantity: "1.000", unit_cost: "7.0000", total_cost_amount: "7.00",
      }],
      error: null,
    });
    const { powerhubInventoryRouter } = await import("./powerhub-inventory-router");
    const query = (powerhubInventoryRouter as any)._def.record.listStockMovements;
    const result = await query._def.resolver({ ctx: { user: { id: 88 } }, input: { siteId: 7, limit: 100 } });
    expect(result).toMatchObject([{ movement_id: 901, quantity: "1.000" }]);
    expect(result[0]).not.toHaveProperty("unit_cost");
    expect(result[0]).not.toHaveProperty("total_cost_amount");
    expect(state.rpc).toHaveBeenCalledWith("powerhub_inventory_list_stock_movements", {
      p_tenant_id: 44, p_site_id: 7, p_limit: 100,
    });
  });


  it("requires approval permission before cancelling a purchase", async () => {
    state.rpc.mockClear();
    state.access.mockReset().mockRejectedValue(new TRPCError({ code: "FORBIDDEN", message: "forbidden" }));
    const { powerhubInventoryRouter } = await import("./powerhub-inventory-router");
    const mutation = (powerhubInventoryRouter as any)._def.record.cancelPurchase;
    await expect(mutation._def.resolver({
      ctx: { user: { id: 91 } }, input: { siteId: 7, purchaseId: 14, reason: "duplicate order" },
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(state.access).toHaveBeenCalledWith(91, 7, expect.any(Array), "approvePurchases");
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("requires supplier-payment management permission before reversing a payment", async () => {
    state.rpc.mockClear();
    state.access.mockReset().mockRejectedValue(new TRPCError({ code: "FORBIDDEN", message: "forbidden" }));
    const { powerhubInventoryRouter } = await import("./powerhub-inventory-router");
    const mutation = (powerhubInventoryRouter as any)._def.record.reverseSupplierPayment;
    await expect(mutation._def.resolver({
      ctx: { user: { id: 92 } }, input: { siteId: 7, paymentId: 15, reason: "duplicate bank entry" },
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(state.access).toHaveBeenCalledWith(92, 7, expect.any(Array), "manageSupplierPayments");
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("requires stock-adjustment permission before returning goods to a supplier", async () => {
    state.rpc.mockClear();
    state.access.mockReset().mockRejectedValue(new TRPCError({ code: "FORBIDDEN", message: "forbidden" }));
    const { powerhubInventoryRouter } = await import("./powerhub-inventory-router");
    const mutation = (powerhubInventoryRouter as any)._def.record.returnToSupplier;
    await expect(mutation._def.resolver({
      ctx: { user: { id: 94 } },
      input: {
        siteId: 7, purchaseId: 14, returnDate: "2026-10-21",
        operationKey: "supplier-return:test:001", reason: "damaged item",
        refundAmount: 0, lines: [{ purchaseLineId: 21, quantity: 1 }],
      },
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(state.access).toHaveBeenCalledWith(94, 7, expect.any(Array), "adjustInventory");
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("requires financial permission for cash refund and passes only the authorized tenant to the return RPC", async () => {
    state.access.mockReset().mockResolvedValue({ tenantId: 44 });
    state.rpc.mockReset().mockResolvedValue({ data: [{
      return_id: 301, return_number: "RET-20261021-000001", purchase_id: 14,
      status: "posted", total_credit_amount: "20.00", stock_cost_amount: "18.00",
      refund_amount: "5.00", supplier_credit_remaining: "15.00", account_balance: "105.00", replayed: false,
    }], error: null });
    const { powerhubInventoryRouter } = await import("./powerhub-inventory-router");
    const mutation = (powerhubInventoryRouter as any)._def.record.returnToSupplier;
    const result = await mutation._def.resolver({
      ctx: { user: { id: 95 } },
      input: {
        siteId: 7, purchaseId: 14, returnDate: "2026-10-21",
        operationKey: "supplier-return:test:002", reason: "damaged item",
        refundAmount: 5, refundCompanyAccountId: 8,
        lines: [{ purchaseLineId: 21, quantity: 1 }],
      },
    });
    expect(result).toMatchObject({ return_id: 301, refund_amount: "5.00" });
    expect(state.access).toHaveBeenNthCalledWith(1, 95, 7, expect.any(Array), "adjustInventory");
    expect(state.access).toHaveBeenNthCalledWith(2, 95, 7, expect.any(Array), "manageSupplierPayments");
    expect(state.rpc).toHaveBeenCalledWith("powerhub_inventory_return_to_supplier", {
      p_tenant_id: 44, p_site_id: 7, p_user_id: 95, p_purchase_id: 14,
      p_return_date: "2026-10-21", p_operation_key: "supplier-return:test:002",
      p_reason: "damaged item", p_notes: null,
      p_lines: [{ purchase_line_id: 21, quantity: 1 }],
      p_refund_amount: 5, p_refund_company_account_id: 8,
    });
  });

  it("requires adjustInventory before correcting a stock movement", async () => {
    state.rpc.mockClear();
    state.access.mockReset().mockRejectedValue(new TRPCError({ code: "FORBIDDEN", message: "forbidden" }));
    const { powerhubInventoryRouter } = await import("./powerhub-inventory-router");
    const mutation = (powerhubInventoryRouter as any)._def.record.correctStockMovement;
    await expect(mutation._def.resolver({
      ctx: { user: { id: 93 } },
      input: { siteId: 7, movementId: 51, quantity: 2, reason: "count correction", operationKey: "stock-correction:test:1" },
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(state.access).toHaveBeenCalledWith(93, 7, expect.any(Array), "adjustInventory");
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("forwards a movement correction to the atomic, idempotent RPC", async () => {
    state.access.mockReset().mockResolvedValue({ tenantId: 44 });
    state.rpc.mockReset().mockResolvedValue({ data: [{
      original_movement_id: 51, reversal_movement_id: 52, replacement_movement_id: 53,
      movement_type: "adjustment_in", quantity: "2", unit_cost: "3.3", total_cost_amount: "6.60",
      on_hand_quantity: "8", stock_value: "25.00", replayed: false,
    }], error: null });
    const { powerhubInventoryRouter } = await import("./powerhub-inventory-router");
    const mutation = (powerhubInventoryRouter as any)._def.record.correctStockMovement;
    const result = await mutation._def.resolver({
      ctx: { user: { id: 93 } },
      input: { siteId: 7, movementId: 51, quantity: 2, unitCost: 3.3, referenceNo: "FIX-51",
        notes: "recounted", reason: "count correction", operationKey: "stock-correction:test:1" },
    });
    expect(result).toMatchObject({ original_movement_id: 51, reversal_movement_id: 52, replacement_movement_id: 53 });
    expect(state.access).toHaveBeenCalledWith(93, 7, expect.any(Array), "adjustInventory");
    expect(state.rpc).toHaveBeenCalledWith("powerhub_inventory_correct_stock_movement", {
      p_tenant_id: 44, p_site_id: 7, p_user_id: 93, p_movement_id: 51, p_quantity: 2,
      p_unit_cost: 3.3, p_reference_no: "FIX-51", p_notes: "recounted",
      p_reason: "count correction", p_operation_key: "stock-correction:test:1",
    });
  });


  it("requires stock-adjustment permission before returning issued stock", async () => {
    state.rpc.mockClear();
    state.access.mockReset().mockRejectedValue(new TRPCError({ code: "FORBIDDEN", message: "forbidden" }));
    const { powerhubInventoryRouter } = await import("./powerhub-inventory-router");
    const mutation = (powerhubInventoryRouter as any)._def.record.returnFromIssue;
    await expect(mutation._def.resolver({
      ctx: { user: { id: 96 } },
      input: { siteId: 7, sourceIssueMovementId: 51, quantity: 1, reason: "unused stock returned", operationKey: "issue-return:test:1" },
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(state.access).toHaveBeenCalledWith(96, 7, expect.any(Array), "adjustInventory");
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("forwards issue returns to the atomic RPC using the authorized tenant", async () => {
    state.access.mockReset().mockResolvedValue({ tenantId: 44 });
    state.rpc.mockReset().mockResolvedValue({ data: [{
      return_movement_id: 61, source_issue_movement_id: 51, quantity: "1.000",
      unit_cost: "3.3300", total_cost_amount: "3.33", on_hand_quantity: "4.000",
      stock_value: "13.33", replayed: false,
    }], error: null });
    const { powerhubInventoryRouter } = await import("./powerhub-inventory-router");
    const mutation = (powerhubInventoryRouter as any)._def.record.returnFromIssue;
    const result = await mutation._def.resolver({
      ctx: { user: { id: 96 } },
      input: { siteId: 7, sourceIssueMovementId: 51, quantity: 1, reason: "unused stock returned",
        referenceNo: "RET-51", notes: "sealed item", operationKey: "issue-return:test:1" },
    });
    expect(result).toMatchObject({ return_movement_id: 61, source_issue_movement_id: 51, total_cost_amount: "3.33" });
    expect(state.access).toHaveBeenCalledWith(96, 7, expect.any(Array), "adjustInventory");
    expect(state.rpc).toHaveBeenCalledWith("powerhub_inventory_return_from_issue", {
      p_tenant_id: 44, p_site_id: 7, p_user_id: 96, p_source_issue_movement_id: 51,
      p_quantity: 1, p_reason: "unused stock returned", p_reference_no: "RET-51",
      p_notes: "sealed item", p_operation_key: "issue-return:test:1",
    });
  });
  it("scopes supplier ledger statement to the authorized tenant and branch", async () => {
    state.access.mockReset().mockResolvedValue({ tenantId: 44 });
    state.rpc.mockReset().mockResolvedValue({ data: {
      supplier: { id: 4, name: "Supplier A", supplier_code: "SUP-4" },
      site_id: 7, balance: "55.00", entry_count: 1, entries: [],
    }, error: null });
    const { powerhubInventoryRouter } = await import("./powerhub-inventory-router");
    const query = (powerhubInventoryRouter as any)._def.record.supplierLedgerStatement;
    const result = await query._def.resolver({
      ctx: { user: { id: 93 } }, input: { siteId: 7, supplierId: 4, limit: 200 },
    });
    expect(result).toMatchObject({ supplier: { id: 4 }, site_id: 7, balance: "55.00" });
    expect(state.access).toHaveBeenCalledWith(93, 7, expect.any(Array), "viewSupplierLedger");
    expect(state.rpc).toHaveBeenCalledWith("powerhub_inventory_supplier_ledger_statement", {
      p_tenant_id: 44, p_site_id: 7, p_supplier_id: 4, p_limit: 200,
    });
  });


  it("requires inventory-adjustment permission before executing a warehouse transfer", async () => {
    state.rpc.mockClear();
    state.access.mockReset().mockRejectedValue(new TRPCError({ code: "FORBIDDEN", message: "forbidden" }));
    const { powerhubInventoryRouter } = await import("./powerhub-inventory-router");
    const mutation = (powerhubInventoryRouter as any)._def.record.transferStock;
    await expect(mutation._def.resolver({
      ctx: { user: { id: 98 } },
      input: { siteId: 7, itemId: 12, sourceWarehouseId: 3, destinationWarehouseId: 4,
        quantity: 2.5, operationKey: "stock-transfer:unauthorized" },
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(state.access).toHaveBeenCalledWith(98, 7, expect.any(Array), "adjustInventory");
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("validates that source and destination warehouses differ before running the resolver", async () => {
    state.rpc.mockClear();
    state.access.mockClear();
    const { powerhubInventoryRouter } = await import("./powerhub-inventory-router");
    const mutation = (powerhubInventoryRouter as any)._def.record.transferStock;
    const inputParser = mutation._def.inputs?.[0];
    expect(inputParser).toBeDefined();
    expect(() => inputParser.parse({
      siteId: 7, itemId: 12, sourceWarehouseId: 3, destinationWarehouseId: 3,
      quantity: 2, operationKey: "stock-transfer:same-warehouse",
    })).toThrow();
    expect(state.access).not.toHaveBeenCalled();
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("forwards the authorized tenant and idempotency key to the atomic warehouse-transfer RPC", async () => {
    state.access.mockReset().mockResolvedValue({ tenantId: 44 });
    state.rpc.mockReset().mockResolvedValue({ data: [{
      transfer_id: 701, source_movement_id: 702, destination_movement_id: 703,
      quantity: "2.500", total_cost_amount: "8.33", replayed: false,
    }], error: null });
    const { powerhubInventoryRouter } = await import("./powerhub-inventory-router");
    const mutation = (powerhubInventoryRouter as any)._def.record.transferStock;
    const result = await mutation._def.resolver({
      ctx: { user: { id: 98 } },
      input: { siteId: 7, itemId: 12, sourceWarehouseId: 3, destinationWarehouseId: 4,
        quantity: 2.5, operationKey: "stock-transfer:stable-1", referenceNo: "TR-1", notes: "branch transfer" },
    });
    expect(result).toMatchObject({ transfer_id: 701, source_movement_id: 702, destination_movement_id: 703, replayed: false });
    expect(state.access).toHaveBeenCalledWith(98, 7, expect.any(Array), "adjustInventory");
    expect(state.rpc).toHaveBeenCalledWith("powerhub_inventory_transfer_stock", {
      p_tenant_id: 44, p_site_id: 7, p_user_id: 98, p_item_id: 12,
      p_source_warehouse_id: 3, p_destination_warehouse_id: 4, p_quantity: 2.5,
      p_operation_key: "stock-transfer:stable-1", p_reference_no: "TR-1", p_notes: "branch transfer",
    });
  });


});
