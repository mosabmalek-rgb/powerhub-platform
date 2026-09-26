-- PowerHub: fix ambiguous OUT parameter names in tenant feature-control writes.
-- PostgreSQL resolves OUT parameters in PL/pgSQL scope, so unqualified
-- ON CONFLICT (tenant_id, feature_key) can collide with the function result columns.
-- Use an explicit row update/insert path instead.

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
  v_updated boolean := false;
begin
  if not exists (
    select 1
    from public.users u
    where u.id = p_actor_user_id
      and u.role = 'admin'
      and u.platform_role in ('platform_owner', 'platform_admin')
      and u.account_status = 'active'
  ) then
    raise exception 'PLATFORM_ADMIN_FORBIDDEN' using errcode = 'P0001';
  end if;

  if p_status not in ('inherit','enabled','disabled') then
    raise exception 'INVALID_FEATURE_STATUS' using errcode='P0001';
  end if;
  if p_limit_mode not in ('inherit','manual','unlimited') then
    raise exception 'INVALID_FEATURE_LIMIT_MODE' using errcode='P0001';
  end if;
  if p_limit_mode='manual' and (p_manual_limit is null or p_manual_limit < 0) then
    raise exception 'INVALID_FEATURE_MANUAL_LIMIT' using errcode='P0001';
  end if;
  if p_limit_mode<>'manual' and p_manual_limit is not null then
    raise exception 'MANUAL_LIMIT_REQUIRES_MANUAL_MODE' using errcode='P0001';
  end if;
  if not exists (select 1 from public.tenants t where t.id=p_tenant_id) then
    raise exception 'TENANT_NOT_FOUND' using errcode='P0001';
  end if;

  select fc.is_active
    into v_feature_active
    from public.feature_catalog fc
   where fc.feature_key=p_feature_key
   limit 1;

  if not found then
    raise exception 'FEATURE_NOT_FOUND' using errcode='P0001';
  end if;
  if not v_feature_active then
    raise exception 'FEATURE_GLOBALLY_DISABLED' using errcode='P0001';
  end if;

  perform pg_advisory_xact_lock(
    hashtext('tenant-feature-control:' || p_tenant_id::text || ':' || p_feature_key)::bigint
  );

  select to_jsonb(c) - 'id'
    into v_before
    from public.tenant_feature_controls c
   where c.tenant_id=p_tenant_id
     and c.feature_key=p_feature_key
   for update;

  select ts.package_code
    into v_package_code
    from public.tenant_subscriptions ts
   where ts.tenant_id=p_tenant_id
     and ts.status in ('trial','active')
     and (ts.ends_at is null or ts.ends_at > now())
   order by ts.created_at desc
   limit 1;

  select p.policy
    into v_policy
    from public.package_feature_policies p
   where p.package_code=v_package_code
     and p.feature_key=p_feature_key;

  v_allowed := coalesce(v_policy in ('included','addon'),false);

  if p_status='enabled' and not v_allowed then
    raise exception 'FEATURE_NOT_AVAILABLE_IN_PACKAGE' using errcode='P0001';
  end if;

  update public.tenant_feature_controls c
     set status=p_status,
         limit_mode=p_limit_mode,
         manual_limit=p_manual_limit,
         override_reason=nullif(btrim(p_reason),''),
         updated_by_user_id=p_actor_user_id,
         updated_at=v_now
   where c.tenant_id=p_tenant_id
     and c.feature_key=p_feature_key;
  v_updated := found;

  if not v_updated then
    insert into public.tenant_feature_controls(
      tenant_id,feature_key,status,limit_mode,manual_limit,
      override_reason,updated_by_user_id,updated_at
    )
    values(
      p_tenant_id,p_feature_key,p_status,p_limit_mode,p_manual_limit,
      nullif(btrim(p_reason),''),
      p_actor_user_id,v_now
    );
  end if;

  if p_feature_key in ('subscriber_portal_logo','payment_documentation') then
    update public.tenant_feature_entitlements e
       set is_enabled=(p_status='enabled'),
           activated_by_user_id=case when p_status='enabled' then p_actor_user_id else null end,
           activated_at=case when p_status='enabled' then v_now else null end,
           updated_at=v_now
     where e.tenant_id=p_tenant_id
       and e.feature_key=p_feature_key;
    v_updated := found;

    if p_status='inherit' then
      delete from public.tenant_feature_entitlements e
       where e.tenant_id=p_tenant_id
         and e.feature_key=p_feature_key;
    elsif not v_updated then
      insert into public.tenant_feature_entitlements(
        tenant_id,feature_key,is_enabled,activated_by_user_id,
        activated_at,created_at,updated_at
      )
      values(
        p_tenant_id,p_feature_key,p_status='enabled',
        case when p_status='enabled' then p_actor_user_id else null end,
        case when p_status='enabled' then v_now else null end,
        v_now,v_now
      );
    end if;
  end if;

  insert into public.tenant_feature_control_audit(
    tenant_id,feature_key,actor_user_id,action,before_data,after_data,reason
  )
  values(
    p_tenant_id,p_feature_key,p_actor_user_id,
    case when v_before is null then 'create' else 'update' end,
    v_before,
    (select to_jsonb(c) - 'id'
       from public.tenant_feature_controls c
      where c.tenant_id=p_tenant_id
        and c.feature_key=p_feature_key),
    nullif(btrim(p_reason),'')
  );

  return query
  select c.tenant_id,c.feature_key,c.status,c.limit_mode,c.manual_limit,
         c.override_reason,c.updated_by_user_id,c.updated_at
    from public.tenant_feature_controls c
   where c.tenant_id=p_tenant_id
     and c.feature_key=p_feature_key;
end;
$function$;

revoke all on function public.powerhub_admin_set_tenant_feature_control(bigint,bigint,text,text,text,integer,text) from public,anon,authenticated;
grant execute on function public.powerhub_admin_set_tenant_feature_control(bigint,bigint,text,text,text,integer,text) to service_role;
