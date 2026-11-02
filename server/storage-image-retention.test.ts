import { describe, expect, it } from "vitest";
import { imageIsExpired, isEligibleImageRetentionKey, isImageEntry, STORAGE_IMAGE_RETENTION_PREFIXES } from "./storage-image-retention";

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
  });
});
