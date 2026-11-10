-- A44: technical projection of prelaunch testing only. No certified opening.
-- This DDL installs an inert, immutable marker; it does NOT activate a bootstrap,
-- create journals, or impersonate a human reviewer.
CREATE TABLE public.financial_gl_prelaunch_technical_bootstrap(
 tenant_id bigint NOT NULL REFERENCES public.tenants(id),
 site_id bigint NOT NULL REFERENCES public.sites(id),
 as_of_date date NOT NULL,
 cohort_key text NOT NULL,
 manifest_sha256 text NOT NULL,
 fixture_row_count bigint NOT NULL,
 mode text NOT NULL DEFAULT 'PRELAUNCH_TECHNICAL',
 human_approved boolean NOT NULL DEFAULT false,
 accounting_certification text NOT NULL DEFAULT 'NOT_CERTIFIED',
 expires_at timestamptz NOT NULL,
 registered_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 PRIMARY KEY(tenant_id,site_id),
 CONSTRAINT a44_exact_test_scope CHECK (
   tenant_id=1 AND site_id=1 AND as_of_date=DATE '2026-09-30'
   AND cohort_key='STG-PERF-20261105'
   AND manifest_sha256='f1b25e8562328a0f6e916beb4d54b2ee88366e78b4459c5d0ebc444616997df9'
   AND fixture_row_count=250000 AND mode='PRELAUNCH_TECHNICAL'
   AND human_approved=false AND accounting_certification='NOT_CERTIFIED'
   AND expires_at>registered_at AND expires_at<'2026-12-01'::timestamptz
 )
);
ALTER TABLE public.financial_gl_prelaunch_technical_bootstrap ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.financial_gl_prelaunch_technical_bootstrap FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.financial_gl_prelaunch_technical_bootstrap TO service_role;
CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_prelaunch_tech_valid(
 p_tenant_id bigint,p_site_id bigint,p_period text)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $valid$
SELECT p_tenant_id=1 AND p_site_id=1 AND p_period>='2026-10'
 AND EXISTS(SELECT 1 FROM public.financial_gl_prelaunch_technical_bootstrap b
 JOIN public.financial_gl_staging_technical_exclusions x
 ON x.tenant_id=b.tenant_id AND x.site_id=b.site_id
 AND x.cohort_key=b.cohort_key AND x.sha256=b.manifest_sha256
 AND x.row_count=b.fixture_row_count
 WHERE b.tenant_id=p_tenant_id AND b.site_id=p_site_id
 AND b.mode='PRELAUNCH_TECHNICAL' AND b.human_approved=false
 AND b.accounting_certification='NOT_CERTIFIED'
 AND b.expires_at>statement_timestamp()
 AND public.powerhub_financial_gl_zero_opening_preflight(b.tenant_id,b.site_id,b.as_of_date));
$valid$;
REVOKE ALL ON FUNCTION public.powerhub_financial_gl_prelaunch_tech_valid(bigint,bigint,text)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_gl_prelaunch_tech_valid(bigint,bigint,text)
 TO service_role;
CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_prelaunch_bootstrap_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $guard$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION
  'GL_PRELAUNCH_TECHNICAL_BOOTSTRAP_IMMUTABLE' USING ERRCODE='23514';END IF;
 IF public.powerhub_financial_gl_zero_opening_preflight(NEW.tenant_id,NEW.site_id,NEW.as_of_date) IS DISTINCT FROM true
 OR public.powerhub_financial_gl_verify_staging_fixture(NEW.tenant_id,NEW.site_id)->>'verified' IS DISTINCT FROM 'true'
 OR EXISTS(SELECT 1 FROM public.financial_gl_entries e
     WHERE e.tenant_id=NEW.tenant_id AND e.site_id=NEW.site_id)
 OR EXISTS(SELECT 1 FROM public.financial_gl_opening_batches b
     WHERE b.tenant_id=NEW.tenant_id AND b.site_id=NEW.site_id)
 THEN RAISE EXCEPTION 'GL_PRELAUNCH_BOOTSTRAP_PRECONDITIONS_NOT_PROVEN'
 USING ERRCODE='23514';END IF;
 RETURN NEW;
