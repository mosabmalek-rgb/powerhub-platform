-- A43: immutable SHA-verified Staging synthetic cohort; history changes fail closed.
-- No committed test rows or actual payments.
BEGIN;
SET LOCAL statement_timeout='70000ms';
DO $qa$
DECLARE e text; fixture_id bigint;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.financial_gl_staging_technical_exclusions
  WHERE tenant_id=1 AND site_id=1 AND cohort_key='STG-PERF-20261105')
 THEN RAISE EXCEPTION 'A43_TEST_MARKER_MISSING';END IF;
 SELECT id INTO fixture_id FROM public.account_transactions
 WHERE tenant_id=1 AND site_id=1 AND reference_no LIKE 'STG-PERF-%' ORDER BY id LIMIT 1;
 IF fixture_id IS NULL THEN RAISE EXCEPTION 'A43_TEST_MISSING_FIXTURE'; END IF;
 BEGIN
  UPDATE public.account_transactions SET amount=amount WHERE id=fixture_id;
  RAISE EXCEPTION 'A43_FIXTURE_UPDATE_ALLOWED';
 EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS e=MESSAGE_TEXT;
  IF e<>'GL_VERIFIED_FIXTURE_COHORT_IMMUTABLE'
  THEN RAISE EXCEPTION 'A43_WRONG_FREEZE_ERROR: %',e; END IF;
 END;
 BEGIN
  INSERT INTO public.account_transactions
   (tenant_id,site_id,account_id,transaction_type,amount,description,reference_no,created_by_user_id,occurred_at)
  VALUES(1,1,5,'collection',1,'A43 rollback attempt to add synthetic fixture',
   'STG-PERF-A43-FAKE',4,'2026-09-29T12:00:00Z');
  RAISE EXCEPTION 'A43_NEW_FIXTURE_INSERT_ALLOWED';
 EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS e=MESSAGE_TEXT;
  IF e<>'GL_VERIFIED_FIXTURE_COHORT_IMMUTABLE'
  THEN RAISE EXCEPTION 'A43_WRONG_INSERT_ERROR: %',e; END IF;
 END;
 BEGIN
  INSERT INTO public.account_transactions
    (tenant_id,site_id,account_id,transaction_type,amount,description,reference_no,created_by_user_id,occurred_at)
  VALUES(1,1,5,'withdrawal',1,'A43 rollback test of historical source',
    'QA-A43-HISTORIC-ROLLBACK',4,'2026-09-29T11:00:00Z');
  IF public.powerhub_financial_gl_zero_opening_preflight(1,1,'2026-09-30') IS DISTINCT FROM false
  THEN RAISE EXCEPTION 'A43_NONFIXTURE_PRIOR_ACTIVITY_IGNORED'; END IF;
  RAISE EXCEPTION 'A43_REVERT_HISTORICAL_TEST_ROW';
 EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS e=MESSAGE_TEXT;
  IF e<>'A43_REVERT_HISTORICAL_TEST_ROW'
  THEN RAISE EXCEPTION 'A43_OTHER_HISTORY_ERROR: %',e;END IF;
 END;
 IF public.powerhub_financial_gl_zero_opening_preflight(1,1,'2026-09-30') IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'A43_ROLLBACK_PRECHECK_FAILED';END IF;
END;$qa$;
SELECT 'PASS_ROLLBACK_ONLY' status;
ROLLBACK;
