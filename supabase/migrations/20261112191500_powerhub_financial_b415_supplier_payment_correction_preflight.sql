-- B4.15: source-specific supplier-payment GL correction preflight.
-- READ ONLY. No payment reversal, no cash deposit, no GL posting or approval.
-- The existing B4.14.1 fail-closed guard stays mandatory.
CREATE OR REPLACE FUNCTION public.powerhub_financial_supplier_payment_correction_readiness(
 p_tenant_id bigint,p_site_id bigint,p_payment_id bigint
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $readiness$
DECLARE
 p public.supplier_payments%ROWTYPE;
 sl public.supplier_ledger_entries%ROWTYPE;
 g public.financial_gl_entries%ROWTYPE;
 ca public.company_accounts%ROWTYPE;
 tx public.account_transactions%ROWTYPE;
 v_plan jsonb;
 v_reason text:='UNVERIFIED_SOURCE';
 v_ready boolean:=false;
 v_count bigint;v_sum numeric;v_debit bigint;v_credit bigint;
 v_cash_code text;v_period text;v_has_locked_period boolean;
BEGIN
 IF p_tenant_id IS NULL OR p_tenant_id<=0 OR p_site_id IS NULL OR p_site_id<=0
  OR p_payment_id IS NULL OR p_payment_id<=0 OR
  NOT EXISTS(SELECT 1 FROM public.sites s WHERE s.tenant_id=p_tenant_id
    AND s.id=p_site_id AND s.status<>'archived')
 THEN RAISE EXCEPTION 'B415_SUPPLIER_CORRECTION_SCOPE_INVALID' USING ERRCODE='22023'; END IF;
 SELECT * INTO p FROM public.supplier_payments
 WHERE tenant_id=p_tenant_id AND site_id=p_site_id AND id=p_payment_id;
 IF p.id IS NULL THEN
   v_reason:='SUPPLIER_PAYMENT_NOT_FOUND';
 ELSIF p.status<>'posted' THEN
   v_reason:='SUPPLIER_PAYMENT_NOT_POSTED';
 ELSIF p.amount<=0 OR p.amount<>round(p.amount,2) THEN
   v_reason:='SUPPLIER_PAYMENT_AMOUNT_INVALID';
 ELSE
   SELECT count(*),coalesce(sum(a.amount),0)
   INTO v_count,v_sum FROM public.supplier_payment_allocations a
   WHERE a.tenant_id=p_tenant_id AND a.payment_id=p.id;
   IF v_count<1 OR v_sum<>p.amount THEN
     v_reason:='SUPPLIER_PAYMENT_ALLOCATION_MISMATCH';
   ELSIF EXISTS(
     SELECT 1 FROM public.supplier_payment_allocations a
     JOIN public.supplier_purchases purchase ON purchase.tenant_id=a.tenant_id
       AND purchase.id=a.purchase_id
     WHERE a.tenant_id=p_tenant_id AND a.payment_id=p.id
       AND (purchase.site_id<>p_site_id OR purchase.supplier_id<>p.supplier_id)
   ) THEN
     v_reason:='SUPPLIER_PAYMENT_PURCHASE_SCOPE_MISMATCH';
   ELSE
     SELECT count(*) INTO v_count
     FROM public.supplier_ledger_entries x
     WHERE x.tenant_id=p_tenant_id AND x.site_id=p_site_id
      AND x.supplier_payment_id=p.id AND x.entry_type='payment';
     IF v_count<>1 THEN
       v_reason:='SUPPLIER_PAYMENT_LEDGER_SOURCE_COUNT_MISMATCH';
     ELSE
       SELECT * INTO sl FROM public.supplier_ledger_entries x
       WHERE x.tenant_id=p_tenant_id AND x.site_id=p_site_id
        AND x.supplier_payment_id=p.id AND x.entry_type='payment';
       SELECT * INTO ca FROM public.company_accounts x
       WHERE x.tenant_id=p_tenant_id AND x.id=p.company_account_id;
       SELECT * INTO tx FROM public.account_transactions x
       WHERE x.tenant_id=p_tenant_id AND x.id=p.account_transaction_id;
       IF sl.supplier_id<>p.supplier_id OR sl.debit_amount<>p.amount OR sl.credit_amount<>0
         OR sl.entry_key<>'supplier-payment:'||p.id
         OR ca.id IS NULL OR tx.id IS NULL
         OR tx.account_id<>p.company_account_id
         OR tx.related_supplier_payment_id IS DISTINCT FROM p.id
         OR tx.transaction_type<>'withdrawal' OR tx.amount<>p.amount
         OR tx.site_id IS DISTINCT FROM p_site_id
       THEN v_reason:='SUPPLIER_PAYMENT_CASH_OR_SUBLEDGER_MISMATCH';
       ELSE
         v_cash_code:=CASE WHEN ca.account_type='cash' THEN '1010' ELSE '1020' END;
         SELECT count(*) INTO v_count FROM public.financial_gl_entries x
         WHERE x.tenant_id=p_tenant_id AND x.site_id=p_site_id
           AND x.source_type='supplier_ledger' AND x.source_id=sl.id::text
           AND x.source_revision=1;
         IF v_count<>1 THEN
           v_reason:='SUPPLIER_PAYMENT_ORIGINAL_GL_NOT_UNIQUE';
         ELSE
           SELECT * INTO g FROM public.financial_gl_entries x
           WHERE x.tenant_id=p_tenant_id AND x.site_id=p_site_id
             AND x.source_type='supplier_ledger' AND x.source_id=sl.id::text
             AND x.source_revision=1;
           SELECT count(*) FILTER(WHERE l.account_code='2300' AND l.side='debit'
               AND l.amount=p.amount),
             count(*) FILTER(WHERE l.account_code=v_cash_code AND l.side='credit'
               AND l.amount=p.amount),
             count(*) INTO v_debit,v_credit,v_count
           FROM public.financial_gl_lines l WHERE l.entry_id=g.id
             AND l.tenant_id=p_tenant_id AND l.site_id=p_site_id;
           IF g.reverses_entry_id IS NOT NULL
             OR g.accounting_policy_version<>'supplier-event-no-stock-duplication-v1'
             OR v_count<>2 OR v_debit<>1 OR v_credit<>1
           THEN v_reason:='SUPPLIER_PAYMENT_ORIGINAL_GL_LINES_INVALID';
           ELSIF EXISTS(SELECT 1 FROM public.financial_gl_entries x
             WHERE x.tenant_id=p_tenant_id AND x.site_id=p_site_id
               AND x.reverses_entry_id=g.id)
           THEN v_reason:='SUPPLIER_PAYMENT_GL_ALREADY_REVERSED';
           ELSE
             BEGIN
               v_plan:=public.powerhub_financial_gl_source_plan(
                 p_tenant_id,p_site_id,'supplier_ledger',sl.id);
               IF g.source_fingerprint IS DISTINCT FROM v_plan->>'sourceFingerprint'
                 OR g.period IS DISTINCT FROM v_plan->>'period'
                 OR g.operation_key IS DISTINCT FROM 'gl:source:supplier_ledger:'||sl.id||':v1'
                 OR g.accounting_policy_version IS DISTINCT FROM v_plan->>'policyVersion'
               THEN v_reason:='SUPPLIER_PAYMENT_GL_FINGERPRINT_CHANGED';
               ELSE
                 v_period:=to_char(clock_timestamp() AT TIME ZONE 'Asia/Gaza','YYYY-MM');
                 SELECT EXISTS(
                  SELECT 1 FROM public.financial_settlements fs
                  WHERE fs.tenant_id=p_tenant_id AND fs.site_id=p_site_id
                   AND fs.status='locked' AND fs.period_start<=clock_timestamp()
                   AND fs.period_end>=clock_timestamp()
                 ) OR EXISTS(
                  SELECT 1 FROM public.financial_accrual_period_reviews ar
                  WHERE ar.tenant_id=p_tenant_id AND ar.site_id=p_site_id
                    AND ar.period=v_period AND ar.status='locked'
                 ) INTO v_has_locked_period;
                 IF g.period>v_period OR v_has_locked_period THEN
                   v_reason:='SUPPLIER_PAYMENT_CORRECTION_PERIOD_LOCKED';
                 ELSE
                   v_reason:='SOURCE_VERIFIED_WORKFLOW_NOT_IMPLEMENTED';
                   v_ready:=true;
                 END IF;
               END IF;
             EXCEPTION WHEN OTHERS THEN
               v_reason:='SUPPLIER_PAYMENT_SOURCE_PLAN_UNVERIFIABLE';
               v_ready:=false;
             END;
           END IF;
         END IF;
       END IF;
     END IF;
   END IF;
 END IF;
 RETURN jsonb_build_object(
   'tenantId',p_tenant_id,'siteId',p_site_id,'paymentId',p_payment_id,
   'supplierLedgerEntryId',sl.id,
   'originalGLEntryId',g.id,
   'originalGLFingerprint',CASE WHEN v_ready THEN g.source_fingerprint ELSE NULL END,
   'originalGLEntryPeriod',g.period,
   'paymentAmount',CASE WHEN p.id IS NOT NULL THEN p.amount ELSE NULL END,
   'sourceEvidenceVerified',v_ready,
   'status',v_reason,
   'canReverseGLDirectly',false,
   'canPostCorrection',false,
   'makerCheckerRequired',true,
   'requiresDocumentedCashRefund',true,
   'correctionWorkflowImplemented',false,
   'accountingCertification','NOT_CERTIFIED');
END;
$readiness$;
REVOKE ALL ON FUNCTION public.powerhub_financial_supplier_payment_correction_readiness(bigint,bigint,bigint)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_supplier_payment_correction_readiness(bigint,bigint,bigint)
 TO service_role;
COMMENT ON FUNCTION public.powerhub_financial_supplier_payment_correction_readiness(bigint,bigint,bigint) IS
 'B4.15 read-only supplier-payment source/GL integrity preflight; NOT a reversal or approval path.';
NOTIFY pgrst,'reload schema';
