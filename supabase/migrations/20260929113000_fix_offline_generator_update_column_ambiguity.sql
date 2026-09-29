-- Fix the SECURITY DEFINER offline generator update RPC.
-- RETURNS TABLE exposes an implicit PL/pgSQL variable named "id", so the
-- unqualified UPDATE target column is ambiguous once the function executes
-- with the intended production security boundary.

create or replace function public.powerhub_sync_generator_update(
  p_site_id bigint,
  p_generator_id bigint,
  p_name text,
  p_rated_capacity_kw numeric,
  p_fuel_level_liters numeric,
  p_operating_hours numeric,
  p_status text,
  p_expected_updated_at timestamptz,
  p_client_operation_id text
)
returns table(id bigint, name text, updated_at timestamptz, replayed boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_user_id bigint;
  v_tenant_id bigint;
  v_role text;
  v_allowed boolean;
  v_current public.generators%rowtype;
  v_updated public.generators%rowtype;
  v_operation public.offline_sync_operations%rowtype;
begin
  select u.id into v_user_id
  from public.users u
  where u.auth_user_id=auth.uid() and u.account_status='active'
  limit 1;
  if v_user_id is null then raise exception 'AUTH_USER_NOT_FOUND'; end if;

  select s.tenant_id into v_tenant_id
  from public.sites s
  where s.id=p_site_id and s.status <> 'archived';
  if v_tenant_id is null then raise exception 'SITE_OUT_OF_SCOPE'; end if;

  select case when u.role='admin' then 'owner' else null end into v_role
  from public.users u where u.id=v_user_id;

  if v_role is null then
    select 'owner' into v_role
    from public.tenant_members m
    where m.tenant_id=v_tenant_id and m.user_id=v_user_id
      and m.role='owner' and m.is_active and m.membership_status='active'
    limit 1;
  end if;

  if v_role is null then
    select p.role into v_role
    from public.staff_profiles p
    where p.tenant_id=v_tenant_id and p.user_id=v_user_id
      and p.is_active and (p.site_id is null or p.site_id=p_site_id)
      and ((p.permissions @> '[\"manageGenerators\"]'::jsonb)
           or p.role in ('owner','manager','technician'))
    limit 1;
  end if;

  if v_role is null then raise exception 'GENERATOR_MANAGEMENT_FORBIDDEN'; end if;

  if v_role <> 'owner' then
    select pr.is_allowed into v_allowed
    from public.platform_role_policies pr
    where pr.role=v_role and pr.capability='manageGenerators'
    limit 1;
    if v_allowed is false then raise exception 'GENERATOR_MANAGEMENT_FORBIDDEN'; end if;
  end if;

  if p_client_operation_id is null then raise exception 'CLIENT_OPERATION_REQUIRED'; end if;

  select * into v_operation
  from public.offline_sync_operations o
  where o.user_id=v_user_id and o.client_operation_id=p_client_operation_id
  limit 1;

  if found then
    if v_operation.operation_type <> 'generator_update' then
      raise exception 'GENERATOR_OPERATION_TYPE_CONFLICT';
    end if;
    return query
      select (v_operation.response->>'id')::bigint,
             coalesce(v_operation.response->>'name',''),
             (v_operation.response->>'updatedAt')::timestamptz,
             true;
    return;
  end if;

  select * into v_current
  from public.generators g
  where g.id=p_generator_id
    and g.tenant_id=v_tenant_id
    and g.site_id=p_site_id
  limit 1;

  if not found then raise exception 'GENERATOR_OUT_OF_SCOPE'; end if;

  if p_expected_updated_at is null or v_current.updated_at<>p_expected_updated_at then
    raise exception 'GENERATOR_VERSION_CONFLICT';
  end if;

  update public.generators as g
  set name=trim(p_name),
      rated_capacity_kw=p_rated_capacity_kw,
      fuel_level_liters=p_fuel_level_liters,
      operating_hours=p_operating_hours,
      status=p_status,
      updated_at=clock_timestamp()
  where g.id=p_generator_id
    and g.tenant_id=v_tenant_id
    and g.site_id=p_site_id
    and g.updated_at=p_expected_updated_at
  returning g.* into v_updated;

  if not found then raise exception 'GENERATOR_VERSION_CONFLICT'; end if;

  insert into public.offline_sync_operations(
    tenant_id,site_id,user_id,client_operation_id,operation_type,
    entity_type,entity_id,response
  )
  values(
    v_tenant_id,p_site_id,v_user_id,p_client_operation_id,'generator_update',
    'generator',v_updated.id,
    jsonb_build_object('id',v_updated.id,'name',v_updated.name,'updatedAt',v_updated.updated_at)
  );

  return query select v_updated.id,v_updated.name,v_updated.updated_at,false;

exception when unique_violation then
  select * into v_operation
  from public.offline_sync_operations o
  where o.user_id=v_user_id and o.client_operation_id=p_client_operation_id
  limit 1;

  if found and v_operation.operation_type='generator_update' then
    return query
      select (v_operation.response->>'id')::bigint,
             coalesce(v_operation.response->>'name',v_updated.name),
             (v_operation.response->>'updatedAt')::timestamptz,
             true;
    return;
  end if;
  raise;
end;
$function$;

revoke execute on function public.powerhub_sync_generator_update(
  bigint,bigint,text,numeric,numeric,numeric,text,timestamptz,text
) from public, anon;
grant execute on function public.powerhub_sync_generator_update(
  bigint,bigint,text,numeric,numeric,numeric,text,timestamptz,text
) to authenticated;