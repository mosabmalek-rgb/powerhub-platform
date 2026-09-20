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
