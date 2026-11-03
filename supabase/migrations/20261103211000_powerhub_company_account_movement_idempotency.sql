-- Idempotent manual deposit, withdrawal, and paired company-account transfers.
-- The operation key is tenant-scoped and payload-bound so retries return original ledger entries.
DO $preflight$
BEGIN
  IF to_regclass('public.account_transactions') IS NULL
     OR to_regclass('public.company_accounts') IS NULL
     OR to_regclass('public.company_account_sites') IS NULL
     OR to_regclass('public.financial_settlements') IS NULL
     OR to_regclass('public.audit_logs') IS NULL
     OR to_regclass('public.sites') IS NULL
     OR to_regclass('public.users') IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conrelid='public.account_transactions'::regclass
         AND contype IN ('p','u')
       GROUP BY conrelid
       HAVING bool_or(pg_get_constraintdef(oid) ILIKE '%tenant_id%id%')
     ) THEN
    RAISE EXCEPTION 'COMPANY_ACCOUNT_MOVEMENT_IDEMPOTENCY_PREREQUISITES_MISSING';
  END IF;
END
$preflight$;

CREATE TABLE IF NOT EXISTS public.company_account_movement_operations (
  tenant_id bigint NOT NULL,
  operation_key uuid NOT NULL,
  site_id bigint NOT NULL,
  created_by_user_id bigint NOT NULL,
  operation_type text NOT NULL CHECK (operation_type IN ('deposit','withdrawal','transfer')),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{32}$'),
  primary_transaction_id bigint NOT NULL,
  counterpart_transaction_id bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,operation_key),
  FOREIGN KEY (tenant_id,site_id) REFERENCES public.sites(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,primary_transaction_id) REFERENCES public.account_transactions(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,counterpart_transaction_id) REFERENCES public.account_transactions(tenant_id,id) ON DELETE RESTRICT,
  CONSTRAINT company_account_movement_operations_transfer_pair_check
    CHECK ((operation_type='transfer')=(counterpart_transaction_id IS NOT NULL))
);

ALTER TABLE public.company_account_movement_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.company_account_movement_operations FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT ON TABLE public.company_account_movement_operations TO service_role;

CREATE OR REPLACE FUNCTION public.powerhub_add_account_movement_idempotent(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_account_id bigint,
  p_transaction_type text,
  p_amount numeric,
  p_description text,
  p_reference_no text,
  p_operation_key uuid
)
RETURNS TABLE(transaction_id bigint,replayed boolean)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path=public,pg_temp
AS $function$
DECLARE
  v_account public.company_accounts%rowtype;
  v_operation public.company_account_movement_operations%rowtype;
  v_balance numeric(14,2);
  v_transaction_id bigint;
  v_platform_role text;
  v_hash text;
