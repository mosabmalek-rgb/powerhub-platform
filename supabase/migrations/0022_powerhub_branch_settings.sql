create or replace function public.powerhub_create_site(p_tenant_id bigint,p_user_id bigint,p_name text,p_code text,p_city text default null,p_address text default null)
returns table (site_id bigint) language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_plan text; v_setting public.platform_settings%rowtype; v_tenant_setting public.tenant_branch_settings%rowtype; v_limit int; v_count int; v_enabled boolean; v_site_id bigint; v_role text;
begin
  if p_name is null or char_length(btrim(p_name)) < 2 or p_code is null or char_length(btrim(p_code)) < 2 then raise exception 'INVALID_SITE_INPUT' using errcode='P0001'; end if;
  perform pg_advisory_xact_lock(p_tenant_id,hashtext('branch-policy'));
  select plan into v_plan from public.tenant_subscriptions where tenant_id=p_tenant_id limit 1; v_plan:=coalesce(v_plan,'starter');
  select * into v_setting from public.platform_settings where setting_key='branch_feature' limit 1;
  select * into v_tenant_setting from public.tenant_branch_settings where tenant_id=p_tenant_id limit 1;
  v_limit:=coalesce((v_setting.value->'defaultLimit'->>v_plan)::int,case v_plan when 'enterprise' then 10 when 'professional' then 3 else 1 end);
  if v_tenant_setting.max_branches_override is not null and v_tenant_setting.max_branches_override >= 1 then v_limit:=v_tenant_setting.max_branches_override; end if;
  v_enabled:=coalesce(v_tenant_setting.is_enabled_override,coalesce(v_setting.is_enabled,false) and v_limit>1);
  if not v_enabled then raise exception 'BRANCH_FEATURE_DISABLED' using errcode='P0001'; end if;
  select count(*)::int into v_count from public.sites where tenant_id=p_tenant_id and status<>'archived';
  if v_count>=v_limit then raise exception 'BRANCH_LIMIT_REACHED' using errcode='P0001'; end if;
  insert into public.sites(tenant_id,name,code,city,address) values(p_tenant_id,btrim(p_name),btrim(p_code),nullif(btrim(p_city),''),nullif(btrim(p_address),'')) returning id into v_site_id;
  insert into public.site_portal_settings(tenant_id,site_id,portal_code,display_name) values(p_tenant_id,v_site_id,lower(btrim(p_code)),btrim(p_name));
  select platform_role into v_role from public.users where id=p_user_id;
  insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data) values(p_tenant_id,v_site_id,p_user_id,v_role,'site',v_site_id::text,'create',jsonb_build_object('name',p_name,'code',p_code,'city',p_city,'address',p_address));
  return query select v_site_id;
end; $$;

create or replace function public.powerhub_update_site_anomaly(p_tenant_id bigint,p_site_id bigint,p_user_id bigint,p_anomaly_alert_percent int)
returns table (site_id bigint) language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_old int; v_role text;
begin
  if p_anomaly_alert_percent<10 or p_anomaly_alert_percent>500 then raise exception 'INVALID_ANOMALY_THRESHOLD' using errcode='P0001'; end if;
  select anomaly_alert_percent into v_old from public.sites where id=p_site_id and tenant_id=p_tenant_id for update; if not found then raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001'; end if;
  update public.sites set anomaly_alert_percent=p_anomaly_alert_percent,updated_at=now() where id=p_site_id;
  select platform_role into v_role from public.users where id=p_user_id; insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,before_data,after_data) values(p_tenant_id,p_site_id,p_user_id,v_role,'site',p_site_id::text,'update_anomaly_alert',jsonb_build_object('anomalyAlertPercent',v_old),jsonb_build_object('anomalyAlertPercent',p_anomaly_alert_percent));
  return query select p_site_id;
end; $$;

create or replace function public.powerhub_update_site(p_tenant_id bigint,p_site_id bigint,p_user_id bigint,p_name text,p_city text,p_address text,p_status text,p_invoice_due_days int)
returns table (site_id bigint) language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_before jsonb; v_role text;
begin
  if p_status not in ('active','inactive','archived') or p_invoice_due_days<1 or p_invoice_due_days>90 then raise exception 'INVALID_SITE_SETTINGS' using errcode='P0001'; end if;
  select to_jsonb(s) into v_before from public.sites s where id=p_site_id and tenant_id=p_tenant_id for update; if not found then raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001'; end if;
  update public.sites set name=btrim(p_name),city=nullif(btrim(p_city),''),address=nullif(btrim(p_address),''),status=p_status,invoice_due_days=p_invoice_due_days,updated_at=now() where id=p_site_id;
  select platform_role into v_role from public.users where id=p_user_id; insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,before_data,after_data) values(p_tenant_id,p_site_id,p_user_id,v_role,'branch',p_site_id::text,'update',v_before,jsonb_build_object('name',p_name,'city',p_city,'address',p_address,'status',p_status,'invoiceDueDays',p_invoice_due_days));
  return query select p_site_id;
end; $$;
revoke execute on function public.powerhub_create_site(bigint,bigint,text,text,text,text),public.powerhub_update_site_anomaly(bigint,bigint,bigint,int),public.powerhub_update_site(bigint,bigint,bigint,text,text,text,text,int) from public,anon,authenticated;
grant execute on function public.powerhub_create_site(bigint,bigint,text,text,text,text),public.powerhub_update_site_anomaly(bigint,bigint,bigint,int),public.powerhub_update_site(bigint,bigint,bigint,text,text,text,text,int) to service_role;
