-- PowerHub GL A2.2: document-backed opening balances, once per tenant/site.
-- Additive forward migration only. No opening balance is manufactured or imported.
-- Requires 20261110010000 for contra-asset chart and transactional posting ACL.
CREATE TABLE public.financial_gl_opening_batches (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES public.tenants(id),
  site_id bigint NOT NULL REFERENCES public.sites(id),
  as_of_date date NOT NULL,
  period text GENERATED ALWAYS AS (
    extract(year from as_of_date)::integer::text || '-' ||
    lpad(extract(month from as_of_date)::integer::text,2,'0')
  ) STORED,
  evidence_reference text NOT NULL CHECK(length(btrim(evidence_reference)) BETWEEN 8 AND 250),
  description text NOT NULL CHECK(length(btrim(description)) BETWEEN 10 AND 1000),
  operation_key text NOT NULL CHECK(length(btrim(operation_key)) BETWEEN 8 AND 180),
  source_fingerprint text NOT NULL CHECK(source_fingerprint ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','posted','void')),
  created_by_user_id bigint NOT NULL REFERENCES public.users(id),
  approved_by_user_id bigint REFERENCES public.users(id),
  voided_by_user_id bigint REFERENCES public.users(id),
  void_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  voided_at timestamptz,
  CONSTRAINT financial_gl_opening_batch_scope UNIQUE(id,tenant_id,site_id),
  CONSTRAINT financial_gl_opening_operation_key UNIQUE(tenant_id,site_id,operation_key),
  CONSTRAINT financial_gl_opening_approval_sep CHECK(
    (status='posted' AND approved_at IS NOT NULL
      AND approved_by_user_id IS NOT NULL
      AND approved_by_user_id<>created_by_user_id)
    OR (status<>'posted' AND approved_at IS NULL AND approved_by_user_id IS NULL)),
  CONSTRAINT financial_gl_opening_void_fields CHECK(
    (status='void' AND voided_by_user_id IS NOT NULL
      AND voided_at IS NOT NULL AND length(btrim(void_reason))>=10)
    OR (status<>'void' AND voided_by_user_id IS NULL
      AND void_reason IS NULL AND voided_at IS NULL))
);
-- One active opening per site, regardless of year. Voided drafts retain audit
-- history without blocking replacement under a fresh operation key.
CREATE UNIQUE INDEX financial_gl_one_active_opening_per_site
 ON public.financial_gl_opening_batches(tenant_id,site_id)
 WHERE status<>'void';
CREATE TABLE public.financial_gl_opening_lines (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  opening_id bigint NOT NULL,
  tenant_id bigint NOT NULL,
  site_id bigint NOT NULL,
  sequence_number integer NOT NULL CHECK(sequence_number BETWEEN 1 AND 500),
  account_code text NOT NULL,
  side text NOT NULL CHECK(side IN ('debit','credit')),
  amount numeric(18,2) NOT NULL CHECK(amount>0),
  evidence_reference text NOT NULL CHECK(length(btrim(evidence_reference)) BETWEEN 3 AND 250),
  CONSTRAINT financial_gl_opening_line_unique UNIQUE(opening_id,sequence_number),
  CONSTRAINT financial_gl_opening_line_batch_scope FOREIGN KEY(opening_id,tenant_id,site_id)
    REFERENCES public.financial_gl_opening_batches(id,tenant_id,site_id),
  CONSTRAINT financial_gl_opening_line_account FOREIGN KEY(tenant_id,account_code)
    REFERENCES public.financial_gl_accounts(tenant_id,code)
);
CREATE INDEX financial_gl_opening_line_lookup
 ON public.financial_gl_opening_lines(tenant_id,site_id,opening_id);

CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_opening_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $guard$
BEGIN
 IF TG_OP='TRUNCATE' OR TG_OP='DELETE' THEN
   RAISE EXCEPTION 'GL_OPENING_IMMUTABLE' USING ERRCODE='22023';
 END IF;
 IF TG_OP='UPDATE' THEN
   IF OLD.status<>'draft'
     OR NEW.status NOT IN ('posted','void')
     OR ROW(NEW.id,NEW.tenant_id,NEW.site_id,NEW.as_of_date,
         NEW.evidence_reference,NEW.description,NEW.operation_key,
         NEW.source_fingerprint,NEW.created_by_user_id,NEW.created_at)
        IS DISTINCT FROM
        ROW(OLD.id,OLD.tenant_id,OLD.site_id,OLD.as_of_date,
         OLD.evidence_reference,OLD.description,OLD.operation_key,
         OLD.source_fingerprint,OLD.created_by_user_id,OLD.created_at)
   THEN RAISE EXCEPTION 'GL_OPENING_IMMUTABLE' USING ERRCODE='22023'; END IF;
 END IF;
 RETURN NEW;
END;
$guard$;
CREATE TRIGGER financial_gl_opening_batch_guard
 BEFORE UPDATE OR DELETE ON public.financial_gl_opening_batches
 FOR EACH ROW EXECUTE FUNCTION public.powerhub_financial_gl_opening_guard();
CREATE TRIGGER financial_gl_opening_batch_truncate
 BEFORE TRUNCATE ON public.financial_gl_opening_batches
 FOR EACH STATEMENT EXECUTE FUNCTION public.powerhub_financial_gl_opening_guard();
CREATE TRIGGER financial_gl_opening_lines_immutable
 BEFORE UPDATE OR DELETE OR TRUNCATE ON public.financial_gl_opening_lines
 FOR EACH STATEMENT EXECUTE FUNCTION public.powerhub_financial_gl_immutable_guard();

ALTER TABLE public.financial_gl_opening_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.financial_gl_opening_lines ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.financial_gl_opening_batches FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON public.financial_gl_opening_lines FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE ON public.financial_gl_opening_batches TO service_role;
GRANT SELECT,INSERT ON public.financial_gl_opening_lines TO service_role;
GRANT USAGE,SELECT ON SEQUENCE public.financial_gl_opening_batches_id_seq TO service_role;
GRANT USAGE,SELECT ON SEQUENCE public.financial_gl_opening_lines_id_seq TO service_role;

-- Default catalog. Only deterministic classifications; existing mismatches
-- cause explicit failure rather than upsert/rewrite of financial history.
CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_seed_chart(p_tenant_id bigint)
RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $seed$
DECLARE v_count integer;
BEGIN
 IF p_tenant_id IS NULL OR NOT EXISTS(
   SELECT 1 FROM public.tenants t WHERE t.id=p_tenant_id) THEN
   RAISE EXCEPTION 'GL_CHART_TENANT_INVALID' USING ERRCODE='22023'; END IF;
 WITH specs(code,name,cls,side,contra) AS (
 VALUES
 ('1010','الصندوق','asset','debit',false),
 ('1020','البنوك والمحافظ الإلكترونية','asset','debit',false),
 ('1100','خدمة مستحقة غير مفوترة','asset','debit',false),
 ('1190','مخصص الديون المشكوك في تحصيلها','asset','credit',true),
 ('1200','ذمم المشتركين','asset','debit',false),
 ('1300','المخزون والوقود','asset','debit',false),
 ('1400','الأصول الثابتة بالتكلفة','asset','debit',false),
 ('1500','مجمع إهلاك الأصول','asset','credit',true),
 ('1600','مصروفات مدفوعة مقدما','asset','debit',false),
 ('1700','السلف المستحقة','asset','debit',false),
 ('2100','المصروفات المستحقة','liability','credit',false),
 ('2200','الإيرادات المؤجلة','liability','credit',false),
 ('2300','ذمم الموردين','liability','credit',false),
 ('2400','الرواتب المستحقة','liability','credit',false),
 ('2500','الضرائب المستحقة','liability','credit',false),
 ('3100','رأس المال','equity','credit',false),
 ('3200','الأرباح المحتجزة','equity','credit',false),
 ('4100','إيراد خدمات الكهرباء','revenue','credit',false),
 ('5100','تكلفة خدمات التشغيل','expense','debit',false),
 ('5200','الأجور والرواتب','expense','debit',false),
 ('5300','مصروف الإهلاك','expense','debit',false),
 ('5400','مصروف مخصص الديون','expense','debit',false),
 ('6100','مصروفات غير تشغيلية','expense','debit',false)
 )
 INSERT INTO public.financial_gl_accounts(tenant_id,code,name,account_class,normal_side,is_contra)
 SELECT p_tenant_id,code,name,cls,side,contra FROM specs
 ON CONFLICT(tenant_id,code) DO NOTHING;
 WITH specs(code,cls,side,contra) AS (
 VALUES
 ('1010','asset','debit',false),('1020','asset','debit',false),
 ('1100','asset','debit',false),('1190','asset','credit',true),
 ('1200','asset','debit',false),('1300','asset','debit',false),
 ('1400','asset','debit',false),('1500','asset','credit',true),
 ('1600','asset','debit',false),('1700','asset','debit',false),
 ('2100','liability','credit',false),('2200','liability','credit',false),
 ('2300','liability','credit',false),('2400','liability','credit',false),
 ('2500','liability','credit',false),('3100','equity','credit',false),
 ('3200','equity','credit',false),('4100','revenue','credit',false),
 ('5100','expense','debit',false),('5200','expense','debit',false),
 ('5300','expense','debit',false),('5400','expense','debit',false),
 ('6100','expense','debit',false)
 )
 SELECT count(*) INTO v_count FROM specs s
 LEFT JOIN public.financial_gl_accounts a ON a.tenant_id=p_tenant_id AND a.code=s.code
 WHERE a.code IS NULL OR a.account_class<>s.cls OR a.normal_side<>s.side
   OR a.is_contra<>s.contra;
 IF v_count>0 THEN RAISE EXCEPTION 'GL_ACCOUNT_CATALOG_CONFLICT' USING ERRCODE='23514'; END IF;
 RETURN 23;
END;
$seed$;

CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_opening_create(
 p_tenant_id bigint,p_site_id bigint,p_user_id bigint,p_as_of_date date,
 p_evidence_reference text,p_description text,p_operation_key text,p_lines jsonb
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $create$
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
 v_period:=to_char(p_as_of_date,'YYYY-MM');
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
   source_fingerprint,created_by_user_id)
 VALUES(p_tenant_id,p_site_id,p_as_of_date,btrim(p_evidence_reference),
   btrim(p_description),p_operation_key,v_fingerprint,p_user_id)
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
$create$;

CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_opening_post(
 p_tenant_id bigint,p_site_id bigint,p_opening_id bigint,p_approver_id bigint
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $post$
DECLARE v_batch public.financial_gl_opening_batches%ROWTYPE;
 v_entry public.financial_gl_entries%ROWTYPE;v_debit numeric;v_credit numeric;
 v_count bigint;v_key text;v_period text;
BEGIN
 IF p_tenant_id IS NULL OR p_site_id IS NULL OR p_opening_id IS NULL OR
   p_approver_id IS NULL OR p_approver_id<=0 THEN
   RAISE EXCEPTION 'GL_OPENING_POST_INVALID' USING ERRCODE='22023'; END IF;
 SELECT b.period INTO v_period FROM public.financial_gl_opening_batches b
 WHERE b.id=p_opening_id AND b.tenant_id=p_tenant_id AND b.site_id=p_site_id;
 IF v_period IS NULL THEN RAISE EXCEPTION 'GL_OPENING_OUT_OF_SCOPE' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(
   'powerhub:accrual-period:'||p_tenant_id||':'||p_site_id||':'||v_period,0));
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
 IF v_count<2 OR v_count>500 OR v_debit<=0 OR v_debit<>v_credit THEN
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
$post$;

CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_opening_void(
 p_tenant_id bigint,p_site_id bigint,p_opening_id bigint,p_actor_id bigint,p_reason text
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $void$
DECLARE b public.financial_gl_opening_batches%ROWTYPE;
BEGIN
 IF p_actor_id IS NULL OR length(btrim(coalesce(p_reason,''))) NOT BETWEEN 10 AND 1000 THEN
   RAISE EXCEPTION 'GL_OPENING_VOID_REQUEST_INVALID' USING ERRCODE='22023'; END IF;
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
$void$;

REVOKE ALL ON FUNCTION public.powerhub_financial_gl_opening_guard()
 FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.powerhub_financial_gl_seed_chart(bigint)
 FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.powerhub_financial_gl_opening_create(bigint,bigint,bigint,date,text,text,text,jsonb)
 FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.powerhub_financial_gl_opening_post(bigint,bigint,bigint,bigint)
 FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.powerhub_financial_gl_opening_void(bigint,bigint,bigint,bigint,text)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_gl_seed_chart(bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_gl_opening_create(bigint,bigint,bigint,date,text,text,text,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_gl_opening_post(bigint,bigint,bigint,bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_gl_opening_void(bigint,bigint,bigint,bigint,text) TO service_role;
COMMENT ON TABLE public.financial_gl_opening_batches IS
 'Documented tenant/site opening balance with distinct maker and approver. No legacy import or fabricated balances.';
NOTIFY pgrst,'reload schema';
