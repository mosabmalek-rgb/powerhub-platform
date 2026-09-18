create or replace function public.powerhub_set_tenant_status_atomic(
  p_tenant_id bigint,
  p_status text,
  p_actor_user_id bigint
)
returns table(success boolean, previous_status text, new_status text)
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_tenant public.tenants%rowtype;
  v_subscription public.tenant_subscriptions%rowtype;
  v_platform_role text;
begin
  if p_status not in ('active','suspended') then
    raise exception 'INVALID_TENANT_STATUS' using errcode='22023';
  end if;

  select *
    into v_tenant
  from public.tenants
  where id = p_tenant_id
  for update;

  if not found then
    raise exception 'TENANT_NOT_FOUND' using errcode='P0002';
  end if;

  select *
    into v_subscription
  from public.tenant_subscriptions
  where tenant_id = p_tenant_id
  order by updated_at desc nulls last, id desc
  limit 1
  for update;

  if not found then
    raise exception 'TENANT_SUBSCRIPTION_NOT_FOUND' using errcode='P0002';
  end if;

  select platform_role into v_platform_role
  from public.users
  where id = p_actor_user_id;

  update public.tenants
     set status = p_status,
         updated_at = now()
   where id = p_tenant_id;

  update public.tenant_subscriptions
     set status = p_status,
         updated_at = now()
   where id = v_subscription.id;

  insert into public.audit_logs(
    tenant_id,
    site_id,
    user_id,
    actor_platform_role,
    entity_type,
    entity_id,
    action,
    before_data,
    after_data
  )
  values(
    p_tenant_id,
    null,
    p_actor_user_id,
    v_platform_role,
    'tenant',
    p_tenant_id::text,
    'admin_set_tenant_status',
    jsonb_build_object(
      'tenantStatus', v_tenant.status,
      'subscriptionStatus', v_subscription.status
    ),
    jsonb_build_object(
      'tenantStatus', p_status,
      'subscriptionStatus', p_status
    )
  );

  return query
  select true, v_tenant.status, p_status;
end;
$function$;

revoke all on function public.powerhub_set_tenant_status_atomic(bigint,text,bigint) from public, anon, authenticated;
grant execute on function public.powerhub_set_tenant_status_atomic(bigint,text,bigint) to service_role;
