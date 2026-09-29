create or replace function public.powerhub_save_site_portal_settings(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_portal_code text,
  p_display_name text,
  p_primary_color text,
  p_accent_color text,
  p_is_enabled boolean
)
returns table (portal_code text)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_portal_code text := lower(btrim(p_portal_code));
  v_before jsonb;
  v_role text;
begin
  if p_tenant_id is null or p_site_id is null or p_user_id is null
    or p_display_name is null or char_length(btrim(p_display_name)) < 2
    or v_portal_code !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
    or p_primary_color !~ '^#[0-9A-Fa-f]{6}$'
    or p_accent_color !~ '^#[0-9A-Fa-f]{6}$' then
    raise exception 'INVALID_PORTAL_SETTINGS' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtext('site-portal-settings:' || p_tenant_id::text || ':' || v_portal_code)::bigint);

  perform 1 from public.sites as site_row
  where site_row.id = p_site_id and site_row.tenant_id = p_tenant_id
  for update;
  if not found then raise exception 'SITE_OUT_OF_SCOPE' using errcode = 'P0001'; end if;

  if exists (
    select 1 from public.site_portal_settings as portal_row
    where portal_row.portal_code = v_portal_code and portal_row.site_id <> p_site_id
  ) then
    raise exception 'PORTAL_CODE_CONFLICT' using errcode = 'P0001';
  end if;

  select to_jsonb(settings) into v_before
  from public.site_portal_settings as settings
  where settings.site_id = p_site_id and settings.tenant_id = p_tenant_id
  for update;

  insert into public.site_portal_settings(tenant_id, site_id, portal_code, display_name, primary_color, accent_color, is_enabled)
  values (p_tenant_id, p_site_id, v_portal_code, btrim(p_display_name), upper(p_primary_color), upper(p_accent_color), p_is_enabled)
  on conflict (site_id) do update set
    portal_code = excluded.portal_code,
    display_name = excluded.display_name,
    primary_color = excluded.primary_color,
    accent_color = excluded.accent_color,
    is_enabled = excluded.is_enabled,
    updated_at = now();

  select u.platform_role into v_role from public.users as u where u.id = p_user_id;
  insert into public.audit_logs(tenant_id, site_id, user_id, actor_platform_role, entity_type, entity_id, action, before_data, after_data)
  values (p_tenant_id, p_site_id, p_user_id, v_role, 'site_portal_settings', p_site_id::text, 'update', v_before,
    jsonb_build_object('portalCode', v_portal_code, 'displayName', btrim(p_display_name), 'primaryColor', upper(p_primary_color), 'accentColor', upper(p_accent_color), 'isEnabled', p_is_enabled));

  return query select v_portal_code;
end;
$$;

revoke execute on function public.powerhub_save_site_portal_settings(bigint, bigint, bigint, text, text, text, text, boolean) from public, anon, authenticated;
grant execute on function public.powerhub_save_site_portal_settings(bigint, bigint, bigint, text, text, text, text, boolean) to service_role;
