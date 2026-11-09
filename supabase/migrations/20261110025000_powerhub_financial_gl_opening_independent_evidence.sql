-- A18: evidence-backed and dual-reviewed opening lines. This is a
-- controllable accounting source-evidence workflow, not a fabricated balance.
-- No opening evidence is created, trusted or auto-approved by this migration.
-- Existing STG-TEST/NOT-CERTIFIED opening lines cannot be verified.
CREATE TABLE public.financial_gl_opening_evidence (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 tenant_id bigint NOT NULL,
 site_id bigint NOT NULL,
 opening_id bigint NOT NULL,
 opening_line_id bigint NOT NULL REFERENCES public.financial_gl_opening_lines(id),
 source_kind text NOT NULL CHECK(source_kind IN (
   'company_account_statement','subscriber_receivable_statement',
   'inventory_valuation_statement','supplier_statement',
   'payroll_liability_statement','tax_statement',
   'equity_confirmation','fixed_asset_register','other_external_statement')),
 source_reference text NOT NULL CHECK(length(btrim(source_reference)) BETWEEN 12 AND 250),
 source_document_sha256 text NOT NULL CHECK(source_document_sha256 ~ '^[0-9a-f]{64}$'),
 source_as_of_date date NOT NULL,
 supported_side text NOT NULL CHECK(supported_side IN ('debit','credit')),
 supported_amount numeric(18,2) NOT NULL CHECK(supported_amount>0),
 prepared_by_user_id bigint NOT NULL REFERENCES public.users(id),
 reviewed_by_user_id bigint REFERENCES public.users(id),
 review_status text NOT NULL DEFAULT 'pending' CHECK(review_status IN ('pending','verified','rejected')),
 created_at timestamptz NOT NULL DEFAULT now(),
 reviewed_at timestamptz,
 review_note text,
 CONSTRAINT financial_gl_opening_evidence_batch_scope
   FOREIGN KEY(opening_id,tenant_id,site_id)
   REFERENCES public.financial_gl_opening_batches(id,tenant_id,site_id)
   ON DELETE RESTRICT,
 CONSTRAINT financial_gl_opening_evidence_unique
   UNIQUE(tenant_id,site_id,opening_line_id,source_kind,source_reference),
 CONSTRAINT financial_gl_opening_evidence_review_separation CHECK(
  (review_status='pending' AND reviewed_by_user_id IS NULL AND reviewed_at IS NULL)
  OR (review_status IN ('verified','rejected') AND reviewed_by_user_id IS NOT NULL
       AND reviewed_by_user_id<>prepared_by_user_id AND reviewed_at IS NOT NULL
       AND length(btrim(coalesce(review_note,'')))>=12))
);
CREATE INDEX financial_gl_opening_evidence_scope_idx
 ON public.financial_gl_opening_evidence(tenant_id,site_id,opening_id,opening_line_id);
ALTER TABLE public.financial_gl_opening_evidence ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.financial_gl_opening_evidence FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON TABLE public.financial_gl_opening_evidence TO service_role;
GRANT USAGE,SELECT ON SEQUENCE public.financial_gl_opening_evidence_id_seq TO service_role;
CREATE POLICY financial_gl_opening_evidence_service
 ON public.financial_gl_opening_evidence
 TO service_role USING(true) WITH CHECK(true);

CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_opening_evidence_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $guard$
DECLARE v_line record;v_batch record;
BEGIN
 IF TG_OP='DELETE' THEN
  RAISE EXCEPTION 'GL_OPENING_EVIDENCE_IMMUTABLE' USING ERRCODE='22023';
 END IF;
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
 IF NEW.review_status='verified' AND (
   NEW.reviewed_by_user_id IS NULL
   OR NEW.reviewed_by_user_id IN (NEW.prepared_by_user_id,
      v_batch.created_by_user_id,v_batch.approved_by_user_id)
 ) THEN RAISE EXCEPTION 'GL_OPENING_EVIDENCE_REVIEW_NOT_INDEPENDENT'
   USING ERRCODE='22023';END IF;
 RETURN NEW;
END;
$guard$;
CREATE TRIGGER zz_gl_opening_evidence_protect
 BEFORE INSERT OR UPDATE OR DELETE ON public.financial_gl_opening_evidence
 FOR EACH ROW EXECUTE FUNCTION public.powerhub_financial_gl_opening_evidence_guard();

-- Evidence can be submitted only through a scope/permission-validated RPC.
CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_opening_evidence_submit(
 p_tenant_id bigint,p_site_id bigint,p_opening_id bigint,
 p_line_id bigint,p_source_kind text,p_source_reference text,
 p_document_sha256 text,p_source_as_of_date date,
 p_side text,p_amount numeric,p_actor_id bigint
) RETURNS bigint LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $submit$
DECLARE v_id bigint;
BEGIN
 IF p_actor_id IS NULL OR NOT EXISTS(
  SELECT 1 FROM public.tenant_members m JOIN public.users u ON u.id=m.user_id
  WHERE m.tenant_id=p_tenant_id AND m.user_id=p_actor_id
    AND m.is_active AND m.membership_status='active'
    AND m.role IN ('owner','manager','accountant')
    AND u.account_status='active'
 ) THEN RAISE EXCEPTION 'GL_OPENING_EVIDENCE_ACTOR_FORBIDDEN'
   USING ERRCODE='22023';END IF;
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

