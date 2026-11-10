-- Forward repair of financial maker/checker eligibility. Preserve the original cohort,
-- immutable SHA-256, raw rows, report semantics and separation of duties.
-- No manifests or approvals are created or changed by this migration.
DO $preflight$
DECLARE target record; current_sha text;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM information_schema.columns
   WHERE table_schema='public' AND table_name='tenant_members' AND column_name='expires_at')
 OR to_regprocedure('public.powerhub_financial_gl_fixture_manifest_guard()') IS NULL
 OR to_regprocedure('public.powerhub_financial_gl_fixture_manifest_prepare(bigint,bigint,bigint)') IS NULL
 OR to_regprocedure('public.powerhub_financial_gl_fixture_manifest_review(bigint,bigint,bigint,bigint)') IS NULL
 OR to_regprocedure('public.powerhub_financial_gl_opening_evidence_guard()') IS NULL
 OR to_regprocedure('public.powerhub_financial_gl_opening_evidence_submit(bigint,bigint,bigint,bigint,text,text,text,date,text,numeric,bigint)') IS NULL
 OR to_regprocedure('public.powerhub_financial_gl_opening_evidence_review(bigint,bigint,bigint,bigint,boolean,text)') IS NULL
 OR to_regprocedure('public.powerhub_approve_payroll(bigint,bigint,bigint,bigint)') IS NULL
 THEN RAISE EXCEPTION 'GL_FIXTURE_EXPIRY_DEPENDENCY_MISSING' USING ERRCODE='22023';END IF;
 -- Refuse to overwrite an unreviewed live definition. The second hash allows
 -- harmless re-execution of this exact repair on disposable test databases.
 FOR target IN SELECT * FROM (VALUES
  ('public.powerhub_financial_gl_fixture_manifest_guard()','4a27b3dd62caf1934bc2887ca3c51279e9542c935355ea9c12f0b35a7cdd1a0a','2580f918b49a6afaec381ef32b42028f6091fb28aff4c0584f47b1c9a62d80be'),
  ('public.powerhub_financial_gl_fixture_manifest_prepare(bigint,bigint,bigint)','b4e009ed73d11427c5fd5dd682cca001d37994ea6af4edd690cacac31a3eb383','bea7ff353c5370e3dfe9281f8208e97f6b2d02014a537841b139204e51927594'),
  ('public.powerhub_financial_gl_fixture_manifest_review(bigint,bigint,bigint,bigint)','aeef214b9e44168705416ae8173565e7225dd1365e99f2779adc0bf0f1881ff1','774f05bf2c4a74846c2ca04ec9d80abc5a35be2e473ef23bc8fb534eafed1066'),
  ('public.powerhub_financial_gl_opening_evidence_guard()','222cde356637ee0f19e2de166d4da6f086812eeb5aef32f22066e45c414eeee6','b0f728b9892791656d8266e913ea3e1a8257a6355e914f11b925d2ab9f837199'),
  ('public.powerhub_financial_gl_opening_evidence_submit(bigint,bigint,bigint,bigint,text,text,text,date,text,numeric,bigint)','23761ad2b72e0e6ba971444556bfaea15736717ddcb3aa15f2f115dbd7ccaecb','91eebc047e489d352ca56dac710f19fcec4c2e06577051ccea26055a22b2500d'),
  ('public.powerhub_financial_gl_opening_evidence_review(bigint,bigint,bigint,bigint,boolean,text)','7ea4184f1863448672ba465cbf3d78ebaf72b8687c9b7af07c2a85b499dae4c3','b45ce5b10146f2f150e6ae4047971d7ac44c9190122f97e2728cb2b143e8e487'),
  ('public.powerhub_approve_payroll(bigint,bigint,bigint,bigint)','a85672979354a2aff91146ccac9ba188f23aaec2052afec8d07fd4e1959385a3','dd64d57b952fb10060ccd2f47ea85c5261eab2c9a44010137facc21c725b97c4')
 ) AS reviewed(signature,original_sha,repaired_sha) LOOP
  SELECT encode(sha256(convert_to(pg_get_functiondef(to_regprocedure(target.signature)),'UTF8')),'hex')
   INTO current_sha;
  IF current_sha IS NULL OR current_sha NOT IN(target.original_sha,target.repaired_sha)
  THEN RAISE EXCEPTION 'GL_FINANCIAL_REVIEW_SOURCE_DRIFT: %',target.signature USING ERRCODE='22023';END IF;
 END LOOP;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_fixture_manifest_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $guard$
