import { describe, expect, it } from "vitest";
import { mobileSyncApproveInput, mobileSyncBulkApprovalInput, mobileSyncReadingDetailInput, mobileSyncReadingsInput } from "./powerhub";

describe("mobile sync reading details input", () => {
  it("accepts a scoped reading-details request and supplies safe pagination defaults", () => {
    expect(mobileSyncReadingsInput.parse({ siteId: 12, userId: 8, from: "2026-08-23T00:00:00.000Z", to: "2026-08-23T23:59:59.999Z" }))
      .toMatchObject({ siteId: 12, userId: 8, page: 1, pageSize: 25 });
  });

  it("rejects unscoped, invalid, or oversized detail requests", () => {
    expect(mobileSyncReadingsInput.safeParse({ siteId: 0 }).success).toBe(false);
    expect(mobileSyncReadingsInput.safeParse({ siteId: 12, userId: 0 }).success).toBe(false);
    expect(mobileSyncReadingsInput.safeParse({ siteId: 12, page: 0 }).success).toBe(false);
    expect(mobileSyncReadingsInput.safeParse({ siteId: 12, pageSize: 101 }).success).toBe(false);
  });

  it("requires both the selected branch and reading identity for a detail page", () => {
    expect(mobileSyncReadingDetailInput.safeParse({ siteId: 12, readingId: 4 }).success).toBe(true);
    expect(mobileSyncReadingDetailInput.safeParse({ siteId: 0, readingId: 4 }).success).toBe(false);
    expect(mobileSyncReadingDetailInput.safeParse({ siteId: 12, readingId: 0 }).success).toBe(false);
  });

  it("limits individual and bulk approvals to a scoped, bounded request", () => {
    expect(mobileSyncApproveInput.safeParse({ siteId: 12, readingId: 4, baseVersion: 2 }).success).toBe(true);
    expect(mobileSyncApproveInput.safeParse({ siteId: 12, readingId: 4, baseVersion: 0 }).success).toBe(false);
    expect(mobileSyncBulkApprovalInput.parse({ siteId: 12 })).toMatchObject({ siteId: 12, limit: 100 });
    expect(mobileSyncBulkApprovalInput.safeParse({ siteId: 12, limit: 101 }).success).toBe(false);
  });
});
