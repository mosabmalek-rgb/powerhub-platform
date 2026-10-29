import { describe, expect, it } from "vitest";
import {
  filterPaymentDocumentationApprovalSnapshots,
  paymentDocumentationApprovalSnapshotKey,
  paymentDocumentationApprovalSnapshotScope,
  PAYMENT_DOCUMENTATION_APPROVAL_SNAPSHOT_TTL_MS,
  type OfflinePaymentDocumentationApprovalSnapshot,
} from "./offline-payment-documentation-approvals";

const baseScope = paymentDocumentationApprovalSnapshotScope({
  status: "pending",
  period: "date_range",
  fromDate: "2026-10-01",
  toDate: "2026-10-29",
});

function snapshot(overrides: Partial<OfflinePaymentDocumentationApprovalSnapshot> = {}): OfflinePaymentDocumentationApprovalSnapshot {
  return {
    id: 10,
    userId: 7,
    siteId: 3,
    snapshotScope: baseScope,
    savedAt: 10_000,
    invoiceNo: "INV-10",
    subscriberName: "مشترك الاختبار",
    subscriberNo: "S-10",
    paymentAmount: 25,
    invoiceBalance: 80,
    paymentMethod: "jawwal_pay",
    destinationAccountId: 12,
    submittedAt: "2026-10-20T10:00:00.000Z",
    status: "pending",
    ...overrides,
  };
}

describe("payment-documentation offline approval snapshot scope", () => {
  it("includes user, branch, exact filter scope, and request identity in storage keys", () => {
    const key = paymentDocumentationApprovalSnapshotKey(7, 3, baseScope, 10);
    expect(key).toContain("user:7");
    expect(key).toContain("site:3");
    expect(key).toContain(baseScope);
    expect(key).toContain("request:10");
    expect(paymentDocumentationApprovalSnapshotKey(8, 3, baseScope, 10)).not.toBe(key);
    expect(paymentDocumentationApprovalSnapshotKey(7, 4, baseScope, 10)).not.toBe(key);
    expect(paymentDocumentationApprovalSnapshotKey(7, 3, baseScope + " ", 10)).not.toBe(key);
    expect(() => paymentDocumentationApprovalSnapshotKey(0, 3, baseScope, 10)).toThrow();
  });

  it("uses stable filter signatures and changes scope when status, period, or dates change", () => {
    expect(paymentDocumentationApprovalSnapshotScope({
      status: "pending",
      period: "date_range",
      fromDate: "2026-10-01",
      toDate: "2026-10-29",
    })).toBe(baseScope);
    expect(paymentDocumentationApprovalSnapshotScope({
      status: "pending", period: "date_range", fromDate: "2026-10-02", toDate: "2026-10-29",
    })).not.toBe(baseScope);
    expect(paymentDocumentationApprovalSnapshotScope({
      status: "all", period: "date_range", fromDate: "2026-10-01", toDate: "2026-10-29",
    })).not.toBe(baseScope);
    expect(paymentDocumentationApprovalSnapshotScope({
      status: "pending", period: "all_time",
    })).not.toBe(baseScope);
  });

  it("returns only pending rows for the exact user, branch, filter scope, and TTL", () => {
    const rows = [
      snapshot({ id: 10 }),
      snapshot({ id: 11, submittedAt: "2026-10-21T10:00:00.000Z" }),
      snapshot({ id: 12, userId: 8 }),
      snapshot({ id: 13, siteId: 4 }),
      snapshot({ id: 14, snapshotScope: baseScope + " " }),
      snapshot({ id: 15, savedAt: 10_000 - PAYMENT_DOCUMENTATION_APPROVAL_SNAPSHOT_TTL_MS - 1 }),
      snapshot({ id: 16, savedAt: 10_001 }),
      snapshot({ id: 17, status: "approved" as "pending" }),
      snapshot({ id: 0 }),
    ];
    const result = filterPaymentDocumentationApprovalSnapshots(rows, {
      userId: 7,
      siteId: 3,
      snapshotScope: baseScope,
      now: 10_000,
    });
    expect(result.map(row => row.id)).toEqual([11, 10]);
  });

  it("fails closed when identity or the exact filter scope is missing", () => {
    const rows = [snapshot()];
    expect(filterPaymentDocumentationApprovalSnapshots(rows, {
      userId: 0, siteId: 3, snapshotScope: baseScope, now: 10_000,
    })).toEqual([]);
    expect(filterPaymentDocumentationApprovalSnapshots(rows, {
      userId: 7, siteId: 0, snapshotScope: baseScope, now: 10_000,
    })).toEqual([]);
    expect(filterPaymentDocumentationApprovalSnapshots(rows, {
      userId: 7, siteId: 3, snapshotScope: "", now: 10_000,
    })).toEqual([]);
  });
});
