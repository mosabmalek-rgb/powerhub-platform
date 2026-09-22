-- Privileged RPCs for unified tenant feature control.
-- Authorization is enforced in the server procedure before invoking these RPCs.

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
  v_after jsonb;
  v_now timestamptz := now();
  v_policy text;
  v_package_code text;
  v_allowed boolean := false;
begin
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
  if not exists (select 1 from public.tenants where id=p_tenant_id) then
    raise exception 'TENANT_NOT_FOUND' using errcode='P0001';
  end if;
  if not exists (select 1 from public.feature_catalog where feature_key=p_feature_key and is_active=true) then
    raise exception 'FEATURE_NOT_FOUND' using errcode='P0001';
  end if;

  select to_jsonb(c) - 'id' into v_before
  from public.tenant_feature_controls c
  where c.tenant_id=p_tenant_id and c.feature_key=p_feature_key;

  -- A manual activation cannot bypass package eligibility.
  select ts.plan into v_package_code
  from public.tenant_subscriptions ts
  where ts.tenant_id=p_tenant_id
    and ts.status in ('trial','active')
    and (ts.ends_at is null or ts.ends_at > now())
  order by ts.created_at desc
  limit 1;

  select p.policy into v_policy
  from public.package_feature_policies p
  where p.package_code=v_package_code and p.feature_key=p_feature_key;

  v_allowed := coalesce(v_policy in ('included','addon'),false);

  if p_status='enabled' and not v_allowed then
    raise exception 'FEATURE_NOT_AVAILABLE_IN_PACKAGE' using errcode='P0001';
  end if;

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

  select to_jsonb(c) - 'id' into v_after
  from public.tenant_feature_controls c
  where c.tenant_id=p_tenant_id and c.feature_key=p_feature_key;

  insert into public.tenant_feature_control_audit(
    tenant_id,feature_key,actor_user_id,action,before_data,after_data,reason
  )
  values(
    p_tenant_id,p_feature_key,p_actor_user_id,
    case when v_before is null then 'create' else 'update' end,
    v_before,v_after,nullif(btrim(p_reason),'')
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
  select to_jsonb(c) - 'id' into v_before
  from public.tenant_feature_controls c
  where c.tenant_id=p_tenant_id and c.feature_key=p_feature_key;

  delete from public.tenant_feature_controls
  where tenant_id=p_tenant_id and feature_key=p_feature_key;

  if v_before is not null then
    insert into public.tenant_feature_control_audit(
      tenant_id,feature_key,actor_user_id,action,before_data,after_data,reason
    )
    values(
      p_tenant_id,p_feature_key,p_actor_user_id,'reset',
      v_before,null,nullif(btrim(p_reason),'')
    );
  end if;

  return true;
end;
$function$;

revoke all on function public.powerhub_admin_set_tenant_feature_control(bigint,bigint,text,text,text,integer,text) from public,anon,authenticated;
revoke all on function public.powerhub_admin_reset_tenant_feature_control(bigint,bigint,text,text) from public,anon,authenticated;
grant execute on function public.powerhub_admin_set_tenant_feature_control(bigint,bigint,text,text,text,integer,text) to service_role;
grant execute on function public.powerhub_admin_reset_tenant_feature_control(bigint,bigint,text,text) to service_role;
