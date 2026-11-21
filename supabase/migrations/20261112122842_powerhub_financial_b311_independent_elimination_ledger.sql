-- B3.11 independent consolidation elimination records. This is not posted into any branch GL.
CREATE TABLE IF NOT EXISTS public.financial_gl_inter_site_eliminations (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 tenant_id bigint NOT NULL REFERENCES public.tenants(id),
 from_site_id bigint NOT NULL REFERENCES public.sites(id),
 to_site_id bigint NOT NULL REFERENCES public.sites(id),
 source_primary_id bigint NOT NULL,
 operation_key uuid NOT NULL,
 period text NOT NULL CHECK(period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
 from_gl_entry_id bigint NOT NULL,
 to_gl_entry_id bigint NOT NULL,
 amount numeric(18,2) NOT NULL CHECK(amount>0),
 source_fingerprint text NOT NULL CHECK(source_fingerprint ~ '^[0-9a-f]{64}$'),
 evidence_reference text NOT NULL CHECK(length(btrim(evidence_reference)) BETWEEN 8 AND 250),
 status text NOT NULL DEFAULT 'draft' CHECK(status IN('draft','approved')),
 prepared_by_user_id bigint NOT NULL REFERENCES public.users(id),
 approved_by_user_id bigint REFERENCES public.users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 approved_at timestamptz,
 CONSTRAINT financial_gl_inter_site_sites_distinct CHECK(from_site_id<>to_site_id),
 CONSTRAINT financial_gl_inter_site_approval_independent CHECK (
  (status='draft' AND approved_by_user_id IS NULL AND approved_at IS NULL)
  OR (status='approved' AND approved_by_user_id IS NOT NULL
   AND approved_by_user_id<>prepared_by_user_id AND approved_at IS NOT NULL)),
 CONSTRAINT financial_gl_inter_site_source_once UNIQUE(tenant_id,source_primary_id),
 CONSTRAINT financial_gl_inter_site_operation_once UNIQUE(tenant_id,operation_key),
 CONSTRAINT financial_gl_inter_site_from_gl_once UNIQUE(from_gl_entry_id),
 CONSTRAINT financial_gl_inter_site_to_gl_once UNIQUE(to_gl_entry_id)
);
CREATE INDEX IF NOT EXISTS financial_gl_inter_site_period_idx ON
 public.financial_gl_inter_site_eliminations(tenant_id,period,status,source_primary_id);
ALTER TABLE public.financial_gl_inter_site_eliminations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.financial_gl_inter_site_eliminations FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE ON public.financial_gl_inter_site_eliminations TO service_role;
GRANT USAGE,SELECT ON SEQUENCE public.financial_gl_inter_site_eliminations_id_seq TO service_role;

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
 RETURN jsonb_build_object('eliminationId',rowdata.id,'status','draft',
  'alreadyPrepared',false,'accountingCertification','NOT_CERTIFIED');
END;$function$;
CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_inter_site_elimination_proof(pt bigint, ps bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE op public.company_account_movement_operations%ROWTYPE;
 a public.account_transactions%ROWTYPE;b public.account_transactions%ROWTYPE;
 ca public.company_accounts%ROWTYPE;cb public.company_accounts%ROWTYPE;
 x public.financial_gl_entries%ROWTYPE;y public.financial_gl_entries%ROWTYPE;
 fp text;per text;code_a text;code_b text;
BEGIN
 SELECT * INTO op FROM public.company_account_movement_operations
 WHERE tenant_id=pt AND primary_transaction_id=ps AND operation_type='transfer';
 IF op.primary_transaction_id IS NULL OR op.counterpart_transaction_id IS NULL
 THEN RAISE EXCEPTION 'GL_B311_SOURCE_NOT_FOUND' USING ERRCODE='22023';END IF;
 SELECT * INTO a FROM public.account_transactions WHERE tenant_id=pt AND id=ps;
 SELECT * INTO b FROM public.account_transactions WHERE tenant_id=pt AND id=op.counterpart_transaction_id;
 IF a.id IS NULL OR b.id IS NULL OR a.site_id IS NULL OR b.site_id IS NULL
 OR a.site_id=b.site_id OR a.site_id<>op.site_id
 OR a.transaction_type<>'transfer_out' OR b.transaction_type<>'transfer_in'
 OR a.amount IS DISTINCT FROM b.amount OR a.amount<=0 OR a.amount<>round(a.amount,2)
 OR a.related_account_id IS DISTINCT FROM b.account_id
 OR b.related_account_id IS DISTINCT FROM a.account_id
 OR a.created_by_user_id IS DISTINCT FROM op.created_by_user_id
 OR b.created_by_user_id IS DISTINCT FROM op.created_by_user_id
 OR a.description IS DISTINCT FROM b.description
 OR to_char(a.occurred_at AT TIME ZONE 'Asia/Gaza','YYYY-MM')
   IS DISTINCT FROM to_char(b.occurred_at AT TIME ZONE 'Asia/Gaza','YYYY-MM')
 OR NOT EXISTS(SELECT 1 FROM generate_series(0,6) g(scale)
  WHERE op.payload_hash=md5(jsonb_build_object('tenantId',pt,'siteId',op.site_id,
   'userId',op.created_by_user_id,'fromAccountId',a.account_id,
   'toAccountId',b.account_id,'amount',round(a.amount,g.scale),
   'description',btrim(a.description))::text))
 THEN RAISE EXCEPTION 'GL_B311_SOURCE_PAIR_INVALID' USING ERRCODE='22023';END IF;
 SELECT * INTO ca FROM public.company_accounts WHERE tenant_id=pt AND id=a.account_id;
 SELECT * INTO cb FROM public.company_accounts WHERE tenant_id=pt AND id=b.account_id;
 IF ca.id IS NULL OR cb.id IS NULL
 OR (SELECT count(*) FROM public.company_account_sites WHERE tenant_id=pt AND account_id=ca.id)<>1
 OR (SELECT count(*) FROM public.company_account_sites WHERE tenant_id=pt AND account_id=cb.id)<>1
 OR NOT EXISTS(SELECT 1 FROM public.company_account_sites WHERE tenant_id=pt AND account_id=ca.id AND site_id=a.site_id)
 OR NOT EXISTS(SELECT 1 FROM public.company_account_sites WHERE tenant_id=pt AND account_id=cb.id AND site_id=b.site_id)
 THEN RAISE EXCEPTION 'GL_B311_SITE_ACCOUNT_SCOPE_INVALID' USING ERRCODE='22023';END IF;
 per:=to_char(a.occurred_at AT TIME ZONE 'Asia/Gaza','YYYY-MM');
 fp:=encode(extensions.digest(jsonb_build_object('key',op.operation_key,
  'payloadHash',op.payload_hash,'sourceId',a.id,'destinationId',b.id,
  'fromSite',a.site_id,'toSite',b.site_id,
  'fromAccount',a.account_id,'toAccount',b.account_id,
  'amount',a.amount,'period',per)::text,'sha256'),'hex');
 SELECT * INTO x FROM public.financial_gl_entries WHERE tenant_id=pt AND site_id=a.site_id
  AND source_type='account_movement' AND source_id=a.id::text;
 SELECT * INTO y FROM public.financial_gl_entries WHERE tenant_id=pt AND site_id=b.site_id
  AND source_type='account_movement' AND source_id=b.id::text;
 code_a:=CASE WHEN ca.account_type='cash' THEN '1010' ELSE '1020' END;
 code_b:=CASE WHEN cb.account_type='cash' THEN '1010' ELSE '1020' END;
 IF x.id IS NULL OR y.id IS NULL OR x.period<>per OR y.period<>per
 OR x.source_fingerprint<>fp OR y.source_fingerprint<>fp
 OR x.accounting_policy_version<>'inter-site-due-from-to-v1'
 OR y.accounting_policy_version<>'inter-site-due-from-to-v1'
 OR x.posted_by_user_id IS DISTINCT FROM y.posted_by_user_id
 OR x.posted_by_user_id IS NOT DISTINCT FROM op.created_by_user_id
 OR (SELECT count(*) FROM public.financial_gl_lines WHERE entry_id=x.id)<>2
 OR (SELECT count(*) FROM public.financial_gl_lines WHERE entry_id=y.id)<>2
 OR NOT EXISTS(SELECT 1 FROM public.financial_gl_lines WHERE entry_id=x.id AND account_code='1350' AND side='debit' AND amount=a.amount)
 OR NOT EXISTS(SELECT 1 FROM public.financial_gl_lines WHERE entry_id=x.id AND account_code=code_a AND side='credit' AND amount=a.amount)
 OR NOT EXISTS(SELECT 1 FROM public.financial_gl_lines WHERE entry_id=y.id AND account_code=code_b AND side='debit' AND amount=a.amount)
 OR NOT EXISTS(SELECT 1 FROM public.financial_gl_lines WHERE entry_id=y.id AND account_code='2350' AND side='credit' AND amount=a.amount)
 THEN RAISE EXCEPTION 'GL_B311_GL_PAIR_INVALID_OR_UNPOSTED' USING ERRCODE='23514';END IF;
 RETURN jsonb_build_object('tenantId',pt,'sourceId',ps,'fromSiteId',a.site_id,
  'toSiteId',b.site_id,'period',per,'amount',a.amount,
  'fromEntryId',x.id,'toEntryId',y.id,'fingerprint',fp,
  'sourceMakerId',op.created_by_user_id,'glCheckerId',x.posted_by_user_id);
END;$function$;
DROP TRIGGER IF EXISTS financial_gl_inter_site_elimination_immutable
 ON public.financial_gl_inter_site_eliminations;
CREATE TRIGGER financial_gl_inter_site_elimination_immutable
 BEFORE UPDATE OR DELETE ON public.financial_gl_inter_site_eliminations
 FOR EACH ROW EXECUTE FUNCTION public.powerhub_financial_gl_inter_site_elimination_immutability();
REVOKE ALL ON FUNCTION public.powerhub_financial_gl_inter_site_elimination_immutability() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_gl_inter_site_elimination_immutability() TO service_role;
REVOKE ALL ON FUNCTION public.powerhub_financial_gl_inter_site_elimination_proof(bigint,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_gl_inter_site_elimination_proof(bigint,bigint) TO service_role;
REVOKE ALL ON FUNCTION public.powerhub_financial_gl_inter_site_elimination_prepare(bigint,bigint,bigint,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_gl_inter_site_elimination_prepare(bigint,bigint,bigint,text,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.powerhub_financial_gl_inter_site_elimination_approve(bigint,bigint,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_gl_inter_site_elimination_approve(bigint,bigint,bigint) TO service_role;
