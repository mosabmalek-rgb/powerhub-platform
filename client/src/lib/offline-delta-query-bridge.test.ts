import { describe, expect, it } from "vitest";
import type { DeltaCursorScope, DeltaPage } from "./offline-delta-sync";
import {
  applyDeltaPageToList,
  normalizeDeltaEntityRow,
  normalizeDeltaPage,
  refreshReadingSubscriberProjection,
  snapshotRowsFromQuery,
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
