-- B4.16: independently reviewed supplier-payment correction, atomic source/cash/GL reversal.
-- Requires B4.15 and pre-existing source backed GL. No historical auto-correction.
CREATE TABLE IF NOT EXISTS public.financial_supplier_payment_corrections (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 tenant_id bigint NOT NULL,
 site_id bigint NOT NULL,
 payment_id bigint NOT NULL,
 operation_key text NOT NULL CHECK(length(btrim(operation_key)) BETWEEN 8 AND 160),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 10 AND 500),
 requested_by_user_id bigint NOT NULL REFERENCES public.users(id),
 requested_at timestamptz NOT NULL DEFAULT now(),
 original_supplier_ledger_id bigint NOT NULL,
 original_gl_entry_id bigint NOT NULL,
 original_gl_fingerprint text NOT NULL CHECK(original_gl_fingerprint ~ '^[0-9a-f]{64}$'),
 amount numeric(14,2) NOT NULL CHECK(amount>0),
 status text NOT NULL DEFAULT 'pending_review'
   CHECK(status IN ('pending_review','posting','posted')),
 approved_by_user_id bigint REFERENCES public.users(id),
 approved_at timestamptz,
 refund_transaction_id bigint,
 reversal_supplier_ledger_entry_id bigint,
 reversal_gl_entry_id bigint,
 CONSTRAINT supplier_correction_payment_scope_fk
   FOREIGN KEY (tenant_id,payment_id) REFERENCES public.supplier_payments(tenant_id,id),
 CONSTRAINT supplier_correction_gl_scope_fk
   FOREIGN KEY (original_gl_entry_id,tenant_id,site_id)
   REFERENCES public.financial_gl_entries(id,tenant_id,site_id),
 CONSTRAINT supplier_correction_independent_actor CHECK (
   approved_by_user_id IS NULL OR requested_by_user_id<>approved_by_user_id),
 CONSTRAINT supplier_correction_posted_evidence CHECK (
   (status='pending_review' AND approved_by_user_id IS NULL AND approved_at IS NULL
    AND refund_transaction_id IS NULL AND reversal_supplier_ledger_entry_id IS NULL
    AND reversal_gl_entry_id IS NULL)
   OR
   (status='posting' AND approved_by_user_id IS NOT NULL AND approved_at IS NOT NULL
    AND refund_transaction_id IS NOT NULL AND reversal_supplier_ledger_entry_id IS NOT NULL
    AND reversal_gl_entry_id IS NULL)
   OR
   (status='posted' AND approved_by_user_id IS NOT NULL AND approved_at IS NOT NULL
    AND refund_transaction_id IS NOT NULL AND reversal_supplier_ledger_entry_id IS NOT NULL
    AND reversal_gl_entry_id IS NOT NULL)),
 UNIQUE(tenant_id,site_id,payment_id),
 UNIQUE(tenant_id,site_id,operation_key),
 UNIQUE(reversal_gl_entry_id)
);
CREATE INDEX IF NOT EXISTS supplier_corrections_original_gl_idx
 ON public.financial_supplier_payment_corrections(tenant_id,site_id,original_gl_entry_id);
ALTER TABLE public.financial_supplier_payment_corrections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.financial_supplier_payment_corrections FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON TABLE public.financial_supplier_payment_corrections TO service_role;
GRANT USAGE,SELECT ON SEQUENCE public.financial_supplier_payment_corrections_id_seq TO service_role;

CREATE OR REPLACE FUNCTION public.powerhub_financial_supplier_payment_correction_proof(
 p_tenant_id bigint,p_site_id bigint,p_payment_id bigint
) RETURNS text LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $proof$
DECLARE
 c public.financial_supplier_payment_corrections%ROWTYPE;
 p public.supplier_payments%ROWTYPE;
 orig public.financial_gl_entries%ROWTYPE;
 rev public.financial_gl_entries%ROWTYPE;
 sl public.supplier_ledger_entries%ROWTYPE;
 refund public.account_transactions%ROWTYPE;
 v_plan jsonb;v_inv boolean;v_count integer;
