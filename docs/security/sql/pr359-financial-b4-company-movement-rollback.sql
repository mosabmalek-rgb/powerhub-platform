-- B4.2 read-only Staging regression; transaction always rolled back.
BEGIN;
SET LOCAL statement_timeout='120000ms';
DO $qa$
DECLARE nov jsonb; oct jsonb; branch jsonb;
BEGIN
 nov:=public.powerhub_financial_gl_company_movement_audit(1,1,'2026-11');
 oct:=public.powerhub_financial_gl_company_movement_audit(1,1,'2026-10');
 branch:=public.powerhub_financial_gl_company_movement_audit(1,9000000000099,'2026-11');
 IF nov->>'status'<>'LINKED_ACCOUNT_MOVEMENTS_MATCH_NOT_CERTIFIED'
 OR nov->>'accountingCertification'<>'NOT_CERTIFIED'
 OR (nov->>'isApproved')::boolean IS DISTINCT FROM false
 OR (nov->>'linkedMovementCount')::bigint<>9
 OR (nov->>'mismatchCount')::bigint<>0
 OR (nov->>'orphanOperationalSourceCount')::bigint<>0
 OR (nov->>'unlinkedNonFixtureMovementCount')::bigint<>0
 OR (nov->>'fixtureExcludedCount')::bigint<>250000
 OR nov->>'fixtureVerificationStatus'<>'CRYPTOGRAPHICALLY_VERIFIED_TEST_COHORT'
 OR oct->>'status'<>'LINKED_ACCOUNT_MOVEMENTS_MATCH_NOT_CERTIFIED'
 OR (oct->>'linkedMovementCount')::bigint<>4
 OR branch->>'status'<>'BLOCKED_ACCOUNT_MOVEMENT_AUDIT'
 OR (branch->>'aggregateUnresolvedCount')::bigint<>1
 THEN RAISE EXCEPTION 'B4_2_CASH_STAGING_ASSERTION_FAILED';END IF;
 BEGIN
  PERFORM public.powerhub_financial_gl_company_movement_audit(9000000000001,1,'2026-11');
  RAISE EXCEPTION 'B4_2_TENANT_BYPASS';
 EXCEPTION WHEN SQLSTATE '22023' THEN NULL;END;
 BEGIN
  PERFORM public.powerhub_financial_gl_company_movement_audit(1,1,'2026-13');
  RAISE EXCEPTION 'B4_2_BAD_MONTH_ACCEPTED';
 EXCEPTION WHEN SQLSTATE '22023' THEN NULL;END;
 IF has_function_privilege('anon','public.powerhub_financial_gl_company_movement_audit(bigint,bigint,text)','EXECUTE')
 OR has_function_privilege('authenticated','public.powerhub_financial_gl_company_movement_audit(bigint,bigint,text)','EXECUTE')
 OR NOT has_function_privilege('service_role','public.powerhub_financial_gl_company_movement_audit(bigint,bigint,text)','EXECUTE')
 THEN RAISE EXCEPTION 'B4_2_RPC_EXECUTE_EXPOSURE';END IF;
 IF (SELECT count(*) FROM public.financial_gl_entries WHERE tenant_id=1)<>24
 OR (SELECT count(*) FROM public.financial_gl_lines WHERE tenant_id=1)<>49
 OR (SELECT count(*) FROM public.financial_gl_central_allocation_policies WHERE tenant_id=1)<>0
 THEN RAISE EXCEPTION 'B4_2_UNEXPECTED_FINANCIAL_CHANGE';END IF;
END;$qa$;
SELECT 'B4_2_PASS_ROLLBACK_ONLY' AS result;
ROLLBACK;
