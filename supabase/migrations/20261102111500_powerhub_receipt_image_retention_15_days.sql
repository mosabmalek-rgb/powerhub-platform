-- The approved policy is now a uniform 15-day lifetime for payment receipt images.
-- The Storage cleaner uses the object's created_at timestamp; request created_at is
-- the persisted upload/submission anchor used for the corresponding metadata deadline.
CREATE OR REPLACE FUNCTION public.powerhub_approve_payment_documentation(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_request_id bigint
) RETURNS TABLE(payment_id bigint,replayed boolean)
LANGUAGE plpgsql
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_request public.payment_documentation_requests%rowtype;
  v_payment_id bigint;
  v_replayed boolean;
  v_payment_no text;
  v_platform_role text;
  v_tenant_role text;
  v_retention_until timestamptz;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('payment-documentation-request:'||p_request_id::text,0));
  SELECT * INTO v_request FROM public.payment_documentation_requests
  WHERE id=p_request_id AND tenant_id=p_tenant_id AND site_id=p_site_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PAYMENT_DOCUMENTATION_NOT_FOUND' USING errcode='P0001'; END IF;
  IF v_request.status='approved' AND v_request.payment_id IS NOT NULL THEN RETURN QUERY SELECT v_request.payment_id,true; RETURN; END IF;
  IF v_request.status='rejected' THEN RAISE EXCEPTION 'PAYMENT_DOCUMENTATION_REJECTED' USING errcode='P0001'; END IF;
  IF v_request.status<>'pending' THEN RAISE EXCEPTION 'PAYMENT_DOCUMENTATION_INVALID_STATE' USING errcode='P0001'; END IF;

  v_payment_no:=format('PH-EDOC-%s-%s',to_char(clock_timestamp(),'YYYYMMDDHH24MISSMS'),v_request.id);
  SELECT created.payment_id,created.replayed INTO v_payment_id,v_replayed
  FROM public.powerhub_create_payment(p_tenant_id,p_site_id,p_user_id,v_request.subscriber_id,v_request.invoice_id,
    v_payment_no,v_request.payment_amount,v_request.payment_method,v_request.destination_account_id,v_request.sender_phone,
    CASE WHEN v_request.payment_method<>'cash' THEN v_request.payment_method ELSE NULL END,
    v_request.reference_no,v_request.receipt_image_key,v_request.receipt_image_hash,NULL,gen_random_uuid()) AS created;

  v_retention_until:=v_request.created_at+interval '15 days';
  UPDATE public.payment_documentation_requests SET status='approved',reviewed_by_user_id=p_user_id,reviewed_at=now(),
    payment_id=v_payment_id,receipt_image_retention_until=v_retention_until,updated_at=now()
  WHERE id=v_request.id AND status='pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'PAYMENT_DOCUMENTATION_STATE_RACE' USING errcode='P0001'; END IF;

  SELECT u.platform_role,m.role INTO v_platform_role,v_tenant_role
  FROM public.users u LEFT JOIN public.tenant_members m ON m.user_id=u.id AND m.tenant_id=p_tenant_id
  WHERE u.id=p_user_id;
  IF v_platform_role NOT IN ('platform_owner','platform_admin','finance_admin') THEN v_platform_role:=NULL; END IF;
  INSERT INTO public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,actor_tenant_role,entity_type,entity_id,action,after_data)
  VALUES(p_tenant_id,p_site_id,p_user_id,v_platform_role,v_tenant_role,'payment_documentation_request',v_request.id::text,'approve',
    jsonb_build_object('paymentId',v_payment_id,'paymentNo',v_payment_no,'receiptRetentionUntil',v_retention_until));
  RETURN QUERY SELECT v_payment_id,COALESCE(v_replayed,false);
END;
$function$;

CREATE OR REPLACE FUNCTION public.powerhub_reject_payment_documentation(
  p_tenant_id bigint,p_site_id bigint,p_user_id bigint,p_request_id bigint,p_rejection_reason text
) RETURNS TABLE(request_id bigint)
LANGUAGE plpgsql
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_request public.payment_documentation_requests%rowtype;
  v_platform_role text;
  v_tenant_role text;
  v_retention_until timestamptz;
BEGIN
  IF nullif(btrim(p_rejection_reason),'') IS NULL THEN RAISE EXCEPTION 'REJECTION_REASON_REQUIRED' USING errcode='P0001'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('payment-documentation-request:'||p_request_id::text,0));
  SELECT * INTO v_request FROM public.payment_documentation_requests
  WHERE id=p_request_id AND tenant_id=p_tenant_id AND site_id=p_site_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PAYMENT_DOCUMENTATION_NOT_FOUND' USING errcode='P0001'; END IF;
  IF v_request.status='approved' THEN RAISE EXCEPTION 'PAYMENT_DOCUMENTATION_ALREADY_APPROVED' USING errcode='P0001'; END IF;
  IF v_request.status='rejected' THEN RETURN QUERY SELECT v_request.id; RETURN; END IF;

  v_retention_until:=v_request.created_at+interval '15 days';
  UPDATE public.payment_documentation_requests SET status='rejected',rejection_reason=btrim(p_rejection_reason),
    reviewed_by_user_id=p_user_id,reviewed_at=now(),receipt_image_retention_until=v_retention_until,updated_at=now()
  WHERE id=v_request.id;

  SELECT u.platform_role,m.role INTO v_platform_role,v_tenant_role FROM public.users u
  LEFT JOIN public.tenant_members m ON m.user_id=u.id AND m.tenant_id=p_tenant_id WHERE u.id=p_user_id;
  IF v_platform_role NOT IN ('platform_owner','platform_admin','finance_admin') THEN v_platform_role:=NULL; END IF;
  INSERT INTO public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,actor_tenant_role,entity_type,entity_id,action,after_data)
  VALUES(p_tenant_id,p_site_id,p_user_id,v_platform_role,v_tenant_role,'payment_documentation_request',v_request.id::text,'reject',
    jsonb_build_object('reason',btrim(p_rejection_reason),'receiptRetentionUntil',v_retention_until));
  RETURN QUERY SELECT v_request.id;
END;
$function$;
