-- Owner creation: five-package catalog, explicit paid duration, optional trial.
alter table public.tenant_subscriptions
  add column if not exists trial_enabled boolean not null default false,
  add column if not exists trial_ends_at timestamptz;

drop function if exists public.powerhub_create_generator_owner_subscription(
  bigint,uuid,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,timestamptz,integer
);

create function public.powerhub_create_generator_owner_subscription(
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
  if p_package_code not in ('basic','advanced','professional','business','vip') then raise exception 'INVALID_PACKAGE_CODE' using errcode='22023'; end if;
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

revoke all on function public.powerhub_create_generator_owner_subscription(
  bigint,uuid,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,timestamptz,integer,integer,boolean
) from public,anon,authenticated;
grant execute on function public.powerhub_create_generator_owner_subscription(
  bigint,uuid,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,timestamptz,integer,integer,boolean
) to service_role;
