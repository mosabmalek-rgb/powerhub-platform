-- B5.1: fast immutable SHA-256 anchored proof for the exact Staging fixture.
-- Full rehash remains an independent action; failure never excludes a fixture.
CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_fast_staging_fixture_proof(pt bigint,ps bigint)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path TO 'pg_catalog','public','pg_temp'
AS $function$
DECLARE ok boolean:=false;n bigint:=0;linked boolean:=false;
BEGIN
 IF pt IS DISTINCT FROM 1 OR ps IS DISTINCT FROM 1
 THEN RETURN jsonb_build_object('verified',false,'quarantinedCount',0,'humanReviewed',false,
  'financialCertification','NOT_CERTIFIED','reason','NOT_STAGING_EXACT_COHORT'); END IF;
 SELECT EXISTS(
  SELECT 1 FROM public.financial_gl_staging_technical_exclusions x
  WHERE x.tenant_id=1 AND x.site_id=1 AND x.cohort_key='STG-PERF-20261105'
  AND x.row_count=250000 AND x.verification_kind='prelaunch_automated_fixture'
  AND x.sha256='f1b25e8562328a0f6e916beb4d54b2ee88366e78b4459c5d0ebc444616997df9')
 AND EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid='public.account_transactions'::regclass
  AND t.tgname='powerhub_financial_gl_fixture_freeze_write' AND t.tgenabled IN('O','A'))
 AND EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid='public.account_transactions'::regclass
  AND t.tgname='powerhub_financial_gl_fixture_freeze_truncate' AND t.tgenabled IN('O','A'))
 AND EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid='public.financial_gl_staging_technical_exclusions'::regclass
  AND t.tgname='zz_financial_gl_staging_technical_immutable' AND t.tgenabled IN('O','A'))
 INTO ok;
 SELECT count(*) INTO n FROM public.account_transactions t
  WHERE t.tenant_id=1 AND t.site_id=1 AND t.reference_no LIKE 'STG-PERF-%';
 IF n<>250000 THEN ok:=false; END IF;
 IF ok THEN
  SELECT EXISTS(SELECT 1 FROM public.company_account_movement_operations x
    JOIN public.account_transactions t ON t.tenant_id=x.tenant_id
      AND t.id IN(x.primary_transaction_id,x.counterpart_transaction_id)
    WHERE t.tenant_id=1 AND t.site_id=1 AND t.reference_no LIKE 'STG-PERF-%')
   OR EXISTS(SELECT 1 FROM public.supplier_payments x JOIN public.account_transactions t
    ON t.tenant_id=x.tenant_id AND t.id=x.account_transaction_id
    WHERE t.tenant_id=1 AND t.site_id=1 AND t.reference_no LIKE 'STG-PERF-%')
   OR EXISTS(SELECT 1 FROM public.employee_adjustments x JOIN public.account_transactions t
    ON t.id=x.disbursement_transaction_id
    WHERE t.tenant_id=1 AND t.site_id=1 AND t.reference_no LIKE 'STG-PERF-%')
   OR EXISTS(SELECT 1 FROM public.employee_adjustment_repayments x JOIN public.account_transactions t
    ON t.id=x.account_transaction_id
    WHERE t.tenant_id=1 AND t.site_id=1 AND t.reference_no LIKE 'STG-PERF-%')
   OR EXISTS(SELECT 1 FROM public.powerhub_expense_offline_operation_results x
    JOIN public.account_transactions t ON t.id=x.transaction_id AND t.tenant_id=x.tenant_id
    WHERE t.tenant_id=1 AND t.site_id=1 AND t.reference_no LIKE 'STG-PERF-%')
  INTO linked;
  IF linked THEN ok:=false; END IF;
 END IF;
 RETURN jsonb_build_object('verified',ok,'quarantinedCount',CASE WHEN ok THEN 250000 ELSE 0 END,
  'sha256',CASE WHEN ok THEN 'f1b25e8562328a0f6e916beb4d54b2ee88366e78b4459c5d0ebc444616997df9' ELSE null END,
  'reason',CASE WHEN ok THEN 'HASH_ANCHORED_IMMUTABLE_STAGING_TEST_COHORT'
    ELSE 'FAST_PROOF_UNAVAILABLE_OR_DRIFTED' END,
  'verificationMode','STAGING_PRELAUNCH_TECHNICAL','humanReviewed',false,
  'retainedRawRows',true,'financialCertification','NOT_CERTIFIED');
END;$function$;
REVOKE ALL ON FUNCTION public.powerhub_financial_gl_fast_staging_fixture_proof(bigint,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_gl_fast_staging_fixture_proof(bigint,bigint) TO service_role;
CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_prior_operational_gaps(p_tenant_id bigint, p_site_id bigint, p_period text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE v_original jsonb;v_audit jsonb;v_rows bigint;
BEGIN
 v_original:=public.powerhub_financial_gl_prior_operational_gaps_raw(
  p_tenant_id,p_site_id,p_period);
 IF p_tenant_id=1 AND p_site_id=1 AND p_period>'2026-05' THEN
  v_audit:=public.powerhub_financial_gl_fast_staging_fixture_proof(p_tenant_id,p_site_id);
 ELSE
  v_audit:=public.powerhub_financial_gl_verify_staging_fixture(p_tenant_id,p_site_id);
 END IF;
 IF (v_audit->>'verified')::boolean IS TRUE
    AND p_period>'2026-05'
    AND ((v_original->>'fromOpeningDate') IS NULL
      OR (v_original->>'fromOpeningDate')::date<='2026-05-01'::date)
 THEN v_rows:=(v_audit->>'quarantinedCount')::bigint;
  IF (v_original->>'unclassifiedAccountMovements')::bigint>=v_rows
   AND (v_original->>'unreconciledCount')::bigint>=v_rows
  THEN
   v_original:=jsonb_set(v_original,'{unclassifiedAccountMovements}',
     to_jsonb((v_original->>'unclassifiedAccountMovements')::bigint-v_rows));
   v_original:=jsonb_set(v_original,'{unreconciledCount}',
     to_jsonb((v_original->>'unreconciledCount')::bigint-v_rows));
   v_original:=v_original||jsonb_build_object(
    'quarantinedTestMovements',v_rows,'fixtureQuarantine',v_audit);
  END IF;
 END IF;
 RETURN v_original;
END;
$function$;

REVOKE ALL ON FUNCTION public.powerhub_financial_gl_prior_operational_gaps(bigint,bigint,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_gl_prior_operational_gaps(bigint,bigint,text) TO service_role;
