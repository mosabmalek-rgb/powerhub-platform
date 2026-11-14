import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const migration=readFileSync("supabase/migrations/20261112224000_powerhub_financial_b517_subledger_cash_fixture_fast_path.sql","utf8");
const regression=readFileSync("docs/security/sql/pr359-financial-b517-subledger-cash-fast-path-rollback.sql","utf8");
describe("B5.17 source-backed cash/subledger performance",()=>{
 it("maintains unmodified GL reconciliation and an explicit full-raw fallback",()=>{
  expect(migration).toContain("LANGUAGE plpgsql\n STABLE");
  expect(migration).toContain("B5.17:");
  expect(migration).toContain("powerhub_financial_gl_fast_staging_fixture_proof");
  expect(migration).toContain("AND v_cutoff>TIMESTAMPTZ '2026-05-03T20:50:00+00'");
  expect(migration).toContain("AND (t.reference_no IS NULL OR t.reference_no NOT LIKE 'STG-PERF-%')");
  expect(migration).toContain("ELSE\n"+migration.slice(migration.indexOf(" SELECT coalesce(sum(CASE WHEN a.account_type='cash'",migration.indexOf("ELSE\n"))).split(" END IF;")[0].slice(0,30));
  expect(migration).toContain("s_cash:=s_cash::numeric(30,2)");
  expect(migration).toContain("s_wallet:=s_wallet::numeric(30,2)");
  expect(migration).toContain("FROM PUBLIC,anon,authenticated");
  expect(migration).toContain("TO service_role");
 });
 it("retains rollback proof for disabled freeze, full historical cash, and ACL",()=>{
  for(const key of ["BEGIN;","ROLLBACK;","DISABLE TRIGGER powerhub_financial_gl_fixture_freeze_write",
   "ENABLE TRIGGER powerhub_financial_gl_fixture_freeze_write",
   "B517_DISABLED_FREEZE_FAST_PATH_NOT_REJECTED","B517_RAW_LEDGER_COMPARISON_FAILED_",
   "B517_GL_CHANGED_OR_BROWSER_FUNCTION_EXPOSED","NOT_CERTIFIED"])
   expect(regression).toContain(key);
 });
});
