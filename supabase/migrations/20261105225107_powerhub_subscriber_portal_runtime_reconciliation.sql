
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
  v_control_found boolean := false;
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

  select true, c.status = 'enabled'
    into v_control_found, v_entitlement
  from public.tenant_feature_controls c
  where c.tenant_id = p_tenant_id
    and c.feature_key = 'subscriber_portal_logo'
  limit 1;

  if not v_control_found then
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

create or replace function public.powerhub_subscriber_portal_list()
returns table(
  portal_code text,
  display_name text,
  primary_color text,
  accent_color text,
  site_name text,
  city text,
  logo_key text
)
language sql
stable
security definer
set search_path = ''
as $function$
  select
    s.portal_code,
    case when access.allowed then coalesce(s.display_name, site.name)
      else 'صفحة استعلامات المشتركين' end,
    s.primary_color,
    s.accent_color,
    case when access.allowed then site.name
      else 'صفحة استعلامات المشتركين' end,
    case when access.allowed then site.city else null end,
    case when access.allowed then s.logo_key else null end
  from public.site_portal_settings s
  join public.sites site on site.id = s.site_id
  cross join lateral public.powerhub_subscriber_portal_logo_access(s.tenant_id) access
  where s.is_enabled = true
    and site.status = 'active'
  order by site.name asc;
$function$;

create or replace function public.powerhub_subscriber_portal_theme(p_portal_code text)
returns table(
  portal_code text,
  display_name text,
  primary_color text,
  accent_color text,
  site_name text,
  city text,
  logo_key text
)
language sql
stable
security definer
set search_path = ''
as $function$
  select
    s.portal_code,
    case when access.allowed then coalesce(s.display_name, site.name)
      else 'صفحة استعلامات المشتركين' end,
    s.primary_color,
    s.accent_color,
    case when access.allowed then site.name
      else 'صفحة استعلامات المشتركين' end,
    case when access.allowed then site.city else null end,
    case when access.allowed then s.logo_key else null end
  from public.site_portal_settings s
  join public.sites site on site.id = s.site_id
  cross join lateral public.powerhub_subscriber_portal_logo_access(s.tenant_id) access
  where s.portal_code = lower(btrim(p_portal_code))
    and s.is_enabled = true
    and site.status = 'active'
  limit 1;
$function$;

alter function public.powerhub_subscriber_portal_logo_access(bigint) owner to postgres;
alter function public.powerhub_subscriber_portal_list() owner to postgres;
alter function public.powerhub_subscriber_portal_theme(text) owner to postgres;

revoke all on function public.powerhub_subscriber_portal_logo_access(bigint) from public, anon, authenticated;
revoke all on function public.powerhub_subscriber_portal_list() from public, anon, authenticated;
revoke all on function public.powerhub_subscriber_portal_theme(text) from public, anon, authenticated;

grant execute on function public.powerhub_subscriber_portal_logo_access(bigint) to service_role;
grant execute on function public.powerhub_subscriber_portal_list() to service_role;
grant execute on function public.powerhub_subscriber_portal_theme(text) to service_role;

comment on function public.powerhub_subscriber_portal_logo_access(bigint) is
  'Resolves subscriber portal branding entitlement; callable only by the trusted server role.';
comment on function public.powerhub_subscriber_portal_list() is
  'Returns active subscriber portal presentation data with branding metadata gated by tenant entitlement; server only.';
comment on function public.powerhub_subscriber_portal_theme(text) is
  'Returns one active subscriber portal theme with branding metadata gated by tenant entitlement; server only.';

notify pgrst, 'reload schema';
