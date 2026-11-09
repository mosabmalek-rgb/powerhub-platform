-- A19: audited *logical* quarantine for the exact known Staging
-- 2026-05 performance fixture cohort. Raw rows remain in account_transactions.
-- No DELETE, UPDATE, disabling Delta, or changes to cash/account balances.
-- When no explicit independently reviewed manifest exists, 100% of original
-- financial source coverage remains unchanged. Safe default in Production.
CREATE TABLE public.financial_gl_staging_fixture_manifests(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 tenant_id bigint NOT NULL REFERENCES public.tenants(id),
 site_id bigint NOT NULL REFERENCES public.sites(id),
 cohort_key text NOT NULL,
 row_count bigint NOT NULL CHECK(row_count=250000),
 sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 prepared_by_user_id bigint NOT NULL REFERENCES public.users(id),
 reviewed_by_user_id bigint REFERENCES public.users(id),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','verified')),
 prepared_at timestamptz NOT NULL DEFAULT now(),
 reviewed_at timestamptz,
 CONSTRAINT gl_staging_fixture_manifest_unique UNIQUE(tenant_id,site_id,cohort_key),
 CONSTRAINT gl_staging_fixture_review_split CHECK(
  (status='pending' AND reviewed_by_user_id IS NULL AND reviewed_at IS NULL)
  OR (status='verified' AND reviewed_by_user_id IS NOT NULL
    AND reviewed_by_user_id<>prepared_by_user_id AND reviewed_at IS NOT NULL)),
 CONSTRAINT gl_staging_fixture_known_cohort CHECK(
  cohort_key='STG-PERF-20261105' AND tenant_id=1 AND site_id=1
  AND sha256='f1b25e8562328a0f6e916beb4d54b2ee88366e78b4459c5d0ebc444616997df9')
);
CREATE INDEX financial_gl_staging_fixture_manifest_scope
 ON public.financial_gl_staging_fixture_manifests(tenant_id,site_id,status);
ALTER TABLE public.financial_gl_staging_fixture_manifests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.financial_gl_staging_fixture_manifests FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.financial_gl_staging_fixture_manifests TO service_role;
REVOKE ALL ON SEQUENCE public.financial_gl_staging_fixture_manifests_id_seq FROM PUBLIC,anon,authenticated;
GRANT USAGE,SELECT ON SEQUENCE public.financial_gl_staging_fixture_manifests_id_seq TO service_role;
CREATE POLICY financial_gl_staging_fixture_manifest_service
 ON public.financial_gl_staging_fixture_manifests TO service_role
 USING(true) WITH CHECK(true);

CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_fixture_manifest_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $guard$
BEGIN
 IF TG_OP='DELETE' THEN
  RAISE EXCEPTION 'GL_FIXTURE_MANIFEST_IMMUTABLE' USING ERRCODE='22023';
 ELSIF TG_OP='INSERT' THEN
  IF NEW.status<>'pending' THEN
   RAISE EXCEPTION 'GL_FIXTURE_MANIFEST_REVIEW_REQUIRED' USING ERRCODE='22023';END IF;
  RETURN NEW;
 ELSIF OLD.status<>'pending'
 OR NEW.status<>'verified'
 OR ROW(OLD.tenant_id,OLD.site_id,OLD.cohort_key,OLD.row_count,
        OLD.sha256,OLD.prepared_by_user_id,OLD.prepared_at)
 IS DISTINCT FROM
    ROW(NEW.tenant_id,NEW.site_id,NEW.cohort_key,NEW.row_count,
        NEW.sha256,NEW.prepared_by_user_id,NEW.prepared_at)
 THEN RAISE EXCEPTION 'GL_FIXTURE_MANIFEST_IMMUTABLE' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(
 SELECT 1 FROM public.tenant_members m JOIN public.users u ON u.id=m.user_id
 WHERE m.tenant_id=NEW.tenant_id AND m.user_id=NEW.reviewed_by_user_id
  AND m.is_active AND m.membership_status='active'
  AND m.role IN('owner','manager','accountant') AND u.account_status='active'
 ) THEN RAISE EXCEPTION 'GL_FIXTURE_REVIEWER_NOT_AUTHORIZED' USING ERRCODE='22023';END IF;
 RETURN NEW;
END;
$guard$;
CREATE TRIGGER zz_financial_gl_staging_fixture_manifest_guard
 BEFORE INSERT OR UPDATE OR DELETE ON public.financial_gl_staging_fixture_manifests
 FOR EACH ROW EXECUTE FUNCTION public.powerhub_financial_gl_fixture_manifest_guard();

CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_verify_staging_fixture(
 p_tenant_id bigint,p_site_id bigint
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path=pg_catalog,public,extensions,pg_temp AS $verify$
DECLARE
 v_manifest record;v_count bigint;v_bad bigint;v_sha text;
 v_good_accounts bigint;v_external bigint;
BEGIN
 SELECT * INTO v_manifest FROM public.financial_gl_staging_fixture_manifests f
 WHERE f.tenant_id=p_tenant_id AND f.site_id=p_site_id
 AND f.cohort_key='STG-PERF-20261105' AND f.status='verified';
 IF NOT FOUND THEN
  RETURN jsonb_build_object('verified',false,'quarantinedCount',0,
    'reason','NO_APPROVED_MANIFEST');END IF;
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
   'sha256',v_sha,'reason','APPROVED_EXACT_COHORT_AND_BALANCED',
   'retainedRawRows',true,'financialCertification','NOT_CERTIFIED');
END;
$verify$;

CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_fixture_manifest_prepare(
 p_tenant_id bigint,p_site_id bigint,p_actor_id bigint
) RETURNS bigint LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $prepare$
DECLARE v_status jsonb;v_id bigint;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.tenant_members m JOIN public.users u
 ON u.id=m.user_id WHERE m.tenant_id=p_tenant_id AND m.user_id=p_actor_id
 AND m.is_active AND m.membership_status='active' AND m.role IN ('owner','manager','accountant')
 AND u.account_status='active')
 THEN RAISE EXCEPTION 'GL_FIXTURE_PREPARER_FORBIDDEN' USING ERRCODE='22023';END IF;
 IF p_tenant_id<>1 OR p_site_id<>1 THEN
  RAISE EXCEPTION 'GL_FIXTURE_SCOPE_FORBIDDEN' USING ERRCODE='22023'; END IF;
 -- Explicit one-off evidence: SQL provenance file must be run separately
 -- before preparation; the reviewed manifest binds the SHA and row count.
 INSERT INTO public.financial_gl_staging_fixture_manifests(
  tenant_id,site_id,cohort_key,row_count,sha256,prepared_by_user_id)
 VALUES(1,1,'STG-PERF-20261105',250000,
 'f1b25e8562328a0f6e916beb4d54b2ee88366e78b4459c5d0ebc444616997df9',
 p_actor_id)
 ON CONFLICT(tenant_id,site_id,cohort_key) DO NOTHING
 RETURNING id INTO v_id;
 IF v_id IS NULL THEN
  SELECT id INTO v_id FROM public.financial_gl_staging_fixture_manifests
  WHERE tenant_id=1 AND site_id=1 AND cohort_key='STG-PERF-20261105';
 END IF;
 RETURN v_id;
END;
$prepare$;

CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_fixture_manifest_review(
 p_tenant_id bigint,p_site_id bigint,p_id bigint,p_reviewer_id bigint
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $review$
DECLARE v_manifest record;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.tenant_members m JOIN public.users u
   ON u.id=m.user_id WHERE m.tenant_id=p_tenant_id AND m.user_id=p_reviewer_id
   AND m.is_active AND m.membership_status='active'
   AND m.role IN('owner','manager','accountant') AND u.account_status='active')
 THEN RAISE EXCEPTION 'GL_FIXTURE_REVIEWER_FORBIDDEN' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_manifest FROM public.financial_gl_staging_fixture_manifests f
 WHERE f.id=p_id AND f.tenant_id=p_tenant_id AND f.site_id=p_site_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'GL_FIXTURE_MANIFEST_NOT_FOUND' USING ERRCODE='22023';END IF;
 IF v_manifest.prepared_by_user_id=p_reviewer_id THEN
  RAISE EXCEPTION 'GL_FIXTURE_SELF_REVIEW' USING ERRCODE='22023';END IF;
 IF v_manifest.status='verified' THEN
  IF v_manifest.reviewed_by_user_id<>p_reviewer_id
  THEN RAISE EXCEPTION 'GL_FIXTURE_REVIEW_CONFLICT' USING ERRCODE='23505';END IF;
  RETURN jsonb_build_object('manifestId',p_id,'replayed',true,'status','verified');
 END IF;
 UPDATE public.financial_gl_staging_fixture_manifests f
 SET status='verified',reviewed_by_user_id=p_reviewer_id,reviewed_at=now()
 WHERE f.id=p_id;
 RETURN jsonb_build_object('manifestId',p_id,'replayed',false,'status','verified');
END;
$review$;

-- Preserve a read-only raw implementation. The public wrapper subtracts
-- precisely the independently approved, unchanged test cohort from the
-- *unclassified* source gap, and still reports the 250k raw fixture rows.
ALTER FUNCTION public.powerhub_financial_gl_prior_operational_gaps(
 bigint,bigint,text) RENAME TO powerhub_financial_gl_prior_operational_gaps_raw;
REVOKE ALL ON FUNCTION public.powerhub_financial_gl_prior_operational_gaps_raw(
 bigint,bigint,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_gl_prior_operational_gaps_raw(
 bigint,bigint,text) TO service_role;
CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_prior_operational_gaps(
 p_tenant_id bigint,p_site_id bigint,p_period text
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $wrapper$
DECLARE v_original jsonb;v_audit jsonb;v_rows bigint;
BEGIN
 v_original:=public.powerhub_financial_gl_prior_operational_gaps_raw(
  p_tenant_id,p_site_id,p_period);
 v_audit:=public.powerhub_financial_gl_verify_staging_fixture(
  p_tenant_id,p_site_id);
 IF (v_audit->>'verified')::boolean IS TRUE
    AND p_period>'2026-05'
    AND (v_original->>'fromOpeningDate') IS NULL
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
$wrapper$;

REVOKE ALL ON FUNCTION public.powerhub_financial_gl_verify_staging_fixture(bigint,bigint)
 FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.powerhub_financial_gl_fixture_manifest_prepare(bigint,bigint,bigint)
 FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.powerhub_financial_gl_fixture_manifest_review(bigint,bigint,bigint,bigint)
 FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.powerhub_financial_gl_prior_operational_gaps(bigint,bigint,text)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_gl_verify_staging_fixture(bigint,bigint)
 TO service_role;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_gl_fixture_manifest_prepare(bigint,bigint,bigint)
 TO service_role;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_gl_fixture_manifest_review(bigint,bigint,bigint,bigint)
 TO service_role;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_gl_prior_operational_gaps(bigint,bigint,text)
 TO service_role;
NOTIFY pgrst,'reload schema';
