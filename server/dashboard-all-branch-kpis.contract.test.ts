import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(resolve(process.cwd(), "supabase/migrations/20261011213932_20261012110000_powerhub_dashboard_all_branch_kpis.sql"), "utf8");
const router = readFileSync(resolve(process.cwd(), "server/powerhub-dashboard.ts"), "utf8");
const trendSection = readFileSync(resolve(process.cwd(), "client/src/components/FinancialTrendSection.tsx"), "utf8");
const home = readFileSync(resolve(process.cwd(), "client/src/pages/Home.tsx"), "utf8");
const kpiComponent = readFileSync(resolve(process.cwd(), "client/src/components/ConsumptionKpiSection.tsx"), "utf8");

describe("dashboard all-branch KPI authorization contract", () => {
  it("authorizes all-branch KPI reads using the canonical server-side all-branch access check", () => {
    expect(router).toContain('requireSupabaseAllBranchesRole(ctx.user.id, input.siteId, ["manager", "accountant", "viewer"])');
    expect(router).toContain('rpc("powerhub_dashboard_reading_kpis_all_branches"');
    expect(router).toContain('rpc("powerhub_dashboard_collector_performance_all_branches"');
    expect(router).toContain("const { start, endExclusive } = periodBounds(input.from, input.to)");
  });

  it("restricts service-only aggregate RPCs to the requested tenant and non-archived sites", () => {
    expect(migration).toContain("security definer");
    expect(migration).toContain("set search_path = ''");
    expect(migration).toContain("st.tenant_id = p_tenant_id");
    expect(migration).toContain("st.status <> 'archived'");
    expect(migration).toContain("mr.tenant_id = p_tenant_id");
    expect(migration).toContain("cs.tenant_id = p_tenant_id");
    expect(migration).toContain("revoke all on function public.powerhub_dashboard_reading_kpis_all_branches");
    expect(migration).toContain("revoke all on function public.powerhub_dashboard_collector_performance_all_branches");
    expect(migration).toContain("to service_role");
  });

  it("keeps detailed performance reports out of the dashboard while preserving authorized report APIs", () => {
    expect(home).toContain('<FinancialTrendSection data={overview?.trend ?? []} loading={financialOverviewQuery.isLoading} />');
    expect(trendSection).not.toContain("ConsumptionKpiSection");
    expect(trendSection).not.toContain("CollectorPerformanceSection");
    expect(trendSection).not.toContain("scope={scope}");
    expect(trendSection).not.toContain("siteId={siteId}");
    expect(router).toContain('requireSupabaseAllBranchesRole(ctx.user.id, input.siteId, ["manager", "accountant", "viewer"])');
    expect(kpiComponent).toContain('scope === "all"');
    expect(kpiComponent).not.toContain("useBranchFilter");
    expect(kpiComponent).toContain("آخر قراءة معتمدة ضمن الفترة");
  });
});
