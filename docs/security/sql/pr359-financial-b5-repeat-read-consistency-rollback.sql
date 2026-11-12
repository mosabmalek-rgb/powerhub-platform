-- B5.2: deterministic concurrent-read baseline on synthetic Staging.
-- This SQL gate validates repeatability inside a transaction; actual concurrent
-- requests are orchestrated outside SQL and documented separately.
-- It does NOT measure browser latency or certify financial statements.
BEGIN;
SET LOCAL statement_timeout='120000ms';
DO $b52$
DECLARE roll_1 jsonb;roll_2 jsonb;
  balances_1 jsonb;balances_2 jsonb;
  movements_1 jsonb;movements_2 jsonb;
  gl_before bigint;lines_before bigint;policies_before bigint;
BEGIN
  SELECT count(*) INTO gl_before FROM public.financial_gl_entries WHERE tenant_id=1;
  SELECT count(*) INTO lines_before FROM public.financial_gl_lines WHERE tenant_id=1;
  SELECT count(*) INTO policies_before FROM public.financial_gl_central_allocation_policies WHERE tenant_id=1;
  roll_1:=public.powerhub_financial_gl_tenant_rollup(1,'2026-11');
  balances_1:=public.powerhub_financial_gl_subledger_reconciliation(1,1,'2026-11');
  movements_1:=public.powerhub_financial_gl_company_movement_audit(1,1,'2026-11');
  roll_2:=public.powerhub_financial_gl_tenant_rollup(1,'2026-11');
  balances_2:=public.powerhub_financial_gl_subledger_reconciliation(1,1,'2026-11');
  movements_2:=public.powerhub_financial_gl_company_movement_audit(1,1,'2026-11');
  IF roll_1 IS DISTINCT FROM roll_2 OR balances_1 IS DISTINCT FROM balances_2
     OR movements_1 IS DISTINCT FROM movements_2
  THEN RAISE EXCEPTION 'B5_2_INCONSISTENT_REPEAT_READ';END IF;
  IF roll_1->>'status'<>'PRELIMINARY_MULTI_SITE_ROLLUP'
     OR roll_1->>'accountingCertification'<>'NOT_CERTIFIED'
     OR (roll_1->>'isConsolidatedFinancialStatements')::boolean IS DISTINCT FROM false
     OR movements_1->>'accountingCertification'<>'NOT_CERTIFIED'
     OR movements_1->>'status'<>'LINKED_ACCOUNT_MOVEMENTS_MATCH_NOT_CERTIFIED'
     OR balances_1->>'accountingCertification'<>'NOT_CERTIFIED'
  THEN RAISE EXCEPTION 'B5_2_UNJUSTIFIED_ACCOUNTING_CERTIFICATION'; END IF;
  IF (SELECT count(*) FROM public.financial_gl_entries WHERE tenant_id=1)<>gl_before
     OR (SELECT count(*) FROM public.financial_gl_lines WHERE tenant_id=1)<>lines_before
     OR (SELECT count(*) FROM public.financial_gl_central_allocation_policies WHERE tenant_id=1)<>policies_before
  THEN RAISE EXCEPTION 'B5_2_READ_CHANGED_FINANCIAL_LEDGER'; END IF;
END;$b52$;
SELECT 'B5_2_REPEAT_READ_CONSISTENCY_PASS_NOT_CERTIFIED' result;
ROLLBACK;
