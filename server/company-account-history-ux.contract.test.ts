import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = readFileSync("client/src/pages/CompanyAccountsPage.tsx", "utf8");
const banner = readFileSync("client/src/components/OfflineStatusBanner.tsx", "utf8");
const receipt = readFileSync("client/src/lib/payment-receipt-image.ts", "utf8");

describe("company account movement view and offline status contracts", () => {
  it("defaults to the authoritative current cycle, with 30 movements and explicit date options", () => {
    expect(page).toContain('useState<MovementPeriod>("cycle")');
    expect(page).toContain("readingCycle.currentBounds.useQuery");
    expect(page).toContain("limit: 30");
    expect(page).toContain("const pageSize = 30");
    for (const caption of ["اليوم", "هذه الدورة", "هذا الشهر", "مخصص"]) {
      expect(page).toContain(caption);
    }
    expect(page).toContain("movementRangeReady && movementDatesValid");
    expect(page).toContain("movementRange.start || undefined");
    expect(page).toContain("movementRange.end || undefined");
  });

  it("replaces the obstructing full-width banner with an accessible corner icon", () => {
    expect(banner).toContain("CloudOff");
    expect(banner).toContain('aria-expanded={expanded}');
    expect(banner).toContain('aria-label="حالة الاتصال بالخادم"');
    expect(banner).toContain("safe-area-inset-bottom");
    expect(banner).not.toContain("fixed inset-x-0 top-0");
  });

  it("keeps existing receipt image resizing and compression", () => {
    expect(receipt).toContain("PAYMENT_RECEIPT_IMAGE_MAX_DIMENSION = 1600");
    expect(receipt).toContain("PAYMENT_RECEIPT_IMAGE_QUALITY = 0.78");
    expect(receipt).toContain('canvasToBlob(canvas, "image/webp"');
    expect(receipt).toContain('canvasToBlob(canvas, "image/jpeg"');
  });
});
