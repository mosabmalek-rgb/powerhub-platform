import { describe, expect, it } from "vitest";
import type { DeltaCursorScope, DeltaPage } from "./offline-delta-sync";
import {
  applyDeltaPageToList,
  normalizeDeltaEntityRow,
  normalizeDeltaPage,
  refreshReadingSubscriberProjection,
  snapshotRowsFromQuery,
  projectInvoiceDeltaPage,
  projectPaymentDeltaPage,
  projectExpenseDeltaPage,
  refreshPaymentRelatedProjection,
  projectReadingDeltaPage,
  projectSubscriberDirectoryPage,
} from "./offline-delta-query-bridge";

const scope: DeltaCursorScope = { userId: 7, tenantId: 2, siteId: 10, entityType: "subscribers" };
const basePage = (changes: any[], entityType: any = "subscribers"): DeltaPage<Record<string, unknown>> => ({
  status: "ok", entity_type: entityType, current_cursor: "4", retained_from_cursor: "0",
  snapshot_cursor: null, through_cursor: "4", next_cursor: "4", has_more: false, changes,
});

describe("company account Delta projection", () => {
  it("normalizes tenant-scoped account balance and transaction projections", () => {
    const row = normalizeDeltaEntityRow("company_accounts", {
      id: 77, tenant_id: 2, site_id: 10, name: "Main", account_type: "cash",
      opening_balance: "100.00", balance: "155.50", is_active: true,
      allow_payment_documentation: true, created_at: "2026-10-27T10:00:00Z",
      linked_sites: [{ account_id: 77, site_id: 10, site_name: "Site A" }],
      transactions: [{ id: 901, tenant_id: 2, account_id: 77, transaction_type: "deposit", amount: "55.50", occurred_at: "2026-10-27T11:00:00Z" }],
    });
    expect(row).toMatchObject({ id: 77, tenantId: 2, siteId: 10, name: "Main", accountType: "cash", openingBalance: "100.00", balance: "155.50", isActive: true, linkedSites: [{ accountId: 77, siteId: 10, siteName: "Site A" }], transactions: [{ id: 901, accountId: 77, amount: "55.50", transactionType: "deposit" }] });
    expect((row.transactions as any[])[0].occurredAt).toBeInstanceOf(Date);
  });

  it("normalizes all-branch accounts without inventing a branch scope", () => {
    const row = normalizeDeltaEntityRow("company_accounts_all", { id: 78, tenant_id: 2, name: "Tenant account", balance: "0", linked_sites: [], transactions: [] });
    expect(row).toMatchObject({ id: 78, tenantId: 2, siteId: null, linkedSites: [], transactions: [] });
  });
});

describe("operational receipt and return Delta projections", () => {
  it("normalizes receipt history without private fields", () => {
    const row = normalizeDeltaEntityRow("inventory_purchase_receipt_headers", {
      id: 91, receipt_id: 91, tenant_id: 2, site_id: 10, purchase_id: 81,
      purchase_number: "PUR-81", receipt_number: "REC-91", receipt_date: "2026-10-29",
      supplier_id: 7, supplier_name: "Supplier A", warehouse_id: 20, warehouse_name: "Main",
      line_count: 2, received_quantity: "5.000",
    });
    expect(row).toMatchObject({ id: 91, receipt_id: 91, purchaseId: 81, supplierName: "Supplier A",
      warehouseName: "Main", receipt_number: "REC-91", line_count: 2, received_quantity: "5.000" });
    expect(row).not.toHaveProperty("notes");
    expect(row).not.toHaveProperty("operation_key");
    expect(row).not.toHaveProperty("unit_cost");
  });

  it("normalizes supplier return history without settlement fields", () => {
    const row = normalizeDeltaEntityRow("inventory_supplier_return_headers", {
      id: 92, return_id: 92, tenant_id: 2, site_id: 10, purchase_id: 82,
      purchase_number: "PUR-82", return_number: "RET-92", return_date: "2026-10-29",
      status: "posted", supplier_id: 7, supplier_name: "Supplier A",
      warehouse_id: 20, warehouse_name: "Main", line_count: 1, returned_quantity: "2.000",
    });
    expect(row).toMatchObject({ id: 92, return_id: 92, purchaseId: 82, supplierName: "Supplier A",
      warehouseName: "Main", return_number: "RET-92", line_count: 1, returned_quantity: "2.000" });
    expect(row).not.toHaveProperty("reason");
    expect(row).not.toHaveProperty("refund_amount");
    expect(row).not.toHaveProperty("stock_cost_amount");
  });
});

