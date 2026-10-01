-- Dynamic package lifecycle bridge.
-- Extends the commercial package catalog without leaving legacy five-package constraints
-- in tenants, upgrade requests, owner creation, quick upgrade, renewal, or admin updates.
-- Catalog helpers: the catalog is the only source of truth for package existence/activation.
create or replace function public.powerhub_catalog_package(p_package_code text)
returns jsonb
language sql
stable
security definer
set search_path=public,pg_temp
as $powerhub$
  select pkg
  from public.platform_settings ps
  cross join lateral jsonb_array_elements(coalesce(ps.value->'packages','[]'::jsonb)) pkg
  where ps.setting_key='subscription_package_catalog'
    and ps.is_enabled=true
    and lower(trim(pkg->>'code'))=lower(trim(p_package_code))
    and coalesce((pkg->>'active')::boolean,true)=true
  limit 1
$powerhub$;

create or replace function public.powerhub_validate_package_code(p_package_code text)
returns boolean
language plpgsql
stable
security definer
set search_path=public,pg_temp
as $powerhub$
begin
  if nullif(trim(p_package_code),'') is null or public.powerhub_catalog_package(p_package_code) is null then
    raise exception 'INVALID_PACKAGE_CODE' using errcode='22023';
  end if;
  return true;
end;
$powerhub$;

revoke all on function public.powerhub_catalog_package(text) from public,anon,authenticated;
revoke all on function public.powerhub_validate_package_code(text) from public,anon,authenticated;
grant execute on function public.powerhub_catalog_package(text) to service_role;
grant execute on function public.powerhub_validate_package_code(text) to service_role;


alter table public.tenants
  drop constraint if exists tenants_package_code_check;

alter table public.subscription_upgrade_requests
  drop constraint if exists subscription_upgrade_requests_current_package_code_check;

alter table public.subscription_upgrade_requests
  drop constraint if exists subscription_upgrade_requests_requested_package_code_check;

