-- B3.11.2: avoid ambiguous argument column in elimination-lines verification.
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
REVOKE ALL ON FUNCTION public.powerhub_financial_gl_inter_site_elimination_approve(bigint,bigint,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_gl_inter_site_elimination_approve(bigint,bigint,bigint) TO service_role;
