-- Harden owner lifecycle no-op semantics and make generator-owner provisioning retry-safe.
--
-- Owner attach:
-- exact same active owner membership + active owner staff profile + tenant owner profile
-- is a true no-op and must not create audit/update timestamps.
create or replace function public.powerhub_admin_attach_owner_user(
  p_actor_user_id bigint,
  p_tenant_id bigint,
  p_user_id bigint,
  p_site_id bigint default null
)
returns table(success boolean,site_id bigint)
language plpgsql
security definer
set search_path=public,pg_temp
as $function$
declare
  v_actor_platform_role text;
  v_user_role text;
  v_user_platform_role text;
  v_user_account_status text;
  v_site_id bigint;
  v_existing_owner_user_id bigint;
  v_existing_membership public.tenant_members%rowtype;
  v_existing_owner_profile boolean;
  v_existing_owner_profile_linked boolean;
  v_previous_owners jsonb;
begin
  select platform_role into v_actor_platform_role
  from public.users
  where id=p_actor_user_id and role='admin' and account_status='active'
    and platform_role in('platform_owner','platform_admin','finance_admin');
  if v_actor_platform_role is null then raise exception 'FORBIDDEN_PLATFORM_ROLE' using errcode='42501'; end if;

  select role,platform_role,account_status into v_user_role,v_user_platform_role,v_user_account_status
  from public.users where id=p_user_id;
  if v_user_role is null then raise exception 'OWNER_USER_NOT_FOUND' using errcode='P0002'; end if;
  if v_user_role<>'user' or v_user_platform_role is not null then raise exception 'PLATFORM_ACCOUNT_CANNOT_BE_OWNER' using errcode='42501'; end if;
  if v_user_account_status<>'active' then raise exception 'OWNER_USER_NOT_ACTIVE' using errcode='42501'; end if;

  if p_site_id is not null then
    select s.id into v_site_id from public.sites s where s.id=p_site_id and s.tenant_id=p_tenant_id;
  else
    select s.id into v_site_id from public.sites s where s.tenant_id=p_tenant_id order by s.id limit 1;
  end if;
  if v_site_id is null then raise exception 'SITE_NOT_FOUND' using errcode='P0002'; end if;

  perform pg_advisory_xact_lock(hashtext('tenant-owner-lifecycle:'||p_tenant_id::text)::bigint);

  select topm.user_id into v_existing_owner_user_id
  from public.tenant_members topm
  where topm.tenant_id=p_tenant_id and topm.role='owner'
    and topm.is_active=true and topm.membership_status='active'
  order by topm.updated_at desc nulls last, topm.id desc
  limit 1;

  select tm.* into v_existing_membership
  from public.tenant_members tm
  where tm.tenant_id=p_tenant_id and tm.user_id=p_user_id
  limit 1;

  select exists(
    select 1 from public.staff_profiles sp
    where sp.tenant_id=p_tenant_id and sp.user_id=p_user_id
      and sp.site_id=v_site_id and sp.role='owner' and sp.is_active=true
  ) into v_existing_owner_profile;

  select exists(
    select 1 from public.tenant_owner_profiles top
    where top.tenant_id=p_tenant_id and top.owner_user_id=p_user_id
  ) into v_existing_owner_profile_linked;

  if v_existing_owner_user_id=p_user_id
     and v_existing_membership.id is not null
     and v_existing_membership.role='owner'
     and v_existing_membership.is_active=true
     and v_existing_membership.membership_status='active'
     and v_existing_membership.expires_at is null
     and v_existing_owner_profile
     and v_existing_owner_profile_linked then
    return query select true,v_site_id;
    return;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('userId',tm.user_id,'membershipId',tm.id)),'[]'::jsonb)
  into v_previous_owners
  from public.tenant_members tm
  where tm.tenant_id=p_tenant_id and tm.role='owner' and tm.user_id<>p_user_id;

  update public.tenant_members set role='member',updated_at=now()
  where tenant_id=p_tenant_id and role='owner' and user_id<>p_user_id;

  update public.staff_profiles set is_active=false,updated_at=now()
  where tenant_id=p_tenant_id and user_id<>p_user_id and role='owner';

  insert into public.tenant_members(tenant_id,user_id,role,is_active,membership_status,updated_at)
  values(p_tenant_id,p_user_id,'owner',true,'active',now())
  on conflict (tenant_id,user_id) do update set
    role='owner',is_active=true,membership_status='active',expires_at=null,updated_at=now();

  insert into public.staff_profiles(tenant_id,site_id,user_id,role,is_active,updated_at)
  values(p_tenant_id,v_site_id,p_user_id,'owner',true,now())
  on conflict (user_id,site_id,role) do update set is_active=true,updated_at=now();

  update public.tenant_owner_profiles
  set owner_user_id=p_user_id,claimed_at=now(),updated_at=now()
  where tenant_id=p_tenant_id;

  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,metadata
  ) values(
    p_tenant_id,v_site_id,p_actor_user_id,v_actor_platform_role,
    'tenant_owner_profile',p_tenant_id::text,'platform_admin_attach_owner_user',
    jsonb_build_object('attachedUserId',p_user_id,'previousOwners',v_previous_owners,'ownershipTransferred',v_existing_owner_user_id is distinct from p_user_id)
  );

  return query select true,v_site_id;
