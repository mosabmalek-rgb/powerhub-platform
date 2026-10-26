-- Correct trial-to-paid lifecycle and add idempotent subscription reminders.
-- Trial and paid periods use the same selected package; the paid term begins after trial.
alter table public.tenant_subscriptions
  add column if not exists trial_enabled boolean not null default false,
  add column if not exists trial_ends_at timestamptz;

-- Backfill only still-running legacy trials. Expired trials remain expired and
-- are not silently reactivated. Older records did not store the paid duration.
update public.tenant_subscriptions
set trial_enabled=true,
    trial_ends_at=coalesce(trial_ends_at, started_at + make_interval(days=>trial_duration_days)),
    ends_at=case
      when ends_at <= coalesce(trial_ends_at, started_at + make_interval(days=>trial_duration_days))
      then coalesce(trial_ends_at, started_at + make_interval(days=>trial_duration_days))
        + case when billing_cycle='yearly' then interval '1 year' else interval '1 month' end
      else ends_at
    end,
    updated_at=now()
where status='trial'
  and ends_at>now()
  and trial_duration_days is not null;

create index if not exists tenant_subscriptions_trial_ends_at_idx
  on public.tenant_subscriptions (trial_ends_at)
  where status='trial' and trial_ends_at is not null;

-- Keep the previous RPC signature during rollout so the currently deployed server
-- remains compatible until the application release switches to the new duration-aware signature.
CREATE FUNCTION public.powerhub_admin_complete_generator_owner_provisioning(p_actor_user_id bigint, p_client_operation_id uuid, p_auth_user_id uuid, p_tenant_name text, p_slug text, p_company_name text, p_owner_name text, p_identity_ciphertext text, p_identity_iv text, p_identity_last4 text, p_owner_phone text, p_owner_whatsapp text, p_owner_email text, p_site_name text, p_site_code text, p_package_code text DEFAULT 'basic'::text, p_billing_cycle text DEFAULT 'monthly'::text, p_subscription_status text DEFAULT 'trial'::text, p_subscription_duration integer, p_ends_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_trial_duration_days integer DEFAULT 8)
 RETURNS TABLE(success boolean, tenant_id bigint, owner_user_id bigint, site_id bigint, subscription_id bigint, replayed boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
 v_role text;
 v_op public.generator_owner_provisioning_operations%rowtype;
 v_started_at timestamptz:=now();
 v_trial_ends_at timestamptz;
 v_ends_at timestamptz;
 v_tenant_id bigint;
 v_user_id bigint;
 v_site_id bigint;
 v_subscription_id bigint;
 v_package_code text;
begin
 select platform_role into v_role
 from public.users
 where id=p_actor_user_id and role='admin' and account_status='active'
   and platform_role in('platform_owner','platform_admin');

 if v_role is null then
   raise exception 'FORBIDDEN_PLATFORM_ROLE' using errcode='42501';
 end if;

 if p_auth_user_id is null then
   raise exception 'AUTH_USER_REQUIRED' using errcode='22023';
 end if;

 if p_client_operation_id is null then
   raise exception 'CLIENT_OPERATION_REQUIRED' using errcode='P0001';
 end if;

 v_package_code:=lower(nullif(btrim(p_package_code),''));
 perform public.powerhub_validate_package_code(v_package_code);

 if p_billing_cycle not in('monthly','yearly') then
   raise exception 'INVALID_BILLING_CYCLE' using errcode='22023';
 end if;

 if p_subscription_status not in('trial','active','overdue','suspended','cancelled') then
   raise exception 'INVALID_SUBSCRIPTION_STATUS' using errcode='22023';
 end if;

 if p_trial_duration_days is null or p_trial_duration_days<1 or p_trial_duration_days>3650 then
   raise exception 'INVALID_TRIAL_DURATION' using errcode='22023';
 end if;
 if p_subscription_duration is null or p_subscription_duration<1 or p_subscription_duration>60 then
   raise exception 'INVALID_SUBSCRIPTION_DURATION' using errcode='22023';
 end if;

 perform pg_advisory_xact_lock(hashtext('generator-owner-provision:'||p_client_operation_id::text)::bigint);

 select * into v_op
 from public.generator_owner_provisioning_operations
 where client_operation_id=p_client_operation_id
 for update;

 if not found then
   raise exception 'PROVISIONING_OPERATION_NOT_FOUND' using errcode='P0002';
 end if;

 if v_op.actor_user_id<>p_actor_user_id then
   raise exception 'PROVISIONING_OPERATION_ACTOR_CONFLICT' using errcode='P0001';
 end if;

 if v_op.auth_user_id is not null and v_op.auth_user_id<>p_auth_user_id then
   raise exception 'PROVISIONING_AUTH_USER_CONFLICT' using errcode='P0001';
 end if;

 if v_op.status='completed' then
   return query select true,v_op.tenant_id,v_op.owner_user_id,v_op.site_id,v_op.subscription_id,true;
   return;
 end if;

 if v_op.owner_email<>lower(trim(p_owner_email)) then
   raise exception 'PROVISIONING_EMAIL_CONFLICT' using errcode='P0001';
 end if;

 update public.generator_owner_provisioning_operations
 set auth_user_id=p_auth_user_id,updated_at=now()
 where client_operation_id=p_client_operation_id;

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

 v_trial_ends_at:=case
   when p_subscription_status='trial' then v_started_at+make_interval(days=>p_trial_duration_days)
   else null
 end;

 -- ends_at represents the end of the selected package period. Trial access
 -- expires at trial_ends_at; the paid period starts immediately afterward.
 v_ends_at:=case
   when p_subscription_status='trial' then coalesce(
     p_ends_at,
     v_trial_ends_at + case
       when p_billing_cycle='yearly' then make_interval(years=>p_subscription_duration)
       else make_interval(months=>p_subscription_duration)
     end
   )
   when p_ends_at is not null then p_ends_at
   when p_billing_cycle='yearly' then v_started_at+make_interval(years=>p_subscription_duration)
   else v_started_at+make_interval(months=>p_subscription_duration)
 end;

 if p_subscription_status='trial' and (v_trial_ends_at is null or v_ends_at<=v_trial_ends_at) then
   raise exception 'INVALID_TRIAL_SUBSCRIPTION_END_DATE' using errcode='22023';
 end if;

 insert into public.users(
   auth_user_id,name,email,login_method,role,account_status,
   must_change_password,temporary_password_issued_at,last_signed_in
 )
 values(
   p_auth_user_id,p_owner_name,lower(p_owner_email),'supabase','user','active',
   true,v_started_at,v_started_at
 )
 on conflict(auth_user_id) do update set
   name=coalesce(excluded.name,public.users.name),
   email=excluded.email,
   login_method='supabase',
   role='user',
   account_status='active',
   must_change_password=true,
   temporary_password_issued_at=v_started_at,
   last_signed_in=v_started_at
 returning id into v_user_id;

 insert into public.tenants(name,slug,status)
 values(p_tenant_name,p_slug,case when p_subscription_status='cancelled' then 'suspended' else 'active' end)
 returning id into v_tenant_id;

 insert into public.tenant_owner_profiles(
   tenant_id,owner_user_id,full_name,phone,whatsapp_number,email,
   company_name,identity_number_ciphertext,identity_number_iv,
   identity_number_last4,invited_at,claimed_at
 )
 values(
   v_tenant_id,v_user_id,p_owner_name,p_owner_phone,nullif(p_owner_whatsapp,''),
   lower(p_owner_email),nullif(p_company_name,''),p_identity_ciphertext,
   p_identity_iv,p_identity_last4,v_started_at,v_started_at
 );

 insert into public.sites(tenant_id,name,code,status)
 values(v_tenant_id,p_site_name,p_site_code,'active')
 returning id into v_site_id;

 insert into public.tenant_members(
   tenant_id,user_id,role,is_active,membership_status
 )
 values(v_tenant_id,v_user_id,'owner',true,'active');

 insert into public.staff_profiles(
   tenant_id,site_id,user_id,role,is_active
 )
 values(v_tenant_id,v_site_id,v_user_id,'owner',true);

 insert into public.tenant_subscriptions(
   tenant_id,package_code,status,billing_cycle,started_at,ends_at,
   auto_renew,renewal_count,notes,trial_duration_days,trial_enabled,trial_ends_at
 )
 values(
   v_tenant_id,v_package_code,p_subscription_status,p_billing_cycle,
   v_started_at,v_ends_at,false,0,null,
   case when p_subscription_status='trial' then p_trial_duration_days else null end,
   p_subscription_status='trial',v_trial_ends_at
 )
 returning id into v_subscription_id;

 insert into public.audit_logs(
   tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,
   action,after_data,metadata
 )
 values(
   v_tenant_id,v_site_id,p_actor_user_id,v_role,'tenant_subscription',
   v_subscription_id::text,'platform_admin_create_generator_owner_subscription',
   jsonb_build_object(
     'tenantId',v_tenant_id,
     'ownerUserId',v_user_id,
     'packageCode',v_package_code,
     'status',p_subscription_status,
     'trialDurationDays',case when p_subscription_status='trial' then p_trial_duration_days else null end,
     'subscriptionDuration',p_subscription_duration
   ),
   jsonb_build_object(
     'ownerEmail',lower(p_owner_email),
     'ownerPhoneLast4',right(p_owner_phone,4),
     'clientOperationId',p_client_operation_id
   )
 );

 update public.generator_owner_provisioning_operations
 set status='completed',
     tenant_id=v_tenant_id,
     owner_user_id=v_user_id,
     site_id=v_site_id,
     subscription_id=v_subscription_id,
     response=jsonb_build_object(
       'tenantId',v_tenant_id,
       'ownerUserId',v_user_id,
       'siteId',v_site_id,
       'subscriptionId',v_subscription_id,
       'packageCode',v_package_code
     ),
     updated_at=now()
 where client_operation_id=p_client_operation_id;

 return query select true,v_tenant_id,v_user_id,v_site_id,v_subscription_id,false;
end;
$function$;

ALTER FUNCTION public.powerhub_admin_complete_generator_owner_provisioning(bigint, uuid, uuid, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text, integer, timestamp with time zone, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.powerhub_admin_complete_generator_owner_provisioning(bigint, uuid, uuid, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text, integer, timestamp with time zone, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_admin_complete_generator_owner_provisioning(bigint, uuid, uuid, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text, integer, timestamp with time zone, integer) TO service_role;

create or replace function public.powerhub_process_subscription_lifecycle()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_trial_started integer := 0;
  v_expired integer := 0;
  v_reminders integer := 0;
  v_row record;
  v_notification_id bigint;
begin
  -- Activate the paid phase once the trial expires; keep the selected package.
  with transitioned as (
    update public.tenant_subscriptions ts
    set status='active', updated_at=now()
    where ts.status='trial'
      and ts.trial_ends_at is not null
      and ts.trial_ends_at <= now()
      and ts.ends_at > now()
    returning ts.id
  )
  select count(*)::integer into v_trial_started from transitioned;

  -- End access after the full paid period has expired.
  for v_row in
    select ts.id,ts.tenant_id,ts.package_code,ts.ends_at,p.owner_user_id
    from public.tenant_subscriptions ts
    left join public.tenant_owner_profiles p on p.tenant_id=ts.tenant_id
    where ts.status in ('trial','active')
      and ts.ends_at <= now()
    order by ts.ends_at,ts.id
    for update of ts skip locked
  loop
    update public.tenant_subscriptions
      set status='overdue', updated_at=now()
      where id=v_row.id and status in ('trial','active');
    if found then
      if v_row.owner_user_id is not null then
        perform public.powerhub_notification_insert(
          v_row.owner_user_id,v_row.tenant_id,'system_alert',
          'انتهت مدة اشتراك PowerHub',
          'انتهت فترة الباقة المحددة. جدّد الاشتراك لاستعادة صلاحيات التشغيل.',
          '/workspace','tenant_subscription',v_row.id::text,
          'subscription-expired:'||v_row.id::text,
          jsonb_build_object('subscription_id',v_row.id,'package_code',v_row.package_code,'ends_at',v_row.ends_at)
        );
      end if;
      v_expired := v_expired + 1;
    end if;
  end loop;

  -- Two-day trial reminder; dedupe key makes retries safe.
  for v_row in
    select ts.id,ts.tenant_id,ts.package_code,ts.trial_ends_at,p.owner_user_id
    from public.tenant_subscriptions ts
    join public.tenant_owner_profiles p on p.tenant_id=ts.tenant_id
    where ts.status='trial'
      and ts.trial_ends_at > now()
      and ts.trial_ends_at <= now()+interval '2 days'
  loop
    v_notification_id := public.powerhub_notification_insert(
      v_row.owner_user_id,v_row.tenant_id,'system_alert',
      'اقترب انتهاء الفترة التجريبية',
      'تبقّى يومان أو أقل على نهاية التجربة. ستبدأ فترة الباقة المحددة بعدها.',
      '/workspace','tenant_subscription',v_row.id::text,
      'subscription-trial-ending:'||v_row.id::text,
      jsonb_build_object('subscription_id',v_row.id,'package_code',v_row.package_code,'trial_ends_at',v_row.trial_ends_at)
    );
    if v_notification_id is not null then v_reminders := v_reminders + 1; end if;
  end loop;

  -- Two-day paid subscription reminder; dedupe key makes retries safe.
  for v_row in
    select ts.id,ts.tenant_id,ts.package_code,ts.ends_at,p.owner_user_id
    from public.tenant_subscriptions ts
    join public.tenant_owner_profiles p on p.tenant_id=ts.tenant_id
    where ts.status='active'
      and ts.ends_at > now()
      and ts.ends_at <= now()+interval '2 days'
  loop
    v_notification_id := public.powerhub_notification_insert(
      v_row.owner_user_id,v_row.tenant_id,'system_alert',
      'اقترب انتهاء اشتراك PowerHub',
      'تبقّى يومان أو أقل على انتهاء الباقة. جدّد الاشتراك لتجنّب توقف الصلاحيات.',
      '/workspace','tenant_subscription',v_row.id::text,
      'subscription-ending:'||v_row.id::text,
      jsonb_build_object('subscription_id',v_row.id,'package_code',v_row.package_code,'ends_at',v_row.ends_at)
    );
    if v_notification_id is not null then v_reminders := v_reminders + 1; end if;
  end loop;

  return jsonb_build_object('trials_activated',v_trial_started,'subscriptions_expired',v_expired,'reminders_created',v_reminders);
end;
$$;

revoke all on function public.powerhub_process_subscription_lifecycle() from public, anon, authenticated;
grant execute on function public.powerhub_process_subscription_lifecycle() to service_role;

do $$
declare v_job_id bigint;
begin
  select jobid into v_job_id from cron.job where jobname='powerhub-subscription-lifecycle' limit 1;
  if v_job_id is not null then perform cron.unschedule(v_job_id); end if;
  perform cron.schedule('powerhub-subscription-lifecycle','*/15 * * * *','select public.powerhub_process_subscription_lifecycle();');
end;
$$;