describe("operational purchase header Delta projection", () => {
  it("normalizes safe labels and IDs without financial fields", () => {
    const row = normalizeDeltaEntityRow("inventory_purchase_headers", {
      id: 81, purchase_id: 81, tenant_id: 2, site_id: 10,
      supplier_id: 7, supplier_name: "Supplier A", supplier_code: "SUP-A",
      warehouse_id: 20, warehouse_name: "Main", purchase_number: "PUR-81",
      invoice_date: "2026-10-29", status: "partially_received", item_count: 3, received_line_count: 1,
    });
    expect(row).toMatchObject({
      id: 81, purchase_id: 81, tenantId: 2, siteId: 10, supplierId: 7,
      supplierName: "Supplier A", supplierCode: "SUP-A", warehouseId: 20,
      warehouseName: "Main", purchase_number: "PUR-81", status: "partially_received",
    });
    expect(row).not.toHaveProperty("total_amount");
    expect(row).not.toHaveProperty("supplier_invoice_no");
    expect(row).not.toHaveProperty("due_date");
    expect(row).not.toHaveProperty("notes");
  });

  it("reconciles purchase header upserts by ID", () => {
    const purchaseScope: DeltaCursorScope = { userId: 7, tenantId: 2, siteId: 10, entityType: "inventory_purchase_headers" };
    const original = { id: 81, purchase_number: "PUR-81", tenantId: 2, siteId: 10, status: "confirmed" };
    const normalized = normalizeDeltaEntityRow("inventory_purchase_headers", {
      id: 81, purchase_id: 81, tenant_id: 2, site_id: 10, purchase_number: "PUR-81",
      status: "received", supplier_name: "Supplier A", warehouse_name: "Main",
    });
    const update = basePage([{
      cursor: "5", entity_type: "inventory_purchase_headers", entity_id: "81", operation: "upsert",
      row_data: normalized, changed_at: "2026-10-29T10:00:00Z",
    }], "inventory_purchase_headers");
    expect(applyDeltaPageToList("inventory_purchase_headers", [original], update, purchaseScope))
      .toEqual([expect.objectContaining({ id: 81, status: "received", supplierName: "Supplier A" })]);
  });
});

describe("inventory stocktake Delta projection", () => {
  it("preserves safe headers and aggregate counters without adding financial line values", () => {
    const row = normalizeDeltaEntityRow("inventory_stocktakes", {
      stocktake_id: 81, tenant_id: 2, site_id: 10, stocktake_number: "ST-81",
      warehouse_id: 20, warehouse_name: "Main", location_type: "branch_warehouse",
      status: "submitted", reason: "Routine", notes: null, created_at: "2026-10-29T10:00:00Z",
      item_count: 4, counted_count: 4, variance_count: 1, variance_quantity: "3.000",
    });
    expect(row).toMatchObject({ id: 81, stocktake_id: 81, tenantId: 2, siteId: 10, warehouse_id: 20,
      item_count: 4, counted_count: 4, variance_count: 1, variance_quantity: "3.000" });
    expect(row).not.toHaveProperty("system_value");
    expect(row).not.toHaveProperty("system_unit_cost");
    expect(row).not.toHaveProperty("counted_unit_cost");
  });

  it("updates cached stocktake rows by stocktake_id", () => {
    const stocktakeScope: DeltaCursorScope = { userId: 7, tenantId: 2, siteId: 10, entityType: "inventory_stocktakes" };
    const original = { stocktake_id: 81, tenantId: 2, siteId: 10, status: "counting" };
    const update = basePage([{
      cursor: "5", entity_type: "inventory_stocktakes", entity_id: "81", operation: "upsert",
      row_data: { id: 81, stocktake_id: 81, tenantId: 2, siteId: 10, status: "submitted" },
      changed_at: "2026-10-29T10:00:00Z",
    }], "inventory_stocktakes");
    expect(applyDeltaPageToList("inventory_stocktakes", [original], update, stocktakeScope))
      .toEqual([{ id: 81, stocktake_id: 81, tenantId: 2, siteId: 10, status: "submitted" }]);
  });
});

describe("inventory stock movement Delta projection", () => {
  it("normalizes stock movements without financial cost fields", () => {
    const row = normalizeDeltaEntityRow("inventory_stock_movements", {
      id: 901, movement_id: 901, tenant_id: 2, site_id: 10, warehouse_id: 20,
      warehouse_code: "WH-20", warehouse_name: "Main", item_id: 1101, item_name: "Diesel",
      category: "fuel", base_unit: "liter", movement_type: "issue", quantity: "2.500",
      reference_no: "ISS-901", operation_key: "stock:901", occurred_at: "2026-10-29T10:00:00Z",
      corrected_by_movement_id: 902, reversal_of_movement_id: null, corrects_movement_id: null,
      correction_reason: null,
      unit_cost: "3.5000", total_cost_amount: "8.75",
    });
    expect(row).toMatchObject({
      id: 901, movement_id: 901, tenantId: 2, siteId: 10, quantity: "2.500",
      movement_type: "issue", corrected_by_movement_id: 902,
    });
    expect(row).not.toHaveProperty("unit_cost");
    expect(row).not.toHaveProperty("total_cost_amount");
  });
});

