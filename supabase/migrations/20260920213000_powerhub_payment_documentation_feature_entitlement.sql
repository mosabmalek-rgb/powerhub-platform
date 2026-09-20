-- Payment documentation feature entitlement:
-- platform global switch + package policy + per-tenant override.

insert into public.platform_settings(setting_key,is_enabled,value,message,updated_at)
values (
  'payment_documentation', true,
  jsonb_build_object('feature','payment_documentation','defaultPolicy','addon'),
  'إتاحة توثيق الدفع الإلكتروني لأصحاب المولدات بحسب سياسة الباقة وتفعيل الحساب.',
  now()
)
on conflict (setting_key) do nothing;

update public.platform_settings ps
set value = jsonb_set(
  ps.value, '{packages}',
  coalesce((
    select jsonb_agg(
      case when package_row ? 'paymentDocumentationPolicy' then package_row
      else package_row || jsonb_build_object(
        'paymentDocumentationPolicy','addon',
        'paymentDocumentationAddonPrice',0
      ) end
    )
    from jsonb_array_elements(coalesce(ps.value->'packages','[]'::jsonb)) package_row
  ), '[]'::jsonb), true),
  updated_at=now()
where ps.setting_key='subscription_package_catalog'
  and jsonb_typeof(ps.value->'packages')='array';

create or replace function public.powerhub_payment_documentation_access(p_tenant_id bigint)
returns table(allowed boolean, policy text, package_code text, entitlement_enabled boolean)
language plpgsql stable security definer set search_path to 'public','pg_temp'
as $function$
declare
  v_global_enabled boolean:=false; v_package_code text; v_package jsonb;
  v_policy text:='not_included'; v_entitlement boolean; v_allowed boolean:=false;
begin
  select coalesce(ps.is_enabled,false) into v_global_enabled from public.platform_settings ps where ps.setting_key='payment_documentation' limit 1;
  select ts.package_code into v_package_code from public.tenant_subscriptions ts
    where ts.tenant_id=p_tenant_id and ts.status in ('trial','active')
      and (ts.ends_at is null or ts.ends_at>now())
    order by ts.created_at desc limit 1;
  if v_package_code is not null then
    select package_row into v_package
    from jsonb_array_elements(coalesce((select ps.value->'packages' from public.platform_settings ps where ps.setting_key='subscription_package_catalog' and ps.is_enabled=true limit 1),'[]'::jsonb)) package_row
    where package_row->>'code'=v_package_code and coalesce((package_row->>'active')::boolean,true)=true limit 1;
    if v_package is not null then
      v_policy:=case
        when v_package ? 'paymentDocumentationPolicy' then coalesce(v_package->>'paymentDocumentationPolicy','not_included')
        when coalesce((v_package->'features'->'paymentDocumentation'->>'included')::boolean,false) then 'included'
        when coalesce((v_package->'features'->'paymentDocumentation'->>'enabled')::boolean,false) then 'addon'
        else 'not_included' end;
    end if;
  end if;
  select e.is_enabled into v_entitlement from public.tenant_feature_entitlements e
    where e.tenant_id=p_tenant_id and e.feature_key='payment_documentation' limit 1;
  v_allowed:=v_global_enabled and v_policy in ('included','addon') and case
    when v_policy='included' then coalesce(v_entitlement,true)
    when v_policy='addon' then coalesce(v_entitlement,false)
    else false end;
  return query select v_allowed,v_policy,v_package_code,coalesce(v_entitlement,false);
end;
$function$;

revoke all on function public.powerhub_payment_documentation_access(bigint) from public;
grant execute on function public.powerhub_payment_documentation_access(bigint) to service_role;

alter function public.powerhub_admin_set_tenant_feature_entitlement(bigint,bigint,text,boolean) security definer;


create or replace function public.powerhub_owner_set_payment_documentation(
  p_user_id bigint,p_site_id bigint,p_is_enabled boolean
) returns table(success boolean,tenant_id bigint,feature_key text,is_enabled boolean,policy text)
language plpgsql security definer set search_path to 'public','pg_temp'
as $function$
declare v_tenant_id bigint; v_access record; v_global_enabled boolean:=false; v_now timestamptz:=now();
begin
  select s.tenant_id into v_tenant_id
  from public.sites s
  join public.tenant_members tm on tm.tenant_id=s.tenant_id and tm.user_id=p_user_id
    and tm.role='owner' and tm.is_active=true and tm.membership_status='active'
  join public.tenants t on t.id=s.tenant_id
  where s.id=p_site_id and s.status='active' and t.status='active' limit 1;
  if v_tenant_id is null then raise exception 'OWNER_SITE_FORBIDDEN' using errcode='P0001'; end if;
  select coalesce(is_enabled,false) into v_global_enabled from public.platform_settings
    where setting_key='payment_documentation' limit 1;
  select * into v_access from public.powerhub_payment_documentation_access(v_tenant_id);
  if p_is_enabled and not v_global_enabled then raise exception 'FEATURE_GLOBALLY_DISABLED' using errcode='P0001'; end if;
  if p_is_enabled and coalesce(v_access.policy,'not_included')='not_included' then raise exception 'FEATURE_NOT_AVAILABLE' using errcode='P0001'; end if;
  insert into public.tenant_feature_entitlements(tenant_id,feature_key,is_enabled,activated_by_user_id,activated_at,created_at,updated_at)
  values(v_tenant_id,'payment_documentation',p_is_enabled,p_user_id,case when p_is_enabled then v_now else null end,v_now,v_now)
  on conflict(tenant_id,feature_key) do update set is_enabled=excluded.is_enabled,
    activated_by_user_id=excluded.activated_by_user_id,activated_at=excluded.activated_at,updated_at=v_now;
  insert into public.audit_logs(tenant_id,site_id,user_id,entity_type,entity_id,action,after_data)
  values(v_tenant_id,p_site_id,p_user_id,'tenant_feature_entitlement','payment_documentation',
    case when p_is_enabled then 'enable' else 'disable' end,
    jsonb_build_object('featureKey','payment_documentation','policy',v_access.policy,'isEnabled',p_is_enabled));
  return query select true,v_tenant_id,'payment_documentation',p_is_enabled,coalesce(v_access.policy,'not_included');
end;
$function$;

revoke all on function public.powerhub_owner_set_payment_documentation(bigint,bigint,boolean) from public;
grant execute on function public.powerhub_owner_set_payment_documentation(bigint,bigint,boolean) to service_role;