-- Source statements are human-reviewed and referenced by SHA-256; the SQL
-- checks complete account-line coverage, amounts and independent signoff.
-- This DOES NOT prove that an external attachment exists merely because a
-- hash was entered. Reconciliation requires document custody/verification.
CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_opening_evidence_status(
 p_tenant_id bigint,p_site_id bigint,p_period text
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $status$
DECLARE v_batch record;v_missing bigint;v_unverified bigint;v_unsupported bigint;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.sites s WHERE s.tenant_id=p_tenant_id
 AND s.id=p_site_id AND s.status<>'archived')
 OR p_period !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
 THEN RAISE EXCEPTION 'GL_OPENING_EVIDENCE_INVALID_SCOPE'
 USING ERRCODE='22023';END IF;
 SELECT * INTO v_batch FROM public.financial_gl_opening_batches b
 WHERE b.tenant_id=p_tenant_id AND b.site_id=p_site_id
  AND b.status='posted' AND b.as_of_date<=(p_period||'-01')::date
 ORDER BY b.as_of_date,b.id LIMIT 1;
 IF NOT FOUND THEN RETURN jsonb_build_object(
   'status','MISSING_POSTED_OPENING','isIndependentlyReconciled',false,
   'accountBalancesMatchedToOpening',false,
   'sourceSubledgersIndependentlyVerified',false);END IF;
 WITH a AS (
 SELECT l.id,l.amount,l.side,l.account_code,
   count(e.id) total_count,
   count(e.id) FILTER(WHERE e.review_status='verified') verified_count,
   coalesce(sum(e.supported_amount) FILTER(WHERE e.review_status='verified'),0) evidence_amount,
   count(e.id) FILTER(WHERE e.review_status<>'verified') pending_count
 FROM public.financial_gl_opening_lines l
 LEFT JOIN public.financial_gl_opening_evidence e
 ON e.opening_line_id=l.id AND e.opening_id=l.opening_id
  AND e.tenant_id=l.tenant_id AND e.site_id=l.site_id
 WHERE l.tenant_id=p_tenant_id AND l.site_id=p_site_id
 AND l.opening_id=v_batch.id
 GROUP BY l.id,l.amount,l.side,l.account_code
 )
 SELECT count(*) FILTER(WHERE total_count=0 OR verified_count=0
      OR evidence_amount<>amount),
 count(*) FILTER(WHERE pending_count<>0),
 count(*) FILTER(WHERE account_code IN ('1010','1020','1200','1300','2300','2400')
      AND NOT EXISTS(SELECT 1 FROM public.financial_gl_opening_evidence e
        WHERE e.opening_line_id=a.id AND e.review_status='verified'
        AND e.source_kind IN ('company_account_statement',
         'subscriber_receivable_statement','inventory_valuation_statement',
         'supplier_statement','payroll_liability_statement')))
 INTO v_missing,v_unverified,v_unsupported FROM a;
 -- A reviewed evidence statement is an attestation, not proof that the
 -- underlying independent document was fetched and cryptographically checked.
 -- Thus DO NOT set sourceSubledgersIndependentlyVerified=true based solely
 -- on user-provided hashes. This remains fail closed until a source document
 -- custody and verification module is implemented.
 RETURN jsonb_build_object(
  'openingId',v_batch.id,
  'status',CASE WHEN v_missing=0 AND v_unverified=0 AND v_unsupported=0
    THEN 'EVIDENCE_ATTESTED_DOCUMENT_VERIFICATION_REQUIRED'
    ELSE 'EVIDENCE_MISSING_OR_UNREVIEWED' END,
  'linesWithoutMatchedReviewedEvidence',v_missing,
  'linesWithUnreviewedEvidence',v_unverified,
  'missingExpectedSourceCategory',v_unsupported,
  'allLinesAttested',v_missing=0 AND v_unverified=0 AND v_unsupported=0,
  'sourceSubledgersIndependentlyVerified',false,
  'accountBalancesMatchedToOpening',v_missing=0 AND v_unverified=0 AND v_unsupported=0,
  'isIndependentlyReconciled',false);
END;
$status$;
REVOKE ALL ON FUNCTION public.powerhub_financial_gl_opening_evidence_submit(
 bigint,bigint,bigint,bigint,text,text,text,date,text,numeric,bigint)
 FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.powerhub_financial_gl_opening_evidence_review(
 bigint,bigint,bigint,bigint,boolean,text)
 FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.powerhub_financial_gl_opening_evidence_status(
 bigint,bigint,text)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_gl_opening_evidence_submit(
 bigint,bigint,bigint,bigint,text,text,text,date,text,numeric,bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_gl_opening_evidence_review(
 bigint,bigint,bigint,bigint,boolean,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_gl_opening_evidence_status(
 bigint,bigint,text) TO service_role;
NOTIFY pgrst,'reload schema';
