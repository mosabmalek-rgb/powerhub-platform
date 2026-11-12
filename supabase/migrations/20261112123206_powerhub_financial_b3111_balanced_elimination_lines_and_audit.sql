-- B3.11.1 actual Staging SQL: two persistent, immutable, balanced
-- consolidation elimination lines, independent approvals and audit.
CREATE TABLE IF NOT EXISTS public.financial_gl_inter_site_elimination_lines (
 elimination_id bigint NOT NULL REFERENCES public.financial_gl_inter_site_eliminations(id),
 tenant_id bigint NOT NULL REFERENCES public.tenants(id),
 sequence_no integer NOT NULL CHECK(sequence_no IN(1,2)),
 account_code text NOT NULL CHECK(account_code IN('1350','2350')),
 side text NOT NULL CHECK(side IN('debit','credit')),
 amount numeric(18,2) NOT NULL CHECK(amount>0),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(elimination_id,sequence_no),
 UNIQUE(elimination_id,account_code)
);
CREATE INDEX IF NOT EXISTS financial_gl_inter_site_lines_tenant_idx ON
 public.financial_gl_inter_site_elimination_lines(tenant_id,elimination_id);
ALTER TABLE public.financial_gl_inter_site_elimination_lines ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.financial_gl_inter_site_elimination_lines FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT ON public.financial_gl_inter_site_elimination_lines TO service_role;
CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_inter_site_elimination_approve(pt bigint, elimination_id bigint, checker bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE d public.financial_gl_inter_site_eliminations%ROWTYPE;proof jsonb;
BEGIN
 IF pt IS NULL OR pt<=0 OR elimination_id IS NULL OR elimination_id<=0
  OR checker IS NULL OR checker<=0
 THEN RAISE EXCEPTION 'GL_B311_APPROVE_INVALID' USING ERRCODE='22023';END IF;
 SELECT * INTO d FROM public.financial_gl_inter_site_eliminations
 WHERE tenant_id=pt AND id=elimination_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'GL_B311_DRAFT_NOT_FOUND' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(
   'powerhub:gl-inter-site-elimination:'||pt||':'||d.source_primary_id,0));
 SELECT * INTO d FROM public.financial_gl_inter_site_eliminations
 WHERE tenant_id=pt AND id=elimination_id FOR UPDATE;
 IF checker=d.prepared_by_user_id
 OR public.powerhub_financial_gl_authorized_actor(pt,d.from_site_id,checker) IS DISTINCT FROM true
 OR public.powerhub_financial_gl_authorized_actor(pt,d.to_site_id,checker) IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'GL_B311_REVIEWER_NOT_INDEPENDENT_OR_AUTHORIZED' USING ERRCODE='42501'; END IF;
 proof:=public.powerhub_financial_gl_inter_site_elimination_proof(pt,d.source_primary_id);
 IF d.from_site_id<>(proof->>'fromSiteId')::bigint
 OR d.to_site_id<>(proof->>'toSiteId')::bigint
 OR d.from_gl_entry_id<>(proof->>'fromEntryId')::bigint
 OR d.to_gl_entry_id<>(proof->>'toEntryId')::bigint
 OR d.amount<>(proof->>'amount')::numeric
 OR d.period<>proof->>'period' OR d.source_fingerprint<>proof->>'fingerprint'
 THEN RAISE EXCEPTION 'GL_B311_SOURCE_CHANGED_DURING_REVIEW' USING ERRCODE='23514';END IF;
 IF (SELECT count(*) FROM public.financial_gl_inter_site_elimination_lines eli
    WHERE eli.elimination_id=d.id AND eli.tenant_id=pt)<>2
 OR NOT EXISTS (SELECT 1 FROM public.financial_gl_inter_site_elimination_lines eli
    WHERE eli.elimination_id=d.id AND eli.tenant_id=pt AND sequence_no=1
    AND account_code='2350' AND side='debit' AND amount=d.amount)
 OR NOT EXISTS (SELECT 1 FROM public.financial_gl_inter_site_elimination_lines eli
    WHERE eli.elimination_id=d.id AND eli.tenant_id=pt AND sequence_no=2
    AND account_code='1350' AND side='credit' AND amount=d.amount)
 THEN RAISE EXCEPTION 'GL_B311_ELIMINATION_LINES_UNBALANCED' USING ERRCODE='23514';END IF;
  IF d.status='approved' THEN
   IF d.approved_by_user_id<>checker
   THEN RAISE EXCEPTION 'GL_B311_APPROVAL_REPLAY_CONFLICT' USING ERRCODE='23505';END IF;
   RETURN jsonb_build_object('eliminationId',d.id,'status','approved',
    'alreadyApproved',true,'amount',d.amount,'accountingCertification','NOT_CERTIFIED');
 END IF;
 IF d.status<>'draft'
 THEN RAISE EXCEPTION 'GL_B311_STATUS_NOT_APPROVABLE' USING ERRCODE='22023';END IF;
 UPDATE public.financial_gl_inter_site_eliminations SET status='approved',
 approved_by_user_id=checker,approved_at=now() WHERE id=d.id
 RETURNING * INTO d;
 INSERT INTO public.audit_logs
  (tenant_id,site_id,user_id,entity_type,entity_id,action,after_data,metadata)
 VALUES(pt,d.from_site_id,checker,'financial_gl_inter_site_elimination',
  d.id::text,'GL_B311_CONSOLIDATION_ELIMINATION_APPROVED',
  jsonb_build_object('sourceId',d.source_primary_id,'toSiteId',d.to_site_id,
   'amount',d.amount,'status','approved','accountingCertification','NOT_CERTIFIED'),
  jsonb_build_object('independentFromPreparer',true,'doesNotPostSiteGL',true));
 RETURN jsonb_build_object('eliminationId',d.id,'status','approved',
   'alreadyApproved',false,'amount',d.amount,'entryCodes',jsonb_build_array(
    jsonb_build_object('code','2350','side','debit','amount',d.amount),
    jsonb_build_object('code','1350','side','credit','amount',d.amount)),
   'doesNotPostSiteGL',true,'accountingCertification','NOT_CERTIFIED');
