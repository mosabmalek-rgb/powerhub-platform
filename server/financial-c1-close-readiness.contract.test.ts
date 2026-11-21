import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync("docs/security/sql/pr359-financial-c1-staging-close-readiness-readonly.sql", "utf8");
const server = readFileSync("server/powerhub.ts", "utf8");
const report = readFileSync("docs/roadmaps/powerhub-finance-phase-c1-readiness-20261113.md", "utf8");

describe("financial C1 close readiness: fail closed, never certify", () => {
  it("executes only read-only fixture checks in a rolled-back transaction", () => {
    expect(sql).toMatch(/BEGIN TRANSACTION READ ONLY;/);
    expect(sql.trimEnd().endsWith("ROLLBACK;")).toBe(true);
    expect(sql).not.toMatch(/\b(COMMIT|INSERT INTO|UPDATE\s+\w+\s+SET|DELETE FROM|TRUNCATE|CREATE TABLE|ALTER TABLE)\b/i);
    for (const name of [
      "powerhub_financial_accrual_period_review_status",
      "powerhub_financial_accrual_month_statement",
      "C1_EXPECTED_STAGING_CLOSE_BLOCKERS_MISSING",
      "C1_UNBALANCED_LEDGER",
      "C1_PERIOD_SCOPE_OR_NONFINAL_GUARD_FAILED",
      "C1_STAGING_READ_ONLY_CLOSE_BLOCKERS_PASS_NOT_CERTIFIED",
    ]) expect(sql).toContain(name);
  });
  it("keeps separate server-authorized review read, save and lock paths", () => {
    for (const name of [
      "accrualMonthStatement: protectedProcedure",
      "accrualPeriodReviewStatus: protectedProcedure",
      "accrualPeriodReviewSave: protectedProcedure",
      "accrualPeriodReviewLock: protectedProcedure",
      '"viewFinancialReports"',
      '"manageExpenses"',
      "isFinalProfit:false as const",
      "isCompleteAccrualStatement:false as const",
      "p_user_id:ctx.user.id",
    ]) expect(server).toContain(name);
    expect(report).toContain("NOT_READY");
    expect(report).toContain("BLOCKED");
    expect(report).toContain("NOT_CERTIFIED");
  });
});