describe("inventory catalog Delta projection", () => {
  it("normalizes catalog fields while preserving the snake-case UI contract", () => {
    expect(normalizeDeltaEntityRow("inventory_items", {
      id: 1101, tenant_id: 2, sku: "SKU-1101", name: "Diesel", category: "fuel",
      base_unit: "liter", reorder_point: "10.000", is_active: true,
      created_at: "2026-10-29T10:00:00Z", updated_at: "2026-10-29T10:00:00Z",
    })).toMatchObject({ id: 1101, tenantId: 2, base_unit: "liter", baseUnit: "liter", reorder_point: "10.000", is_active: true, isActive: true });

    expect(normalizeDeltaEntityRow("inventory_item_units", {
      id: 1201, tenant_id: 2, item_id: 1101, unit_label: "barrel",
      factor_to_base: "200.000000", is_active: true,
    })).toMatchObject({ id: 1201, tenantId: 2, itemId: 1101, unit_label: "barrel", unitLabel: "barrel", factor_to_base: "200.000000" });

    expect(normalizeDeltaEntityRow("suppliers", {
      id: 1301, tenant_id: 2, supplier_code: "SUP-1301", supplier_type: "permanent",
      default_payment_terms_days: 30, is_active: true,
    })).toMatchObject({ id: 1301, tenantId: 2, supplier_code: "SUP-1301", supplier_type: "permanent", default_payment_terms_days: 30, is_active: true });

    expect(normalizeDeltaEntityRow("inventory_warehouses", {
      id: 1401, tenant_id: 2, site_id: 10, code: "WH-1", name: "Branch",
      location_type: "branch_warehouse", generator_id: null, is_active: true,
    })).toMatchObject({ id: 1401, tenantId: 2, siteId: 10, location_type: "branch_warehouse", generator_id: null, is_active: true });
  });

  it("applies tenant-wide catalog updates without accepting another tenant's row", () => {
    const catalogScope: DeltaCursorScope = { userId: 7, tenantId: 2, siteId: 10, entityType: "inventory_items" };
    const current = [{ id: 1101, tenantId: 2, name: "Old", base_unit: "liter" }];
    const page = basePage([
      { cursor: "5", entity_type: "inventory_items", entity_id: "1101", operation: "upsert",
        row_data: normalizeDeltaEntityRow("inventory_items", { id: 1101, tenant_id: 2, name: "New", base_unit: "liter", is_active: true }), changed_at: "2026-10-29T10:00:00Z" },
      { cursor: "6", entity_type: "inventory_items", entity_id: "1102", operation: "upsert",
        row_data: normalizeDeltaEntityRow("inventory_items", { id: 1102, tenant_id: 999, name: "Foreign", base_unit: "liter", is_active: true }), changed_at: "2026-10-29T10:00:01Z" },
    ], "inventory_items");
    expect(applyDeltaPageToList("inventory_items", current, page, catalogScope)).toMatchObject([
      { id: 1101, tenantId: 2, name: "New" },
    ]);
  });
});

describe("delta-query bridge", () => {
  it("normalizes site projections including tenant label and due-time policy", () => {
    const row = normalizeDeltaEntityRow("sites", {
      id: 10, tenant_id: 2, tenant_name: "Tenant One", name: "Site One", code: "S-10",
      invoice_due_days: 14, invoice_due_hours: 48, created_at: "2026-10-24T00:00:00Z",
    });
    expect(row).toMatchObject({ id: 10, tenantId: 2, tenantName: "Tenant One", invoiceDueDays: 14, invoiceDueHours: 48 });
  });

  it("applies only the matching site row to the shared accessible-site list", () => {
    const siteScope: DeltaCursorScope = { userId: 7, tenantId: 2, siteId: 10, entityType: "sites" };
    const current = [
      { id: 10, tenantId: 2, name: "Old Site" },
      { id: 11, tenantId: 2, name: "Other Site" },
    ];
    const update = basePage([{
      cursor: "1", entity_type: "sites", entity_id: "10", operation: "upsert",
      row_data: { id: 10, tenantId: 2, name: "Updated Site" }, changed_at: "2026-10-24T00:00:00Z",
    }], "sites");
    expect(applyDeltaPageToList("sites", current, update, siteScope)).toEqual([
      { id: 10, tenantId: 2, name: "Updated Site" },
      { id: 11, tenantId: 2, name: "Other Site" },
    ]);
    const wrongSite = basePage([{
      cursor: "1", entity_type: "sites", entity_id: "11", operation: "upsert",
      row_data: { id: 11, tenantId: 2, name: "Wrong Site" }, changed_at: "2026-10-24T00:00:00Z",
    }], "sites");
    expect(applyDeltaPageToList("sites", current, wrongSite, siteScope)).toEqual(current);
  });

  it("maps database subscriber rows to the existing PowerHub client shape", () => {
    const row = normalizeDeltaEntityRow("subscribers", {
      id: 4, tenant_id: 2, site_id: 10, subscriber_no: "SUB-000004",
      full_name: "Test", phone: "0590000000", subscription_type: "residential",
      service_status: "active", created_at: "2026-10-24T00:00:00Z", updated_at: "2026-10-24T01:00:00Z",
    });
    expect(row).toMatchObject({ id: 4, tenantId: 2, siteId: 10, subscriberNo: "SUB-000004", fullName: "Test" });
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(row.updatedAt).toBeInstanceOf(Date);
  });

  it("normalizes each delta page and rejects an entity mismatch", () => {
    const page = basePage([{
      cursor: "4", entity_type: "subscribers", entity_id: "4", operation: "upsert",
      row_data: { id: 4, tenant_id: 2, site_id: 10, subscriber_no: "SUB-000004", full_name: "Test" }, changed_at: "2026-10-24T00:00:00Z",
    }]);
    expect(normalizeDeltaPage("subscribers", page).changes[0].row_data).toMatchObject({ id: 4, tenantId: 2, subscriberNo: "SUB-000004" });
    expect(() => normalizeDeltaPage("tariffs", page)).toThrow(/لا تطابق/);
  });

  it("flattens the current paired readings snapshot without changing its public query shape", () => {
    const readings = snapshotRowsFromQuery("readings", [{ reading: { id: 3, tenantId: 2, subscriberId: 4, readingValue: "12.5" }, subscriber: { id: 4 } }]);
    expect(readings).toEqual([{ id: 3, tenantId: 2, subscriberId: 4, readingValue: "12.5", previousReadingValue: null, consumptionKwh: null, clientOperationId: null, readingAt: new Date(0), captureMethod: "manual", imageKey: null, imageHash: null, status: "pending", enteredByUserId: null, reviewedByUserId: null, reviewedAt: null, notes: null, versionNo: 0, createdAt: new Date(0), updatedAt: new Date(0) }]);
  });

  it("applies scoped upserts and tombstones to the same list without leaking another tenant", () => {
    const page = basePage([
      { cursor: "3", entity_type: "subscribers", entity_id: "4", operation: "upsert", row_data: { id: 4, tenantId: 2, siteId: 10, fullName: "Updated" }, changed_at: "2026-10-24T00:00:00Z" },
      { cursor: "4", entity_type: "subscribers", entity_id: "5", operation: "upsert", row_data: { id: 5, tenantId: 3, siteId: 10, fullName: "Other tenant" }, changed_at: "2026-10-24T00:00:00Z" },
    ]);
    const result = applyDeltaPageToList("subscribers", [{ id: 4, tenantId: 2, siteId: 10, fullName: "Old" }], page, scope);
    expect(result).toEqual([{ id: 4, tenantId: 2, siteId: 10, fullName: "Updated" }]);
  });

  it("does not add a reading without its in-scope subscriber and updates nested subscriber projections", () => {
    const readingPage = basePage([{
      cursor: "4", entity_type: "readings", entity_id: "30", operation: "upsert",
      row_data: { id: 30, tenantId: 2, subscriberId: 4, readingValue: "125.5" }, changed_at: "2026-10-24T00:00:00Z",
    }], "readings");
    const noParent = applyDeltaPageToList("readings", [], readingPage, { ...scope, entityType: "readings" }, []);
    expect(noParent).toEqual([]);
    const subPage = basePage([{
      cursor: "4", entity_type: "subscribers", entity_id: "4", operation: "upsert",
      row_data: { id: 4, tenantId: 2, siteId: 10, fullName: "New name" }, changed_at: "2026-10-24T00:00:00Z",
    }]);
    expect(refreshReadingSubscriberProjection([{ reading: { id: 30 }, subscriber: { id: 4, fullName: "Old" } }], subPage, scope))
      .toEqual([{ reading: { id: 30 }, subscriber: { id: 4, fullName: "New name", tenantId: 2, siteId: 10 } }]);
  });
});


