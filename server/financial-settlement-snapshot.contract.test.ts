import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (file: string) => fs.readFileSync(path.resolve(process.cwd(), file), "utf8");
const router = read("server/powerhub.ts");
const page = read("client/src/pages/FinancialSettlementsPage.tsx");

describe("financial settlement branch-scoping UI contract", () => {
  it("uses the selected branch for access checks, preview, and new settlement creation", () => {
    expect(page).toContain("settlementAuthorizationSiteId=selectedBranchId??siteId");
    expect(page).toContain('staff.myAccess.useQuery({siteId:settlementAuthorizationSiteId}');
    expect(page).toContain('aria-label="فرع التسوية الجديدة"');
    expect(page).toContain("targetSettlementSiteId");
    expect(page).toContain("settlements.preview.useQuery({siteId:targetSettlementSiteId");
    expect(page).toContain("create.mutate({siteId:targetSettlementSiteId");
    expect(page).toContain("لا يمكن إنشاء تسوية على خيار جميع الفروع");
  });

  it("sends approval, locking, and exceptional edits with the row's actual site id", () => {
    expect(page).toContain('setStatus.mutate({siteId:row.siteId,settlementId:row.id,status:"submitted"})');
    expect(page).toContain('setStatus.mutate({siteId:row.siteId,settlementId:row.id,status:"approved"})');
    expect(page).toContain('setStatus.mutate({siteId:row.siteId,settlementId:row.id,status:"locked"})');
    expect(page).toContain("setExceptionalEditSiteId(row.siteId)");
    expect(page).toContain("siteId:exceptionalEditSiteId??selectedBranchId??siteId");
  });
});

describe("saved financial settlement ledger breakdown", () => {
  it("loads the persisted JSON snapshot and returns only the normalized projection", () => {
    const settlementsRoute = router.slice(router.indexOf("  settlements: router({"), router.indexOf("  reports: router({"));
    expect(settlementsRoute).toContain("ledger_snapshot");
    expect(settlementsRoute).toContain("normalizeSettlementLedgerSnapshot(row.ledger_snapshot)");
  });

  it("renders a clear legacy fallback when no saved snapshot exists", () => {
    expect(page).toContain("row.ledgerBreakdown ?");
    expect(page).toContain("لا تتوفر تفاصيل الدفتر المحفوظة لهذه التسوية التاريخية");
  });

  it("includes the saved breakdown in Excel and PDF without exporting the raw JSON snapshot", () => {
    expect(page).toContain('addWorksheet("تفاصيل الدفتر المحفوظة"');
    expect(page).toContain("ledgerSheet.addRow");
    expect(page).toContain("const detailsHtml=rows.map");
    expect(page).toContain("b?.subscriberCreditCreated");
    expect(page).toContain("cashBreakdown");
    expect(page).not.toContain("JSON.stringify(row.ledgerSnapshot)");
    expect(page).not.toContain("sourceFingerprint");
  });
});
