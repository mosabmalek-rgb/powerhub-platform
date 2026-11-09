-- A3.3: recognize only fully elapsed calendar-month allocations of
-- invoiced service already posted as deferred revenue (2200).
-- No automatic backfill; no unbilled revenue assertion, period close respected.
ALTER TABLE public.financial_gl_entries
 DROP CONSTRAINT IF EXISTS financial_gl_entries_source_type_check;
ALTER TABLE public.financial_gl_entries
 ADD CONSTRAINT financial_gl_entries_source_type_check CHECK(source_type IN(
 'opening_balance','accrual_adjustment','invoice','payment','expense','payroll',
 'stock_movement','supplier_ledger','account_movement','asset_depreciation',
 'provision','tax','correction','service_recognition','payroll_payment'
 ));

CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_recognize_billed_service(
 p_tenant_id bigint,p_site_id bigint,p_invoice_id bigint,p_period text,p_actor_id bigint
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $recognize$
DECLARE
 i public.invoices%ROWTYPE;
 v_invoice_gl public.financial_gl_entries%ROWTYPE;
 v_existing public.financial_gl_entries%ROWTYPE;
 v_month date;v_last date;v_now date;
 v_first_service date;v_last_service date;
 v_first date;v_end date;v_days bigint;v_net_minor bigint;
 v_through bigint;v_prior bigint;v_amount_minor bigint;v_amount numeric;
 v_key text;v_source_id text;v_fingerprint text;v_expected_invoice_hash text;
BEGIN
 IF p_tenant_id IS NULL OR p_site_id IS NULL OR p_invoice_id IS NULL OR
    p_actor_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.users WHERE id=p_actor_id)
    OR p_period IS NULL OR p_period !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
 THEN RAISE EXCEPTION 'GL_SERVICE_RECOGNITION_INVALID_REQUEST'
   USING ERRCODE='22023'; END IF;
 v_month:=(p_period||'-01')::date;
 v_last:=(v_month+interval '1 month - 1 day')::date;
 v_now:=(now() AT TIME ZONE 'Asia/Gaza')::date;
 IF v_last>=v_now THEN RAISE EXCEPTION 'GL_SERVICE_MONTH_NOT_COMPLETED'
   USING ERRCODE='22023'; END IF;
 -- Match financial source posting lock ordering (period first, then site).
 PERFORM pg_advisory_xact_lock(hashtextextended(
   'powerhub:accrual-period:'||p_tenant_id||':'||p_site_id||':'||p_period,0));
 PERFORM pg_advisory_xact_lock(hashtextextended(
   'powerhub:gl-site:'||p_tenant_id||':'||p_site_id,0));
 SELECT * INTO i FROM public.invoices
 WHERE id=p_invoice_id AND tenant_id=p_tenant_id AND site_id=p_site_id
 FOR SHARE;
 IF NOT FOUND OR i.status NOT IN ('issued','overdue','partially_paid','paid')
    OR i.cycle_start_at IS NULL OR i.cycle_end_at IS NULL
    OR i.cycle_end_at<i.cycle_start_at
    OR i.total_amount<0 OR i.tax_amount<0 OR i.tax_amount>i.total_amount
    OR i.total_amount<>round(i.total_amount,2)
    OR i.tax_amount<>round(i.tax_amount,2)
    OR i.credit_applied_amount<>0 THEN
  RAISE EXCEPTION 'GL_SERVICE_INVOICE_NOT_ELIGIBLE' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_invoice_gl FROM public.financial_gl_entries e
 WHERE e.tenant_id=p_tenant_id AND e.site_id=p_site_id
   AND e.source_type='invoice' AND e.source_id=i.id::text AND e.source_revision=1;
 IF NOT FOUND OR v_invoice_gl.accounting_policy_version<>'invoice-receivable-v1-defer-service'
   THEN RAISE EXCEPTION 'GL_SERVICE_INVOICE_NOT_DEFERRED'
   USING ERRCODE='22023'; END IF;
 v_expected_invoice_hash:=public.powerhub_financial_gl_source_plan(
   p_tenant_id,p_site_id,'invoice',p_invoice_id)->>'sourceFingerprint';
 IF v_invoice_gl.source_fingerprint<>v_expected_invoice_hash THEN
  RAISE EXCEPTION 'GL_SERVICE_INVOICE_SOURCE_CHANGED' USING ERRCODE='23505'; END IF;
 IF NOT EXISTS (SELECT 1 FROM public.financial_gl_opening_batches b
   WHERE b.tenant_id=p_tenant_id AND b.site_id=p_site_id
     AND b.status='posted' AND b.period<=p_period) THEN
  RAISE EXCEPTION 'GL_SERVICE_OPENING_REQUIRED' USING ERRCODE='22023'; END IF;
 v_first_service:=(i.cycle_start_at AT TIME ZONE 'Asia/Gaza')::date;
 v_last_service:=(i.cycle_end_at AT TIME ZONE 'Asia/Gaza')::date;
 v_days:=(v_last_service-v_first_service+1)::bigint;
 IF v_days<1 OR v_days>3660 OR v_last_service<v_month
    OR v_first_service>v_last THEN
  RAISE EXCEPTION 'GL_SERVICE_MONTH_OUTSIDE_CYCLE' USING ERRCODE='22023'; END IF;
 v_net_minor:=((i.total_amount-i.tax_amount)*100)::bigint;
 v_first:=greatest(v_first_service,v_month);
 v_end:=least(v_last_service,v_last);
 v_through:=v_net_minor*((v_end-v_first_service+1)::bigint)/v_days;
 v_prior:=v_net_minor*((v_first-v_first_service)::bigint)/v_days;
 v_amount_minor:=v_through-v_prior;
 IF v_amount_minor<=0 THEN
  RAISE EXCEPTION 'GL_SERVICE_ZERO_ALLOCATION' USING ERRCODE='22023'; END IF;
 v_amount:=v_amount_minor::numeric/100;
 v_source_id:=i.id::text||':'||p_period;
 v_key:='gl:service:'||v_source_id||':v1';
 v_fingerprint:=encode(sha256(convert_to(jsonb_build_object(
   'invoice',i.id,'period',p_period,'invoiceSourceHash',v_expected_invoice_hash,
   'minorUnits',v_amount_minor,'policy','gaza-invoice-service-calendar-days-v1'
 )::text,'UTF8')),'hex');
 SELECT * INTO v_existing FROM public.financial_gl_entries e
 WHERE e.tenant_id=p_tenant_id AND e.site_id=p_site_id
   AND e.source_type='service_recognition' AND e.source_id=v_source_id
   AND e.source_revision=1;
 IF FOUND THEN
  IF v_existing.period<>p_period OR v_existing.source_fingerprint<>v_fingerprint
    OR v_existing.operation_key<>v_key
    OR (SELECT count(*) FROM public.financial_gl_lines l
      WHERE l.entry_id=v_existing.id
        AND ((l.account_code='2200' AND l.side='debit' AND l.amount=v_amount)
          OR (l.account_code='4100' AND l.side='credit' AND l.amount=v_amount)))<>2
    OR (SELECT count(*) FROM public.financial_gl_lines l
      WHERE l.entry_id=v_existing.id)<>2 THEN
    RAISE EXCEPTION 'GL_SERVICE_REPLAY_MISMATCH' USING ERRCODE='23505'; END IF;
  RETURN jsonb_build_object('status','posted','alreadyPosted',true,
    'entryId',v_existing.id,'invoiceId',i.id,'period',p_period,'amountMinor',v_amount_minor,
    'accountingCertification','NOT_CERTIFIED');
 END IF;
 IF EXISTS(SELECT 1 FROM public.financial_accrual_period_reviews r
   WHERE r.tenant_id=p_tenant_id AND r.site_id=p_site_id
      AND r.period=p_period AND r.status='locked') THEN
  RAISE EXCEPTION 'GL_SERVICE_PERIOD_LOCKED' USING ERRCODE='22023'; END IF;
 INSERT INTO public.financial_gl_entries(tenant_id,site_id,period,source_type,
    source_id,source_revision,operation_key,source_fingerprint,
    accounting_policy_version,posted_by_user_id)
 VALUES(p_tenant_id,p_site_id,p_period,'service_recognition',v_source_id,1,
   v_key,v_fingerprint,'gaza-invoice-service-calendar-days-v1',p_actor_id)
 RETURNING * INTO v_existing;
 INSERT INTO public.financial_gl_lines(entry_id,tenant_id,site_id,account_code,side,amount)
 VALUES(v_existing.id,p_tenant_id,p_site_id,'2200','debit',v_amount),
       (v_existing.id,p_tenant_id,p_site_id,'4100','credit',v_amount);
 RETURN jsonb_build_object('status','posted','alreadyPosted',false,
   'entryId',v_existing.id,'invoiceId',i.id,'period',p_period,'amountMinor',v_amount_minor,
   'accountingCertification','NOT_CERTIFIED');
END;$recognize$;
REVOKE ALL ON FUNCTION public.powerhub_financial_gl_recognize_billed_service(
 bigint,bigint,bigint,text,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_gl_recognize_billed_service(
 bigint,bigint,bigint,text,bigint) TO service_role;
COMMENT ON FUNCTION public.powerhub_financial_gl_recognize_billed_service(bigint,bigint,bigint,text,bigint)
 IS 'Recognizes invoiced service only after the Gaza-local month fully ends, with immutable, exact source allocation and prior deferred invoice GL; excludes unbilled service.';
NOTIFY pgrst,'reload schema';
