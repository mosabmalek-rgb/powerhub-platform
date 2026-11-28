import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { InvalidFinancialOpeningDocument,
  openingDocumentHashMatches, openingDocumentDetails,
  parseOpeningDocumentBase64 } from "./financial-opening-evidence";

const pdf = Buffer.from("%PDF-1.7\nA28 genuine byte-bound test fixture\n%%EOF\n");
const sha = createHash("sha256").update(pdf).digest("hex");

describe("opening document custody byte validation", () => {
  it("derives SHA-256 only from actual bytes and roundtrips valid base64", () => {
    expect(parseOpeningDocumentBase64(pdf.toString("base64"), "application/pdf"))
      .toMatchObject({ byteSize:pdf.length,sha256:sha });
    expect(openingDocumentHashMatches(sha,sha)).toBe(true);
    expect(openingDocumentHashMatches(sha, "f".repeat(64))).toBe(false);
  });
  it("rejects forged MIME, encoded corruption, empty or oversized documents", () => {
    expect(()=>openingDocumentDetails(pdf,"image/jpeg")).toThrow(InvalidFinancialOpeningDocument);
    expect(()=>parseOpeningDocumentBase64("!@#@","application/pdf")).toThrow(InvalidFinancialOpeningDocument);
    expect(()=>parseOpeningDocumentBase64("abc","application/pdf")).toThrow(InvalidFinancialOpeningDocument);
    expect(()=>openingDocumentDetails(Buffer.alloc(0),"application/pdf")).toThrow();
    expect(()=>openingDocumentDetails(Buffer.alloc(5*1024*1024+1),"application/pdf")).toThrow();
    expect(openingDocumentHashMatches("x".repeat(64),sha)).toBe(false);
  });
  it("accepts valid image signatures but rejects extension/content mismatches", () => {
    const png=Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,1]);
    expect(openingDocumentDetails(png,"image/png").byteSize).toBe(png.length);
    expect(()=>openingDocumentDetails(png,"image/webp")).toThrow(InvalidFinancialOpeningDocument);
    const jpeg=Buffer.from([0xff,0xd8,0xff,0x01]);
    expect(openingDocumentDetails(jpeg,"image/jpeg").byteSize).toBe(jpeg.length);
  });
});