describe("reading Delta page materialization", () => {
  const readingScope: DeltaCursorScope = { userId: 7, tenantId: 2, siteId: 10, entityType: "readings" };
  const reading = (id: number, readingAt: string, extra: Record<string, unknown> = {}) => ({
    id, tenantId: 2, subscriberId: id + 100, readingAt: new Date(readingAt),
    readingValue: "100.00", status: "approved", ...extra,
  });
  const subscriber = (id: number, extra: Record<string, unknown> = {}) => ({
    id, tenantId: 2, siteId: 10, fullName: "Subscriber " + id, serviceStatus: "active", ...extra,
  });

  it("rebuilds keyset pages with reading/subscriber pairs without gaps or duplicates", () => {
    const all = [
      reading(8, "2026-10-27T10:00:00.000Z"),
      reading(7, "2026-10-27T10:00:00.000Z"),
      reading(6, "2026-10-26T10:00:00.000Z"),
    ];
    const subscribers = all.map((row) => subscriber(row.subscriberId));
    const first = projectReadingDeltaPage(all, subscribers, { siteId: 10, limit: 2 }, undefined, readingScope);
    expect(first.items.map((row: any) => row.reading.id)).toEqual([8, 7]);
    expect(first.items[0].subscriber.fullName).toBe("Subscriber 108");
    expect(first.hasNext).toBe(true);
    expect(typeof first.nextCursor).toBe("string");
    const second = projectReadingDeltaPage(all, subscribers, { siteId: 10, limit: 2, cursor: first.nextCursor }, undefined, readingScope);
    expect(second.items.map((row: any) => row.reading.id)).toEqual([6]);
    expect(second.hasNext).toBe(false);
    expect(second.nextCursor).toBeNull();
  });

  it("filters tenant/site leaks and rejects a page cursor for a different site", () => {
    const rows = [
      reading(1, "2026-10-27T10:00:00.000Z"),
      reading(2, "2026-10-26T10:00:00.000Z", { tenantId: 99 }),
      reading(3, "2026-10-25T10:00:00.000Z"),
    ];
    const subscribers = [
      subscriber(101),
      subscriber(102, { tenantId: 99 }),
      subscriber(103, { siteId: 99 }),
    ];
    const page = projectReadingDeltaPage(rows, subscribers, { siteId: 10, limit: 10 }, undefined, readingScope);
    expect(page.items.map((row: any) => row.reading.id)).toEqual([1]);
    expect(() => projectReadingDeltaPage(rows, subscribers, { siteId: 99, limit: 10 }, undefined, readingScope))
      .toThrow(/نطاق صفحة القراءات/);
  });

  it("preserves page response metadata while refreshing the materialized items", () => {
    const projected = projectReadingDeltaPage(
      [reading(1, "2026-10-27T10:00:00.000Z")],
      [subscriber(101)],
      { siteId: 10, limit: 20 },
      { items: [], hasNext: false, nextCursor: null, uiMarker: "keep" },
      readingScope,
    );
    expect(projected.uiMarker).toBe("keep");
    expect(projected.items).toHaveLength(1);
  });
});

