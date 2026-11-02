import { beforeEach, describe, expect, it, vi } from "vitest";

const { supabaseAdminMock } = vi.hoisted(() => ({ supabaseAdminMock: vi.fn() }));
vi.mock("./supabase-admin", () => ({ supabaseAdmin: supabaseAdminMock }));

import {
  cleanupExpiredStorageImages,
  imageIsExpired,
  isEligibleImageRetentionKey,
  isImageEntry,
  STORAGE_IMAGE_RETENTION_PREFIXES,
} from "./storage-image-retention";

describe("15-day image retention classification",()=>{
  const cutoff=new Date("2026-10-17T00:00:00.000Z");
  it("expires uploaded images at 15 days and retains newer images",()=>{
    expect(imageIsExpired({id:"1",name:"old.jpg",created_at:"2026-10-16T23:59:59.000Z",metadata:{mimetype:"image/jpeg"}},cutoff)).toBe(true);
    expect(imageIsExpired({id:"2",name:"new.jpg",created_at:"2026-10-17T00:00:01.000Z",metadata:{mimetype:"image/jpeg"}},cutoff)).toBe(false);
  });
  it("retains PDFs and non-image documents",()=>{
    expect(isImageEntry({name:"receipt.pdf",metadata:{mimetype:"application/pdf"}})).toBe(false);
    expect(isImageEntry({name:"scan.bin",metadata:{mimetype:"image/heic"}})).toBe(true);
  });
  it("does not guess expiry when Storage creation time is missing",()=>{
    expect(imageIsExpired({id:"3",name:"unknown.jpg",created_at:null,metadata:{mimetype:"image/jpeg"}},cutoff)).toBe(false);
  });
});

describe("image retention namespace allowlist",()=>{
  it("only includes application image-upload namespaces",()=>{
    expect(STORAGE_IMAGE_RETENTION_PREFIXES).toEqual(["payment-receipts","subscriber-readings","chat"]);
    expect(isEligibleImageRetentionKey("payment-receipts/tenant/file.jpg")).toBe(true);
    expect(isEligibleImageRetentionKey("subscriber-readings/mobile/worker/file.webp")).toBe(true);
    expect(isEligibleImageRetentionKey("chat/tenant/conversation/message/file.png")).toBe(true);
  });
  it("never includes permanent branding, exports, arbitrary bucket roots, or traversal paths",()=>{
    expect(isEligibleImageRetentionKey("logos/company.png")).toBe(false);
    expect(isEligibleImageRetentionKey("brand-assets/logo.png")).toBe(false);
    expect(isEligibleImageRetentionKey("exports/report.png")).toBe(false);
    expect(isEligibleImageRetentionKey("tenant/receipt.png")).toBe(false);
    expect(isEligibleImageRetentionKey("../payment-receipts/file.png")).toBe(false);
    expect(isEligibleImageRetentionKey("payment-receipts/../logos/logo.png")).toBe(false);
    expect(isEligibleImageRetentionKey("payment-receipts//file.png")).toBe(false);
    expect(isEligibleImageRetentionKey("payment-receipts/a" + String.fromCharCode(92) + "b.png")).toBe(false);
  });
});


describe("storage image retention execution safety", () => {
  const expiredImage = {
    id: "object-1",
    name: "receipt.jpg",
    created_at: "2026-10-01T00:00:00.000Z",
    metadata: { mimetype: "image/jpeg" },
  };

  function createAdminMock(options: { referenceCleanupError?: boolean } = {}) {
    const remove = vi.fn(async () => ({ data: [], error: null }));
    const list = vi.fn(async (path: string) => ({
      data: path === "payment-receipts" ? [expiredImage] : [],
      error: null,
    }));
    const updates = new Map<string, ReturnType<typeof vi.fn>>();
    const from = vi.fn((table: string) => {
      const query: any = {
        select: vi.fn(() => query),
        not: vi.fn(() => query),
        range: vi.fn(async () => ({ data: [], error: null })),
        update: vi.fn(() => query),
        eq: vi.fn(() => query),
        in: vi.fn(async () => ({
          data: [],
          error: options.referenceCleanupError && table === "meter_readings"
            ? { message: "simulated reference cleanup failure" }
            : null,
        })),
      };
      updates.set(table, query.update);
      return query;
    });
    const storageFrom = vi.fn(() => ({ list, remove }));
    supabaseAdminMock.mockReturnValue({
      storage: { from: storageFrom },
      from,
    });
    return { remove, list, from, storageFrom, updates };
  }

  beforeEach(() => {
    supabaseAdminMock.mockReset();
  });

  it("reports expired images without mutating Storage or database references in dry-run mode", async () => {
    const admin = createAdminMock();

    const result = await cleanupExpiredStorageImages(
      new Date("2026-11-02T00:00:00.000Z"),
      { dryRun: true },
    );

    expect(result.dryRun).toBe(true);
    expect(result.expiredImagesFound).toBe(1);
    expect(result.deleted).toBe(0);
    expect(result.failed).toBe(0);
    expect(admin.storageFrom).toHaveBeenCalledTimes(3);
    expect(admin.remove).not.toHaveBeenCalled();
    expect(Array.from(admin.updates.values()).every((update) => update.mock.calls.length === 0)).toBe(true);
  });

  it("detaches known references before removing an eligible expired image", async () => {
    const admin = createAdminMock();

    const result = await cleanupExpiredStorageImages(
      new Date("2026-11-02T00:00:00.000Z"),
      { dryRun: false },
    );

    expect(result.dryRun).toBe(false);
    expect(result.expiredImagesFound).toBe(1);
    expect(result.deleted).toBe(1);
    expect(result.failed).toBe(0);
    expect(admin.remove).toHaveBeenCalledWith(["payment-receipts/receipt.jpg"]);
    const appliedUpdates = Array.from(admin.updates.values()).filter((update) => update.mock.calls.length > 0);
    expect(appliedUpdates).toHaveLength(4);
    expect(appliedUpdates.every((update) => update.mock.calls.length === 1)).toBe(true);
  });

  it("does not remove an object when any reference cleanup operation fails", async () => {
    const admin = createAdminMock({ referenceCleanupError: true });

    const result = await cleanupExpiredStorageImages(
      new Date("2026-11-02T00:00:00.000Z"),
      { dryRun: false },
    );

    expect(result.expiredImagesFound).toBe(1);
    expect(result.deleted).toBe(0);
    expect(result.failed).toBe(1);
    expect(admin.remove).not.toHaveBeenCalled();
  });
});
