-- A41: applied to Staging as migration 20261110152142.
-- A caller-controlled numeric actor id is never sufficient authorization.
-- Preserve granular tRPC permissions; this SQL guard is defense-in-depth
-- for the service-role RPC boundary and tenant/site membership.
CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_authorized_actor(p_tenant_id bigint, p_site_id bigint, p_actor_id bigint)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
 SELECT p_tenant_id>0 AND p_site_id>0 AND p_actor_id>0 AND EXISTS(
  SELECT 1 FROM public.sites s JOIN public.tenant_members m ON m.tenant_id=s.tenant_id
  JOIN public.users u ON u.id=m.user_id
  WHERE s.tenant_id=p_tenant_id AND s.id=p_site_id AND s.status<>'archived'
  AND m.user_id=p_actor_id AND m.is_active AND m.membership_status='active'
  AND (m.expires_at IS NULL OR m.expires_at>statement_timestamp())
  AND m.role IN ('owner','manager','accountant') AND u.account_status='active');
$function$
;
CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_opening_create(p_tenant_id bigint, p_site_id bigint, p_user_id bigint, p_as_of_date date, p_evidence_reference text, p_description text, p_operation_key text, p_lines jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE v_fingerprint text;v_batch public.financial_gl_opening_batches%ROWTYPE;
 v_line jsonb;v_i integer;v_amount numeric;v_debit numeric:=0;v_credit numeric:=0;
 v_code text;v_side text;v_evidence text;v_period text;
BEGIN
 IF p_tenant_id IS NULL OR p_site_id IS NULL OR p_user_id IS NULL OR
    p_as_of_date IS NULL OR p_as_of_date>current_date OR
    length(btrim(coalesce(p_evidence_reference,''))) NOT BETWEEN 8 AND 250 OR
    length(btrim(coalesce(p_description,''))) NOT BETWEEN 10 AND 1000 OR
    length(btrim(coalesce(p_operation_key,''))) NOT BETWEEN 8 AND 180 OR
    p_lines IS NULL OR jsonb_typeof(p_lines)<>'array' OR
    jsonb_array_length(p_lines) NOT BETWEEN 2 AND 500 OR
    NOT EXISTS(SELECT 1 FROM public.sites s WHERE s.id=p_site_id
      AND s.tenant_id=p_tenant_id AND s.status<>'archived')
 THEN RAISE EXCEPTION 'GL_OPENING_REQUEST_INVALID' USING ERRCODE='22023'; END IF;
 IF public.powerhub_financial_gl_authorized_actor(p_tenant_id,p_site_id,p_user_id) IS DISTINCT FROM true THEN
 RAISE EXCEPTION 'GL_OPENING_ACTOR_FORBIDDEN' USING ERRCODE='42501'; END IF;
 v_period:=to_char(p_as_of_date,'YYYY-MM');
 PERFORM pg_advisory_xact_lock(hashtextextended(
   'powerhub:gl-site:'||p_tenant_id||':'||p_site_id,0));
 PERFORM pg_advisory_xact_lock(hashtextextended(
   'powerhub:gl-opening:'||p_tenant_id||':'||p_site_id,0));
 v_fingerprint:=encode(sha256(convert_to(jsonb_build_object(
  'tenantId',p_tenant_id,'siteId',p_site_id,'asOfDate',p_as_of_date,
  'evidence',btrim(p_evidence_reference),'description',btrim(p_description),
  'lines',p_lines,'creator',p_user_id)::text,'UTF8')),'hex');
 SELECT * INTO v_batch FROM public.financial_gl_opening_batches b
 WHERE b.tenant_id=p_tenant_id AND b.site_id=p_site_id AND b.operation_key=p_operation_key;
 IF FOUND THEN
  IF v_batch.source_fingerprint<>v_fingerprint OR v_batch.status='void' THEN
    RAISE EXCEPTION 'GL_OPENING_OPERATION_CONFLICT' USING ERRCODE='23505'; END IF;
  RETURN jsonb_build_object('openingId',v_batch.id,'status',v_batch.status,
    'alreadyCreated',true);
 END IF;
 IF EXISTS(SELECT 1 FROM public.financial_gl_opening_batches b
   WHERE b.tenant_id=p_tenant_id AND b.site_id=p_site_id AND b.status<>'void') THEN
  RAISE EXCEPTION 'GL_OPENING_ALREADY_EXISTS' USING ERRCODE='23505'; END IF;
 IF EXISTS(SELECT 1 FROM public.financial_gl_entries e
   WHERE e.tenant_id=p_tenant_id AND e.site_id=p_site_id
     AND e.period<=v_period) THEN
  RAISE EXCEPTION 'GL_OPENING_PRIOR_POSTINGS' USING ERRCODE='22023'; END IF;
 PERFORM public.powerhub_financial_gl_seed_chart(p_tenant_id);
 FOR v_i IN 0..jsonb_array_length(p_lines)-1 LOOP
   v_line:=p_lines->v_i;
   IF jsonb_typeof(v_line)<>'object'
      OR jsonb_typeof(v_line->'amount')<>'number' THEN
      RAISE EXCEPTION 'GL_OPENING_LINE_INVALID' USING ERRCODE='22023'; END IF;
   v_code:=v_line->>'accountCode';v_side:=v_line->>'side';
   v_evidence:=v_line->>'evidenceReference';
   v_amount:=(v_line->>'amount')::numeric;
   IF v_amount<=0 OR v_amount>100000000000 OR v_amount<>round(v_amount,2)
      OR v_side NOT IN ('debit','credit')
      OR length(btrim(coalesce(v_evidence,''))) NOT BETWEEN 3 AND 250
      OR NOT EXISTS(SELECT 1 FROM public.financial_gl_accounts a
        WHERE a.tenant_id=p_tenant_id AND a.code=v_code
          AND a.account_class IN ('asset','liability','equity'))
   THEN RAISE EXCEPTION 'GL_OPENING_LINE_INVALID' USING ERRCODE='22023'; END IF;
   IF v_side='debit' THEN v_debit:=v_debit+v_amount;
   ELSE v_credit:=v_credit+v_amount; END IF;
 END LOOP;
 IF v_debit<=0 OR v_debit<>v_credit THEN
   RAISE EXCEPTION 'GL_OPENING_NOT_BALANCED' USING ERRCODE='23514'; END IF;
 INSERT INTO public.financial_gl_opening_batches
  (tenant_id,site_id,as_of_date,evidence_reference,description,operation_key,
   source_fingerprint,expected_line_count,created_by_user_id)
 VALUES(p_tenant_id,p_site_id,p_as_of_date,btrim(p_evidence_reference),
   btrim(p_description),p_operation_key,v_fingerprint,jsonb_array_length(p_lines),p_user_id)
 RETURNING * INTO v_batch;
 FOR v_i IN 0..jsonb_array_length(p_lines)-1 LOOP
   v_line:=p_lines->v_i;
   INSERT INTO public.financial_gl_opening_lines
    (opening_id,tenant_id,site_id,sequence_number,account_code,side,amount,evidence_reference)
   VALUES(v_batch.id,p_tenant_id,p_site_id,v_i+1,v_line->>'accountCode',
      v_line->>'side',(v_line->>'amount')::numeric,
      btrim(v_line->>'evidenceReference'));
 END LOOP;
 RETURN jsonb_build_object('openingId',v_batch.id,'status','draft',
   'alreadyCreated',false,'debits',v_debit,'credits',v_credit);
END;
$function$
;
CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_opening_post(p_tenant_id bigint, p_site_id bigint, p_opening_id bigint, p_approver_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE v_batch public.financial_gl_opening_batches%ROWTYPE;
 v_entry public.financial_gl_entries%ROWTYPE;v_debit numeric;v_credit numeric;
 v_count bigint;v_key text;v_period text;
BEGIN
 IF p_tenant_id IS NULL OR p_site_id IS NULL OR p_opening_id IS NULL OR
   p_approver_id IS NULL OR p_approver_id<=0 THEN
   RAISE EXCEPTION 'GL_OPENING_POST_INVALID' USING ERRCODE='22023'; END IF;
 IF public.powerhub_financial_gl_authorized_actor(p_tenant_id,p_site_id,p_approver_id) IS DISTINCT FROM true THEN
 RAISE EXCEPTION 'GL_OPENING_APPROVER_FORBIDDEN' USING ERRCODE='42501'; END IF;
 SELECT b.period INTO v_period FROM public.financial_gl_opening_batches b
 WHERE b.id=p_opening_id AND b.tenant_id=p_tenant_id AND b.site_id=p_site_id;
 IF v_period IS NULL THEN RAISE EXCEPTION 'GL_OPENING_OUT_OF_SCOPE' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(
   'powerhub:accrual-period:'||p_tenant_id||':'||p_site_id||':'||v_period,0));
 PERFORM pg_advisory_xact_lock(hashtextextended(
   'powerhub:gl-site:'||p_tenant_id||':'||p_site_id,0));
 PERFORM pg_advisory_xact_lock(hashtextextended(
   'powerhub:gl-opening:'||p_tenant_id||':'||p_site_id,0));
 SELECT * INTO v_batch FROM public.financial_gl_opening_batches
 WHERE id=p_opening_id AND tenant_id=p_tenant_id AND site_id=p_site_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'GL_OPENING_OUT_OF_SCOPE' USING ERRCODE='22023'; END IF;
 v_key:='gl:opening:'||v_batch.id||':v1';
 IF v_batch.status='posted' THEN
  SELECT * INTO v_entry FROM public.financial_gl_entries
    WHERE tenant_id=p_tenant_id AND site_id=p_site_id
      AND source_type='opening_balance' AND source_id=v_batch.id::text;
  IF v_batch.approved_by_user_id<>p_approver_id OR
      v_entry.id IS NULL OR v_entry.source_fingerprint<>v_batch.source_fingerprint THEN
    RAISE EXCEPTION 'GL_OPENING_POST_REPLAY_CONFLICT' USING ERRCODE='23505'; END IF;
  RETURN jsonb_build_object('openingId',v_batch.id,'entryId',v_entry.id,
    'status','posted','alreadyPosted',true);
 END IF;
 IF v_batch.status<>'draft' OR v_batch.created_by_user_id=p_approver_id OR
   NOT EXISTS(SELECT 1 FROM public.users u WHERE u.id=p_approver_id) THEN
   RAISE EXCEPTION 'GL_OPENING_APPROVAL_DENIED' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM public.financial_accrual_period_reviews r
   WHERE r.tenant_id=p_tenant_id AND r.site_id=p_site_id
   AND r.period=v_batch.period AND r.status='locked') THEN
   RAISE EXCEPTION 'GL_OPENING_PERIOD_LOCKED' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM public.financial_gl_entries e
   WHERE e.tenant_id=p_tenant_id AND e.site_id=p_site_id
     AND e.period<=v_batch.period) THEN
   RAISE EXCEPTION 'GL_OPENING_PRIOR_POSTINGS' USING ERRCODE='22023'; END IF;
 SELECT count(*),coalesce(sum(amount) FILTER(WHERE side='debit'),0),
  coalesce(sum(amount) FILTER(WHERE side='credit'),0)
 INTO v_count,v_debit,v_credit FROM public.financial_gl_opening_lines
 WHERE opening_id=v_batch.id AND tenant_id=p_tenant_id AND site_id=p_site_id;
 IF v_count<2 OR v_count>500 OR v_count<>v_batch.expected_line_count
    OR v_debit<=0 OR v_debit<>v_credit THEN
   RAISE EXCEPTION 'GL_OPENING_NOT_BALANCED' USING ERRCODE='23514'; END IF;
 UPDATE public.financial_gl_opening_batches
 SET status='posted',approved_by_user_id=p_approver_id,approved_at=now()
 WHERE id=v_batch.id;
 INSERT INTO public.financial_gl_entries
  (tenant_id,site_id,period,source_type,source_id,source_revision,operation_key,
   source_fingerprint,accounting_policy_version,posted_by_user_id)
 VALUES(p_tenant_id,p_site_id,v_batch.period,'opening_balance',v_batch.id::text,1,
   v_key,v_batch.source_fingerprint,'documented-opening-v1',p_approver_id)
 RETURNING * INTO v_entry;
 INSERT INTO public.financial_gl_lines(entry_id,tenant_id,site_id,account_code,side,amount)
 SELECT v_entry.id,p_tenant_id,p_site_id,l.account_code,l.side,l.amount
 FROM public.financial_gl_opening_lines l WHERE l.opening_id=v_batch.id
 ORDER BY l.sequence_number;
 RETURN jsonb_build_object('openingId',v_batch.id,'entryId',v_entry.id,
   'status','posted','alreadyPosted',false,'debits',v_debit,'credits',v_credit);