END;
$guard$;
REVOKE ALL ON FUNCTION public.powerhub_financial_gl_prelaunch_bootstrap_guard()
 FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER financial_gl_prelaunch_tech_insert
 BEFORE INSERT ON public.financial_gl_prelaunch_technical_bootstrap
 FOR EACH ROW EXECUTE FUNCTION public.powerhub_financial_gl_prelaunch_bootstrap_guard();
CREATE TRIGGER financial_gl_prelaunch_tech_immutable
 BEFORE UPDATE OR DELETE OR TRUNCATE ON public.financial_gl_prelaunch_technical_bootstrap
 FOR EACH STATEMENT EXECUTE FUNCTION public.powerhub_financial_gl_prelaunch_bootstrap_guard();

CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_post_source(p_tenant_id bigint, p_site_id bigint, p_source_type text, p_source_id bigint, p_user_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
 v_plan jsonb;v_entry public.financial_gl_entries%ROWTYPE;
 v_period text;v_lines jsonb;v_fingerprint text;v_policy text;v_key text;
 v_line jsonb;v_debit numeric;v_credit numeric;v_expected bigint;
 v_reversal_id bigint;v_count bigint;v_required numeric;v_available numeric;
BEGIN
 IF p_user_id IS NULL OR p_user_id<=0 OR NOT EXISTS(
    SELECT 1 FROM public.users u WHERE u.id=p_user_id)
 THEN RAISE EXCEPTION 'GL_SOURCE_ACTOR_INVALID' USING ERRCODE='22023'; END IF;
 IF public.powerhub_financial_gl_authorized_actor(p_tenant_id,p_site_id,p_user_id) IS DISTINCT FROM true THEN
 RAISE EXCEPTION 'GL_SOURCE_ACTOR_FORBIDDEN' USING ERRCODE='42501'; END IF;
 v_plan:=public.powerhub_financial_gl_source_plan(
   p_tenant_id,p_site_id,p_source_type,p_source_id);
 v_period:=v_plan->>'period';v_lines:=v_plan->'lines';
 v_fingerprint:=v_plan->>'sourceFingerprint';v_policy:=v_plan->>'policyVersion';
 v_reversal_id:=(v_plan->>'reversesEntryId')::bigint;
 v_key:='gl:source:'||p_source_type||':'||p_source_id||':v1';
 -- Match the existing accrual/opening lock hierarchy: period before site.
 PERFORM pg_advisory_xact_lock(hashtextextended(
   'powerhub:accrual-period:'||p_tenant_id||':'||p_site_id||':'||v_period,0));
 PERFORM pg_advisory_xact_lock(hashtextextended(
   'powerhub:gl-site:'||p_tenant_id||':'||p_site_id,0));
 -- Source may have changed while waiting for locks: derive and compare again.
 IF public.powerhub_financial_gl_source_plan(
     p_tenant_id,p_site_id,p_source_type,p_source_id)->>'sourceFingerprint'
     IS DISTINCT FROM v_fingerprint
 THEN RAISE EXCEPTION 'GL_SOURCE_CHANGED_DURING_POST'
    USING ERRCODE='40001'; END IF;
 SELECT * INTO v_entry FROM public.financial_gl_entries e
 WHERE e.tenant_id=p_tenant_id AND e.site_id=p_site_id
   AND e.source_type=p_source_type AND e.source_id=p_source_id::text
   AND e.source_revision=1;
 IF FOUND THEN
   IF v_entry.period<>v_period OR v_entry.source_fingerprint<>v_fingerprint
      OR v_entry.operation_key<>v_key OR v_entry.accounting_policy_version<>v_policy
      OR v_entry.reverses_entry_id IS DISTINCT FROM v_reversal_id
      OR EXISTS (
        SELECT code,side,amount,count(*) FROM
          (SELECT v->>'code' AS code,v->>'side' AS side,(v->>'amount')::numeric AS amount
           FROM jsonb_array_elements(v_lines) v) want GROUP BY code,side,amount
        EXCEPT
        SELECT account_code,side,amount,count(*) FROM public.financial_gl_lines
        WHERE entry_id=v_entry.id GROUP BY account_code,side,amount
      )
      OR EXISTS(
        SELECT account_code,side,amount,count(*) FROM public.financial_gl_lines
        WHERE entry_id=v_entry.id GROUP BY account_code,side,amount
        EXCEPT
        SELECT code,side,amount,count(*) FROM
          (SELECT v->>'code' AS code,v->>'side' AS side,(v->>'amount')::numeric AS amount
           FROM jsonb_array_elements(v_lines) v) want GROUP BY code,side,amount
      )
   THEN RAISE EXCEPTION 'GL_SOURCE_REPLAY_MISMATCH' USING ERRCODE='23505'; END IF;
   RETURN jsonb_build_object('status','posted','alreadyPosted',true,'entryId',v_entry.id,
     'sourceType',p_source_type,'sourceId',p_source_id);
 END IF;
 IF EXISTS(SELECT 1 FROM public.financial_accrual_period_reviews r
   WHERE r.tenant_id=p_tenant_id AND r.site_id=p_site_id
    AND r.period=v_period AND r.status='locked')
 THEN RAISE EXCEPTION 'GL_SOURCE_PERIOD_LOCKED' USING ERRCODE='22023'; END IF;
 -- No postings without a separately approved documentary opening. Without it,
 -- arithmetic GL equality can conceal missing historical cash, stock and debts.
 IF NOT EXISTS(SELECT 1 FROM public.financial_gl_opening_batches b
    WHERE b.tenant_id=p_tenant_id AND b.site_id=p_site_id AND b.status='posted'
      AND b.period<=v_period AND EXISTS(
       SELECT 1 FROM public.financial_gl_entries e
       WHERE e.tenant_id=b.tenant_id AND e.site_id=b.site_id
         AND e.source_type='opening_balance' AND e.source_id=b.id::text
         AND e.source_fingerprint=b.source_fingerprint))

 AND public.powerhub_financial_gl_prelaunch_tech_valid(p_tenant_id,p_site_id,v_period) IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'GL_DOCUMENTED_OPENING_REQUIRED' USING ERRCODE='22023'; END IF;
 -- Source cost/settlement may not consume more than the documented GL
 -- asset or liability available at this site. Check AFTER acquiring both
 -- advisory locks, so two concurrent issues cannot spend the same stock.
 FOR v_line IN SELECT jsonb_array_elements(v_lines) LOOP
   IF (v_line->>'side')='credit' AND (v_line->>'code') IN ('1300','1700') THEN
     v_required:=(v_line->>'amount')::numeric;
     SELECT coalesce(sum(CASE WHEN l.side='debit' THEN l.amount ELSE -l.amount END),0)
       INTO v_available
     FROM public.financial_gl_lines l JOIN public.financial_gl_entries e ON e.id=l.entry_id
     WHERE e.tenant_id=p_tenant_id AND e.site_id=p_site_id
       AND e.period<=v_period AND l.account_code=v_line->>'code';
     IF v_available<v_required THEN
       RAISE EXCEPTION 'GL_SOURCE_ASSET_NOT_SUPPORTED_BY_LEDGER'
         USING ERRCODE='22023'; END IF;
   ELSIF (v_line->>'side')='debit' AND (v_line->>'code') IN ('2300','2400') THEN
     v_required:=(v_line->>'amount')::numeric;
     SELECT coalesce(sum(CASE WHEN l.side='credit' THEN l.amount ELSE -l.amount END),0)
       INTO v_available
     FROM public.financial_gl_lines l JOIN public.financial_gl_entries e ON e.id=l.entry_id
     WHERE e.tenant_id=p_tenant_id AND e.site_id=p_site_id
       AND e.period<=v_period AND l.account_code=v_line->>'code';
     IF v_available<v_required THEN
       RAISE EXCEPTION 'GL_SOURCE_SETTLEMENT_EXCEEDS_LIABILITY'
         USING ERRCODE='22023'; END IF;
   END IF;
 END LOOP;
 PERFORM public.powerhub_financial_gl_seed_chart(p_tenant_id);
 INSERT INTO public.financial_gl_accounts(tenant_id,code,name,account_class,normal_side,is_contra)
 VALUES(p_tenant_id,'2250','أرصدة مقدمة للمشتركين','liability','credit',false),
       (p_tenant_id,'2450','استقطاعات رواتب مستحقة','liability','credit',false)
 ON CONFLICT(tenant_id,code) DO NOTHING;
 IF EXISTS(SELECT 1 FROM public.financial_gl_accounts a WHERE a.tenant_id=p_tenant_id
    AND a.code IN ('2250','2450')
    AND (a.account_class<>'liability' OR a.normal_side<>'credit' OR a.is_contra))
 THEN RAISE EXCEPTION 'GL_SOURCE_ACCOUNT_CATALOG_CONFLICT' USING ERRCODE='23514'; END IF;
 SELECT count(*) INTO v_count FROM jsonb_array_elements(v_lines) l
 LEFT JOIN public.financial_gl_accounts a ON a.tenant_id=p_tenant_id AND a.code=l->>'code'
 WHERE a.code IS NULL;
 IF v_count<>0 THEN RAISE EXCEPTION 'GL_SOURCE_ACCOUNT_UNKNOWN' USING ERRCODE='22023'; END IF;
 INSERT INTO public.financial_gl_entries(tenant_id,site_id,period,source_type,source_id,
   source_revision,operation_key,source_fingerprint,accounting_policy_version,
   posted_by_user_id,reverses_entry_id)
 VALUES(p_tenant_id,p_site_id,v_period,p_source_type,p_source_id::text,1,v_key,
   v_fingerprint,v_policy,p_user_id,v_reversal_id)
 RETURNING * INTO v_entry;
 INSERT INTO public.financial_gl_lines(entry_id,tenant_id,site_id,account_code,side,amount)
 SELECT v_entry.id,p_tenant_id,p_site_id,l->>'code',l->>'side',(l->>'amount')::numeric
 FROM jsonb_array_elements(v_lines) l;
 RETURN jsonb_build_object('status','posted','alreadyPosted',false,'entryId',v_entry.id,
   'sourceType',p_source_type,'sourceId',p_source_id,
   'postingMode',CASE WHEN public.powerhub_financial_gl_prelaunch_tech_valid(p_tenant_id,p_site_id,v_period)
 THEN 'PRELAUNCH_TECHNICAL' ELSE 'DOCUMENTED_OPENING' END,
   'accountingCertification','NOT_CERTIFIED');
END;
$function$
;
CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_recognize_billed_service(p_tenant_id bigint, p_site_id bigint, p_invoice_id bigint, p_period text, p_actor_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
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
 IF public.powerhub_financial_gl_authorized_actor(p_tenant_id,p_site_id,p_actor_id) IS DISTINCT FROM true THEN
 RAISE EXCEPTION 'GL_SERVICE_ACTOR_FORBIDDEN' USING ERRCODE='42501'; END IF;
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
     AND b.status='posted' AND b.period<=p_period)
 AND public.powerhub_financial_gl_prelaunch_tech_valid(p_tenant_id,p_site_id,p_period) IS DISTINCT FROM true THEN
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
END;$function$
;
