-- A42 -- Staging applied version: 20261110154921
-- No invented starting cents. Only a strictly proven zero-activity opening.
-- This migration updates guard functions and structural acceptance; no data backfill.
-- Both accounting certification and independent document verification remain false.
ALTER TABLE public.financial_gl_opening_batches
  DROP CONSTRAINT financial_gl_opening_batches_expected_line_count_check;
ALTER TABLE public.financial_gl_opening_batches
  ADD CONSTRAINT financial_gl_opening_batches_expected_line_count_check
  CHECK (expected_line_count=0 OR expected_line_count BETWEEN 2 AND 500);

CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_zero_opening_preflight(p_tenant_id bigint, p_site_id bigint, p_as_of_date date)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE v_fixture boolean:=false;v_cutoff timestamptz;
BEGIN
 IF p_tenant_id IS NULL OR p_tenant_id<=0 OR p_site_id IS NULL OR p_site_id<=0
  OR p_as_of_date IS NULL OR p_as_of_date>current_date
  OR NOT EXISTS(SELECT 1 FROM public.sites WHERE tenant_id=p_tenant_id AND id=p_site_id AND status<>'archived')
 THEN RETURN false;END IF;
 v_cutoff:=(p_as_of_date+1)::timestamp AT TIME ZONE 'Asia/Gaza';
 IF p_tenant_id=1 AND p_site_id=1 THEN
  v_fixture:=coalesce((public.powerhub_financial_gl_verify_staging_fixture(1,1)->>'verified')::boolean,false);
 END IF;
 RETURN NOT EXISTS(SELECT 1 FROM public.company_accounts t
  WHERE t.tenant_id=p_tenant_id AND t.created_at<v_cutoff AND t.opening_balance<>0)
 AND NOT EXISTS(SELECT 1 FROM public.account_transactions t
  WHERE t.tenant_id=p_tenant_id AND t.site_id=p_site_id
  AND t.occurred_at<v_cutoff AND NOT (v_fixture AND t.reference_no LIKE 'STG-PERF-%'))
 AND NOT EXISTS(SELECT 1 FROM public.invoices t WHERE t.tenant_id=p_tenant_id AND t.site_id=p_site_id AND t.issue_date<=p_as_of_date)
 AND NOT EXISTS(SELECT 1 FROM public.payments t WHERE t.tenant_id=p_tenant_id AND t.site_id=p_site_id AND t.paid_at<v_cutoff)
 AND NOT EXISTS(SELECT 1 FROM public.expenses t WHERE t.tenant_id=p_tenant_id AND t.site_id=p_site_id AND t.occurred_at<v_cutoff)
 AND NOT EXISTS(SELECT 1 FROM public.inventory_stock_movements t WHERE t.tenant_id=p_tenant_id AND t.site_id=p_site_id AND t.occurred_at<v_cutoff)
 AND NOT EXISTS(SELECT 1 FROM public.supplier_ledger_entries t WHERE t.tenant_id=p_tenant_id AND t.site_id=p_site_id AND t.occurred_at<v_cutoff)
 AND NOT EXISTS(SELECT 1 FROM public.supplier_purchases t WHERE t.tenant_id=p_tenant_id AND t.site_id=p_site_id AND t.invoice_date<=p_as_of_date)
 AND NOT EXISTS(SELECT 1 FROM public.payroll_runs t WHERE t.tenant_id=p_tenant_id AND t.site_id=p_site_id AND t.period<=to_char(p_as_of_date,'YYYY-MM'))
 AND NOT EXISTS(SELECT 1 FROM public.financial_accrual_journals t WHERE t.tenant_id=p_tenant_id AND t.site_id=p_site_id AND t.period<=to_char(p_as_of_date,'YYYY-MM'))
 AND NOT EXISTS(SELECT 1 FROM public.employee_adjustments t WHERE t.tenant_id=p_tenant_id AND t.site_id=p_site_id AND t.disbursed_at<v_cutoff)
 AND NOT EXISTS(SELECT 1 FROM public.financial_gl_entries t WHERE t.tenant_id=p_tenant_id AND t.site_id=p_site_id AND t.period<=to_char(p_as_of_date,'YYYY-MM'));
