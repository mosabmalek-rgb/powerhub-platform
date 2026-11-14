-- B2: central management allocation policy. No automatic GL entries.
CREATE TABLE public.financial_gl_central_allocation_policies(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 tenant_id bigint NOT NULL REFERENCES public.tenants(id),
 central_site_id bigint NOT NULL REFERENCES public.sites(id),
 period text NOT NULL CHECK(period~'^[0-9]{4}-(0[1-9]|1[0-2])$'),
 source_entry_ids bigint[] NOT NULL CHECK(cardinality(source_entry_ids) BETWEEN 1 AND 100),
 weights jsonb NOT NULL CHECK(jsonb_typeof(weights)='array'),
 evidence_reference text NOT NULL CHECK(length(btrim(evidence_reference)) BETWEEN 8 AND 250),
 operation_key text NOT NULL CHECK(length(btrim(operation_key)) BETWEEN 8 AND 180),
 fingerprint text NOT NULL,
 status text NOT NULL DEFAULT 'draft' CHECK(status IN('draft','approved')),
 prepared_by bigint NOT NULL REFERENCES public.users(id),
 approved_by bigint REFERENCES public.users(id),
 created_at timestamptz NOT NULL DEFAULT now(),approved_at timestamptz,
 UNIQUE(tenant_id,period),UNIQUE(tenant_id,operation_key),
 CHECK((status='draft' AND approved_by IS NULL AND approved_at IS NULL)
 OR (status='approved' AND approved_by IS NOT NULL AND approved_by<>prepared_by AND approved_at IS NOT NULL))
);
ALTER TABLE public.financial_gl_central_allocation_policies ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.financial_gl_central_allocation_policies FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE ON public.financial_gl_central_allocation_policies TO service_role;
CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_central_pool_check(pt bigint, ps bigint, pp text, ids bigint[], weights jsonb)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE w jsonb; s bigint;bp bigint;seen bigint[]:='{}';total bigint:=0;n bigint;amt numeric;
BEGIN
IF pt IS NULL OR ps IS NULL OR pp IS NULL OR pt<=0 OR ps<=0
OR pp!~'^[0-9]{4}-(0[1-9]|1[0-2])$'
OR cardinality(ids) NOT BETWEEN 1 AND 100
OR jsonb_typeof(weights)<>'array' OR jsonb_array_length(weights) NOT BETWEEN 2 AND 50
OR NOT EXISTS(SELECT 1 FROM public.sites WHERE tenant_id=pt AND id=ps AND status='active')
THEN RAISE EXCEPTION 'B2_INVALID_SCOPE' USING ERRCODE='22023';END IF;
IF EXISTS(SELECT 1 FROM unnest(ids) x GROUP BY x HAVING x IS NULL OR count(*)>1)
THEN RAISE EXCEPTION 'B2_SOURCE_DUPLICATE' USING ERRCODE='23514';END IF;
FOR w IN SELECT value FROM jsonb_array_elements(weights) LOOP
IF jsonb_typeof(w)<>'object' OR coalesce(w->>'siteId','')!~'^[0-9]{1,18}$'
OR coalesce(w->>'basisPoints','')!~'^[0-9]{1,5}$'
THEN RAISE EXCEPTION 'B2_INVALID_WEIGHT' USING ERRCODE='22023';END IF;
s:=(w->>'siteId')::bigint;bp:=(w->>'basisPoints')::bigint;
IF bp NOT BETWEEN 1 AND 10000 OR s=ANY(seen)
OR NOT EXISTS(SELECT 1 FROM public.sites WHERE tenant_id=pt AND id=s AND status='active')
THEN RAISE EXCEPTION 'B2_INVALID_WEIGHT' USING ERRCODE='22023';END IF;
seen:=array_append(seen,s);total:=total+bp;
END LOOP;
IF total<>10000 THEN RAISE EXCEPTION 'B2_WEIGHTS_NOT_100_PERCENT' USING ERRCODE='23514';END IF;
SELECT count(DISTINCT e.id),coalesce(sum(CASE WHEN a.account_class='expense'
THEN CASE WHEN l.side='debit' THEN l.amount ELSE -l.amount END ELSE 0 END),0)
INTO n,amt FROM public.financial_gl_entries e
JOIN public.financial_gl_lines l ON l.entry_id=e.id AND l.tenant_id=e.tenant_id AND l.site_id=e.site_id
JOIN public.financial_gl_accounts a ON a.tenant_id=l.tenant_id AND a.code=l.account_code
WHERE e.tenant_id=pt AND e.site_id=ps AND e.period=pp AND e.id=ANY(ids)
AND e.source_type='expense' AND e.reverses_entry_id IS NULL
AND NOT EXISTS(SELECT 1 FROM public.financial_gl_entries rev
WHERE rev.tenant_id=e.tenant_id AND rev.site_id=e.site_id AND rev.reverses_entry_id=e.id);
IF n<>cardinality(ids) OR amt<=0 OR amt<>round(amt,2)
THEN RAISE EXCEPTION 'B2_UNVERIFIED_SOURCE' USING ERRCODE='23514';END IF;
RETURN amt;
END;$function$
;

CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_central_policy_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
IF TG_OP IN('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'B2_IMMUTABLE' USING ERRCODE='23514';END IF;
IF TG_OP='INSERT' THEN
IF NEW.status<>'draft' OR NEW.approved_by IS NOT NULL
OR public.powerhub_financial_gl_authorized_actor(NEW.tenant_id,NEW.central_site_id,NEW.prepared_by) IS DISTINCT FROM true
THEN RAISE EXCEPTION 'B2_PREPARER_DENIED' USING ERRCODE='42501';END IF;
ELSE
IF OLD.status<>'draft' OR NEW.status<>'approved'
OR NEW.id<>OLD.id OR NEW.tenant_id<>OLD.tenant_id OR NEW.central_site_id<>OLD.central_site_id
OR NEW.period<>OLD.period OR NEW.source_entry_ids IS DISTINCT FROM OLD.source_entry_ids
OR NEW.weights IS DISTINCT FROM OLD.weights OR NEW.evidence_reference IS DISTINCT FROM OLD.evidence_reference
OR NEW.operation_key IS DISTINCT FROM OLD.operation_key OR NEW.fingerprint IS DISTINCT FROM OLD.fingerprint
OR NEW.prepared_by<>OLD.prepared_by OR NEW.created_at<>OLD.created_at OR NEW.approved_by IS NULL
OR NEW.approved_by=OLD.prepared_by
OR public.powerhub_financial_gl_authorized_actor(NEW.tenant_id,NEW.central_site_id,NEW.approved_by) IS DISTINCT FROM true
THEN RAISE EXCEPTION 'B2_APPROVAL_DENIED' USING ERRCODE='23514';END IF;
END IF;
PERFORM public.powerhub_financial_gl_central_pool_check(NEW.tenant_id,NEW.central_site_id,NEW.period,NEW.source_entry_ids,NEW.weights);
RETURN NEW;
END;$function$
;

CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_central_policy_prepare(pt bigint, ps bigint, pp text, actor bigint, evidence text, opkey text, ids bigint[], weights jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE rowdata public.financial_gl_central_allocation_policies%ROWTYPE;fp text;pool numeric;
BEGIN
IF actor IS NULL OR actor<=0 OR length(btrim(coalesce(evidence,''))) NOT BETWEEN 8 AND 250
OR length(btrim(coalesce(opkey,''))) NOT BETWEEN 8 AND 180
OR public.powerhub_financial_gl_authorized_actor(pt,ps,actor) IS DISTINCT FROM true
THEN RAISE EXCEPTION 'B2_PREPARER_DENIED' USING ERRCODE='42501';END IF;
pool:=public.powerhub_financial_gl_central_pool_check(pt,ps,pp,ids,weights);
PERFORM pg_advisory_xact_lock(hashtextextended('powerhub:B2:'||pt||':'||pp,0));
fp:=encode(sha256(convert_to(jsonb_build_object('tenant',pt,'site',ps,'period',pp,
'actor',actor,'evidence',btrim(evidence),'sources',ids,'weights',weights)::text,'UTF8')),'hex');
SELECT * INTO rowdata FROM public.financial_gl_central_allocation_policies
WHERE tenant_id=pt AND period=pp FOR UPDATE;
IF FOUND THEN
IF rowdata.operation_key<>opkey OR rowdata.fingerprint<>fp THEN
RAISE EXCEPTION 'B2_IDEMPOTENCY_CONFLICT' USING ERRCODE='23505';END IF;
RETURN jsonb_build_object('policyId',rowdata.id,'status',rowdata.status,'alreadyPrepared',true,
'pool',pool,'accountingCertification','NOT_CERTIFIED');END IF;
INSERT INTO public.financial_gl_central_allocation_policies
(tenant_id,central_site_id,period,source_entry_ids,weights,evidence_reference,operation_key,fingerprint,prepared_by)
VALUES(pt,ps,pp,ids,weights,btrim(evidence),opkey,fp,actor) RETURNING * INTO rowdata;
INSERT INTO public.audit_logs(tenant_id,site_id,user_id,action,entity_type,entity_id,after_data,metadata)
VALUES(pt,ps,actor,'GL_B2_POLICY_PREPARED','financial_gl_central_allocation_policies',rowdata.id::text,
jsonb_build_object('period',pp,'fingerprint',fp,'status','draft'),
jsonb_build_object('managementOnly',true,'doesNotPostGL',true));
RETURN jsonb_build_object('policyId',rowdata.id,'status','draft','alreadyPrepared',false,'pool',pool,
'accountingCertification','NOT_CERTIFIED');
END;$function$
;

CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_central_policy_approve(pt bigint, ps bigint, policy_id bigint, actor bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE rowdata public.financial_gl_central_allocation_policies%ROWTYPE;pool numeric;
BEGIN
IF actor IS NULL OR actor<=0 OR public.powerhub_financial_gl_authorized_actor(pt,ps,actor) IS DISTINCT FROM true
THEN RAISE EXCEPTION 'B2_APPROVER_DENIED' USING ERRCODE='42501';END IF;
SELECT * INTO rowdata FROM public.financial_gl_central_allocation_policies
WHERE id=policy_id AND tenant_id=pt AND central_site_id=ps FOR UPDATE;
IF NOT FOUND THEN RAISE EXCEPTION 'B2_POLICY_MISSING' USING ERRCODE='22023';END IF;
IF rowdata.prepared_by=actor THEN RAISE EXCEPTION 'B2_SELF_APPROVAL_DENIED' USING ERRCODE='23514';END IF;
pool:=public.powerhub_financial_gl_central_pool_check(pt,ps,rowdata.period,rowdata.source_entry_ids,rowdata.weights);
IF rowdata.status='approved' THEN
IF rowdata.approved_by<>actor THEN RAISE EXCEPTION 'B2_APPROVAL_REPLAY_CONFLICT' USING ERRCODE='23505';END IF;
RETURN jsonb_build_object('policyId',policy_id,'status','approved','alreadyApproved',true,
'pool',pool,'accountingCertification','NOT_CERTIFIED');END IF;
UPDATE public.financial_gl_central_allocation_policies SET status='approved',
approved_by=actor,approved_at=statement_timestamp() WHERE id=rowdata.id;
INSERT INTO public.audit_logs(tenant_id,site_id,user_id,action,entity_type,entity_id,before_data,after_data,metadata)
VALUES(pt,ps,actor,'GL_B2_POLICY_APPROVED','financial_gl_central_allocation_policies',rowdata.id::text,
jsonb_build_object('status','draft'),jsonb_build_object('status','approved','preparedBy',rowdata.prepared_by,
'approvedBy',actor),jsonb_build_object('managementOnly',true,'doesNotPostGL',true));
RETURN jsonb_build_object('policyId',policy_id,'status','approved','alreadyApproved',false,
'pool',pool,'accountingCertification','NOT_CERTIFIED');
END;$function$
;

CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_central_policy_preview(pt bigint, ps bigint, pp text, central_site bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE policy public.financial_gl_central_allocation_policies%ROWTYPE;
pool numeric;cents bigint;allocated bigint;allocated_total bigint;all_sites jsonb;before_result numeric;
BEGIN
IF pt IS NULL OR ps IS NULL OR central_site IS NULL OR pt<=0 OR ps<=0 OR central_site<=0
OR pp IS NULL OR pp!~'^[0-9]{4}-(0[1-9]|1[0-2])$'
OR NOT EXISTS(SELECT 1 FROM public.sites WHERE tenant_id=pt AND id=ps AND status='active')
OR NOT EXISTS(SELECT 1 FROM public.sites WHERE tenant_id=pt AND id=central_site AND status='active')
THEN RAISE EXCEPTION 'B2_PREVIEW_SCOPE' USING ERRCODE='22023';END IF;
SELECT * INTO policy FROM public.financial_gl_central_allocation_policies
WHERE tenant_id=pt AND period=pp AND central_site_id=central_site;
IF NOT FOUND OR policy.status<>'approved' THEN
RETURN jsonb_build_object('tenantId',pt,'siteId',ps,'period',pp,
'status',CASE WHEN policy.id IS NULL THEN 'NOT_CONFIGURED' ELSE 'DRAFT_NOT_APPROVED' END,
'pool','null'::jsonb,'allocatedCost','null'::jsonb,'managerialResult','null'::jsonb,
'doesNotPostGL',true,'isFinalBranchProfit',false,'accountingCertification','NOT_CERTIFIED');END IF;
pool:=public.powerhub_financial_gl_central_pool_check(pt,central_site,pp,policy.source_entry_ids,policy.weights);
cents:=(pool*100)::bigint;
WITH w AS(SELECT (x->>'siteId')::bigint site,(x->>'basisPoints')::bigint bp
FROM jsonb_array_elements(policy.weights) x),base AS(
SELECT site,bp,(cents*bp/10000)::bigint part,mod(cents*bp,10000) fraction FROM w),
ranked AS(SELECT *,row_number() OVER(ORDER BY fraction DESC,site) rn,sum(part) OVER() base_total FROM base),
result AS(SELECT site,bp,part+CASE WHEN rn<=cents-base_total THEN 1 ELSE 0 END amount FROM ranked)
SELECT coalesce(jsonb_agg(jsonb_build_object('siteId',site,'basisPoints',bp,
'allocatedCost',amount::numeric/100) ORDER BY site),'[]'::jsonb),
coalesce(sum(amount),0),coalesce(max(amount) FILTER(WHERE site=ps),0)
INTO all_sites,allocated_total,allocated FROM result;
IF allocated_total<>cents THEN RAISE EXCEPTION 'B2_ROUNDING_INCONSISTENT' USING ERRCODE='23514';END IF;
before_result:=(public.powerhub_financial_gl_site_statements(pt,ps,pp)
->'branchProfitability'->>'siteResultBeforeCentralAllocation')::numeric;
RETURN jsonb_build_object('tenantId',pt,'siteId',ps,'period',pp,
'status','MANAGEMENT_ALLOCATION_APPROVED','policyId',policy.id,'fingerprint',policy.fingerprint,
'pool',pool,'allocations',all_sites,'allocatedCost',allocated::numeric/100,
'siteResultBeforeCentralAllocation',before_result,
'sourceCostAddback',CASE WHEN ps=central_site THEN pool ELSE 0 END,
'managerialResult',before_result+CASE WHEN ps=central_site THEN pool ELSE 0 END-allocated::numeric/100,
'unallocatedCost',0,'doesNotPostGL',true,'isFinalBranchProfit',false,'accountingCertification','NOT_CERTIFIED');
END;$function$
;
REVOKE ALL ON FUNCTION public.powerhub_financial_gl_central_policy_guard() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER financial_gl_central_policy_guard_row BEFORE INSERT OR UPDATE OR DELETE
 ON public.financial_gl_central_allocation_policies FOR EACH ROW EXECUTE FUNCTION public.powerhub_financial_gl_central_policy_guard();
CREATE TRIGGER financial_gl_central_policy_guard_truncate BEFORE TRUNCATE
 ON public.financial_gl_central_allocation_policies FOR EACH STATEMENT EXECUTE FUNCTION public.powerhub_financial_gl_central_policy_guard();
REVOKE ALL ON FUNCTION public.powerhub_financial_gl_central_pool_check(bigint,bigint,text,bigint[],jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.powerhub_financial_gl_central_policy_prepare(bigint,bigint,text,bigint,text,text,bigint[],jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.powerhub_financial_gl_central_policy_approve(bigint,bigint,bigint,bigint) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.powerhub_financial_gl_central_policy_preview(bigint,bigint,text,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_gl_central_pool_check(bigint,bigint,text,bigint[],jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_gl_central_policy_prepare(bigint,bigint,text,bigint,text,text,bigint[],jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_gl_central_policy_approve(bigint,bigint,bigint,bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_gl_central_policy_preview(bigint,bigint,text,bigint) TO service_role;
