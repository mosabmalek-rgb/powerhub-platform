-- A35: Staging/prelaunch technical exclusion. No user impersonation, no raw deletion.
-- On databases without the exact synthetic cohort, the table stays empty.
CREATE TABLE public.financial_gl_staging_technical_exclusions(
 tenant_id bigint NOT NULL REFERENCES public.tenants(id),
 site_id bigint NOT NULL REFERENCES public.sites(id),
 cohort_key text NOT NULL,
 row_count bigint NOT NULL,
 sha256 text NOT NULL,
 verification_kind text NOT NULL DEFAULT 'prelaunch_automated_fixture',
 recorded_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT gl_staging_technical_exact_cohort CHECK (
  tenant_id=1 AND site_id=1 AND cohort_key='STG-PERF-20261105'
  AND row_count=250000
  AND sha256='f1b25e8562328a0f6e916beb4d54b2ee88366e78b4459c5d0ebc444616997df9'
  AND verification_kind='prelaunch_automated_fixture'),
 PRIMARY KEY(tenant_id,site_id,cohort_key)
);
ALTER TABLE public.financial_gl_staging_technical_exclusions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.financial_gl_staging_technical_exclusions FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.financial_gl_staging_technical_exclusions TO service_role;
CREATE POLICY financial_gl_staging_technical_read
 ON public.financial_gl_staging_technical_exclusions FOR SELECT TO service_role USING(true);
CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_staging_technical_immutable()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $guard$
BEGIN
 RAISE EXCEPTION 'GL_STAGING_TECHNICAL_PROOF_IMMUTABLE' USING ERRCODE='22023';
END;
$guard$;
REVOKE ALL ON FUNCTION public.powerhub_financial_gl_staging_technical_immutable()
 FROM PUBLIC,anon,authenticated;
CREATE TRIGGER zz_financial_gl_staging_technical_immutable
 BEFORE UPDATE OR DELETE ON public.financial_gl_staging_technical_exclusions
 FOR EACH ROW EXECUTE FUNCTION public.powerhub_financial_gl_staging_technical_immutable();
CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_verify_staging_fixture(p_tenant_id bigint, p_site_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
 v_manifest record;v_count bigint;v_bad bigint;v_sha text;
 v_good_accounts bigint;v_external bigint;
BEGIN
 SELECT f.sha256,'HUMAN_INDEPENDENT_REVIEW'::text verification_mode
   INTO v_manifest FROM public.financial_gl_staging_fixture_manifests f
 WHERE f.tenant_id=p_tenant_id AND f.site_id=p_site_id
 AND f.cohort_key='STG-PERF-20261105' AND f.status='verified';
 IF NOT FOUND THEN
  SELECT t.sha256,'STAGING_PRELAUNCH_TECHNICAL'::text verification_mode
  INTO v_manifest FROM public.financial_gl_staging_technical_exclusions t
  WHERE t.tenant_id=p_tenant_id AND t.site_id=p_site_id
    AND t.cohort_key='STG-PERF-20261105' AND t.row_count=250000;
 END IF;
 IF NOT FOUND THEN
  RETURN jsonb_build_object('verified',false,'quarantinedCount',0,
    'reason','NO_REVIEWED_OR_TECHNICAL_FIXTURE');END IF;
 -- This batch is a fixed one-off Staging load, never a generic prefix
 -- exclusion rule. Content hash binds *every column* of all 250,000 rows.
 WITH cohort AS MATERIALIZED (
   SELECT a.* FROM public.account_transactions a
   WHERE a.tenant_id=p_tenant_id AND a.site_id=p_site_id
    AND a.reference_no LIKE 'STG-PERF-%'
 ), aggregate AS (
   SELECT count(*) n,
   count(*) FILTER(WHERE a.reference_no
      !~ '^STG-PERF-20261105-(250K-(CASH|PALPAY)-[0-9]{6}|[0-9]{6})$'
     OR a.description NOT IN (
       'Synthetic 250k scale benchmark movement',
       'Synthetic Staging performance fixture (100k); not a real financial movement')
     OR a.created_by_user_id IS NOT NULL
     OR a.transaction_type NOT IN ('collection','withdrawal')
     OR a.amount NOT IN (1.00,125.00)
     OR a.related_payment_id IS NOT NULL OR a.related_expense_id IS NOT NULL
     OR a.related_supplier_payment_id IS NOT NULL
     OR a.related_supplier_return_id IS NOT NULL
     OR a.related_account_id IS NOT NULL
     OR a.occurred_at<'2026-05-01'::timestamptz
     OR a.occurred_at>='2026-05-04'::timestamptz
     OR a.account_id NOT IN (5,6)) bad,
   encode(extensions.digest(
     string_agg(a.id::text||'='||to_jsonb(a)::text,chr(10) ORDER BY a.id),
     'sha256'),'hex') content_sha256
   FROM cohort a
 ), accounts AS (
   SELECT account_id,count(*) n,
      count(*) FILTER(WHERE transaction_type='collection') receipts,
      count(*) FILTER(WHERE transaction_type='withdrawal') withdrawals,
      coalesce(sum(CASE WHEN transaction_type='collection' THEN amount
       WHEN transaction_type='withdrawal' THEN -amount ELSE NULL END),0) signed_net
   FROM cohort GROUP BY account_id
 )
 SELECT a.n,a.bad,a.content_sha256,
    (SELECT count(*) FROM accounts c WHERE c.n=125000
      AND c.receipts=62500 AND c.withdrawals=62500 AND c.signed_net=0)
 INTO v_count,v_bad,v_sha,v_good_accounts FROM aggregate a;
 IF v_count<>250000 OR v_bad<>0 OR v_sha IS DISTINCT FROM v_manifest.sha256
    OR v_good_accounts<>2
 THEN RETURN jsonb_build_object('verified',false,'quarantinedCount',0,
   'reason','COHORT_CONTENT_OR_BALANCE_DRIFT',
   'currentCount',v_count);END IF;
 -- A new business-side FK could be added without mutating the original
 -- transactions. Any such reference revokes exclusion immediately.
 SELECT
  (SELECT count(*) FROM public.company_account_movement_operations x
    JOIN public.account_transactions c ON c.id=x.primary_transaction_id
     AND c.tenant_id=x.tenant_id AND c.reference_no LIKE 'STG-PERF-%')
 + (SELECT count(*) FROM public.company_account_movement_operations x
    JOIN public.account_transactions c ON c.id=x.counterpart_transaction_id
     AND c.tenant_id=x.tenant_id AND c.reference_no LIKE 'STG-PERF-%')
 + (SELECT count(*) FROM public.employee_adjustments x
    JOIN public.account_transactions c ON c.id=x.disbursement_transaction_id
     AND c.reference_no LIKE 'STG-PERF-%')
 + (SELECT count(*) FROM public.employee_adjustment_repayments x
    JOIN public.account_transactions c ON c.id=x.account_transaction_id
     AND c.reference_no LIKE 'STG-PERF-%')
 + (SELECT count(*) FROM public.powerhub_expense_offline_operation_results x
    JOIN public.account_transactions c ON c.id=x.transaction_id
     AND c.reference_no LIKE 'STG-PERF-%')
 + (SELECT count(*) FROM public.supplier_payments x
    JOIN public.account_transactions c ON c.id=x.account_transaction_id
     AND c.tenant_id=x.tenant_id AND c.reference_no LIKE 'STG-PERF-%')
 INTO v_external;
 IF v_external<>0 THEN RETURN jsonb_build_object('verified',false,
   'quarantinedCount',0,'reason','BUSINESS_REFERENCE_ADDED',
   'references',v_external);END IF;
 RETURN jsonb_build_object('verified',true,'quarantinedCount',v_count,
   'sha256',v_sha,
   'verificationMode',v_manifest.verification_mode,
   'humanReviewed',v_manifest.verification_mode='HUMAN_INDEPENDENT_REVIEW',
   'reason',CASE WHEN v_manifest.verification_mode='STAGING_PRELAUNCH_TECHNICAL'
     THEN 'EXACT_TEST_COHORT_TECHNICALLY_VERIFIED_NOT_HUMAN_REVIEWED'
     ELSE 'APPROVED_EXACT_COHORT_AND_BALANCED' END,
   'retainedRawRows',true,'financialCertification','NOT_CERTIFIED');
END;
$function$
;

REVOKE ALL ON FUNCTION public.powerhub_financial_gl_verify_staging_fixture(bigint,bigint)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_gl_verify_staging_fixture(bigint,bigint)
 TO service_role;
DO $seed$
DECLARE v_count bigint;v_proof jsonb;
BEGIN
 SELECT count(*) INTO v_count FROM public.account_transactions
  WHERE tenant_id=1 AND site_id=1 AND reference_no LIKE 'STG-PERF-%';
 IF v_count=0 THEN RETURN; END IF;
 IF v_count<>250000
 OR EXISTS(SELECT 1 FROM public.financial_gl_staging_fixture_manifests
     WHERE tenant_id=1 AND site_id=1)
 OR EXISTS(SELECT 1 FROM public.financial_gl_entries WHERE tenant_id=1 AND site_id=1)
 OR EXISTS(SELECT 1 FROM public.financial_settlements
     WHERE tenant_id=1 AND site_id=1 AND status='locked')
 THEN RAISE EXCEPTION 'GL_STAGING_TECHNICAL_SEED_PRECONDITION_FAILED'
   USING ERRCODE='23514'; END IF;
 INSERT INTO public.financial_gl_staging_technical_exclusions
 (tenant_id,site_id,cohort_key,row_count,sha256)
 VALUES(1,1,'STG-PERF-20261105',250000,
   'f1b25e8562328a0f6e916beb4d54b2ee88366e78b4459c5d0ebc444616997df9');
 v_proof:=public.powerhub_financial_gl_verify_staging_fixture(1,1);
 IF (v_proof->>'verified')::boolean IS DISTINCT FROM true
    OR (v_proof->>'quarantinedCount')::bigint<>250000
    OR v_proof->>'verificationMode'<>'STAGING_PRELAUNCH_TECHNICAL'
    OR (v_proof->>'humanReviewed')::boolean IS DISTINCT FROM false
    OR v_proof->>'financialCertification'<>'NOT_CERTIFIED'
 THEN RAISE EXCEPTION 'GL_STAGING_TECHNICAL_FULL_SHA_OR_BALANCE_INVALID: %',v_proof
   USING ERRCODE='23514'; END IF;
 INSERT INTO public.audit_logs
 (id,tenant_id,site_id,user_id,action,entity_type,entity_id,
  before_data,after_data,metadata)
 VALUES (nextval('public.audit_logs_id_seq'),1,1,NULL,
 'STAGING_PRELAUNCH_FIXTURE_TECHNICAL_EXCLUSION',
 'synthetic_performance_cohort','STG-PERF-20261105',
 jsonb_build_object('cohortRows',250000,'sourceSha256',v_proof->>'sha256'),
 jsonb_build_object('cohortRowsRetained',250000,'technicallyExcluded',250000,
   'humanReviewed',false,'financialCertification','NOT_CERTIFIED'),
 jsonb_build_object('actorType','AUTOMATED_PRELAUNCH_MIGRATION',
   'auditCategory','TECHNICAL_TEST_FIXTURE','isHumanApproval',false,
   'physicalDeletion',false,'purpose','prelaunch-staging-only'));
END;
$seed$;
NOTIFY pgrst,'reload schema';
