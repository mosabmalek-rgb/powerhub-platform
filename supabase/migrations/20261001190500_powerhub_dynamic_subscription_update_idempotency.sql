-- Catalog-driven idempotent subscription update RPC.
-- Isolated from the broader lifecycle bridge so existing wrappers retain their signature.
CREATE OR REPLACE FUNCTION public.powerhub_admin_update_subscription_idempotent(p_actor_user_id bigint, p_tenant_id bigint, p_package_code text, p_status text, p_billing_cycle text, p_ends_at timestamp with time zone, p_auto_renew boolean, p_notes text, p_sms_plan_id bigint, p_client_operation_id text)
 RETURNS TABLE(success boolean, subscription_id bigint, site_id bigint, replayed boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_role text;
  v_sub public.tenant_subscriptions%rowtype;
  v_site_id bigint;
  v_sms_active boolean;
  v_op public.offline_sync_operations%rowtype;
  v_package_code text;
begin
  if nullif(trim(p_client_operation_id),'') is null then
    raise exception 'CLIENT_OPERATION_REQUIRED' using errcode='P0001';
  end if;

  select platform_role
    into v_role
  from public.users
  where id=p_actor_user_id
    and role='admin'
    and account_status='active'
    and platform_role in('platform_owner','platform_admin','finance_admin');

  if v_role is null then
    raise exception 'FORBIDDEN_PLATFORM_ROLE' using errcode='42501';
  end if;

  v_package_code:=lower(nullif(btrim(p_package_code),''));
  perform public.powerhub_validate_package_code(v_package_code);

  if p_status not in('trial','active','overdue','suspended','cancelled') then
    raise exception 'INVALID_SUBSCRIPTION_STATUS' using errcode='22023';
  end if;

  if p_billing_cycle not in('monthly','yearly') then
    raise exception 'INVALID_BILLING_CYCLE' using errcode='22023';
  end if;

  if p_sms_plan_id is not null then
    select is_active
      into v_sms_active
    from public.platform_sms_plans
    where id=p_sms_plan_id;

    if not coalesce(v_sms_active,false) then
      raise exception 'SMS_PLAN_NOT_ACTIVE' using errcode='22023';
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtext('subscription-update:'||p_tenant_id::text)::bigint);

  select *
    into v_op
  from public.offline_sync_operations
  where user_id=p_actor_user_id
    and client_operation_id=trim(p_client_operation_id)
  for update;

  if found then
    if v_op.operation_type<>'subscription_update'
       or v_op.tenant_id<>p_tenant_id
       or v_op.response->>'packageCode'<>v_package_code
       or v_op.response->>'status'<>p_status
       or v_op.response->>'billingCycle'<>p_billing_cycle
       or (v_op.response->>'endsAt')::timestamptz is distinct from p_ends_at
       or (v_op.response->>'autoRenew')::boolean is distinct from p_auto_renew
       or coalesce(v_op.response->>'notes','')<>coalesce(p_notes,'')
       or (v_op.response->>'smsPlanId')::bigint is distinct from p_sms_plan_id
    then
      raise exception 'SUBSCRIPTION_UPDATE_OPERATION_CONFLICT' using errcode='P0001';
    end if;

    return query
      select true,
        (v_op.response->>'subscriptionId')::bigint,
        v_op.site_id,
        true;
    return;
  end if;

  select *
    into v_sub
  from public.tenant_subscriptions
  where tenant_id=p_tenant_id
  order by created_at desc,id desc
  limit 1
  for update;

  if not found then
    raise exception 'SUBSCRIPTION_NOT_FOUND' using errcode='P0002';
  end if;

  select s.id
    into v_site_id
  from public.sites s
  where s.tenant_id=p_tenant_id
  order by s.id
  limit 1;

  if v_site_id is null then
    raise exception 'SITE_NOT_FOUND' using errcode='P0002';
  end if;

  update public.tenant_subscriptions
  set package_code=v_package_code,
      status=p_status,
      billing_cycle=p_billing_cycle,
      ends_at=p_ends_at,
      auto_renew=p_auto_renew,
      notes=p_notes,
      sms_plan_id=p_sms_plan_id,
      updated_at=now()
  where id=v_sub.id;

  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,
    entity_type,entity_id,action,after_data
  )
  values(
    p_tenant_id,
    v_site_id,
    p_actor_user_id,
    v_role,
    'tenant_subscription',
    v_sub.id::text,
    'platform_admin_update_subscription',
    jsonb_build_object(
      'packageCode',v_package_code,
      'status',p_status,
      'billingCycle',p_billing_cycle,
      'endsAt',p_ends_at,
      'autoRenew',p_auto_renew,
      'smsPlanId',p_sms_plan_id
    )
  );

  insert into public.offline_sync_operations(
    tenant_id,site_id,user_id,client_operation_id,
    operation_type,entity_type,entity_id,response
  )
  values(
    p_tenant_id,v_site_id,p_actor_user_id,trim(p_client_operation_id),
    'subscription_update','tenant_subscription',v_sub.id,
    jsonb_build_object(
      'subscriptionId',v_sub.id,
      'packageCode',v_package_code,
      'status',p_status,
      'billingCycle',p_billing_cycle,
      'endsAt',p_ends_at,
      'autoRenew',p_auto_renew,
      'notes',coalesce(p_notes,''),
      'smsPlanId',p_sms_plan_id
    )
  );

  return query
    select true,v_sub.id,v_site_id,false;
end;
$function$;

revoke all on function public.powerhub_admin_update_subscription_idempotent(bigint,bigint,text,text,text,timestamptz,boolean,text,bigint,text) from public,anon,authenticated;
grant execute on function public.powerhub_admin_update_subscription_idempotent(bigint,bigint,text,text,text,timestamptz,boolean,text,bigint,text) to service_role;
