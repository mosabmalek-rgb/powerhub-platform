-- B5.6 acceptance: indexed reference cohort remains fully counted and
-- technical fixture quarantining never becomes human/accounting certification.
-- No test mutation. This is a strict Staging-only rollback guard.
BEGIN;
SET LOCAL statement_timeout='120000ms';
DO $qa$
DECLARE proof jsonb; prior jsonb; roll jsonb; entries bigint; lines bigint;
BEGIN
 IF NOT EXISTS(
   SELECT 1 FROM public.sites WHERE tenant_id=1 AND id=9000000000099
     AND name='STAGING Finance A Isolated Acceptance (TEST ONLY)' AND status='active')
 THEN RAISE EXCEPTION 'B56_STAGING_SITE_GUARD'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_index i
   JOIN pg_catalog.pg_class c ON c.oid=i.indexrelid
   WHERE c.relname='account_transactions_tenant_site_reference_prefix_idx'
   AND i.indisvalid AND i.indisready)
 THEN RAISE EXCEPTION 'B56_INDEX_MISSING_OR_INVALID'; END IF;
 SELECT count(*) INTO entries FROM public.financial_gl_entries WHERE tenant_id=1;
 SELECT count(*) INTO lines FROM public.financial_gl_lines WHERE tenant_id=1;
 IF entries<>25 OR lines<>51 THEN RAISE EXCEPTION 'B56_GL_BASELINE_CHANGED';END IF;
 proof:=public.powerhub_financial_gl_fast_staging_fixture_proof(1,1);
 prior:=public.powerhub_financial_gl_prior_operational_gaps(1,1,'2026-11');
 roll:=public.powerhub_financial_gl_tenant_rollup(1,'2026-11');
 IF proof->>'verified'<>'true'
  OR (proof->>'quarantinedCount')::bigint<>250000
  OR proof->>'sha256'<>'f1b25e8562328a0f6e916beb4d54b2ee88366e78b4459c5d0ebc444616997df9'
  OR proof->>'humanReviewed'<>'false'
  OR proof->>'financialCertification'<>'NOT_CERTIFIED'
  OR prior->>'unreconciledCount'<>'0'
  OR prior->>'unclassifiedAccountMovements'<>'0'
  OR prior->>'quarantinedTestMovements'<>'250000'
  OR prior->>'fromOpeningDate' IS NOT NULL
  OR roll->>'glEntryCount'<>'25'
  OR roll->>'accountingCertification'<>'NOT_CERTIFIED'
  OR (roll->>'isConsolidatedFinancialStatements')::boolean IS DISTINCT FROM false
  OR (roll->'positionBeforeEliminations'->>'netAssets')::numeric<>4070.50
  OR (roll->'positionBeforeEliminations'->>'liabilities')::numeric<>7119.00
  OR (roll->'positionBeforeEliminations'->>'equationDifference')::numeric<>0
  OR (SELECT count(*) FROM public.financial_gl_entries WHERE tenant_id=1)<>entries
  OR (SELECT count(*) FROM public.financial_gl_lines WHERE tenant_id=1)<>lines
 THEN RAISE EXCEPTION 'B56_NUMERIC_OR_SOURCE_GUARD_DRIFT';END IF;
END;$qa$;
SELECT 'B56_INDEXED_STAGING_SOURCE_GUARD_PASS_ROLLBACK' AS result;
ROLLBACK;