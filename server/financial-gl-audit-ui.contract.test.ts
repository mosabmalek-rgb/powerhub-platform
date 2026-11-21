import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const panel = readFileSync("client/src/components/finance/FinancialGLAuditPanel.tsx", "utf8");
const dashboard = readFileSync("client/src/pages/FinancialDashboardPage.tsx", "utf8");
const router = readFileSync("server/powerhub.ts", "utf8");
const openingEvidence = readFileSync(
  "supabase/migrations/20261110022000_powerhub_financial_gl_opening_evidence_gate.sql", "utf8",
);

describe("financial GL audit fail-closed UX", () => {
  it("is optional and fetches the scoped report only while explicitly open", () => {
    expect(dashboard).toContain("const [showGLAudit, setShowGLAudit] = useState(false)");
    expect(dashboard).toContain("showGLAudit && siteId && cycleRangeReady");
    expect(dashboard).toContain("FinancialGLAuditPanel");
    expect(panel).toContain("financialGLSourceCoverage.useQuery({ siteId, period }");
    expect(panel).toContain("enabled, staleTime:");
    expect(panel).toContain("financialGLTrialBalance.useQuery({ siteId, period }");
    expect(panel).toContain("enabled: enabled && showTrial");
  });

  it("does not confuse an opening balance with independently audited subledgers", () => {
    for (const term of [
      "isOpeningStructurallyPosted",
      "isOpeningReconciled",
      "accountBalancesMatchedToOpening",
      "sourceSubledgersIndependentlyVerified",
      "unreconciledSourceCount",
      "performanceFixtureTagged",
      "integrity.isClean",
      "accountingCertification",
    ]) {
      expect(panel).toContain(term);
    }
    expect(panel).toContain("غير معتمدة محاسبيًا");
    expect(openingEvidence).toContain("'isOpeningReconciled',false");
    expect(openingEvidence).toContain("'isOpeningStructurallyPosted'");
  });

  it("has no unscoped database access or partial stale success on query failure", () => {
    expect(router).toContain("financialGLSourceCoverage: protectedProcedure");
    expect(router).toContain("financialGLTrialBalance: protectedProcedure");
    expect(router).toContain('"viewFinancialReports"');
    expect(panel).toContain("!coverage.isError && !coverage.isFetching");
    expect(panel).toContain("!trial.isError && !trial.isFetching");
    expect(panel).toContain("تعذر إكمال تدقيق المصادر");
    expect(panel).toContain("تعذر مطابقة ميزان المراجعة");
    expect(panel).not.toContain("createClient(");
    expect(panel).not.toContain("supabaseAdmin()");
  });
});
