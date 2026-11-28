import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {describe,it,expect} from "vitest";

const root=process.cwd();
const opening=readFileSync(resolve(root,
  "supabase/migrations/20261110011000_powerhub_financial_gl_opening_balances.sql"),"utf8");
const coverage=readFileSync(resolve(root,
  "supabase/migrations/20261110012000_powerhub_financial_gl_source_coverage.sql"),"utf8");
const accrual=readFileSync(resolve(root,
  "supabase/migrations/20261110010000_powerhub_financial_gl_post_approved_accrual.sql"),"utf8");
const api=readFileSync(resolve(root,"server/powerhub.ts"),"utf8");

describe("financial A2.2 opening accounting and A3 coverage release contract",()=>{
 it("does not fabricate balances, posts only after independent approval and preserves audit",()=>{
  expect(opening).toContain("financial_gl_one_active_opening_per_site");
  expect(opening).toContain("expected_line_count");
  expect(opening).toContain("v_count<>v_batch.expected_line_count");
  expect(opening).toContain("created_by_user_id=p_approver_id");
  expect(opening).toContain("financial_gl_opening_lines_immutable");
  expect(opening).toContain("GL_OPENING_LINES_SEALED");
  expect(opening).toContain("GL_OPENING_POSTED_CANNOT_VOID");
  expect(opening).toContain("GL_OPENING_PRIOR_POSTINGS");
  expect(opening).toContain("GL_OPENING_PERIOD_LOCKED");
  expect(opening).toContain("VALUES(p_tenant_id,p_site_id,p_as_of_date");
  expect(opening).toContain("jsonb_array_length(p_lines),p_user_id");
 });
 it("serializes opening approvals with accrual ledger projection on the same site",()=>{
  expect(opening).toContain("'powerhub:gl-site:'||p_tenant_id||':'||p_site_id");
  expect(accrual).toContain("'powerhub:gl-site:'||p_tenant_id||':'||p_site_id");
 });
 it("does not grant financial opening management to public browser clients",()=>{
  expect(opening).toContain("ALTER TABLE public.financial_gl_opening_batches ENABLE ROW LEVEL SECURITY");
  expect(opening).toContain("ALTER TABLE public.financial_gl_opening_lines ENABLE ROW LEVEL SECURITY");
  expect(opening).toContain("FROM PUBLIC,anon,authenticated");
  expect(opening).toContain("GRANT SELECT,INSERT,UPDATE ON public.financial_gl_opening_batches TO service_role");
  expect(opening).toContain("GRANT SELECT,INSERT ON public.financial_gl_opening_lines TO service_role");
 });
 it("requires authorization in the server for each opening operation",()=>{
  for(const procedure of ["financialGLOpeningCreate","financialGLOpeningPost","financialGLOpeningVoid"]){
   const start=api.indexOf(procedure+":");
   expect(start).toBeGreaterThan(0);
   const segment=api.slice(start,start+2000);
   expect(segment).toContain("requireSupabaseSiteRole(ctx.user.id,input.siteId");
   expect(segment).toContain('"manageExpenses"');
  }
  expect(api).toContain('rpc("powerhub_financial_gl_opening_create"');
  expect(api).toContain('rpc("powerhub_financial_gl_opening_post"');
  expect(api).toContain('rpc("powerhub_financial_gl_opening_void"');
 });
 it("exposes source counts on demand without auto-posting or final certification",()=>{
  expect(coverage).toContain("'unreconciledSourceCount',v_missing");
  expect(coverage).toContain("'isCompleteAccrualStatement',false,'isFinalProfit',false");
  expect(coverage).toContain("'accountingCertification','NOT_CERTIFIED'");
  expect(coverage).toContain("FROM public.account_transactions a");
  expect(coverage).toContain("FROM public.supplier_ledger_entries s");
  expect(coverage).toContain("FROM public.inventory_stock_movements m");
  expect(coverage).not.toMatch(/LIMIT\s+[0-9]+/i);
  const start=api.indexOf("financialGLSourceCoverage:");
  const section=api.slice(start,start+1800);
  expect(section).toContain('"viewFinancialReports"');
  expect(section).toContain('rpc("powerhub_financial_gl_source_coverage"');
  expect(section).toContain('coverage.accountingCertification!=="NOT_CERTIFIED"');
 });
});
