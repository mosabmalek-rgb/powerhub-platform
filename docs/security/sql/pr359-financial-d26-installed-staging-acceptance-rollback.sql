-- D26 installed-Staging acceptance, read-only by effect, transaction rolled back.
-- Run ONLY after the versioned migration 20261115174500 is recorded by the
-- protected GitHub release workflow. Do not run on Production.
-- This is a technical audit, not an approval of financial opening documents.
BEGIN;
SET LOCAL statement_timeout = '120000ms';
DO $d26$
DECLARE
  d26 jsonb; main jsonb; rollup jsonb; r record;
  v_orig_entries bigint; v_orig_lines bigint; v_orig_movements bigint;
  v_site_moves bigint;v_site_net numeric;
  v_account_opening numeric;v_account_movements bigint;
  v_denied boolean:=false;
BEGIN
  SELECT count(*) INTO v_orig_entries FROM public.financial_gl_entries;
  SELECT count(*) INTO v_orig_lines FROM public.financial_gl_lines;
  SELECT count(*) INTO v_orig_movements FROM public.account_transactions;
  IF v_orig_entries<>25 OR v_orig_lines<>51 OR v_orig_movements<>361009
    OR EXISTS(SELECT 1 FROM public.financial_accrual_period_reviews)
    OR NOT EXISTS(SELECT 1 FROM supabase_migrations.schema_migrations
      WHERE version='20261115174500'
       AND name='powerhub_financial_d26_tenant_company_accounts_preliminary_reconciliation')
    OR to_regprocedure('public.powerhub_financial_company_accounts_tenant_reconciliation(bigint,text)') IS NULL
  THEN RAISE EXCEPTION 'D26_NOT_INSTALLED_OR_STAGING_BASELINE_CHANGED'; END IF;
  IF NOT EXISTS(
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public'
      AND p.oid='public.powerhub_financial_company_accounts_tenant_reconciliation(bigint,text)'::regprocedure
      AND p.provolatile='s' AND NOT p.prosecdef)
    OR has_function_privilege('anon',
      'public.powerhub_financial_company_accounts_tenant_reconciliation(bigint,text)','EXECUTE')
    OR has_function_privilege('authenticated',
      'public.powerhub_financial_company_accounts_tenant_reconciliation(bigint,text)','EXECUTE')
    OR NOT has_function_privilege('service_role',
      'public.powerhub_financial_company_accounts_tenant_reconciliation(bigint,text)','EXECUTE')
  THEN RAISE EXCEPTION 'D26_INSTALLED_FUNCTION_SECURITY_INVALID';END IF;

  d26:=public.powerhub_financial_company_accounts_tenant_reconciliation(9000000000001,'2026-10');
  main:=public.powerhub_financial_company_accounts_tenant_reconciliation(1,'2026-10');
  rollup:=public.powerhub_financial_gl_tenant_rollup(9000000000001,'2026-10');

  IF (d26->>'tenantId')::bigint<>9000000000001
    OR d26->>'period' IS DISTINCT FROM '2026-10'
    OR d26->>'scope' IS DISTINCT FROM 'TENANT_GLOBAL_COMPANY_ACCOUNTS'
    OR (d26->>'activeSiteCount')::integer<>2
    OR (d26->>'accountCount')::integer<>3
    OR (d26->>'openingBalanceCountedOnceUnverified')::numeric<>300000
    OR (d26->>'totalMovementCount')::bigint<>105544
    OR (d26->>'unlinkedSourceMovementCount')::bigint<>105544
    OR (d26->>'signedMovementNet')::numeric<>6530556
    OR (d26->>'operationalAsOfBalanceUnverified')::numeric<>6830556
    OR (d26->>'transferInCount')::bigint<>10555
    OR (d26->>'transferOutCount')::bigint<>10555
    OR (d26->>'transferAmountDifference')::numeric<>10555
    OR (d26->>'transferCountDifference')::bigint<>0
    OR d26->>'status' IS DISTINCT FROM 'BLOCKED_OPERATIONAL_RECONCILIATION'
    OR NOT(d26->'blockers' @>
      '["MOVEMENTS_WITHOUT_SOURCE_LINK","TRANSFER_SIDES_UNBALANCED"]'::jsonb)
    OR d26->>'accountingCertification' IS DISTINCT FROM 'NOT_CERTIFIED'
    OR d26->>'canBeCertifiedConsolidation' IS DISTINCT FROM 'false'
    OR d26->>'sourceOpeningEvidenceApproved' IS DISTINCT FROM 'false'
    OR d26->>'transferPairingIndependentlyVerified' IS DISTINCT FROM 'false'
    OR d26->>'glAndOperationalCashIndependentlyReconciled' IS DISTINCT FROM 'false'
  THEN RAISE EXCEPTION 'D26_INSTALLED_TEST_TENANT_FALSE_RECONCILIATION';END IF;

  SELECT count(*),coalesce(sum((x->>'openingBalanceUnverified')::numeric),0),
         coalesce(sum((x->>'movementCount')::bigint),0)
  INTO v_account_movements,v_account_opening,v_orig_movements
  FROM jsonb_array_elements(d26->'accounts') x;
  IF v_account_movements<>3 OR v_account_opening<>300000
     OR v_orig_movements<>105544
  THEN RAISE EXCEPTION 'D26_INSTALLED_DUPLICATED_ACCOUNT_OPENING_OR_MOVEMENT'; END IF;

  SELECT coalesce(sum((x->>'movementCount')::bigint),0),
         coalesce(sum((x->>'signedMovementNet')::numeric),0)
  INTO v_site_moves,v_site_net FROM jsonb_array_elements(d26->'sites') x;
  IF v_site_moves<>105544 OR v_site_net<>6530556
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(d26->'sites') x
      WHERE x->>'openingBalanceAllocated' IS DISTINCT FROM 'false')
  THEN RAISE EXCEPTION 'D26_INSTALLED_SITE_TOTALS_DUPLICATED_OR_OPENING_ALLOCATED'; END IF;

  IF (main->>'tenantId')::bigint<>1
    OR (main->>'accountCount')::integer<>2
    OR (main->>'totalMovementCount')::bigint<>250004
    OR main->>'status' IS DISTINCT FROM 'BLOCKED_OPERATIONAL_RECONCILIATION'
    OR main->>'accountingCertification' IS DISTINCT FROM 'NOT_CERTIFIED'
    OR rollup->>'status' IS DISTINCT FROM 'PRELIMINARY_MULTI_SITE_ROLLUP'
    OR rollup->>'companyAccountsIncluded' IS DISTINCT FROM 'false'
    OR rollup->>'sharedCompanyAccountDoubleCountAvoidedByOmission' IS DISTINCT FROM 'true'
    OR rollup->>'accountingCertification' IS DISTINCT FROM 'NOT_CERTIFIED'
    OR rollup->>'isConsolidatedFinancialStatements' IS DISTINCT FROM 'false'
  THEN RAISE EXCEPTION 'D26_INSTALLED_OTHER_TENANT_OR_GL_ROLLUP_LEAK'; END IF;
  BEGIN
    PERFORM public.powerhub_financial_company_accounts_tenant_reconciliation(9000000000002,'2026-10');
  EXCEPTION WHEN SQLSTATE '22023' THEN v_denied:=true; END;
  IF NOT v_denied THEN RAISE EXCEPTION 'D26_INSTALLED_UNKNOWN_TENANT_ALLOWED'; END IF;

  IF (SELECT count(*) FROM public.financial_gl_entries)<>v_orig_entries
    OR (SELECT count(*) FROM public.financial_gl_lines)<>v_orig_lines
    OR (SELECT count(*) FROM public.account_transactions)<>361009
    OR EXISTS(SELECT 1 FROM public.financial_accrual_period_reviews)
  THEN RAISE EXCEPTION 'D26_INSTALLED_REPORT_MODIFIED_FINANCIAL_DATA'; END IF;
END $d26$;
SELECT 'D26_INSTALLED_STAGING_GLOBAL_ACCOUNT_RECONCILIATION_SCOPED_PASS' AS result;
ROLLBACK;