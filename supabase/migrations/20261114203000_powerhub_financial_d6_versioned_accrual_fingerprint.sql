-- PowerHub Phase D6: versioned accrual fingerprints; exact-version protected release only.
-- Old LOCKED reviews must keep their original digest and historical algorithm.
-- Do not rewrite source_fingerprint/locked_snapshot of any locked review.
-- D3/D4/D5 source-write locks stay intact; v3 detects financial field drift
-- without treating cash-only deposits, invoice collection progress, or metadata
-- changes as modifications to recognized monthly accruals.

ALTER TABLE public.financial_accrual_period_reviews
  ADD COLUMN fingerprint_version text NOT NULL DEFAULT 'legacy_v2';
-- This is a metadata-only default backfill: no UPDATE of immutable locked rows.
ALTER TABLE public.financial_accrual_period_reviews
  ALTER COLUMN fingerprint_version SET DEFAULT 'financial_v3';
ALTER TABLE public.financial_accrual_period_reviews
  ADD CONSTRAINT financial_accrual_fingerprint_version_ck
  CHECK (fingerprint_version IN ('legacy_v2','financial_v3'));
-- Draft reviews have no stored fingerprint and can safely use the new algorithm.
UPDATE public.financial_accrual_period_reviews
 SET fingerprint_version='financial_v3' WHERE status='draft';

CREATE OR REPLACE FUNCTION public.powerhub_financial_accrual_detail_fingerprint_v3(
 p_tenant_id bigint,p_site_id bigint,p_period text
) RETURNS text LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $fp_v3$
DECLARE
 v_first date;
 v_start timestamptz;
 v_end timestamptz;
 v_acc text:='powerhub-financial-accrual-v3';
 v_row record;
