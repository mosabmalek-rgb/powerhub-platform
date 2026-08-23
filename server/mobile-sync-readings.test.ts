import { describe, expect, it } from "vitest";
import { mobileSyncReadingsInput } from "./powerhub";

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
});
