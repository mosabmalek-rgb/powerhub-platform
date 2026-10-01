-- Dynamic subscription package catalog: new admin-defined packages inherit the same
-- runtime eligibility, quota-policy bridge, creation and upgrade lifecycle.
create or replace function public.powerhub_catalog_package(p_code text)
returns jsonb
language sql
stable
security definer
set search_path=public,pg_temp
as $$
  select p
  from public.platform_settings ps
  cross join lateral jsonb_array_elements(coalesce(ps.value->'packages','[]'::jsonb)) p
  where ps.setting_key='subscription_package_catalog'
    and ps.is_enabled=true
    and p->>'code'=lower(trim(p_code))
    and coalesce((p->>'active')::boolean,true)=true
  limit 1;
$$;

create or replace function public.powerhub_validate_package_code(p_code text)
returns boolean
language plpgsql
stable
security definer
set search_path=public,pg_temp
as $$
begin
  if nullif(trim(p_code),'') is null then
    raise exception 'INVALID_PACKAGE_CODE' using errcode='22023';
  end if;
  if public.powerhub_catalog_package(p_code) is null then
    raise exception 'INVALID_PACKAGE_CODE' using errcode='22023';
  end if;
  return true;
end;
$$;

create or replace function public.powerhub_validate_tenant_package()
returns trigger
language plpgsql
security definer
set search_path=public,pg_temp
as $$
begin
  perform public.powerhub_validate_package_code(new.package_code);
  new.package_code:=lower(trim(new.package_code));
  return new;
end;
$$;

drop trigger if exists trg_powerhub_validate_tenant_package on public.tenants;
create trigger trg_powerhub_validate_tenant_package
before insert or update of package_code on public.tenants
for each row execute function public.powerhub_validate_tenant_package();

drop trigger if exists trg_powerhub_validate_subscription_package on public.tenant_subscriptions;
create trigger trg_powerhub_validate_subscription_package
before insert or update of package_code on public.tenant_subscriptions
for each row execute function public.powerhub_validate_tenant_package();

create or replace function public.powerhub_sync_catalog_feature_policies()
returns trigger
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  p jsonb;
  code text;
begin
  if new.setting_key <> 'subscription_package_catalog' or new.is_enabled=false then
    return new;
  end if;
  for p in select * from jsonb_array_elements(coalesce(new.value->'packages','[]'::jsonb))
  loop
    code:=lower(trim(p->>'code'));
    if code is null or code='' then continue; end if;
    insert into public.package_feature_policies(package_code,feature_key,policy,default_limit,limit_mode,source)
    values
      (code,'subscriber_management','included',nullif(p->'features'->'subscribers'->>'limit','')::integer,'fixed','catalog'),
      (code,'branch_management','included',nullif(p->'features'->'branches'->>'limit','')::integer,'fixed','catalog'),
      (code,'sms','included',coalesce(nullif(p->'features'->'sms'->>'limit','')::integer,nullif(p->>'includedMessages','')::integer),'fixed','catalog'),
      (code,'field_users','included',nullif(p->>'fieldUsers','')::integer,'fixed','catalog'),
      (code,'platform_users','included',nullif(p->>'platformUsers','')::integer,'fixed','catalog'),
      (code,'subscriber_portal','included',null,'unlimited','catalog'),
      (code,'subscriber_portal_logo',case coalesce(p->>'logoPolicy','not_included') when 'included' then 'included' when 'addon' then 'addon' else 'not_included' end,null,'unlimited','catalog'),
      (code,'payment_documentation',case coalesce(p->>'paymentDocumentationPolicy','not_included') when 'included' then 'included' when 'addon' then 'addon' else 'not_included' end,null,'unlimited','catalog'),
      (code,'reports','included',null,'unlimited','catalog'),
      (code,'company_accounts','included',null,'unlimited','catalog'),
      (code,'human_resources','included',null,'unlimited','catalog'),
      (code,'attendance','included',null,'unlimited','catalog'),
      (code,'payroll','included',null,'unlimited','catalog'),
      (code,'financial_settlements','included',null,'unlimited','catalog'),
      (code,'mobile_sync','included',null,'unlimited','catalog')
    on conflict(package_code,feature_key) do update set
      policy=excluded.policy,default_limit=excluded.default_limit,limit_mode=excluded.limit_mode,source='catalog',updated_at=now();
  end loop;
  return new;
end;
$$;

drop trigger if exists trg_powerhub_sync_catalog_feature_policies on public.platform_settings;
create trigger trg_powerhub_sync_catalog_feature_policies
after insert or update of value,is_enabled on public.platform_settings
for each row execute function public.powerhub_sync_catalog_feature_policies();

