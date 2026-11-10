-- B1: read-only queries with rollback; assertions are for the known Staging fixture.
BEGIN;
SET LOCAL statement_timeout='85000ms';
DO $verify$
DECLARE oct jsonb;nov jsonb;other_site jsonb;
BEGIN
 oct:=public.powerhub_financial_gl_site_statements(1,1,'2026-10');
 nov:=public.powerhub_financial_gl_site_statements(1,1,'2026-11');
 other_site:=public.powerhub_financial_gl_site_statements(1,9000000000099,'2026-11');
 IF (oct->'incomeStatement'->>'serviceRevenue')::numeric<>2621.50
 OR (oct->'incomeStatement'->>'provisionalNetResult')::numeric<>-2928.50
 OR (nov->'incomeStatement'->>'directServiceCost')::numeric<>120
 OR (nov->'incomeStatement'->>'provisionalNetResult')::numeric<>-120
 OR (nov->'balanceSheet'->>'unclosedAccumulatedResult')::numeric<>-3048.50
 OR (nov->'balanceSheet'->>'netAssets')::numeric<>4070.50
 OR (nov->'balanceSheet'->>'liabilities')::numeric<>7119.00
 OR (nov->'balanceSheet'->>'equationDifference')::numeric<>0
 OR (nov->>'glEntryCount')::bigint<>21
 OR nov->>'accountingCertification'<>'NOT_CERTIFIED'
 OR (nov->>'isFinalBalanceSheet')::boolean IS DISTINCT FROM false
 OR (nov->'branchProfitability'->>'isFinalBranchProfit')::boolean IS DISTINCT FROM false
 OR (nov->'branchProfitability'->'allocatedCentralExpenses')<>'null'::jsonb
 OR (other_site->>'glEntryCount')::bigint<>3
 OR (other_site->'balanceSheet'->>'equationDifference')::numeric<>0
 THEN RAISE EXCEPTION 'B1_STATEMENTS_OR_SITE_ISOLATION_FAILED'; END IF;
 BEGIN
  PERFORM public.powerhub_financial_gl_site_statements(9000000000001,1,'2026-11');
  RAISE EXCEPTION 'B1_CROSS_TENANT_BYPASS';
 EXCEPTION WHEN SQLSTATE '22023' THEN NULL;END;
 IF EXISTS(SELECT 1 FROM pg_proc f
   WHERE f.pronamespace='public'::regnamespace
    AND f.proname='powerhub_financial_gl_site_statements'
    AND (has_function_privilege('anon',f.oid,'EXECUTE')
         OR has_function_privilege('authenticated',f.oid,'EXECUTE')
         OR NOT has_function_privilege('service_role',f.oid,'EXECUTE')))
 THEN RAISE EXCEPTION 'B1_RPC_EXPOSED_TO_PUBLIC';END IF;
END;$verify$;
SELECT 'PASS_ROLLBACK_ONLY' status;
ROLLBACK;
