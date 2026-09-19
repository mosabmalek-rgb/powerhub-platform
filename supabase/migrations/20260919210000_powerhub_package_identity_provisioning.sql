create or replace function public.powerhub_admin_complete_generator_owner_provisioning(
  p_actor_user_id bigint,p_client_operation_id uuid,p_auth_user_id uuid,p_tenant_name text,p_slug text,
  p_company_name text,p_owner_name text,p_identity_ciphertext text,p_identity_iv text,p_identity_last4 text,
  p_owner_phone text,p_owner_whatsapp text,p_owner_email text,p_site_name text,p_site_code text,
  p_plan text default 'basic',p_billing_cycle text default 'monthly',p_subscription_status text default 'trial',
  p_ends_at timestamptz default null,p_trial_duration_days integer default 8
)
returns table(success boolean,tenant_id bigint,owner_user_id bigint,site_id bigint,subscription_id bigint,replayed boolean)
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  v_role text; v_op public.generator_owner_provisioning_operations%rowtype;
  v_started_at timestamptz:=now(); v_ends_at timestamptz;
  v_tenant_id bigint; v_user_id bigint; v_site_id bigint; v_subscription_id bigint;
  v_package_code text; v_legacy_plan text;
begin
  select platform_role into v_role from public.users
  where id=p_actor_user_id and role='admin' and account_status='active'
    and platform_role in('platform_owner','platform_admin');
  if v_role is null then raise exception 'FORBIDDEN_PLATFORM_ROLE' using errcode='42501'; end if;
  if p_auth_user_id is null then raise exception 'AUTH_USER_REQUIRED' using errcode='22023'; end if;
  if p_client_operation_id is null then raise exception 'CLIENT_OPERATION_REQUIRED' using errcode='P0001'; end if;

  v_package_code:=lower(nullif(btrim(p_plan),''));
  if v_package_code in ('starter','professional','enterprise') then
    v_package_code:=case v_package_code when 'starter' then 'basic' when 'professional' then 'advanced' when 'enterprise' then 'business' end;
  end if;
  if v_package_code not in ('basic','advanced','professional','business','vip') then
    raise exception 'INVALID_PLAN' using errcode='22023';
  end if;
  v_legacy_plan:=case v_package_code when 'basic' then 'starter' when 'advanced' then 'professional' when 'professional' then 'professional' when 'business' then 'enterprise' when 'vip' then 'enterprise' end;

  if p_billing_cycle not in ('monthly','yearly') then raise exception 'INVALID_BILLING_CYCLE' using errcode='22023'; end if;
  if p_subscription_status not in ('trial','active','overdue','suspended','cancelled') then raise exception 'INVALID_SUBSCRIPTION_STATUS' using errcode='22023'; end if;
  if p_trial_duration_days is null or p_trial_duration_days<1 or p_trial_duration_days>3650 then raise exception 'INVALID_TRIAL_DURATION' using errcode='22023'; end if;

  perform pg_advisory_xact_lock(hashtext('generator-owner-provision:'||p_client_operation_id::text)::bigint);
  select * into v_op from public.generator_owner_provisioning_operations where client_operation_id=p_client_operation_id for update;
  if not found then raise exception 'PROVISIONING_OPERATION_NOT_FOUND' using errcode='P0002'; end if;
  if v_op.actor_user_id<>p_actor_user_id then raise exception 'PROVISIONING_OPERATION_ACTOR_CONFLICT' using errcode='P0001'; end if;
  if v_op.auth_user_id is not null and v_op.auth_user_id<>p_auth_user_id then raise exception 'PROVISIONING_AUTH_USER_CONFLICT' using errcode='P0001'; end if;
  if v_op.status='completed' then return query select true,v_op.tenant_id,v_op.owner_user_id,v_op.site_id,v_op.subscription_id,true; return; end if;
  if v_op.owner_email<>lower(trim(p_owner_email)) then raise exception 'PROVISIONING_EMAIL_CONFLICT' using errcode='P0001'; end if;

  update public.generator_owner_provisioning_operations set auth_user_id=p_auth_user_id,updated_at=now() where client_operation_id=p_client_operation_id;

  if exists(select 1 from public.users where auth_user_id=p_auth_user_id and role<>'user') then raise exception 'AUTH_USER_ALREADY_MAPPED' using errcode='23505'; end if;
  if exists(select 1 from public.tenant_owner_profiles where phone=p_owner_phone) then raise exception 'OWNER_PHONE_ALREADY_PROVISIONED' using errcode='23505'; end if;
  if exists(select 1 from public.tenant_owner_profiles where email=lower(p_owner_email)) then raise exception 'OWNER_EMAIL_ALREADY_PROVISIONED' using errcode='23505'; end if;
  if exists(select 1 from public.tenants where slug=p_slug) then raise exception 'TENANT_SLUG_ALREADY_EXISTS' using errcode='23505'; end if;

  v_ends_at:=case when p_subscription_status='trial' then v_started_at+make_interval(days=>p_trial_duration_days)
    when p_ends_at is not null then p_ends_at when p_billing_cycle='yearly' then v_started_at+interval '1 year'
    else v_started_at+interval '1 month' end;

  insert into public.users(auth_user_id,name,email,login_method,role,account_status,must_change_password,temporary_password_issued_at,last_signed_in)
  values(p_auth_user_id,p_owner_name,lower(p_owner_email),'supabase','user','active',true,v_started_at,v_started_at)
  on conflict(auth_user_id) do update set name=coalesce(excluded.name,public.users.name),email=excluded.email,login_method='supabase',role='user',account_status='active',must_change_password=true,temporary_password_issued_at=v_started_at,last_signed_in=v_started_at
  returning id into v_user_id;

  insert into public.tenants(name,slug,status,plan) values(p_tenant_name,p_slug,case when p_subscription_status='cancelled' then 'suspended' else 'active' end,v_legacy_plan) returning id into v_tenant_id;
  insert into public.tenant_owner_profiles(tenant_id,owner_user_id,full_name,phone,whatsapp_number,email,company_name,identity_number_ciphertext,identity_number_iv,identity_number_last4,invited_at,claimed_at)
  values(v_tenant_id,v_user_id,p_owner_name,p_owner_phone,nullif(p_owner_whatsapp,''),lower(p_owner_email),nullif(p_company_name,''),p_identity_ciphertext,p_identity_iv,p_identity_last4,v_started_at,v_started_at);
  insert into public.sites(tenant_id,name,code,status) values(v_tenant_id,p_site_name,p_site_code,'active') returning id into v_site_id;
  insert into public.tenant_members(tenant_id,user_id,role,is_active,membership_status) values(v_tenant_id,v_user_id,'owner',true,'active');
  insert into public.staff_profiles(tenant_id,site_id,user_id,role,is_active) values(v_tenant_id,v_site_id,v_user_id,'owner',true);
  insert into public.tenant_subscriptions(tenant_id,plan,package_code,status,billing_cycle,started_at,ends_at,auto_renew,renewal_count,notes,trial_duration_days)
  values(v_tenant_id,v_legacy_plan,v_package_code,p_subscription_status,p_billing_cycle,v_started_at,v_ends_at,false,0,null,case when p_subscription_status='trial' then p_trial_duration_days else null end)
  returning id into v_subscription_id;

  insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data,metadata)
  values(v_tenant_id,v_site_id,p_actor_user_id,v_role,'tenant_subscription',v_subscription_id::text,'platform_admin_create_generator_owner_subscription',
    jsonb_build_object('tenantId',v_tenant_id,'ownerUserId',v_user_id,'plan',v_legacy_plan,'packageCode',v_package_code,'status',p_subscription_status,'trialDurationDays',case when p_subscription_status='trial' then p_trial_duration_days else null end),
    jsonb_build_object('ownerEmail',lower(p_owner_email),'ownerPhoneLast4',right(p_owner_phone,4),'clientOperationId',p_client_operation_id));

  update public.generator_owner_provisioning_operations set status='completed',tenant_id=v_tenant_id,owner_user_id=v_user_id,site_id=v_site_id,subscription_id=v_subscription_id,response=jsonb_build_object('tenantId',v_tenant_id,'ownerUserId',v_user_id,'siteId',v_site_id,'subscriptionId',v_subscription_id,'packageCode',v_package_code),updated_at=now()
  where client_operation_id=p_client_operation_id;

  return query select true,v_tenant_id,v_user_id,v_site_id,v_subscription_id,false;
end;
$$;

revoke all on function public.powerhub_admin_complete_generator_owner_provisioning(bigint,uuid,uuid,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,timestamptz,integer) from public,anon,authenticated;
grant execute on function public.powerhub_admin_complete_generator_owner_provisioning(bigint,uuid,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,timestamptz,integer) to service_role;
