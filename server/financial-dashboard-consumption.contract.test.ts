import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync("supabase/migrations/20261109110000_powerhub_financial_dashboard_inventory_consumption.sql","utf8");
const router = readFileSync("server/powerhub.ts","utf8");
const page = readFileSync("client/src/pages/FinancialDashboardPage.tsx","utf8");

describe("financial dashboard operating expense inclusion",()=>{
  it("matches the financial settlement's category, reversal, and return rules",()=>{
    const settlement = readFileSync("supabase/migrations/20261104215452_powerhub_settlement_inventory_consumption_cost.sql","utf8");
    for (const rule of [
      "i.category='fuel' AND m.movement_type='fuel_consumption'",
      "i.category IN ('oil','filter','maintenance_supply')",
      "i.category='spare_part'",
      "m.movement_type IN ('issue','fuel_consumption','return_from_issue')",
      "reversal.reversal_of_movement_id=m.id",
      "source.id=m.source_issue_movement_id",
    ]) {
      expect(migration).toContain(rule);
      expect(settlement).toContain(rule);
    }
    expect(migration).toContain("m.occurred_at < p_period_end_exclusive");
    expect(migration).toContain("THEN -m.total_cost_amount");
    expect(migration).toContain("SECURITY INVOKER");
    expect(migration).toContain("REVOKE ALL ON FUNCTION");
  });
  it("adds inventory consumption to direct expenses for single-site and all-branch reports",()=>{
    expect(router).toContain('rpc("powerhub_report_inventory_consumption_costs"');
    expect(router).toContain("const inventoryConsumptionCost = inventoryConsumption.get(input.siteId) ?? 0");
    expect(router).toContain("const expenseTotal = Math.round((directExpenseTotal + inventoryConsumptionCost) * 100) / 100");
    expect(router).toContain("inventoryConsumptionCost: total.inventoryConsumptionCost + branch.inventoryConsumptionCost");
    expect(router).toContain('No silent fallback to');
    expect(router).toContain("operatingProfit: collected - expenseTotal");
  });
  it("explains the expense components in cards, CSV and PDF, avoiding cash-flow mislabelling",()=>{
    expect(page).toContain("مصروفات مسجلة مباشرة");
    expect(page).toContain("صافي تكلفة استهلاك المخزون");
    expect(page).toContain("فائض التحصيل بعد المصروفات");
    expect(page).toContain("["+'"'+"تكلفة استهلاك المخزون"+'"'+", data.summary.inventoryConsumptionCost]");
    expect(page).toContain("المصروفات المباشرة:");
  });
});
