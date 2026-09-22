-- Route branch creation through the unified feature policy.
-- Existing RPC signature and branch validation remain unchanged.
create or replace function public.powerhub_create_site(p_tenant_id bigint,p_user_id bigint,p_name text,p_code text,p_city text default null,p_address text default null)
returns table (site_id bigint) language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_plan text; v_setting public.platform_settings%rowtype; v_tenant_setting public.tenant_branch_settings%rowtype; v_limit int; v_count int; v_enabled boolean; v_site_id bigint; v_role text; v_feature_policy record;
begin
  if p_name is null or char_length(btrim(p_name)) < 2 or p_code is null or char_length(btrim(p_code)) < 2 then raise exception 'INVALID_SITE_INPUT' using errcode='P0001'; end if;
  perform pg_advisory_xact_lock(p_tenant_id,hashtext('branch-policy'));
  select package_code into v_plan from public.tenant_subscriptions where tenant_id=p_tenant_id limit 1; if v_plan is null then raise exception 'TENANT_PACKAGE_NOT_FOUND' using errcode='P0002'; end if;
  select * into v_setting from public.platform_settings where setting_key='branch_feature' limit 1;
  select * into v_tenant_setting from public.tenant_branch_settings where tenant_id=p_tenant_id limit 1;
  select * into v_feature_policy
  from public.powerhub_resolve_tenant_feature_policy(p_tenant_id, 'branch_management');

  if not coalesce(v_feature_policy.eligible, false)
     or not coalesce(v_feature_policy.enabled, false) then
    raise exception 'BRANCH_FEATURE_DISABLED' using errcode='P0001';
  end if;
  select count(*)::int into v_count from public.sites where tenant_id=p_tenant_id and status<>'archived';
  if v_feature_policy.effective_limit is not null and v_count>=v_feature_policy.effective_limit then raise exception 'BRANCH_LIMIT_REACHED' using errcode='P0001'; end if;
  insert into public.sites(tenant_id,name,code,city,address) values(p_tenant_id,btrim(p_name),btrim(p_code),nullif(btrim(p_city),''),nullif(btrim(p_address),'')) returning id into v_site_id;
  insert into public.site_portal_settings(tenant_id,site_id,portal_code,display_name) values(p_tenant_id,v_site_id,lower(btrim(p_code)),btrim(p_name));
  select platform_role into v_role from public.users where id=p_user_id;
  insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data) values(p_tenant_id,v_site_id,p_user_id,v_role,'site',v_site_id::text,'create',jsonb_build_object('name',p_name,'code',p_code,'city',p_city,'address',p_address));
  return query select v_site_id;
end; $$;



revoke all on function public.powerhub_create_site(bigint,bigint,text,text,text,text)
  from public, anon, authenticated;
grant execute on function public.powerhub_create_site(bigint,bigint,text,text,text,text)
  to service_role;
