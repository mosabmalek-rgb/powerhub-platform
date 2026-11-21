-- Monthly review and sign-off; the source statement remains explicitly provisional
-- because this is an accrual adjustment subledger, not a complete double-entry GL.
CREATE TABLE IF NOT EXISTS public.financial_accrual_period_reviews(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 tenant_id bigint NOT NULL REFERENCES public.tenants(id),
 site_id bigint NOT NULL REFERENCES public.sites(id),
 period text NOT NULL CHECK(period~'^[0-9]{4}-(0[1-9]|1[0-2])$'),
 evidence jsonb NOT NULL,
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','locked')),
 prepared_by_user_id bigint NOT NULL REFERENCES public.users(id),
 locked_by_user_id bigint REFERENCES public.users(id),
 prepared_at timestamptz NOT NULL DEFAULT now(),
 locked_at timestamptz,
 locked_snapshot jsonb,
 source_fingerprint text,
 CONSTRAINT financial_accrual_period_review_unique UNIQUE(tenant_id,site_id,period),
 CONSTRAINT financial_accrual_period_review_locked_ck CHECK(
  (status='draft' AND locked_by_user_id IS NULL AND locked_at IS NULL
      AND locked_snapshot IS NULL AND source_fingerprint IS NULL) OR
  (status='locked' AND locked_by_user_id IS NOT NULL AND locked_at IS NOT NULL
      AND locked_snapshot IS NOT NULL AND source_fingerprint IS NOT NULL)
 )
);
ALTER TABLE public.financial_accrual_period_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.financial_accrual_period_reviews FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.financial_accrual_period_reviews TO service_role;
GRANT USAGE,SELECT ON SEQUENCE public.financial_accrual_period_reviews_id_seq TO service_role;

