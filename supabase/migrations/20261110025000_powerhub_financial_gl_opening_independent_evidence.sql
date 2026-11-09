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

-- Keep the existing coverage contract while reporting independently reviewed
-- source-document attestations as diagnostic evidence. No attestation or
-- human signature alone changes isOpeningReconciled or NOT_CERTIFIED.
CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_source_coverage(
 p_tenant_id bigint,p_site_id bigint,p_period text
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $coverage$
DECLARE
 v_start timestamptz;v_end timestamptz;v_day date;
 v_opening_count bigint;v_unposted_opening_count bigint;
 v_opening_date date;
 v_invoice_total bigint;v_invoice_unposted bigint;v_invoice_missing_cycle bigint;
 v_service_recognition_required bigint:=0;v_service_recognition_missing bigint:=0;
 v_payments_total bigint;v_payments_unposted bigint;
 v_payment_ledger_mismatches bigint;v_payment_missing_ledger bigint;
 v_expense_total bigint;v_expense_unposted bigint;
 v_payroll_total bigint;v_payroll_unposted bigint;v_payroll_drafts bigint;
 v_stock_total bigint;v_stock_unposted bigint;
 v_supplier_total bigint;v_supplier_unposted bigint;
 v_cash_moves bigint;v_cash_unclassified bigint;v_cash_perf_fixture bigint;
 v_gl_total bigint;v_gl_broken bigint;v_gl_balance numeric;
 v_missing bigint;v_source_integrity jsonb;
 v_accrual_posted bigint;v_accrual_unposted bigint;v_accrual_drafts bigint;
 v_prior_accrual_posted bigint;v_prior_accrual_unposted bigint;v_prior_accrual_drafts bigint;
 v_prior_operational jsonb; v_evidence_review jsonb;
BEGIN
 IF p_tenant_id IS NULL OR p_tenant_id<=0 OR
   p_site_id IS NULL OR p_site_id<=0 OR
   p_period IS NULL OR p_period !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' OR
   NOT EXISTS(SELECT 1 FROM public.sites s WHERE s.id=p_site_id
     AND s.tenant_id=p_tenant_id AND s.status<>'archived')
 THEN RAISE EXCEPTION 'GL_COVERAGE_INVALID_SCOPE' USING ERRCODE='22023'; END IF;
 v_day:=(p_period||'-01')::date;
 v_start:=v_day::timestamp AT TIME ZONE 'Asia/Gaza';
 v_end:=(v_day+INTERVAL '1 month')::timestamp AT TIME ZONE 'Asia/Gaza';
 SELECT count(*) FILTER(WHERE status='posted' AND as_of_date<=v_day),
        count(*) FILTER(WHERE status='draft'),
        min(as_of_date) FILTER(WHERE status='posted' AND as_of_date<=v_day)
 INTO v_opening_count,v_unposted_opening_count,v_opening_date
 FROM public.financial_gl_opening_batches
 WHERE tenant_id=p_tenant_id AND site_id=p_site_id;
 -- A6: signed adjustments that are approved in the source subledger
 -- but not yet projected to GL must also block an apparently clean trial.
 -- Draft adjustment evidence remains visible instead of disappearing.
 SELECT count(*) FILTER(WHERE j.status='posted'),
        count(*) FILTER(WHERE j.status='posted' AND NOT EXISTS(
          SELECT 1 FROM public.financial_gl_entries e
          WHERE e.tenant_id=j.tenant_id AND e.site_id=j.site_id
            AND e.source_type='accrual_adjustment'
            AND e.source_id=j.id::text AND e.source_revision=1)),
        count(*) FILTER(WHERE j.status='draft')
 INTO v_accrual_posted,v_accrual_unposted,v_accrual_drafts
 FROM public.financial_accrual_journals j
 WHERE j.tenant_id=p_tenant_id AND j.site_id=p_site_id AND j.period=p_period;
 -- A7: fiscal continuity: earlier approved journals without GL are
 -- a missing source even when the current month has zero source gaps.
 -- Compare all earlier periods up to (not including) the queried period.
 -- Do not mark historical source gaps as clean, and do not truncate counts.
 SELECT count(*) FILTER(WHERE j.status='posted'),
        count(*) FILTER(WHERE j.status='posted' AND NOT EXISTS(
          SELECT 1 FROM public.financial_gl_entries e
          WHERE e.tenant_id=j.tenant_id AND e.site_id=j.site_id
            AND e.source_type='accrual_adjustment'
            AND e.source_id=j.id::text AND e.source_revision=1)),
        count(*) FILTER(WHERE j.status='draft')
 INTO v_prior_accrual_posted,v_prior_accrual_unposted,v_prior_accrual_drafts
 FROM public.financial_accrual_journals j
 WHERE j.tenant_id=p_tenant_id AND j.site_id=p_site_id
   AND j.period<p_period;
 SELECT count(*),
        count(*) FILTER (WHERE (i.cycle_start_at IS NULL OR i.cycle_end_at IS NULL
          OR i.cycle_start_at>i.cycle_end_at)),
        count(*) FILTER(WHERE NOT EXISTS(
          SELECT 1 FROM public.financial_gl_entries g
          WHERE g.tenant_id=i.tenant_id AND g.site_id=i.site_id
            AND g.source_type='invoice'
            AND (g.source_id=i.id::text OR g.source_id=i.id::text||':'||p_period)))
 INTO v_invoice_total,v_invoice_missing_cycle,v_invoice_unposted
 FROM public.invoices i
 WHERE i.tenant_id=p_tenant_id AND i.site_id=p_site_id
  AND i.status IN ('issued','overdue','partially_paid','paid')
  AND i.cycle_start_at<v_end AND i.cycle_end_at>=v_start;
 -- Missing-cycle invoices issued in this period are counted separately,
 -- because they cannot be allocated by service month.
 SELECT v_invoice_missing_cycle+count(*) INTO v_invoice_missing_cycle
 FROM public.invoices i WHERE i.tenant_id=p_tenant_id AND i.site_id=p_site_id
 AND i.status IN ('issued','overdue','partially_paid','paid')
 AND (i.cycle_start_at IS NULL OR i.cycle_end_at IS NULL)
 AND i.issue_date>=v_start AND i.issue_date<v_end;
 -- For fully completed months, a posted invoice alone does not prove
 -- earned-service recognition. Evaluate the same Gaza calendar-day, integer-
 -- minor-unit formula as the dedicated recognition RPC. No future-month
 -- revenue recognition is required, and a zero-cent allocation needs no GL.
 IF (v_day+INTERVAL '1 month - 1 day')::date
    < (now() AT TIME ZONE 'Asia/Gaza')::date THEN
   WITH scoped AS (
     SELECT i.id, i.total_amount, i.tax_amount,
       (i.cycle_start_at AT TIME ZONE 'Asia/Gaza')::date first_day,
       (i.cycle_end_at AT TIME ZONE 'Asia/Gaza')::date last_day
     FROM public.invoices i
     WHERE i.tenant_id=p_tenant_id AND i.site_id=p_site_id
       AND i.status IN ('issued','overdue','partially_paid','paid')
       AND i.cycle_start_at IS NOT NULL AND i.cycle_end_at IS NOT NULL
       AND i.cycle_end_at>=v_start AND i.cycle_start_at<v_end
       AND i.total_amount IS NOT NULL AND i.tax_amount IS NOT NULL
       AND i.total_amount>=i.tax_amount AND i.tax_amount>=0
       AND i.total_amount=round(i.total_amount,2)
       AND i.tax_amount=round(i.tax_amount,2)
   ), calendar AS (
     SELECT id, first_day,last_day,
       ((total_amount-tax_amount)*100)::bigint net_minor,
       (last_day-first_day+1)::bigint service_days
     FROM scoped
     WHERE last_day>=v_day AND first_day<(v_day+INTERVAL '1 month')::date
       AND last_day>=first_day AND last_day-first_day+1 BETWEEN 1 AND 3660
   ), portions AS (
     SELECT id,
       (net_minor*((least(last_day,(v_day+INTERVAL '1 month - 1 day')::date)
         -first_day+1)::bigint)/service_days)
       -(net_minor*((greatest(first_day,v_day)-first_day)::bigint)/service_days)
       AS expected_minor
     FROM calendar
   )
   SELECT count(*),count(*) FILTER(WHERE NOT EXISTS(
      SELECT 1 FROM public.financial_gl_entries gl
      WHERE gl.tenant_id=p_tenant_id AND gl.site_id=p_site_id
       AND gl.source_type='service_recognition'
       AND gl.source_revision=1
       AND gl.source_id=portions.id::text||':'||p_period))
   INTO v_service_recognition_required,v_service_recognition_missing
   FROM portions WHERE expected_minor>0;
 END IF;
 SELECT count(*),count(*) FILTER(WHERE NOT EXISTS(
   SELECT 1 FROM public.financial_gl_entries g
   WHERE g.tenant_id=p.tenant_id AND g.site_id=p.site_id
   AND g.source_type='payment' AND g.source_id=p.id::text))
 INTO v_payments_total,v_payments_unposted
 FROM public.payments p
 WHERE p.tenant_id=p_tenant_id AND p.site_id=p_site_id
 AND p.status='completed' AND p.paid_at>=v_start AND p.paid_at<v_end;
 -- Audit the ACTUAL payment-to-company-account movement, without
 -- counting the same collection again as a second revenue event.
 -- One completed payment must have exactly one collection movement with
 -- matching tenant, site and amount. A link to another tenant is invalid.
 SELECT count(*) FILTER(WHERE linked.movement_count=0),
        count(*) FILTER(WHERE linked.movement_count<>1 OR
          linked.correct_count<>1 OR linked.movement_amount<>p.amount OR
          coalesce(p.invoice_applied_amount,0)+
            coalesce(p.subscriber_credit_amount,0)<>p.amount OR
          p.invoice_applied_amount<0 OR p.subscriber_credit_amount<0
        )
 INTO v_payment_missing_ledger,v_payment_ledger_mismatches
 FROM public.payments p
 CROSS JOIN LATERAL (
   SELECT count(*) AS movement_count,
      count(*) FILTER(WHERE a.tenant_id=p.tenant_id AND
        a.site_id=p.site_id AND a.transaction_type='collection') AS correct_count,
      coalesce(sum(a.amount),0) AS movement_amount
   FROM public.account_transactions a
   WHERE a.related_payment_id=p.id AND a.tenant_id=p.tenant_id
 ) linked
 WHERE p.tenant_id=p_tenant_id AND p.site_id=p_site_id
   AND p.status='completed' AND p.paid_at>=v_start AND p.paid_at<v_end;
 SELECT count(*),count(*) FILTER(WHERE NOT EXISTS(
   SELECT 1 FROM public.financial_gl_entries g
   WHERE g.tenant_id=x.tenant_id AND g.site_id=x.site_id
   AND g.source_type='expense' AND g.source_id=x.id::text))
 INTO v_expense_total,v_expense_unposted FROM public.expenses x
 WHERE x.tenant_id=p_tenant_id AND x.site_id=p_site_id
 AND x.occurred_at>=v_start AND x.occurred_at<v_end
 AND x.category<>'payroll';
 SELECT count(*) FILTER(WHERE status IN ('approved','paid')),
        count(*) FILTER(WHERE status IN ('approved','paid') AND
          (NOT EXISTS(
            SELECT 1 FROM public.financial_gl_entries g
            WHERE g.tenant_id=p.tenant_id AND g.site_id=p.site_id
              AND g.source_type='payroll' AND g.source_id=p.id::text)
           OR (p.status='paid' AND NOT EXISTS(
             SELECT 1 FROM public.financial_gl_entries g
             WHERE g.tenant_id=p.tenant_id AND g.site_id=p.site_id
               AND g.source_type='payroll_payment' AND g.source_id=p.id::text)))),
        count(*) FILTER(WHERE status='draft')
 INTO v_payroll_total,v_payroll_unposted,v_payroll_drafts
 FROM public.payroll_runs p WHERE p.tenant_id=p_tenant_id
 AND p.site_id=p_site_id AND p.period=p_period;
 -- Receipt and supplier return have one authoritative supplier-ledger event
 -- (purchase or return). Their individual stock rows are not GL postings.
 -- All receipt rows must add up exactly to their supplier event before coverage
 -- can be marked complete; this avoids counting purchases twice.
 SELECT count(*),count(*) FILTER(WHERE NOT (
   EXISTS(SELECT 1 FROM public.financial_gl_entries g
     WHERE g.tenant_id=m.tenant_id AND g.site_id=m.site_id
       AND g.source_type='stock_movement' AND g.source_id=m.id::text)
   OR
   (m.movement_type='purchase_receipt' AND EXISTS(
      SELECT 1 FROM public.supplier_ledger_entries sl
      JOIN public.financial_gl_entries gl
        ON gl.tenant_id=sl.tenant_id AND gl.site_id=sl.site_id
       AND gl.source_type='supplier_ledger' AND gl.source_id=sl.id::text
      WHERE sl.tenant_id=m.tenant_id AND sl.site_id=m.site_id
        AND sl.purchase_id=m.purchase_id AND sl.entry_type='purchase'
        AND sl.credit_amount>0
        AND sl.credit_amount=(
          SELECT coalesce(sum(sm.total_cost_amount),0)
          FROM public.inventory_stock_movements sm
          WHERE sm.tenant_id=m.tenant_id AND sm.site_id=m.site_id
            AND sm.purchase_id=m.purchase_id AND sm.movement_type='purchase_receipt')))
   OR
   (m.movement_type='supplier_return' AND EXISTS(
      SELECT 1 FROM public.supplier_ledger_entries sl
      JOIN public.financial_gl_entries gl
        ON gl.tenant_id=sl.tenant_id AND gl.site_id=sl.site_id
       AND gl.source_type='supplier_ledger' AND gl.source_id=sl.id::text
      WHERE sl.tenant_id=m.tenant_id AND sl.site_id=m.site_id
        AND sl.purchase_id=m.purchase_id AND sl.entry_type='supplier_return'
        AND sl.reference_no=m.reference_no
        AND sl.debit_amount>0 AND sl.debit_amount=(
          SELECT coalesce(sum(sm.total_cost_amount),0)
          FROM public.inventory_stock_movements sm
          WHERE sm.tenant_id=m.tenant_id AND sm.site_id=m.site_id
            AND sm.purchase_id=m.purchase_id
            AND sm.reference_no=m.reference_no
            AND sm.movement_type='supplier_return')))
   OR
   (m.movement_type='issue' AND m.operation_key LIKE 'trf:%:out'
     AND (SELECT count(*) FROM public.inventory_stock_movements paired
       WHERE paired.tenant_id=m.tenant_id AND paired.site_id=m.site_id
         AND paired.movement_type='adjustment_in'
         AND paired.operation_key=left(m.operation_key,length(m.operation_key)-4)||':in'
         AND paired.reference_no=m.reference_no
         AND paired.item_id=m.item_id AND paired.quantity=m.quantity
         AND paired.unit_cost=m.unit_cost
         AND paired.total_cost_amount=m.total_cost_amount
         AND paired.warehouse_id<>m.warehouse_id)=1)
   OR
   (m.movement_type='adjustment_in' AND m.operation_key LIKE 'trf:%:in'
     AND (SELECT count(*) FROM public.inventory_stock_movements paired
       WHERE paired.tenant_id=m.tenant_id AND paired.site_id=m.site_id
         AND paired.movement_type='issue'
         AND paired.operation_key=left(m.operation_key,length(m.operation_key)-3)||':out'
         AND paired.reference_no=m.reference_no
         AND paired.item_id=m.item_id AND paired.quantity=m.quantity
         AND paired.unit_cost=m.unit_cost
         AND paired.total_cost_amount=m.total_cost_amount
         AND paired.warehouse_id<>m.warehouse_id)=1)
 ))
 INTO v_stock_total,v_stock_unposted
 FROM public.inventory_stock_movements m
 WHERE m.tenant_id=p_tenant_id AND m.site_id=p_site_id
 AND m.occurred_at>=v_start AND m.occurred_at<v_end;
 SELECT count(*),count(*) FILTER(WHERE NOT EXISTS(
   SELECT 1 FROM public.financial_gl_entries g
   WHERE g.tenant_id=s.tenant_id AND g.site_id=s.site_id
   AND g.source_type='supplier_ledger' AND g.source_id=s.id::text))
 INTO v_supplier_total,v_supplier_unposted
 FROM public.supplier_ledger_entries s
 WHERE s.tenant_id=p_tenant_id AND s.site_id=p_site_id
 AND s.occurred_at>=v_start AND s.occurred_at<v_end;
 -- Report all movements, not only the first 5,000; linked movements may
 -- share one business-event GL posting, so don't sum them as new revenue.
 SELECT count(*),count(*) FILTER(WHERE
     a.related_payment_id IS NULL AND a.related_expense_id IS NULL
     AND a.related_supplier_payment_id IS NULL AND a.related_supplier_return_id IS NULL
     AND a.related_account_id IS NULL),
     count(*) FILTER(WHERE a.reference_no LIKE 'STG-PERF-%'
        OR a.reference_no LIKE 'PH-PERF-%')
 INTO v_cash_moves,v_cash_unclassified,v_cash_perf_fixture
 FROM public.account_transactions a
 WHERE a.tenant_id=p_tenant_id AND a.site_id=p_site_id
 AND a.occurred_at>=v_start AND a.occurred_at<v_end;
 SELECT count(*),count(*) FILTER (WHERE z.cnt<2 OR z.net<>0),
        COALESCE(sum(z.net),0)
 INTO v_gl_total,v_gl_broken,v_gl_balance
 FROM (
   SELECT e.id,count(l.id) cnt,
       coalesce(sum(CASE WHEN l.side='debit' THEN l.amount ELSE -l.amount END),0) net
   FROM public.financial_gl_entries e LEFT JOIN public.financial_gl_lines l
     ON l.entry_id=e.id AND l.tenant_id=e.tenant_id AND l.site_id=e.site_id
   WHERE e.tenant_id=p_tenant_id AND e.site_id=p_site_id AND e.period=p_period
   GROUP BY e.id
 ) z;
 v_source_integrity:=public.powerhub_financial_gl_source_integrity(
   p_tenant_id,p_site_id,p_period);
 v_prior_operational:=public.powerhub_financial_gl_prior_operational_gaps(
   p_tenant_id,p_site_id,p_period);
 v_evidence_review:=public.powerhub_financial_gl_opening_evidence_status(p_tenant_id,p_site_id,p_period);
 v_missing:=v_invoice_unposted+v_invoice_missing_cycle+v_payments_unposted+
   v_expense_unposted+v_payroll_unposted+v_payroll_drafts+
   v_stock_unposted+v_supplier_unposted+v_cash_unclassified+v_gl_broken+
   v_payment_ledger_mismatches+v_service_recognition_missing+
   v_accrual_unposted+v_accrual_drafts+
   v_prior_accrual_unposted+v_prior_accrual_drafts+
   (v_prior_operational->>'unreconciledCount')::bigint+
   (v_source_integrity->>'driftedEntries')::bigint+
   (v_source_integrity->>'invalidSources')::bigint+
   (v_source_integrity->>'unauditedEntries')::bigint;
 RETURN jsonb_build_object(
  'tenantId',p_tenant_id,'siteId',p_site_id,'period',p_period,
  'opening',jsonb_build_object('postedCount',v_opening_count,
     'draftCount',v_unposted_opening_count,'asOfDate',v_opening_date),
  'sources',jsonb_build_object(
    'priorOperationalSources',v_prior_operational,
    'accrualAdjustments',jsonb_build_object('approved',v_accrual_posted,
      'drafts',v_accrual_drafts,'missingGL',v_accrual_unposted),
    'priorAccrualAdjustments',jsonb_build_object(
      'approved',v_prior_accrual_posted,'drafts',v_prior_accrual_drafts,
      'missingGL',v_prior_accrual_unposted),
    'invoices',jsonb_build_object('inScope',v_invoice_total,
      'missingGL',v_invoice_unposted,'missingCycle',v_invoice_missing_cycle),
    'serviceRecognition',jsonb_build_object(
      'monthCompleted',(v_day+INTERVAL '1 month - 1 day')::date
        < (now() AT TIME ZONE 'Asia/Gaza')::date,
      'requiredInvoiceMonths',v_service_recognition_required,
      'missingGL',v_service_recognition_missing),
    'payments',jsonb_build_object('inScope',v_payments_total,
      'missingGL',v_payments_unposted,
      'withoutLinkedCollection',v_payment_missing_ledger,
      'linkedCollectionMismatch',v_payment_ledger_mismatches),
    'expenses',jsonb_build_object('inScope',v_expense_total,'missingGL',v_expense_unposted),
    'payroll',jsonb_build_object('approvedOrPaid',v_payroll_total,
      'missingGL',v_payroll_unposted,'drafts',v_payroll_drafts),
    'stockMovements',jsonb_build_object('inScope',v_stock_total,'missingGL',v_stock_unposted),
    'supplierLedger',jsonb_build_object('inScope',v_supplier_total,'missingGL',v_supplier_unposted),
    'companyAccountMovements',jsonb_build_object('inScope',v_cash_moves,
      'unclassified',v_cash_unclassified,
      'performanceFixtureTagged',v_cash_perf_fixture)),
  'sourceIntegrity',v_source_integrity,
  'gl',jsonb_build_object('entries',v_gl_total,'unbalancedEntries',v_gl_broken,
    'signedBalance',v_gl_balance),
  'unreconciledSourceCount',v_missing,
  'isOpeningStructurallyPosted',v_opening_count=1 AND v_unposted_opening_count=0,
  'openingEvidenceAudit',jsonb_build_object(
    'status',CASE
      WHEN v_opening_count=0 THEN 'MISSING_POSTED_OPENING'
      WHEN v_opening_count<>1 OR v_unposted_opening_count<>0
        THEN 'STRUCTURAL_OPENING_NOT_RESOLVED'
      ELSE 'INDEPENDENT_SUBLEDGER_RECONCILIATION_REQUIRED'
    END,
    'sourceSubledgersIndependentlyVerified',false,
    'accountBalancesMatchedToOpening',
       coalesce((v_evidence_review->>'accountBalancesMatchedToOpening')::boolean,false),
    'evidenceReview',v_evidence_review,
    'structuralPostingPresent',v_opening_count=1 AND v_unposted_opening_count=0),
  'isOpeningReconciled',false,
  'isGLStructurallyBalanced',v_gl_broken=0 AND v_gl_balance=0,
  'isSourceCoverageComplete',v_missing=0 AND (v_source_integrity->>'isClean')::boolean
    AND v_opening_count=1
    AND v_unposted_opening_count=0,
  'isCompleteAccrualStatement',false,'isFinalProfit',false,
  'accountingCertification','NOT_CERTIFIED',
  'limitation','Operational movement classification, source fingerprints and opening subledger reconciliation must all pass before final certification');
END;
$coverage$;
REVOKE ALL ON FUNCTION public.powerhub_financial_gl_source_coverage(bigint,bigint,text)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_gl_source_coverage(bigint,bigint,text)
 TO service_role;
NOTIFY pgrst,'reload schema';
