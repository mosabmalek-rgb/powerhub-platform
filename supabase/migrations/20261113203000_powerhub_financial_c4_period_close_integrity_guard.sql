-- C4 fail-closed financial period lock; exact versioned migration required.
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
$function$;
REVOKE ALL ON FUNCTION public.powerhub_financial_accrual_period_lock(bigint,bigint,text,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_accrual_period_lock(bigint,bigint,text,bigint) TO service_role;
