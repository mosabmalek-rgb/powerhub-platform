import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read=(path:string)=>readFileSync(path,"utf8");
const router=read("server/powerhub.ts");
const access=read("client/src/components/RouteAccessGate.tsx");
const app=read("client/src/App.tsx");
const menu=read("client/src/components/DashboardLayout.tsx");
const reports=read("client/src/pages/ReportsPage.tsx");
const company=read("client/src/pages/CompanyAccountsPage.tsx");
const staff=read("client/src/pages/SettingsPage.tsx");
const gl=read("client/src/components/finance/FinancialGLAuditPanel.tsx");
const dashboard=read("client/src/pages/FinancialDashboardPage.tsx");

describe("one-site subscription limit takes precedence",()=>{
  it("forces effective single-site even if admin enabled and legacy branches remain",()=>{
    const start=router.indexOf("export function resolveBranchPolicy(");
    const end=router.indexOf("async function requireTenantMultiBranchEntitlement(",start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const implementation=router.slice(start,end);
    expect(implementation).toContain("const maxBranches =");
    expect(implementation).toContain("const isEnabled = maxBranches > 1 &&");
    expect(implementation).toContain("isEnabledOverride ?? (platformEnabled && planLimit > 1)");
  });
  it("does not unlock finance or role grants based on legacy multi-site rows",()=>{
    expect(router).toContain("enabled:policy.isEnabled===true && policy.maxBranches>1");
    expect(router).toContain("if(policy.isEnabled!==true || policy.maxBranches<=1)");
    expect(menu).toContain('shouldShowBranchManagement(branchPolicy.data, displayUser.role)');
    expect(reports).toContain("const canUseAllBranches = multiBranchEnabled");
    expect(company).toContain("multiBranchAccess.data?.enabled===true");
    expect(staff).toContain('allBranches: multiBranchEnabled && data.get("allBranches") === "on"');
  });
});

describe("subscription-controlled multi-branch surfaces",()=>{
  it("sources eligibility from tenant's platform, package and override policies, not site count alone",()=>{
    const route=router.slice(router.indexOf("multiBranchAccess: protectedProcedure"),router.indexOf("branchPolicy: protectedProcedure"));
    expect(route).toContain("requireSupabaseSiteRole(ctx.user.id,input.siteId");
    expect(route).toContain('.eq("tenant_id",access.tenantId)');
    expect(route).toContain('.eq("setting_key","branch_feature")');
    expect(route).toContain('from("tenant_branch_settings")');
    expect(route).toContain("resolveBranchPolicy");
    expect(route).toContain("enabled:policy.isEnabled===true && policy.maxBranches>1");
    expect(route).toContain('code:"INTERNAL_SERVER_ERROR"');
  });
  it("blocks a pasted /branches URL before rendering the branch page",()=>{
    expect(app).toContain("<RouteAccessGate multiBranchOnly><BranchesPage />");
    expect(access).toContain("function MultiBranchRouteGate");
    expect(access).toContain("multiBranchAccess.useQuery({siteId}");
    expect(access).toContain("entitlement.data?.enabled!==true");
    expect(access).toContain("entitlement.isFetching");
    expect(access).toContain("return <>{children}</>");
    expect(menu).toContain('shouldShowBranchManagement(branchPolicy.data, displayUser.role)');
  });
  it("retains site-only finance while concealing inter-site accounting when disabled",()=>{
    expect(gl).toContain("multiBranchAccess.data?.enabled===true");
    expect(gl).toContain("{hasMultipleSites ? <>");
    expect(dashboard).toContain("multiBranchAccess.data?.enabled===true");
    expect(dashboard).toContain("hasMultipleBranches && showAllBranches");
  });
  it("hides all-branch report filter, comparison and exported section",()=>{
    expect(reports).toContain("multiBranchEnabled && tenantSites.length>1 ? <select");
    expect(reports).toContain('section!=="branches" || (multiBranchEnabled && tenantSites.length>1)');
    expect(reports).toContain("sections={visibleReportSections}");
    expect(reports).toContain("allowBranchSection={multiBranchEnabled && tenantSites.length>1}");
    expect(reports).toContain('scope === "all" && canUseAllBranches ? allReportQuery : branchReportQuery');
    expect(reports).toContain("canCompareBranches && <option");
  });
  it("conceals company-account multi-site link controls and optional export columns",()=>{
    expect(company).toContain("multiBranchAccess.data?.enabled===true");
    expect(company).toContain("{multiBranchEnabled ? <select");
    expect(company).toContain("{multiBranchEnabled ? <div");
    expect(company).toContain('multiBranchEnabled ? ["الفروع"] : []');
    expect(company).toContain('siteIds: multiBranchEnabled && selectedSites.length ? selectedSites : [siteId]');
  });
  it("cannot use staff all-branch grant through hidden checkbox or a forged API call",()=>{
    expect(staff).toContain('allBranches: multiBranchEnabled && data.get("allBranches") === "on"');
    expect(staff).toContain('{multiBranchEnabled ? <label');
    expect(router).toContain("if(input.allBranches) await requireTenantMultiBranchEntitlement(access.tenantId)");
    expect(router).toContain('message:"هذا الاشتراك لا يتيح منح صلاحية جميع الفروع."');
  });
  it("protects every multi-site financial server endpoint from direct API bypass",()=>{
    for(const name of [
      "allSitesCurrentPosition","allBranchesRange","financialGLTenantRollup",
      "financialGLCentralPolicyWorkspace","financialGLCentralPolicyPreview",
      "financialGLCentralPolicyPrepare","financialGLCentralPolicyApprove",
      "financialGLPrepareInterSiteElimination","financialGLApproveInterSiteElimination",
      "financialGLCreateInterSiteTransfer","financialGLPostInterSiteTransfer"
    ]){
      const start=router.indexOf(name+": protectedProcedure");
      expect(start).toBeGreaterThanOrEqual(0);
      const body=router.slice(start,start+2500);
      expect(body).toContain("await requireTenantMultiBranchEntitlement(");
    }
  });
});
