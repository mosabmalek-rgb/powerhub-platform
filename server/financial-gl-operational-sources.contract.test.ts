import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {describe,it,expect} from "vitest";

const api=readFileSync(resolve(process.cwd(),"server/powerhub.ts"),"utf8");
const operational=readFileSync(resolve(process.cwd(),
 "supabase/migrations/20261110015000_powerhub_financial_gl_post_operational_sources.sql"),"utf8");
const coverage=readFileSync(resolve(process.cwd(),
 "supabase/migrations/20261110016000_powerhub_financial_gl_source_coverage_operational.sql"),"utf8");
const recognition=readFileSync(resolve(process.cwd(),
 "supabase/migrations/20261110017000_powerhub_financial_gl_service_recognition.sql"),"utf8");
const isolated=readFileSync(resolve(process.cwd(),
 "supabase/tests/financial_gl_operational_sources_integration.sql"),"utf8");

describe("financial operational source accounting release invariants",()=>{
 it("checks accounting and source capabilities before using privileged RPCs",()=>{
  const start=api.indexOf("financialGLPostSource:");
  const end=api.indexOf("financialGLOpeningCreate:",start);
  const section=api.slice(start,end);
  expect(start).toBeGreaterThan(0);
  expect(section).toContain('["owner","manager","accountant"],"manageExpenses"');
  expect(section).toContain('"issueInvoices"');
  expect(section).toContain('"collectPayments"');
  expect(section).toContain('"managePayroll"');
  expect(section).toContain('"payroll_payment"');
  expect(section).toContain('rpc("powerhub_financial_gl_post_source"');
  const rec=section.slice(section.indexOf("financialGLRecognizeBilledService:"));
  expect(rec).toContain('"manageExpenses"');
  expect(rec).toContain('"issueInvoices"');
  expect(rec).toContain('rpc(\n        "powerhub_financial_gl_recognize_billed_service"');
 });
 it("keeps GL postings immutable, site locked and source-evidence bound",()=>{
  expect(operational).toContain("'powerhub:accrual-period:'");
  expect(operational).toContain("'powerhub:gl-site:'");
  expect(operational).toContain("GL_SOURCE_REPLAY_MISMATCH");
  expect(operational).toContain("GL_DOCUMENTED_OPENING_REQUIRED");
  expect(operational).toContain("GL_SOURCE_SETTLEMENT_EXCEEDS_LIABILITY");
  expect(operational).toContain("GL_SOURCE_ASSET_NOT_SUPPORTED_BY_LEDGER");
  expect(operational).toContain("GL_INTERNAL_STOCK_TRANSFER_NOT_AN_EXPENSE");
  expect(operational).toContain("GL_SUPPLIER_RETURN_NOT_RECONCILED");
  expect(operational).toContain("payroll-settlement-no-second-wage-expense-v1");
  expect(operational).toContain("GL_PAYROLL_PAYOUT_CASH_MOVEMENT_MISMATCH");
 });
 it("never offers anonymous or browser execute on financial posting functions",()=>{
  expect(operational).toContain("FROM PUBLIC,anon,authenticated");
  expect(operational).toContain("TO service_role");
  expect(recognition).toContain("FROM PUBLIC,anon,authenticated");
  expect(recognition).toContain("TO service_role");
 });
 it("separates source completeness from earned-service recognition and final certification",()=>{
  expect(coverage).toContain("v_service_recognition_missing");
  expect(coverage).toContain("'serviceRecognition',jsonb_build_object(");
  expect(coverage).toContain("'missingGL',v_service_recognition_missing");
  expect(coverage).toContain("'accountingCertification','NOT_CERTIFIED'");
  expect(recognition).toContain("GL_SERVICE_MONTH_NOT_COMPLETED");
  expect(recognition).toContain("GL_SERVICE_INVOICE_NOT_DEFERRED");
  expect(isolated).toContain("GL_CI_EARNED_REVENUE_MISSING_NOT_DETECTED");
  expect(isolated).toContain("GL_CI_EARNED_REVENUE_POSTED_NOT_RECONCILED");
  expect(isolated).toContain("GL_CI_TRANSFER_EXPENSED_");
  expect(isolated).toContain("GL_CI_PAYROLL_PAYOUT_IDEMPOTENCY");
 });
});