end;
$function$;

-- Membership status already had the requested state comparison in Production.
-- Re-state it in migration history so Production and branch have one canonical contract.
create or replace function public.powerhub_admin_set_tenant_membership_status(
  p_actor_user_id bigint,
  p_tenant_id bigint,
  p_user_id bigint,
  p_status text
)
returns table(success boolean,membership_id bigint,site_id bigint,status text)
language plpgsql
security definer
set search_path=public,pg_temp
as $function$
declare
  v_actor_platform_role text;
  v_membership public.tenant_members%rowtype;
  v_site_id bigint;
  v_is_active boolean;
  v_active_owner_count integer;
begin
  select platform_role into v_actor_platform_role
  from public.users
  where id=p_actor_user_id and role='admin' and account_status='active'
    and platform_role in('platform_owner','platform_admin','finance_admin');
  if v_actor_platform_role is null then raise exception 'FORBIDDEN_PLATFORM_ROLE' using errcode='42501'; end if;

  if p_status not in('active','suspended','revoked') then raise exception 'INVALID_MEMBERSHIP_STATUS' using errcode='22023'; end if;

  perform pg_advisory_xact_lock(hashtext('tenant-owner-lifecycle:'||p_tenant_id::text)::bigint);

  select tm.* into v_membership
  from public.tenant_members tm
  where tm.tenant_id=p_tenant_id and tm.user_id=p_user_id
  limit 1;

  select s.id into v_site_id from public.sites s where s.tenant_id=p_tenant_id order by s.id limit 1;

  if v_membership.id is null or v_site_id is null then raise exception 'MEMBERSHIP_OR_SITE_NOT_FOUND' using errcode='P0002'; end if;

  v_is_active:=p_status='active';

  if v_membership.membership_status=p_status
     and v_membership.is_active=v_is_active
     and (
       (p_status='revoked' and v_membership.expires_at is not null)
       or (p_status<>'revoked' and v_membership.expires_at is null)
     ) then
    return query select true,v_membership.id,v_site_id,p_status;
    return;
  end if;

  if v_membership.role='owner' and p_status<>'active' then
    select count(*)::integer into v_active_owner_count
    from public.tenant_members tm
    where tm.tenant_id=p_tenant_id and tm.role='owner'
      and tm.is_active=true and tm.membership_status='active'
      and tm.user_id<>p_user_id;
    if v_active_owner_count=0 then raise exception 'LAST_ACTIVE_OWNER_PROTECTED' using errcode='P0001'; end if;
  end if;

  update public.tenant_members
  set membership_status=p_status,is_active=v_is_active,
      expires_at=case when p_status='revoked' then coalesce(v_membership.expires_at,now()) else null end,
      updated_at=now()
  where id=v_membership.id;

  update public.staff_profiles
  set is_active=v_is_active,updated_at=now()
  where tenant_id=p_tenant_id and user_id=p_user_id;

  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,
    entity_type,entity_id,action,before_data,after_data
  ) values(
    p_tenant_id,v_site_id,p_actor_user_id,v_actor_platform_role,
    'tenant_membership',v_membership.id::text,'platform_admin_set_tenant_membership_status',
    jsonb_build_object('status',v_membership.membership_status,'isActive',v_membership.is_active,'expiresAt',v_membership.expires_at),
    jsonb_build_object('status',p_status,'isActive',v_is_active,'staffProfilesSynchronized',true)
  );

  return query select true,v_membership.id,v_site_id,p_status;
