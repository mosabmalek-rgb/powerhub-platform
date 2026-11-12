-- B4.16: independently reviewed supplier-payment correction, atomic source/cash/GL reversal.
-- Requires B4.15 and pre-existing source backed GL. No historical auto-correction.
-- One and only one compensating cash deposit may be referenced for a supplier payment.
CREATE UNIQUE INDEX IF NOT EXISTS b416_supplier_refund_tenant_reference_unique
 ON public.account_transactions(tenant_id,reference_no)
 WHERE transaction_type='deposit' AND reference_no LIKE 'REV-SUPPLIER-PAYMENT-%';

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
   OR refund.related_supplier_payment_id IS NOT NULL
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
 IF (SELECT count(*) FROM public.account_transactions t
    WHERE t.tenant_id=p_tenant_id AND t.site_id=p_site_id
      AND t.account_id=p.company_account_id AND t.transaction_type='deposit'
      AND t.reference_no='REV-SUPPLIER-PAYMENT-'||p.id)<>1
 THEN RETURN 'B416_REFUND_REFERENCE_NOT_UNIQUE';END IF;
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
 -- Posted requests replay only after the source-linked GL/cash reversal is proven.
 -- The original preflight intentionally rejects already-reversed payment sources.
 SELECT * INTO c FROM public.financial_supplier_payment_corrections
 WHERE tenant_id=p_tenant_id AND site_id=p_site_id AND payment_id=p_payment_id
 FOR UPDATE;
 IF FOUND AND c.status='posted' THEN
   IF c.requested_by_user_id<>p_user_id OR c.operation_key<>v_key
      OR c.reason<>v_reason OR
      public.powerhub_financial_supplier_payment_correction_proof(
        p_tenant_id,p_site_id,p_payment_id)<>'SOURCE_BACKED_REVERSAL_VALID'
   THEN RAISE EXCEPTION 'B416_CORRECTION_REQUEST_CONFLICT' USING ERRCODE='23505';END IF;
   RETURN jsonb_build_object('correctionId',c.id,'status','posted',
    'alreadyRequested',true,'alreadyPosted',true,
    'accountingCertification','NOT_CERTIFIED');
 END IF;
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
 IF EXISTS(SELECT 1 FROM public.account_transactions t
   WHERE t.tenant_id=p_tenant_id AND t.reference_no=v_reference
     AND t.transaction_type='deposit')
 OR EXISTS(SELECT 1 FROM public.supplier_ledger_entries sl
   WHERE sl.tenant_id=p_tenant_id AND sl.site_id=p_site_id
     AND sl.supplier_payment_id=p.id AND sl.entry_type='reversal')
 THEN RAISE EXCEPTION 'B416_PREEXISTING_UNVERIFIED_REFUND_OR_REVERSAL'
    USING ERRCODE='23505';END IF;
 INSERT INTO public.account_transactions(
 tenant_id,site_id,account_id,transaction_type,amount,description,reference_no,
 created_by_user_id,occurred_at)
 VALUES(p_tenant_id,p_site_id,p.company_account_id,'deposit',p.amount,
 'تصحيح دفعة مورد معتمد #'||p.id||' — '||c.reason,
 v_reference,p_approver_id,clock_timestamp())
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