describe("payment Delta page materialization",()=>{
 const scope:DeltaCursorScope={userId:7,tenantId:2,siteId:10,entityType:"payments"};
 const row=(id:number,paidAt:string,extra:Record<string,unknown>={})=>({id,tenantId:2,siteId:10,payment:{id,tenantId:2,siteId:10,subscriberId:id+100,invoiceId:id+200,paymentNo:"PAY-"+id,amount:"25.00",paymentMethod:"cash",status:"completed",paidAt:new Date(paidAt),hasReceiptImage:true,receiptImageUrl:null},subscriber:{id:id+100,tenantId:2,siteId:10,fullName:"Subscriber "+id},invoiceNo:"INV-"+(id+200),...extra});
 it("materializes stable keyset pages and never returns receipt URLs",()=>{
  const rows=[row(8,"2026-10-27T10:00:00Z"),row(7,"2026-10-27T10:00:00Z"),row(6,"2026-10-26T10:00:00Z")];
  const first=projectPaymentDeltaPage(rows,{siteId:10,limit:2},undefined,scope);
  expect(first.items.map(x=>x.payment.id)).toEqual([8,7]);expect(first.hasNext).toBe(true);expect(first.items[0].payment.receiptImageUrl).toBeNull();
  const second=projectPaymentDeltaPage(rows,{siteId:10,limit:2,cursor:first.nextCursor},undefined,scope);
  expect(second.items.map(x=>x.payment.id)).toEqual([6]);expect(second.hasNext).toBe(false);
 });
 it("rejects another site and filters cross-scope joined rows",()=>{
  const rows=[row(1,"2026-10-27T10:00:00Z"),row(2,"2026-10-26T10:00:00Z",{tenantId:99}),row(3,"2026-10-25T10:00:00Z",{subscriber:{id:103,tenantId:2,siteId:99,fullName:"wrong"}})];
  expect(projectPaymentDeltaPage(rows,{siteId:10,limit:10},undefined,scope).items.map(x=>x.payment.id)).toEqual([1]);
  expect(()=>projectPaymentDeltaPage(rows,{siteId:99,limit:10},undefined,scope)).toThrow(/نطاق صفحة المدفوعات/);
 });
 it("refreshes related subscriber and invoice labels from Delta",()=>{
  const rows=[row(1,"2026-10-27T10:00:00Z")];
  const make=(entity_type:"subscribers"|"invoices",entity_id:string,row_data:Record<string,unknown>):DeltaPage<any>=>({status:"ok",entity_type,current_cursor:"2",retained_from_cursor:"0",snapshot_cursor:null,through_cursor:"2",next_cursor:"2",has_more:false,changes:[{cursor:"2",entity_type,entity_id,operation:"upsert",row_data,changed_at:"2026-10-27T12:00:00Z"}]});
  expect((refreshPaymentRelatedProjection(rows,make("subscribers","101",{id:101,tenantId:2,siteId:10,fullName:"Updated"}),scope,"subscribers") as any[])[0].subscriber.fullName).toBe("Updated");
  expect((refreshPaymentRelatedProjection(rows,make("invoices","201",{id:201,tenantId:2,siteId:10,invoiceNo:"INV-NEW"}),scope,"invoices") as any[])[0].invoiceNo).toBe("INV-NEW");
 });
});
describe("invoice Delta page materialization", () => {
  const invoiceScope: DeltaCursorScope = { userId: 7, tenantId: 2, siteId: 10, entityType: "invoices" };
  const invoice = (id: number, issueDate: string, extra: Record<string, unknown> = {}) => ({
    id, tenantId: 2, siteId: 10, invoiceNo: `INV-${id}`, issueDate: new Date(issueDate),
    dueDate: new Date("2026-11-10T00:00:00.000Z"), totalAmount: "100.00",
    paidAmount: "0.00", balanceDue: "100.00", status: "issued", ...extra,
  });

  it("rebuilds keyset pages without gaps or duplicates", () => {
    const all = [
      invoice(8, "2026-10-27T10:00:00.000Z"),
      invoice(7, "2026-10-27T10:00:00.000Z"),
      invoice(6, "2026-10-26T10:00:00.000Z"),
    ];
    const first = projectInvoiceDeltaPage(all, { siteId: 10, limit: 2 }, undefined, invoiceScope);
    expect(first.items.map((row: any) => row.id)).toEqual([8, 7]);
    expect(first.hasNext).toBe(true);
    expect(typeof first.nextCursor).toBe("string");
    const second = projectInvoiceDeltaPage(all, { siteId: 10, limit: 2, cursor: first.nextCursor }, undefined, invoiceScope);
    expect(second.items.map((row: any) => row.id)).toEqual([6]);
    expect(second.hasNext).toBe(false);
    expect(second.nextCursor).toBeNull();
  });

  it("excludes invoice rows outside tenant/site and rejects a mismatched page key", () => {
    const rows = [
      invoice(1, "2026-10-27T10:00:00.000Z"),
      invoice(2, "2026-10-26T10:00:00.000Z", { tenantId: 99 }),
      invoice(3, "2026-10-25T10:00:00.000Z", { siteId: 99 }),
    ];
    expect(projectInvoiceDeltaPage(rows, { siteId: 10, limit: 10 }, undefined, invoiceScope).items.map((r: any) => r.id)).toEqual([1]);
    expect(() => projectInvoiceDeltaPage(rows, { siteId: 99, limit: 10 }, undefined, invoiceScope)).toThrow(/نطاق صفحة الفواتير/);
  });

  it("preserves non-page response metadata", () => {
    const projected = projectInvoiceDeltaPage(
      [invoice(1, "2026-10-27T10:00:00.000Z")],
      { siteId: 10, limit: 20 },
      { items: [], hasNext: false, nextCursor: null, uiMarker: "keep" },
      invoiceScope,
    );
    expect(projected.uiMarker).toBe("keep");
    expect(projected.items).toHaveLength(1);
  });
});

