import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (file: string) => fs.readFileSync(path.resolve(process.cwd(), file), "utf8");
const router = read("server/powerhub.ts");
const page = read("client/src/pages/FinancialSettlementsPage.tsx");

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