BEGIN
 IF p_tenant_id IS NULL OR p_tenant_id<=0 OR p_site_id IS NULL OR p_site_id<=0
    OR p_period IS NULL OR p_period !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
 THEN RAISE EXCEPTION 'INVALID_ACCRUAL_FINGERPRINT_V3_SCOPE' USING ERRCODE='22023';END IF;
 v_first:=(p_period||'-01')::date;
 v_start:=v_first::timestamp AT TIME ZONE 'Asia/Gaza';
 v_end:=(v_first+INTERVAL '1 month')::timestamp AT TIME ZONE 'Asia/Gaza';

 -- Every checksum covers recognized financial fields, never entire mutable rows.
 -- Record identifiers are included in the running accumulator below.
 FOR v_row IN
  SELECT source_type,source_id,checksum FROM (
    SELECT '01-invoice'::text source_type,i.id::text source_id,
      md5(jsonb_build_array(i.tenant_id,i.site_id,i.subscriber_id,
        i.reading_id,i.tariff_id,i.cycle_key,i.cycle_start_at,i.cycle_end_at,
        i.issue_date,i.total_amount,i.tax_amount,i.discount_amount,i.fixed_fee,
        i.price_per_kwh,i.consumption_kwh,
        i.status IN ('issued','overdue','partially_paid','paid'))::text) checksum
    FROM public.invoices i
    WHERE i.tenant_id=p_tenant_id AND i.site_id=p_site_id
      AND ((i.cycle_start_at < v_end AND i.cycle_end_at >= v_start)
        OR (i.issue_date >= v_start AND i.issue_date < v_end))
    UNION ALL
    SELECT '02-billing-adjustment',a.id::text,
      md5(jsonb_build_array(a.tenant_id,a.site_id,a.subscriber_id,
        a.invoice_id,a.adjustment_type,a.amount,a.state,a.source_adjustment_id,
        a.source_invoice_id,a.applied_to_invoice_id,a.created_at)::text)
    FROM public.billing_adjustments a
    WHERE a.tenant_id=p_tenant_id AND a.site_id=p_site_id
      AND (a.created_at>=v_start AND a.created_at<v_end OR EXISTS(
        SELECT 1 FROM public.invoices i WHERE i.tenant_id=a.tenant_id
         AND i.site_id=a.site_id AND i.id=a.invoice_id
         AND i.cycle_start_at<v_end AND i.cycle_end_at>=v_start))
    UNION ALL
    SELECT '03-expense',e.id::text,
      md5(jsonb_build_array(e.tenant_id,e.site_id,e.generator_id,e.category,
        e.amount,e.occurred_at,e.expense_classification,e.company_account_id,
        e.reference_no)::text)
    FROM public.expenses e
    WHERE e.tenant_id=p_tenant_id AND e.site_id=p_site_id
      AND e.occurred_at>=v_start AND e.occurred_at<v_end
    UNION ALL
    SELECT '04-payroll',p.id::text,
      md5(jsonb_build_array(p.tenant_id,p.site_id,p.period,p.status,
        p.total_gross,p.total_deductions,p.total_net,p.paid_from_account_id,
        p.approved_by_user_id,p.paid_at)::text)
    FROM public.payroll_runs p
    WHERE p.tenant_id=p_tenant_id AND p.site_id=p_site_id AND p.period=p_period
    UNION ALL
    SELECT '04b-payroll-item',pi.id::text,
      md5(jsonb_build_array(pi.payroll_run_id,pi.employee_id,pi.base_amount,
        pi.extra_amount,pi.advance_deduction,pi.other_deduction,pi.net_amount)::text)
    FROM public.payroll_runs p
    JOIN public.payroll_items pi ON pi.payroll_run_id=p.id
    WHERE p.tenant_id=p_tenant_id AND p.site_id=p_site_id AND p.period=p_period
    UNION ALL
    SELECT '05-stock-movement',m.id::text,
      md5(jsonb_build_array(m.tenant_id,m.site_id,m.item_id,m.warehouse_id,
        m.generator_id,m.movement_type,m.quantity,m.unit_cost,m.total_cost_amount,
        m.occurred_at,m.reversal_of_movement_id,m.corrects_movement_id,
        m.source_issue_movement_id,m.purchase_id,m.purchase_line_id,
        m.operation_key)::text)
    FROM public.inventory_stock_movements m
    WHERE m.tenant_id=p_tenant_id AND m.site_id=p_site_id
      AND m.occurred_at>=v_start AND m.occurred_at<v_end
    UNION ALL
    SELECT '06-inventory-item',i.id::text,
      md5(jsonb_build_array(i.tenant_id,i.category,i.accounting_treatment,
        i.base_unit)::text)
    FROM public.inventory_items i
    WHERE i.tenant_id=p_tenant_id AND EXISTS(
      SELECT 1 FROM public.inventory_stock_movements m
      WHERE m.tenant_id=i.tenant_id AND m.site_id=p_site_id AND m.item_id=i.id
        AND m.occurred_at>=v_start AND m.occurred_at<v_end)
    UNION ALL
    SELECT '07-purchase',p.id::text,
      md5(jsonb_build_array(p.tenant_id,p.site_id,p.supplier_id,p.warehouse_id,
        p.invoice_date,p.status,p.subtotal_amount,p.discount_amount,p.tax_amount,
        p.other_charges_amount,p.total_amount,p.payment_mode,p.received_at,
        p.confirmed_at,p.cancelled_at,p.supplier_invoice_no)::text)
    FROM public.supplier_purchases p
    WHERE p.tenant_id=p_tenant_id AND p.site_id=p_site_id
      AND p.invoice_date BETWEEN v_first AND ((v_first+INTERVAL '1 month')::date-1)
    UNION ALL
    -- Only ledger-linked payroll cash belongs to this month's payroll
    -- reconciliation. Unrelated collections, deposits and supplier payments do not.
    SELECT '08-payroll-account-transaction',t.id::text,
      md5(jsonb_build_array(t.tenant_id,t.site_id,t.account_id,
        t.transaction_type,t.amount,t.related_expense_id,t.reference_no)::text)
    FROM public.payroll_runs p
    JOIN public.account_transactions t
      ON t.tenant_id=p.tenant_id AND t.site_id=p.site_id
     AND t.reference_no=('PAYROLL-'||p.id::text)
     AND t.transaction_type='withdrawal'
    WHERE p.tenant_id=p_tenant_id AND p.site_id=p_site_id AND p.period=p_period
    UNION ALL
    -- Cash settlement presence and date overlap appear in the monthly
    -- statement. Exclude mutable reconciliation notes and cash-only totals.
    SELECT '09-cash-settlement-presence',s.id::text,
      md5(jsonb_build_array(s.tenant_id,s.site_id,s.period_start,s.period_end)::text)
    FROM public.financial_settlements s
    WHERE s.tenant_id=p_tenant_id AND s.site_id=p_site_id
      AND s.period_start<v_end AND s.period_end>=v_start
    UNION ALL
    SELECT '10-accrual-journal',j.id::text,
      md5(jsonb_build_array(j.tenant_id,j.site_id,j.period,j.debit_account,
        j.credit_account,j.amount,j.operation_key,j.status,
        j.reverses_journal_id,j.created_by_user_id,j.approved_by_user_id)::text)
    FROM public.financial_accrual_journals j
    WHERE j.tenant_id=p_tenant_id AND j.site_id=p_site_id AND j.period=p_period
    UNION ALL
    -- Payroll integrity compares these reference-linked expenses even when
    -- the associated cash payout is dated in a different calendar month.
    SELECT '11-payroll-linked-expense',e.id::text,
      md5(jsonb_build_array(e.tenant_id,e.site_id,e.category,e.amount,
        e.company_account_id,e.reference_no)::text)
    FROM public.payroll_runs p
    JOIN public.expenses e ON e.tenant_id=p.tenant_id AND e.site_id=p.site_id
      AND e.category='payroll' AND e.reference_no=('PAYROLL-'||p.id::text)
    WHERE p.tenant_id=p_tenant_id AND p.site_id=p_site_id AND p.period=p_period
  ) sources ORDER BY source_type,source_id
 LOOP
  v_acc:=md5(v_acc||':'||v_row.source_type||':'||v_row.source_id||':'||v_row.checksum);
 END LOOP;
 RETURN v_acc;
