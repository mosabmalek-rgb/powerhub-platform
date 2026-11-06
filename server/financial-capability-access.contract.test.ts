import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("financial capability enforcement", () => {
  it("separates invoice and payment collection reads from broad financial reporting", () => {
    const router = read("server/powerhub.ts");
    expect(router).toContain('requireSupabaseSiteAnyCapability(ctx.user.id, input.siteId, ["issueInvoices", "collectPayments", "viewFinancialReports"])');
    expect(router).toContain('requireSupabaseSiteAnyCapability(ctx.user.id, input.siteId, ["collectPayments", "viewFinancialReports"])');
    expect(router).not.toContain('requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "collector", "viewer"]);\n      return listSupabaseInvoices');
    expect(router).not.toContain('requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "collector", "viewer"]);\n      return listSupabasePayments');
  });

  it("does not let site membership or viewer role expose expenses, deposits, or financial reports", () => {
    const router = read("server/powerhub.ts");
    expect(router).toContain('requireSupabaseSiteAnyCapability(ctx.user.id, input.siteId, ["manageExpenses", "viewFinancialReports"])');
    expect(router).toContain('requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "viewFinancialReports")');
    expect(router).toContain('requireSupabaseAllBranchesRole(ctx.user.id, input.siteId, ["manager", "accountant", "viewer"], "viewFinancialReports")');
    expect(router).toContain('securityDeposit: canViewFinancialReports ? String(data?.[0]?.security_deposit ?? 0) : null');
    expect(router).toContain('financial: canViewFinancial ? {');
  });

  it("keeps collection credit visible without exposing the subscriber security deposit to collectors", () => {
    const router = read("server/powerhub.ts");
    expect(router).toContain('["collectPayments", "viewFinancialReports"]');
    expect(router).toContain('securityDeposit: canViewFinancialReports ? String(data?.[0]?.security_deposit ?? 0) : null');
    expect(router).toContain('await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "viewFinancialReports")');
  });

  it("applies capability checks to both financial Delta feeds and full snapshots", () => {
    const router = read("server/powerhub.ts");
    expect(router).toContain("const isFinancialDeltaEntity = [\\"invoices\\", \\"payments\\", \\"expenses\\", \\"company_accounts\\", \\"company_accounts_all\\"].includes(input.entityType)");
    expect(router).toContain('["manageExpenses", "viewFinancialReports"]');
    expect(router).toContain('["collectPayments", "viewFinancialReports"]');
    expect(router).toContain('requireSupabaseAllBranchesRole(ctx.user.id, input.siteId, ["manager", "accountant", "viewer"], "viewFinancialReports")');
  });

  it("guards complete financial reports and settlement statements", () => {
    const router = read("server/powerhub.ts");
    expect(router).toContain('requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "viewer"], "viewFinancialReports")');
    expect(router).toContain('requireSupabaseAllBranchesRole(ctx.user.id, input.siteId, ["manager", "accountant", "viewer"], "viewFinancialReports")');
    expect(router).toContain('requireSupabaseSiteAnyCapability(ctx.user.id, input.siteId, ["manageExpenses", "viewFinancialReports"])');
  });

  it("keeps role defaults least-privilege and supports explicit financial report grants", () => {
    const rbac = read("shared/powerhub-rbac.ts");
    const tests = read("shared/powerhub-rbac.test.ts");
    expect(rbac).toContain('viewFinancialReports: ["owner", "manager", "accountant"]');
    expect(rbac).toContain('viewFinancialReports: "عرض التقارير والبيانات المالية"');
    expect(tests).toContain('expect(can("collector", "viewFinancialReports")).toBe(false)');
    expect(tests).toContain('expect(can("viewer", "viewFinancialReports", ["viewFinancialReports"])).toBe(true)');
  });

  it("uses the effective site permission and deny-only platform policy for all-branch reports", () => {
    const access = read("server/powerhub-supabase.ts");
    expect(access).toContain("export async function requireSupabaseAllBranchesRole(");
    expect(access).toContain("permissions.includes(capability)");
    expect(access).toContain('eq("capability", capability)');
    expect(access).toContain("staff_profile_capability_overrides");
    expect(access).toContain("custom_permission_roles");
  });
});
