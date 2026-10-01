-- Catalog-driven cleanup for remaining legacy five-package guards.
-- Keeps historical migrations immutable and updates the current production RPCs in place.
-- Package existence and activation always come from subscription_package_catalog.
CREATE OR REPLACE FUNCTION public.powerhub_admin_complete_generator_owner_provisioning(p_actor_user_id bigint, p_client_operation_id uuid, p_auth_user_id uuid, p_tenant_name text, p_slug text, p_company_name text, p_owner_name text, p_identity_ciphertext text, p_identity_iv text, p_identity_last4 text, p_owner_phone text, p_owner_whatsapp text, p_owner_email text, p_site_name text, p_site_code text, p_package_code text DEFAULT 'basic'::text, p_billing_cycle text DEFAULT 'monthly'::text, p_subscription_status text DEFAULT 'trial'::text, p_ends_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_trial_duration_days integer DEFAULT 8)
 RETURNS TABLE(success boolean, tenant_id bigint, owner_user_id bigint, site_id bigint, subscription_id bigint, replayed boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
 v_role text;
 v_op public.generator_owner_provisioning_operations%rowtype;
 v_started_at timestamptz:=now();
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

 v_ends_at:=case
   when p_subscription_status='trial' then v_started_at+make_interval(days=>p_trial_duration_days)
   when p_ends_at is not null then p_ends_at
   when p_billing_cycle='yearly' then v_started_at+interval '1 year'
   else v_started_at+interval '1 month'
 end;

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
   auto_renew,renewal_count,notes,trial_duration_days
 )
 values(
   v_tenant_id,v_package_code,p_subscription_status,p_billing_cycle,
   v_started_at,v_ends_at,false,0,null,
   case when p_subscription_status='trial' then p_trial_duration_days else null end
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
     'trialDurationDays',case when p_subscription_status='trial' then p_trial_duration_days else null end
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
$function$


revoke all on function public.powerhub_admin_complete_generator_owner_provisioning(bigint,uuid,uuid,text,text,text,text,text,text,text,text,text,text,text,text,text,text,timestamptz,integer) from public,anon,authenticated;
grant execute on function public.powerhub_admin_complete_generator_owner_provisioning(bigint,uuid,uuid,text,text,text,text,text,text,text,text,text,text,text,text,text,text,timestamptz,integer) to service_role;

CREATE OR REPLACE FUNCTION public.powerhub_admin_quick_upgrade_owner_plan_idempotent(p_actor_user_id bigint, p_tenant_id bigint, p_package_code text, p_note text, p_client_operation_id text)
 RETURNS TABLE(success boolean, package_code text, replayed boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor_platform_role text;
  v_subscription public.tenant_subscriptions%rowtype;
  v_package_code text;
  v_site_id bigint;
  v_current_rank int;
  v_requested_rank int;
  v_op public.offline_sync_operations%rowtype;
begin
  if nullif(trim(p_client_operation_id),'') is null then
    raise exception 'CLIENT_OPERATION_REQUIRED' using errcode='P0001';
  end if;

  select platform_role
    into v_actor_platform_role
  from public.users
  where id=p_actor_user_id
    and role='admin'
    and account_status='active'
    and platform_role in('platform_owner','platform_admin');

  if v_actor_platform_role is null then
    raise exception 'FORBIDDEN_PLATFORM_ROLE' using errcode='42501';
  end if;

  v_package_code:=lower(nullif(btrim(p_package_code),''));
  perform public.powerhub_validate_package_code(v_package_code);

  perform pg_advisory_xact_lock(hashtext('subscription-quick-upgrade:'||p_tenant_id::text)::bigint);

  select * into v_op
  from public.offline_sync_operations
  where user_id=p_actor_user_id
    and client_operation_id=trim(p_client_operation_id)
  for update;

  if found then
    if v_op.operation_type<>'subscription_quick_upgrade'
       or v_op.tenant_id<>p_tenant_id
       or v_op.response->>'packageCode'<>v_package_code
       or coalesce(v_op.response->>'note','')<>coalesce(p_note,'')
    then
      raise exception 'SUBSCRIPTION_QUICK_UPGRADE_OPERATION_CONFLICT' using errcode='P0001';
    end if;

    return query select true,v_package_code,true;
    return;
  end if;

  select * into v_subscription
  from public.tenant_subscriptions
  where tenant_id=p_tenant_id
  order by created_at desc,id desc
  limit 1
  for update;

  if not found then
    raise exception 'SUBSCRIPTION_NOT_FOUND' using errcode='P0002';
  end if;

  select s.id into v_site_id
  from public.sites s
  where s.tenant_id=p_tenant_id
  order by s.id
  limit 1;

  if v_site_id is null then
    raise exception 'SITE_NOT_FOUND' using errcode='P0002';
  end if;

  select ordinality
    into v_current_rank
  from public.platform_settings ps
  cross join lateral jsonb_array_elements(coalesce(ps.value->'packages','[]'::jsonb)) with ordinality pkg
  where ps.setting_key='subscription_package_catalog'
    and ps.is_enabled=true
    and lower(trim(pkg->>'code'))=lower(trim(v_subscription.package_code))
    and coalesce((pkg->>'active')::boolean,true)=true
  limit 1;

  select ordinality
    into v_requested_rank
  from public.platform_settings ps
  cross join lateral jsonb_array_elements(coalesce(ps.value->'packages','[]'::jsonb)) with ordinality pkg
  where ps.setting_key='subscription_package_catalog'
    and ps.is_enabled=true
    and lower(trim(pkg->>'code'))=lower(trim(v_package_code))
    and coalesce((pkg->>'active')::boolean,true)=true
  limit 1;

  if v_current_rank is null then
    raise exception 'SUBSCRIPTION_PACKAGE_INVALID' using errcode='P0001';
  end if;

  if v_requested_rank<=v_current_rank then
    raise exception 'PACKAGE_NOT_UPGRADE' using errcode='22023';
  end if;

  update public.tenant_subscriptions
  set package_code=v_package_code,
      updated_at=now()
  where id=v_subscription.id;

  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,
    entity_type,entity_id,action,after_data
  )
  values(
    p_tenant_id,v_site_id,p_actor_user_id,v_actor_platform_role,
    'tenant_subscription',v_subscription.id::text,
    'platform_admin_quick_upgrade_owner_package',
    jsonb_build_object(
      'fromPackageCode',v_subscription.package_code,
      'toPackageCode',v_package_code,
      'note',p_note
    )
  );

  insert into public.offline_sync_operations(
    tenant_id,site_id,user_id,client_operation_id,
    operation_type,entity_type,entity_id,response
  )
  values(
    p_tenant_id,v_site_id,p_actor_user_id,trim(p_client_operation_id),
    'subscription_quick_upgrade','tenant_subscription',v_subscription.id,
    jsonb_build_object('packageCode',v_package_code,'note',coalesce(p_note,''))
  );

  return query select true,v_package_code,false;
end;
$function$


revoke all on function public.powerhub_admin_quick_upgrade_owner_plan_idempotent(bigint,bigint,text,text,text) from public,anon,authenticated;
grant execute on function public.powerhub_admin_quick_upgrade_owner_plan_idempotent(bigint,bigint,text,text,text) to service_role;

CREATE OR REPLACE FUNCTION public.powerhub_admin_review_subscription_upgrade_request(p_actor_user_id bigint, p_request_id bigint, p_decision text, p_note text DEFAULT NULL::text)
 RETURNS TABLE(success boolean, package_code text, replayed boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor_platform_role text;
  v_request public.subscription_upgrade_requests%rowtype;
  v_subscription public.tenant_subscriptions%rowtype;
  v_site_id bigint;
  v_current_rank integer;
  v_requested_rank integer;
begin
  select platform_role
    into v_actor_platform_role
  from public.users
  where id=p_actor_user_id
    and role='admin'
    and account_status='active'
    and platform_role in('platform_owner','platform_admin');

  if v_actor_platform_role is null then
    raise exception 'FORBIDDEN_PLATFORM_ROLE' using errcode='42501';
  end if;

  if p_decision not in('approved','rejected') then
    raise exception 'INVALID_DECISION' using errcode='22023';
  end if;

  select *
    into v_request
  from public.subscription_upgrade_requests
  where id=p_request_id
  for update;

  if not found then
    raise exception 'REQUEST_NOT_FOUND' using errcode='P0002';
  end if;

  if v_request.status not in('pending','reviewing') then
    if (p_decision='approved' and v_request.status='approved')
       or (p_decision='rejected' and v_request.status='rejected')
    then
      return query
        select true,
          case when p_decision='approved' then v_request.requested_package_code else v_request.current_package_code end,
          true;
      return;
    end if;
    raise exception 'REQUEST_ALREADY_PROCESSED' using errcode='P0001';
  end if;

  select s.id
    into v_site_id
  from public.sites s
  where s.tenant_id=v_request.tenant_id
    and s.status<>'archived'
  order by s.id
  limit 1;

  if v_site_id is null then
    raise exception 'SITE_NOT_FOUND' using errcode='P0002';
  end if;

  select *
    into v_subscription
  from public.tenant_subscriptions
  where tenant_id=v_request.tenant_id
  order by
    case when status in('active','trial') then 0 else 1 end,
    ends_at desc nulls last,
    id desc
  limit 1
  for update;

  if not found then
    raise exception 'SUBSCRIPTION_NOT_FOUND' using errcode='P0002';
  end if;

  if p_decision='approved' then
    perform public.powerhub_validate_package_code(v_subscription.package_code);
    perform public.powerhub_validate_package_code(v_request.requested_package_code);

    select ordinality
      into v_current_rank
    from public.platform_settings ps
    cross join lateral jsonb_array_elements(coalesce(ps.value->'packages','[]'::jsonb)) with ordinality pkg
    where ps.setting_key='subscription_package_catalog'
      and ps.is_enabled=true
      and lower(trim(pkg->>'code'))=lower(trim(v_subscription.package_code))
      and coalesce((pkg->>'active')::boolean,true)=true
    limit 1;

    select ordinality
      into v_requested_rank
    from public.platform_settings ps
    cross join lateral jsonb_array_elements(coalesce(ps.value->'packages','[]'::jsonb)) with ordinality pkg
    where ps.setting_key='subscription_package_catalog'
      and ps.is_enabled=true
      and lower(trim(pkg->>'code'))=lower(trim(v_request.requested_package_code))
      and coalesce((pkg->>'active')::boolean,true)=true
    limit 1;

    if v_requested_rank is null or v_current_rank is null or v_requested_rank<=v_current_rank then
      raise exception 'REQUESTED_PACKAGE_NO_LONGER_UPGRADE' using errcode='P0001';
    end if;
  end if;

  update public.subscription_upgrade_requests
  set status=p_decision,
      note=p_note,
      reviewed_by_user_id=p_actor_user_id,
      reviewed_at=now(),
      updated_at=now()
  where id=v_request.id;

  if p_decision='approved' then
    update public.tenant_subscriptions
    set package_code=v_request.requested_package_code,
        updated_at=now()
    where id=v_subscription.id;

    update public.tenants
    set package_code=v_request.requested_package_code,
        updated_at=now()
    where id=v_request.tenant_id;

    insert into public.audit_logs(
      tenant_id,site_id,user_id,actor_platform_role,
      entity_type,entity_id,action,before_data,after_data
    )
    values(
      v_request.tenant_id,v_site_id,p_actor_user_id,v_actor_platform_role,
      'tenant_subscription',v_subscription.id::text,
      'platform_admin_approved_subscription_upgrade',
      jsonb_build_object('packageCode',v_subscription.package_code),
      jsonb_build_object('packageCode',v_request.requested_package_code,'requestId',v_request.id)
    );
  else
    insert into public.audit_logs(
      tenant_id,site_id,user_id,actor_platform_role,
      entity_type,entity_id,action,before_data,after_data
    )
    values(
      v_request.tenant_id,v_site_id,p_actor_user_id,v_actor_platform_role,
      'subscription_upgrade_request',v_request.id::text,
      'platform_admin_rejected_subscription_upgrade',
      jsonb_build_object('requestedPackageCode',v_request.requested_package_code,'currentPackageCode',v_request.current_package_code),
      jsonb_build_object('decision','rejected','note',p_note)
    );
  end if;

  return query
    select true,
      case when p_decision='approved' then v_request.requested_package_code else v_request.current_package_code end,
      false;
end;
$function$


revoke all on function public.powerhub_admin_review_subscription_upgrade_request(bigint,bigint,text,text) from public,anon,authenticated;
grant execute on function public.powerhub_admin_review_subscription_upgrade_request(bigint,bigint,text,text) to service_role;

CREATE OR REPLACE FUNCTION public.powerhub_assign_existing_staff(p_tenant_id bigint, p_site_id bigint, p_actor_user_id bigint, p_target_user_id bigint, p_role text, p_all_branches boolean)
 RETURNS TABLE(profile_id bigint, target_user_id bigint)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$ declare v_actor_role text; v_actor_platform_role text; v_actor_tenant_role text; v_existing_member_role text; v_existing_member_active boolean; v_existing_membership_status text; v_target_membership_role text; v_target_site_id bigint; v_plan text; v_policy_enabled boolean; v_roles_policy jsonb; v_platform_policy record; v_field_policy record; v_already_active_subaccount boolean:=false; v_before_member jsonb; v_before_profiles jsonb; v_profile_id bigint; v_current_count integer; begin if p_role not in ('owner','manager','accountant','collector','technician','viewer') then raise exception 'INVALID_STAFF_ROLE'; end if; if not exists(select 1 from public.sites where id=p_site_id and tenant_id=p_tenant_id) then raise exception 'SITE_OUT_OF_SCOPE'; end if; select role,platform_role into v_actor_role,v_actor_platform_role from public.users where id=p_actor_user_id; if not found then raise exception 'ACTOR_NOT_FOUND'; end if; if not exists(select 1 from public.users where id=p_target_user_id) then raise exception 'TARGET_USER_NOT_FOUND'; end if; if v_actor_role<>'admin' then select role into v_actor_tenant_role from public.tenant_members where tenant_id=p_tenant_id and user_id=p_actor_user_id and is_active=true and membership_status='active'; if v_actor_tenant_role<>'owner' then raise exception 'STAFF_ASSIGNMENT_FORBIDDEN'; end if; else v_actor_tenant_role:='platform_admin'; end if; perform pg_advisory_xact_lock(hashtextextended('staff-assignment:'||p_tenant_id::text,0)); select to_jsonb(member),member.role,member.is_active,member.membership_status into v_before_member,v_existing_member_role,v_existing_member_active,v_existing_membership_status from public.tenant_members member where member.tenant_id=p_tenant_id and member.user_id=p_target_user_id for update; v_already_active_subaccount:=found and v_existing_member_role='member' and v_existing_member_active=true and v_existing_membership_status='active'; v_target_membership_role:=case when found and v_existing_member_role='owner' then 'owner' else 'member' end; v_target_site_id:=case when p_all_branches then null else p_site_id end; select coalesce(jsonb_agg(to_jsonb(profile)),'[]'::jsonb) into v_before_profiles from public.staff_profiles profile where profile.tenant_id=p_tenant_id and profile.user_id=p_target_user_id and (profile.site_id=p_site_id or(p_all_branches and profile.site_id is null)); select package_code into v_plan from public.tenant_subscriptions where tenant_id=p_tenant_id order by created_at desc limit 1; if v_plan is null then raise exception 'TENANT_PACKAGE_NOT_FOUND'; end if;
 perform public.powerhub_validate_package_code(v_plan); select is_enabled,value into v_policy_enabled,v_roles_policy from public.platform_settings where setting_key='owner_subaccount_roles'; if v_actor_role<>'admin' then if v_policy_enabled=false or p_role='owner' then raise exception 'SUBACCOUNT_ROLE_NOT_ALLOWED'; end if; if jsonb_typeof(v_roles_policy->'allowedRoles')='array' and not(v_roles_policy->'allowedRoles'?p_role) then raise exception 'SUBACCOUNT_ROLE_NOT_ALLOWED'; end if; end if; select * into v_platform_policy from public.powerhub_resolve_tenant_feature_policy(p_tenant_id,'platform_users'); if not coalesce(v_platform_policy.eligible,false) or not coalesce(v_platform_policy.enabled,false) then raise exception 'PLATFORM_USERS_FEATURE_DISABLED'; end if; if p_role='technician' then select * into v_field_policy from public.powerhub_resolve_tenant_feature_policy(p_tenant_id,'field_users'); if not coalesce(v_field_policy.eligible,false) or not coalesce(v_field_policy.enabled,false) then raise exception 'FIELD_USERS_FEATURE_DISABLED'; end if; end if; if not v_already_active_subaccount and v_platform_policy.effective_limit is not null then select count(*)::integer into v_current_count from public.tenant_members where tenant_id=p_tenant_id and role='member' and is_active=true and membership_status='active'; if v_current_count>=v_platform_policy.effective_limit then raise exception 'SUBACCOUNT_LIMIT_REACHED'; end if; end if; insert into public.tenant_members(tenant_id,user_id,role,is_active,membership_status,expires_at,invited_by_user_id) values(p_tenant_id,p_target_user_id,v_target_membership_role,true,'active',null,p_actor_user_id) on conflict(tenant_id,user_id) do update set role=excluded.role,is_active=true,membership_status='active',expires_at=null,updated_at=now(); update public.staff_profiles set is_active=false,updated_at=now() where tenant_id=p_tenant_id and user_id=p_target_user_id and (site_id=p_site_id or(p_all_branches and site_id is null)); insert into public.staff_profiles(tenant_id,site_id,user_id,role,is_active) values(p_tenant_id,v_target_site_id,p_target_user_id,p_role,true) on conflict(user_id,site_id,role) do update set is_active=true,updated_at=now() returning id into v_profile_id; insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,actor_tenant_role,entity_type,entity_id,action,before_data,after_data) values(p_tenant_id,p_site_id,p_actor_user_id,v_actor_platform_role,v_actor_tenant_role,'staff_profile',v_profile_id::text,'assign_role',jsonb_build_object('membership',v_before_member,'profiles',v_before_profiles),jsonb_build_object('targetUserId',p_target_user_id,'role',p_role,'allBranches',p_all_branches,'assignedSiteId',v_target_site_id,'membershipRole',v_target_membership_role)); return query select v_profile_id,p_target_user_id; end; $function$


revoke all on function public.powerhub_assign_existing_staff(bigint,bigint,bigint,bigint,text,boolean) from public,anon,authenticated;
grant execute on function public.powerhub_assign_existing_staff(bigint,bigint,bigint,bigint,text,boolean) to service_role;
