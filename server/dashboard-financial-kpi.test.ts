import { describe, expect, it } from "vitest";
import { buildDashboardFinancialKpi } from "./dashboard-financial-kpi";

describe("buildDashboardFinancialKpi", () => {
  it("calculates the current-month expense total without reading payment rows", () => {
    expect(buildDashboardFinancialKpi({
      metric: "expenses",
      expenses: [{ amount: "0.10" }, { amount: "0.20" }],
    })).toMatchObject({ metric: "expenses", expenses: 0.3, collected: 0, netCash: -0.3 });
  });

  it("calculates monthly net cash using only completed collections and expenses", () => {
    expect(buildDashboardFinancialKpi({
      metric: "netCash",
      expenses: [{ amount: "12.35" }],
      payments: [
        { status: "completed", amount: "20.10" },
        { status: "pending", amount: "999.00" },
      ],
    })).toMatchObject({ metric: "netCash", expenses: 12.35, collected: 20.1, netCash: 7.75 });
  });

  it("calculates outstanding and overdue balances with exact minor-unit arithmetic", () => {
    expect(buildDashboardFinancialKpi({
      metric: "currentArrears",
      now: new Date("2026-10-30T12:00:00.000Z"),
      arrears: [
        { siteId: 1, subscriberId: 10, dueDate: "2026-10-01T00:00:00.000Z", balanceDue: "0.10", status: "partially_paid" },
        { siteId: 1, subscriberId: 10, dueDate: "2026-10-31T00:00:00.000Z", balanceDue: "0.20", status: "issued" },
        { siteId: 2, subscriberId: 10, dueDate: "2026-10-20T00:00:00.000Z", balanceDue: "1.00", status: "issued" },
        { siteId: 2, subscriberId: 20, dueDate: "2026-10-20T00:00:00.000Z", balanceDue: "0.00", status: "issued" },
      ],
    })).toMatchObject({
      metric: "currentArrears", outstanding: 1.3, overdue: 1.1, partialInvoices: 1, accountCount: 2,
    });
  });
});
