-- PowerHub unified feature-control authority.
-- The Features & Limits center is the single tenant-level control surface.
-- Package policies remain owned by subscription_package_catalog/package_feature_policies.
-- Legacy logo/payment entitlements are synchronized for runtime compatibility.

create or replace function public.powerhub_admin_feature_catalog()
returns table(
  feature_key text,
  name text,
  description text,
  category text,
  feature_type text,
  limit_type text,
  enforcement_mode text,
  is_active boolean,
  sort_order integer
)
language sql
stable
security definer
set search_path to 'public','pg_temp'
as $$
  select feature_key,name,description,category,feature_type,limit_type,enforcement_mode,is_active,sort_order
  from public.feature_catalog
  order by sort_order, feature_key;
$$;

create or replace function public.powerhub_resolve_tenant_feature_policy(
  p_tenant_id bigint,
  p_feature_key text
)
returns table(
  feature_key text,
  package_code text,
  package_policy text,
  eligible boolean,
  enabled boolean,
  package_limit integer,
  effective_limit integer,
  effective_limit_mode text,
  control_status text
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with subscription as (
    select ts.package_code
    from public.tenant_subscriptions ts
    where ts.tenant_id = p_tenant_id
      and ts.status in ('trial','active')
      and (ts.ends_at is null or ts.ends_at > now())
    order by ts.created_at desc
    limit 1
  ),
  feature as (
    select fc.is_active
    from public.feature_catalog fc
    where fc.feature_key = p_feature_key
    limit 1
  ),
  package_policy as (
    select p.package_code, p.policy, p.default_limit, p.limit_mode
    from public.package_feature_policies p
    where p.package_code = (select package_code from subscription)
      and p.feature_key = p_feature_key
  ),
  control as (
    select c.status, c.limit_mode, c.manual_limit
    from public.tenant_feature_controls c
    where c.tenant_id = p_tenant_id
      and c.feature_key = p_feature_key
  )
  select
    p_feature_key,
    pp.package_code,
    coalesce(pp.policy, 'not_included') as package_policy,
    coalesce((select is_active from feature), false)
      and coalesce(pp.policy in ('included','addon'), false) as eligible,
    case
      when coalesce((select is_active from feature), false) = false then false
      when coalesce(pp.policy in ('included','addon'), false) = false then false
      when coalesce(c.status, 'inherit') = 'enabled' then true
      when coalesce(c.status, 'inherit') = 'disabled' then false
      else pp.policy = 'included'
        and p_feature_key not in ('subscriber_portal_logo','payment_documentation')
    end as enabled,
    pp.default_limit as package_limit,
    case
      when coalesce(c.limit_mode, 'inherit') = 'manual' then c.manual_limit
      when coalesce(c.limit_mode, 'inherit') = 'unlimited' then null
      else pp.default_limit
    end as effective_limit,
    case
      when coalesce(c.limit_mode, 'inherit') = 'manual' then 'manual'
      when coalesce(c.limit_mode, 'inherit') = 'unlimited' then 'unlimited'
      else coalesce(pp.limit_mode, 'inherit')
    end as effective_limit_mode,
    coalesce(c.status, 'inherit') as control_status
  from package_policy pp
  full join control c on true;
$$;

create or replace function public.powerhub_subscriber_portal_logo_access(p_tenant_id bigint)
returns table(allowed boolean, policy text, package_code text, entitlement_enabled boolean)
language plpgsql
stable
security definer
set search_path to 'public','pg_temp'
as $function$
declare
 v_global_enabled boolean := false;
 v_package_code text;
 v_package jsonb;
 v_policy text := 'not_included';
 v_entitlement boolean;
 v_control_found boolean := false;
 v_allowed boolean := false;
begin
 select coalesce(fc.is_active,false) into v_global_enabled
 from public.feature_catalog fc
 where fc.feature_key='subscriber_portal_logo'
 limit 1;

 select ts.package_code into v_package_code
 from public.tenant_subscriptions ts
 where ts.tenant_id=p_tenant_id and ts.status in ('trial','active')
   and (ts.ends_at is null or ts.ends_at>now())
 order by ts.created_at desc limit 1;

 if v_package_code is not null then
   select package_row into v_package
   from jsonb_array_elements(coalesce(
     (select ps.value->'packages' from public.platform_settings ps
      where ps.setting_key='subscription_package_catalog' and ps.is_enabled=true limit 1),
     '[]'::jsonb)) as package_row
   where package_row->>'code'=v_package_code
     and coalesce((package_row->>'active')::boolean,true)=true limit 1;
   if v_package is not null then
     v_policy:=case
       when v_package ? 'logoPolicy' then coalesce(v_package->>'logoPolicy','not_included')
       when coalesce((v_package->'features'->'logo'->>'included')::boolean,false) then 'included'
       when coalesce((v_package->'features'->'logo'->>'enabled')::boolean,false) then 'addon'
       else 'not_included' end;
   end if;
 end if;

 select true, c.status='enabled'
 into v_control_found, v_entitlement
 from public.tenant_feature_controls c
 where c.tenant_id=p_tenant_id and c.feature_key='subscriber_portal_logo'
 limit 1;

 if not v_control_found then
   select e.is_enabled into v_entitlement
   from public.tenant_feature_entitlements e
   where e.tenant_id=p_tenant_id and e.feature_key='subscriber_portal_logo'
   limit 1;
 end if;

 v_allowed:=v_global_enabled and v_policy in ('included','addon') and case
   when v_policy='included' then coalesce(v_entitlement,true)
   when v_policy='addon' then coalesce(v_entitlement,false)
   else false end;

 return query select v_allowed,v_policy,v_package_code,coalesce(v_entitlement,false);
end;
$function$;

create or replace function public.powerhub_payment_documentation_access(p_tenant_id bigint)
returns table(allowed boolean, policy text, package_code text, entitlement_enabled boolean)
language plpgsql
stable
security definer
set search_path to 'public','pg_temp'
as $function$
declare
  v_global_enabled boolean := false;
  v_package_code text;
  v_package jsonb;
  v_policy text := 'not_included';
  v_entitlement boolean;
  v_control_found boolean := false;
  v_allowed boolean := false;
begin
  select coalesce(fc.is_active,false) into v_global_enabled
  from public.feature_catalog fc
  where fc.feature_key='payment_documentation'
  limit 1;

  select ts.package_code into v_package_code
  from public.tenant_subscriptions ts
  where ts.tenant_id=p_tenant_id
    and ts.status in ('trial','active')
    and (ts.ends_at is null or ts.ends_at>now())
  order by ts.created_at desc
  limit 1;

  if v_package_code is not null then
    select package_row into v_package
    from jsonb_array_elements(coalesce(
      (select ps.value->'packages' from public.platform_settings ps
       where ps.setting_key='subscription_package_catalog' and ps.is_enabled=true limit 1),
      '[]'::jsonb
    )) as package_row
    where package_row->>'code'=v_package_code
      and coalesce((package_row->>'active')::boolean,true)=true
    limit 1;

    if v_package is not null then
      v_policy:=case
        when v_package ? 'paymentDocumentationPolicy'
          then coalesce(v_package->>'paymentDocumentationPolicy','not_included')
        when coalesce((v_package->'features'->'paymentDocumentation'->>'included')::boolean,false)
          then 'included'
        when coalesce((v_package->'features'->'paymentDocumentation'->>'enabled')::boolean,false)
          then 'addon'
        else 'not_included'
      end;
    end if;
  end if;

  select true, c.status='enabled'
  into v_control_found, v_entitlement
  from public.tenant_feature_controls c
  where c.tenant_id=p_tenant_id and c.feature_key='payment_documentation'
  limit 1;

  if not v_control_found then
    select e.is_enabled into v_entitlement
    from public.tenant_feature_entitlements e
    where e.tenant_id=p_tenant_id
      and e.feature_key='payment_documentation'
    limit 1;
  end if;

  v_allowed := v_global_enabled
    and v_policy in ('included','addon')
    and case
      when v_policy='included' then coalesce(v_entitlement,true)
      when v_policy='addon' then coalesce(v_entitlement,false)
      else false
    end;

  return query
  select v_allowed, v_policy, v_package_code, coalesce(v_entitlement,false);
end;
$function$;

create or replace function public.powerhub_admin_set_tenant_feature_control(
  p_actor_user_id bigint,
  p_tenant_id bigint,
  p_feature_key text,
  p_status text,
  p_limit_mode text,
  p_manual_limit integer,
  p_reason text default null
)
returns table(
  tenant_id bigint,
  feature_key text,
  status text,
  limit_mode text,
  manual_limit integer,
  override_reason text,
  updated_by_user_id bigint,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $function$
declare
  v_before jsonb;
  v_now timestamptz := now();
  v_policy text;
  v_package_code text;
  v_feature_active boolean := false;
  v_allowed boolean := false;
begin
  if not exists (
    select 1
    from public.users
    where id = p_actor_user_id
      and role = 'admin'
      and platform_role in ('platform_owner', 'platform_admin')
      and account_status = 'active'
  ) then
    raise exception 'PLATFORM_ADMIN_FORBIDDEN' using errcode = 'P0001';
  end if;
  if p_status not in ('inherit','enabled','disabled') then raise exception 'INVALID_FEATURE_STATUS' using errcode='P0001'; end if;
  if p_limit_mode not in ('inherit','manual','unlimited') then raise exception 'INVALID_FEATURE_LIMIT_MODE' using errcode='P0001'; end if;
  if p_limit_mode='manual' and (p_manual_limit is null or p_manual_limit < 0) then raise exception 'INVALID_FEATURE_MANUAL_LIMIT' using errcode='P0001'; end if;
  if p_limit_mode<>'manual' and p_manual_limit is not null then raise exception 'MANUAL_LIMIT_REQUIRES_MANUAL_MODE' using errcode='P0001'; end if;
  if not exists (select 1 from public.tenants where id=p_tenant_id) then raise exception 'TENANT_NOT_FOUND' using errcode='P0001'; end if;

  select fc.is_active into v_feature_active
  from public.feature_catalog fc
  where fc.feature_key=p_feature_key and fc.is_active=true
  limit 1;
  if not found then
    if exists(select 1 from public.feature_catalog where feature_key=p_feature_key)
    then raise exception 'FEATURE_GLOBALLY_DISABLED' using errcode='P0001';
    else raise exception 'FEATURE_NOT_FOUND' using errcode='P0001';
    end if;
  end if;

  select to_jsonb(c) - 'id' into v_before
  from public.tenant_feature_controls c
  where c.tenant_id=p_tenant_id and c.feature_key=p_feature_key;

  select ts.package_code into v_package_code
  from public.tenant_subscriptions ts
  where ts.tenant_id=p_tenant_id and ts.status in ('trial','active')
    and (ts.ends_at is null or ts.ends_at > now())
  order by ts.created_at desc limit 1;

  select p.policy into v_policy
  from public.package_feature_policies p
  where p.package_code=v_package_code and p.feature_key=p_feature_key;

  v_allowed := coalesce(v_policy in ('included','addon'),false);
  if p_status='enabled' and not v_allowed then raise exception 'FEATURE_NOT_AVAILABLE_IN_PACKAGE' using errcode='P0001'; end if;

  insert into public.tenant_feature_controls(
    tenant_id,feature_key,status,limit_mode,manual_limit,override_reason,updated_by_user_id,updated_at
  )
  values(
    p_tenant_id,p_feature_key,p_status,p_limit_mode,p_manual_limit,
    nullif(btrim(p_reason),''),
    p_actor_user_id,v_now
  )
  on conflict (tenant_id,feature_key) do update set
    status=excluded.status,
    limit_mode=excluded.limit_mode,
    manual_limit=excluded.manual_limit,
    override_reason=excluded.override_reason,
    updated_by_user_id=excluded.updated_by_user_id,
    updated_at=v_now;

  if p_feature_key in ('subscriber_portal_logo','payment_documentation') then
    if p_status='inherit' then
      delete from public.tenant_feature_entitlements
      where tenant_id=p_tenant_id and feature_key=p_feature_key;
    else
      insert into public.tenant_feature_entitlements(
        tenant_id,feature_key,is_enabled,activated_by_user_id,activated_at,created_at,updated_at
      )
      values(
        p_tenant_id,p_feature_key,p_status='enabled',
        case when p_status='enabled' then p_actor_user_id else null end,
        case when p_status='enabled' then v_now else null end,
        v_now,v_now
      )
      on conflict (tenant_id,feature_key) do update set
        is_enabled=excluded.is_enabled,
        activated_by_user_id=excluded.activated_by_user_id,
        activated_at=excluded.activated_at,
        updated_at=v_now;
    end if;
  end if;

  insert into public.tenant_feature_control_audit(
    tenant_id,feature_key,actor_user_id,action,before_data,after_data,reason
  )
  values(
    p_tenant_id,p_feature_key,p_actor_user_id,
    case when v_before is null then 'create' else 'update' end,
    v_before,to_jsonb(jsonb_build_object(
      'status',p_status,'limitMode',p_limit_mode,'manualLimit',p_manual_limit
    )),nullif(btrim(p_reason),'')
  );

  return query
  select c.tenant_id,c.feature_key,c.status,c.limit_mode,c.manual_limit,c.override_reason,c.updated_by_user_id,c.updated_at
  from public.tenant_feature_controls c
  where c.tenant_id=p_tenant_id and c.feature_key=p_feature_key;
end;
$function$;

create or replace function public.powerhub_admin_reset_tenant_feature_control(
  p_actor_user_id bigint,
  p_tenant_id bigint,
  p_feature_key text,
  p_reason text default null
)
returns boolean
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $function$
declare
  v_before jsonb;
begin
  if not exists (
    select 1
    from public.users
    where id = p_actor_user_id
      and role = 'admin'
      and platform_role in ('platform_owner', 'platform_admin')
      and account_status = 'active'
  ) then
    raise exception 'PLATFORM_ADMIN_FORBIDDEN' using errcode = 'P0001';
  end if;
  select to_jsonb(c) - 'id' into v_before
  from public.tenant_feature_controls c
  where c.tenant_id=p_tenant_id and c.feature_key=p_feature_key;

  delete from public.tenant_feature_controls
  where tenant_id=p_tenant_id and feature_key=p_feature_key;

  if p_feature_key in ('subscriber_portal_logo','payment_documentation') then
    delete from public.tenant_feature_entitlements
    where tenant_id=p_tenant_id and feature_key=p_feature_key;
  end if;

  if v_before is not null then
    insert into public.tenant_feature_control_audit(
      tenant_id,feature_key,actor_user_id,action,before_data,after_data,reason
    )
    values(p_tenant_id,p_feature_key,p_actor_user_id,'reset',v_before,null,nullif(btrim(p_reason),''));
  end if;

  return true;
end;
$function$;

create or replace function public.powerhub_admin_set_feature_global(
  p_actor_user_id bigint,
  p_feature_key text,
  p_is_active boolean
)
returns table(feature_key text,is_active boolean)
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $function$
declare
  v_role text;
  v_setting_key text;
begin
  select platform_role into v_role
  from public.users
  where id=p_actor_user_id
    and role='admin'
    and platform_role in ('platform_owner','platform_admin')
    and account_status='active';

  if not found then raise exception 'PLATFORM_ADMIN_FORBIDDEN' using errcode='P0001'; end if;

  if not exists(select 1 from public.feature_catalog where feature_key=p_feature_key) then
    raise exception 'FEATURE_NOT_FOUND' using errcode='P0001';
  end if;

  update public.feature_catalog
  set is_active=p_is_active, updated_at=now()
  where feature_key=p_feature_key;

  v_setting_key := case p_feature_key
    when 'subscriber_portal_logo' then 'subscriber_portal_logo'
    when 'payment_documentation' then 'payment_documentation'
    when 'branch_management' then 'branch_feature'
    else null
  end;

  if v_setting_key is not null then
    insert into public.platform_settings(setting_key,is_enabled,value,message,updated_at)
    values(v_setting_key,p_is_active,jsonb_build_object('feature',p_feature_key),'إدارة إتاحة الميزة من مركز الميزات والحدود.',now())
    on conflict(setting_key) do update set
      is_enabled=excluded.is_enabled,
      value=case when public.platform_settings.value is null then excluded.value else public.platform_settings.value end,
      message=excluded.message,
      updated_at=now();
  end if;

  return query select p_feature_key,p_is_active;
end;
$function$;

revoke all on function public.powerhub_admin_set_feature_global(bigint,text,boolean) from public,anon,authenticated;
grant execute on function public.powerhub_admin_set_feature_global(bigint,text,boolean) to service_role;

-- These functions are called only through the trusted server adapter.
-- Never expose SECURITY DEFINER feature or tenant-control functions to PostgREST roles.
revoke all on function public.powerhub_admin_feature_catalog() from public,anon,authenticated;
grant execute on function public.powerhub_admin_feature_catalog() to service_role;

revoke all on function public.powerhub_resolve_tenant_feature_policy(bigint,text) from public,anon,authenticated;
grant execute on function public.powerhub_resolve_tenant_feature_policy(bigint,text) to service_role;

revoke all on function public.powerhub_subscriber_portal_logo_access(bigint) from public,anon,authenticated;
grant execute on function public.powerhub_subscriber_portal_logo_access(bigint) to service_role;

revoke all on function public.powerhub_payment_documentation_access(bigint) from public,anon,authenticated;
grant execute on function public.powerhub_payment_documentation_access(bigint) to service_role;

revoke all on function public.powerhub_admin_set_tenant_feature_control(bigint,bigint,text,text,text,integer,text) from public,anon,authenticated;
grant execute on function public.powerhub_admin_set_tenant_feature_control(bigint,bigint,text,text,text,integer,text) to service_role;

revoke all on function public.powerhub_admin_reset_tenant_feature_control(bigint,bigint,text,text) from public,anon,authenticated;
grant execute on function public.powerhub_admin_reset_tenant_feature_control(bigint,bigint,text,text) to service_role;
