create or replace function public.powerhub_update_report_branding(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_company_name text,
  p_report_logo_key text
)
returns table (company_name text, report_logo_key text)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_role text;
  v_before jsonb;
begin
  if p_company_name is null and p_report_logo_key is null then
    raise exception 'EMPTY_BRANDING_UPDATE' using errcode='P0001';
  end if;

  perform pg_advisory_xact_lock(
    hashtext('tenant-site:' || p_tenant_id::text || ':' || p_site_id::text)::bigint
  );

  perform 1
  from public.sites as site_row
  where site_row.id = p_site_id
    and site_row.tenant_id = p_tenant_id
    and site_row.status <> 'archived'
  for share;
  if not found then
    raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001';
  end if;

  select jsonb_build_object(
    'companyName', profile.company_name,
    'reportLogoKey', profile.report_logo_key
  )
  into v_before
  from public.tenant_owner_profiles as profile
  where profile.tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception 'OWNER_PROFILE_NOT_FOUND' using errcode='P0001';
  end if;

  update public.tenant_owner_profiles as profile
  set company_name = coalesce(p_company_name, profile.company_name),
      report_logo_key = coalesce(p_report_logo_key, profile.report_logo_key),
      updated_at = now()
  where profile.tenant_id = p_tenant_id
  returning profile.company_name, profile.report_logo_key
  into company_name, report_logo_key;

  select u.platform_role
  into v_role
  from public.users as u
  where u.id = p_user_id;

  insert into public.audit_logs(
    tenant_id, site_id, user_id, actor_platform_role,
    entity_type, entity_id, action, before_data, after_data
  )
  values (
    p_tenant_id, p_site_id, p_user_id, v_role,
    'tenant_owner_profile', p_tenant_id::text, 'update_report_branding',
    v_before,
    jsonb_build_object(
      'companyName', company_name,
      'reportLogoKey', report_logo_key
    )
  );

  return next;
end;
$$;

revoke execute on function public.powerhub_update_report_branding(bigint,bigint,bigint,text,text) from public, anon, authenticated;
grant execute on function public.powerhub_update_report_branding(bigint,bigint,bigint,text,text) to service_role;
