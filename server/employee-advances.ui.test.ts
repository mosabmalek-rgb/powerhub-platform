import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read=(file:string)=>fs.readFileSync(path.resolve(process.cwd(),file),"utf8");

describe("employee advances and loans workflow contract",()=>{
  it("exposes a protected HR workspace tab and dedicated advances UI",()=>{
    const workspace=read("client/src/pages/HumanResourcesWorkspacePage.tsx");
    const ui=read("client/src/pages/EmployeeAdvancesPage.tsx");
    const payroll=read("client/src/pages/PayrollPage.tsx");
    const app=read("client/src/App.tsx");
    const preload=read("client/src/lib/route-preload.ts");
    expect(app).toContain('path={"/human-resources"}');
    expect(workspace).toContain('TabsTrigger value="advances"');
    expect(workspace).toContain("<EmployeeAdvancesPage embedded />");
    expect(ui).toContain("سلفة من الراتب");
    expect(ui).toContain("دين / قرض على الموظف");
    expect(ui).toContain("تسجيل سداد جزئي أو كامل");
    expect(payroll).toContain("cancelPayrollDraft");
    expect(payroll).toContain("إلغاء المسودة");
    expect(ui).toContain("operationKey:newKey()");
    expect(preload).toContain('"/human-resources": () => import("../pages/HumanResourcesWorkspacePage")');
  });

  it("keeps issue and repayment atomic, tenant scoped, audited, and idempotent in SQL",()=>{
    const migration=read("supabase/migrations/20261023194500_powerhub_employee_advances_loans.sql");
    const router=read("server/powerhub.ts");
    expect(migration).toContain("create table if not exists public.employee_adjustment_repayments");
    expect(migration).toContain("powerhub_issue_employee_advance");
    expect(migration).toContain("powerhub_repay_employee_advance");
    expect(migration).toContain("IDEMPOTENCY_KEY_REUSED");
    expect(migration).toContain("INSUFFICIENT_ACCOUNT_BALANCE");
    expect(migration).toContain("REPAYMENT_EXCEEDS_REMAINING");
    expect(migration).toContain("employee_advance");
    expect(migration).toContain("powerhub_create_payroll_draft");
    expect(migration).toContain("least(v_adjustment.remaining_amount,coalesce(v_adjustment.monthly_deduction,v_adjustment.remaining_amount))");
    expect(router).toContain("listEmployeeAdvances:");
    expect(router).toContain("issueEmployeeAdvance:");
    expect(router).toContain("repayEmployeeAdvance:");
    expect(router).toContain('requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "accountant"], "manageExpenses")');
  });
});
