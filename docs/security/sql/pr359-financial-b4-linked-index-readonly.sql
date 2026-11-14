-- B4.5 Staging read-only regression; checks the selective index and ledger invariants.
BEGIN;
SET LOCAL statement_timeout='90000ms';
DO $audit$
DECLARE v jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname='public'
    AND tablename='account_transactions'
    AND indexname='account_transactions_b4_linked_site_time_idx'
    AND indexdef LIKE '%related_supplier_payment_id IS NOT NULL%'
    AND indexdef LIKE '%related_payment_id IS NOT NULL%'
    AND indexdef LIKE '%related_expense_id IS NOT NULL%'
  ) THEN RAISE EXCEPTION 'B4_5_LINKED_INDEX_NOT_PRESENT';END IF;
  v:=public.powerhub_financial_gl_company_movement_audit(1,1,'2026-11');
  IF v->>'status'<>'LINKED_ACCOUNT_MOVEMENTS_MATCH_NOT_CERTIFIED'
    OR v->>'accountingCertification'<>'NOT_CERTIFIED'
    OR (v->>'linkedMovementCount')::bigint<>9
    OR (v->>'mismatchCount')::bigint<>0
    OR (v->>'orphanOperationalSourceCount')::bigint<>0
    OR (v->>'unlinkedNonFixtureMovementCount')::bigint<>0
    OR (v->>'fixtureExcludedCount')::bigint<>250000
  THEN RAISE EXCEPTION 'B4_5_RECONCILIATION_CHANGED';END IF;
  IF (SELECT count(*) FROM public.financial_gl_entries WHERE tenant_id=1)<>24
    OR (SELECT count(*) FROM public.financial_gl_lines WHERE tenant_id=1)<>49
    OR (SELECT count(*) FROM public.financial_gl_central_allocation_policies WHERE tenant_id=1)<>0
  THEN RAISE EXCEPTION 'B4_5_GL_MUTATED';END IF;
END;$audit$;
SELECT 'B4_5_INDEX_AND_LEDGER_PASS' result;
ROLLBACK;