CREATE OR REPLACE FUNCTION public.powerhub_financial_accrual_review_evidence_valid(p_evidence jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp
AS $validate$
 SELECT p_evidence IS NOT NULL AND jsonb_typeof(p_evidence)='object'
   AND (
    SELECT COUNT(*)=8 FROM jsonb_object_keys(p_evidence) AS keys(key)
     WHERE key IN (
       'unbilled_service','invoice_cutoff','supplier_reconciliation','inventory_reconciliation',
       'payroll_reconciliation','depreciation_register','provision_assessment','tax_reconciliation'
     )
   ) AND (
    SELECT COUNT(*)=8 FROM jsonb_each_text(p_evidence) AS e(key,val)
      WHERE key IN (
       'unbilled_service','invoice_cutoff','supplier_reconciliation','inventory_reconciliation',
       'payroll_reconciliation','depreciation_register','provision_assessment','tax_reconciliation'
      ) AND length(trim(val)) BETWEEN 8 AND 1000
   );
$validate$;

CREATE OR REPLACE FUNCTION public.powerhub_financial_accrual_period_save_review(
 p_tenant_id bigint,p_site_id bigint,p_period text,p_user_id bigint,p_evidence jsonb
) RETURNS bigint LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $save$
DECLARE v_id bigint;
BEGIN
 IF p_tenant_id IS NULL OR p_site_id IS NULL OR p_user_id IS NULL OR
    p_period IS NULL OR p_period !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' OR
    NOT public.powerhub_financial_accrual_review_evidence_valid(p_evidence) OR
    NOT EXISTS(SELECT 1 FROM public.sites s WHERE s.tenant_id=p_tenant_id AND s.id=p_site_id AND s.status<>'archived')
 THEN RAISE EXCEPTION 'INVALID_FINANCIAL_REVIEW_EVIDENCE' USING ERRCODE='22023'; END IF;
 INSERT INTO public.financial_accrual_period_reviews(tenant_id,site_id,period,evidence,prepared_by_user_id)
 VALUES(p_tenant_id,p_site_id,p_period,p_evidence,p_user_id)
 ON CONFLICT(tenant_id,site_id,period) DO UPDATE
  SET evidence=EXCLUDED.evidence,prepared_by_user_id=EXCLUDED.prepared_by_user_id,
      prepared_at=now()
  WHERE public.financial_accrual_period_reviews.status='draft'
 RETURNING id INTO v_id;
 IF v_id IS NULL THEN RAISE EXCEPTION 'FINANCIAL_PERIOD_LOCKED' USING ERRCODE='22023'; END IF;
 RETURN v_id;
END;
$save$;

CREATE OR REPLACE FUNCTION public.powerhub_financial_accrual_period_lock(
 p_tenant_id bigint,p_site_id bigint,p_period text,p_user_id bigint
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $lock$
DECLARE
 v_review public.financial_accrual_period_reviews%ROWTYPE;
 v_snapshot jsonb;
 v_fingerprint text;
 v_month_end date;
BEGIN
 SELECT * INTO v_review FROM public.financial_accrual_period_reviews
 WHERE tenant_id=p_tenant_id AND site_id=p_site_id AND period=p_period FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'MISSING_PERIOD_REVIEW' USING ERRCODE='22023'; END IF;
 IF v_review.status='locked' THEN
   IF v_review.locked_by_user_id=p_user_id THEN
    RETURN jsonb_build_object('status','locked','alreadyLocked',true,'id',v_review.id);
   END IF;
   RAISE EXCEPTION 'PERIOD_ALREADY_LOCKED' USING ERRCODE='22023';
 END IF;
 IF p_user_id IS NULL OR v_review.prepared_by_user_id=p_user_id THEN
  RAISE EXCEPTION 'ACCRUAL_SEPARATION_OF_DUTIES' USING ERRCODE='22023'; END IF;
 v_month_end:=((p_period||'-01')::date+INTERVAL '1 month - 1 day')::date;
 IF (now() AT TIME ZONE 'Asia/Gaza')::date <= v_month_end THEN
  RAISE EXCEPTION 'ACCRUAL_PERIOD_NOT_FINISHED' USING ERRCODE='22023'; END IF;
 v_snapshot:=public.powerhub_financial_accrual_month_statement(
  p_tenant_id,p_site_id,p_period,now()
 );
 IF (v_snapshot->>'missingCycleCount')::bigint<>0 OR
    (v_snapshot->>'uncompletedInvoiceCount')::bigint<>0 OR
    (v_snapshot->>'unclassifiedInventoryIssueCount')::bigint<>0 OR
    (v_snapshot->>'draftPayrollCount')::bigint<>0 OR
    (v_snapshot->'journalAdjustments'->>'draftCount')::bigint<>0 THEN
  RAISE EXCEPTION 'ACCRUAL_SOURCES_NOT_RECONCILED' USING ERRCODE='22023';
 END IF;
 v_fingerprint:=md5((v_snapshot-'asOf')::text);
 UPDATE public.financial_accrual_period_reviews
 SET status='locked',locked_by_user_id=p_user_id,locked_at=now(),
     locked_snapshot=v_snapshot,source_fingerprint=v_fingerprint
 WHERE id=v_review.id;
 RETURN jsonb_build_object('status','locked','alreadyLocked',false,'id',v_review.id,
   'sourceFingerprint',v_fingerprint,
   'isCertifiedProfit',false);
END;
$lock$;

CREATE OR REPLACE FUNCTION public.powerhub_financial_accrual_period_review_status(
 p_tenant_id bigint,p_site_id bigint,p_period text
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $status$
DECLARE
 v_review public.financial_accrual_period_reviews%ROWTYPE;
 v_current jsonb; v_changed boolean;
BEGIN
 SELECT * INTO v_review FROM public.financial_accrual_period_reviews
 WHERE tenant_id=p_tenant_id AND site_id=p_site_id AND period=p_period;
 IF NOT FOUND THEN
  RETURN jsonb_build_object('status','unprepared','isCertifiedProfit',false);
 END IF;
 IF v_review.status='draft' THEN
  RETURN jsonb_build_object('status','draft','evidence',v_review.evidence,
    'preparedByUserId',v_review.prepared_by_user_id,'isCertifiedProfit',false);
 END IF;
 v_current:=public.powerhub_financial_accrual_month_statement(
  p_tenant_id,p_site_id,p_period,now()
 );
 v_changed:=md5((v_current-'asOf')::text)<>v_review.source_fingerprint;
 RETURN jsonb_build_object('status','locked','driftDetected',v_changed,
   'lockedByUserId',v_review.locked_by_user_id,'lockedAt',v_review.locked_at,
   'sourceFingerprint',v_review.source_fingerprint,
   'isCertifiedProfit',false,'lockedSnapshot',v_review.locked_snapshot);
END;
$status$;

CREATE OR REPLACE FUNCTION public.powerhub_financial_accrual_no_locked_journal_change()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $guard$
DECLARE v_closed boolean;
BEGIN
 SELECT EXISTS(SELECT 1 FROM public.financial_accrual_period_reviews r
  WHERE r.tenant_id=NEW.tenant_id AND r.site_id=NEW.site_id
    AND r.period=NEW.period AND r.status='locked') INTO v_closed;
 IF v_closed THEN RAISE EXCEPTION 'ACCRUAL_PERIOD_LOCKED' USING ERRCODE='22023'; END IF;
 RETURN NEW;
END;
$guard$;
DROP TRIGGER IF EXISTS financial_accrual_block_locked_journal_changes ON public.financial_accrual_journals;
CREATE TRIGGER financial_accrual_block_locked_journal_changes
BEFORE INSERT OR UPDATE ON public.financial_accrual_journals
FOR EACH ROW EXECUTE FUNCTION public.powerhub_financial_accrual_no_locked_journal_change();

REVOKE ALL ON FUNCTION public.powerhub_financial_accrual_review_evidence_valid(jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.powerhub_financial_accrual_period_save_review(bigint,bigint,text,bigint,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.powerhub_financial_accrual_period_lock(bigint,bigint,text,bigint) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.powerhub_financial_accrual_period_review_status(bigint,bigint,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_accrual_review_evidence_valid(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_accrual_period_save_review(bigint,bigint,text,bigint,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_accrual_period_lock(bigint,bigint,text,bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_accrual_period_review_status(bigint,bigint,text) TO service_role;
COMMENT ON TABLE public.financial_accrual_period_reviews
IS 'Review evidence and immutable period snapshots. Locking is not certification of full double-entry financial statements.';
NOTIFY pgrst,'reload schema';