-- B4.16 explicit source plan maintains original immutable fingerprint after evidence-backed reversal.
CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_source_plan(p_tenant_id bigint, p_site_id bigint, p_source_type text, p_source_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
 i public.invoices%ROWTYPE; pay public.payments%ROWTYPE;
 exp public.expenses%ROWTYPE; stock public.inventory_stock_movements%ROWTYPE;
 supplier public.supplier_ledger_entries%ROWTYPE;
 payroll public.payroll_runs%ROWTYPE;
 a public.account_transactions%ROWTYPE;
 ca public.company_accounts%ROWTYPE;
 purch public.supplier_purchases%ROWTYPE;
 sp public.supplier_payments%ROWTYPE;
 corr public.financial_supplier_payment_corrections%ROWTYPE;
 v_original_gl public.financial_gl_entries%ROWTYPE;
 v_origin_sl public.supplier_ledger_entries%ROWTYPE;
 v_refund_tx public.account_transactions%ROWTYPE;
 original public.inventory_stock_movements%ROWTYPE;
 op public.company_account_movement_operations%ROWTYPE;
 incoming public.account_transactions%ROWTYPE;
 destination_account public.company_accounts%ROWTYPE;
 v_source_cash_code text;v_destination_cash_code text;
 v_count bigint;v_sum numeric;v_gross numeric;v_net numeric;v_adv numeric;v_other numeric;
 v_payload jsonb;v_lines jsonb:='[]'::jsonb;v_policy text;v_period text;
 v_reversal_id bigint;v_cash_account text;v_amount numeric;
BEGIN
 IF p_tenant_id IS NULL OR p_tenant_id<=0 OR p_site_id IS NULL OR p_site_id<=0
   OR p_source_id IS NULL OR p_source_id<=0 OR p_source_type IS NULL
   OR p_source_type NOT IN('invoice','payment','expense','stock_movement','supplier_ledger','payroll','payroll_payment','account_movement')
   OR NOT EXISTS(SELECT 1 FROM public.sites s WHERE s.id=p_site_id
      AND s.tenant_id=p_tenant_id AND s.status<>'archived')
 THEN RAISE EXCEPTION 'GL_SOURCE_SCOPE_INVALID' USING ERRCODE='22023'; END IF;
 IF p_source_type='invoice' THEN
  SELECT * INTO i FROM public.invoices
   WHERE id=p_source_id AND tenant_id=p_tenant_id AND site_id=p_site_id FOR SHARE;
  IF NOT FOUND OR i.status NOT IN ('issued','overdue','partially_paid','paid')
     OR i.total_amount<=0 OR i.tax_amount<0 OR i.tax_amount>i.total_amount
     OR i.total_amount<>round(i.total_amount,2) OR i.tax_amount<>round(i.tax_amount,2)
     OR i.credit_applied_amount<>0 OR i.cycle_start_at IS NULL OR i.cycle_end_at IS NULL
     OR i.cycle_end_at<i.cycle_start_at
  THEN RAISE EXCEPTION 'GL_INVOICE_UNVERIFIED_OR_CREDIT_NOT_SUPPORTED' USING ERRCODE='22023'; END IF;
  v_period:=to_char(i.issue_date AT TIME ZONE 'Asia/Gaza','YYYY-MM');
  v_lines:=jsonb_build_array(
    jsonb_build_object('code','1200','side','debit','amount',i.total_amount),
    jsonb_build_object('code','2200','side','credit','amount',i.total_amount-i.tax_amount));
  IF i.tax_amount>0 THEN
    v_lines:=v_lines||jsonb_build_array(jsonb_build_object('code','2500','side','credit','amount',i.tax_amount));
  END IF;
  v_payload:=jsonb_build_object('id',i.id,'issuedAt',i.issue_date,
    'cycleStart',i.cycle_start_at,'cycleEnd',i.cycle_end_at,
    'gross',i.total_amount,'tax',i.tax_amount,'creditApplied',i.credit_applied_amount,
    'invoiceNo',i.invoice_no,'subscriberId',i.subscriber_id);
  v_policy:='invoice-receivable-v1-defer-service';
 ELSIF p_source_type='payment' THEN
  SELECT * INTO pay FROM public.payments WHERE id=p_source_id
    AND tenant_id=p_tenant_id AND site_id=p_site_id FOR SHARE;
  IF NOT FOUND OR pay.status<>'completed' OR pay.amount<=0
    OR pay.amount<>round(pay.amount,2)
    OR pay.invoice_applied_amount<0 OR pay.subscriber_credit_amount<0
    OR pay.amount<>pay.invoice_applied_amount+pay.subscriber_credit_amount
    OR (pay.invoice_applied_amount>0 AND (pay.invoice_id IS NULL OR
      NOT EXISTS(SELECT 1 FROM public.invoices iv WHERE iv.id=pay.invoice_id
       AND iv.tenant_id=p_tenant_id AND iv.site_id=p_site_id)))
  THEN RAISE EXCEPTION 'GL_PAYMENT_AMOUNT_OR_INVOICE_INVALID' USING ERRCODE='22023'; END IF;
  SELECT count(*) INTO v_count FROM public.account_transactions t
  WHERE t.tenant_id=p_tenant_id AND t.related_payment_id=pay.id;
  IF v_count<>1 THEN RAISE EXCEPTION 'GL_PAYMENT_COLLECTION_LINK_MISSING' USING ERRCODE='22023'; END IF;
  SELECT * INTO a FROM public.account_transactions t
  WHERE t.tenant_id=p_tenant_id AND t.related_payment_id=pay.id FOR SHARE;
  IF a.site_id IS DISTINCT FROM p_site_id OR a.transaction_type<>'collection'
    OR a.amount<>pay.amount OR a.amount<=0
  THEN RAISE EXCEPTION 'GL_PAYMENT_COLLECTION_MISMATCH' USING ERRCODE='22023'; END IF;
  SELECT * INTO ca FROM public.company_accounts
   WHERE id=a.account_id AND tenant_id=p_tenant_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'GL_PAYMENT_CASH_ACCOUNT_UNKNOWN' USING ERRCODE='22023'; END IF;
  v_cash_account:=CASE WHEN ca.account_type='cash' THEN '1010' ELSE '1020' END;
  -- A payment settles an already issued invoice. It must not create revenue twice.
  IF pay.invoice_applied_amount>0 AND NOT EXISTS(
    SELECT 1 FROM public.financial_gl_entries e WHERE e.tenant_id=p_tenant_id
     AND e.site_id=p_site_id AND e.source_type='invoice'
     AND e.source_id=pay.invoice_id::text AND e.source_revision=1)
  THEN RAISE EXCEPTION 'GL_PAYMENT_INVOICE_NOT_POSTED' USING ERRCODE='22023'; END IF;
  v_period:=to_char(pay.paid_at AT TIME ZONE 'Asia/Gaza','YYYY-MM');
  v_lines:=jsonb_build_array(jsonb_build_object('code',v_cash_account,'side','debit','amount',pay.amount));
  IF pay.invoice_applied_amount>0 THEN
   v_lines:=v_lines||jsonb_build_array(
    jsonb_build_object('code','1200','side','credit','amount',pay.invoice_applied_amount));
  END IF;
  IF pay.subscriber_credit_amount>0 THEN
   v_lines:=v_lines||jsonb_build_array(
    jsonb_build_object('code','2250','side','credit','amount',pay.subscriber_credit_amount));
  END IF;
  v_payload:=jsonb_build_object('id',pay.id,'paidAt',pay.paid_at,'amount',pay.amount,
   'invoiceId',pay.invoice_id,'applied',pay.invoice_applied_amount,
   'credit',pay.subscriber_credit_amount,'movementId',a.id,'accountId',a.account_id,
   'accountType',ca.account_type,'movementAmount',a.amount);
  v_policy:='payment-receivable-and-prepayment-v1';
 ELSIF p_source_type='expense' THEN
  SELECT * INTO exp FROM public.expenses WHERE id=p_source_id
    AND tenant_id=p_tenant_id AND site_id=p_site_id FOR SHARE;
  IF NOT FOUND OR exp.amount<=0 OR exp.amount<>round(exp.amount,2)
    OR exp.company_account_id IS NULL
    OR exp.expense_classification NOT IN ('operating','non_operating')
    OR exp.category='payroll'
  THEN RAISE EXCEPTION 'GL_EXPENSE_NOT_CASH_VERIFIED' USING ERRCODE='22023'; END IF;
  SELECT count(*) INTO v_count FROM public.account_transactions t
    WHERE t.tenant_id=p_tenant_id AND t.related_expense_id=exp.id;
  IF v_count<>1 THEN RAISE EXCEPTION 'GL_EXPENSE_CASH_LINK_MISSING' USING ERRCODE='22023'; END IF;
  SELECT * INTO a FROM public.account_transactions t
    WHERE t.tenant_id=p_tenant_id AND t.related_expense_id=exp.id FOR SHARE;
  IF a.site_id IS DISTINCT FROM p_site_id OR a.transaction_type<>'withdrawal'
     OR a.amount<>exp.amount OR a.account_id<>exp.company_account_id
  THEN RAISE EXCEPTION 'GL_EXPENSE_CASH_MISMATCH' USING ERRCODE='22023'; END IF;
  SELECT * INTO ca FROM public.company_accounts
    WHERE id=a.account_id AND tenant_id=p_tenant_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'GL_EXPENSE_CASH_ACCOUNT_UNKNOWN' USING ERRCODE='22023'; END IF;
  v_cash_account:=CASE WHEN ca.account_type='cash' THEN '1010' ELSE '1020' END;
  v_period:=to_char(exp.occurred_at AT TIME ZONE 'Asia/Gaza','YYYY-MM');
  v_lines:=jsonb_build_array(
   jsonb_build_object('code',CASE WHEN exp.expense_classification='operating'
      THEN '5100' ELSE '6100' END,'side','debit','amount',exp.amount),
   jsonb_build_object('code',v_cash_account,'side','credit','amount',exp.amount));
  v_payload:=jsonb_build_object('id',exp.id,'amount',exp.amount,'occurredAt',exp.occurred_at,
    'classification',exp.expense_classification,'category',exp.category,
    'movementId',a.id,'accountId',a.account_id,'cashType',ca.account_type);
  v_policy:='cash-expense-no-double-count-v1';
 ELSIF p_source_type='account_movement' THEN
  -- The primary transaction id is the stable numeric key of a transfer operation.
  SELECT * INTO op FROM public.company_account_movement_operations x
  WHERE x.tenant_id=p_tenant_id AND x.site_id=p_site_id
    AND x.primary_transaction_id=p_source_id AND x.operation_type='transfer'
    FOR SHARE;
  IF NOT FOUND OR op.counterpart_transaction_id IS NULL
     OR (SELECT count(*) FROM public.company_account_movement_operations x
       WHERE x.tenant_id=p_tenant_id AND x.primary_transaction_id=p_source_id)<>1
  THEN RAISE EXCEPTION 'GL_COMPANY_TRANSFER_OPERATION_NOT_FOUND' USING ERRCODE='22023'; END IF;
  SELECT * INTO a FROM public.account_transactions t
  WHERE t.tenant_id=p_tenant_id AND t.id=op.primary_transaction_id FOR SHARE;
  SELECT * INTO incoming FROM public.account_transactions t
  WHERE t.tenant_id=p_tenant_id AND t.id=op.counterpart_transaction_id FOR SHARE;
  SELECT * INTO ca FROM public.company_accounts ac
  WHERE ac.tenant_id=p_tenant_id AND ac.id=a.account_id FOR SHARE;
  SELECT * INTO destination_account FROM public.company_accounts ac
  WHERE ac.tenant_id=p_tenant_id AND ac.id=incoming.account_id FOR SHARE;
  IF a.id IS NULL OR incoming.id IS NULL OR ca.id IS NULL OR destination_account.id IS NULL
     OR a.site_id IS DISTINCT FROM p_site_id
     OR incoming.site_id IS DISTINCT FROM p_site_id
     OR a.transaction_type<>'transfer_out' OR incoming.transaction_type<>'transfer_in'
     OR a.account_id=incoming.account_id
     OR a.related_account_id IS DISTINCT FROM incoming.account_id
     OR incoming.related_account_id IS DISTINCT FROM a.account_id
     OR a.amount IS DISTINCT FROM incoming.amount
     OR a.amount<=0 OR a.amount<>round(a.amount,2)
     OR a.description IS DISTINCT FROM incoming.description
     OR NOT EXISTS (SELECT 1 FROM generate_series(0,6) precision_scale
       WHERE op.payload_hash=md5(jsonb_build_object(
       'tenantId',p_tenant_id,'siteId',p_site_id,
       'userId',op.created_by_user_id,'fromAccountId',a.account_id,
       'toAccountId',incoming.account_id,'amount',round(a.amount,precision_scale),
       'description',btrim(a.description))::text))
     OR (SELECT count(*) FROM public.company_account_movement_operations x
       WHERE x.tenant_id=p_tenant_id
       AND x.counterpart_transaction_id=incoming.id)<>1
     OR a.created_by_user_id IS DISTINCT FROM op.created_by_user_id
     OR incoming.created_by_user_id IS DISTINCT FROM op.created_by_user_id
     OR ca.account_type NOT IN ('cash','jawwal_pay','palpay','bank_of_palestine','other')
     OR destination_account.account_type NOT IN ('cash','jawwal_pay','palpay','bank_of_palestine','other')
     OR to_char(a.occurred_at AT TIME ZONE 'Asia/Gaza','YYYY-MM')
        <>to_char(incoming.occurred_at AT TIME ZONE 'Asia/Gaza','YYYY-MM')
     OR EXISTS(SELECT 1 FROM public.company_account_sites s WHERE s.tenant_id=p_tenant_id AND s.account_id=a.account_id)
        AND NOT EXISTS(SELECT 1 FROM public.company_account_sites s WHERE s.tenant_id=p_tenant_id AND s.account_id=a.account_id AND s.site_id=p_site_id)
     OR EXISTS(SELECT 1 FROM public.company_account_sites s WHERE s.tenant_id=p_tenant_id AND s.account_id=incoming.account_id)
        AND NOT EXISTS(SELECT 1 FROM public.company_account_sites s WHERE s.tenant_id=p_tenant_id AND s.account_id=incoming.account_id AND s.site_id=p_site_id)
  THEN RAISE EXCEPTION 'GL_COMPANY_TRANSFER_PAIR_INVALID_OR_CROSS_SITE' USING ERRCODE='22023'; END IF;
  v_source_cash_code:=CASE WHEN ca.account_type='cash' THEN '1010' ELSE '1020' END;
  v_destination_cash_code:=CASE WHEN destination_account.account_type='cash' THEN '1010' ELSE '1020' END;
  v_period:=to_char(a.occurred_at AT TIME ZONE 'Asia/Gaza','YYYY-MM');
  v_lines:=jsonb_build_array(
    jsonb_build_object('code',v_destination_cash_code,'side','debit','amount',a.amount),
    jsonb_build_object('code',v_source_cash_code,'side','credit','amount',a.amount));
  v_payload:=jsonb_build_object('operationKey',op.operation_key,'payloadHash',op.payload_hash,
    'fromTransactionId',a.id,'toTransactionId',incoming.id,
    'fromAccount',a.account_id,'toAccount',incoming.account_id,
    'fromAccountType',ca.account_type,'toAccountType',destination_account.account_type,
    'fromOccurredAt',a.occurred_at,'toOccurredAt',incoming.occurred_at,
    'sourceAmount',a.amount,'destinationAmount',incoming.amount,'actor',op.created_by_user_id);
  v_policy:='company-transfer-paired-no-income-or-expense-v1';
 ELSIF p_source_type='stock_movement' THEN
  SELECT * INTO stock FROM public.inventory_stock_movements
   WHERE id=p_source_id AND tenant_id=p_tenant_id AND site_id=p_site_id FOR SHARE;
  IF NOT FOUND OR stock.total_cost_amount<=0 OR stock.total_cost_amount<>round(stock.total_cost_amount,2)
    OR stock.quantity<=0 OR stock.quantity*stock.unit_cost<>stock.total_cost_amount
    OR NOT EXISTS(SELECT 1 FROM public.inventory_items it
      WHERE it.id=stock.item_id AND it.tenant_id=p_tenant_id
        AND it.accounting_treatment='expense_on_issue')
  THEN RAISE EXCEPTION 'GL_STOCK_QUANTITY_COST_OR_CLASS_INVALID' USING ERRCODE='22023'; END IF;
  v_period:=to_char(stock.occurred_at AT TIME ZONE 'Asia/Gaza','YYYY-MM');
  -- A paired warehouse transfer is NEVER an operating expense.
  -- The associated adjustment_in is a location move, not an undo of usage.
  IF stock.operation_key LIKE 'trf:%:out' OR
     stock.operation_key LIKE 'trf:%:in' THEN
    RAISE EXCEPTION 'GL_INTERNAL_STOCK_TRANSFER_NOT_AN_EXPENSE'
      USING ERRCODE='22023'; END IF;
  IF stock.movement_type='issue' THEN
    v_lines:=jsonb_build_array(
      jsonb_build_object('code','5100','side','debit','amount',stock.total_cost_amount),
      jsonb_build_object('code','1300','side','credit','amount',stock.total_cost_amount));
  ELSIF stock.movement_type='adjustment_in' THEN
    IF stock.reversal_of_movement_id IS NULL THEN
      RAISE EXCEPTION 'GL_STOCK_ADJUSTMENT_NEEDS_SOURCE_LINK' USING ERRCODE='22023'; END IF;
    SELECT * INTO original FROM public.inventory_stock_movements m
    WHERE m.id=stock.reversal_of_movement_id AND m.tenant_id=p_tenant_id
      AND m.site_id=p_site_id AND m.movement_type='issue' FOR SHARE;
    IF NOT FOUND OR original.item_id<>stock.item_id OR original.quantity<>stock.quantity
      OR original.total_cost_amount<>stock.total_cost_amount THEN
      RAISE EXCEPTION 'GL_STOCK_REVERSAL_NOT_MATCHED' USING ERRCODE='22023'; END IF;
    SELECT id INTO v_reversal_id FROM public.financial_gl_entries e
      WHERE e.tenant_id=p_tenant_id AND e.site_id=p_site_id
        AND e.source_type='stock_movement' AND e.source_id=original.id::text
        AND e.source_revision=1;
    IF v_reversal_id IS NULL THEN
      RAISE EXCEPTION 'GL_STOCK_REVERSAL_ORIGINAL_NOT_POSTED' USING ERRCODE='22023'; END IF;
    v_lines:=jsonb_build_array(
      jsonb_build_object('code','1300','side','debit','amount',stock.total_cost_amount),
      jsonb_build_object('code','5100','side','credit','amount',stock.total_cost_amount));
  ELSE
    RAISE EXCEPTION 'GL_STOCK_EVENT_ACCOUNTED_VIA_SUPPLIER_LEDGER_OR_UNSUPPORTED'
      USING ERRCODE='22023';
  END IF;
  v_payload:=jsonb_build_object('id',stock.id,'itemId',stock.item_id,
    'type',stock.movement_type,'quantity',stock.quantity,'unitCost',stock.unit_cost,
    'cost',stock.total_cost_amount,'date',stock.occurred_at,
    'reversesMovement',stock.reversal_of_movement_id);
  v_policy:='inventory-expense-on-issue-v1';
 ELSIF p_source_type='supplier_ledger' THEN
  SELECT * INTO supplier FROM public.supplier_ledger_entries
   WHERE id=p_source_id AND tenant_id=p_tenant_id AND site_id=p_site_id FOR SHARE;
  IF NOT FOUND OR supplier.entry_type NOT IN ('purchase','supplier_return','payment','reversal')
    OR supplier.debit_amount<0 OR supplier.credit_amount<0
    OR supplier.debit_amount<>round(supplier.debit_amount,2)
    OR supplier.credit_amount<>round(supplier.credit_amount,2)
  THEN RAISE EXCEPTION 'GL_SUPPLIER_EVENT_INVALID' USING ERRCODE='22023'; END IF;
  v_period:=to_char(supplier.occurred_at AT TIME ZONE 'Asia/Gaza','YYYY-MM');
  IF supplier.entry_type='purchase' THEN
    SELECT * INTO purch FROM public.supplier_purchases
     WHERE id=supplier.purchase_id AND tenant_id=p_tenant_id AND site_id=p_site_id FOR SHARE;
    SELECT coalesce(sum(m.total_cost_amount),0),count(*) INTO v_sum,v_count
    FROM public.inventory_stock_movements m WHERE m.tenant_id=p_tenant_id
      AND m.site_id=p_site_id AND m.purchase_id=supplier.purchase_id
      AND m.movement_type='purchase_receipt';
    IF NOT FOUND OR purch.id IS NULL OR purch.status<>'received'
       OR v_count<1 OR supplier.debit_amount<>0 OR supplier.credit_amount<=0
       OR v_sum<>supplier.credit_amount
       OR purch.total_amount<>supplier.credit_amount THEN
      RAISE EXCEPTION 'GL_SUPPLIER_PURCHASE_NOT_RECEIVED_OR_RECONCILED' USING ERRCODE='22023'; END IF;
    v_lines:=jsonb_build_array(
      jsonb_build_object('code','1300','side','debit','amount',v_sum),
      jsonb_build_object('code','2300','side','credit','amount',supplier.credit_amount));
  ELSIF supplier.entry_type='supplier_return' THEN
    SELECT coalesce(sum(m.total_cost_amount),0),count(*) INTO v_sum,v_count
    FROM public.inventory_stock_movements m WHERE m.tenant_id=p_tenant_id
     AND m.site_id=p_site_id AND m.purchase_id=supplier.purchase_id
     AND m.movement_type='supplier_return'
     AND m.reference_no=supplier.reference_no;
    IF supplier.reference_no IS NULL
      OR supplier.supplier_return_id IS NULL OR supplier.debit_amount<=0
      OR supplier.credit_amount<>0 OR v_sum<>supplier.debit_amount OR v_count<1
      OR NOT EXISTS(SELECT 1 FROM public.financial_gl_entries e
       WHERE e.tenant_id=p_tenant_id AND e.site_id=p_site_id
       AND e.source_type='supplier_ledger' AND e.source_id IN (
          SELECT s.id::text FROM public.supplier_ledger_entries s
          WHERE s.tenant_id=p_tenant_id AND s.site_id=p_site_id
            AND s.entry_type='purchase' AND s.purchase_id=supplier.purchase_id))
    THEN RAISE EXCEPTION 'GL_SUPPLIER_RETURN_NOT_RECONCILED' USING ERRCODE='22023'; END IF;
    v_lines:=jsonb_build_array(
      jsonb_build_object('code','2300','side','debit','amount',supplier.debit_amount),
      jsonb_build_object('code','1300','side','credit','amount',supplier.debit_amount));
  ELSIF supplier.entry_type='reversal' THEN
    SELECT * INTO corr FROM public.financial_supplier_payment_corrections c
      WHERE c.tenant_id=p_tenant_id AND c.site_id=p_site_id
      AND c.payment_id=supplier.supplier_payment_id
      AND c.reversal_supplier_ledger_entry_id=supplier.id
      AND c.status IN ('posting','posted') FOR SHARE;
    SELECT * INTO sp FROM public.supplier_payments
      WHERE tenant_id=p_tenant_id AND site_id=p_site_id
        AND id=supplier.supplier_payment_id FOR SHARE;
    SELECT * INTO v_origin_sl FROM public.supplier_ledger_entries
      WHERE tenant_id=p_tenant_id AND site_id=p_site_id
        AND id=corr.original_supplier_ledger_id FOR SHARE;
    SELECT * INTO v_original_gl FROM public.financial_gl_entries
      WHERE tenant_id=p_tenant_id AND site_id=p_site_id
        AND id=corr.original_gl_entry_id;
    SELECT * INTO v_refund_tx FROM public.account_transactions
      WHERE tenant_id=p_tenant_id AND site_id=p_site_id
        AND id=corr.refund_transaction_id FOR SHARE;
    IF corr.id IS NULL OR sp.id IS NULL OR v_origin_sl.id IS NULL
       OR v_original_gl.id IS NULL OR v_refund_tx.id IS NULL
       OR corr.amount<=0 OR corr.amount<>sp.amount
       OR sp.status<>'reversed'
       OR sp.reversed_by_user_id IS DISTINCT FROM corr.approved_by_user_id
       OR sp.reversal_reason IS DISTINCT FROM corr.reason
       OR corr.requested_by_user_id=corr.approved_by_user_id
       OR corr.approved_at IS NULL
       OR supplier.supplier_id<>sp.supplier_id
       OR supplier.debit_amount<>0 OR supplier.credit_amount<>corr.amount
       OR supplier.entry_key IS DISTINCT FROM 'supplier-payment-reversal:'||sp.id
       OR v_origin_sl.entry_type<>'payment'
       OR v_origin_sl.supplier_payment_id<>sp.id
       OR v_origin_sl.debit_amount<>corr.amount
       OR v_original_gl.source_type<>'supplier_ledger'
       OR v_original_gl.source_id IS DISTINCT FROM v_origin_sl.id::text
       OR v_original_gl.source_fingerprint IS DISTINCT FROM corr.original_gl_fingerprint
       OR v_refund_tx.account_id<>sp.company_account_id
       OR v_refund_tx.related_supplier_payment_id IS NOT NULL
       OR v_refund_tx.transaction_type<>'deposit'
       OR v_refund_tx.amount<>sp.amount
       OR v_refund_tx.reference_no IS DISTINCT FROM 'REV-SUPPLIER-PAYMENT-'||sp.id
       OR EXISTS(SELECT 1 FROM public.financial_gl_entries e
         WHERE e.tenant_id=p_tenant_id AND e.site_id=p_site_id
         AND e.reverses_entry_id=v_original_gl.id
         AND e.source_id IS DISTINCT FROM supplier.id::text)
    THEN RAISE EXCEPTION 'GL_SUPPLIER_CORRECTION_SOURCE_INVALID' USING ERRCODE='22023'; END IF;
    SELECT * INTO ca FROM public.company_accounts
      WHERE tenant_id=p_tenant_id AND id=sp.company_account_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'GL_SUPPLIER_CORRECTION_ACCOUNT_MISSING' USING ERRCODE='22023'; END IF;
    v_cash_account:=CASE WHEN ca.account_type='cash' THEN '1010' ELSE '1020' END;
    IF (SELECT count(*) FROM public.financial_gl_lines l
      WHERE l.entry_id=v_original_gl.id)<>2
       OR NOT EXISTS(SELECT 1 FROM public.financial_gl_lines l
        WHERE l.entry_id=v_original_gl.id AND l.account_code='2300'
          AND l.side='debit' AND l.amount=sp.amount)
       OR NOT EXISTS(SELECT 1 FROM public.financial_gl_lines l
        WHERE l.entry_id=v_original_gl.id AND l.account_code=v_cash_account
          AND l.side='credit' AND l.amount=sp.amount)
    THEN RAISE EXCEPTION 'GL_SUPPLIER_CORRECTION_ORIGINAL_LINES_CHANGED'
       USING ERRCODE='22023'; END IF;
    v_reversal_id:=v_original_gl.id;
    v_lines:=jsonb_build_array(
      jsonb_build_object('code',v_cash_account,'side','debit','amount',sp.amount),
      jsonb_build_object('code','2300','side','credit','amount',sp.amount));
    v_policy:='supplier-payment-source-correction-v1';
    v_payload:=jsonb_build_object(
      'id',supplier.id,'type','reversal','date',supplier.occurred_at,
      'paymentId',sp.id,'amount',sp.amount,'originalLedgerId',v_origin_sl.id,
      'originalGlId',v_original_gl.id,'originalSha',corr.original_gl_fingerprint,
      'correctionId',corr.id,'refundTransactionId',v_refund_tx.id,
      'makerId',corr.requested_by_user_id,'checkerId',corr.approved_by_user_id,
      'approvedAt',corr.approved_at);
  ELSE
    SELECT * INTO sp FROM public.supplier_payments
      WHERE id=supplier.supplier_payment_id AND tenant_id=p_tenant_id
       AND site_id=p_site_id FOR SHARE;
    IF NOT FOUND OR (sp.status<>'posted' AND NOT (sp.status='reversed' AND
      public.powerhub_financial_supplier_payment_correction_proof(p_tenant_id,p_site_id,sp.id)
        ='SOURCE_BACKED_REVERSAL_VALID')) OR sp.amount<=0
       OR sp.amount<>supplier.debit_amount OR supplier.credit_amount<>0
       OR sp.account_transaction_id IS NULL
    THEN RAISE EXCEPTION 'GL_SUPPLIER_PAYMENT_NOT_POSTED' USING ERRCODE='22023'; END IF;
    SELECT * INTO a FROM public.account_transactions
      WHERE id=sp.account_transaction_id AND tenant_id=p_tenant_id FOR SHARE;
    IF NOT FOUND OR a.site_id IS DISTINCT FROM p_site_id
       OR a.related_supplier_payment_id<>sp.id
       OR a.transaction_type<>'withdrawal' OR a.amount<>sp.amount
       OR a.account_id<>sp.company_account_id
    THEN RAISE EXCEPTION 'GL_SUPPLIER_PAYMENT_CASH_MISMATCH' USING ERRCODE='22023'; END IF;
    SELECT * INTO ca FROM public.company_accounts
      WHERE id=a.account_id AND tenant_id=p_tenant_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'GL_SUPPLIER_PAYMENT_ACCOUNT_UNKNOWN' USING ERRCODE='22023'; END IF;
    v_cash_account:=CASE WHEN ca.account_type='cash' THEN '1010' ELSE '1020' END;
    v_lines:=jsonb_build_array(
      jsonb_build_object('code','2300','side','debit','amount',supplier.debit_amount),
      jsonb_build_object('code',v_cash_account,'side','credit','amount',supplier.debit_amount));
    -- Supplier purchase is recognized once from supplier_ledger, never
    -- a second expense from the matching bank movement or receipt.
    IF NOT EXISTS(SELECT 1 FROM public.financial_gl_entries e
       WHERE e.tenant_id=p_tenant_id AND e.site_id=p_site_id
         AND e.source_type='supplier_ledger' AND e.source_id IN
         (SELECT sl.id::text FROM public.supplier_ledger_entries sl
          WHERE sl.tenant_id=p_tenant_id AND sl.site_id=p_site_id
            AND sl.entry_type='purchase' AND sl.purchase_id=supplier.purchase_id))
    THEN RAISE EXCEPTION 'GL_SUPPLIER_PAYMENT_PURCHASE_NOT_POSTED' USING ERRCODE='22023'; END IF;
  END IF;
  IF supplier.entry_type<>'reversal' THEN
  v_payload:=jsonb_build_object('id',supplier.id,'type',supplier.entry_type,
    'date',supplier.occurred_at,'purchaseId',supplier.purchase_id,
    'returnId',supplier.supplier_return_id,'paymentId',supplier.supplier_payment_id,
    'debit',supplier.debit_amount,'credit',supplier.credit_amount,
    'accountTxId',a.id,'receiptAmount',CASE WHEN supplier.entry_type='payment' THEN NULL ELSE v_sum END);
  v_policy:='supplier-event-no-stock-duplication-v1';
  END IF;
 ELSIF p_source_type='payroll' THEN
  SELECT * INTO payroll FROM public.payroll_runs WHERE id=p_source_id
    AND tenant_id=p_tenant_id AND site_id=p_site_id FOR SHARE;
  IF NOT FOUND OR
    (payroll.status<>'approved' AND NOT (
       payroll.status='paid' AND EXISTS(
         SELECT 1 FROM public.financial_gl_entries e
         WHERE e.tenant_id=p_tenant_id AND e.site_id=p_site_id
           AND e.source_type='payroll' AND e.source_id=payroll.id::text
           AND e.source_revision=1)))
    OR payroll.approved_by_user_id IS NULL
    OR payroll.approved_by_user_id=payroll.created_by_user_id
    OR payroll.total_gross<=0 OR payroll.total_net<=0 OR payroll.total_deductions<0
    OR payroll.total_gross<>payroll.total_net+payroll.total_deductions
  THEN RAISE EXCEPTION 'GL_PAYROLL_DRAFT_OR_UNAPPROVED' USING ERRCODE='22023'; END IF;
  SELECT count(*),coalesce(sum(it.base_amount+it.extra_amount),0),
    coalesce(sum(it.net_amount),0),coalesce(sum(it.advance_deduction),0),
    coalesce(sum(it.other_deduction),0)
  INTO v_count,v_gross,v_net,v_adv,v_other FROM public.payroll_items it
  WHERE it.payroll_run_id=payroll.id;
  -- Payroll paid state needs a separately verified cash settlement. The
  -- accrual entry below must never misstate a paid run as unpaid liability.
  IF payroll.status='approved' AND
     (payroll.paid_at IS NOT NULL OR payroll.paid_from_account_id IS NOT NULL)
  THEN RAISE EXCEPTION 'GL_PAYROLL_PAYMENT_REQUIRES_CASH_RECONCILIATION'
    USING ERRCODE='22023'; END IF;
  IF v_count<1 OR v_gross<>payroll.total_gross OR v_net<>payroll.total_net
    OR v_adv+v_other<>payroll.total_deductions OR v_adv<0 OR v_other<0
    OR payroll.total_gross<>round(payroll.total_gross,2)
  THEN RAISE EXCEPTION 'GL_PAYROLL_ITEMS_RECONCILIATION_FAILED' USING ERRCODE='22023'; END IF;
  IF NOT public.powerhub_payroll_advance_allocations_valid(p_tenant_id,p_site_id,payroll.id,payroll.period) THEN
    RAISE EXCEPTION 'GL_PAYROLL_ADVANCE_DISBURSEMENT_OR_ALLOCATION_INVALID' USING ERRCODE='23514';
  END IF;
  v_period:=payroll.period;
  v_lines:=jsonb_build_array(
    jsonb_build_object('code','5200','side','debit','amount',v_gross),
    jsonb_build_object('code','2400','side','credit','amount',v_net));
  IF v_adv>0 THEN v_lines:=v_lines||jsonb_build_array(
    jsonb_build_object('code','1700','side','credit','amount',v_adv)); END IF;
  IF v_other>0 THEN v_lines:=v_lines||jsonb_build_array(
    jsonb_build_object('code','2450','side','credit','amount',v_other)); END IF;
  v_payload:=jsonb_build_object('id',payroll.id,'period',payroll.period,
    'gross',v_gross,'net',v_net,'advance',v_adv,'other',v_other,
    'approvedBy',payroll.approved_by_user_id,'itemCount',v_count);
  v_policy:='payroll-accrued-gross-advance-deductions-v1';
 ELSIF p_source_type='payroll_payment' THEN
  SELECT * INTO payroll FROM public.payroll_runs WHERE id=p_source_id
    AND tenant_id=p_tenant_id AND site_id=p_site_id FOR SHARE;
  IF NOT FOUND OR payroll.status<>'paid'
     OR payroll.paid_at IS NULL OR payroll.paid_from_account_id IS NULL
     OR payroll.total_net<=0 OR payroll.total_net<>round(payroll.total_net,2)
     OR payroll.approved_by_user_id IS NULL
     OR payroll.created_by_user_id=payroll.approved_by_user_id
     OR NOT EXISTS (SELECT 1 FROM public.financial_gl_entries e
         WHERE e.tenant_id=p_tenant_id AND e.site_id=p_site_id
          AND e.source_type='payroll' AND e.source_id=payroll.id::text)
  THEN RAISE EXCEPTION 'GL_PAYROLL_PAYOUT_ACCRUAL_NOT_POSTED'
    USING ERRCODE='22023'; END IF;
  SELECT count(*) INTO v_count FROM public.expenses e
    WHERE e.tenant_id=p_tenant_id AND e.site_id=p_site_id
      AND e.category='payroll' AND e.reference_no='PAYROLL-'||payroll.id;
  IF v_count<>1 THEN RAISE EXCEPTION 'GL_PAYROLL_PAYOUT_EXPENSE_MISSING'
    USING ERRCODE='22023'; END IF;
  SELECT * INTO exp FROM public.expenses e
    WHERE e.tenant_id=p_tenant_id AND e.site_id=p_site_id
      AND e.category='payroll' AND e.reference_no='PAYROLL-'||payroll.id
    FOR SHARE;
  IF exp.amount<>payroll.total_net OR exp.company_account_id<>payroll.paid_from_account_id
    THEN RAISE EXCEPTION 'GL_PAYROLL_PAYOUT_AMOUNT_MISMATCH'
      USING ERRCODE='22023'; END IF;
  SELECT count(*) INTO v_count FROM public.account_transactions tx
    WHERE tx.tenant_id=p_tenant_id AND tx.site_id=p_site_id
      AND tx.reference_no='PAYROLL-'||payroll.id;
  IF v_count<>1 THEN RAISE EXCEPTION 'GL_PAYROLL_PAYOUT_CASH_MOVEMENT_MISSING'
    USING ERRCODE='22023'; END IF;
  SELECT * INTO a FROM public.account_transactions tx
    WHERE tx.tenant_id=p_tenant_id AND tx.site_id=p_site_id
      AND tx.reference_no='PAYROLL-'||payroll.id FOR SHARE;
  IF a.related_expense_id<>exp.id OR a.transaction_type<>'withdrawal'
     OR a.amount<>payroll.total_net OR a.account_id<>payroll.paid_from_account_id
     OR (a.occurred_at AT TIME ZONE 'Asia/Gaza')::date<>(payroll.paid_at AT TIME ZONE 'Asia/Gaza')::date
  THEN RAISE EXCEPTION 'GL_PAYROLL_PAYOUT_CASH_MOVEMENT_MISMATCH'
      USING ERRCODE='22023'; END IF;
  SELECT * INTO ca FROM public.company_accounts
    WHERE id=a.account_id AND tenant_id=p_tenant_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'GL_PAYROLL_PAYOUT_ACCOUNT_UNKNOWN'
      USING ERRCODE='22023'; END IF;
  v_cash_account:=CASE WHEN ca.account_type='cash' THEN '1010' ELSE '1020' END;
  v_period:=to_char(payroll.paid_at AT TIME ZONE 'Asia/Gaza','YYYY-MM');
  v_lines:=jsonb_build_array(
   jsonb_build_object('code','2400','side','debit','amount',payroll.total_net),
   jsonb_build_object('code',v_cash_account,'side','credit','amount',payroll.total_net));
  v_payload:=jsonb_build_object('payrollRunId',payroll.id,'paidAt',payroll.paid_at,
    'net',payroll.total_net,'approvedBy',payroll.approved_by_user_id,
    'expenseId',exp.id,'movementId',a.id,'cashAccount',a.account_id,
    'cashAccountType',ca.account_type);
  v_policy:='payroll-settlement-no-second-wage-expense-v1';
 END IF;
 IF v_lines IS NULL OR jsonb_typeof(v_lines)<>'array' OR jsonb_array_length(v_lines)<2
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_lines) item
       WHERE (item->>'amount')::numeric<=0
          OR (item->>'amount')::numeric<>round((item->>'amount')::numeric,2))
    OR (SELECT sum(CASE WHEN item->>'side'='debit' THEN (item->>'amount')::numeric
                   ELSE -(item->>'amount')::numeric END)
        FROM jsonb_array_elements(v_lines) item)<>0
 THEN RAISE EXCEPTION 'GL_SOURCE_PLAN_NOT_BALANCED' USING ERRCODE='23514'; END IF;
 RETURN jsonb_build_object('tenantId',p_tenant_id,'siteId',p_site_id,
    'sourceType',p_source_type,'sourceId',p_source_id,'period',v_period,
    'policyVersion',v_policy,'lines',v_lines,'reversesEntryId',v_reversal_id,
    'sourceFingerprint',encode(sha256(convert_to(v_payload::text,'UTF8')),'hex'),
    'accountingCertification','NOT_CERTIFIED');
