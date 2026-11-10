-- All actual Staging GL data is synthetic, no financial mutations are committed.
BEGIN;
SET LOCAL statement_timeout='90000ms';
DO $check$
DECLARE roll jsonb;a jsonb;b jsonb;
BEGIN
 roll:=public.powerhub_financial_gl_tenant_rollup(1,'2026-11');
 a:=public.powerhub_financial_gl_site_statements(1,1,'2026-11');
 b:=public.powerhub_financial_gl_site_statements(1,9000000000099,'2026-11');
 IF roll->>'status'<>'PRELIMINARY_MULTI_SITE_ROLLUP'
  OR roll->>'accountingCertification'<>'NOT_CERTIFIED'
  OR (roll->>'isConsolidatedFinancialStatements')::boolean IS DISTINCT FROM false
  OR (roll->>'siteCount')::bigint<>2
  OR (roll->>'glEntryCount')::bigint<>24
  OR (roll->'positionBeforeEliminations'->>'netAssets')::numeric<>6070.50
  OR (roll->'positionBeforeEliminations'->>'liabilities')::numeric<>7119
  OR (roll->'positionBeforeEliminations'->>'postedEquity')::numeric<>2000
  OR (roll->'positionBeforeEliminations'->>'unclosedAccumulatedResult')::numeric<>-3048.50
  OR (roll->'positionBeforeEliminations'->>'equationDifference')::numeric<>0
  OR (roll->'incomeStatement'->>'provisionalNetResultBeforeEliminations')::numeric<>
     (a->'incomeStatement'->>'provisionalNetResult')::numeric+
     (b->'incomeStatement'->>'provisionalNetResult')::numeric
  OR (roll->>'companyAccountsIncluded')::boolean IS DISTINCT FROM false
  OR (roll->>'intraSiteWarehouseTransferCount')::bigint<>2
  OR (roll->>'intraSiteWarehouseTransferValue')::numeric<>170
  OR (roll->>'intraSiteWarehouseTransferMismatchCount')::bigint<>0
  OR roll->>'warehouseTransferClassification'<>'INTRA_SITE_STOCK_TRANSFER_NOT_GL_ELIMINATION'
  OR (roll->>'interSiteTransferCandidateCount')::bigint<>0
  OR (roll->'readiness'->>'warehouseTransfersPaired')::boolean IS DISTINCT FROM true
  OR roll->>'interSiteTransferEliminationStatus'<>'NOT_INDEPENDENTLY_RECONCILED'
  OR (roll->'readiness'->>'canBeCertifiedConsolidation')::boolean IS DISTINCT FROM false
  THEN RAISE EXCEPTION 'B3_STAGING_ROLLUP_MISMATCH';END IF;
 IF EXISTS(SELECT 1 FROM pg_proc f WHERE f.pronamespace='public'::regnamespace
  AND f.proname='powerhub_financial_gl_tenant_rollup'
  AND (has_function_privilege('anon',f.oid,'EXECUTE') OR has_function_privilege('authenticated',f.oid,'EXECUTE')))
 THEN RAISE EXCEPTION 'B3_EXPOSED_TO_PUBLIC';END IF;
END;$check$;
SELECT 'B3_PASS_ROLLBACK_ONLY' result;
ROLLBACK;
