import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const migration=readFileSync(
 "supabase/migrations/20261113203000_powerhub_financial_c4_period_close_integrity_guard.sql","utf8");
const rollback=readFileSync(
 "docs/security/sql/pr359-financial-c4-lock-guard-rollback.sql","utf8");
const router=readFileSync("server/powerhub.ts","utf8");

describe("C4 close authority lives inside the source-backed DB lock",()=>{
 it("preserves advisory serialization, maker/checker and idempotent replay",()=>{
  for(const token of [
   "pg_advisory_xact_lock","FOR UPDATE",
   "ACCRUAL_SEPARATION_OF_DUTIES","PERIOD_ALREADY_LOCKED",
   "ACCRUAL_PERIOD_NOT_FINISHED","alreadyLocked", "isCertifiedProfit',false",
  ]) expect(migration).toContain(token);
 });
 it("refuses all recognized incomplete, corrupt, stale-cutoff financial sources",()=>{
  for(const token of [
   "INVALID_ACCRUAL_CLOSE_SCOPE","INVALID_ACCRUAL_REVIEW_STATE",
   "ACCRUAL_CLOSE_EVIDENCE_INCOMPLETE",
   "ACCRUAL_CLOSE_UNRESOLVED_SOURCE_",
   "ACCRUAL_CLOSE_UNBALANCED_OR_DRAFT_JOURNAL",
   "ACCRUAL_CLOSE_SOURCE_SCOPE_OR_FINALITY",
   "invalidInvoiceCount","invalidExpenseCount","invalidPayrollCount",
   "invalidInventoryCount","crossPeriodInvoiceCount",
   "issuedOutsideServiceMonthCount","draftCount",
   "balancedDebits","balancedCredits","isCompleteAccrualStatement",
  ]) expect(migration).toContain(token);
  expect(migration).toContain("jsonb_typeof(v_snapshot->v_key) IS DISTINCT FROM 'number'");
  expect(migration).toContain("(v_snapshot->>v_key)::bigint IS DISTINCT FROM 0");
 });
 it("does not widen direct SQL execution or expose generic posting",()=>{
  expect(migration).toContain("REVOKE ALL ON FUNCTION public.powerhub_financial_accrual_period_lock");
  expect(migration).toContain("FROM PUBLIC,anon,authenticated");
  expect(migration).toContain("TO service_role");
  expect(router).toContain("accrualPeriodReviewLock: protectedProcedure");
  expect(router).toContain('["owner","manager","accountant"],"manageExpenses"');
  expect(router).toContain("p_user_id:ctx.user.id");
  expect(migration).not.toContain("GRANT EXECUTE TO authenticated");
 });
 it("retains rollback-only Staging proof including successful close, negative cutoff and replay",()=>{
  for(const token of [
   "BEGIN;","ROLLBACK;","C4_STAGING_BASELINE_DRIFT",
   "C4_SELF_APPROVAL_ALLOWED","C4_CLEAN_PERIOD_FAILED",
   "C4_REPLAY_NOT_IDEMPOTENT","C4_CURRENT_PERIOD_NOT_BLOCKED",
   "C4_CUTOFF_NOT_BLOCKED","C4_WRONG_SITE_NOT_BLOCKED",
   "C4_POST_TEST_LEDGER_OR_PERIOD_DRIFT",
   "C4_SOURCE_LOCK_MAKER_CHECKER_REPLAY_PASS_ROLLBACK",
  ]) expect(rollback).toContain(token);
  expect(rollback).not.toMatch(/\bCOMMIT\s*;/i);
 });
});
