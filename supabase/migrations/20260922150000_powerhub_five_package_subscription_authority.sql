-- Retire legacy Starter/Professional/Enterprise subscription plans.
-- Five commercial package codes are now authoritative: basic, advanced, professional, business, vip.

alter table public.tenants
  add column if not exists package_code text;

update public.tenants t
set package_code = s.package_code
from public.tenant_subscriptions s
where s.tenant_id = t.id
  and s.package_code is not null
  and t.package_code is distinct from s.package_code;

do $
begin
  if exists (select 1 from public.tenants where package_code is null) then
    raise exception 'TENANT_PACKAGE_CODE_BACKFILL_INCOMPLETE'
      using errcode='23514';
  end if;
end
$;

alter table public.tenants
  alter column package_code set not null;

do $
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid='public.tenants'::regclass
      and conname='tenants_package_code_check'
  ) then
    alter table public.tenants
      add constraint tenants_package_code_check
      check (package_code in ('basic','advanced','professional','business','vip'));
  end if;
end
$;

drop function if exists public.powerhub_admin_update_subscription(bigint, bigint, text, text, text, timestamptz, boolean, text, bigint);
drop function if exists public.powerhub_admin_quick_upgrade_owner_plan(bigint, bigint, text, text);
drop function if exists public.powerhub_admin_review_subscription_upgrade_request(bigint, bigint, text, text);
drop function if exists public.powerhub_create_generator_owner_subscription(bigint, uuid, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text, timestamptz, integer);

create function public.powerhub_admin_update_subscription(
  p_actor_user_id bigint,
  p_tenant_id bigint,
  p_package_code text,
  p_status text,
  p_billing_cycle text,
  p_ends_at timestamptz,
  p_auto_renew boolean,
  p_notes text default null,
  p_sms_plan_id bigint default null
)
returns table(success boolean, subscription_id bigint, site_id bigint)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_actor_platform_role text; v_subscription_id bigint; v_site_id bigint; v_sms_plan_active boolean;
begin
 select u.platform_role into v_actor_platform_role
 from public.users u
 where u.id=p_actor_user_id
   and u.role='admin'
   and u.account_status='active'
   and u.platform_role in ('platform_owner','platform_admin','finance_admin');
 if v_actor_platform_role is null then raise exception 'FORBIDDEN_PLATFORM_ROLE' using errcode='42501'; end if;
 if p_package_code not in ('basic','advanced','professional','business','vip') then raise exception 'INVALID_SUBSCRIPTION_PLAN' using errcode='22023'; end if;
 if p_status not in ('trial','active','overdue','suspended','cancelled') then raise exception 'INVALID_SUBSCRIPTION_STATUS' using errcode='22023'; end if;
 if p_billing_cycle not in ('monthly','yearly') then raise exception 'INVALID_BILLING_CYCLE' using errcode='22023'; end if;
 if p_sms_plan_id is not null then
   select sp.is_active into v_sms_plan_active from public.platform_sms_plans sp where sp.id=p_sms_plan_id;
   if coalesce(v_sms_plan_active,false)=false then raise exception 'SMS_PLAN_NOT_ACTIVE' using errcode='22023'; end if;
 end if;
 select ts.id,s.id into v_subscription_id,v_site_id
 from public.tenant_subscriptions ts
 left join lateral(select id from public.sites where tenant_id=p_tenant_id order by id limit 1)s on true
 where ts.tenant_id=p_tenant_id limit 1;
 if v_subscription_id is null or v_site_id is null then raise exception 'SUBSCRIPTION_OR_SITE_NOT_FOUND' using errcode='P0002'; end if;
 update public.tenant_subscriptions set package_code=p_package_code,status=p_status,billing_cycle=p_billing_cycle,ends_at=p_ends_at,auto_renew=p_auto_renew,notes=p_notes,sms_plan_id=p_sms_plan_id,updated_at=now() where id=v_subscription_id;
 update public.tenants set status=case when p_status in ('suspended','cancelled') then 'suspended' else 'active' end,updated_at=now() where id=p_tenant_id;
 insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data) values(p_tenant_id,v_site_id,p_actor_user_id,v_actor_platform_role,'tenant_subscription',v_subscription_id::text,'platform_admin_update_subscription',jsonb_build_object('packageCode',p_package_code,'status',p_status,'billingCycle',p_billing_cycle,'endsAt',p_ends_at,'autoRenew',p_auto_renew,'smsPlanId',p_sms_plan_id));
 return query select true,v_subscription_id,v_site_id;