BEGIN
  IF p_tenant_id IS NULL OR p_tenant_id<1 OR p_site_id IS NULL OR p_site_id<1
     OR p_user_id IS NULL OR p_user_id<1 OR p_account_id IS NULL OR p_account_id<1
     OR p_operation_key IS NULL OR p_transaction_type NOT IN ('deposit','withdrawal')
     OR p_amount IS NULL OR p_amount<=0 OR p_amount>100000000 OR p_amount<>round(p_amount,2)
     OR char_length(coalesce(p_description,''))<2 OR char_length(p_description)>255
     OR char_length(coalesce(p_reference_no,''))>120 THEN
    RAISE EXCEPTION 'INVALID_ACCOUNT_MOVEMENT' USING ERRCODE='P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.sites s WHERE s.id=p_site_id AND s.tenant_id=p_tenant_id) THEN
    RAISE EXCEPTION 'SITE_OUT_OF_SCOPE' USING ERRCODE='P0001';
  END IF;

  v_hash:=md5(jsonb_build_object(
    'tenantId',p_tenant_id,'siteId',p_site_id,'userId',p_user_id,'accountId',p_account_id,
    'type',p_transaction_type,'amount',p_amount,'description',btrim(p_description),
    'referenceNo',nullif(btrim(p_reference_no),'')
  )::text);

  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_tenant_id::text||':company-account-movement:'||p_operation_key::text,0
  ));
  SELECT op.* INTO v_operation
  FROM public.company_account_movement_operations op
  WHERE op.tenant_id=p_tenant_id AND op.operation_key=p_operation_key
  FOR UPDATE;
  IF FOUND THEN
    IF v_operation.operation_type<>p_transaction_type OR v_operation.payload_hash<>v_hash THEN
      RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='P0001';
    END IF;
    RETURN QUERY SELECT v_operation.primary_transaction_id,true;
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(p_account_id);
  SELECT * INTO v_account
  FROM public.company_accounts
  WHERE id=p_account_id AND tenant_id=p_tenant_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCOUNT_NOT_FOUND' USING ERRCODE='P0001'; END IF;

  IF EXISTS (SELECT 1 FROM public.company_account_sites cs WHERE cs.tenant_id=p_tenant_id AND cs.account_id=p_account_id)
     AND NOT EXISTS (SELECT 1 FROM public.company_account_sites cs WHERE cs.tenant_id=p_tenant_id AND cs.account_id=p_account_id AND cs.site_id=p_site_id) THEN
    RAISE EXCEPTION 'ACCOUNT_SITE_OUT_OF_SCOPE' USING ERRCODE='P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM public.financial_settlements fs
    WHERE fs.tenant_id=p_tenant_id AND fs.site_id=p_site_id AND fs.status='locked'
      AND fs.period_start<=now() AND fs.period_end>=now()) THEN
    RAISE EXCEPTION 'FINANCIAL_PERIOD_LOCKED' USING ERRCODE='P0001';
  END IF;

  SELECT v_account.opening_balance+coalesce(sum(
    CASE WHEN tx.transaction_type IN ('deposit','transfer_in','collection') THEN tx.amount ELSE -tx.amount END
  ),0)
  INTO v_balance
  FROM public.account_transactions tx
  WHERE tx.tenant_id=p_tenant_id AND tx.account_id=p_account_id;
  IF p_transaction_type='withdrawal' AND p_amount>v_balance THEN
    RAISE EXCEPTION 'INSUFFICIENT_ACCOUNT_BALANCE' USING ERRCODE='P0001';
  END IF;

  INSERT INTO public.account_transactions(
    tenant_id,account_id,site_id,transaction_type,amount,description,reference_no,created_by_user_id
  ) VALUES(
    p_tenant_id,p_account_id,p_site_id,p_transaction_type,p_amount,btrim(p_description),
    nullif(btrim(p_reference_no),''),p_user_id
  ) RETURNING id INTO v_transaction_id;

  SELECT u.platform_role INTO v_platform_role FROM public.users u WHERE u.id=p_user_id;
  INSERT INTO public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data,metadata
  ) VALUES(
    p_tenant_id,p_site_id,p_user_id,v_platform_role,'company_account',p_account_id::text,p_transaction_type,
    jsonb_build_object('transactionId',v_transaction_id,'amount',p_amount,'referenceNo',nullif(btrim(p_reference_no),'')),
    jsonb_build_object('operationKey',p_operation_key,'payloadHash',v_hash)
  );

  INSERT INTO public.company_account_movement_operations(
    tenant_id,operation_key,site_id,created_by_user_id,operation_type,payload_hash,primary_transaction_id
  ) VALUES(
    p_tenant_id,p_operation_key,p_site_id,p_user_id,p_transaction_type,v_hash,v_transaction_id
  );

  RETURN QUERY SELECT v_transaction_id,false;
END;
$function$;