describe("expense Delta page materialization", () => {
  const expenseScope: DeltaCursorScope = { userId: 7, tenantId: 2, siteId: 10, entityType: "expenses" };
  const expense = (id: number, occurredAt: string, extra: Record<string, unknown> = {}) => ({
    id, tenantId: 2, siteId: 10, companyAccountId: 55, category: "fuel", description: "Fuel",
    amount: "25.00", occurredAt: new Date(occurredAt), referenceNo: "EXP-" + id, ...extra,
  });
  it("applies account/date filters and stable cursor paging", () => {
    const rows = [
      expense(8, "2026-10-27T10:00:00.000Z"),
      expense(7, "2026-10-27T10:00:00.000Z"),
      expense(6, "2026-10-26T10:00:00.000Z"),
      expense(9, "2026-10-27T10:00:00.000Z", { companyAccountId: 77 }),
      expense(10, "2026-10-28T10:00:00.000Z", { tenantId: 99 }),
    ];
    const first = projectExpenseDeltaPage(rows, { siteId: 10, limit: 2, companyAccountId: 55 }, undefined, expenseScope);
    expect(first.items.map((r) => r.id)).toEqual([8, 7]);
    expect(first.hasNext).toBe(true);
    const second = projectExpenseDeltaPage(rows, { siteId: 10, limit: 2, companyAccountId: 55, cursor: first.nextCursor }, undefined, expenseScope);
    expect(second.items.map((r) => r.id)).toEqual([6]);
    const filtered = projectExpenseDeltaPage(rows, { siteId: 10, limit: 10, startDate: "2026-10-27", endDate: "2026-10-27", companyAccountId: 55 }, undefined, expenseScope);
    expect(filtered.items.map((r) => r.id)).toEqual([8, 7]);
  });
  it("decodes generated base64url cursors and rejects malformed cursor tokens", () => {
    const rows = [
      expense(8, "2026-10-27T10:00:00.000Z"),
      expense(7, "2026-10-27T10:00:00.000Z"),
      expense(6, "2026-10-26T10:00:00.000Z"),
    ];
    const first = projectExpenseDeltaPage(rows, { siteId: 10, limit: 2, companyAccountId: 55 }, undefined, expenseScope);
    expect(first.nextCursor).toBeTruthy();
    const next = projectExpenseDeltaPage(rows, { siteId: 10, limit: 2, companyAccountId: 55, cursor: first.nextCursor }, undefined, expenseScope);
    expect(next.items.map((row) => row.id)).toEqual([6]);
    expect(() => projectExpenseDeltaPage(rows, { siteId: 10, cursor: "not-a-base64url-cursor" }, undefined, expenseScope))
      .toThrow(/مؤشر صفحة المصروفات المحلي غير صالح/);
  });

  it("rejects mismatched scopes and invalid filters", () => {
    const rows = [expense(1, "2026-10-27T10:00:00.000Z")];
    expect(() => projectExpenseDeltaPage(rows, { siteId: 99 }, undefined, expenseScope)).toThrow(/نطاق صفحة المصروفات/);
    expect(() => projectExpenseDeltaPage(rows, { siteId: 10, startDate: "2026-02-30", endDate: "2026-03-01" }, undefined, expenseScope)).toThrow(/تاريخ فلتر المصروفات/);
    expect(() => projectExpenseDeltaPage(rows, { siteId: 10, startDate: "2026-10-28", endDate: "2026-10-27" }, undefined, expenseScope)).toThrow(/تاريخ بداية المصروفات/);
  });
});

describe("reading Delta site scope projection", () => {
  it("preserves resolved site_id from server projections", () => {
    expect(normalizeDeltaEntityRow("readings", { id:700, tenant_id:1, site_id:10, subscriber_id:101, reading_at:"2026-10-27T10:00:00Z", reading_value:120 }))
      .toMatchObject({ id:700, tenantId:1, siteId:10, subscriberId:101 });
  });
});


describe("fuel and preventive maintenance Delta projections", () => {
  it("normalizes fuel readings without losing the existing UI field names", () => {
    const row = normalizeDeltaEntityRow("fuel_readings", {
      id: 701, tenant_id: 2, site_id: 10, generator_id: 44, generator_name: "مولد A",
      reading_type: "tank_level", tank_warehouse_id: 18, tank_name: "خزان A",
      reading_value: "125.500", recorded_at: "2026-10-29T10:00:00Z",
      corrects_reading_id: null, reference_no: null, notes: null, created_at: "2026-10-29T10:00:00Z",
    });
    expect(row).toMatchObject({
      id: 701, reading_id: 701, tenantId: 2, siteId: 10, generator_id: 44,
      generator_name: "مولد A", reading_type: "tank_level", tank_warehouse_id: 18,
      tank_name: "خزان A", reading_value: "125.500", corrects_reading_id: null,
    });
    expect(row.recorded_at).toBe("2026-10-29T10:00:00.000Z");
  });

  it("normalizes preventive plans and applies only same-tenant, same-branch changes", () => {
    const plan = normalizeDeltaEntityRow("maintenance_preventive_plans", {
      id: 801, tenant_id: 2, site_id: 10, generator_id: 44, generator_name: "مولد A",
      plan_code: "PM-801", title: "فحص دوري", interval_days: 30, interval_operating_hours: null,
      next_due_at: "2026-11-01T00:00:00Z", next_due_operating_hours: null,
      due_soon_days: 7, due_soon_hours: 10, is_active: true, alert_type: "due_soon",
      observed_operating_hours: "450.00",
    });
    expect(plan).toMatchObject({
      id: 801, plan_id: 801, tenantId: 2, siteId: 10, generator_id: 44,
      plan_code: "PM-801", title: "فحص دوري", interval_days: 30, is_active: true, alert_type: "due_soon",
    });
    const planScope: DeltaCursorScope = { userId: 7, tenantId: 2, siteId: 10, entityType: "maintenance_preventive_plans" };
    const current = [plan];
    const update = basePage([
      { cursor: "5", entity_type: "maintenance_preventive_plans", entity_id: "801", operation: "upsert",
        row_data: { ...plan, title: "فحص محدث" }, changed_at: "2026-10-29T10:00:00Z" },
      { cursor: "6", entity_type: "maintenance_preventive_plans", entity_id: "802", operation: "upsert",
        row_data: { ...plan, id: 802, plan_id: 802, tenantId: 999, title: "خطة مستأجر آخر" }, changed_at: "2026-10-29T10:00:01Z" },
    ], "maintenance_preventive_plans");
    expect(applyDeltaPageToList("maintenance_preventive_plans", current, update, planScope))
      .toMatchObject([{ id: 801, title: "فحص محدث" }]);
    const deletion = basePage([
      { cursor: "7", entity_type: "maintenance_preventive_plans", entity_id: "801", operation: "delete",
        row_data: null, changed_at: "2026-10-29T10:00:02Z" },
    ], "maintenance_preventive_plans");
    expect(applyDeltaPageToList("maintenance_preventive_plans", current, deletion, planScope)).toEqual([]);
  });
});


