import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const provenance = readFileSync(
  "docs/security/sql/pr359-staging-performance-fixture-provenance-audit.sql", "utf8",
);
const acceptance = readFileSync(
  "docs/security/sql/pr359-financial-phase-a-final-readonly-acceptance.sql", "utf8",
);
const dashboard = readFileSync(
  "client/src/components/finance/FinancialGLAuditPanel.tsx", "utf8",
);

describe("Phase A financial acceptance evidence", () => {
  it("qualifies but never silently removes or relabels synthetic bank movements", () => {
    for (const evidence of [
      "d.count=250000",
      "d.unknown_reference=0",
      "d.unknown_description=0",
      "d.attributed_to_user=0",
      "d.non_fixture_type=0",
      "d.unexpected_amount=0",
      "d.linked_business_sources=0",
      "d.outside_fixture_dates=0",
      "x.other_table_references=0",
      "p.collections<>62500",
      "p.withdrawals<>62500",
      "p.signed_amount<>0",
      "BLOCKED_MANUAL_REVIEW_REQUIRED",
      "ARCHIVE_CANDIDATE_VERIFIED_NOT_ARCHIVED",
    ]) expect(provenance).toContain(evidence);
    expect(provenance).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(provenance).not.toMatch(/\bUPDATE\s+public\./i);
    expect(provenance).not.toMatch(/\bTRUNCATE\b/i);
    expect(provenance).not.toContain("DISABLE TRIGGER");
  });

  it("requires independent opening evidence, non-zero GL and complete sources", () => {
    for (const signal of [
      "gl_entries>0",
      "opening_reconciled IS TRUE",
      "matched_opening IS TRUE",
      "verified_subledgers IS TRUE",
      "source_clean IS TRUE",
      "unresolved=0",
      "performance_fixtures=0",
      "balance_difference=0",
      "phase_a_accounting_acceptance",
    ]) expect(acceptance).toContain(signal);
    expect(acceptance).toContain("BLOCKED");
    expect(acceptance).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(acceptance).not.toMatch(/\bUPDATE\s+public\./i);
  });

  it("never renders balanced GL or synthetic archive eligibility as certification", () => {
    expect(dashboard).toContain("غير معتمدة محاسبيًا");
    expect(dashboard).toContain("isOpeningReconciled");
    expect(dashboard).toContain("sourceSubledgersIndependentlyVerified");
    expect(dashboard).toContain("performanceFixtureTagged");
  });
});
