-- B3.10.1 record cross-site counterpart without incorrectly attributing its site.
CREATE OR REPLACE FUNCTION public.powerhub_transfer_company_accounts_inter_site_idempotent(p_tenant_id bigint, p_from_site_id bigint, p_to_site_id bigint, p_user_id bigint, p_from_account_id bigint, p_to_account_id bigint, p_amount numeric, p_description text, p_operation_key uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
 v_hash text;v_op public.company_account_movement_operations%ROWTYPE;
 v_from public.company_accounts%ROWTYPE;
 v_to public.company_accounts%ROWTYPE;
 v_balance numeric;v_out bigint;v_in bigint;
 v_period text;
BEGIN
 IF p_tenant_id IS NULL OR p_tenant_id<=0 OR p_from_site_id IS NULL OR p_from_site_id<=0
 OR p_to_site_id IS NULL OR p_to_site_id<=0 OR p_from_site_id=p_to_site_id
 OR p_user_id IS NULL OR p_user_id<=0 OR p_operation_key IS NULL
 OR p_from_account_id IS NULL OR p_from_account_id<=0
 OR p_to_account_id IS NULL OR p_to_account_id<=0
 OR p_from_account_id=p_to_account_id
 OR p_amount IS NULL OR p_amount<=0 OR p_amount>100000000 OR p_amount<>round(p_amount,2)
 OR length(btrim(coalesce(p_description,''))) NOT BETWEEN 2 AND 255
 THEN RAISE EXCEPTION 'B310_INVALID_CROSS_SITE_TRANSFER' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.sites WHERE tenant_id=p_tenant_id AND id=p_from_site_id AND status='active')
 OR NOT EXISTS(SELECT 1 FROM public.sites WHERE tenant_id=p_tenant_id AND id=p_to_site_id AND status='active')
 OR public.powerhub_financial_gl_authorized_actor(p_tenant_id,p_from_site_id,p_user_id) IS DISTINCT FROM true
 OR public.powerhub_financial_gl_authorized_actor(p_tenant_id,p_to_site_id,p_user_id) IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'B310_ACTOR_OR_SITE_OUT_OF_SCOPE' USING ERRCODE='42501'; END IF;
 -- Historical operation hashes must align with the B3.5/B3.8 payload checker.
 v_hash:=md5(jsonb_build_object('tenantId',p_tenant_id,'siteId',p_from_site_id,
 'userId',p_user_id,'fromAccountId',p_from_account_id,
 'toAccountId',p_to_account_id,'amount',p_amount,'description',btrim(p_description))::text);
 PERFORM pg_advisory_xact_lock(hashtextextended(
  p_tenant_id::text||':company-account-movement:'||p_operation_key::text,0));
 SELECT * INTO v_op FROM public.company_account_movement_operations
 WHERE tenant_id=p_tenant_id AND operation_key=p_operation_key FOR UPDATE;
 IF FOUND THEN
   IF v_op.operation_type<>'transfer' OR v_op.payload_hash<>v_hash
      OR v_op.site_id<>p_from_site_id OR v_op.created_by_user_id<>p_user_id
      OR v_op.counterpart_transaction_id IS NULL
      OR NOT EXISTS(SELECT 1 FROM public.account_transactions a
       JOIN public.account_transactions b ON b.id=v_op.counterpart_transaction_id
       AND b.tenant_id=a.tenant_id
       WHERE a.tenant_id=p_tenant_id AND a.id=v_op.primary_transaction_id
       AND a.account_id=p_from_account_id AND b.account_id=p_to_account_id
       AND a.site_id=p_from_site_id AND b.site_id=p_to_site_id
       AND a.amount=p_amount AND b.amount=p_amount
       AND a.transaction_type='transfer_out' AND b.transaction_type='transfer_in'
       AND a.related_account_id=b.account_id AND b.related_account_id=a.account_id)
   THEN RAISE EXCEPTION 'B310_IDEMPOTENCY_CONFLICT' USING ERRCODE='23505'; END IF;
   RETURN jsonb_build_object('sourceId',v_op.primary_transaction_id,
     'counterpartId',v_op.counterpart_transaction_id,'fromSiteId',p_from_site_id,
     'toSiteId',p_to_site_id,'amount',p_amount,'alreadyCreated',true);
 END IF;
 PERFORM pg_advisory_xact_lock(least(p_from_account_id,p_to_account_id));
 PERFORM pg_advisory_xact_lock(greatest(p_from_account_id,p_to_account_id));
 SELECT * INTO v_from FROM public.company_accounts
 WHERE tenant_id=p_tenant_id AND id=p_from_account_id FOR UPDATE;
 SELECT * INTO v_to FROM public.company_accounts
 WHERE tenant_id=p_tenant_id AND id=p_to_account_id FOR UPDATE;
 IF v_from.id IS NULL OR v_to.id IS NULL OR v_from.is_active IS DISTINCT FROM true
 OR v_to.is_active IS DISTINCT FROM true
 OR (SELECT count(*) FROM public.company_account_sites cs
   WHERE cs.tenant_id=p_tenant_id AND cs.account_id=p_from_account_id)<>1
 OR (SELECT count(*) FROM public.company_account_sites cs
   WHERE cs.tenant_id=p_tenant_id AND cs.account_id=p_to_account_id)<>1
 OR NOT EXISTS(SELECT 1 FROM public.company_account_sites cs
    WHERE cs.tenant_id=p_tenant_id AND cs.account_id=p_from_account_id AND cs.site_id=p_from_site_id)
 OR NOT EXISTS(SELECT 1 FROM public.company_account_sites cs
    WHERE cs.tenant_id=p_tenant_id AND cs.account_id=p_to_account_id AND cs.site_id=p_to_site_id)
 THEN RAISE EXCEPTION 'B310_SITE_ACCOUNT_MAPPING_INVALID' USING ERRCODE='22023'; END IF;
 v_period:=to_char(clock_timestamp() AT TIME ZONE 'Asia/Gaza','YYYY-MM');
 IF EXISTS(SELECT 1 FROM public.financial_accrual_period_reviews r
  WHERE r.tenant_id=p_tenant_id AND r.site_id IN (p_from_site_id,p_to_site_id)
   AND r.period=v_period AND r.status='locked')
 OR EXISTS(SELECT 1 FROM public.financial_settlements fs
  WHERE fs.tenant_id=p_tenant_id AND fs.site_id IN(p_from_site_id,p_to_site_id)
   AND fs.status='locked' AND fs.period_start<=now() AND fs.period_end>=now())
 THEN RAISE EXCEPTION 'B310_FINANCIAL_PERIOD_LOCKED' USING ERRCODE='22023';END IF;
 SELECT v_from.opening_balance+coalesce(sum(
 CASE WHEN t.transaction_type IN('deposit','collection','transfer_in') THEN t.amount
 ELSE -t.amount END),0) INTO v_balance
 FROM public.account_transactions t WHERE t.tenant_id=p_tenant_id AND t.account_id=p_from_account_id;
 IF v_balance IS NULL OR p_amount>v_balance
 THEN RAISE EXCEPTION 'B310_INSUFFICIENT_ACCOUNT_BALANCE' USING ERRCODE='22023';END IF;
 INSERT INTO public.account_transactions(
  tenant_id,account_id,site_id,related_account_id,transaction_type,amount,
  description,created_by_user_id)
 VALUES(p_tenant_id,p_from_account_id,p_from_site_id,p_to_account_id,
   'transfer_out',p_amount,btrim(p_description),p_user_id)
 RETURNING id INTO v_out;
 INSERT INTO public.account_transactions(
  tenant_id,account_id,site_id,related_account_id,transaction_type,amount,
  description,created_by_user_id)
 VALUES(p_tenant_id,p_to_account_id,p_to_site_id,p_from_account_id,
   'transfer_in',p_amount,btrim(p_description),p_user_id)
 RETURNING id INTO v_in;
 INSERT INTO public.company_account_movement_operations(
  tenant_id,operation_key,site_id,created_by_user_id,operation_type,payload_hash,
  primary_transaction_id,counterpart_transaction_id)
 VALUES(p_tenant_id,p_operation_key,p_from_site_id,p_user_id,'transfer',
  v_hash,v_out,v_in);
 INSERT INTO public.audit_logs(tenant_id,site_id,user_id,entity_type,entity_id,
  action,after_data,metadata)
 VALUES(p_tenant_id,p_from_site_id,p_user_id,'company_account_movement_operations',
  p_operation_key::text,'B310_CROSS_SITE_TRANSFER_CREATED',
  jsonb_build_object('fromSite',p_from_site_id,'toSite',p_to_site_id,
   'fromTransactionId',v_out,'counterpartTransactionId',v_in,'amount',p_amount),
  jsonb_build_object('requiresIndependentGLChecker',true,
   'glPosted',false,'isConsolidationElimination',false));
 RETURN jsonb_build_object('sourceId',v_out,'counterpartId',v_in,
  'fromSiteId',p_from_site_id,'toSiteId',p_to_site_id,
  'amount',p_amount,'alreadyCreated',false);
END;$function$;

REVOKE ALL ON FUNCTION public.powerhub_transfer_company_accounts_inter_site_idempotent(bigint,bigint,bigint,bigint,bigint,bigint,numeric,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_transfer_company_accounts_inter_site_idempotent(bigint,bigint,bigint,bigint,bigint,bigint,numeric,text,uuid) TO service_role;
