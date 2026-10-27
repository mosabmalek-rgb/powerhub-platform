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
} from "./offline-delta-query-bridge";

const scope: DeltaCursorScope = { userId: 7, tenantId: 2, siteId: 10, entityType: "subscribers" };
const basePage = (changes: any[], entityType: any = "subscribers"): DeltaPage<Record<string, unknown>> => ({
  status: "ok", entity_type: entityType, current_cursor: "4", retained_from_cursor: "0",
  snapshot_cursor: null, through_cursor: "4", next_cursor: "4", has_more: false, changes,
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
