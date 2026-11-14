-- B3.8 initially applied Staging definition; B3.8.1 qualifies extensions.digest.
CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_post_inter_site_source(p_tenant_id bigint, p_from_site_id bigint, p_source_id bigint, p_checker_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
 v_op public.company_account_movement_operations%ROWTYPE;
 v_src public.account_transactions%ROWTYPE;
 v_dst public.account_transactions%ROWTYPE;
 v_from public.company_accounts%ROWTYPE;
 v_to public.company_accounts%ROWTYPE;
 v_e_from public.financial_gl_entries%ROWTYPE;
 v_e_to public.financial_gl_entries%ROWTYPE;
 v_period text;v_fingerprint text;
 v_from_cash text;v_to_cash text;
 v_from_site bigint;v_to_site bigint;
 v_lock_site bigint;
BEGIN
 IF p_tenant_id IS NULL OR p_tenant_id<=0
 OR p_from_site_id IS NULL OR p_from_site_id<=0
 OR p_source_id IS NULL OR p_source_id<=0
 OR p_checker_id IS NULL OR p_checker_id<=0
 THEN RAISE EXCEPTION 'GL_B38_SCOPE_INVALID' USING ERRCODE='22023'; END IF;

 SELECT * INTO v_op FROM public.company_account_movement_operations op
 WHERE op.tenant_id=p_tenant_id AND op.site_id=p_from_site_id
 AND op.primary_transaction_id=p_source_id AND op.operation_type='transfer'
 FOR UPDATE;
 IF NOT FOUND OR v_op.counterpart_transaction_id IS NULL
 THEN RAISE EXCEPTION 'GL_B38_TRANSFER_SOURCE_MISSING' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_src FROM public.account_transactions t
 WHERE t.tenant_id=p_tenant_id AND t.id=v_op.primary_transaction_id FOR SHARE;
 SELECT * INTO v_dst FROM public.account_transactions t
 WHERE t.tenant_id=p_tenant_id AND t.id=v_op.counterpart_transaction_id FOR SHARE;
 IF v_src.id IS NULL OR v_dst.id IS NULL
 OR v_src.site_id IS DISTINCT FROM p_from_site_id
 OR v_dst.site_id IS NULL OR v_dst.site_id=v_src.site_id
 OR v_src.transaction_type<>'transfer_out' OR v_dst.transaction_type<>'transfer_in'
 OR v_src.account_id IS NOT DISTINCT FROM v_dst.account_id
 OR v_src.related_account_id IS DISTINCT FROM v_dst.account_id
 OR v_dst.related_account_id IS DISTINCT FROM v_src.account_id
 OR v_src.amount IS DISTINCT FROM v_dst.amount
 OR v_src.amount<=0 OR v_src.amount<>round(v_src.amount,2)
 OR v_src.description IS DISTINCT FROM v_dst.description
 OR v_src.created_by_user_id IS DISTINCT FROM v_op.created_by_user_id
 OR v_dst.created_by_user_id IS DISTINCT FROM v_op.created_by_user_id
 OR to_char(v_src.occurred_at AT TIME ZONE 'Asia/Gaza','YYYY-MM')
     IS DISTINCT FROM to_char(v_dst.occurred_at AT TIME ZONE 'Asia/Gaza','YYYY-MM')
 OR NOT EXISTS (SELECT 1 FROM generate_series(0,6) g(input_scale)
  WHERE v_op.payload_hash=md5(jsonb_build_object(
    'tenantId',p_tenant_id,'siteId',p_from_site_id,
    'userId',v_op.created_by_user_id,
    'fromAccountId',v_src.account_id,'toAccountId',v_dst.account_id,
    'amount',round(v_src.amount,g.input_scale),
    'description',btrim(v_src.description))::text))
 OR (SELECT count(*) FROM public.company_account_movement_operations op2
    WHERE op2.tenant_id=p_tenant_id
    AND (op2.primary_transaction_id=v_src.id OR op2.counterpart_transaction_id=v_dst.id))<>1
 THEN RAISE EXCEPTION 'GL_B38_SOURCE_PAIR_OR_FINGERPRINT_INVALID' USING ERRCODE='22023'; END IF;

 v_from_site:=v_src.site_id;v_to_site:=v_dst.site_id;
 IF NOT EXISTS(SELECT 1 FROM public.sites s WHERE s.tenant_id=p_tenant_id
       AND s.id=v_from_site AND s.status='active')
 OR NOT EXISTS(SELECT 1 FROM public.sites s WHERE s.tenant_id=p_tenant_id
       AND s.id=v_to_site AND s.status='active')
 OR public.powerhub_financial_gl_authorized_actor(p_tenant_id,v_from_site,p_checker_id)
    IS DISTINCT FROM true
 OR public.powerhub_financial_gl_authorized_actor(p_tenant_id,v_to_site,p_checker_id)
    IS DISTINCT FROM true
 OR v_op.created_by_user_id=p_checker_id
 THEN RAISE EXCEPTION 'GL_B38_REVIEWER_NOT_INDEPENDENT_OR_AUTHORIZED'
 USING ERRCODE='42501'; END IF;

 SELECT * INTO v_from FROM public.company_accounts a
 WHERE a.tenant_id=p_tenant_id AND a.id=v_src.account_id FOR SHARE;
 SELECT * INTO v_to FROM public.company_accounts a
 WHERE a.tenant_id=p_tenant_id AND a.id=v_dst.account_id FOR SHARE;
 -- Cross-site financial attribution requires an exclusive site-account mapping;
 -- a shared or unmapped account must never be silently assigned to a site.
 IF v_from.id IS NULL OR v_to.id IS NULL
 OR v_from.is_active IS DISTINCT FROM true OR v_to.is_active IS DISTINCT FROM true
 OR (SELECT count(*) FROM public.company_account_sites cs
  WHERE cs.tenant_id=p_tenant_id AND cs.account_id=v_from.id)<>1
 OR (SELECT count(*) FROM public.company_account_sites cs
  WHERE cs.tenant_id=p_tenant_id AND cs.account_id=v_to.id)<>1
 OR NOT EXISTS(SELECT 1 FROM public.company_account_sites cs
  WHERE cs.tenant_id=p_tenant_id AND cs.account_id=v_from.id AND cs.site_id=v_from_site)
 OR NOT EXISTS(SELECT 1 FROM public.company_account_sites cs
  WHERE cs.tenant_id=p_tenant_id AND cs.account_id=v_to.id AND cs.site_id=v_to_site)
 THEN RAISE EXCEPTION 'GL_B38_SITE_ACCOUNT_MAPPING_AMBIGUOUS' USING ERRCODE='22023'; END IF;

 v_from_cash:=CASE WHEN v_from.account_type='cash' THEN '1010' ELSE '1020' END;
 v_to_cash:=CASE WHEN v_to.account_type='cash' THEN '1010' ELSE '1020' END;
 v_period:=to_char(v_src.occurred_at AT TIME ZONE 'Asia/Gaza','YYYY-MM');
 IF EXISTS(SELECT 1 FROM public.financial_accrual_period_reviews r
   WHERE r.tenant_id=p_tenant_id AND r.status='locked' AND r.period=v_period
   AND r.site_id IN(v_from_site,v_to_site))
 THEN RAISE EXCEPTION 'GL_B38_PERIOD_LOCKED' USING ERRCODE='22023'; END IF;

 -- All ledger writers share the site advisory locks, in deterministic order.
 PERFORM pg_advisory_xact_lock(hashtextextended(
  'powerhub:gl-site:'||p_tenant_id||':'||least(v_from_site,v_to_site),0));
 PERFORM pg_advisory_xact_lock(hashtextextended(
  'powerhub:gl-site:'||p_tenant_id||':'||greatest(v_from_site,v_to_site),0));
 v_fingerprint:=encode(digest(jsonb_build_object(
  'key',v_op.operation_key,'payloadHash',v_op.payload_hash,
  'sourceId',v_src.id,'destinationId',v_dst.id,
  'fromSite',v_from_site,'toSite',v_to_site,
  'fromAccount',v_from.id,'toAccount',v_to.id,
  'amount',v_src.amount,'period',v_period)::text,'sha256'),'hex');

 SELECT * INTO v_e_from FROM public.financial_gl_entries e
 WHERE e.tenant_id=p_tenant_id AND e.site_id=v_from_site
 AND e.source_type='account_movement' AND e.source_id=v_src.id::text;
 SELECT * INTO v_e_to FROM public.financial_gl_entries e
 WHERE e.tenant_id=p_tenant_id AND e.site_id=v_to_site
 AND e.source_type='account_movement' AND e.source_id=v_dst.id::text;
 IF v_e_from.id IS NOT NULL OR v_e_to.id IS NOT NULL THEN
  IF v_e_from.id IS NULL OR v_e_to.id IS NULL
   OR v_e_from.source_fingerprint<>v_fingerprint
   OR v_e_to.source_fingerprint<>v_fingerprint
   OR v_e_from.accounting_policy_version<>'inter-site-due-from-to-v1'
   OR v_e_to.accounting_policy_version<>'inter-site-due-from-to-v1'
   OR v_e_from.period<>v_period OR v_e_to.period<>v_period
   OR v_e_from.posted_by_user_id<>p_checker_id
   OR v_e_to.posted_by_user_id<>p_checker_id
   OR (SELECT count(*) FROM public.financial_gl_lines l
       WHERE l.entry_id=v_e_from.id)<>2
   OR (SELECT count(*) FROM public.financial_gl_lines l
       WHERE l.entry_id=v_e_to.id)<>2
   OR NOT EXISTS(SELECT 1 FROM public.financial_gl_lines l
       WHERE l.entry_id=v_e_from.id AND l.account_code='1350'
       AND l.side='debit' AND l.amount=v_src.amount)
   OR NOT EXISTS(SELECT 1 FROM public.financial_gl_lines l
       WHERE l.entry_id=v_e_from.id AND l.account_code=v_from_cash
       AND l.side='credit' AND l.amount=v_src.amount)
   OR NOT EXISTS(SELECT 1 FROM public.financial_gl_lines l
       WHERE l.entry_id=v_e_to.id AND l.account_code=v_to_cash
       AND l.side='debit' AND l.amount=v_src.amount)
   OR NOT EXISTS(SELECT 1 FROM public.financial_gl_lines l
       WHERE l.entry_id=v_e_to.id AND l.account_code='2350'
       AND l.side='credit' AND l.amount=v_src.amount)
  THEN RAISE EXCEPTION 'GL_B38_PARTIAL_OR_TAMPERED_REPLAY' USING ERRCODE='23505'; END IF;
  RETURN jsonb_build_object('fromEntryId',v_e_from.id,'toEntryId',v_e_to.id,
    'sourceId',v_src.id,'counterpartId',v_dst.id,'period',v_period,
    'amount',v_src.amount,'alreadyPosted',true,
    'accountingCertification','NOT_CERTIFIED',
    'consolidationEliminationPosted',false);
 END IF;

 INSERT INTO public.financial_gl_accounts(tenant_id,code,name,account_class,normal_side)
 VALUES(p_tenant_id,'1350','مستحق من فرع','asset','debit'),
       (p_tenant_id,'2350','مستحق لفرع','liability','credit')
 ON CONFLICT(tenant_id,code) DO NOTHING;
 IF NOT EXISTS (SELECT 1 FROM public.financial_gl_accounts
    WHERE tenant_id=p_tenant_id AND code='1350'
     AND account_class='asset' AND normal_side='debit' AND is_contra=false)
 OR NOT EXISTS (SELECT 1 FROM public.financial_gl_accounts
    WHERE tenant_id=p_tenant_id AND code='2350'
     AND account_class='liability' AND normal_side='credit' AND is_contra=false)
 THEN RAISE EXCEPTION 'GL_B38_INTER_SITE_CHART_CONFLICT' USING ERRCODE='23514'; END IF;

 INSERT INTO public.financial_gl_entries
 (tenant_id,site_id,period,source_type,source_id,source_revision,operation_key,
  source_fingerprint,accounting_policy_version,posted_by_user_id)
 VALUES(p_tenant_id,v_from_site,v_period,'account_movement',v_src.id::text,1,
  'gl:inter-site:out:'||v_op.operation_key::text,
  v_fingerprint,'inter-site-due-from-to-v1',p_checker_id)
 RETURNING * INTO v_e_from;
 INSERT INTO public.financial_gl_lines
 (entry_id,tenant_id,site_id,account_code,side,amount)
 VALUES (v_e_from.id,p_tenant_id,v_from_site,'1350','debit',v_src.amount),
        (v_e_from.id,p_tenant_id,v_from_site,v_from_cash,'credit',v_src.amount);

 INSERT INTO public.financial_gl_entries
 (tenant_id,site_id,period,source_type,source_id,source_revision,operation_key,
  source_fingerprint,accounting_policy_version,posted_by_user_id)
 VALUES(p_tenant_id,v_to_site,v_period,'account_movement',v_dst.id::text,1,
  'gl:inter-site:in:'||v_op.operation_key::text,
  v_fingerprint,'inter-site-due-from-to-v1',p_checker_id)
 RETURNING * INTO v_e_to;
 INSERT INTO public.financial_gl_lines
 (entry_id,tenant_id,site_id,account_code,side,amount)
 VALUES (v_e_to.id,p_tenant_id,v_to_site,v_to_cash,'debit',v_dst.amount),
        (v_e_to.id,p_tenant_id,v_to_site,'2350','credit',v_dst.amount);

 INSERT INTO public.audit_logs
 (tenant_id,site_id,user_id,entity_type,entity_id,action,after_data,metadata)
 VALUES(p_tenant_id,v_from_site,NULL,'financial_gl_inter_site_posting',
   v_op.operation_key::text,'GL_B38_INTER_SITE_DOUBLE_ENTRY_POSTED',
   jsonb_build_object('operationKey',v_op.operation_key,'makerId',v_op.created_by_user_id,
     'checkerId',p_checker_id,'fromSite',v_from_site,'toSite',v_to_site,
     'fromEntryId',v_e_from.id,'toEntryId',v_e_to.id,'amount',v_src.amount,
     'sourceFingerprint',v_fingerprint,'accountingCertification','NOT_CERTIFIED'),
   jsonb_build_object('requiresAuthenticatedBrowserReview',true,
     'isConsolidationElimination',false,'approvalAttestedBySQLActorIdsOnly',true));
 RETURN jsonb_build_object('fromEntryId',v_e_from.id,'toEntryId',v_e_to.id,
   'sourceId',v_src.id,'counterpartId',v_dst.id,'period',v_period,
   'amount',v_src.amount,'alreadyPosted',false,
   'accountingCertification','NOT_CERTIFIED',
   'consolidationEliminationPosted',false);
END;$function$;
REVOKE ALL ON FUNCTION public.powerhub_financial_gl_post_inter_site_source(bigint,bigint,bigint,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_gl_post_inter_site_source(bigint,bigint,bigint,bigint) TO service_role;