end;
$function$;

-- Provisioning identity is deliberately separate from offline_sync_operations:
-- there is no tenant yet at the point the workflow starts, and Auth is an external
-- side effect that must be reconciled by operation identity.
create table if not exists public.generator_owner_provisioning_operations (
  client_operation_id uuid primary key,
  actor_user_id bigint not null references public.users(id),
  owner_email text not null,
  request_fingerprint text not null,
  auth_user_id uuid,
  status text not null default 'pending' check (status in ('pending','completed')),
  tenant_id bigint references public.tenants(id),
  owner_user_id bigint references public.users(id),
  site_id bigint references public.sites(id),
  subscription_id bigint references public.tenant_subscriptions(id),
  response jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists generator_owner_provisioning_auth_uidx
  on public.generator_owner_provisioning_operations(auth_user_id)
  where auth_user_id is not null;

create index if not exists generator_owner_provisioning_email_idx
  on public.generator_owner_provisioning_operations(lower(owner_email));

alter table public.generator_owner_provisioning_operations enable row level security;
revoke all on table public.generator_owner_provisioning_operations from anon,authenticated;
grant all on table public.generator_owner_provisioning_operations to service_role;

create or replace function public.powerhub_admin_begin_generator_owner_provisioning(
  p_actor_user_id bigint,
  p_client_operation_id uuid,
  p_owner_email text,
  p_request_fingerprint text
)
returns table(client_operation_id uuid,auth_user_id uuid,status text,replayed boolean)
language plpgsql
security definer
set search_path=public,pg_temp
as $function$
declare
  v_role text;
  v_op public.generator_owner_provisioning_operations%rowtype;
  v_existing_public_user_id bigint;
  v_existing_auth_user_id uuid;
begin
  select platform_role into v_role
  from public.users
  where id=p_actor_user_id and role='admin' and account_status='active'
    and platform_role in('platform_owner','platform_admin');
  if v_role is null then raise exception 'FORBIDDEN_PLATFORM_ROLE' using errcode='42501'; end if;
  if p_client_operation_id is null then raise exception 'CLIENT_OPERATION_REQUIRED' using errcode='P0001'; end if;
  if nullif(trim(p_owner_email),'') is null then raise exception 'OWNER_EMAIL_REQUIRED' using errcode='22023'; end if;
  if nullif(trim(p_request_fingerprint),'') is null then raise exception 'REQUEST_FINGERPRINT_REQUIRED' using errcode='P0001'; end if;

  perform pg_advisory_xact_lock(hashtext('generator-owner-provision:'||p_client_operation_id::text)::bigint);

  select * into v_op
  from public.generator_owner_provisioning_operations
  where client_operation_id=p_client_operation_id
  for update;

  if found then
    if v_op.actor_user_id<>p_actor_user_id or v_op.request_fingerprint<>trim(p_request_fingerprint) then
      raise exception 'GENERATOR_OWNER_PROVISIONING_OPERATION_CONFLICT' using errcode='P0001';
    end if;
    return query select v_op.client_operation_id,v_op.auth_user_id,v_op.status,true;
    return;
  end if;

  select u.id,u.auth_user_id into v_existing_public_user_id,v_existing_auth_user_id
  from public.users u
  where lower(u.email)=lower(trim(p_owner_email))
  limit 1;
  if v_existing_public_user_id is not null then
    raise exception 'OWNER_EMAIL_ALREADY_PROVISIONED' using errcode='23505';
  end if;

  if exists(select 1 from public.tenant_owner_profiles top where lower(top.email)=lower(trim(p_owner_email))) then
    raise exception 'OWNER_EMAIL_ALREADY_PROVISIONED' using errcode='23505';
  end if;

  if exists(select 1 from auth.users au where lower(au.email)=lower(trim(p_owner_email))) then
    raise exception 'AUTH_EMAIL_ALREADY_EXISTS' using errcode='23505';
  end if;

  insert into public.generator_owner_provisioning_operations(
    client_operation_id,actor_user_id,owner_email,request_fingerprint,status
  ) values(
    p_client_operation_id,p_actor_user_id,lower(trim(p_owner_email)),trim(p_request_fingerprint),'pending'
  );

  return query select p_client_operation_id,null::uuid,'pending'::text,false;
end;
$function$;

create or replace function public.powerhub_admin_complete_generator_owner_provisioning(
  p_actor_user_id bigint,
  p_client_operation_id uuid,
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
  p_site_name text,
  p_site_code text,
  p_plan text default 'starter',
  p_billing_cycle text default 'monthly',
  p_subscription_status text default 'trial',
  p_ends_at timestamptz default null,
  p_trial_duration_days integer default 8
)
returns table(success boolean,tenant_id bigint,owner_user_id bigint,site_id bigint,subscription_id bigint,replayed boolean)
language plpgsql
security definer
set search_path=public,pg_temp
as $function$
declare
  v_role text;
  v_op public.generator_owner_provisioning_operations%rowtype;
  v_started_at timestamptz:=now();
  v_ends_at timestamptz;
  v_tenant_id bigint;
  v_user_id bigint;
  v_site_id bigint;
  v_subscription_id bigint;
begin
  select platform_role into v_role
  from public.users
  where id=p_actor_user_id and role='admin' and account_status='active'
    and platform_role in('platform_owner','platform_admin');
  if v_role is null then raise exception 'FORBIDDEN_PLATFORM_ROLE' using errcode='42501'; end if;
  if p_auth_user_id is null then raise exception 'AUTH_USER_REQUIRED' using errcode='22023'; end if;
  if p_client_operation_id is null then raise exception 'CLIENT_OPERATION_REQUIRED' using errcode='P0001'; end if;
  if p_plan not in ('starter','professional','enterprise') then raise exception 'INVALID_PLAN' using errcode='22023'; end if;
  if p_billing_cycle not in ('monthly','yearly') then raise exception 'INVALID_BILLING_CYCLE' using errcode='22023'; end if;
  if p_subscription_status not in ('trial','active','overdue','suspended','cancelled') then raise exception 'INVALID_SUBSCRIPTION_STATUS' using errcode='22023'; end if;
  if p_trial_duration_days is null or p_trial_duration_days<1 or p_trial_duration_days>3650 then raise exception 'INVALID_TRIAL_DURATION' using errcode='22023'; end if;

  perform pg_advisory_xact_lock(hashtext('generator-owner-provision:'||p_client_operation_id::text)::bigint);

  select * into v_op
  from public.generator_owner_provisioning_operations
  where client_operation_id=p_client_operation_id
  for update;

  if not found then raise exception 'PROVISIONING_OPERATION_NOT_FOUND' using errcode='P0002'; end if;
  if v_op.actor_user_id<>p_actor_user_id then raise exception 'PROVISIONING_OPERATION_ACTOR_CONFLICT' using errcode='P0001'; end if;
  if v_op.auth_user_id is not null and v_op.auth_user_id<>p_auth_user_id then raise exception 'PROVISIONING_AUTH_USER_CONFLICT' using errcode='P0001'; end if;

  if v_op.status='completed' then
    return query
      select true,v_op.tenant_id,v_op.owner_user_id,v_op.site_id,v_op.subscription_id,true;
    return;
  end if;

  if v_op.owner_email<>lower(trim(p_owner_email)) then raise exception 'PROVISIONING_EMAIL_CONFLICT' using errcode='P0001'; end if;

  update public.generator_owner_provisioning_operations
  set auth_user_id=p_auth_user_id,updated_at=now()
  where client_operation_id=p_client_operation_id;

  begin
    if exists(select 1 from public.users where auth_user_id=p_auth_user_id and role<>'user') then
      raise exception 'AUTH_USER_ALREADY_MAPPED' using errcode='23505';
    end if;
    if exists(select 1 from public.tenant_owner_profiles where phone=p_owner_phone) then
      raise exception 'OWNER_PHONE_ALREADY_PROVISIONED' using errcode='23505';
    end if;
    if exists(select 1 from public.tenant_owner_profiles where email=lower(p_owner_email)) then
      raise exception 'OWNER_EMAIL_ALREADY_PROVISIONED' using errcode='23505';
    end if;
    if exists(select 1 from public.tenants where slug=p_slug) then
      raise exception 'TENANT_SLUG_ALREADY_EXISTS' using errcode='23505';
    end if;

    v_ends_at:=case
      when p_subscription_status='trial' then v_started_at+make_interval(days=>p_trial_duration_days)
      when p_ends_at is not null then p_ends_at
      when p_billing_cycle='yearly' then v_started_at+interval '1 year'
      else v_started_at+interval '1 month'
    end;

    insert into public.users(
      auth_user_id,name,email,login_method,role,account_status,must_change_password,
      temporary_password_issued_at,last_signed_in
    ) values(
      p_auth_user_id,p_owner_name,lower(p_owner_email),'supabase','user','active',true,
      v_started_at,v_started_at
    ) on conflict(auth_user_id) do update set
      name=coalesce(excluded.name,public.users.name),
      email=excluded.email,login_method='supabase',role='user',
      account_status='active',must_change_password=true,
      temporary_password_issued_at=v_started_at,last_signed_in=v_started_at
    returning id into v_user_id;

    insert into public.tenants(name,slug,status,plan)
    values(p_tenant_name,p_slug,case when p_subscription_status='cancelled' then 'suspended' else 'active' end,p_plan)
    returning id into v_tenant_id;

    insert into public.tenant_owner_profiles(
      tenant_id,owner_user_id,full_name,phone,whatsapp_number,email,company_name,
      identity_number_ciphertext,identity_number_iv,identity_number_last4,invited_at,claimed_at
    ) values(
      v_tenant_id,v_user_id,p_owner_name,p_owner_phone,nullif(p_owner_whatsapp,''),
      lower(p_owner_email),nullif(p_company_name,''),p_identity_ciphertext,p_identity_iv,
      p_identity_last4,v_started_at,v_started_at
    );

    insert into public.sites(tenant_id,name,code,status)
    values(v_tenant_id,p_site_name,p_site_code,'active')
    returning id into v_site_id;

    insert into public.tenant_members(tenant_id,user_id,role,is_active,membership_status)
    values(v_tenant_id,v_user_id,'owner',true,'active');

    insert into public.staff_profiles(tenant_id,site_id,user_id,role,is_active)
    values(v_tenant_id,v_site_id,v_user_id,'owner',true);

    insert into public.tenant_subscriptions(
      tenant_id,plan,status,billing_cycle,started_at,ends_at,auto_renew,renewal_count,
      notes,trial_duration_days
    ) values(
      v_tenant_id,p_plan,p_subscription_status,p_billing_cycle,v_started_at,v_ends_at,false,0,
      null,case when p_subscription_status='trial' then p_trial_duration_days else null end
    )
    returning id into v_subscription_id;

    insert into public.audit_logs(
      tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data,metadata
    ) values(
      v_tenant_id,v_site_id,p_actor_user_id,v_role,'tenant_subscription',v_subscription_id::text,
      'platform_admin_create_generator_owner_subscription',
      jsonb_build_object(
        'tenantId',v_tenant_id,'ownerUserId',v_user_id,'plan',p_plan,
        'status',p_subscription_status,
        'trialDurationDays',case when p_subscription_status='trial' then p_trial_duration_days else null end
      ),
      jsonb_build_object(
        'ownerEmail',lower(p_owner_email),'ownerPhoneLast4',right(p_owner_phone,4),
        'clientOperationId',p_client_operation_id
      )
    );

    update public.generator_owner_provisioning_operations
    set status='completed',
        tenant_id=v_tenant_id,owner_user_id=v_user_id,site_id=v_site_id,
        subscription_id=v_subscription_id,
        response=jsonb_build_object(
          'tenantId',v_tenant_id,'ownerUserId',v_user_id,'siteId',v_site_id,
          'subscriptionId',v_subscription_id
        ),
        updated_at=now()
    where client_operation_id=p_client_operation_id;

  exception when others then
    raise;
  end;

  return query select true,v_tenant_id,v_user_id,v_site_id,v_subscription_id,false;
end;
$function$;

revoke execute on function public.powerhub_admin_begin_generator_owner_provisioning(bigint,uuid,text,text) from public,anon,authenticated;
grant execute on function public.powerhub_admin_begin_generator_owner_provisioning(bigint,uuid,text,text) to service_role;
do $$ declare r record; begin for r in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='powerhub_admin_complete_generator_owner_provisioning' loop execute format('revoke execute on function %s from public,anon,authenticated',r.signature); execute format('grant execute on function %s to service_role',r.signature); end loop; end $$;

revoke execute on function public.powerhub_create_generator_owner_subscription(bigint,uuid,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,timestamptz,integer) from public,anon,authenticated;
grant execute on function public.powerhub_create_generator_owner_subscription(bigint,uuid,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,timestamptz,integer) to service_role;
