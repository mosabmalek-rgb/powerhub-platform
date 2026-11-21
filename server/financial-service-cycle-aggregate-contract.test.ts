import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe,expect,it } from "vitest";

const migration=readFileSync(resolve(process.cwd(),
 "supabase/migrations/20261109170000_powerhub_financial_service_cycle_billing_aggregate.sql"),"utf8");
const server=readFileSync(resolve(process.cwd(),"server/powerhub.ts"),"utf8");
const financial=server.slice(server.indexOf("    serviceCycleBillingReview:"),
 server.indexOf("    range: protectedProcedure.input(",server.indexOf("    serviceCycleBillingReview:")));
const ui=readFileSync(resolve(process.cwd(),"client/src/pages/FinancialDashboardPage.tsx"),"utf8");

describe("PostgreSQL financial service-cycle aggregate release contract",()=>{
 it("aggregates in SQL without copying individual invoices into application memory",()=>{
  expect(financial).toContain('.rpc(\n        "powerhub_financial_service_cycle_billing_aggregate"');
  expect(financial).toContain("requireSupabaseSiteRole(");
  expect(financial).toContain('"viewFinancialReports"');
  expect(financial).not.toContain('.from("invoices")');
  expect(financial).not.toContain(".limit(5001)");
  expect(financial).not.toContain("windowDays>366");
 });
 it("keeps tenant/site filtering and indexed temporal overlap predicates",()=>{
  expect(migration).toContain("i.tenant_id = p_tenant_id AND i.site_id = p_site_id");
  expect(migration).toContain("i.cycle_end_at >= v_lower AND i.cycle_start_at < v_upper");
  expect(migration).toContain("invoices_financial_service_cycle_end_idx");
  expect(migration).toContain("invoices_financial_missing_cycle_issue_idx");
  expect(migration).toContain("AT TIME ZONE 'Asia/Gaza'");
  expect(migration).toContain("SUM(total_amount)");
  expect(migration).toContain("COUNT(*)");
 });
 it("restricts RPC execution to backend service role and refuses to label billing as earned income",()=>{
  expect(migration).toContain("SECURITY INVOKER");
  expect(migration).toContain("FROM PUBLIC,anon,authenticated");
  expect(migration).toContain("TO service_role");
  expect(migration).toContain("'isRecognizedRevenue',false");
  expect(migration).toContain("'isCompleteProfitAndLoss',false");
  expect(financial).toContain("snapshot.isRecognizedRevenue!==false");
  expect(financial).toContain("snapshot.isCompleteProfitAndLoss!==false");
 });
 it("fails closed if aggregate arithmetic or scope does not reconcile",()=>{
  expect(financial).toContain("Number(snapshot.scopeTenantId)!==access.tenantId");
  expect(financial).toContain("Number(snapshot.scopeSiteId)!==input.siteId");
  expect(financial).toContain("counts.fullyInsideCount+counts.crossBoundaryCount!==counts.issuedInvoiceCount");
  expect(financial).toContain("counts.completedCount+counts.inProgressCount+counts.futureCount!==counts.issuedInvoiceCount");
  expect(migration).toContain("INVALID_FINANCIAL_CYCLE_INVOICE");
 });
 it("discloses missing service-cycle data in the financial dashboard",()=>{
  expect(migration).toContain("'missingCycleCount',v_missing_count");
  expect(ui).toContain("serviceCycleBilling.data.isCycleCoverageComplete");
  expect(ui).toContain("لم تدخل في مجموع فوترة الدورات");
  expect(ui).toContain("showServiceCycleBilling");
 });
});
