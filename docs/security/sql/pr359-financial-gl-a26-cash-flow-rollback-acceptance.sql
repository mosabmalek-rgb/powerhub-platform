-- A26: Staging-only rollback test of reviewed fixture effects on cash flow.
-- No durable users, manifest, or financial certification.
BEGIN;
CREATE TEMP TABLE a25_results(kind text,proof jsonb) ON COMMIT DROP;
DO $a25$
DECLARE mid bigint; reviewed jsonb; replay jsonb; proof jsonb; coverage jsonb; blocked boolean;
 full_flow jsonb; day_flow jsonb; day_raw jsonb; month_raw jsonb; november jsonb; november_raw jsonb;
 day_in numeric;day_out numeric;day_count bigint;
BEGIN
 IF EXISTS(SELECT 1 FROM public.financial_gl_staging_fixture_manifests
   WHERE tenant_id=1 AND site_id=1)
 THEN RAISE EXCEPTION 'A25_MANIFEST_ALREADY_EXISTS';END IF;
 INSERT INTO auth.users(id,email) VALUES
 ('a2500000-0000-4000-8000-000000000001','a25-maker@invalid.example'),
 ('a2500000-0000-4000-8000-000000000002','a25-checker@invalid.example');
 INSERT INTO public.users(id,auth_user_id,name,role) VALUES
 (90000000002501,'a2500000-0000-4000-8000-000000000001','A25 TEMP MAKER','user'),
 (90000000002502,'a2500000-0000-4000-8000-000000000002','A25 TEMP CHECKER','user');
 INSERT INTO public.tenant_members(id,tenant_id,user_id,role,is_active,membership_status)
 VALUES (90000000002501,1,90000000002501,'owner',true,'active'),
 (90000000002502,1,90000000002502,'owner',true,'active');

 mid:=public.powerhub_financial_gl_fixture_manifest_prepare(1,1,90000000002501);
 -- The guard must fail rather than show inflated May cash before review.
 blocked:=false;
 BEGIN
   PERFORM public.powerhub_financial_period_cash_flow(1,1,
      '2026-05-01T00:00:00Z'::timestamptz,
      '2026-05-02T00:00:00Z'::timestamptz);
 EXCEPTION WHEN SQLSTATE '23514' THEN
   IF SQLERRM LIKE 'GL_CASHFLOW_FIXTURE_REVIEW_REQUIRED:%' THEN blocked:=true;
   ELSE RAISE; END IF;
 END;
 IF NOT blocked THEN RAISE EXCEPTION 'A26_UNREVIEWED_CASH_FLOW_ALLOWED'; END IF;
 blocked:=false;
 BEGIN
   PERFORM public.powerhub_financial_gl_fixture_manifest_review(1,1,mid,90000000002501);
 EXCEPTION WHEN SQLSTATE '22023' THEN
   IF SQLERRM='GL_FIXTURE_SELF_REVIEW' THEN blocked:=true; ELSE RAISE; END IF;
 END;
 IF NOT blocked THEN RAISE EXCEPTION 'A25_SELF_REVIEW_ACCEPTED';END IF;
 UPDATE public.tenant_members SET expires_at=statement_timestamp()-interval '1 day'
 WHERE tenant_id=1 AND user_id=90000000002502;
 blocked:=false;
 BEGIN
   PERFORM public.powerhub_financial_gl_fixture_manifest_review(1,1,mid,90000000002502);
 EXCEPTION WHEN SQLSTATE '22023' THEN
   IF SQLERRM='GL_FIXTURE_REVIEWER_FORBIDDEN' THEN blocked:=true;ELSE RAISE;END IF;
 END;
 IF NOT blocked THEN RAISE EXCEPTION 'A25_EXPIRED_REVIEWER_ACCEPTED';END IF;
 UPDATE public.tenant_members SET expires_at=NULL
 WHERE tenant_id=1 AND user_id=90000000002502;
 reviewed:=public.powerhub_financial_gl_fixture_manifest_review(1,1,mid,90000000002502);

 replay:=public.powerhub_financial_gl_fixture_manifest_review(1,1,mid,90000000002502);
 IF (replay->>'replayed')::boolean IS DISTINCT FROM true
 OR (replay->>'manifestId')::bigint<>mid
 THEN RAISE EXCEPTION 'A26_REVIEW_REPLAY_FAILED';END IF;
 proof:=public.powerhub_financial_gl_verify_staging_fixture(1,1);
 IF reviewed->>'status'<>'verified' OR (proof->>'verified')::boolean IS DISTINCT FROM true
   OR (proof->>'quarantinedCount')::bigint<>250000
   OR proof->>'financialCertification'<>'NOT_CERTIFIED'
 THEN RAISE EXCEPTION 'A25_INDEPENDENT_COHORT_PROOF_FAILED';END IF;

 -- May contains only test movements: both gross sides must disappear.
 month_raw:=public.powerhub_financial_period_cash_flow_raw(1,1,
   '2026-05-01T00:00:00Z'::timestamptz,
   '2026-06-01T00:00:00Z'::timestamptz);
 full_flow:=public.powerhub_financial_period_cash_flow(1,1,
   '2026-05-01T00:00:00Z'::timestamptz,
   '2026-06-01T00:00:00Z'::timestamptz);
 IF (month_raw->>'transactionCount')::bigint<>250000
 OR (full_flow->>'fixtureExcludedMovements')::bigint<>250000
 OR (full_flow->>'transactionCount')::bigint<>0
 OR (full_flow->>'externalCashIn')::numeric<>0
 OR (full_flow->>'externalCashOut')::numeric<>0
 OR (full_flow->>'netCashFlow')::numeric<>0
 THEN RAISE EXCEPTION 'A26_FULL_MONTH_FIXTURE_NOT_EXCLUDED'; END IF;
 day_raw:=public.powerhub_financial_period_cash_flow_raw(1,1,
   '2026-05-01T00:00:00Z'::timestamptz,
   '2026-05-02T00:00:00Z'::timestamptz);
 day_flow:=public.powerhub_financial_period_cash_flow(1,1,
   '2026-05-01T00:00:00Z'::timestamptz,
   '2026-05-02T00:00:00Z'::timestamptz);
 SELECT count(*),
   coalesce(sum(amount) FILTER(WHERE transaction_type IN ('collection','deposit')),0),
   coalesce(sum(amount) FILTER(WHERE transaction_type='withdrawal'),0)
 INTO day_count,day_in,day_out FROM public.account_transactions
 WHERE tenant_id=1 AND site_id=1 AND reference_no LIKE 'STG-PERF-%'
 AND occurred_at>='2026-05-01T00:00:00Z'::timestamptz
 AND occurred_at<'2026-05-02T00:00:00Z'::timestamptz;
 IF day_count<=0 OR day_count>=250000 OR day_in=day_out
 OR (day_flow->>'fixtureExcludedMovements')::bigint<>day_count
 OR (day_flow->>'transactionCount')::bigint<>(day_raw->>'transactionCount')::bigint-day_count
 OR (day_flow->>'externalCashIn')::numeric<>(day_raw->>'externalCashIn')::numeric-day_in
 OR (day_flow->>'externalCashOut')::numeric<>(day_raw->>'externalCashOut')::numeric-day_out
 OR (day_flow->>'netCashFlow')::numeric<>(day_raw->>'netCashFlow')::numeric-day_in+day_out
 OR (day_flow->>'netCashFlow')::numeric<>(day_flow->>'externalCashIn')::numeric-(day_flow->>'externalCashOut')::numeric
 OR day_flow->>'fixtureTreatment'<>'EXACT_REVIEWED_COHORT_EXCLUDED'
 OR day_flow->>'fixtureEvidenceSha256'<>proof->>'sha256'
 OR day_flow->>'accountingCertification'<>'NOT_CERTIFIED'
 THEN RAISE EXCEPTION 'A26_PARTIAL_DAY_EXCLUSION_DRIFT: % %',day_raw,day_flow;END IF;
 -- A month with no fixture should stay exactly equal to the raw source.
 november_raw:=public.powerhub_financial_period_cash_flow_raw(1,1,
  '2026-11-01T00:00:00Z'::timestamptz,'2026-12-01T00:00:00Z'::timestamptz);
 november:=public.powerhub_financial_period_cash_flow(1,1,
  '2026-11-01T00:00:00Z'::timestamptz,'2026-12-01T00:00:00Z'::timestamptz);
 IF (november->>'fixtureExcludedMovements')::bigint<>0
 OR november->>'fixtureTreatment'<>'NO_FIXTURE_IN_SCOPED_PERIOD'
 OR november->>'accountingCertification'<>'NOT_CERTIFIED'
 OR (november->>'externalCashIn')::numeric<>(november_raw->>'externalCashIn')::numeric
 OR (november->>'externalCashOut')::numeric<>(november_raw->>'externalCashOut')::numeric
 OR (november->>'netCashFlow')::numeric<>(november_raw->>'netCashFlow')::numeric
 OR (november->>'transactionCount')::bigint<>(november_raw->>'transactionCount')::bigint
 THEN RAISE EXCEPTION 'A26_NO_FIXTURE_MONTH_CHANGED'; END IF;
 INSERT INTO a25_results VALUES
 ('cashflow_full_month',jsonb_build_object(
    'rawCount',month_raw->>'transactionCount',
    'excludedCount',full_flow->>'fixtureExcludedMovements',
    'remainingCount',full_flow->>'transactionCount',
    'net',full_flow->>'netCashFlow')),
 ('cashflow_partial_day',jsonb_build_object(
    'rawCount',day_raw->>'transactionCount',
    'fixtureCount',day_count,
    'fixtureIn',day_in,'fixtureOut',day_out,
    'remainingCount',day_flow->>'transactionCount',
    'remainingNet',day_flow->>'netCashFlow')),
 ('cashflow_november',jsonb_build_object(
    'cashIn',november->>'externalCashIn',
    'cashOut',november->>'externalCashOut',
    'net',november->>'netCashFlow',
    'excluded',november->>'fixtureExcludedMovements'));
 coverage:=public.powerhub_financial_gl_source_coverage(1,1,'2026-11');
 IF (coverage->>'unreconciledSourceCount')::bigint<>27
   OR (coverage->'sources'->'priorOperationalSources'->>'quarantinedTestMovements')::bigint<>250000
   OR coverage->>'accountingCertification'<>'NOT_CERTIFIED'
 THEN RAISE EXCEPTION 'A25_COVERAGE_NOT_EXACT: %',coverage->>'unreconciledSourceCount';END IF;
 INSERT INTO a25_results VALUES
 ('manifest',reviewed),('verification',proof),
 ('coverage',jsonb_build_object('unresolved',27,'quarantined',250000,'certification','NOT_CERTIFIED'));
END;
$a25$;
SELECT kind,proof FROM a25_results ORDER BY kind;
ROLLBACK;
