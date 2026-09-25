-- Enforce the UI separation at database level as well.
create or replace function public.powerhub_guard_tenant_feature_control_scope()
returns trigger
language plpgsql
security definer
set search_path=public,pg_temp
as $$
begin
  if not exists(
    select 1 from public.feature_catalog
    where feature_key=new.feature_key
      and feature_type in ('quota','addon','hybrid')
  ) then
    raise exception 'FEATURE_NOT_TENANT_CONTROLLABLE' using errcode='P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_powerhub_tenant_feature_control_scope on public.tenant_feature_controls;
create trigger trg_powerhub_tenant_feature_control_scope
before insert or update on public.tenant_feature_controls
for each row execute function public.powerhub_guard_tenant_feature_control_scope();

revoke all on function public.powerhub_guard_tenant_feature_control_scope() from public,anon,authenticated;
grant execute on function public.powerhub_guard_tenant_feature_control_scope() to service_role;

-- Reset is also restricted to tenant-controllable features.
create or replace function public.powerhub_admin_reset_tenant_feature_control(
  p_actor_user_id bigint,
  p_tenant_id bigint,
  p_feature_key text,
  p_reason text default null
)
returns boolean
language plpgsql security definer set search_path to 'public','pg_temp'
as $$
declare v_before jsonb;
begin
  if not exists(select 1 from public.users where id=p_actor_user_id and role='admin' and platform_role in ('platform_owner','platform_admin') and account_status='active') then
    raise exception 'PLATFORM_ADMIN_FORBIDDEN' using errcode='P0001';
  end if;
  if not exists(select 1 from public.feature_catalog where feature_key=p_feature_key) then
    raise exception 'FEATURE_NOT_FOUND' using errcode='P0001';
  end if;
  if not exists(select 1 from public.feature_catalog where feature_key=p_feature_key and feature_type in ('quota','addon','hybrid')) then
    raise exception 'FEATURE_NOT_TENANT_CONTROLLABLE' using errcode='P0001';
  end if;
  select to_jsonb(c)-'id' into v_before from public.tenant_feature_controls c where c.tenant_id=p_tenant_id and c.feature_key=p_feature_key;
  delete from public.tenant_feature_controls where tenant_id=p_tenant_id and feature_key=p_feature_key;
  if p_feature_key in ('subscriber_portal_logo','payment_documentation') then
    delete from public.tenant_feature_entitlements where tenant_id=p_tenant_id and feature_key=p_feature_key;
  end if;
  if v_before is not null then
    insert into public.tenant_feature_control_audit(tenant_id,feature_key,actor_user_id,action,before_data,after_data,reason)
    values(p_tenant_id,p_feature_key,p_actor_user_id,'reset',v_before,null,nullif(btrim(p_reason),''));
  end if;
  return true;
end;
$$;

revoke all on function public.powerhub_admin_reset_tenant_feature_control(bigint,bigint,text,text) from public,anon,authenticated;
grant execute on function public.powerhub_admin_reset_tenant_feature_control(bigint,bigint,text,text) to service_role;