BEGIN
 IF TG_OP='DELETE' THEN
  RAISE EXCEPTION 'GL_FIXTURE_MANIFEST_IMMUTABLE' USING ERRCODE='22023';
 ELSIF TG_OP='INSERT' THEN
  IF NEW.status<>'pending' THEN
   RAISE EXCEPTION 'GL_FIXTURE_MANIFEST_REVIEW_REQUIRED' USING ERRCODE='22023';END IF;
  IF NOT EXISTS(SELECT 1 FROM public.tenant_members m JOIN public.users u
    ON u.id=m.user_id WHERE m.tenant_id=NEW.tenant_id
    AND m.user_id=NEW.prepared_by_user_id AND m.is_active
    AND m.membership_status='active'
    AND (m.expires_at IS NULL OR m.expires_at>statement_timestamp())
    AND m.role IN ('owner','manager','accountant') AND u.account_status='active')
  THEN RAISE EXCEPTION 'GL_FIXTURE_PREPARER_FORBIDDEN' USING ERRCODE='22023';END IF;
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
  AND (m.expires_at IS NULL OR m.expires_at>statement_timestamp())
  AND m.role IN('owner','manager','accountant') AND u.account_status='active'
 ) THEN RAISE EXCEPTION 'GL_FIXTURE_REVIEWER_NOT_AUTHORIZED' USING ERRCODE='22023';END IF;
 RETURN NEW;
END;
$guard$;

CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_fixture_manifest_prepare(
 p_tenant_id bigint,p_site_id bigint,p_actor_id bigint
) RETURNS bigint LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $prepare$
DECLARE v_status jsonb;v_id bigint;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.tenant_members m JOIN public.users u
 ON u.id=m.user_id WHERE m.tenant_id=p_tenant_id AND m.user_id=p_actor_id
 AND m.is_active AND m.membership_status='active'
  AND (m.expires_at IS NULL OR m.expires_at>statement_timestamp()) AND m.role IN ('owner','manager','accountant')
 AND u.account_status='active')
 THEN RAISE EXCEPTION 'GL_FIXTURE_PREPARER_FORBIDDEN' USING ERRCODE='22023';END IF;
 IF p_tenant_id IS DISTINCT FROM 1 OR p_site_id IS DISTINCT FROM 1 THEN
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
DECLARE v_manifest record;v_verified jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.tenant_members m JOIN public.users u
   ON u.id=m.user_id WHERE m.tenant_id=p_tenant_id AND m.user_id=p_reviewer_id
   AND m.is_active AND m.membership_status='active'
  AND (m.expires_at IS NULL OR m.expires_at>statement_timestamp())
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
 v_verified:=public.powerhub_financial_gl_verify_staging_fixture(p_tenant_id,p_site_id);
 IF (v_verified->>'verified')::boolean IS DISTINCT FROM true THEN
   RAISE EXCEPTION 'GL_FIXTURE_REVIEW_CONTENT_MISMATCH: %',
    v_verified->>'reason' USING ERRCODE='23514';
 END IF;
 RETURN jsonb_build_object('manifestId',p_id,'replayed',false,'status','verified');
END;
$review$;


CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_opening_evidence_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $guard$
DECLARE v_line record;v_batch record;
BEGIN
 IF TG_OP='DELETE' THEN
  RAISE EXCEPTION 'GL_OPENING_EVIDENCE_IMMUTABLE' USING ERRCODE='22023';
 END IF;
 IF TG_OP='INSERT' AND NEW.review_status<>'pending' THEN
  RAISE EXCEPTION 'GL_OPENING_EVIDENCE_REVIEW_REQUIRES_WORKFLOW'
    USING ERRCODE='22023';END IF;
 IF TG_OP='INSERT' AND NOT EXISTS(
  SELECT 1 FROM public.tenant_members m JOIN public.users u ON u.id=m.user_id
  WHERE m.tenant_id=NEW.tenant_id AND m.user_id=NEW.prepared_by_user_id
   AND m.is_active AND m.membership_status='active'
   AND (m.expires_at IS NULL OR m.expires_at>statement_timestamp())
   AND m.role IN ('owner','manager','accountant') AND u.account_status='active')
 THEN RAISE EXCEPTION 'GL_OPENING_EVIDENCE_ACTOR_FORBIDDEN' USING ERRCODE='22023';END IF;
 IF TG_OP='UPDATE' THEN
  IF OLD.review_status<>'pending' OR NEW.review_status='pending'
    OR ROW(OLD.tenant_id,OLD.site_id,OLD.opening_id,OLD.opening_line_id,
      OLD.source_kind,OLD.source_reference,OLD.source_document_sha256,
      OLD.source_as_of_date,OLD.supported_side,OLD.supported_amount,
      OLD.prepared_by_user_id,OLD.created_at)
      IS DISTINCT FROM
       ROW(NEW.tenant_id,NEW.site_id,NEW.opening_id,NEW.opening_line_id,
       NEW.source_kind,NEW.source_reference,NEW.source_document_sha256,
       NEW.source_as_of_date,NEW.supported_side,NEW.supported_amount,
       NEW.prepared_by_user_id,NEW.created_at)
  THEN RAISE EXCEPTION 'GL_OPENING_EVIDENCE_IMMUTABLE' USING ERRCODE='22023';END IF;
 END IF;
 SELECT b.as_of_date,b.status,b.created_by_user_id,b.approved_by_user_id,
        b.evidence_reference INTO v_batch
 FROM public.financial_gl_opening_batches b
 WHERE b.id=NEW.opening_id AND b.tenant_id=NEW.tenant_id AND b.site_id=NEW.site_id;
 SELECT l.account_code,l.side,l.amount,l.evidence_reference
 INTO v_line FROM public.financial_gl_opening_lines l
 WHERE l.id=NEW.opening_line_id AND l.opening_id=NEW.opening_id
   AND l.tenant_id=NEW.tenant_id AND l.site_id=NEW.site_id;
 IF v_line IS NULL OR v_batch IS NULL OR v_batch.status<>'posted'
    OR v_batch.as_of_date<>NEW.source_as_of_date
    OR v_line.side<>NEW.supported_side
    OR v_batch.evidence_reference ILIKE '%NOT-CERTIFIED%'
    OR v_line.evidence_reference ILIKE '%NOT-CERTIFIED%'
    OR NEW.source_reference ILIKE '%NOT-CERTIFIED%'
    OR NEW.source_reference ILIKE 'STG-TEST-%'
 THEN RAISE EXCEPTION 'GL_OPENING_EVIDENCE_SOURCE_OR_SCOPE_INVALID'
   USING ERRCODE='22023'; END IF;
 IF (v_line.account_code IN ('1010','1020')
     AND NEW.source_kind<>'company_account_statement')
 OR (v_line.account_code='1200'
     AND NEW.source_kind<>'subscriber_receivable_statement')
 OR (v_line.account_code='1300'
     AND NEW.source_kind<>'inventory_valuation_statement')
 OR (v_line.account_code='2300'
     AND NEW.source_kind<>'supplier_statement')
 OR (v_line.account_code='2400'
     AND NEW.source_kind<>'payroll_liability_statement')
 THEN RAISE EXCEPTION 'GL_OPENING_EVIDENCE_KIND_MISMATCH'
   USING ERRCODE='22023';END IF;
 IF NEW.review_status IN ('verified','rejected') AND
   (NEW.reviewed_by_user_id IS NULL
   OR NEW.reviewed_by_user_id IN (NEW.prepared_by_user_id,
      v_batch.created_by_user_id,v_batch.approved_by_user_id)
   OR NOT EXISTS(SELECT 1 FROM public.tenant_members m
       JOIN public.users u ON u.id=m.user_id
       WHERE m.tenant_id=NEW.tenant_id
        AND m.user_id=NEW.reviewed_by_user_id
        AND m.is_active AND m.membership_status='active'
        AND (m.expires_at IS NULL OR m.expires_at>statement_timestamp())
        AND m.role IN ('owner','manager','accountant')
        AND u.account_status='active'))
 THEN RAISE EXCEPTION 'GL_OPENING_EVIDENCE_REVIEW_NOT_INDEPENDENT'
   USING ERRCODE='22023';END IF;
 RETURN NEW;
END;
$guard$;

CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_opening_evidence_submit(
 p_tenant_id bigint,p_site_id bigint,p_opening_id bigint,
 p_line_id bigint,p_source_kind text,p_source_reference text,
 p_document_sha256 text,p_source_as_of_date date,
 p_side text,p_amount numeric,p_actor_id bigint
) RETURNS bigint LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $submit$
DECLARE v_id bigint;v_existing record;
BEGIN
 IF p_actor_id IS NULL OR NOT EXISTS(
  SELECT 1 FROM public.tenant_members m JOIN public.users u ON u.id=m.user_id
  WHERE m.tenant_id=p_tenant_id AND m.user_id=p_actor_id
    AND m.is_active AND m.membership_status='active'
        AND (m.expires_at IS NULL OR m.expires_at>statement_timestamp())
    AND m.role IN ('owner','manager','accountant')
    AND u.account_status='active'
 ) THEN RAISE EXCEPTION 'GL_OPENING_EVIDENCE_ACTOR_FORBIDDEN'
   USING ERRCODE='22023';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(
   p_tenant_id::text||':gl-opening-evidence:'||p_site_id::text||':'||
   p_line_id::text||':'||p_source_kind||':'||p_source_reference,0));
 SELECT * INTO v_existing FROM public.financial_gl_opening_evidence e
 WHERE e.tenant_id=p_tenant_id AND e.site_id=p_site_id
   AND e.opening_id=p_opening_id AND e.opening_line_id=p_line_id
   AND e.source_kind=p_source_kind
   AND e.source_reference=btrim(p_source_reference)
 FOR UPDATE;
 IF FOUND THEN
  IF v_existing.source_document_sha256 IS DISTINCT FROM p_document_sha256
   OR v_existing.source_as_of_date IS DISTINCT FROM p_source_as_of_date
   OR v_existing.supported_side IS DISTINCT FROM p_side
   OR v_existing.supported_amount IS DISTINCT FROM p_amount
   OR v_existing.prepared_by_user_id IS DISTINCT FROM p_actor_id
  THEN RAISE EXCEPTION 'GL_OPENING_EVIDENCE_REPLAY_CONFLICT'
    USING ERRCODE='23505';END IF;
  RETURN v_existing.id;
 END IF;
 INSERT INTO public.financial_gl_opening_evidence(
  tenant_id,site_id,opening_id,opening_line_id,source_kind,
  source_reference,source_document_sha256,source_as_of_date,
  supported_side,supported_amount,prepared_by_user_id)
 VALUES(p_tenant_id,p_site_id,p_opening_id,p_line_id,
  p_source_kind,btrim(p_source_reference),p_document_sha256,
  p_source_as_of_date,p_side,p_amount,p_actor_id)
 RETURNING id INTO v_id;
 RETURN v_id;
END;
$submit$;

CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_opening_evidence_review(
 p_tenant_id bigint,p_site_id bigint,p_evidence_id bigint,
 p_reviewer_id bigint,p_accept boolean,p_note text
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $review$
DECLARE v_ev record;v_batch record;
BEGIN
 IF p_accept IS NULL OR length(btrim(coalesce(p_note,'')))<12
    OR NOT EXISTS(
      SELECT 1 FROM public.tenant_members m JOIN public.users u ON u.id=m.user_id
      WHERE m.tenant_id=p_tenant_id AND m.user_id=p_reviewer_id
       AND m.is_active AND m.membership_status='active'
        AND (m.expires_at IS NULL OR m.expires_at>statement_timestamp())
       AND m.role IN ('owner','manager','accountant')
       AND u.account_status='active')
 THEN RAISE EXCEPTION 'GL_OPENING_EVIDENCE_REVIEWER_FORBIDDEN'
 USING ERRCODE='22023'; END IF;
 SELECT * INTO v_ev FROM public.financial_gl_opening_evidence e
 WHERE e.id=p_evidence_id AND e.tenant_id=p_tenant_id AND e.site_id=p_site_id
 FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'GL_OPENING_EVIDENCE_OUT_OF_SCOPE'
   USING ERRCODE='22023'; END IF;
 SELECT * INTO v_batch FROM public.financial_gl_opening_batches b
 WHERE b.id=v_ev.opening_id AND b.tenant_id=p_tenant_id AND b.site_id=p_site_id;
 IF p_reviewer_id IN (v_ev.prepared_by_user_id,v_batch.created_by_user_id,v_batch.approved_by_user_id)
 THEN RAISE EXCEPTION 'GL_OPENING_EVIDENCE_REVIEW_NOT_INDEPENDENT'
 USING ERRCODE='22023'; END IF;
 IF v_ev.review_status<>'pending' THEN
   IF v_ev.reviewed_by_user_id<>p_reviewer_id
      OR v_ev.review_status<>(CASE WHEN p_accept THEN 'verified' ELSE 'rejected' END)
      OR v_ev.review_note<>p_note
   THEN RAISE EXCEPTION 'GL_OPENING_EVIDENCE_REPLAY_CONFLICT' USING ERRCODE='23505';END IF;
   RETURN jsonb_build_object('evidenceId',v_ev.id,'status',v_ev.review_status,'replayed',true);
 END IF;
 UPDATE public.financial_gl_opening_evidence
 SET review_status=CASE WHEN p_accept THEN 'verified' ELSE 'rejected' END,
     reviewed_by_user_id=p_reviewer_id,reviewed_at=now(),review_note=btrim(p_note)
 WHERE id=v_ev.id;
 RETURN jsonb_build_object('evidenceId',v_ev.id,
    'status',CASE WHEN p_accept THEN 'verified' ELSE 'rejected' END,'replayed',false);
END;
$review$;

CREATE OR REPLACE FUNCTION public.powerhub_approve_payroll(
 p_tenant_id bigint,p_site_id bigint,p_user_id bigint,p_payroll_run_id bigint
) RETURNS TABLE(payroll_run_id bigint)
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $approve$
DECLARE
 v_period text;v_status text;v_creator bigint;v_approver bigint;
 v_period_start timestamptz;v_period_end timestamptz;v_role text;
BEGIN
 IF p_tenant_id IS NULL OR p_tenant_id<=0 OR p_site_id IS NULL OR p_site_id<=0
    OR p_user_id IS NULL OR p_user_id<=0
    OR p_payroll_run_id IS NULL OR p_payroll_run_id<=0 THEN
   RAISE EXCEPTION 'PAYROLL_APPROVAL_INVALID_SCOPE' USING ERRCODE='22023';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(
   p_tenant_id::text||':payroll-approve:'||p_site_id::text||':'||p_payroll_run_id::text,0));
 SELECT p.period,p.status,p.created_by_user_id,p.approved_by_user_id
 INTO v_period,v_status,v_creator,v_approver
 FROM public.payroll_runs p
 WHERE p.id=p_payroll_run_id AND p.tenant_id=p_tenant_id AND p.site_id=p_site_id
 FOR UPDATE;
 IF NOT FOUND THEN
   RAISE EXCEPTION 'PAYROLL_RUN_OUT_OF_SCOPE' USING ERRCODE='P0001';
 END IF;
 SELECT u.platform_role INTO v_role
 FROM public.users u
 JOIN public.tenant_members m ON m.user_id=u.id
 WHERE u.id=p_user_id AND u.account_status='active'
    AND m.tenant_id=p_tenant_id AND m.is_active
    AND m.membership_status='active'
    AND (m.expires_at IS NULL OR m.expires_at>statement_timestamp())
 LIMIT 1;
 IF NOT FOUND THEN
   RAISE EXCEPTION 'PAYROLL_APPROVER_OUT_OF_TENANT'
     USING ERRCODE='22023';
 END IF;
 IF v_creator=p_user_id THEN
   RAISE EXCEPTION 'PAYROLL_APPROVER_SAME_AS_CREATOR'
     USING ERRCODE='22023';
 END IF;
 -- Network retries return the identical result, with no second audit event.
 -- A different actor cannot silently claim or overwrite an existing approval.
 IF v_status IN ('approved','paid') THEN
   IF v_approver IS DISTINCT FROM p_user_id THEN
     RAISE EXCEPTION 'PAYROLL_APPROVAL_REPLAY_CONFLICT'
       USING ERRCODE='23505';
   END IF;
   RETURN QUERY SELECT p_payroll_run_id;
   RETURN;
 END IF;
 IF v_status<>'draft' THEN
   RAISE EXCEPTION 'PAYROLL_RUN_NOT_DRAFT' USING ERRCODE='P0001';
 END IF;
 v_period_start:=(v_period||'-01')::date;
 v_period_end:=v_period_start+interval '1 month'-interval '1 microsecond';
 IF EXISTS(
   SELECT 1 FROM public.financial_settlements s
   WHERE s.tenant_id=p_tenant_id AND s.site_id=p_site_id
     AND s.status='locked'
     AND s.period_start<=v_period_end AND s.period_end>=v_period_start
 ) THEN
   RAISE EXCEPTION 'FINANCIAL_PERIOD_LOCKED' USING ERRCODE='P0001';
 END IF;
 UPDATE public.payroll_runs
 SET status='approved',approved_by_user_id=p_user_id,updated_at=now()
 WHERE id=p_payroll_run_id AND tenant_id=p_tenant_id AND site_id=p_site_id
   AND status='draft';
 IF NOT FOUND THEN
   RAISE EXCEPTION 'PAYROLL_APPROVAL_CONCURRENT_STATUS_CHANGE'
      USING ERRCODE='23505';
 END IF;
 INSERT INTO public.audit_logs(
   tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data
 ) VALUES(
   p_tenant_id,p_site_id,p_user_id,v_role,'payroll_run',
   p_payroll_run_id::text,'approve',
   jsonb_build_object('period',v_period,'previousStatus',v_status,
     'status','approved','sourceCreatorId',v_creator)
 );
 RETURN QUERY SELECT p_payroll_run_id;