END;
$function$;


-- B4.16: independent reversal source provenance for supplier payment.
CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_reversal_source_proof(p_tenant_id bigint, p_site_id bigint, p_original_id bigint, p_reversal_id bigint)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
 o public.financial_gl_entries%ROWTYPE;
 r public.financial_gl_entries%ROWTYPE;
 a public.financial_accrual_journals%ROWTYPE;
 b public.financial_accrual_journals%ROWTYPE;
 n_original integer; n_reversal integer; n_linked integer; has_diff boolean;
 sha_original text; sha_reversal text;
 v_supplier_payment_id bigint;
BEGIN
 IF p_tenant_id IS NULL OR p_tenant_id<=0 OR p_site_id IS NULL OR p_site_id<=0
    OR p_original_id IS NULL OR p_original_id<=0 OR p_reversal_id IS NULL
    OR p_reversal_id<=0 OR p_original_id=p_reversal_id
 THEN RETURN 'BLOCKED_INTEGRITY'; END IF;
 SELECT * INTO o FROM public.financial_gl_entries
   WHERE tenant_id=p_tenant_id AND site_id=p_site_id AND id=p_original_id;
 SELECT * INTO r FROM public.financial_gl_entries
   WHERE tenant_id=p_tenant_id AND site_id=p_site_id AND id=p_reversal_id;
 IF o.id IS NULL OR r.id IS NULL OR r.reverses_entry_id IS DISTINCT FROM o.id
   OR o.reverses_entry_id IS NOT NULL OR r.period<o.period
   OR o.source_fingerprint !~ '^[0-9a-f]{64}$'
   OR r.source_fingerprint !~ '^[0-9a-f]{64}$'
   OR o.posted_at IS NULL OR r.posted_at IS NULL
 THEN RETURN 'BLOCKED_INTEGRITY'; END IF;
 SELECT count(*) INTO n_linked FROM public.financial_gl_entries
   WHERE tenant_id=p_tenant_id AND site_id=p_site_id AND reverses_entry_id=o.id;
 IF n_linked<>1 THEN RETURN 'BLOCKED_INTEGRITY'; END IF;
 SELECT count(*) INTO n_original FROM public.financial_gl_lines
   WHERE tenant_id=p_tenant_id AND site_id=p_site_id AND entry_id=o.id;
 SELECT count(*) INTO n_reversal FROM public.financial_gl_lines
   WHERE tenant_id=p_tenant_id AND site_id=p_site_id AND entry_id=r.id;
 IF n_original<2 OR n_original<>n_reversal THEN RETURN 'BLOCKED_INTEGRITY'; END IF;
 WITH original_group AS (
   SELECT account_code,side,amount,count(*) AS n
   FROM public.financial_gl_lines
   WHERE tenant_id=p_tenant_id AND site_id=p_site_id AND entry_id=o.id
   GROUP BY account_code,side,amount
 ), inverse_group AS (
   SELECT account_code,
     CASE side WHEN 'debit' THEN 'credit' ELSE 'debit' END AS side,
     amount,count(*) AS n
   FROM public.financial_gl_lines
   WHERE tenant_id=p_tenant_id AND site_id=p_site_id AND entry_id=r.id
   GROUP BY account_code,side,amount
 )
 SELECT EXISTS (
   SELECT 1 FROM (
     (SELECT account_code,side,amount,n FROM original_group
      EXCEPT SELECT account_code,side,amount,n FROM inverse_group)
     UNION ALL
     (SELECT account_code,side,amount,n FROM inverse_group
      EXCEPT SELECT account_code,side,amount,n FROM original_group)
   ) differences
 ) INTO has_diff;
 IF has_diff OR EXISTS (
    SELECT 1 FROM public.financial_gl_lines
    WHERE entry_id IN (o.id,r.id) AND tenant_id=p_tenant_id
      AND site_id=p_site_id AND (amount<=0 OR side NOT IN ('debit','credit'))
 ) THEN RETURN 'BLOCKED_INTEGRITY'; END IF;
 IF o.source_type='accrual_adjustment' OR r.source_type='accrual_adjustment' THEN
   IF o.source_type<>'accrual_adjustment'
      OR r.source_type<>'accrual_adjustment'
      OR o.accounting_policy_version<>'accrual-approved-subledger-v1'
      OR r.accounting_policy_version<>'accrual-approved-subledger-v1'
   THEN RETURN 'BLOCKED_INTEGRITY'; END IF;
   SELECT * INTO a FROM public.financial_accrual_journals
     WHERE tenant_id=p_tenant_id AND site_id=p_site_id
       AND id::text=o.source_id;
   SELECT * INTO b FROM public.financial_accrual_journals
     WHERE tenant_id=p_tenant_id AND site_id=p_site_id
       AND id::text=r.source_id;
   IF a.id IS NULL OR b.id IS NULL
     OR a.status<>'posted' OR b.status<>'posted'
     OR a.reverses_journal_id IS NOT NULL
     OR b.reverses_journal_id IS DISTINCT FROM a.id
     OR a.period<>o.period OR b.period<>r.period
     OR a.amount<=0 OR b.amount<>a.amount
     OR a.amount<>round(a.amount,2)
     OR b.amount<>round(b.amount,2)
     OR a.debit_account<>b.credit_account
     OR a.credit_account<>b.debit_account
     OR a.approved_by_user_id IS NULL OR b.approved_by_user_id IS NULL
     OR a.created_by_user_id=a.approved_by_user_id
     OR b.created_by_user_id=b.approved_by_user_id
     OR a.approved_at IS NULL OR b.approved_at IS NULL
     OR o.posted_by_user_id IS DISTINCT FROM a.approved_by_user_id
     OR r.posted_by_user_id IS DISTINCT FROM b.approved_by_user_id
   THEN RETURN 'BLOCKED_INTEGRITY'; END IF;
   -- Source fingerprint alone cannot certify posted GL lines: both original and
   -- reversal must agree with their own independently approved accrual journal.
   IF n_original<>2 OR n_reversal<>2
      OR a.debit_account=a.credit_account OR b.debit_account=b.credit_account
      OR NOT EXISTS (
        SELECT 1 FROM public.financial_gl_lines l WHERE l.tenant_id=p_tenant_id
          AND l.site_id=p_site_id AND l.entry_id=o.id
          AND l.account_code=a.debit_account AND l.side='debit' AND l.amount=a.amount)
      OR NOT EXISTS (
        SELECT 1 FROM public.financial_gl_lines l WHERE l.tenant_id=p_tenant_id
          AND l.site_id=p_site_id AND l.entry_id=o.id
          AND l.account_code=a.credit_account AND l.side='credit' AND l.amount=a.amount)
      OR NOT EXISTS (
        SELECT 1 FROM public.financial_gl_lines l WHERE l.tenant_id=p_tenant_id
          AND l.site_id=p_site_id AND l.entry_id=r.id
          AND l.account_code=b.debit_account AND l.side='debit' AND l.amount=b.amount)
      OR NOT EXISTS (
        SELECT 1 FROM public.financial_gl_lines l WHERE l.tenant_id=p_tenant_id
          AND l.site_id=p_site_id AND l.entry_id=r.id
          AND l.account_code=b.credit_account AND l.side='credit' AND l.amount=b.amount)
   THEN RETURN 'BLOCKED_INTEGRITY'; END IF;
   sha_original:=encode(sha256(convert_to(jsonb_build_object(
     'tenantId',a.tenant_id,'siteId',a.site_id,'journalId',a.id,
     'period',a.period,'debit',a.debit_account,'credit',a.credit_account,
     'amount',a.amount,'reason',a.reason,'createdBy',a.created_by_user_id,
     'approvedBy',a.approved_by_user_id,'approvedAt',a.approved_at,
     'reverses',a.reverses_journal_id
   )::text,'UTF8')),'hex');
   sha_reversal:=encode(sha256(convert_to(jsonb_build_object(
     'tenantId',b.tenant_id,'siteId',b.site_id,'journalId',b.id,
     'period',b.period,'debit',b.debit_account,'credit',b.credit_account,
     'amount',b.amount,'reason',b.reason,'createdBy',b.created_by_user_id,
     'approvedBy',b.approved_by_user_id,'approvedAt',b.approved_at,
     'reverses',b.reverses_journal_id
   )::text,'UTF8')),'hex');
   IF sha_original IS DISTINCT FROM o.source_fingerprint
      OR sha_reversal IS DISTINCT FROM r.source_fingerprint
   THEN RETURN 'BLOCKED_INTEGRITY'; END IF;
   RETURN 'SOURCE_BACKED_REVERSAL_VALID';
 END IF;
 IF o.source_type='supplier_ledger' OR r.source_type='supplier_ledger' THEN
   IF o.source_type<>'supplier_ledger' OR r.source_type<>'supplier_ledger'
     OR o.source_id !~ '^[0-9]+$'
     OR r.source_id !~ '^[0-9]+$'
     OR NOT EXISTS(SELECT 1 FROM public.supplier_ledger_entries sl
       WHERE sl.tenant_id=p_tenant_id AND sl.site_id=p_site_id
       AND sl.id::text=o.source_id AND sl.entry_type='payment')
   THEN RETURN 'BLOCKED_INTEGRITY'; END IF;
   SELECT sl.supplier_payment_id INTO v_supplier_payment_id
   FROM public.supplier_ledger_entries sl
   WHERE sl.tenant_id=p_tenant_id AND sl.site_id=p_site_id
     AND sl.id::text=r.source_id AND sl.entry_type='reversal';
   IF v_supplier_payment_id IS NULL OR
     public.powerhub_financial_supplier_payment_correction_proof(
       p_tenant_id,p_site_id,v_supplier_payment_id)<>'SOURCE_BACKED_REVERSAL_VALID'
   THEN RETURN 'BLOCKED_INTEGRITY';END IF;
   RETURN 'SOURCE_BACKED_REVERSAL_VALID';
 END IF;
 RETURN 'GL_INVERSE_ONLY_SOURCE_UNATTESTED';