BEGIN
 SELECT * INTO c FROM public.financial_supplier_payment_corrections x
 WHERE x.tenant_id=p_tenant_id AND x.site_id=p_site_id
 AND x.payment_id=p_payment_id AND x.status='posted';
 IF NOT FOUND THEN RETURN 'B416_CORRECTION_NOT_POSTED'; END IF;
 SELECT * INTO p FROM public.supplier_payments x
 WHERE x.tenant_id=p_tenant_id AND x.site_id=p_site_id AND x.id=p_payment_id;
 SELECT * INTO orig FROM public.financial_gl_entries x
 WHERE x.id=c.original_gl_entry_id AND x.tenant_id=p_tenant_id AND x.site_id=p_site_id;
 SELECT * INTO rev FROM public.financial_gl_entries x
 WHERE x.id=c.reversal_gl_entry_id AND x.tenant_id=p_tenant_id AND x.site_id=p_site_id;
 SELECT * INTO sl FROM public.supplier_ledger_entries x
 WHERE x.id=c.reversal_supplier_ledger_entry_id AND x.tenant_id=p_tenant_id
 AND x.site_id=p_site_id;
 SELECT * INTO refund FROM public.account_transactions x
 WHERE x.id=c.refund_transaction_id AND x.tenant_id=p_tenant_id
 AND x.site_id=p_site_id;
 IF p.id IS NULL OR orig.id IS NULL OR rev.id IS NULL OR sl.id IS NULL
   OR refund.id IS NULL OR p.status<>'reversed'
   OR p.reversed_by_user_id IS DISTINCT FROM c.approved_by_user_id
   OR p.reversal_reason IS DISTINCT FROM c.reason
   OR p.amount<>c.amount OR c.requested_by_user_id=c.approved_by_user_id
   OR c.approved_at IS NULL
   OR orig.source_type<>'supplier_ledger'
   OR orig.source_id IS DISTINCT FROM c.original_supplier_ledger_id::text
   OR orig.source_fingerprint IS DISTINCT FROM c.original_gl_fingerprint
   OR rev.source_type<>'supplier_ledger' OR rev.source_id IS DISTINCT FROM sl.id::text
   OR rev.reverses_entry_id IS DISTINCT FROM orig.id
   OR rev.posted_by_user_id IS DISTINCT FROM c.approved_by_user_id
   OR rev.accounting_policy_version<>'supplier-payment-source-correction-v1'
   OR sl.entry_type<>'reversal' OR sl.supplier_id<>p.supplier_id
   OR sl.supplier_payment_id<>p.id OR sl.credit_amount<>p.amount OR sl.debit_amount<>0
   OR sl.entry_key IS DISTINCT FROM 'supplier-payment-reversal:'||p.id
   OR refund.related_supplier_payment_id IS DISTINCT FROM p.id
   OR refund.account_id<>p.company_account_id
   OR refund.transaction_type<>'deposit' OR refund.amount<>p.amount
   OR refund.reference_no IS DISTINCT FROM 'REV-SUPPLIER-PAYMENT-'||p.id
 THEN RETURN 'B416_CORRECTION_SOURCE_MISMATCH'; END IF;
 SELECT count(*) INTO v_count FROM public.financial_gl_entries x
 WHERE x.tenant_id=p_tenant_id AND x.site_id=p_site_id
 AND x.reverses_entry_id=orig.id;
 IF v_count<>1 THEN RETURN 'B416_DUPLICATE_GL_REVERSAL';END IF;
 WITH original_group AS (
 SELECT l.account_code,l.side,l.amount,count(*) n FROM public.financial_gl_lines l
 WHERE l.entry_id=orig.id GROUP BY 1,2,3
 ),reverse_group AS(
 SELECT l.account_code,CASE l.side WHEN 'debit' THEN 'credit' ELSE 'debit' END side,
 l.amount,count(*) n FROM public.financial_gl_lines l
 WHERE l.entry_id=rev.id GROUP BY 1,2,3
 )
 SELECT EXISTS(
 (SELECT * FROM original_group EXCEPT SELECT * FROM reverse_group)
 UNION ALL
 (SELECT * FROM reverse_group EXCEPT SELECT * FROM original_group)
 ) INTO v_inv;
 IF v_inv THEN RETURN 'B416_GL_LINES_NOT_INVERSE';END IF;
 BEGIN
   v_plan:=public.powerhub_financial_gl_source_plan(p_tenant_id,p_site_id,'supplier_ledger',sl.id);
 EXCEPTION WHEN OTHERS THEN
   RETURN 'B416_REVERSAL_SOURCE_UNVERIFIABLE';
 END;
 IF rev.source_fingerprint IS DISTINCT FROM v_plan->>'sourceFingerprint'
    OR rev.period IS DISTINCT FROM v_plan->>'period'
    OR (v_plan->>'reversesEntryId')::bigint IS DISTINCT FROM orig.id
 THEN RETURN 'B416_REVERSAL_FINGERPRINT_MISMATCH';END IF;
 RETURN 'SOURCE_BACKED_REVERSAL_VALID';