END
$fp_v3$;

CREATE OR REPLACE FUNCTION public.powerhub_financial_accrual_period_lock(p_tenant_id bigint, p_site_id bigint, p_period text, p_user_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
 v_review public.financial_accrual_period_reviews%ROWTYPE;
 v_snapshot jsonb;
 v_fingerprint text;
 v_month_end date;
 v_key text;
BEGIN
 IF p_tenant_id IS NULL OR p_tenant_id<=0 OR p_site_id IS NULL OR p_site_id<=0
    OR p_user_id IS NULL OR p_user_id<=0
    OR p_period IS NULL OR p_period !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
    OR NOT EXISTS(SELECT 1 FROM public.sites s WHERE s.tenant_id=p_tenant_id
                  AND s.id=p_site_id AND s.status<>'archived') THEN
  RAISE EXCEPTION 'INVALID_ACCRUAL_CLOSE_SCOPE' USING ERRCODE='22023';
 END IF;
 -- Serialize the close against journal INSERT/UPDATE/VOID and the monthly snapshot.
 PERFORM pg_advisory_xact_lock(hashtextextended(
    'powerhub:accrual-period:'||p_tenant_id||':'||p_site_id||':'||p_period,0));
 SELECT * INTO v_review FROM public.financial_accrual_period_reviews
 WHERE tenant_id=p_tenant_id AND site_id=p_site_id AND period=p_period FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'MISSING_PERIOD_REVIEW' USING ERRCODE='22023'; END IF;
 IF v_review.status='locked' THEN
   IF v_review.locked_by_user_id=p_user_id THEN
    RETURN jsonb_build_object('status','locked','alreadyLocked',true,'id',v_review.id);
   END IF;
   RAISE EXCEPTION 'PERIOD_ALREADY_LOCKED' USING ERRCODE='22023';
 END IF;
 IF v_review.status IS DISTINCT FROM 'draft' THEN
  RAISE EXCEPTION 'INVALID_ACCRUAL_REVIEW_STATE' USING ERRCODE='22023'; END IF;
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
    (v_snapshot->>'unreconciledPayrollPayoutCount')::bigint<>0 OR
    (v_snapshot->'journalAdjustments'->>'draftCount')::bigint<>0 THEN
  RAISE EXCEPTION 'ACCRUAL_SOURCES_NOT_RECONCILED' USING ERRCODE='22023';
 END IF;
 -- C4: fail closed at the database writer, not only in the React readiness screen.
 IF jsonb_typeof(v_snapshot) IS DISTINCT FROM 'object'
    OR (v_snapshot->>'scopeTenantId')::bigint IS DISTINCT FROM p_tenant_id
    OR (v_snapshot->>'scopeSiteId')::bigint IS DISTINCT FROM p_site_id
    OR v_snapshot->>'period' IS DISTINCT FROM p_period
    OR (v_snapshot->>'isFinalProfit')::boolean IS DISTINCT FROM false
    OR (v_snapshot->>'isCompleteAccrualStatement')::boolean IS DISTINCT FROM false
 THEN RAISE EXCEPTION 'ACCRUAL_CLOSE_SOURCE_SCOPE_OR_FINALITY' USING ERRCODE='22023'; END IF;
 IF NOT public.powerhub_financial_accrual_review_evidence_valid(v_review.evidence) THEN
  RAISE EXCEPTION 'ACCRUAL_CLOSE_EVIDENCE_INCOMPLETE' USING ERRCODE='22023';
 END IF;
 FOR v_key IN SELECT unnest(ARRAY[
  'missingCycleCount','uncompletedInvoiceCount','unclassifiedInventoryIssueCount',
  'draftPayrollCount','unreconciledPayrollPayoutCount','invalidInvoiceCount',
  'invalidExpenseCount','invalidPayrollCount','invalidInventoryCount',
  'crossPeriodInvoiceCount','issuedOutsideServiceMonthCount'
 ]) LOOP
  IF jsonb_typeof(v_snapshot->v_key) IS DISTINCT FROM 'number'
     OR (v_snapshot->>v_key) !~ '^[0-9]+$'
     OR (v_snapshot->>v_key)::bigint IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'ACCRUAL_CLOSE_UNRESOLVED_SOURCE_%', v_key USING ERRCODE='22023';
  END IF;
 END LOOP;
 IF jsonb_typeof(v_snapshot->'journalAdjustments') IS DISTINCT FROM 'object'
    OR jsonb_typeof(v_snapshot->'journalAdjustments'->'draftCount') IS DISTINCT FROM 'number'
    OR (v_snapshot->'journalAdjustments'->>'draftCount') !~ '^[0-9]+$'
    OR (v_snapshot->'journalAdjustments'->>'draftCount')::bigint IS DISTINCT FROM 0
    OR jsonb_typeof(v_snapshot->'journalAdjustments'->'balancedDebits') IS DISTINCT FROM 'number'
    OR jsonb_typeof(v_snapshot->'journalAdjustments'->'balancedCredits') IS DISTINCT FROM 'number'
    OR (v_snapshot->'journalAdjustments'->>'balancedDebits')::numeric
       IS DISTINCT FROM (v_snapshot->'journalAdjustments'->>'balancedCredits')::numeric THEN
  RAISE EXCEPTION 'ACCRUAL_CLOSE_UNBALANCED_OR_DRAFT_JOURNAL' USING ERRCODE='22023';
 END IF;
 IF v_review.fingerprint_version IS DISTINCT FROM 'financial_v3' THEN
  RAISE EXCEPTION 'ACCRUAL_FINGERPRINT_VERSION_NOT_READY' USING ERRCODE='22023';
 END IF;
 v_fingerprint:=md5((v_snapshot-'asOf')::text || ':' ||
    public.powerhub_financial_accrual_detail_fingerprint_v3(p_tenant_id,p_site_id,p_period));
 UPDATE public.financial_accrual_period_reviews
 SET status='locked',locked_by_user_id=p_user_id,locked_at=now(),
     locked_snapshot=v_snapshot,source_fingerprint=v_fingerprint
 WHERE id=v_review.id;
 RETURN jsonb_build_object('status','locked','alreadyLocked',false,'id',v_review.id,
   'sourceFingerprint',v_fingerprint,
   'isCertifiedProfit',false);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.powerhub_financial_accrual_period_review_status(p_tenant_id bigint, p_site_id bigint, p_period text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
 v_review public.financial_accrual_period_reviews%ROWTYPE;
 v_current jsonb; v_changed boolean; v_detail text;
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
 IF v_review.fingerprint_version='legacy_v2' THEN
  v_detail:=public.powerhub_financial_accrual_detail_fingerprint(
    p_tenant_id,p_site_id,p_period);
 ELSIF v_review.fingerprint_version='financial_v3' THEN
  v_detail:=public.powerhub_financial_accrual_detail_fingerprint_v3(
    p_tenant_id,p_site_id,p_period);
 ELSE
  RAISE EXCEPTION 'ACCRUAL_UNKNOWN_FINGERPRINT_VERSION' USING ERRCODE='22023';
 END IF;
 v_changed:=md5((v_current-'asOf')::text || ':' || v_detail)
    IS DISTINCT FROM v_review.source_fingerprint;
 RETURN jsonb_build_object('status','locked','driftDetected',v_changed,
   'lockedByUserId',v_review.locked_by_user_id,'lockedAt',v_review.locked_at,
   'sourceFingerprint',v_review.source_fingerprint,
   'fingerprintVersion',v_review.fingerprint_version,
   'isCertifiedProfit',false,'lockedSnapshot',v_review.locked_snapshot);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.powerhub_financial_accrual_period_review_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
 IF TG_OP='DELETE' THEN
  RAISE EXCEPTION 'ACCRUAL_PERIOD_REVIEW_DELETE_DENIED' USING ERRCODE='22023';
 ELSIF TG_OP='INSERT' THEN
  IF NEW.fingerprint_version IS DISTINCT FROM 'financial_v3' THEN
   RAISE EXCEPTION 'ACCRUAL_NEW_REVIEW_REQUIRES_V3' USING ERRCODE='22023';END IF;
  IF NEW.status<>'draft' OR NEW.locked_by_user_id IS NOT NULL OR
    NEW.locked_at IS NOT NULL OR NEW.locked_snapshot IS NOT NULL OR
    NEW.source_fingerprint IS NOT NULL THEN
   RAISE EXCEPTION 'ACCRUAL_PERIOD_MUST_START_DRAFT' USING ERRCODE='22023';
  END IF;
 ELSIF TG_OP='UPDATE' THEN
  IF OLD.status<>'draft' OR
    NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR
    NEW.site_id IS DISTINCT FROM OLD.site_id OR
    NEW.period IS DISTINCT FROM OLD.period OR
    NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'ACCRUAL_PERIOD_REVIEW_IMMUTABLE' USING ERRCODE='22023';
  END IF;
  IF NEW.status='draft' THEN
   IF NEW.locked_by_user_id IS NOT NULL OR NEW.locked_at IS NOT NULL OR
     NEW.locked_snapshot IS NOT NULL OR NEW.source_fingerprint IS NOT NULL OR
     NOT public.powerhub_financial_accrual_review_evidence_valid(NEW.evidence) THEN
    RAISE EXCEPTION 'INVALID_ACCRUAL_REVIEW_UPDATE' USING ERRCODE='22023';
   END IF;
  ELSIF NEW.status='locked' THEN
   IF NEW.evidence IS DISTINCT FROM OLD.evidence OR
     NEW.prepared_by_user_id IS DISTINCT FROM OLD.prepared_by_user_id OR
     NEW.prepared_at IS DISTINCT FROM OLD.prepared_at OR
     NEW.locked_by_user_id IS NULL OR NEW.locked_by_user_id=OLD.prepared_by_user_id OR
     NEW.locked_at IS NULL OR NEW.locked_snapshot IS NULL OR
     NEW.fingerprint_version IS DISTINCT FROM OLD.fingerprint_version OR
     NEW.source_fingerprint IS NULL THEN
      RAISE EXCEPTION 'INVALID_ACCRUAL_REVIEW_LOCK' USING ERRCODE='22023';
   END IF;
  ELSE
   RAISE EXCEPTION 'INVALID_ACCRUAL_REVIEW_STATE' USING ERRCODE='22023';
  END IF;
 END IF;
 RETURN NEW;
END;
$function$
;

REVOKE ALL ON FUNCTION public.powerhub_financial_accrual_detail_fingerprint_v3(bigint,bigint,text)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_accrual_detail_fingerprint_v3(bigint,bigint,text)
 TO service_role;
COMMENT ON FUNCTION public.powerhub_financial_accrual_detail_fingerprint_v3(bigint,bigint,text)
 IS 'Version 3 accrual financial source digest. Historical locked reviews continue to use legacy_v2 without modifying their saved source fingerprints.';
COMMENT ON COLUMN public.financial_accrual_period_reviews.fingerprint_version
 IS 'legacy_v2 for pre-D6 locked snapshots; financial_v3 for new and previously unclosed draft reviews.';
NOTIFY pgrst,'reload schema';
