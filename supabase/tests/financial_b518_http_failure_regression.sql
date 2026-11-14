-- B5.18: read-only acceptance assertions. Execute against Staging in
-- a transaction and ROLLBACK; no financial rows or approvals may persist.
BEGIN;
SET LOCAL statement_timeout='20000ms';
DO $tests$
DECLARE
  v_stmt jsonb;
  v_audit jsonb;
  v_count_before bigint;
  v_count_after bigint;
  v_lines_before bigint;
  v_lines_after bigint;
BEGIN
  SELECT count(*) INTO v_count_before FROM public.financial_gl_entries WHERE tenant_id=1;
  SELECT count(*) INTO v_lines_before FROM public.financial_gl_lines WHERE tenant_id=1;

  IF (SELECT provolatile FROM pg_proc
      WHERE oid='public.powerhub_financial_gl_site_statements(bigint,bigint,text)'::regprocedure)<>'v'
  THEN RAISE EXCEPTION 'B518_SITE_REPORT_MUST_NOT_BE_POSTGREST_READ_ONLY'; END IF;

  v_stmt:=public.powerhub_financial_gl_site_statements(1,1,'2026-11');
  IF v_stmt->>'accountingCertification' IS DISTINCT FROM 'NOT_CERTIFIED'
      OR v_stmt->>'siteScope' IS DISTINCT FROM 'SITE_ONLY'
      OR (v_stmt->>'siteId')::bigint IS DISTINCT FROM 1
      OR (v_stmt->>'isFinalBalanceSheet')::boolean IS DISTINCT FROM false
      OR jsonb_typeof(v_stmt->'accounts') IS DISTINCT FROM 'array'
  THEN RAISE EXCEPTION 'B518_SITE_REPORT_CONTRACT_DRIFT'; END IF;

  v_audit:=public.powerhub_financial_gl_company_movement_audit(1,1,'2026-11');
  IF v_audit->>'accountingCertification' IS DISTINCT FROM 'NOT_CERTIFIED'
      OR (v_audit->>'siteId')::bigint IS DISTINCT FROM 1
      OR (v_audit->>'isApproved')::boolean IS DISTINCT FROM false
      OR jsonb_typeof(v_audit->'accountBalancesLinkedOnly') IS DISTINCT FROM 'array'
  THEN RAISE EXCEPTION 'B518_COMPANY_AUDIT_CONTRACT_DRIFT'; END IF;

  SELECT count(*) INTO v_count_after FROM public.financial_gl_entries WHERE tenant_id=1;
  SELECT count(*) INTO v_lines_after FROM public.financial_gl_lines WHERE tenant_id=1;
  IF v_count_before<>v_count_after OR v_lines_before<>v_lines_after
  THEN RAISE EXCEPTION 'B518_REPORT_CREATED_FINANCIAL_LEDGER_ENTRIES'; END IF;

  RAISE NOTICE 'B518_SQL_REPORT_CONTRACTS_PASS_ROLLBACK';
END
$tests$;
ROLLBACK;
