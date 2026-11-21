-- D25: tenancy-wide company accounts, branch-tagged movements, and
-- double-count prevention. Installed Supabase Staging ONLY (synthetic
-- tenant 9000000000001). Read/audit transaction; ROLLBACK unconditionally.
-- This PROVES omission is safe from double counting; it does NOT convert
-- the preliminary tenant report into certified consolidated statements.
BEGIN;
SET LOCAL statement_timeout='120000ms';
DO $d25$
DECLARE
 v_sites bigint;v_accounts bigint;v_opening_once numeric;v_opening_naive numeric;
 v_movements bigint;v_site_a bigint;v_site_b bigint;
 v_distinct_ids bigint;v_foreign_accounts bigint;v_foreign_sites bigint;
 v_global_accounts bigint;v_rollup jsonb;v_rollup_other jsonb;
BEGIN
 IF current_database()<>'postgres'
 OR (SELECT count(*) FROM public.financial_gl_entries)<>25
 OR (SELECT count(*) FROM public.financial_gl_lines)<>51
 OR (SELECT count(*) FROM public.account_transactions)<>361009
 OR (SELECT count(*) FROM public.financial_accrual_period_reviews)<>0
 OR (SELECT count(*) FROM public.company_account_movement_operations
     WHERE tenant_id=9000000000001)<>0
 THEN RAISE EXCEPTION 'D25_STAGING_SYNTHETIC_LEDGER_BASELINE_MISMATCH';END IF;

 SELECT count(*) INTO v_sites FROM public.sites
 WHERE tenant_id=9000000000001 AND status='active'
 AND id IN(9000000000011,9000000000012);
 SELECT count(*),coalesce(sum(opening_balance),0)
 INTO v_accounts,v_opening_once FROM public.company_accounts
 WHERE tenant_id=9000000000001;
 -- Deliberately quantify the INCORRECT branch-by-branch opening total.
 SELECT coalesce(sum(a.opening_balance),0) INTO v_opening_naive
 FROM public.company_accounts a JOIN public.sites s
 ON s.tenant_id=a.tenant_id AND s.status='active'
 WHERE a.tenant_id=9000000000001;
 IF v_sites<>2 OR v_accounts<>3 OR v_opening_once<>300000.00
 OR v_opening_naive<>600000.00
 THEN RAISE EXCEPTION 'D25_TENANT_LEVEL_OPENING_ACCOUNT_MODEL_DRIFT';END IF;

 SELECT count(*),count(DISTINCT t.id),
    count(*) FILTER(WHERE a.id IS NULL OR a.tenant_id IS DISTINCT FROM t.tenant_id),
    count(*) FILTER(WHERE s.id IS NULL OR s.tenant_id IS DISTINCT FROM t.tenant_id)
 INTO v_movements,v_distinct_ids,v_foreign_accounts,v_foreign_sites
 FROM public.account_transactions t
 LEFT JOIN public.company_accounts a
 ON a.id=t.account_id AND a.tenant_id=t.tenant_id
 LEFT JOIN public.sites s
 ON s.id=t.site_id AND s.tenant_id=t.tenant_id
 WHERE t.tenant_id=9000000000001;
 SELECT count(*) INTO v_site_a FROM public.account_transactions
 WHERE tenant_id=9000000000001 AND site_id=9000000000011;
 SELECT count(*) INTO v_site_b FROM public.account_transactions
 WHERE tenant_id=9000000000001 AND site_id=9000000000012;
 IF v_movements<>111000 OR v_distinct_ids<>111000
 OR v_site_a<>55500 OR v_site_b<>55500
 OR v_site_a+v_site_b<>v_movements OR v_foreign_accounts<>0 OR v_foreign_sites<>0
 THEN RAISE EXCEPTION 'D25_CROSS_SITE_MOVEMENT_SCOPE_OR_DUPLICATION';END IF;

 SELECT count(*) INTO v_global_accounts
 FROM public.company_accounts a
 WHERE a.tenant_id=9000000000001
 AND (SELECT count(DISTINCT t.site_id) FROM public.account_transactions t
  WHERE t.tenant_id=a.tenant_id AND t.account_id=a.id)=2;
 IF v_global_accounts<>3
 THEN RAISE EXCEPTION 'D25_SHARED_ACCOUNTS_NOT_USED_BY_BOTH_SITES'; END IF;

 v_rollup:=public.powerhub_financial_gl_tenant_rollup(9000000000001,'2026-10');
 v_rollup_other:=public.powerhub_financial_gl_tenant_rollup(1,'2026-11');
 IF (v_rollup->>'tenantId')::bigint<>9000000000001
 OR (v_rollup->>'siteCount')::bigint<>2
 OR (v_rollup->>'glEntryCount')::bigint<>0
 OR (v_rollup->>'unreconciledSourceCount')::bigint<>105544
 OR v_rollup->>'status' IS DISTINCT FROM 'PRELIMINARY_MULTI_SITE_ROLLUP'
 OR v_rollup->>'companyAccountsIncluded' IS DISTINCT FROM 'false'
 OR v_rollup->>'sharedCompanyAccountDoubleCountAvoidedByOmission' IS DISTINCT FROM 'true'
 OR v_rollup->'readiness'->>'companyAccountsReconciled' IS DISTINCT FROM 'false'
 OR v_rollup->'readiness'->>'canBeCertifiedConsolidation' IS DISTINCT FROM 'false'
 OR v_rollup->>'isConsolidatedFinancialStatements' IS DISTINCT FROM 'false'
 OR v_rollup->>'isFinalBalanceSheet' IS DISTINCT FROM 'false'
 OR v_rollup->>'accountingCertification' IS DISTINCT FROM 'NOT_CERTIFIED'
 THEN RAISE EXCEPTION 'D25_GLOBAL_ACCOUNT_OMISSION_FALSELY_CERTIFIED';END IF;
 IF (v_rollup_other->>'tenantId')::bigint<>1
 OR (v_rollup_other->>'siteCount')::bigint<>2
 OR v_rollup_other->>'companyAccountsIncluded' IS DISTINCT FROM 'false'
 OR v_rollup_other->>'sharedCompanyAccountDoubleCountAvoidedByOmission' IS DISTINCT FROM 'true'
 OR v_rollup_other->>'isConsolidatedFinancialStatements' IS DISTINCT FROM 'false'
 OR v_rollup_other->>'accountingCertification' IS DISTINCT FROM 'NOT_CERTIFIED'
 THEN RAISE EXCEPTION 'D25_OTHER_TENANT_PRELIMINARY_FALSE_CERTIFIED';END IF;
END $d25$;
SELECT 'D25_SHARED_TENANT_ACCOUNTS_NO_DUPLICATE_OPENING_FALSE_CERTIFICATION_ROLLBACK_PASS' AS result;
ROLLBACK;