describe("fuel event and maintenance work-order Delta projection", () => {
  it("normalizes scoped fuel fills, work orders and per-order parts while excluding nonessential notes", () => {
    const event = normalizeDeltaEntityRow("fuel_events", {
      id: 10, event_id: 10, tenant_id: 2, site_id: 10, generator_id: 44,
      generator_name: "G-44", fuel_item_id: 3, fuel_item_name: "Diesel",
      source_warehouse_id: 5, source_warehouse_name: "Store",
      destination_warehouse_id: 6, destination_warehouse_name: "Tank",
      litres: "40.000", occurred_at: "2026-10-29T08:00:00Z",
      notes: "should not persist", unit_cost: "8.0000", total_cost_amount: "320.00",
    });
    expect(event).toMatchObject({ id: 10, tenantId: 2, siteId: 10, litres: "40.000", notes: null });
    expect(event).not.toHaveProperty("unit_cost");
    expect(event).not.toHaveProperty("total_cost_amount");

    const order = normalizeDeltaEntityRow("maintenance_work_orders", {
      id: 20, work_order_id: 20, tenant_id: 2, site_id: 10, generator_id: 44,
      work_order_number: "MW-20", status: "in_progress", reported_at: "2026-10-29T07:00:00Z",
      title: "Repair", labor_cost: "25.00", description: "Description",
    });
    expect(order).toMatchObject({ id: 20, tenantId: 2, siteId: 10, work_order_number: "MW-20" });

    const entity = "maintenance_work_order_parts:20" as const;
    const part = normalizeDeltaEntityRow(entity, {
      id: 30, part_id: 30, tenant_id: 2, site_id: 10, work_order_id: 20, generator_id: 44,
      item_id: 7, item_name: "Filter", warehouse_id: 6, warehouse_name: "Store",
      quantity: "2.000", unit_cost: "4.0000", total_cost_amount: "8.00",
      stock_movement_id: 90, issued_at: "2026-10-29T09:00:00Z", notes: "private note",
    });
    expect(part).toMatchObject({ id: 30, tenantId: 2, siteId: 10, work_order_id: 20, notes: null });

    const eventScope: DeltaCursorScope = { userId: 7, tenantId: 2, siteId: 10, entityType: "fuel_events" };
    const eventPage = basePage([{
      cursor: "1", entity_type: "fuel_events", entity_id: "10", operation: "upsert",
      row_data: event, changed_at: "2026-10-29T08:00:00Z",
    }], "fuel_events");
    expect(applyDeltaPageToList("fuel_events", [], eventPage, eventScope)).toMatchObject([{ id: 10 }]);

    const orderScope: DeltaCursorScope = { userId: 7, tenantId: 2, siteId: 10, entityType: "maintenance_work_orders" };
    const orderPage = basePage([{
      cursor: "1", entity_type: "maintenance_work_orders", entity_id: "20", operation: "upsert",
      row_data: order, changed_at: "2026-10-29T07:00:00Z",
    }], "maintenance_work_orders");
    expect(applyDeltaPageToList("maintenance_work_orders", [], orderPage, orderScope)).toMatchObject([{ id: 20 }]);

    const partScope: DeltaCursorScope = { userId: 7, tenantId: 2, siteId: 10, entityType: entity };
    const partPage = basePage([{
      cursor: "1", entity_type: entity, entity_id: "30", operation: "upsert",
      row_data: part, changed_at: "2026-10-29T09:00:00Z",
    }], entity);
    expect(applyDeltaPageToList(entity, [], partPage, partScope)).toMatchObject([{ id: 30, work_order_id: 20 }]);
  });
});