create or replace function public.powerhub_admin_quick_upgrade_owner_plan(
  p_actor_user_id bigint,
  p_tenant_id bigint,
  p_package_code text,
  p_note text default null
)
returns table(success boolean, package_code text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_platform_role text;
  v_tenant public.tenants%rowtype;
  v_subscription public.tenant_subscriptions%rowtype;
  v_site_id bigint;
  v_current_rank integer;
  v_requested_rank integer;
begin
  select u.platform_role
  into v_actor_platform_role
  from public.users as u
  where u.id = p_actor_user_id
    and u.role = 'admin'
    and u.account_status = 'active'
    and u.platform_role in ('platform_owner', 'platform_admin');

  if v_actor_platform_role is null then
    raise exception 'FORBIDDEN_PLATFORM_ROLE' using errcode = '42501';
  end if;

  perform public.powerhub_validate_package_code(p_package_code);

  select t.*
  into v_tenant
  from public.tenants as t
  where t.id = p_tenant_id
  for update;

  if not found then
    raise exception 'TENANT_NOT_FOUND' using errcode = 'P0002';
  end if;

  select ts.*
  into v_subscription
  from public.tenant_subscriptions as ts
  where ts.tenant_id = p_tenant_id
  for update;

  if not found then
    raise exception 'SUBSCRIPTION_NOT_FOUND' using errcode = 'P0002';
  end if;

  select s.id
  into v_site_id
  from public.sites as s
  where s.tenant_id = p_tenant_id
  order by s.id
  limit 1;

  if v_site_id is null then
    raise exception 'SITE_NOT_FOUND' using errcode = 'P0002';
  end if;

  select ordinality into v_current_rank
  from public.platform_settings ps
  cross join lateral jsonb_array_elements(coalesce(ps.value->'packages','[]'::jsonb)) with ordinality pkg
  where ps.setting_key='subscription_package_catalog'
    and ps.is_enabled=true
    and lower(trim(pkg->>'code'))=lower(trim(v_subscription.package_code))
    and coalesce((pkg->>'active')::boolean,true)=true
  limit 1;

  select ordinality into v_requested_rank
  from public.platform_settings ps
  cross join lateral jsonb_array_elements(coalesce(ps.value->'packages','[]'::jsonb)) with ordinality pkg
  where ps.setting_key='subscription_package_catalog'
    and ps.is_enabled=true
    and lower(trim(pkg->>'code'))=lower(trim(p_package_code))
    and coalesce((pkg->>'active')::boolean,true)=true
  limit 1;

  if v_current_rank is null then
    raise exception 'INVALID_CURRENT_PACKAGE' using errcode = '22023';
  end if;

  if v_requested_rank <= v_current_rank then
    raise exception 'PLAN_NOT_UPGRADE' using errcode = '22023';
  end if;

  update public.tenants
  set package_code = p_package_code,
      updated_at = now()
  where id = p_tenant_id;

  update public.tenant_subscriptions
  set package_code = p_package_code,
      updated_at = now()
  where id = v_subscription.id;

  insert into public.audit_logs (
    tenant_id, site_id, user_id, actor_platform_role,
    entity_type, entity_id, action, after_data
  ) values (
    p_tenant_id, v_site_id, p_actor_user_id, v_actor_platform_role,
    'tenant_subscription', p_tenant_id::text,
    'platform_admin_quick_upgrade_owner_plan',
    jsonb_build_object(
      'fromPackageCode', v_subscription.package_code,
      'toPackageCode', p_package_code,
      'note', p_note
    )
  );

  return query select true, p_package_code;
end;
$$;

revoke all on function public.powerhub_admin_quick_upgrade_owner_plan(bigint, bigint, text, text) from public, anon, authenticated;
grant execute on function public.powerhub_admin_quick_upgrade_owner_plan(bigint, bigint, text, text) to service_role;


create or replace function public.powerhub_create_generator_owner_subscription(
  p_actor_user_id bigint,
  p_auth_user_id uuid,
  p_tenant_name text,
  p_slug text,
  p_company_name text,
  p_owner_name text,
  p_identity_ciphertext text,
  p_identity_iv text,
  p_identity_last4 text,
  p_owner_phone text,
  p_owner_whatsapp text,
  p_owner_email text,
  p_site_name text default 'الفرع الرئيسي',
  p_site_code text default null,
  p_package_code text default 'basic',
  p_billing_cycle text default 'monthly',
  p_subscription_status text default 'active',
  p_ends_at timestamptz default null,
  p_trial_duration_days integer default 8,
  p_subscription_duration integer default 1,
  p_trial_enabled boolean default false
)
returns table (tenant_id bigint, owner_user_id bigint, site_id bigint, subscription_id bigint)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_platform_role text;
  v_started_at timestamptz := now();
  v_trial_ends_at timestamptz;
  v_paid_start_at timestamptz;
  v_ends_at timestamptz;
  v_subscription_status text;
  v_tenant_id bigint;
  v_user_id bigint;
  v_site_id bigint;
  v_subscription_id bigint;
  v_site_name text := coalesce(nullif(trim(p_site_name), ''), 'الفرع الرئيسي');
  v_site_code text := coalesce(nullif(trim(p_site_code), ''), 'SITE-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)));
begin
  select platform_role into v_actor_platform_role
  from public.users
  where id = p_actor_user_id and role = 'admin' and account_status = 'active'
    and platform_role in ('platform_owner','platform_admin','finance_admin');
  if v_actor_platform_role is null then raise exception 'FORBIDDEN_PLATFORM_ROLE' using errcode='42501'; end if;

  if p_auth_user_id is null then raise exception 'AUTH_USER_REQUIRED' using errcode='22023'; end if;
  perform public.powerhub_validate_package_code(p_package_code);
  if p_billing_cycle not in ('monthly','yearly') then raise exception 'INVALID_BILLING_CYCLE' using errcode='22023'; end if;
  if p_subscription_duration is null or p_subscription_duration < 1 or p_subscription_duration > 60 then
    raise exception 'INVALID_SUBSCRIPTION_DURATION' using errcode='22023';
  end if;
  if p_trial_enabled and (p_trial_duration_days is null or p_trial_duration_days < 1 or p_trial_duration_days > 3650) then
    raise exception 'INVALID_TRIAL_DURATION' using errcode='22023';
  end if;
  if not p_trial_enabled then p_trial_duration_days := null; end if;

  if exists (select 1 from public.tenant_owner_profiles where phone = p_owner_phone) then
    raise exception 'OWNER_PHONE_ALREADY_EXISTS' using errcode='23505';
  end if;
  if exists (select 1 from public.tenant_owner_profiles where email = lower(p_owner_email)) then
    raise exception 'OWNER_EMAIL_ALREADY_EXISTS' using errcode='23505';
  end if;
  if exists (select 1 from public.tenants where slug = p_slug) then
    raise exception 'TENANT_SLUG_ALREADY_EXISTS' using errcode='23505';
  end if;

  v_subscription_status := case when p_trial_enabled then 'trial' else 'active' end;
  v_trial_ends_at := case when p_trial_enabled then v_started_at + make_interval(days => p_trial_duration_days) else null end;
  v_paid_start_at := coalesce(v_trial_ends_at, v_started_at);
  v_ends_at := coalesce(
    p_ends_at,
    v_paid_start_at + case
      when p_billing_cycle = 'yearly' then make_interval(years => p_subscription_duration)
      else make_interval(months => p_subscription_duration)
    end
  );

  if v_ends_at <= v_paid_start_at then
    raise exception 'INVALID_SUBSCRIPTION_END_DATE' using errcode='22023';
  end if;

  insert into public.users(auth_user_id,name,email,login_method,role,account_status,must_change_password,temporary_password_issued_at,last_signed_in)
  values(p_auth_user_id,p_owner_name,lower(p_owner_email),'supabase','user','active',true,v_started_at,v_started_at)
  on conflict(auth_user_id) do update set
    name=coalesce(excluded.name,public.users.name),email=excluded.email,login_method='supabase',
    role='user',account_status='active',must_change_password=true,
    temporary_password_issued_at=v_started_at,last_signed_in=v_started_at
  returning id into v_user_id;

  insert into public.tenants(name,slug,status,package_code)
  values(p_tenant_name,p_slug,'active',p_package_code)
  returning id into v_tenant_id;

  insert into public.tenant_owner_profiles(
    tenant_id,owner_user_id,full_name,phone,whatsapp_number,email,company_name,
    identity_number_ciphertext,identity_number_iv,identity_number_last4,invited_at,claimed_at
  ) values(
    v_tenant_id,v_user_id,p_owner_name,p_owner_phone,nullif(p_owner_whatsapp,''),lower(p_owner_email),
    nullif(p_company_name,''),p_identity_ciphertext,p_identity_iv,p_identity_last4,v_started_at,v_started_at
  );

  insert into public.sites(tenant_id,name,code,status)
  values(v_tenant_id,v_site_name,v_site_code,'active')
  returning id into v_site_id;

  insert into public.tenant_members(tenant_id,user_id,role,is_active,membership_status)
  values(v_tenant_id,v_user_id,'owner',true,'active');

  insert into public.staff_profiles(tenant_id,site_id,user_id,role,is_active)
  values(v_tenant_id,v_site_id,v_user_id,'owner',true);

  insert into public.tenant_subscriptions(
    tenant_id,package_code,status,billing_cycle,started_at,ends_at,auto_renew,renewal_count,
    notes,trial_enabled,trial_ends_at
  ) values(
    v_tenant_id,p_package_code,v_subscription_status,p_billing_cycle,v_started_at,v_ends_at,
    false,0,null,p_trial_enabled,v_trial_ends_at
  )
  returning id into v_subscription_id;

  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data,metadata
  ) values(
    v_tenant_id,v_site_id,p_actor_user_id,v_actor_platform_role,
    'tenant_subscription',v_subscription_id::text,
    'platform_admin_create_generator_owner_subscription',
    jsonb_build_object(
      'tenantId',v_tenant_id,'ownerUserId',v_user_id,'siteId',v_site_id,
      'packageCode',p_package_code,'status',v_subscription_status,
      'billingCycle',p_billing_cycle,'subscriptionDuration',p_subscription_duration,
      'trialEnabled',p_trial_enabled,'trialDurationDays',p_trial_duration_days,
      'trialEndsAt',v_trial_ends_at,'endsAt',v_ends_at
    ),
    jsonb_build_object('ownerEmail',lower(p_owner_email),'ownerPhoneLast4',right(p_owner_phone,4))
  );

  return query select v_tenant_id,v_user_id,v_site_id,v_subscription_id;
end;
$$;


CREATE OR REPLACE FUNCTION public.powerhub_admin_renew_subscription_with_addons(p_actor_user_id bigint, p_subscription_id bigint, p_new_ends_at timestamp with time zone, p_package_code text, p_addon_decisions jsonb, p_request_key uuid)
 RETURNS TABLE(success boolean, ends_at timestamp with time zone, package_code text, renewed_addons integer, expired_addons integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  s public.tenant_subscriptions%rowtype;
  a public.tenant_addon_requests%rowtype;
  d jsonb;
  v_existing public.subscription_renewal_operations%rowtype;
  v_fingerprint jsonb;
  v_tenant_status text;
  v_site_id bigint;
  v_actor_platform_role text;
  v_addon_id bigint;
  v_decision text;
  v_duration int;
  v_new_end timestamptz;
  v_renewed int := 0;
  v_expired int := 0;
begin
  if p_request_key is null then
    raise exception 'RENEWAL_REQUEST_KEY_REQUIRED' using errcode='P0001';
  end if;

  v_fingerprint := jsonb_build_object(
    'subscriptionId', p_subscription_id,
    'endsAt', p_new_ends_at,
    'packageCode', p_package_code,
    'addonDecisions', coalesce(p_addon_decisions,'[]'::jsonb)
  );

  select platform_role into v_actor_platform_role
  from public.users
  where id=p_actor_user_id
    and role='admin'
    and account_status='active'
    and platform_role in ('platform_owner','platform_admin');

  if v_actor_platform_role is null then
    raise exception 'FORBIDDEN_PLATFORM_ROLE' using errcode='42501';
  end if;

  if p_package_code is null or public.powerhub_catalog_package(p_package_code) is null then
    raise exception 'INVALID_RENEWAL_PACKAGE' using errcode='22023';
  end if;

  if not exists (
    select 1
    from jsonb_array_elements(
      coalesce((select value->'packages'
                from public.platform_settings
                where setting_key='subscription_package_catalog'
                  and is_enabled=true
                limit 1),'[]'::jsonb)
    ) package_row
    where lower(trim(package_row->>'code'))=lower(trim(p_package_code))
      and coalesce((package_row->>'active')::boolean,true)=true
  ) then
    raise exception 'RENEWAL_PACKAGE_NOT_ACTIVE' using errcode='P0001';
  end if;

  if jsonb_typeof(coalesce(p_addon_decisions,'[]'::jsonb)) <> 'array' then
    raise exception 'INVALID_ADDON_DECISIONS_PAYLOAD' using errcode='P0001';
  end if;

  select * into s from public.tenant_subscriptions
  where id=p_subscription_id for update;

  if not found then
    raise exception 'SUBSCRIPTION_NOT_FOUND' using errcode='P0001';
  end if;

  select * into v_existing
  from public.subscription_renewal_operations
  where request_key=p_request_key for update;

  if found then
    if v_existing.subscription_id<>p_subscription_id
       or v_existing.request_fingerprint<>v_fingerprint then
      raise exception 'RENEWAL_REQUEST_KEY_REUSED' using errcode='P0001';
    end if;
    return query select true,v_existing.ends_at,
      coalesce(v_existing.package_code,v_existing.request_fingerprint->>'packageCode'),
      v_existing.renewed_addons,v_existing.expired_addons;
    return;
  end if;

  select status into v_tenant_status from public.tenants where id=s.tenant_id;
  if v_tenant_status='archived' or s.status='archived' then
    raise exception 'ARCHIVED_SUBSCRIPTION_RENEWAL_FORBIDDEN' using errcode='42501';
  end if;

  if p_new_ends_at<=now() then
    raise exception 'INVALID_RENEWAL_END_DATE' using errcode='P0001';
  end if;

  select site_id into v_site_id
  from public.tenant_addon_requests
  where tenant_id=s.tenant_id and site_id is not null
  order by created_at desc limit 1;

  if v_site_id is null then
    select id into v_site_id from public.sites
    where tenant_id=s.tenant_id and status<>'archived'
    order by id limit 1;
  end if;

  if v_site_id is null then
    raise exception 'TENANT_SITE_REQUIRED_FOR_AUDIT' using errcode='P0001';
  end if;

  if exists (
    select 1
    from (
      select (x->>'addonRequestId')::bigint addon_request_id,count(*) decision_count
      from jsonb_array_elements(coalesce(p_addon_decisions,'[]'::jsonb)) x
      where jsonb_typeof(x)='object' and (x->>'addonRequestId') ~ '^[0-9]+$'
      group by (x->>'addonRequestId')::bigint having count(*)>1
    ) duplicates
  ) then
    raise exception 'DUPLICATE_ADDON_DECISION' using errcode='P0001';
  end if;

  for d in select * from jsonb_array_elements(coalesce(p_addon_decisions,'[]'::jsonb)) loop
    if jsonb_typeof(d)<>'object' or coalesce(d->>'addonRequestId','') !~ '^[0-9]+$' then
      raise exception 'INVALID_ADDON_REQUEST_ID' using errcode='P0001';
    end if;
    v_addon_id := (d->>'addonRequestId')::bigint;
    v_decision := d->>'decision';
    if v_decision is null or v_decision not in ('renew','expire') then
      raise exception 'INVALID_ADDON_DECISION' using errcode='P0001';
    end if;
    select * into a from public.tenant_addon_requests
    where id=v_addon_id and tenant_id=s.tenant_id for update;
    if not found then raise exception 'ADDON_NOT_FOUND_OR_TENANT_MISMATCH' using errcode='P0001'; end if;
    if a.status<>'approved' then raise exception 'ADDON_NOT_APPROVED' using errcode='P0001'; end if;
    if v_decision='renew' and a.ends_at is not null and a.ends_at<=now() then
      raise exception 'EXPIRED_ADDON_RENEWAL_FORBIDDEN' using errcode='P0001';
    end if;
    if v_decision='renew' then
      if d ? 'durationDays' and d->>'durationDays'<>'' then
        if (d->>'durationDays') !~ '^[0-9]+$' then raise exception 'INVALID_ADDON_DURATION' using errcode='P0001'; end if;
        v_duration := (d->>'durationDays')::int;
      else
        v_duration := coalesce(a.duration_days,30);
      end if;
      if v_duration<1 or v_duration>3650 then raise exception 'INVALID_ADDON_DURATION' using errcode='P0001'; end if;
    end if;
  end loop;

  update public.tenant_subscriptions
  set ends_at=p_new_ends_at,
      package_code=p_package_code,
      status='active',
      renewal_count=renewal_count+1,
      last_renewed_at=now(),
      updated_at=now()
  where id=s.id;

  for d in select * from jsonb_array_elements(coalesce(p_addon_decisions,'[]'::jsonb)) loop
    v_addon_id := (d->>'addonRequestId')::bigint;
    v_decision := d->>'decision';
    select * into a from public.tenant_addon_requests
    where id=v_addon_id and tenant_id=s.tenant_id for update;
    if v_decision='renew' then
      v_duration := case
        when d ? 'durationDays' and d->>'durationDays'<>'' then (d->>'durationDays')::int
        else coalesce(a.duration_days,30)
      end;
      v_new_end := p_new_ends_at + make_interval(days=>v_duration);
      update public.tenant_addon_requests set ends_at=v_new_end,duration_days=v_duration where id=a.id;
      insert into public.tenant_addon_renewal_decisions(
        tenant_id,subscription_id,addon_request_id,decision,new_duration_days,created_by_user_id
      ) values(s.tenant_id,s.id,a.id,'renew',v_duration,p_actor_user_id)
      on conflict(subscription_id,addon_request_id) do update set
        decision='renew',new_duration_days=excluded.new_duration_days,
        created_by_user_id=excluded.created_by_user_id,created_at=now();
      v_renewed := v_renewed+1;
    else
      update public.tenant_addon_requests
      set ends_at=least(coalesce(tenant_addon_requests.ends_at,now()),now())
      where tenant_addon_requests.id=a.id;
      insert into public.tenant_addon_renewal_decisions(
        tenant_id,subscription_id,addon_request_id,decision,created_by_user_id
      ) values(s.tenant_id,s.id,a.id,'expire',p_actor_user_id)
      on conflict(subscription_id,addon_request_id) do update set
        decision='expire',new_duration_days=null,
        created_by_user_id=excluded.created_by_user_id,created_at=now();
      v_expired := v_expired+1;
    end if;
  end loop;

  insert into public.subscription_renewal_operations(
    request_key,subscription_id,request_fingerprint,ends_at,package_code,
    renewed_addons,expired_addons,created_by_user_id
  ) values(
    p_request_key,s.id,v_fingerprint,p_new_ends_at,p_package_code,
    v_renewed,v_expired,p_actor_user_id
  );

  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,
    entity_type,entity_id,action,after_data
  ) values(
    s.tenant_id,v_site_id,p_actor_user_id,v_actor_platform_role,
    'tenant_subscription',s.id::text,'renew_subscription_with_addons',
    jsonb_build_object(
      'newEndsAt',p_new_ends_at,
      'packageCode',p_package_code,
      'renewedAddons',v_renewed,
      'expiredAddons',v_expired,
      'requestKey',p_request_key
    )
  );

  return query select true,p_new_ends_at,p_package_code,v_renewed,v_expired;
end;
$function$;


CREATE OR REPLACE FUNCTION public.powerhub_request_subscription_upgrade(p_tenant_id bigint, p_site_id bigint, p_user_id bigint, p_requested_package_code text)
 RETURNS TABLE(request_id bigint, requested_package_code text, already_requested boolean)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_current_package text;
  v_requested_package text;
  v_catalog jsonb;
  v_override jsonb;
  v_limit integer;
  v_count integer;
  v_existing_id bigint;
  v_existing_package text;
  v_role text;
  v_order int;
  v_current_order int;
begin
  v_requested_package := lower(nullif(btrim(p_requested_package_code),''));
  if public.powerhub_catalog_package(v_requested_package) is null then
    raise exception 'INVALID_REQUESTED_PACKAGE_CODE' using errcode='P0001';
  end if;

  perform pg_advisory_xact_lock(p_tenant_id,hashtext('subscription-upgrade'));

  perform 1
  from public.sites
  where id=p_site_id
    and tenant_id=p_tenant_id
    and status<>'archived'
  for share;

  if not found then
    raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001';
  end if;

  select lower(nullif(btrim(ts.package_code),''))
    into v_current_package
  from public.tenant_subscriptions ts
  where ts.tenant_id=p_tenant_id
  order by ts.created_at desc,ts.id desc
  limit 1
  for share;

  if v_current_package is null then
    raise exception 'TENANT_PACKAGE_NOT_FOUND' using errcode='P0001';
  end if;

  select ordinality into v_current_order
  from public.platform_settings ps
  cross join lateral jsonb_array_elements(coalesce(ps.value->'packages','[]'::jsonb)) with ordinality pkg
  where ps.setting_key='subscription_package_catalog'
    and ps.is_enabled=true
    and lower(trim(pkg->>'code'))=lower(trim(v_current_package))
    and coalesce((pkg->>'active')::boolean,true)=true
  limit 1;

  select ordinality into v_order
  from public.platform_settings ps
  cross join lateral jsonb_array_elements(coalesce(ps.value->'packages','[]'::jsonb)) with ordinality pkg
  where ps.setting_key='subscription_package_catalog'
    and ps.is_enabled=true
    and lower(trim(pkg->>'code'))=lower(trim(v_requested_package))
    and coalesce((pkg->>'active')::boolean,true)=true
  limit 1;

  if v_order <= v_current_order then
    raise exception 'REQUESTED_PACKAGE_NOT_HIGHER' using errcode='P0001';
  end if;

  select value
    into v_catalog
  from public.platform_settings
  where setting_key='subscription_package_catalog'
    and is_enabled=true;

  select coalesce(
    (pkg->'features'->'subscribers'->>'limit')::integer,
    (pkg->>'includedSubscribers')::integer,
    0
  )
    into v_limit
  from jsonb_array_elements(coalesce(v_catalog->'packages','[]'::jsonb)) pkg
  where lower(trim(pkg->>'code'))=lower(trim(v_current_package))
    and coalesce((pkg->>'active')::boolean,true)=true
  limit 1;

  if v_current_order is null or v_order is null then
    raise exception 'PACKAGE_ORDER_NOT_CONFIGURED' using errcode='P0001';
  end if;

  select value
    into v_override
  from public.platform_settings
  where setting_key='owner_limit_overrides';

  if jsonb_typeof(v_override->'overrides')='object'
     and jsonb_typeof(v_override->'overrides'->p_tenant_id::text)='object'
     and (v_override->'overrides'->p_tenant_id::text->>'subscriberLimit') ~ '^[0-9]+$'
  then
    v_limit := least(
      (v_override->'overrides'->p_tenant_id::text->>'subscriberLimit')::integer,
      100000
    );
  end if;

  if v_limit is null or v_limit<0 then
    raise exception 'SUBSCRIBER_QUOTA_NOT_CONFIGURED' using errcode='P0001';
  end if;

  select count(*)::integer
    into v_count
  from public.subscribers
  where tenant_id=p_tenant_id;

  if v_count < v_limit then
    raise exception 'SUBSCRIBER_LIMIT_NOT_REACHED' using errcode='P0001';
  end if;

  select id,requested_package_code
    into v_existing_id,v_existing_package
  from public.subscription_upgrade_requests
  where tenant_id=p_tenant_id
    and status in ('pending','reviewing')
  order by created_at desc
  limit 1
  for share;

  if found then
    return query
      select v_existing_id,v_existing_package,true;
    return;
  end if;

  insert into public.subscription_upgrade_requests(
    tenant_id,
    requested_by_user_id,
    current_package_code,
    requested_package_code,
    reason,
    status
  )
  values(
    p_tenant_id,
    p_user_id,
    v_current_package,
    v_requested_package,
    'subscriber_limit_reached',
    'pending'
  )
  returning id into v_existing_id;

  select platform_role
    into v_role
  from public.users
  where id=p_user_id;

  insert into public.audit_logs(
    tenant_id,
    site_id,
    user_id,
    actor_platform_role,
    entity_type,
    entity_id,
    action,
    after_data
  )
  values(
    p_tenant_id,
    p_site_id,
    p_user_id,
    v_role,
    'subscription_upgrade_request',
    v_existing_id::text,
    'request_upgrade',
    jsonb_build_object(
      'currentPackageCode',v_current_package,
      'requestedPackageCode',v_requested_package,
      'subscriberCount',v_count,
      'subscriberLimit',v_limit
    )
  );

  return query
    select v_existing_id,v_requested_package,false;
end;
$function$;


revoke all on function public.powerhub_admin_update_subscription_idempotent(bigint,bigint,text,text,text,timestamptz,boolean,text,bigint,text) from public,anon,authenticated;
grant execute on function public.powerhub_admin_update_subscription_idempotent(bigint,bigint,text,text,text,timestamptz,boolean,text,bigint,text) to service_role;

revoke all on function public.powerhub_admin_renew_subscription_with_addons(bigint,bigint,timestamptz,text,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.powerhub_admin_renew_subscription_with_addons(bigint,bigint,timestamptz,text,jsonb,uuid) to service_role;

revoke all on function public.powerhub_request_subscription_upgrade(bigint,bigint,bigint,text) from public,anon,authenticated;
grant execute on function public.powerhub_request_subscription_upgrade(bigint,bigint,bigint,text) to service_role;