END;$function$
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
    (jsonb_array_length(p_lines) <> 0 AND jsonb_array_length(p_lines) NOT BETWEEN 2 AND 500) OR
    NOT EXISTS(SELECT 1 FROM public.sites s WHERE s.id=p_site_id
      AND s.tenant_id=p_tenant_id AND s.status<>'archived')
 THEN RAISE EXCEPTION 'GL_OPENING_REQUEST_INVALID' USING ERRCODE='22023'; END IF;
 IF public.powerhub_financial_gl_authorized_actor(p_tenant_id,p_site_id,p_user_id) IS DISTINCT FROM true THEN
 RAISE EXCEPTION 'GL_OPENING_ACTOR_FORBIDDEN' USING ERRCODE='42501'; END IF;
 IF jsonb_array_length(p_lines)=0 AND (
   p_evidence_reference NOT LIKE 'ZERO-OPENING:%' OR
   public.powerhub_financial_gl_zero_opening_preflight(p_tenant_id,p_site_id,p_as_of_date) IS DISTINCT FROM true)
 THEN RAISE EXCEPTION 'GL_ZERO_OPENING_PRIOR_ACTIVITY_OR_MISSING_DECLARATION' USING ERRCODE='23514';END IF;
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
 IF v_debit<>v_credit OR (jsonb_array_length(p_lines)>0 AND v_debit<=0) THEN
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
    'zeroOpening',v_batch.expected_line_count=0,
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
 IF v_count>500 OR v_count<>v_batch.expected_line_count OR v_debit<>v_credit
    OR (v_count>0 AND (v_count<2 OR v_debit<=0))
    OR (v_count=0 AND (v_batch.evidence_reference NOT LIKE 'ZERO-OPENING:%'
      OR public.powerhub_financial_gl_zero_opening_preflight(
         p_tenant_id,p_site_id,v_batch.as_of_date) IS DISTINCT FROM true))
 THEN
   RAISE EXCEPTION 'GL_OPENING_NOT_BALANCED' USING ERRCODE='23514'; END IF;
 UPDATE public.financial_gl_opening_batches
 SET status='posted',approved_by_user_id=p_approver_id,approved_at=now()
 WHERE id=v_batch.id;
 INSERT INTO public.financial_gl_entries
  (tenant_id,site_id,period,source_type,source_id,source_revision,operation_key,
   source_fingerprint,accounting_policy_version,posted_by_user_id)
 VALUES(p_tenant_id,p_site_id,v_batch.period,'opening_balance',v_batch.id::text,1,
   v_key,v_batch.source_fingerprint,CASE WHEN v_batch.expected_line_count=0 THEN 'documented-zero-opening-v1'
 ELSE 'documented-opening-v1' END,p_approver_id)
 RETURNING * INTO v_entry;
 INSERT INTO public.financial_gl_lines(entry_id,tenant_id,site_id,account_code,side,amount)
 SELECT v_entry.id,p_tenant_id,p_site_id,l.account_code,l.side,l.amount
 FROM public.financial_gl_opening_lines l WHERE l.opening_id=v_batch.id
 ORDER BY l.sequence_number;
 RETURN jsonb_build_object('openingId',v_batch.id,'entryId',v_entry.id,
   'zeroOpening',v_batch.expected_line_count=0,
   'status','posted','alreadyPosted',false,'debits',v_debit,'credits',v_credit);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_opening_atomicity_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE v_e bigint;v_expected bigint;v_lines bigint;v_net numeric;v_status text;