CREATE OR REPLACE FUNCTION public.powerhub_transfer_company_accounts_idempotent(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_from_account_id bigint,
  p_to_account_id bigint,
  p_amount numeric,
  p_description text,
  p_operation_key uuid
)
RETURNS TABLE(from_transaction_id bigint,to_transaction_id bigint,replayed boolean)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path=public,pg_temp
AS $function$
DECLARE
  v_source public.company_accounts%rowtype;
  v_destination public.company_accounts%rowtype;
  v_operation public.company_account_movement_operations%rowtype;
  v_balance numeric(14,2);
  v_from_transaction_id bigint;
  v_to_transaction_id bigint;
  v_platform_role text;
  v_hash text;
BEGIN
  IF p_tenant_id IS NULL OR p_tenant_id<1 OR p_site_id IS NULL OR p_site_id<1
     OR p_user_id IS NULL OR p_user_id<1 OR p_from_account_id IS NULL OR p_from_account_id<1
     OR p_to_account_id IS NULL OR p_to_account_id<1 OR p_operation_key IS NULL
     OR p_amount IS NULL OR p_amount<=0 OR p_amount>100000000 OR p_amount<>round(p_amount,2)
     OR char_length(coalesce(p_description,''))<2 OR char_length(p_description)>255 THEN
    RAISE EXCEPTION 'INVALID_TRANSFER_AMOUNT' USING ERRCODE='P0001';
  END IF;
  IF p_from_account_id=p_to_account_id THEN
    RAISE EXCEPTION 'SAME_TRANSFER_ACCOUNT' USING ERRCODE='P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.sites s WHERE s.id=p_site_id AND s.tenant_id=p_tenant_id) THEN
    RAISE EXCEPTION 'SITE_OUT_OF_SCOPE' USING ERRCODE='P0001';
  END IF;

  v_hash:=md5(jsonb_build_object(
    'tenantId',p_tenant_id,'siteId',p_site_id,'userId',p_user_id,
    'fromAccountId',p_from_account_id,'toAccountId',p_to_account_id,
    'amount',p_amount,'description',btrim(p_description)
  )::text);

  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_tenant_id::text||':company-account-movement:'||p_operation_key::text,0
  ));
  SELECT op.* INTO v_operation
  FROM public.company_account_movement_operations op
  WHERE op.tenant_id=p_tenant_id AND op.operation_key=p_operation_key
  FOR UPDATE;
  IF FOUND THEN
    IF v_operation.operation_type<>'transfer' OR v_operation.payload_hash<>v_hash
       OR v_operation.counterpart_transaction_id IS NULL THEN
      RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='P0001';
    END IF;
    RETURN QUERY SELECT v_operation.primary_transaction_id,v_operation.counterpart_transaction_id,true;
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(least(p_from_account_id,p_to_account_id));
  PERFORM pg_advisory_xact_lock(greatest(p_from_account_id,p_to_account_id));
  SELECT * INTO v_source FROM public.company_accounts
  WHERE id=p_from_account_id AND tenant_id=p_tenant_id FOR UPDATE;
  SELECT * INTO v_destination FROM public.company_accounts
  WHERE id=p_to_account_id AND tenant_id=p_tenant_id FOR UPDATE;
  IF v_source.id IS NULL OR v_destination.id IS NULL THEN
    RAISE EXCEPTION 'ACCOUNT_NOT_FOUND' USING ERRCODE='P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM public.company_account_sites cs WHERE cs.tenant_id=p_tenant_id AND cs.account_id=p_from_account_id)
     AND NOT EXISTS (SELECT 1 FROM public.company_account_sites cs WHERE cs.tenant_id=p_tenant_id AND cs.account_id=p_from_account_id AND cs.site_id=p_site_id) THEN
    RAISE EXCEPTION 'ACCOUNT_SITE_OUT_OF_SCOPE' USING ERRCODE='P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM public.company_account_sites cs WHERE cs.tenant_id=p_tenant_id AND cs.account_id=p_to_account_id)
     AND NOT EXISTS (SELECT 1 FROM public.company_account_sites cs WHERE cs.tenant_id=p_tenant_id AND cs.account_id=p_to_account_id AND cs.site_id=p_site_id) THEN
    RAISE EXCEPTION 'ACCOUNT_SITE_OUT_OF_SCOPE' USING ERRCODE='P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM public.financial_settlements fs
    WHERE fs.tenant_id=p_tenant_id AND fs.site_id=p_site_id AND fs.status='locked'
      AND fs.period_start<=now() AND fs.period_end>=now()) THEN
    RAISE EXCEPTION 'FINANCIAL_PERIOD_LOCKED' USING ERRCODE='P0001';
  END IF;

  SELECT v_source.opening_balance+coalesce(sum(
    CASE WHEN tx.transaction_type IN ('deposit','transfer_in','collection') THEN tx.amount ELSE -tx.amount END
  ),0)
  INTO v_balance
  FROM public.account_transactions tx
  WHERE tx.tenant_id=p_tenant_id AND tx.account_id=p_from_account_id;
  IF p_amount>v_balance THEN
    RAISE EXCEPTION 'INSUFFICIENT_ACCOUNT_BALANCE' USING ERRCODE='P0001';
  END IF;

  INSERT INTO public.account_transactions(
    tenant_id,account_id,site_id,related_account_id,transaction_type,amount,description,created_by_user_id
  ) VALUES(
    p_tenant_id,p_from_account_id,p_site_id,p_to_account_id,'transfer_out',p_amount,btrim(p_description),p_user_id
  ) RETURNING id INTO v_from_transaction_id;
  INSERT INTO public.account_transactions(
    tenant_id,account_id,site_id,related_account_id,transaction_type,amount,description,created_by_user_id
  ) VALUES(
    p_tenant_id,p_to_account_id,p_site_id,p_from_account_id,'transfer_in',p_amount,btrim(p_description),p_user_id
  ) RETURNING id INTO v_to_transaction_id;

  SELECT u.platform_role INTO v_platform_role FROM public.users u WHERE u.id=p_user_id;
  INSERT INTO public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data,metadata
  ) VALUES(
    p_tenant_id,p_site_id,p_user_id,v_platform_role,'company_account',p_from_account_id::text,'transfer',
    jsonb_build_object('toAccountId',p_to_account_id,'amount',p_amount,'fromTransactionId',v_from_transaction_id,'toTransactionId',v_to_transaction_id),
    jsonb_build_object('operationKey',p_operation_key,'payloadHash',v_hash)
  );

  INSERT INTO public.company_account_movement_operations(
    tenant_id,operation_key,site_id,created_by_user_id,operation_type,payload_hash,primary_transaction_id,counterpart_transaction_id
  ) VALUES(
    p_tenant_id,p_operation_key,p_site_id,p_user_id,'transfer',v_hash,v_from_transaction_id,v_to_transaction_id
  );

  RETURN QUERY SELECT v_from_transaction_id,v_to_transaction_id,false;
END;
$function$;

ALTER FUNCTION public.powerhub_add_account_movement_idempotent(bigint,bigint,bigint,bigint,text,numeric,text,text,uuid) OWNER TO postgres;
ALTER FUNCTION public.powerhub_transfer_company_accounts_idempotent(bigint,bigint,bigint,bigint,bigint,numeric,text,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.powerhub_add_account_movement_idempotent(bigint,bigint,bigint,bigint,text,numeric,text,text,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.powerhub_transfer_company_accounts_idempotent(bigint,bigint,bigint,bigint,bigint,numeric,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_add_account_movement_idempotent(bigint,bigint,bigint,bigint,text,numeric,text,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.powerhub_transfer_company_accounts_idempotent(bigint,bigint,bigint,bigint,bigint,numeric,text,uuid) TO service_role;

NOTIFY pgrst,'reload schema';