describe("HR Delta minimized projections", () => {
  it("keeps employee optimistic versions while removing personal and wage fields", () => {
    const employee = normalizeDeltaEntityRow("hr_employee_directory", {
      id: 42, tenant_id: 2, site_id: null, full_name: "موظف", job_title: "worker",
      employment_status: "active", contract_type: "monthly", created_at: "2026-10-01T00:00:00Z",
      version_no: 9, identity_no: "PRIVATE-ID", phone: "PRIVATE-PHONE", base_wage: "9999",
      notes: "PRIVATE-NOTE", linked_user_id: 55,
    });
    expect(employee).toMatchObject({
      id: 42, tenantId: 2, siteId: null, fullName: "موظف", versionNo: 9,
    });
    for (const field of ["identityNo", "identity_no", "phone", "baseWage", "base_wage", "notes", "linkedUserId", "linked_user_id"]) {
      expect(employee).not.toHaveProperty(field);
    }
  });

  it("does not synthesize a server version when an HR Delta row omits it", () => {
    const employee = normalizeDeltaEntityRow("hr_employee_directory", {
      id: 43, tenant_id: 2, site_id: 10, full_name: "موظف", job_title: "worker",
    }) as Record<string, any>;
    expect(employee.versionNo).toBe(0);

    const attendance = normalizeDeltaEntityRow("hr_attendance", {
      id: 82, tenant_id: 2, site_id: 10,
      attendance: { id: 82, tenant_id: 2, employee_id: 43, site_id: 10, work_date: "2026-10-28" },
      employee: { id: 43, tenant_id: 2, site_id: 10, full_name: "موظف" },
    }) as Record<string, any>;
    expect(attendance.attendance.versionNo).toBe(0);
  });

  it("keeps attendance versions and bounded employee fields but never notes or audit identities", () => {
    const attendance = normalizeDeltaEntityRow("hr_attendance", {
      id: 81, tenant_id: 2, site_id: 10,
      attendance: {
        id: 81, tenant_id: 2, employee_id: 42, site_id: 10, work_date: "2026-10-28",
        regular_hours: "8", overtime_hours: "1", absent_days: "0",
        notes: "PRIVATE-ATTENDANCE-NOTE", created_by_user_id: 77, version_no: 6,
        created_at: "2026-10-28T00:00:00Z", updated_at: "2026-10-28T12:00:00Z",
      },
      employee: {
        id: 42, tenant_id: 2, site_id: null, full_name: "موظف", job_title: "worker", employment_status: "active",
        identity_no: "PRIVATE-ID", phone: "PRIVATE-PHONE", base_wage: "9999", notes: "PRIVATE-NOTE",
      },
    }) as Record<string, any>;
    expect(attendance.attendance).toMatchObject({ id: 81, employeeId: 42, versionNo: 6, notes: null, createdByUserId: null });
    expect(attendance.employee).toMatchObject({ id: 42, fullName: "موظف", siteId: null });
    for (const field of ["identityNo", "identity_no", "phone", "baseWage", "base_wage", "notes"]) {
      expect(attendance.employee).not.toHaveProperty(field);
    }
  });
});


describe("subscriber directory Delta projection", () => {
  const directoryScope = { tenantId: 2, siteId: 10 };
  const directoryRows = [
    normalizeDeltaEntityRow("subscribers", {
      id: 11, tenant_id: 2, site_id: 10, subscriber_no: "SUB-000011",
      full_name: "أحمد علي", phone: "0591000011", whatsapp_number: "0591000011",
      address: "النصر", subscription_type: "commercial", created_at: "2026-10-01T10:00:00Z",
    }),
    normalizeDeltaEntityRow("subscribers", {
      id: 12, tenant_id: 2, site_id: 10, subscriber_no: "SUB-000012",
      full_name: "محمد علي", phone: "0591000012", whatsapp_number: null,
      address: "الرمال", subscription_type: "residential", created_at: "2026-10-02T10:00:00Z",
    }),
    normalizeDeltaEntityRow("subscribers", {
      id: 13, tenant_id: 2, site_id: 11, subscriber_no: "SUB-000013",
      full_name: "أحمد خارج الفرع", phone: "0591000013",
      subscription_type: "commercial", created_at: "2026-10-03T10:00:00Z",
    }),
    normalizeDeltaEntityRow("subscribers", {
      id: 14, tenant_id: 9, site_id: 10, subscriber_no: "SUB-000014",
      full_name: "أحمد خارج المستأجر", phone: "0591000014",
      subscription_type: "commercial", created_at: "2026-10-04T10:00:00Z",
    }),
  ];

  it("rebuilds dynamic search/type filters from full scoped data with stable order/counts", () => {
    const result = projectSubscriberDirectoryPage(directoryRows, {
      siteId: 10, page: 1, pageSize: 20, search: "أحمد", subscriptionType: "commercial",
    }, directoryScope);
    expect(result.items.map((row) => row.id)).toEqual([11]);
    expect(result).toMatchObject({ totalCount: 1, totalPages: 1, page: 1, pageSize: 20 });
  });

  it("recounts and shifts pages when matching rows are added or removed from the Delta snapshot", () => {
    const all = projectSubscriberDirectoryPage(directoryRows, {
      siteId: 10, page: 1, pageSize: 20, search: "",
    }, directoryScope);
    const afterDelete = projectSubscriberDirectoryPage(directoryRows.filter((row) => row.id !== 12), {
      siteId: 10, page: 1, pageSize: 20, search: "",
    }, directoryScope);
    expect(all.totalCount).toBe(2);
    expect(afterDelete.totalCount).toBe(1);
    expect(afterDelete.items.map((row) => row.id)).toEqual([11]);
  });

  it("rejects projections for a different site scope", () => {
    expect(() => projectSubscriberDirectoryPage(directoryRows, {
      siteId: 11, page: 1, pageSize: 20, search: "",
    }, directoryScope)).toThrow(/نطاق/);
  });
});
