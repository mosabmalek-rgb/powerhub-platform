import {readFileSync} from "node:fs";
import {describe,expect,it} from "vitest";
const read=(p:string)=>readFileSync(p,"utf8");
const sql=read("supabase/tests/financial_c6_two_session_close_setup.sql");
const runner=read("supabase/tests/financial_c6_two_session_close.sh");
const workflow=read(".github/workflows/reading-cycle-sql-integration.yml");
const original=read("supabase/migrations/20261110003000_powerhub_financial_accrual_source_detail_fingerprint.sql");
const migration=read("supabase/migrations/20261113203000_powerhub_financial_c4_period_close_integrity_guard.sql");

describe("C6 disposable two-backend month-close acceptance",()=>{
 it("runs exact versioned C4 writer and canonical fingerprint review-status function",()=>{
  expect(sql).toContain("\\ir ../migrations/20261113203000_powerhub_financial_c4_period_close_integrity_guard.sql");
  const match=original.match(/CREATE OR REPLACE FUNCTION public\.powerhub_financial_accrual_period_review_status\([\s\S]*?\$status\$;/);
  expect(match).not.toBeNull();
  expect(sql).toContain(match![0]);
  expect(migration).toContain("pg_advisory_xact_lock");
  expect(migration).toContain("FOR UPDATE");
  expect(migration).toContain("ACCRUAL_CLOSE_UNRESOLVED_SOURCE_%");
 });
 it("races distinct PostgreSQL sessions on the same period mutex; never Staging",()=>{
  expect(runner).toContain("financial_c6_two_session_close_test");
  expect(runner).toContain("C6_REJECT_NON_DISPOSABLE_DATABASE");
  expect(runner).toContain("\"$PGHOST\" == 127.0.0.1");
  expect(runner).toContain("pg_advisory_lock(hashtextextended('powerhub:accrual-period:901:9101:2026-09',0))");
  expect(runner).toContain("pg_backend_pid()");
  expect(runner).toContain("C6_RACE_NOT_EXACTLY_ONE_WIN");
  expect(runner).toContain("C6_WINNER_REPLAY_NOT_IDEMPOTENT");
  expect(runner).toContain("C6_OTHER_CHECKER_REPLAY_ALLOWED");
  expect(runner).toContain("C6_POST_LOCK_DRIFT_NOT_REPORTED");
  expect(runner).toContain("C6_CORRUPT_INVOICE_SOURCE_ALLOWED");
  expect(runner).toContain("C6_CROSS_TENANT_LOCK_ACCEPTED");
  expect(runner).not.toMatch(/\bDROP DATABASE\b|\bTRUNCATE\b/);
 });
 it("is a required PostgreSQL integration step, not an opt-in mock",()=>{
  expect(workflow).toContain("Verify C6 two-session period close");
  expect(workflow).toContain("PGDATABASE: financial_c6_two_session_close_test");
  expect(workflow).toContain("supabase/tests/financial_c6_two_session_close_setup.sql");
  expect(workflow).toContain("bash supabase/tests/financial_c6_two_session_close.sh");
 });
});
