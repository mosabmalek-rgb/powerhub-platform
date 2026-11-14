import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const server=readFileSync("server/powerhub.ts","utf8");
const panel=readFileSync("client/src/components/finance/AccrualAccountingPanel.tsx","utf8");
describe("C2 protected close-readiness route and guarded UI",()=>{
 it("reads both sources under a fresh site permission; it never invokes a write",()=>{
  const start=server.indexOf("accrualCloseReadiness: protectedProcedure");
  const end=server.indexOf("accrualPeriodReviewStatus: protectedProcedure",start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const route=server.slice(start,end);
  expect(route).toContain("requireSupabaseSiteRole(ctx.user.id,input.siteId");
  expect(route).toContain('"viewFinancialReports"');
  expect(route).toContain("p_tenant_id:access.tenantId");
  expect(route).toContain("p_site_id:input.siteId");
  expect(route).toContain("buildFinancialCloseReadiness");
  expect(route).not.toContain(".mutation(");
  expect(route).not.toContain("powerhub_financial_accrual_period_lock");
 });
 it("enables lock UI only with a current readiness decision",()=>{
  expect(panel).toContain('readiness.data?.status==="READY_FOR_INDEPENDENT_REVIEW"');
  expect(panel).toContain("!readiness.isError && !readiness.isFetching && !readiness.isLoading");
  expect(panel).toContain("accrualCloseReadiness.invalidate({siteId,period})");
  expect(panel).toContain("!readiness.isLoading&&!readiness.isFetching&&!readiness.isError");
  expect(panel).toContain("لا يُنشئ قيودًا ولا يمنح اعتمادًا");
 });
});