END;
$approve$;

REVOKE ALL ON FUNCTION public.powerhub_financial_gl_fixture_manifest_guard()
 FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.powerhub_financial_gl_fixture_manifest_prepare(bigint,bigint,bigint)
 FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.powerhub_financial_gl_fixture_manifest_review(bigint,bigint,bigint,bigint)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_gl_fixture_manifest_guard() TO service_role;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_gl_fixture_manifest_prepare(bigint,bigint,bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_gl_fixture_manifest_review(bigint,bigint,bigint,bigint) TO service_role;

REVOKE ALL ON FUNCTION public.powerhub_financial_gl_opening_evidence_guard() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_gl_opening_evidence_guard() TO service_role;

REVOKE ALL ON FUNCTION public.powerhub_financial_gl_opening_evidence_submit(bigint,bigint,bigint,bigint,text,text,text,date,text,numeric,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_gl_opening_evidence_submit(bigint,bigint,bigint,bigint,text,text,text,date,text,numeric,bigint) TO service_role;

REVOKE ALL ON FUNCTION public.powerhub_financial_gl_opening_evidence_review(bigint,bigint,bigint,bigint,boolean,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_gl_opening_evidence_review(bigint,bigint,bigint,bigint,boolean,text) TO service_role;

REVOKE ALL ON FUNCTION public.powerhub_approve_payroll(bigint,bigint,bigint,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_approve_payroll(bigint,bigint,bigint,bigint) TO service_role;

DO $postflight$
DECLARE signature text; routine_oid oid;
BEGIN
 FOREACH signature IN ARRAY ARRAY[
  'public.powerhub_financial_gl_fixture_manifest_guard()',
  'public.powerhub_financial_gl_fixture_manifest_prepare(bigint,bigint,bigint)',
  'public.powerhub_financial_gl_fixture_manifest_review(bigint,bigint,bigint,bigint)',
  'public.powerhub_financial_gl_opening_evidence_guard()',
  'public.powerhub_financial_gl_opening_evidence_submit(bigint,bigint,bigint,bigint,text,text,text,date,text,numeric,bigint)',
  'public.powerhub_financial_gl_opening_evidence_review(bigint,bigint,bigint,bigint,boolean,text)',
  'public.powerhub_approve_payroll(bigint,bigint,bigint,bigint)'
 ] LOOP
  routine_oid:=to_regprocedure(signature);
  IF routine_oid IS NULL OR (SELECT prosecdef FROM pg_proc WHERE oid=routine_oid)
   OR has_function_privilege('anon',routine_oid,'EXECUTE')
   OR has_function_privilege('authenticated',routine_oid,'EXECUTE')
   OR NOT has_function_privilege('service_role',routine_oid,'EXECUTE')
   OR EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL
    aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
    WHERE p.oid=routine_oid AND acl.grantee=0 AND acl.privilege_type='EXECUTE')
  THEN RAISE EXCEPTION 'GL_FIXTURE_EXPIRY_ACL_POSTFLIGHT_FAILED: %',signature;
  END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger t
  WHERE t.tgrelid='public.financial_gl_staging_fixture_manifests'::regclass
   AND t.tgfoid='public.powerhub_financial_gl_fixture_manifest_guard()'::regprocedure
   AND NOT t.tgisinternal AND t.tgenabled IN ('O','A'))
 THEN RAISE EXCEPTION 'GL_FIXTURE_EXPIRY_TRIGGER_POSTFLIGHT_FAILED';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger t
  WHERE t.tgrelid='public.financial_gl_opening_evidence'::regclass
   AND t.tgfoid='public.powerhub_financial_gl_opening_evidence_guard()'::regprocedure
   AND NOT t.tgisinternal AND t.tgenabled IN ('O','A'))
 THEN RAISE EXCEPTION 'GL_OPENING_EXPIRY_TRIGGER_POSTFLIGHT_FAILED';END IF;
END;
$postflight$;
NOTIFY pgrst,'reload schema';