END;
$proof$;

CREATE OR REPLACE FUNCTION public.powerhub_financial_supplier_payment_correction_request(
 p_tenant_id bigint,p_site_id bigint,p_payment_id bigint,p_user_id bigint,
 p_reason text,p_operation_key text
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $request$
DECLARE v jsonb;c public.financial_supplier_payment_corrections%ROWTYPE;
 v_reason text:=btrim(p_reason);v_key text:=btrim(p_operation_key);
BEGIN
 IF p_tenant_id<=0 OR p_site_id<=0 OR p_payment_id<=0 OR p_user_id<=0
 OR length(coalesce(v_reason,'')) NOT BETWEEN 10 AND 500
 OR length(coalesce(v_key,'')) NOT BETWEEN 8 AND 160
 THEN RAISE EXCEPTION 'B416_CORRECTION_REQUEST_INVALID' USING ERRCODE='22023';END IF;
 IF public.powerhub_financial_gl_authorized_actor(p_tenant_id,p_site_id,p_user_id)
   IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'B416_CORRECTION_MAKER_FORBIDDEN' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(
   'powerhub:supplier-correction:'||p_tenant_id||':'||p_site_id||':'||p_payment_id,0));
 v:=public.powerhub_financial_supplier_payment_correction_readiness(
   p_tenant_id,p_site_id,p_payment_id);
 IF v->>'status'<>'SOURCE_VERIFIED_WORKFLOW_NOT_IMPLEMENTED'
 OR (v->>'sourceEvidenceVerified')::boolean IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'B416_CORRECTION_SOURCE_NOT_READY' USING ERRCODE='22023';END IF;
 SELECT * INTO c FROM public.financial_supplier_payment_corrections
 WHERE tenant_id=p_tenant_id AND site_id=p_site_id AND payment_id=p_payment_id
 FOR UPDATE;
 IF FOUND THEN
   IF c.requested_by_user_id<>p_user_id OR c.operation_key<>v_key
    OR c.reason<>v_reason OR c.amount<>(v->>'paymentAmount')::numeric
    OR c.original_gl_fingerprint IS DISTINCT FROM v->>'originalGLFingerprint'
   THEN RAISE EXCEPTION 'B416_CORRECTION_REQUEST_CONFLICT' USING ERRCODE='23505';END IF;
   RETURN jsonb_build_object('correctionId',c.id,'status',c.status,
    'alreadyRequested',true,'alreadyPosted',c.status='posted',
    'accountingCertification','NOT_CERTIFIED');
 END IF;
 INSERT INTO public.financial_supplier_payment_corrections(
 tenant_id,site_id,payment_id,operation_key,reason,requested_by_user_id,
 original_supplier_ledger_id,original_gl_entry_id,original_gl_fingerprint,amount)
 VALUES(p_tenant_id,p_site_id,p_payment_id,v_key,v_reason,p_user_id,
  (v->>'supplierLedgerEntryId')::bigint,(v->>'originalGLEntryId')::bigint,
  v->>'originalGLFingerprint',(v->>'paymentAmount')::numeric)
 RETURNING * INTO c;
 RETURN jsonb_build_object('correctionId',c.id,'status','pending_review',
  'alreadyRequested',false,'alreadyPosted',false,
  'accountingCertification','NOT_CERTIFIED');
END;
$request$;