create or replace function public.powerhub_request_subscription_upgrade(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_requested_plan text
)
returns table(request_id bigint, requested_plan text, already_requested boolean)
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  v_current_package text;
  v_limit integer;
  v_count integer;
  v_existing_id bigint;
  v_existing_plan text;
  v_role text;
  v_policy record;
  v_current_rank integer;
  v_requested_rank integer;
begin
  perform public.powerhub_validate_package_code(p_requested_plan);
  select ts.package_code into v_current_package
  from public.tenant_subscriptions ts
  where ts.tenant_id=p_tenant_id and ts.status in ('trial','active','overdue','suspended')
  order by ts.created_at desc limit 1 for share;
  if v_current_package is null then raise exception 'TENANT_PACKAGE_NOT_FOUND' using errcode='P0002'; end if;
  if lower(trim(p_requested_plan))=lower(trim(v_current_package)) then raise exception 'REQUESTED_PLAN_NOT_HIGHER' using errcode='P0001'; end if;

  select ord into v_current_rank
  from (
    select elem->>'code' code, row_number() over() ord
    from public.platform_settings ps
    cross join lateral jsonb_array_elements(coalesce(ps.value->'packages','[]'::jsonb)) elem
    where ps.setting_key='subscription_package_catalog' and ps.is_enabled=true and coalesce((elem->>'active')::boolean,true)=true
  ) ranked where code=lower(trim(v_current_package));
  select ord into v_requested_rank
  from (
    select elem->>'code' code, row_number() over() ord
    from public.platform_settings ps
    cross join lateral jsonb_array_elements(coalesce(ps.value->'packages','[]'::jsonb)) elem
    where ps.setting_key='subscription_package_catalog' and ps.is_enabled=true and coalesce((elem->>'active')::boolean,true)=true
  ) ranked where code=lower(trim(p_requested_plan));
  if v_requested_rank is null or v_current_rank is null or v_requested_rank<=v_current_rank then
    raise exception 'REQUESTED_PLAN_NOT_HIGHER' using errcode='P0001';
  end if;

  perform 1 from public.sites where id=p_site_id and tenant_id=p_tenant_id and status<>'archived' for share;
  if not found then raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001'; end if;

  select * into v_policy from public.powerhub_resolve_tenant_feature_policy(p_tenant_id,'subscriber_management');
  v_limit:=coalesce(v_policy.effective_limit,0);
  select count(*)::integer into v_count from public.subscribers where tenant_id=p_tenant_id;
  if v_count<v_limit then raise exception 'SUBSCRIBER_LIMIT_NOT_REACHED' using errcode='P0001'; end if;

  select id,requested_package_code into v_existing_id,v_existing_plan
  from public.subscription_upgrade_requests
  where tenant_id=p_tenant_id and status='pending'
  order by created_at desc limit 1 for share;
  if found then return query select v_existing_id,v_existing_plan,true; return; end if;

  insert into public.subscription_upgrade_requests(tenant_id,requested_by_user_id,current_package_code,requested_package_code,reason,status)
  values(p_tenant_id,p_user_id,v_current_package,lower(trim(p_requested_plan)),'subscriber_limit_reached','pending')
  returning id into v_existing_id;

  select platform_role into v_role from public.users where id=p_user_id;
  insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data)
  values(p_tenant_id,p_site_id,p_user_id,v_role,'subscription_upgrade_request',v_existing_id::text,'request_upgrade',
    jsonb_build_object('currentPackageCode',v_current_package,'requestedPackageCode',lower(trim(p_requested_plan)),'reason','subscriber_limit_reached','subscriberCount',v_count,'subscriberLimit',v_limit));
  return query select v_existing_id,lower(trim(p_requested_plan)),false;
end;
$$;

revoke all on function public.powerhub_catalog_package(text) from public,anon,authenticated;
revoke all on function public.powerhub_validate_package_code(text) from public,anon,authenticated;
revoke all on function public.powerhub_sync_catalog_feature_policies() from public,anon,authenticated;
revoke all on function public.powerhub_request_subscription_upgrade(bigint,bigint,bigint,text) from public,anon,authenticated;
grant execute on function public.powerhub_catalog_package(text) to service_role;
grant execute on function public.powerhub_validate_package_code(text) to service_role;
grant execute on function public.powerhub_sync_catalog_feature_policies() to service_role;
grant execute on function public.powerhub_request_subscription_upgrade(bigint,bigint,bigint,text) to service_role;
