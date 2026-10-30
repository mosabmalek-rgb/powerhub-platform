import { describe, expect, it } from "vitest";
import {
  buildDashboardKpiRevisions,
  DASHBOARD_KPI_REVISION_DEPENDENCIES,
  DASHBOARD_KPI_REVISION_ENTITIES,
} from "./dashboard-kpi-revisions";

const baseRows = [
  { site_id: 10, entity_type: "invoices", last_cursor: "inv-1" },
  { site_id: 10, entity_type: "payments", last_cursor: "pay-1" },
  { site_id: 10, entity_type: "expenses", last_cursor: "exp-1" },
  { site_id: 10, entity_type: "generators", last_cursor: "gen-1" },
  { site_id: 10, entity_type: "company_accounts", last_cursor: "acc-1" },
];

describe("dashboard KPI revision dependencies", () => {
  it("declares one explicit journal dependency set per KPI", () => {
    expect(Object.keys(DASHBOARD_KPI_REVISION_DEPENDENCIES)).toEqual([
      "activeSubscribers", "generatorStatus", "periodInvoiced", "periodCollected",
      "collectionRate", "periodOverdue", "expenses", "netCash", "currentArrears",
      "financialOverview", "companyBalances",
    ]);
    expect(DASHBOARD_KPI_REVISION_ENTITIES).toEqual([
      "company_accounts", "company_accounts_all", "expenses", "generators", "invoices",
      "payments", "sites", "subscribers",
    ]);
  });

  it("invalidates only metrics whose journal sources advanced", () => {
    const before = buildDashboardKpiRevisions(baseRows, new Date("2026-10-30T12:00:00.000Z"));
    const after = buildDashboardKpiRevisions(
      baseRows.map((row) => row.entity_type === "invoices" ? { ...row, last_cursor: "inv-2" } : row),
      new Date("2026-10-30T12:00:00.000Z"),
    );

    expect(after.periodInvoiced).not.toBe(before.periodInvoiced);
    expect(after.collectionRate).not.toBe(before.collectionRate);
    expect(after.periodOverdue).not.toBe(before.periodOverdue);
    expect(after.currentArrears).not.toBe(before.currentArrears);
    expect(after.financialOverview).not.toBe(before.financialOverview);
    expect(after.periodCollected).toBe(before.periodCollected);
    expect(after.expenses).toBe(before.expenses);
    expect(after.netCash).toBe(before.netCash);
    expect(after.companyBalances).toBe(before.companyBalances);
    expect(after.generatorStatus).toBe(before.generatorStatus);
  });

  it("keeps account balances independent from cash flow and financial overview revisions", () => {
    const before = buildDashboardKpiRevisions(baseRows, new Date("2026-10-30T12:00:00.000Z"));
    const afterAccount = buildDashboardKpiRevisions(
      baseRows.map((row) => row.entity_type === "company_accounts" ? { ...row, last_cursor: "acc-2" } : row),
      new Date("2026-10-30T12:00:00.000Z"),
    );
    expect(afterAccount.companyBalances).not.toBe(before.companyBalances);
    expect(afterAccount.financialOverview).toBe(before.financialOverview);
    expect(afterAccount.netCash).toBe(before.netCash);
    expect(afterAccount.expenses).toBe(before.expenses);
  });

  it("advances overdue fingerprints as due-date status changes within a day", () => {
    const before = buildDashboardKpiRevisions(baseRows, new Date("2026-10-30T21:14:59.000Z"));
    const after = buildDashboardKpiRevisions(baseRows, new Date("2026-10-30T21:15:01.000Z"));
    expect(after.periodOverdue).not.toBe(before.periodOverdue);
    expect(after.currentArrears).not.toBe(before.currentArrears);
    expect(after.financialOverview).not.toBe(before.financialOverview);
    expect(after.periodInvoiced).toBe(before.periodInvoiced);
    expect(after.periodCollected).toBe(before.periodCollected);
  });

  it("advances monthly cash and expense fingerprints at UTC month rollover without a new row", () => {
    const before = buildDashboardKpiRevisions(baseRows, new Date("2026-10-31T23:59:00.000Z"));
    const after = buildDashboardKpiRevisions(baseRows, new Date("2026-11-01T00:00:00.000Z"));
    expect(after.expenses).not.toBe(before.expenses);
    expect(after.netCash).not.toBe(before.netCash);
    expect(after.periodOverdue).not.toBe(before.periodOverdue);
    expect(after.currentArrears).not.toBe(before.currentArrears);
  });

  it("ignores unrelated journal entities", () => {
    const before = buildDashboardKpiRevisions(baseRows, new Date("2026-10-30T12:00:00.000Z"));
    const after = buildDashboardKpiRevisions(
      [...baseRows, { site_id: 10, entity_type: "inventory_items", last_cursor: "item-1" }],
      new Date("2026-10-30T12:00:00.000Z"),
    );
    expect(after).toEqual(before);
  });
});