END;
$function$
;
CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_opening_void(p_tenant_id bigint, p_site_id bigint, p_opening_id bigint, p_actor_id bigint, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE b public.financial_gl_opening_batches%ROWTYPE;
BEGIN
 IF p_actor_id IS NULL OR length(btrim(coalesce(p_reason,''))) NOT BETWEEN 10 AND 1000 THEN
   RAISE EXCEPTION 'GL_OPENING_VOID_REQUEST_INVALID' USING ERRCODE='22023'; END IF;
 IF public.powerhub_financial_gl_authorized_actor(p_tenant_id,p_site_id,p_actor_id) IS DISTINCT FROM true THEN
 RAISE EXCEPTION 'GL_OPENING_VOID_ACTOR_FORBIDDEN' USING ERRCODE='42501'; END IF;
 SELECT * INTO b FROM public.financial_gl_opening_batches
 WHERE tenant_id=p_tenant_id AND site_id=p_site_id AND id=p_opening_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'GL_OPENING_OUT_OF_SCOPE' USING ERRCODE='22023'; END IF;
 IF b.status='void' AND b.voided_by_user_id=p_actor_id
     AND b.void_reason=btrim(p_reason) THEN
   RETURN jsonb_build_object('openingId',b.id,'status','void','alreadyVoided',true); END IF;
 IF b.status<>'draft' THEN RAISE EXCEPTION 'GL_OPENING_POSTED_CANNOT_VOID' USING ERRCODE='22023'; END IF;
 UPDATE public.financial_gl_opening_batches
 SET status='void',voided_by_user_id=p_actor_id,void_reason=btrim(p_reason),voided_at=now()
 WHERE id=b.id;
 RETURN jsonb_build_object('openingId',b.id,'status','void','alreadyVoided',false);
END;
$function$
;
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
END;$function$
;
REVOKE ALL ON FUNCTION public.powerhub_financial_gl_authorized_actor(bigint,bigint,bigint)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_gl_authorized_actor(bigint,bigint,bigint) TO service_role;