END;$function$;
CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_inter_site_elimination_immutability()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
 IF TG_OP<>'UPDATE' OR OLD.status<>'draft' OR NEW.status<>'approved'
 OR ROW(NEW.tenant_id,NEW.from_site_id,NEW.to_site_id,
  NEW.source_primary_id,NEW.operation_key,NEW.period,NEW.from_gl_entry_id,
  NEW.to_gl_entry_id,NEW.amount,NEW.source_fingerprint,NEW.evidence_reference,
  NEW.prepared_by_user_id,NEW.created_at)
 IS DISTINCT FROM
 ROW(OLD.tenant_id,OLD.from_site_id,OLD.to_site_id,
  OLD.source_primary_id,OLD.operation_key,OLD.period,OLD.from_gl_entry_id,
  OLD.to_gl_entry_id,OLD.amount,OLD.source_fingerprint,OLD.evidence_reference,
  OLD.prepared_by_user_id,OLD.created_at)
 THEN RAISE EXCEPTION 'GL_B311_ELIMINATION_IMMUTABLE' USING ERRCODE='22023'; END IF;
 IF (SELECT count(*) FROM public.financial_gl_inter_site_elimination_lines
      WHERE elimination_id=NEW.id AND tenant_id=NEW.tenant_id)<>2
 OR NOT EXISTS(SELECT 1 FROM public.financial_gl_inter_site_elimination_lines
    WHERE elimination_id=NEW.id AND tenant_id=NEW.tenant_id AND sequence_no=1
    AND account_code='2350' AND side='debit' AND amount=NEW.amount)
 OR NOT EXISTS(SELECT 1 FROM public.financial_gl_inter_site_elimination_lines
    WHERE elimination_id=NEW.id AND tenant_id=NEW.tenant_id AND sequence_no=2
    AND account_code='1350' AND side='credit' AND amount=NEW.amount)
 THEN RAISE EXCEPTION 'GL_B311_ELIMINATION_LINES_UNBALANCED' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;$function$;
CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_inter_site_elimination_prepare(pt bigint, ps bigint, actor bigint, evidence text, opkey uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE proof jsonb;rowdata public.financial_gl_inter_site_eliminations%ROWTYPE;
BEGIN
 IF pt IS NULL OR pt<=0 OR ps IS NULL OR ps<=0 OR actor IS NULL OR actor<=0
 OR opkey IS NULL OR length(btrim(coalesce(evidence,''))) NOT BETWEEN 8 AND 250
 THEN RAISE EXCEPTION 'GL_B311_PREPARE_INVALID' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(
   'powerhub:gl-inter-site-elimination:'||pt||':'||ps,0));
 proof:=public.powerhub_financial_gl_inter_site_elimination_proof(pt,ps);
 IF public.powerhub_financial_gl_authorized_actor(pt,(proof->>'fromSiteId')::bigint,actor) IS DISTINCT FROM true
 OR public.powerhub_financial_gl_authorized_actor(pt,(proof->>'toSiteId')::bigint,actor) IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'GL_B311_PREPARER_FORBIDDEN' USING ERRCODE='42501';END IF;
 SELECT * INTO rowdata FROM public.financial_gl_inter_site_eliminations
 WHERE tenant_id=pt AND source_primary_id=ps FOR UPDATE;
 IF FOUND THEN
  IF rowdata.operation_key<>opkey OR rowdata.prepared_by_user_id<>actor
   OR rowdata.evidence_reference<>btrim(evidence)
   OR rowdata.source_fingerprint<>proof->>'fingerprint'
   OR rowdata.from_gl_entry_id<>(proof->>'fromEntryId')::bigint
   OR rowdata.to_gl_entry_id<>(proof->>'toEntryId')::bigint
   OR rowdata.amount<>(proof->>'amount')::numeric
  THEN RAISE EXCEPTION 'GL_B311_PREPARE_REPLAY_CONFLICT' USING ERRCODE='23505';END IF;
  RETURN jsonb_build_object('eliminationId',rowdata.id,'status',rowdata.status,
   'alreadyPrepared',true,'accountingCertification','NOT_CERTIFIED');
 END IF;
 INSERT INTO public.financial_gl_inter_site_eliminations(
 tenant_id,from_site_id,to_site_id,source_primary_id,operation_key,period,
 from_gl_entry_id,to_gl_entry_id,amount,source_fingerprint,evidence_reference,
 prepared_by_user_id)
 VALUES(pt,(proof->>'fromSiteId')::bigint,(proof->>'toSiteId')::bigint,ps,opkey,
 proof->>'period',(proof->>'fromEntryId')::bigint,(proof->>'toEntryId')::bigint,
 (proof->>'amount')::numeric,proof->>'fingerprint',btrim(evidence),actor)
 RETURNING * INTO rowdata;
 INSERT INTO public.financial_gl_inter_site_elimination_lines
  (elimination_id,tenant_id,sequence_no,account_code,side,amount)
 VALUES(rowdata.id,pt,1,'2350','debit',rowdata.amount),
       (rowdata.id,pt,2,'1350','credit',rowdata.amount);
 INSERT INTO public.audit_logs
  (tenant_id,site_id,user_id,entity_type,entity_id,action,after_data,metadata)
 VALUES(pt,rowdata.from_site_id,actor,'financial_gl_inter_site_elimination',
  rowdata.id::text,'GL_B311_CONSOLIDATION_ELIMINATION_PREPARED',
  jsonb_build_object('sourceId',ps,'toSiteId',rowdata.to_site_id,
   'amount',rowdata.amount,'status','draft','accountingCertification','NOT_CERTIFIED'),
  jsonb_build_object('isIndependentReviewPending',true,
   'doesNotPostSiteGL',true));
 RETURN jsonb_build_object('eliminationId',rowdata.id,'status','draft',
  'alreadyPrepared',false,'accountingCertification','NOT_CERTIFIED');
END;$function$;
CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_inter_site_line_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE x public.financial_gl_inter_site_eliminations%ROWTYPE;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'GL_B311_ELIMINATION_LINE_IMMUTABLE' USING ERRCODE='22023';END IF;
 SELECT * INTO x FROM public.financial_gl_inter_site_eliminations
 WHERE id=NEW.elimination_id AND tenant_id=NEW.tenant_id FOR SHARE;
 IF x.id IS NULL OR x.status<>'draft' OR NEW.amount IS DISTINCT FROM x.amount
 OR NOT ((NEW.sequence_no=1 AND NEW.account_code='2350' AND NEW.side='debit')
  OR (NEW.sequence_no=2 AND NEW.account_code='1350' AND NEW.side='credit'))
 THEN RAISE EXCEPTION 'GL_B311_ELIMINATION_LINE_INVALID' USING ERRCODE='22023'; END IF;
 RETURN NEW;
END;$function$;
DROP TRIGGER IF EXISTS financial_gl_inter_site_line_insert_guard ON public.financial_gl_inter_site_elimination_lines;
CREATE TRIGGER financial_gl_inter_site_line_insert_guard BEFORE INSERT ON public.financial_gl_inter_site_elimination_lines
 FOR EACH ROW EXECUTE FUNCTION public.powerhub_financial_gl_inter_site_line_guard();
DROP TRIGGER IF EXISTS financial_gl_inter_site_line_immutable ON public.financial_gl_inter_site_elimination_lines;
CREATE TRIGGER financial_gl_inter_site_line_immutable BEFORE UPDATE OR DELETE ON public.financial_gl_inter_site_elimination_lines
 FOR EACH ROW EXECUTE FUNCTION public.powerhub_financial_gl_inter_site_line_guard();
REVOKE ALL ON FUNCTION public.powerhub_financial_gl_inter_site_elimination_prepare(bigint,bigint,bigint,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_gl_inter_site_elimination_prepare(bigint,bigint,bigint,text,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.powerhub_financial_gl_inter_site_elimination_approve(bigint,bigint,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_gl_inter_site_elimination_approve(bigint,bigint,bigint) TO service_role;
REVOKE ALL ON FUNCTION public.powerhub_financial_gl_inter_site_elimination_immutability() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_gl_inter_site_elimination_immutability() TO service_role;
REVOKE ALL ON FUNCTION public.powerhub_financial_gl_inter_site_line_guard() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_gl_inter_site_line_guard() TO service_role;