END;
$function$;

-- B4.16: only verified approved supplier refunds reduce otherwise unclassified cash counts.
CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_source_coverage_raw(p_tenant_id bigint, p_site_id bigint, p_period text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
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
 v_supplier_verified_refunds bigint:=0;
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
 -- B4.16: one compensating deposit is classifiable only with an independently
 -- reviewed supplier correction and a verified source-linked inverse GL.
 SELECT count(*) INTO v_supplier_verified_refunds
 FROM public.account_transactions t
 JOIN public.financial_supplier_payment_corrections c
   ON c.tenant_id=t.tenant_id AND c.site_id=t.site_id
   AND c.refund_transaction_id=t.id AND c.status='posted'
 WHERE t.tenant_id=p_tenant_id AND t.site_id=p_site_id
   AND t.occurred_at>=v_start AND t.occurred_at<v_end
   AND t.related_payment_id IS NULL AND t.related_expense_id IS NULL
   AND t.related_supplier_payment_id IS NULL
   AND t.related_supplier_return_id IS NULL AND t.related_account_id IS NULL
   AND public.powerhub_financial_supplier_payment_correction_proof(
     c.tenant_id,c.site_id,c.payment_id)='SOURCE_BACKED_REVERSAL_VALID';
 IF v_supplier_verified_refunds>v_cash_unclassified THEN
   RAISE EXCEPTION 'B416_VERIFIED_REFUND_CLASSIFICATION_EXCEEDS_UNLINKED'
   USING ERRCODE='23514';END IF;
 v_cash_unclassified:=v_cash_unclassified-v_supplier_verified_refunds;

 SELECT count(*),count(*) FILTER (WHERE z.net<>0
  OR (z.cnt<2 AND NOT(z.cnt=0 AND z.source_type='opening_balance'
   AND z.accounting_policy_version='documented-zero-opening-v1'
   AND EXISTS(SELECT 1 FROM public.financial_gl_opening_batches b
     WHERE b.tenant_id=p_tenant_id AND b.site_id=p_site_id
       AND b.id::text=z.source_id AND b.status='posted'
       AND b.expected_line_count=0)))),
        COALESCE(sum(z.net),0)
 INTO v_gl_total,v_gl_broken,v_gl_balance
 FROM (
   SELECT e.id,e.source_type,e.source_id,e.accounting_policy_version,count(l.id) cnt,
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
$function$;