CREATE OR REPLACE FUNCTION public.powerhub_financial_supplier_payment_correction_approve_post(
 p_tenant_id bigint,p_site_id bigint,p_correction_id bigint,p_approver_id bigint
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $approve$
DECLARE c public.financial_supplier_payment_corrections%ROWTYPE;
 p public.supplier_payments%ROWTYPE;
 gl public.financial_gl_entries%ROWTYPE;
 ca public.company_accounts%ROWTYPE;
 v_info jsonb;v_post jsonb;v_refund bigint;v_sl bigint;v_current_period text;
 v_existing_count integer;v_reference text;v_platform_role text;
BEGIN
 IF p_tenant_id<=0 OR p_site_id<=0 OR p_correction_id<=0 OR p_approver_id<=0
 THEN RAISE EXCEPTION 'B416_CORRECTION_APPROVAL_INVALID' USING ERRCODE='22023';END IF;
 IF public.powerhub_financial_gl_authorized_actor(p_tenant_id,p_site_id,p_approver_id)
 IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'B416_CORRECTION_CHECKER_FORBIDDEN' USING ERRCODE='42501';END IF;
 -- Consistent advisory lock hierarchy with GL posting: period, site, then payment.
 SELECT * INTO c FROM public.financial_supplier_payment_corrections
 WHERE tenant_id=p_tenant_id AND site_id=p_site_id AND id=p_correction_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'B416_CORRECTION_OUT_OF_SCOPE' USING ERRCODE='22023';END IF;
 v_current_period:=to_char(clock_timestamp() AT TIME ZONE 'Asia/Gaza','YYYY-MM');
 PERFORM pg_advisory_xact_lock(hashtextextended(
   'powerhub:accrual-period:'||p_tenant_id||':'||p_site_id||':'||v_current_period,0));
 PERFORM pg_advisory_xact_lock(hashtextextended(
   'powerhub:gl-site:'||p_tenant_id||':'||p_site_id,0));
 PERFORM pg_advisory_xact_lock(hashtextextended(
   'powerhub:supplier-correction:'||p_tenant_id||':'||p_site_id||':'||c.payment_id,0));
 SELECT * INTO c FROM public.financial_supplier_payment_corrections
 WHERE tenant_id=p_tenant_id AND site_id=p_site_id AND id=p_correction_id FOR UPDATE;
 IF c.requested_by_user_id=p_approver_id
 THEN RAISE EXCEPTION 'B416_MAKER_CANNOT_APPROVE_OWN_CORRECTION' USING ERRCODE='22023';END IF;
 IF c.status='posted' THEN
   IF c.approved_by_user_id<>p_approver_id
    OR public.powerhub_financial_supplier_payment_correction_proof(
      p_tenant_id,p_site_id,c.payment_id)<>'SOURCE_BACKED_REVERSAL_VALID'
   THEN RAISE EXCEPTION 'B416_CORRECTION_POST_REPLAY_CONFLICT' USING ERRCODE='23505';END IF;
   RETURN jsonb_build_object('correctionId',c.id,'status','posted',
    'entryId',c.reversal_gl_entry_id,'alreadyPosted',true,
    'accountingCertification','NOT_CERTIFIED');
 END IF;
 IF c.status<>'pending_review'
 THEN RAISE EXCEPTION 'B416_CORRECTION_STATE_INVALID' USING ERRCODE='22023';END IF;
 v_info:=public.powerhub_financial_supplier_payment_correction_readiness(
   p_tenant_id,p_site_id,c.payment_id);
 IF v_info->>'status'<>'SOURCE_VERIFIED_WORKFLOW_NOT_IMPLEMENTED'
 OR (v_info->>'originalGLEntryId')::bigint IS DISTINCT FROM c.original_gl_entry_id
 OR v_info->>'originalGLFingerprint' IS DISTINCT FROM c.original_gl_fingerprint
 OR (v_info->>'paymentAmount')::numeric IS DISTINCT FROM c.amount
 THEN RAISE EXCEPTION 'B416_CORRECTION_EVIDENCE_CHANGED' USING ERRCODE='22023';END IF;
 SELECT * INTO p FROM public.supplier_payments
 WHERE id=c.payment_id AND tenant_id=p_tenant_id AND site_id=p_site_id FOR UPDATE;
 IF p.status<>'posted' THEN RAISE EXCEPTION 'B416_PAYMENT_NOT_POSTED' USING ERRCODE='22023';END IF;
 SELECT * INTO ca FROM public.company_accounts
 WHERE id=p.company_account_id AND tenant_id=p_tenant_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'B416_COMPANY_ACCOUNT_NOT_FOUND' USING ERRCODE='22023';END IF;
 SELECT * INTO gl FROM public.financial_gl_entries WHERE id=c.original_gl_entry_id
 AND tenant_id=p_tenant_id AND site_id=p_site_id;
 IF gl.period>v_current_period THEN
   RAISE EXCEPTION 'B416_CORRECTION_ORIGINAL_PERIOD_IN_FUTURE' USING ERRCODE='22023';END IF;
 v_reference:='REV-SUPPLIER-PAYMENT-'||p.id;
 INSERT INTO public.account_transactions(
 tenant_id,site_id,account_id,transaction_type,amount,description,reference_no,
 related_supplier_payment_id,created_by_user_id,occurred_at)
 VALUES(p_tenant_id,p_site_id,p.company_account_id,'deposit',p.amount,
 'تصحيح دفعة مورد معتمد #'||p.id||' — '||c.reason,
 v_reference,p.id,p_approver_id,clock_timestamp())
 RETURNING id INTO v_refund;
 INSERT INTO public.supplier_ledger_entries(
 tenant_id,site_id,supplier_id,entry_type,credit_amount,debit_amount,
 supplier_payment_id,purchase_id,entry_key,reference_no,description,
 occurred_at,created_by_user_id)
 VALUES(p_tenant_id,p_site_id,p.supplier_id,'reversal',p.amount,0,
  p.id,NULL,'supplier-payment-reversal:'||p.id,p.reference_no,
  'تصحيح دفعة المورد #'||p.id||' — '||c.reason,clock_timestamp(),p_approver_id)
 RETURNING id INTO v_sl;
 UPDATE public.supplier_payments
 SET status='reversed',reversed_at=clock_timestamp(),
  reversed_by_user_id=p_approver_id,reversal_reason=c.reason,updated_at=clock_timestamp()
 WHERE tenant_id=p_tenant_id AND site_id=p_site_id AND id=p.id;
 UPDATE public.financial_supplier_payment_corrections
 SET status='posting',approved_by_user_id=p_approver_id,approved_at=clock_timestamp(),
 refund_transaction_id=v_refund,reversal_supplier_ledger_entry_id=v_sl
 WHERE id=c.id;
 -- The balance-preserving GL source is posted before the end of the SAME transaction.
 v_post:=public.powerhub_financial_gl_post_source(p_tenant_id,p_site_id,
  'supplier_ledger',v_sl,p_approver_id);
 IF v_post->>'status'<>'posted' OR (v_post->>'alreadyPosted')::boolean IS DISTINCT FROM false
 THEN RAISE EXCEPTION 'B416_CORRECTION_GL_POST_INCOMPLETE' USING ERRCODE='23514';END IF;
 UPDATE public.financial_supplier_payment_corrections
 SET status='posted',reversal_gl_entry_id=(v_post->>'entryId')::bigint WHERE id=c.id;
 IF public.powerhub_financial_supplier_payment_correction_proof(
  p_tenant_id,p_site_id,p.id)<>'SOURCE_BACKED_REVERSAL_VALID'
 THEN RAISE EXCEPTION 'B416_CORRECTION_POSTED_PROOF_FAILED' USING ERRCODE='23514';END IF;
 SELECT platform_role INTO v_platform_role FROM public.users WHERE id=p_approver_id;
 IF v_platform_role NOT IN('platform_owner','platform_admin','finance_admin')
 THEN v_platform_role:=NULL;END IF;
 INSERT INTO public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,
  entity_type,entity_id,action,after_data)
 VALUES(p_tenant_id,p_site_id,p_approver_id,v_platform_role,'supplier_payment',
 p.id::text,'reverse',jsonb_build_object(
 'correctionId',c.id,'sourceGlId',c.original_gl_entry_id,
 'reversalGlId',(v_post->>'entryId')::bigint,
 'refundTransactionId',v_refund,'reversalSupplierLedgerId',v_sl,
 'makerId',c.requested_by_user_id,'checkerId',p_approver_id));
 RETURN jsonb_build_object('correctionId',c.id,'status','posted',
 'entryId',(v_post->>'entryId')::bigint,'alreadyPosted',false,
 'accountingCertification','NOT_CERTIFIED');
END;
$approve$;

REVOKE ALL ON FUNCTION public.powerhub_financial_supplier_payment_correction_proof(bigint,bigint,bigint)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_supplier_payment_correction_proof(bigint,bigint,bigint) TO service_role;
REVOKE ALL ON FUNCTION public.powerhub_financial_supplier_payment_correction_request(bigint,bigint,bigint,bigint,text,text)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_supplier_payment_correction_request(bigint,bigint,bigint,bigint,text,text) TO service_role;
REVOKE ALL ON FUNCTION public.powerhub_financial_supplier_payment_correction_approve_post(bigint,bigint,bigint,bigint)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_supplier_payment_correction_approve_post(bigint,bigint,bigint,bigint) TO service_role;
