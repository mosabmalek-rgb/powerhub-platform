import { readFileSync } from "node:fs";
import { describe,expect,it } from "vitest";
const server=readFileSync("server/powerhub.ts","utf8");
const dashboard=readFileSync("client/src/pages/FinancialDashboardPage.tsx","utf8");
const sql=readFileSync("supabase/migrations/20261109140000_powerhub_financial_current_position.sql","utf8");
describe("financial dashboard current position scope and performance contracts",()=>{
 it("separates point-in-time balances from filtered period calculations and independently renders",()=>{
  expect(server).toContain("currentPosition: protectedProcedure.input(siteScoped)");
  expect(server).toContain('"viewFinancialReports"');
  expect(server).toContain('rpc("powerhub_financial_current_position"');
  expect(server).toContain("Number(result.scopeSiteId) !== input.siteId");
  expect(dashboard).toContain("powerhub.reports.currentPosition.useQuery({ siteId }");
  expect(dashboard).toContain("المركز المالي الحالي");
  expect(dashboard).toContain("الأداء المالي خلال الفترة");
  expect(dashboard).toContain("لا تتأثر بفلتر اليوم أو الدورة أو الشهر");
  expect(dashboard).toContain("staleTime: 120_000");
  expect(dashboard).toContain("refetchOnWindowFocus: false");
  expect(dashboard).toContain("currentPosition.refetch()");
  expect(dashboard).not.toContain('if (loading || report.isLoading ||');
 });
 it("aggregates cash and supplier entries once, rather than returning transaction logs",()=>{
  expect(sql).toContain("LANGUAGE sql STABLE SECURITY INVOKER");
  expect(sql).toContain("account_transactions t");
  expect(sql).toContain("t.tenant_id = p_tenant_id AND t.account_id = a.id");
  expect(sql).toContain("SUM(l.credit_amount - l.debit_amount)");
  expect(sql).toContain("employee_adjustments e");
  expect(sql).toContain("GREATEST(i.balance_due,0)");
  expect(sql).toContain("p_site_id");
  expect(sql).toContain("CROSS JOIN verified_site v");
  expect(sql).toContain("s.tenant_id=p_tenant_id AND s.status<>'archived'");
  expect(sql).toContain("is_shared");
  expect(sql).toContain("REVOKE ALL ON FUNCTION");
  expect(sql).toContain("TO service_role");
 });
});

describe("cash-flow movement scope and revenue independence",()=>{
 const flow=readFileSync("supabase/migrations/20261109150000_powerhub_financial_period_cash_flow.sql","utf8");
 it("excludes internal transfers, uses site/time boundaries, and does not equate deposits with revenue",()=>{
  expect(flow).toContain("t.tenant_id=p_tenant_id AND t.site_id=p_site_id");
  expect(flow).toContain("t.occurred_at>=p_period_start AND t.occurred_at<p_period_end_exclusive");
  expect(flow).toContain("t.transaction_type IN ('collection','deposit')");
  expect(flow).toContain("t.transaction_type='withdrawal'");
  expect(flow).toContain("t.transaction_type='transfer_out'");
  expect(flow).toContain("SECURITY INVOKER");
  expect(flow).toContain("FROM PUBLIC,anon,authenticated");
  expect(server).toContain('cashFlow: protectedProcedure');
  expect(dashboard).toContain("التدفق النقدي خلال الفترة");
  expect(dashboard).toContain("لا تشمل التحويلات بين حسابات الشركة");
 });
});