end;
$$;

revoke execute on function public.powerhub_admin_update_subscription(bigint,bigint,text,text,text,timestamptz,boolean,text,bigint) from public, anon, authenticated;
grant execute on function public.powerhub_admin_update_subscription(bigint,bigint,text,text,text,timestamptz,boolean,text,bigint) to service_role;

create function public.powerhub_admin_quick_upgrade_owner_plan(
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

  if p_package_code not in ('basic', 'advanced', 'professional', 'business', 'vip') then
    raise exception 'INVALID_PLAN' using errcode = '22023';
  end if;

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

  v_current_rank := case v_subscription.package_code
    when 'basic' then 1
    when 'advanced' then 2
    when 'professional' then 3
    when 'business' then 4
    when 'vip' then 5
  end;
  v_requested_rank := case p_package_code
    when 'basic' then 1
    when 'advanced' then 2
    when 'professional' then 3
    when 'business' then 4
    when 'vip' then 5
  end;

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
grant execute on function public.powerhub_admin_quick_upgrade_owner_plan(bigint, bigint, text, text) to service_role;;

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
  p_subscription_status text default 'trial',
  p_ends_at timestamptz default null,
  p_trial_duration_days integer default 8
)
returns table (tenant_id bigint, owner_user_id bigint, site_id bigint, subscription_id bigint)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_platform_role text;
  v_started_at timestamptz := now();
  v_ends_at timestamptz;
  v_tenant_id bigint;
  v_user_id bigint;
  v_site_id bigint;
  v_subscription_id bigint;
  v_site_name text := coalesce(nullif(trim(p_site_name), ''), 'الفرع الرئيسي');
  v_site_code text := coalesce(nullif(trim(p_site_code), ''), 'SITE-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)));
begin
  select platform_role into v_actor_platform_role
  from public.users
  where id = p_actor_user_id
    and role = 'admin'
    and account_status = 'active';

  if v_actor_platform_role is null then
    raise exception using errcode = '42501', message = 'حساب المنفذ لا يملك صلاحية إنشاء صاحب مولد.';
  end if;

  if p_auth_user_id is null then
    raise exception using errcode = '22023', message = 'معرف حساب Supabase Auth مطلوب.';
  end if;

  if p_package_code not in ('basic','advanced','professional','business','vip') then
    raise exception using errcode = '22023', message = 'خطة الاشتراك غير صالحة.';
  end if;

  if p_billing_cycle not in ('monthly', 'yearly') then
    raise exception using errcode = '22023', message = 'دورة الفوترة غير صالحة.';
  end if;

  if p_subscription_status not in ('trial', 'active', 'overdue', 'suspended', 'cancelled') then
    raise exception using errcode = '22023', message = 'حالة الاشتراك غير صالحة.';
  end if;

  if p_trial_duration_days is null or p_trial_duration_days < 1 or p_trial_duration_days > 3650 then
    raise exception using errcode = '22023', message = 'مدة التجربة يجب أن تكون بين يوم واحد و3650 يوماً.';
  end if;

  if exists (select 1 from public.tenant_owner_profiles where phone = p_owner_phone) then
    raise exception using errcode = '23505', message = 'رقم هاتف صاحب المولد مستخدم بالفعل.';
  end if;

  if exists (select 1 from public.tenant_owner_profiles where email = lower(p_owner_email)) then
    raise exception using errcode = '23505', message = 'البريد الإلكتروني لصاحب المولد مستخدم بالفعل.';
  end if;

  if exists (select 1 from public.tenants where slug = p_slug) then
    raise exception using errcode = '23505', message = 'معرف مساحة صاحب المولد مستخدم بالفعل.';
  end if;

  if exists (
    select 1 from public.users
    where auth_user_id = p_auth_user_id
      and (role <> 'user' or platform_role is not null)
  ) then
    raise exception using errcode = '23505', message = 'حساب Auth مرتبط بصلاحية منصة ولا يمكن تخصيصه لصاحب مولد.';
  end if;

  v_ends_at := coalesce(
    p_ends_at,
    v_started_at + case
      when p_subscription_status = 'trial' then make_interval(days => p_trial_duration_days)
      when p_billing_cycle = 'yearly' then interval '1 year'
      else interval '1 month'
    end
  );

  insert into public.users (
    auth_user_id, name, email, login_method, role, account_status,
    must_change_password, temporary_password_issued_at, last_signed_in
  ) values (
    p_auth_user_id, p_owner_name, lower(p_owner_email), 'supabase', 'user', 'active',
    true, v_started_at, v_started_at
  )
  on conflict (auth_user_id) do update
  set name = coalesce(excluded.name, public.users.name),
      email = excluded.email,
      login_method = 'supabase',
      role = 'user',
      account_status = 'active',
      must_change_password = true,
      temporary_password_issued_at = v_started_at,
      last_signed_in = v_started_at
  returning id into v_user_id;

  insert into public.tenants (name, slug, status, package_code)
  values (p_tenant_name, p_slug, case when p_subscription_status = 'cancelled' then 'suspended' else 'active' end, p_package_code)
  returning id into v_tenant_id;

  insert into public.tenant_owner_profiles (
    tenant_id, owner_user_id, full_name, phone, whatsapp_number, email, company_name,
    identity_number_ciphertext, identity_number_iv, identity_number_last4, invited_at, claimed_at
  ) values (
    v_tenant_id, v_user_id, p_owner_name, p_owner_phone, nullif(p_owner_whatsapp, ''), lower(p_owner_email),
    nullif(p_company_name, ''), p_identity_ciphertext, p_identity_iv, p_identity_last4, v_started_at, v_started_at
  );

  -- Every new owner subscription receives exactly one operational main branch.
  insert into public.sites (tenant_id, name, code, status)
  values (v_tenant_id, v_site_name, v_site_code, 'active')
  returning id into v_site_id;

  if v_site_id is null then
    raise exception using errcode = '23514', message = 'تعذر إنشاء الفرع الرئيسي لصاحب المولد.';
  end if;

  insert into public.tenant_members (tenant_id, user_id, role, is_active, membership_status)
  values (v_tenant_id, v_user_id, 'owner', true, 'active');

  insert into public.staff_profiles (tenant_id, site_id, user_id, role, is_active)
  values (v_tenant_id, v_site_id, v_user_id, 'owner', true);

  insert into public.tenant_subscriptions (
    tenant_id, package_code, status, billing_cycle, started_at, ends_at, auto_renew, renewal_count, notes
  ) values (
    v_tenant_id, p_package_code, p_subscription_status, p_billing_cycle, v_started_at, v_ends_at, false, 0, null
  ) returning id into v_subscription_id;

  insert into public.audit_logs (
    tenant_id, site_id, user_id, actor_platform_role, entity_type, entity_id, action, after_data, metadata
  ) values (
    v_tenant_id, v_site_id, p_actor_user_id, v_actor_platform_role,
    'tenant_subscription', v_subscription_id::text,
    'platform_admin_create_generator_owner_subscription',
    jsonb_build_object(
      'tenantId', v_tenant_id,
      'ownerUserId', v_user_id,
      'siteId', v_site_id,
      'siteName', v_site_name,
      'packageCode', p_package_code,
      'status', p_subscription_status
    ),
    jsonb_build_object('ownerEmail', lower(p_owner_email), 'ownerPhoneLast4', right(p_owner_phone, 4))
  );

  return query select v_tenant_id, v_user_id, v_site_id, v_subscription_id;
end;
$$;

revoke all on function public.powerhub_create_generator_owner_subscription(bigint, uuid, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.powerhub_create_generator_owner_subscription(bigint, uuid, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text, timestamptz, integer) to service_role;

comment on function public.powerhub_create_generator_owner_subscription(bigint, uuid, text, text, text, text, text, text, text, text, text, text, text, text, text, text, timestamptz, integer)
is 'Creates a generator-owner subscription atomically with its active main branch named الفرع الرئيسي by default.';;

