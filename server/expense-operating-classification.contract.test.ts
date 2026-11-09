import { readFileSync } from "node:fs";
import { describe,expect,it } from "vitest";
const migration=readFileSync("supabase/migrations/20261109123000_powerhub_expense_operating_classification.sql","utf8");
const operation=readFileSync("client/src/pages/OperationsPage.tsx","utf8");
const router=readFileSync("server/powerhub.ts","utf8");
const reader=readFileSync("server/powerhub-supabase.ts","utf8");
const finance=readFileSync("client/src/pages/FinancialDashboardPage.tsx","utf8");
describe("expense classification across expense form, offline and reporting",()=>{
  it("defaults to operating and has a clearly selectable non-operating option",()=>{
    expect(operation).toContain('name="expenseClassification" defaultValue="operating"');
    expect(operation).toContain('value="non_operating"');
    expect(operation).toContain("expenseClassification: payload.expenseClassification");
    expect(router).toContain('expenseClassification: z.enum(["operating", "non_operating"]).default("operating")');
    expect(reader).toContain("expense_classification");
  });
  it("retains financial posting idempotency and prevents conflicting classification replays",()=>{
    expect(migration).toContain("DEFAULT 'operating'");
    expect(migration).toContain("powerhub_create_expense_with_account_idempotent(");
    expect(migration).toContain("IF v_created.replayed THEN");
    expect(migration).toContain("IDEMPOTENCY_KEY_REUSED");
    expect(migration).toContain("REVOKE ALL ON FUNCTION");
    expect(migration).toContain("TO service_role");
  });
  it("separates operational and non-operational costs without duplicate inventory or payroll costs",()=>{
    expect(router).toContain('expense.expenseClassification === "non_operating"');
    expect(router).toContain('nonOperatingExpenseTotal');
    expect(router).toContain("inventoryConsumptionCost");
    expect(finance).toContain("المصروفات غير التشغيلية");
    expect(finance).toContain("المصروفات المباشرة التشغيلية");
    expect(reader).toContain('expenseClassification: row.expense_classification');
  });
});
