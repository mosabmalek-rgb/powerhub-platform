-- D24: installed Staging financial scope isolation and fail-closed certification.
-- Tenant 1: site 1 vs technical-fixture site 9000000000099.
-- Separate tenant 9000000000001: site 9000000000011 and 9000000000012.
-- All reads/review checks are performed within a rollback-only transaction,
-- because source-audit functions can use SELECT FOR SHARE.
-- No financial DML, no schema changes, and no accounting attestation.
BEGIN;
SET LOCAL statement_timeout='120000ms';
DO $d24$
DECLARE
 main_oct jsonb; main_nov jsonb;fixture_oct jsonb;fixture_nov jsonb;
 other_a jsonb;other_b jsonb;roll_oct jsonb;roll_nov jsonb;
 v_status text;
 v_entries bigint;v_lines bigint;v_movements bigint;
BEGIN
 SELECT count(*) INTO v_entries FROM public.financial_gl_entries;
 SELECT count(*) INTO v_lines FROM public.financial_gl_lines;
 SELECT count(*) INTO v_movements FROM public.account_transactions;
 IF v_entries<>25 OR v_lines<>51 OR v_movements<>361009
 OR (SELECT count(*) FROM public.financial_accrual_period_reviews)<>0
 THEN RAISE EXCEPTION 'D24_STAGING_BASELINE_DRIFT';END IF;

 main_oct:=public.powerhub_financial_gl_source_coverage(1,1,'2026-10');
 main_nov:=public.powerhub_financial_gl_source_coverage(1,1,'2026-11');
 fixture_oct:=public.powerhub_financial_gl_source_coverage(1,9000000000099,'2026-10');
 fixture_nov:=public.powerhub_financial_gl_source_coverage(1,9000000000099,'2026-11');
 other_a:=public.powerhub_financial_gl_source_coverage(9000000000001,9000000000011,'2026-10');
 other_b:=public.powerhub_financial_gl_source_coverage(9000000000001,9000000000012,'2026-10');
 roll_oct:=public.powerhub_financial_gl_tenant_rollup(1,'2026-10');
 roll_nov:=public.powerhub_financial_gl_tenant_rollup(1,'2026-11');

 IF (main_oct->>'tenantId')::bigint<>1 OR (main_oct->>'siteId')::bigint<>1
 OR (main_oct->>'period')<>'2026-10' OR (main_oct#>>'{gl,entries}')::bigint<>10
 OR main_oct->>'isGLStructurallyBalanced' IS DISTINCT FROM 'true'
 OR main_oct->>'isSourceCoverageComplete' IS DISTINCT FROM 'false'
 OR main_oct->>'isOpeningReconciled' IS DISTINCT FROM 'false'
 OR main_oct->'openingEvidenceAudit'->>'status' IS DISTINCT FROM 'MISSING_POSTED_OPENING'
 OR (main_oct->>'unreconciledSourceCount')::bigint<>0
 OR main_oct->>'accountingCertification' IS DISTINCT FROM 'NOT_CERTIFIED'
 THEN RAISE EXCEPTION 'D24_MAIN_SITE_OCT_FALSE_CERTIFICATION'; END IF;

 IF (main_nov->>'tenantId')::bigint<>1 OR (main_nov->>'siteId')::bigint<>1
 OR (main_nov#>>'{gl,entries}')::bigint<>11
 OR main_nov->>'isSourceCoverageComplete' IS DISTINCT FROM 'false'
 OR main_nov->'openingEvidenceAudit'->>'status' IS DISTINCT FROM 'MISSING_POSTED_OPENING'
 OR main_nov->>'accountingCertification' IS DISTINCT FROM 'NOT_CERTIFIED'
 THEN RAISE EXCEPTION 'D24_MAIN_SITE_NOV_FALSE_CERTIFICATION';END IF;

 IF (fixture_oct->>'tenantId')::bigint<>1
 OR (fixture_oct->>'siteId')::bigint<>9000000000099
 OR (fixture_oct#>>'{gl,entries}')::bigint<>1
 OR fixture_oct->>'isSourceCoverageComplete' IS DISTINCT FROM 'true'
 OR fixture_oct->>'isOpeningReconciled' IS DISTINCT FROM 'false'
 OR fixture_oct->'openingEvidenceAudit'->>'status'
    IS DISTINCT FROM 'INDEPENDENT_SUBLEDGER_RECONCILIATION_REQUIRED'
 OR fixture_oct->>'accountingCertification' IS DISTINCT FROM 'NOT_CERTIFIED'
 THEN RAISE EXCEPTION 'D24_FIXTURE_SITE_OCT_FALSE_CERTIFICATION';END IF;

 IF (fixture_nov#>>'{gl,entries}')::bigint<>1
 OR (fixture_nov->'sourceIntegrity'->>'isClean') IS DISTINCT FROM 'false'
 OR (fixture_nov->'sourceIntegrity'->>'unauditedEntries')::bigint<>1
 OR (fixture_nov->>'unreconciledSourceCount')::bigint<>1
 OR fixture_nov->>'isSourceCoverageComplete' IS DISTINCT FROM 'false'
 OR fixture_nov->>'accountingCertification' IS DISTINCT FROM 'NOT_CERTIFIED'
 THEN RAISE EXCEPTION 'D24_FIXTURE_UNAUDITED_SOURCE_MISTAKEN_FOR_CLEAN';END IF;

 IF (other_a->>'tenantId')::bigint<>9000000000001
 OR (other_a->>'siteId')::bigint<>9000000000011
 OR (other_b->>'tenantId')::bigint<>9000000000001
 OR (other_b->>'siteId')::bigint<>9000000000012
 OR (other_a#>>'{gl,entries}')::bigint<>0
 OR (other_b#>>'{gl,entries}')::bigint<>0
 OR (other_a#>>'{sources,companyAccountMovements,unclassified}')::bigint<>19107
 OR (other_b#>>'{sources,companyAccountMovements,unclassified}')::bigint<>19107
 OR (other_a->>'unreconciledSourceCount')::bigint<>52772
 OR (other_b->>'unreconciledSourceCount')::bigint<>52772
 OR other_a->'openingEvidenceAudit'->>'status' IS DISTINCT FROM 'MISSING_POSTED_OPENING'
 OR other_b->'openingEvidenceAudit'->>'status' IS DISTINCT FROM 'MISSING_POSTED_OPENING'
 OR other_a->>'isSourceCoverageComplete' IS DISTINCT FROM 'false'
 OR other_b->>'isSourceCoverageComplete' IS DISTINCT FROM 'false'
 OR other_a->>'accountingCertification' IS DISTINCT FROM 'NOT_CERTIFIED'
 OR other_b->>'accountingCertification' IS DISTINCT FROM 'NOT_CERTIFIED'
 THEN RAISE EXCEPTION 'D24_OTHER_TENANT_MISSING_GL_FALSE_EMPTY_ACCEPTANCE';END IF;

 IF roll_oct->>'status' IS DISTINCT FROM 'PRELIMINARY_MULTI_SITE_ROLLUP'
 OR (roll_oct->>'siteCount')::bigint<>2
 OR (roll_oct->>'glEntryCount')::bigint<>13
 OR roll_oct->>'isConsolidatedFinancialStatements' IS DISTINCT FROM 'false'
 OR roll_oct->>'isFinalBalanceSheet' IS DISTINCT FROM 'false'
 OR roll_oct->>'accountingCertification' IS DISTINCT FROM 'NOT_CERTIFIED'
 OR roll_oct->'readiness'->>'canBeCertifiedConsolidation' IS DISTINCT FROM 'false'
 OR roll_nov->>'status' IS DISTINCT FROM 'PRELIMINARY_MULTI_SITE_ROLLUP'
 OR (roll_nov->>'siteCount')::bigint<>2
 OR (roll_nov->>'glEntryCount')::bigint<>25
 OR (roll_nov->>'unreconciledSourceCount')::bigint<>1
 OR roll_nov->>'isConsolidatedFinancialStatements' IS DISTINCT FROM 'false'
 OR roll_nov->>'accountingCertification' IS DISTINCT FROM 'NOT_CERTIFIED'
 OR roll_nov->'readiness'->>'canBeCertifiedConsolidation' IS DISTINCT FROM 'false'
 THEN RAISE EXCEPTION 'D24_CROSS_SITE_PRELIMINARY_MISTAKEN_FOR_CONSOLIDATED';END IF;

 v_status:=NULL;
 BEGIN
   PERFORM public.powerhub_financial_gl_source_coverage(9000000000001,1,'2026-10');
 EXCEPTION WHEN SQLSTATE '22023' THEN v_status:=SQLERRM;
 END;
 IF v_status IS NULL OR v_status NOT LIKE '%SCOPE%' THEN
   RAISE EXCEPTION 'D24_CROSS_TENANT_SITE_READ_NOT_REJECTED code=%',v_status;
 END IF;
 v_status:=NULL;
 BEGIN
   PERFORM public.powerhub_financial_gl_source_coverage(1,9000000000011,'2026-10');
 EXCEPTION WHEN SQLSTATE '22023' THEN v_status:=SQLERRM;
 END;
 IF v_status IS NULL OR v_status NOT LIKE '%SCOPE%' THEN
   RAISE EXCEPTION 'D24_REVERSE_CROSS_TENANT_SITE_READ_NOT_REJECTED code=%',v_status;
 END IF;

 IF (SELECT count(*) FROM public.financial_gl_entries)<>v_entries
 OR (SELECT count(*) FROM public.financial_gl_lines)<>v_lines
 OR (SELECT count(*) FROM public.account_transactions)<>v_movements
 OR (SELECT count(*) FROM public.financial_accrual_period_reviews)<>0
 THEN RAISE EXCEPTION 'D24_REPORT_READS_CHANGED_FINANCIAL_BASELINE';END IF;
END $d24$;
SELECT 'D24_MULTI_SITE_MULTI_TENANT_FINANCIAL_FAIL_CLOSED_ROLLBACK_PASS' AS result;
ROLLBACK;