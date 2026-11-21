-- Source-detail checksum complements the aggregate snapshot.
-- Detects offsetting edits which keep a displayed monthly total unchanged.
-- Deliberately read-only and scoped to tenant/site/month.
CREATE OR REPLACE FUNCTION public.powerhub_financial_accrual_detail_fingerprint(
 p_tenant_id bigint,p_site_id bigint,p_period text
) RETURNS text
LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp
AS $detail$
DECLARE
 v_first date;
 v_start timestamptz;
 v_end timestamptz;
 v_acc text:='powerhub-financial-accrual-v2';
 v_row record;
BEGIN
 IF p_tenant_id IS NULL OR p_site_id IS NULL OR
    p_period IS NULL OR p_period !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
 THEN RAISE EXCEPTION 'INVALID_ACCRUAL_SOURCE_FINGERPRINT' USING ERRCODE='22023'; END IF;
 v_first:=(p_period||'-01')::date;
 v_start:=v_first::timestamp AT TIME ZONE 'Asia/Gaza';
 v_end:=(v_first+INTERVAL '1 month')::timestamp AT TIME ZONE 'Asia/Gaza';
 FOR v_row IN
  SELECT source_type,source_id,checksum FROM (
   SELECT '01-invoice'::text source_type, i.id::text source_id,md5(to_jsonb(i)::text) checksum
     FROM public.invoices i
     WHERE i.tenant_id=p_tenant_id AND i.site_id=p_site_id AND
       ((i.cycle_start_at < v_end AND i.cycle_end_at >= v_start) OR
        (i.issue_date >= v_start AND i.issue_date < v_end))
   UNION ALL
   SELECT '02-billing-adjustment',a.id::text,md5(to_jsonb(a)::text)
     FROM public.billing_adjustments a
     WHERE a.tenant_id=p_tenant_id AND a.site_id=p_site_id AND
       (a.created_at>=v_start AND a.created_at<v_end OR EXISTS(
         SELECT 1 FROM public.invoices i WHERE i.tenant_id=a.tenant_id
           AND i.site_id=a.site_id AND i.id=a.invoice_id AND
           i.cycle_start_at < v_end AND i.cycle_end_at >= v_start))
   UNION ALL
   SELECT '03-expense',e.id::text,md5(to_jsonb(e)::text)
     FROM public.expenses e
     WHERE e.tenant_id=p_tenant_id AND e.site_id=p_site_id
       AND e.occurred_at>=v_start AND e.occurred_at<v_end
   UNION ALL
   SELECT '04-payroll',p.id::text,md5(to_jsonb(p)::text)
     FROM public.payroll_runs p
     WHERE p.tenant_id=p_tenant_id AND p.site_id=p_site_id AND p.period=p_period
   UNION ALL
   SELECT '05-stock-movement',m.id::text,md5(to_jsonb(m)::text)
     FROM public.inventory_stock_movements m
     WHERE m.tenant_id=p_tenant_id AND m.site_id=p_site_id
       AND m.occurred_at>=v_start AND m.occurred_at<v_end
   UNION ALL
   SELECT '06-inventory-item',i.id::text,md5(to_jsonb(i)::text)
     FROM public.inventory_items i
     WHERE i.tenant_id=p_tenant_id AND EXISTS(
       SELECT 1 FROM public.inventory_stock_movements m
       WHERE m.tenant_id=i.tenant_id AND m.site_id=p_site_id AND m.item_id=i.id
         AND m.occurred_at>=v_start AND m.occurred_at<v_end)
   UNION ALL
   SELECT '07-purchase',p.id::text,md5(to_jsonb(p)::text)
     FROM public.supplier_purchases p
     WHERE p.tenant_id=p_tenant_id AND p.site_id=p_site_id
       AND p.invoice_date BETWEEN v_first AND ((v_first+INTERVAL '1 month')::date-1)
   UNION ALL
   SELECT '08-account-transaction',t.id::text,md5(to_jsonb(t)::text)
     FROM public.account_transactions t
     WHERE t.tenant_id=p_tenant_id AND t.site_id=p_site_id
       AND t.occurred_at>=v_start AND t.occurred_at<v_end
   UNION ALL
   SELECT '09-cash-settlement',s.id::text,md5(to_jsonb(s)::text)
     FROM public.financial_settlements s
     WHERE s.tenant_id=p_tenant_id AND s.site_id=p_site_id
       AND s.period_start<v_end AND s.period_end>=v_start
   UNION ALL
   SELECT '10-accrual-journal',j.id::text,md5(to_jsonb(j)::text)
     FROM public.financial_accrual_journals j
     WHERE j.tenant_id=p_tenant_id AND j.site_id=p_site_id AND j.period=p_period
  ) sources ORDER BY source_type,source_id
 LOOP
  v_acc:=md5(v_acc || ':' || v_row.source_type || ':' || v_row.source_id || ':' || v_row.checksum);
 END LOOP;
 RETURN v_acc;
END;
$detail$;
REVOKE ALL ON FUNCTION public.powerhub_financial_accrual_detail_fingerprint(bigint,bigint,text)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_accrual_detail_fingerprint(bigint,bigint,text)
 TO service_role;

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
 v_fingerprint:=md5((v_snapshot-'asOf')::text || ':' ||
    public.powerhub_financial_accrual_detail_fingerprint(p_tenant_id,p_site_id,p_period));
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
 v_changed:=md5((v_current-'asOf')::text || ':' ||
    public.powerhub_financial_accrual_detail_fingerprint(p_tenant_id,p_site_id,p_period))
    <>v_review.source_fingerprint;
 RETURN jsonb_build_object('status','locked','driftDetected',v_changed,
   'lockedByUserId',v_review.locked_by_user_id,'lockedAt',v_review.locked_at,
   'sourceFingerprint',v_review.source_fingerprint,
   'isCertifiedProfit',false,'lockedSnapshot',v_review.locked_snapshot);
END;
$status$;


REVOKE ALL ON FUNCTION public.powerhub_financial_accrual_period_lock(bigint,bigint,text,bigint)
 FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.powerhub_financial_accrual_period_review_status(bigint,bigint,text)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_accrual_period_lock(bigint,bigint,text,bigint)
 TO service_role;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_accrual_period_review_status(bigint,bigint,text)
 TO service_role;
NOTIFY pgrst,'reload schema';
