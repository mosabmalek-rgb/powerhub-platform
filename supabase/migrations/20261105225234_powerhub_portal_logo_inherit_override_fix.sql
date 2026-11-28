
create or replace function public.powerhub_subscriber_portal_logo_access(p_tenant_id bigint)
returns table(allowed boolean, policy text, package_code text, entitlement_enabled boolean)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_global_enabled boolean := false;
  v_package_code text;
  v_package jsonb;
  v_policy text := 'not_included';
  v_entitlement boolean;
  v_control_status text;
  v_allowed boolean := false;
begin
  select coalesce(fc.is_active, false)
    into v_global_enabled
  from public.feature_catalog fc
  where fc.feature_key = 'subscriber_portal_logo'
  limit 1;

  select ts.package_code
    into v_package_code
  from public.tenant_subscriptions ts
  where ts.tenant_id = p_tenant_id
    and ts.status in ('trial', 'active')
    and (ts.ends_at is null or ts.ends_at > now())
  order by ts.created_at desc
  limit 1;

  if v_package_code is not null then
    select package_row
      into v_package
    from jsonb_array_elements(coalesce(
      (select ps.value->'packages'
       from public.platform_settings ps
       where ps.setting_key = 'subscription_package_catalog'
         and ps.is_enabled = true
       limit 1),
      '[]'::jsonb
    )) as package_row
    where package_row->>'code' = v_package_code
      and coalesce((package_row->>'active')::boolean, true) = true
    limit 1;

    if v_package is not null then
      v_policy := case
        when v_package ? 'logoPolicy' then coalesce(v_package->>'logoPolicy', 'not_included')
        when coalesce((v_package->'features'->'logo'->>'included')::boolean, false) then 'included'
        when coalesce((v_package->'features'->'logo'->>'enabled')::boolean, false) then 'addon'
        else 'not_included'
      end;
    end if;
  end if;

  select c.status
    into v_control_status
  from public.tenant_feature_controls c
  where c.tenant_id = p_tenant_id
    and c.feature_key = 'subscriber_portal_logo'
  limit 1;

  if v_control_status = 'enabled' then
    v_entitlement := true;
  elsif v_control_status = 'disabled' then
    v_entitlement := false;
  else
    select e.is_enabled
      into v_entitlement
    from public.tenant_feature_entitlements e
    where e.tenant_id = p_tenant_id
      and e.feature_key = 'subscriber_portal_logo'
    limit 1;
  end if;

  v_allowed := v_global_enabled
    and v_policy in ('included', 'addon')
    and case
      when v_policy = 'included' then coalesce(v_entitlement, true)
      when v_policy = 'addon' then coalesce(v_entitlement, false)
      else false
    end;

  return query select v_allowed, v_policy, v_package_code, coalesce(v_entitlement, false);
end;
$function$;

alter function public.powerhub_subscriber_portal_logo_access(bigint) owner to postgres;

revoke all on function public.powerhub_subscriber_portal_logo_access(bigint) from public, anon, authenticated;
grant execute on function public.powerhub_subscriber_portal_logo_access(bigint) to service_role;

comment on function public.powerhub_subscriber_portal_logo_access(bigint) is
  'Resolves subscriber portal branding entitlement; an inherit control falls back to legacy entitlement or package default. Server role only.';