BEGIN
 -- Deferred INSERT/UPDATE trigger events may carry old snapshots. Consult the
 -- current persisted state at the end of the transaction.
 SELECT b.status INTO v_status FROM public.financial_gl_opening_batches b
 WHERE b.id=NEW.id AND b.tenant_id=NEW.tenant_id AND b.site_id=NEW.site_id;
 SELECT e.id INTO v_e FROM public.financial_gl_entries e
 WHERE e.tenant_id=NEW.tenant_id AND e.site_id=NEW.site_id
   AND e.source_type='opening_balance' AND e.source_id=NEW.id::text
   AND e.source_revision=1 AND e.source_fingerprint=NEW.source_fingerprint;
 IF v_status='posted' THEN
   IF NEW.expected_line_count=0 THEN
     IF v_e IS NULL
      OR NOT EXISTS(SELECT 1 FROM public.financial_gl_entries e
         WHERE e.id=v_e AND e.tenant_id=NEW.tenant_id AND e.site_id=NEW.site_id
         AND e.accounting_policy_version='documented-zero-opening-v1')
      OR EXISTS(SELECT 1 FROM public.financial_gl_lines l WHERE l.entry_id=v_e)
      OR EXISTS(SELECT 1 FROM public.financial_gl_opening_lines l
         WHERE l.opening_id=NEW.id AND l.tenant_id=NEW.tenant_id AND l.site_id=NEW.site_id)
     THEN RAISE EXCEPTION 'GL_ZERO_OPENING_NOT_ATOMIC' USING ERRCODE='23514';END IF;
     RETURN NULL;
   END IF;
   IF v_e IS NULL THEN RAISE EXCEPTION 'GL_OPENING_POSTING_NOT_ATOMIC'
     USING ERRCODE='23514'; END IF;
   SELECT count(*) INTO v_expected FROM public.financial_gl_opening_lines l
   WHERE l.opening_id=NEW.id AND l.tenant_id=NEW.tenant_id AND l.site_id=NEW.site_id;
   SELECT count(*),coalesce(sum(CASE WHEN side='debit' THEN amount ELSE -amount END),0)
   INTO v_lines,v_net FROM public.financial_gl_lines WHERE entry_id=v_e;
   IF v_lines<2 OR v_lines<>NEW.expected_line_count OR
      v_lines<>v_expected OR v_net<>0 THEN
     RAISE EXCEPTION 'GL_OPENING_POSTING_NOT_BALANCED' USING ERRCODE='23514'; END IF;
   IF EXISTS(
     SELECT account_code,side,amount,count(*) AS n
     FROM public.financial_gl_opening_lines
     WHERE opening_id=NEW.id AND tenant_id=NEW.tenant_id AND site_id=NEW.site_id
     GROUP BY account_code,side,amount
     EXCEPT
     SELECT account_code,side,amount,count(*) AS n
     FROM public.financial_gl_lines WHERE entry_id=v_e
     GROUP BY account_code,side,amount
   ) OR EXISTS(
     SELECT account_code,side,amount,count(*) AS n
     FROM public.financial_gl_lines WHERE entry_id=v_e
     GROUP BY account_code,side,amount
     EXCEPT
     SELECT account_code,side,amount,count(*) AS n
     FROM public.financial_gl_opening_lines
     WHERE opening_id=NEW.id AND tenant_id=NEW.tenant_id AND site_id=NEW.site_id
     GROUP BY account_code,side,amount
   ) THEN
     RAISE EXCEPTION 'GL_OPENING_GL_LINES_MISMATCH' USING ERRCODE='23514';
   END IF;
 ELSIF v_e IS NOT NULL THEN
   RAISE EXCEPTION 'GL_OPENING_UNAPPROVED_GL_EXISTS' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END;$function$
;

CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_balance_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE v_id bigint;v_total numeric;v_count bigint;v_entry public.financial_gl_entries%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME='financial_gl_entries' THEN
    v_id:=NEW.id;
  ELSIF TG_TABLE_NAME='financial_gl_lines' THEN
    v_id:=NEW.entry_id;
  ELSE
    RAISE EXCEPTION 'FINANCIAL_GL_UNKNOWN_TRIGGER_SOURCE' USING ERRCODE='22023';
  END IF;
  SELECT count(*),
    coalesce(sum(CASE WHEN side='debit' THEN amount ELSE -amount END),0)
    INTO v_count,v_total FROM public.financial_gl_lines WHERE entry_id=v_id;
  SELECT * INTO v_entry FROM public.financial_gl_entries WHERE id=v_id;
 IF v_count=0 AND v_total=0 AND v_entry.source_type='opening_balance'
  AND v_entry.accounting_policy_version='documented-zero-opening-v1'
  AND EXISTS(SELECT 1 FROM public.financial_gl_opening_batches b
   WHERE b.tenant_id=v_entry.tenant_id AND b.site_id=v_entry.site_id
   AND b.id::text=v_entry.source_id AND b.status='posted'
   AND b.expected_line_count=0 AND b.source_fingerprint=v_entry.source_fingerprint)
 THEN RETURN NULL;END IF;
 IF v_count<2 OR v_total<>0 THEN
    RAISE EXCEPTION 'FINANCIAL_GL_ENTRY_NOT_BALANCED' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_opening_evidence_status(p_tenant_id bigint, p_site_id bigint, p_period text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE v_batch record;v_missing bigint;v_unverified bigint;v_unsupported bigint;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.sites s WHERE s.tenant_id=p_tenant_id
 AND s.id=p_site_id AND s.status<>'archived')
 OR p_period !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
 THEN RAISE EXCEPTION 'GL_OPENING_EVIDENCE_INVALID_SCOPE'
 USING ERRCODE='22023';END IF;
 SELECT * INTO v_batch FROM public.financial_gl_opening_batches b
 WHERE b.tenant_id=p_tenant_id AND b.site_id=p_site_id
  AND b.status='posted' AND b.as_of_date<=(p_period||'-01')::date
 ORDER BY b.as_of_date,b.id LIMIT 1;
 IF NOT FOUND THEN RETURN jsonb_build_object(
   'status','MISSING_POSTED_OPENING','isIndependentlyReconciled',false,
   'accountBalancesMatchedToOpening',false,
   'sourceSubledgersIndependentlyVerified',false);END IF;
 IF v_batch.expected_line_count=0 THEN
  RETURN jsonb_build_object('openingId',v_batch.id,
   'status','ZERO_OPENING_TECHNICAL_NOT_CERTIFIED',
   'linesWithoutMatchedReviewedEvidence',0,'linesWithUnreviewedEvidence',0,
   'missingExpectedSourceCategory',0,'allLinesAttested',false,
   'accountBalancesMatchedToOpening',false,
   'sourceSubledgersIndependentlyVerified',false,'isIndependentlyReconciled',false);
 END IF;
 WITH a AS (
 SELECT l.id,l.amount,l.side,l.account_code,
   count(e.id) total_count,
   count(e.id) FILTER(WHERE e.review_status='verified') verified_count,
   coalesce(sum(e.supported_amount) FILTER(WHERE e.review_status='verified'),0) evidence_amount,
   count(e.id) FILTER(WHERE e.review_status<>'verified') pending_count
 FROM public.financial_gl_opening_lines l
 LEFT JOIN public.financial_gl_opening_evidence e
 ON e.opening_line_id=l.id AND e.opening_id=l.opening_id
  AND e.tenant_id=l.tenant_id AND e.site_id=l.site_id
 WHERE l.tenant_id=p_tenant_id AND l.site_id=p_site_id
 AND l.opening_id=v_batch.id
 GROUP BY l.id,l.amount,l.side,l.account_code
 )
 SELECT count(*) FILTER(WHERE total_count=0 OR verified_count=0
      OR evidence_amount<>amount),
 count(*) FILTER(WHERE pending_count<>0),
 count(*) FILTER(WHERE account_code IN ('1010','1020','1200','1300','2300','2400')
      AND NOT EXISTS(SELECT 1 FROM public.financial_gl_opening_evidence e
        WHERE e.opening_line_id=a.id AND e.review_status='verified'
        AND e.source_kind IN ('company_account_statement',
         'subscriber_receivable_statement','inventory_valuation_statement',
         'supplier_statement','payroll_liability_statement')))
 INTO v_missing,v_unverified,v_unsupported FROM a;
 -- A reviewed evidence statement is an attestation, not proof that the
 -- underlying independent document was fetched and cryptographically checked.
 -- Thus DO NOT set sourceSubledgersIndependentlyVerified=true based solely
 -- on user-provided hashes. This remains fail closed until a source document
 -- custody and verification module is implemented.
 RETURN jsonb_build_object(
  'openingId',v_batch.id,
  'status',CASE WHEN v_missing=0 AND v_unverified=0 AND v_unsupported=0
    THEN 'EVIDENCE_ATTESTED_DOCUMENT_VERIFICATION_REQUIRED'
    ELSE 'EVIDENCE_MISSING_OR_UNREVIEWED' END,
  'linesWithoutMatchedReviewedEvidence',v_missing,
  'linesWithUnreviewedEvidence',v_unverified,
  'missingExpectedSourceCategory',v_unsupported,
  'allLinesAttested',v_missing=0 AND v_unverified=0 AND v_unsupported=0,
  'sourceSubledgersIndependentlyVerified',false,
  'accountBalancesMatchedToOpening',v_missing=0 AND v_unverified=0 AND v_unsupported=0,
  'isIndependentlyReconciled',false);
END;
$function$
;

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
$function$
;

REVOKE ALL ON FUNCTION public.powerhub_financial_gl_zero_opening_preflight(bigint,bigint,date)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_gl_zero_opening_preflight(bigint,bigint,date)
 TO service_role;
