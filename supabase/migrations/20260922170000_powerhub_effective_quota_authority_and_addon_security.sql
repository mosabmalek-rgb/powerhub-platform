
-- Corrective quota authority: package base + admin override + active, time-bounded add-ons.
create or replace function public.powerhub_effective_tenant_quota(
  p_tenant_id bigint,
  p_resource text,
  p_at timestamptz default now()
)
returns integer
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  v_package_code text;
  v_catalog jsonb;
  v_base integer:=0;
  v_override integer;
  v_delta integer:=0;
  v_overrides jsonb;
  v_branch_override integer;
begin
  if p_resource not in ('subscribers','platformUser','fieldUser','branch') then
    raise exception 'INVALID_QUOTA_RESOURCE' using errcode='P0001';
  end if;

  select coalesce(ts.package_code,t.package_code) into v_package_code
  from public.tenants t left join public.tenant_subscriptions ts on ts.tenant_id=t.id
  where t.id=p_tenant_id;

  select p
  into v_catalog
  from jsonb_array_elements(coalesce((select value->'packages' from public.platform_settings where setting_key='subscription_package_catalog' and is_enabled=true),'[]'::jsonb)) p
  where p->>'code'=v_package_code and coalesce((p->>'active')::boolean,true)=true
  limit 1;

  v_base:=case p_resource
    when 'subscribers' then coalesce((v_catalog->>'includedSubscribers')::integer,0)
    when 'platformUser' then coalesce((v_catalog->>'platformUsers')::integer,0)
    when 'fieldUser' then coalesce((v_catalog->>'fieldUsers')::integer,0)
    when 'branch' then coalesce((v_catalog->>'branches')::integer,0)
  end;

  select coalesce(value->'overrides'->p_tenant_id::text,'{}'::jsonb) into v_overrides
  from public.platform_settings where setting_key='owner_limit_overrides';

  if p_resource='subscribers' then
    v_override:=case when (v_overrides->>'subscriberLimit')~'^\d+$' then (v_overrides->>'subscriberLimit')::integer end;
  elsif p_resource='platformUser' then
    v_override:=case when (v_overrides->>'subaccountLimit')~'^\d+$' then (v_overrides->>'subaccountLimit')::integer end;
  elsif p_resource='fieldUser' then
    v_override:=case when (v_overrides->>'fieldUserLimit')~'^\d+$' then (v_overrides->>'fieldUserLimit')::integer end;
  else
    v_override:=case when (v_overrides->>'branchLimit')~'^\d+$' then (v_overrides->>'branchLimit')::integer end;
  end if;

  v_base:=greatest(0,coalesce(v_override,v_base));

  select coalesce(sum(quantity * case when addon_code='subscribers50' and p_resource='subscribers' then 50 else 1 end),0)::integer
  into v_delta
  from public.tenant_addon_requests
  where tenant_id=p_tenant_id and status='approved'
    and addon_code=case p_resource when 'subscribers' then 'subscribers50' when 'platformUser' then 'platformUser' when 'fieldUser' then 'fieldUser' when 'branch' then 'branch' end
    and (starts_at is null or starts_at<=p_at)
    and (ends_at is null or ends_at>p_at);

  return v_base + coalesce(v_delta,0);
end;
$$;

revoke all on function public.powerhub_effective_tenant_quota(bigint,text,timestamptz) from public,anon,authenticated;
grant execute on function public.powerhub_effective_tenant_quota(bigint,text,timestamptz) to service_role;

-- Secure owner addon requests.
create or replace function public.powerhub_request_tenant_addon(
 p_tenant_id bigint,p_site_id bigint,p_user_id bigint,p_addon_code text,p_quantity integer default 1,p_note text default null
)
returns table(request_id bigint,addon_code text,quantity integer,already_requested boolean)
language plpgsql security invoker set search_path=public,pg_temp
as $$
declare v_existing_id bigint; v_existing_qty integer;
begin
 if p_addon_code not in ('fieldUser','platformUser','subscribers50','branch','sms') then raise exception 'INVALID_ADDON_CODE' using errcode='P0001'; end if;
 if p_quantity is null or p_quantity<1 or p_quantity>1000 then raise exception 'INVALID_ADDON_QUANTITY' using errcode='P0001'; end if;
 if not exists(select 1 from public.tenant_members where tenant_id=p_tenant_id and user_id=p_user_id and role='owner' and is_active=true and membership_status='active') then
   raise exception 'ADDON_REQUEST_OWNER_ONLY' using errcode='42501';
 end if;
 if p_site_id is not null and not exists(select 1 from public.sites where id=p_site_id and tenant_id=p_tenant_id and status<>'archived') then raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001'; end if;
 select id,quantity into v_existing_id,v_existing_qty from public.tenant_addon_requests where tenant_id=p_tenant_id and addon_code=p_addon_code and status in ('pending','reviewing') order by created_at desc limit 1 for update;
 if found then return query select v_existing_id,p_addon_code,v_existing_qty,true; return; end if;
 insert into public.tenant_addon_requests(tenant_id,site_id,requested_by_user_id,addon_code,quantity,note) values(p_tenant_id,p_site_id,p_user_id,p_addon_code,p_quantity,p_note) returning id into v_existing_id;
 insert into public.audit_logs(tenant_id,site_id,user_id,entity_type,entity_id,action,after_data)
 values(p_tenant_id,p_site_id,p_user_id,'tenant_addon_request',v_existing_id::text,'request_addon',jsonb_build_object('addonCode',p_addon_code,'quantity',p_quantity,'note',p_note));
 return query select v_existing_id,p_addon_code,p_quantity,false;
end;
$$;

revoke all on function public.powerhub_request_tenant_addon(bigint,bigint,bigint,text,integer,text) from public,anon,authenticated;
grant execute on function public.powerhub_request_tenant_addon(bigint,bigint,bigint,text,integer,text) to service_role;

-- Secure timed addon approval; approval never writes a permanent quota override.
drop function if exists public.powerhub_admin_review_tenant_addon_request(bigint,bigint,text,text);
drop function if exists public.powerhub_admin_review_tenant_addon_request(bigint,bigint,text,text,integer);
create function public.powerhub_admin_review_tenant_addon_request(
 p_actor_user_id bigint,p_request_id bigint,p_decision text,p_note text default null,p_duration_days integer default null
)
returns table(success boolean,status text,ends_at timestamptz)
language plpgsql security definer set search_path=public,pg_temp
as $$
declare r public.tenant_addon_requests%rowtype; v_days int; v_start timestamptz; v_end timestamptz; v_actor_platform_role text;
begin
 select platform_role into v_actor_platform_role from public.users where id=p_actor_user_id and role='admin' and account_status='active' and platform_role in ('platform_owner','platform_admin');
 if v_actor_platform_role is null then raise exception 'FORBIDDEN_PLATFORM_ROLE' using errcode='42501'; end if;
 if p_decision not in ('approved','rejected') then raise exception 'INVALID_DECISION' using errcode='P0001'; end if;
 select * into r from public.tenant_addon_requests where id=p_request_id for update;
 if not found then raise exception 'ADDON_REQUEST_NOT_FOUND' using errcode='P0001'; end if;
 if r.status not in ('pending','reviewing') then raise exception 'ADDON_REQUEST_NOT_PENDING' using errcode='P0001'; end if;
 if p_decision='rejected' then
   update public.tenant_addon_requests set status='rejected',reviewed_at=now(),reviewed_by_user_id=p_actor_user_id,review_note=p_note where id=r.id;
   return query select true,'rejected',null::timestamptz; return;
 end if;
 v_days:=coalesce(p_duration_days,r.duration_days,30);
 if v_days<1 or v_days>3650 then raise exception 'INVALID_ADDON_DURATION' using errcode='P0001'; end if;
 v_start:=now(); v_end:=v_start+make_interval(days=>v_days);
 update public.tenant_addon_requests set status='approved',duration_days=v_days,starts_at=v_start,ends_at=v_end,reviewed_at=now(),reviewed_by_user_id=p_actor_user_id,review_note=p_note where id=r.id;
 insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data)
 values(r.tenant_id,r.site_id,p_actor_user_id,v_actor_platform_role,'tenant_addon_request',r.id::text,'approve_addon',jsonb_build_object('addonCode',r.addon_code,'quantity',r.quantity,'durationDays',v_days,'startsAt',v_start,'endsAt',v_end));
 return query select true,'approved',v_end;
end;
$$;
revoke all on function public.powerhub_admin_review_tenant_addon_request(bigint,bigint,text,text,integer) from public,anon,authenticated;
grant execute on function public.powerhub_admin_review_tenant_addon_request(bigint,bigint,text,text,integer) to service_role;

-- Secure and simplify renewal; every renewal decision is checked against the actor and tenant.
create or replace function public.powerhub_admin_renew_subscription_with_addons(
 p_actor_user_id bigint,p_subscription_id bigint,p_new_ends_at timestamptz,p_addon_decisions jsonb default '[]'::jsonb
)
returns table(success boolean,ends_at timestamptz,renewed_addons integer,expired_addons integer)
language plpgsql security definer set search_path=public,pg_temp
as $$
declare s public.tenant_subscriptions%rowtype; d jsonb; a public.tenant_addon_requests%rowtype; v_renewed int:=0;v_expired int:=0;v_duration int;v_new_end timestamptz; v_actor_platform_role text;
begin
 select platform_role into v_actor_platform_role from public.users where id=p_actor_user_id and role='admin' and account_status='active' and platform_role in ('platform_owner','platform_admin');
 if v_actor_platform_role is null then raise exception 'FORBIDDEN_PLATFORM_ROLE' using errcode='42501'; end if;
 select * into s from public.tenant_subscriptions where id=p_subscription_id for update;
 if not found then raise exception 'SUBSCRIPTION_NOT_FOUND' using errcode='P0001'; end if;
 if p_new_ends_at<=now() then raise exception 'INVALID_RENEWAL_END_DATE' using errcode='P0001'; end if;
 update public.tenant_subscriptions set ends_at=p_new_ends_at,status='active',renewal_count=renewal_count+1,last_renewed_at=now(),updated_at=now() where id=s.id;
 for d in select * from jsonb_array_elements(coalesce(p_addon_decisions,'[]'::jsonb)) loop
   select * into a from public.tenant_addon_requests where id=(d->>'addonRequestId')::bigint and tenant_id=s.tenant_id for update;
   if not found or a.status<>'approved' then continue; end if;
   if coalesce(d->>'decision','expire')='renew' then
     v_duration:=coalesce(nullif(d->>'durationDays','')::int,a.duration_days,30);
     if v_duration<1 or v_duration>3650 then raise exception 'INVALID_ADDON_DURATION' using errcode='P0001'; end if;
     v_new_end:=p_new_ends_at+make_interval(days=>v_duration);
     update public.tenant_addon_requests set ends_at=v_new_end,duration_days=v_duration where id=a.id;
     insert into public.tenant_addon_renewal_decisions(tenant_id,subscription_id,addon_request_id,decision,new_duration_days,created_by_user_id)
     values(s.tenant_id,s.id,a.id,'renew',v_duration,p_actor_user_id)
     on conflict(subscription_id,addon_request_id) do update set decision='renew',new_duration_days=excluded.new_duration_days,created_by_user_id=excluded.created_by_user_id,created_at=now();
     v_renewed:=v_renewed+1;
   else
     update public.tenant_addon_requests set ends_at=least(coalesce(ends_at,now()),now()) where id=a.id;
     insert into public.tenant_addon_renewal_decisions(tenant_id,subscription_id,addon_request_id,decision,created_by_user_id)
     values(s.tenant_id,s.id,a.id,'expire',p_actor_user_id)
     on conflict(subscription_id,addon_request_id) do update set decision='expire',new_duration_days=null,created_by_user_id=excluded.created_by_user_id,created_at=now();
     v_expired:=v_expired+1;
   end if;
 end loop;
 insert into public.audit_logs(tenant_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data)
 values(s.tenant_id,p_actor_user_id,v_actor_platform_role,'tenant_subscription',s.id::text,'renew_subscription_with_addons',jsonb_build_object('newEndsAt',p_new_ends_at,'renewedAddons',v_renewed,'expiredAddons',v_expired));
 return query select true,p_new_ends_at,v_renewed,v_expired;
end;
$$;
revoke all on function public.powerhub_admin_renew_subscription_with_addons(bigint,bigint,timestamptz,jsonb) from public,anon,authenticated;
grant execute on function public.powerhub_admin_renew_subscription_with_addons(bigint,bigint,timestamptz,jsonb) to service_role;

-- Remove direct client access to timed addon tables; all mutations/read models go through service-role RPCs.
alter table public.tenant_addon_requests enable row level security;
alter table public.tenant_addon_renewal_decisions enable row level security;
revoke all on table public.tenant_addon_requests from anon,authenticated;
revoke all on table public.tenant_addon_renewal_decisions from anon,authenticated;


create or replace function public.powerhub_assign_existing_staff(p_tenant_id bigint,p_site_id bigint,p_actor_user_id bigint,p_target_user_id bigint,p_role text,p_all_branches boolean)
returns table(profile_id bigint,target_user_id bigint) language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_actor_role text; v_actor_platform_role text; v_actor_tenant_role text; v_existing_member_role text; v_existing_member_active boolean; v_existing_membership_status text; v_target_membership_role text; v_target_site_id bigint; v_package_code text; v_policy_enabled boolean; v_roles_policy jsonb; v_limits_policy jsonb; v_overrides_policy jsonb; v_override jsonb; v_limit_text text; v_override_limit_text text; v_limit integer; v_current_count integer; v_already_active_subaccount boolean:=false; v_before_member jsonb; v_before_profiles jsonb; v_profile_id bigint;
begin
  if p_role not in ('owner','manager','accountant','collector','technician','viewer') then raise exception 'INVALID_STAFF_ROLE' using errcode='P0001'; end if;
  if not exists(select 1 from public.sites where id=p_site_id and tenant_id=p_tenant_id) then raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001'; end if;
  select role,platform_role into v_actor_role,v_actor_platform_role from public.users where id=p_actor_user_id;
  if not found then raise exception 'ACTOR_NOT_FOUND' using errcode='P0001'; end if;
  if not exists(select 1 from public.users where id=p_target_user_id) then raise exception 'TARGET_USER_NOT_FOUND' using errcode='P0001'; end if;
  if v_actor_role<>'admin' then select role into v_actor_tenant_role from public.tenant_members where tenant_id=p_tenant_id and user_id=p_actor_user_id and is_active=true and membership_status='active'; if v_actor_tenant_role<>'owner' then raise exception 'STAFF_ASSIGNMENT_FORBIDDEN' using errcode='P0001'; end if; else v_actor_tenant_role:='platform_admin'; end if;
  perform pg_advisory_xact_lock(p_tenant_id,hashtext('staff-assignment'));
  select to_jsonb(member),member.role,member.is_active,member.membership_status into v_before_member,v_existing_member_role,v_existing_member_active,v_existing_membership_status from public.tenant_members member where member.tenant_id=p_tenant_id and member.user_id=p_target_user_id for update;
  v_already_active_subaccount:=found and v_existing_member_role='member' and v_existing_member_active=true and v_existing_membership_status='active';
  v_target_membership_role:=case when found and v_existing_member_role='owner' then 'owner' else 'member' end;
  v_target_site_id:=case when p_all_branches then null else p_site_id end;
  select coalesce(jsonb_agg(to_jsonb(profile)),'[]'::jsonb) into v_before_profiles from public.staff_profiles profile where profile.tenant_id=p_tenant_id and profile.user_id=p_target_user_id and (profile.site_id=p_site_id or (p_all_branches and profile.site_id is null));
  select coalesce(ts.package_code,t.package_code) into v_package_code from public.tenants t left join public.tenant_subscriptions ts on ts.tenant_id=t.id where t.id=p_tenant_id;
  if v_package_code not in ('basic','advanced','professional','business','vip') then raise exception 'TENANT_PACKAGE_NOT_FOUND' using errcode='P0001'; end if;
  select is_enabled,value into v_policy_enabled,v_roles_policy from public.platform_settings where setting_key='owner_subaccount_roles';
  select value into v_limits_policy from public.platform_settings where setting_key='owner_subaccount_limits';
  select value into v_overrides_policy from public.platform_settings where setting_key='owner_limit_overrides';
  v_override:=case when jsonb_typeof(v_overrides_policy->'overrides')='object' then v_overrides_policy->'overrides'->p_tenant_id::text else null end;
  if v_actor_role<>'admin' then
    if v_policy_enabled=false then raise exception 'SUBACCOUNT_ROLE_NOT_ALLOWED' using errcode='P0001'; end if;
    if p_role='owner' then raise exception 'SUBACCOUNT_ROLE_NOT_ALLOWED' using errcode='P0001'; end if;
    if jsonb_typeof(v_roles_policy->'allowedRoles')='array' and not (v_roles_policy->'allowedRoles' ? p_role) then raise exception 'SUBACCOUNT_ROLE_NOT_ALLOWED' using errcode='P0001'; end if;
    if jsonb_typeof(v_override->'allowedRoles')='array' and not (v_override->'allowedRoles' ? p_role) then raise exception 'SUBACCOUNT_ROLE_NOT_ALLOWED' using errcode='P0001'; end if;
  end if;
  if p_role in ('manager','accountant','collector','viewer') then
    v_limit:=public.powerhub_effective_tenant_quota(p_tenant_id,'platformUser');
    select count(*)::integer into v_current_count from public.tenant_members where tenant_id=p_tenant_id and role='member' and is_active=true and membership_status='active'
      and exists (select 1 from public.staff_profiles sp where sp.tenant_id=p_tenant_id and sp.user_id=tenant_members.user_id and sp.role in ('manager','accountant','collector','viewer') and sp.is_active=true);
    if not v_already_active_subaccount and v_current_count>=v_limit then raise exception 'SUBACCOUNT_LIMIT_REACHED' using errcode='P0001'; end if;
  elsif p_role='technician' then
    v_limit:=public.powerhub_effective_tenant_quota(p_tenant_id,'fieldUser');
  end if;
  insert into public.tenant_members(tenant_id,user_id,role,is_active,membership_status,expires_at,invited_by_user_id) values(p_tenant_id,p_target_user_id,v_target_membership_role,true,'active',null,p_actor_user_id) on conflict(tenant_id,user_id) do update set role=excluded.role,is_active=true,membership_status='active',expires_at=null,updated_at=now();
  update public.staff_profiles set is_active=false,updated_at=now() where tenant_id=p_tenant_id and user_id=p_target_user_id and (site_id=p_site_id or (p_all_branches and site_id is null));
  insert into public.staff_profiles(tenant_id,site_id,user_id,role,is_active) values(p_tenant_id,v_target_site_id,p_target_user_id,p_role,true) on conflict(user_id,site_id,role) do update set is_active=true,updated_at=now() returning id into v_profile_id;
  insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,actor_tenant_role,entity_type,entity_id,action,before_data,after_data) values(p_tenant_id,p_site_id,p_actor_user_id,v_actor_platform_role,v_actor_tenant_role,'staff_profile',v_profile_id::text,'assign_role',jsonb_build_object('membership',v_before_member,'profiles',v_before_profiles),jsonb_build_object('targetUserId',p_target_user_id,'role',p_role,'allBranches',p_all_branches,'assignedSiteId',v_target_site_id,'membershipRole',v_target_membership_role));
  return query select v_profile_id,p_target_user_id;
end; $$;
create or replace function public.powerhub_create_subscriber(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_full_name text,
  p_phone text,
  p_whatsapp_number text,
  p_address text,
  p_subscription_type text,
  p_client_operation_id uuid,
  p_quota_limit integer
)
returns table (subscriber_id bigint, subscriber_no text, replayed boolean)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_subscriber_id bigint;
  v_subscriber_no text;
  v_response jsonb;
  v_platform_role text;
  v_current_count integer;
  v_effective_limit integer;
begin
  if p_client_operation_id is not null then
    select response into v_response
    from public.offline_sync_operations
    where user_id = p_user_id and client_operation_id = p_client_operation_id::text
    limit 1;
    if found then
      if coalesce(v_response->>'id', '') = '' or coalesce(v_response->>'subscriberNo', '') = '' then
        raise exception 'INVALID_SUBSCRIBER_OPERATION_REPLAY' using errcode = 'P0001';
      end if;
      return query select (v_response->>'id')::bigint, v_response->>'subscriberNo', true;
      return;
    end if;
  end if;

  perform pg_advisory_xact_lock(p_tenant_id);

  if not exists (select 1 from public.sites where id = p_site_id and tenant_id = p_tenant_id) then
    raise exception 'SITE_OUT_OF_SCOPE' using errcode = 'P0001';
  end if;

  if p_full_name is null or length(trim(p_full_name)) < 2 then
    raise exception 'INVALID_SUBSCRIBER_NAME' using errcode = 'P0001';
  end if;
  if p_phone is null or length(trim(p_phone)) < 5 then
    raise exception 'INVALID_SUBSCRIBER_PHONE' using errcode = 'P0001';
  end if;

  if p_client_operation_id is not null then
    select id, subscriber_no into v_subscriber_id, v_subscriber_no
    from public.subscribers
    where client_operation_id = p_client_operation_id::text
    limit 1;
    if found then
      return query select v_subscriber_id, v_subscriber_no, true;
      return;
    end if;
  end if;

  select count(*)::integer into v_current_count
  from public.subscribers
  where tenant_id = p_tenant_id;
  v_effective_limit := public.powerhub_effective_tenant_quota(p_tenant_id,'subscribers');
  if v_current_count >= v_effective_limit then
    raise exception 'SUBSCRIBER_QUOTA_REACHED' using errcode = 'P0001';
  end if;

  v_subscriber_no := format('SUB-%s', lpad(nextval('public.subscriber_global_number_seq')::text, 6, '0'));

  insert into public.subscribers (
    tenant_id, site_id, subscriber_no, client_operation_id, full_name, phone, whatsapp_number, address, subscription_type
  ) values (
    p_tenant_id, p_site_id, v_subscriber_no, p_client_operation_id::text, trim(p_full_name), trim(p_phone), nullif(trim(p_whatsapp_number), ''), nullif(trim(p_address), ''), p_subscription_type
  ) returning id, subscriber_no into v_subscriber_id, v_subscriber_no;

  select platform_role into v_platform_role from public.users where id = p_user_id;
  insert into public.audit_logs (
    tenant_id, site_id, user_id, actor_platform_role, entity_type, entity_id, action, after_data
  ) values (
    p_tenant_id, p_site_id, p_user_id, v_platform_role, 'subscriber', v_subscriber_id::text, 'create',
    jsonb_build_object('siteId', p_site_id, 'fullName', trim(p_full_name), 'phone', trim(p_phone), 'whatsappNumber', nullif(trim(p_whatsapp_number), ''), 'address', nullif(trim(p_address), ''), 'subscriptionType', p_subscription_type, 'subscriberNo', v_subscriber_no, 'clientOperationId', p_client_operation_id)
  );

  if p_client_operation_id is not null then
    insert into public.offline_sync_operations (
      tenant_id, site_id, user_id, client_operation_id, operation_type, entity_type, entity_id, response
    ) values (
      p_tenant_id, p_site_id, p_user_id, p_client_operation_id::text, 'subscriber_create', 'subscriber', v_subscriber_id,
      jsonb_build_object('id', v_subscriber_id, 'subscriberNo', v_subscriber_no, 'referenceNotifications', jsonb_build_array())
    );
  end if;

  return query select v_subscriber_id, v_subscriber_no, false;
end;
$$;

revoke all on function public.powerhub_create_subscriber(bigint, bigint, bigint, text, text, text, text, text, uuid, integer) from public, anon, authenticated;
grant execute on function public.powerhub_create_subscriber(bigint, bigint, bigint, text, text, text, text, text, uuid, integer) to service_role;
revoke all on sequence public.subscriber_global_number_seq from public, anon, authenticated;
grant usage, select on sequence public.subscriber_global_number_seq to service_role;
create or replace function public.powerhub_create_site(p_tenant_id bigint,p_user_id bigint,p_name text,p_code text,p_city text default null,p_address text default null)
returns table (site_id bigint) language plpgsql security invoker set search_path=public,pg_temp as $
declare v_package_code text; v_setting public.platform_settings%rowtype; v_tenant_setting public.tenant_branch_settings%rowtype; v_limit int; v_count int; v_enabled boolean; v_site_id bigint; v_role text;
begin
  if p_name is null or char_length(btrim(p_name)) < 2 or p_code is null or char_length(btrim(p_code)) < 2 then raise exception 'INVALID_SITE_INPUT' using errcode='P0001'; end if;
  perform pg_advisory_xact_lock(p_tenant_id,hashtext('branch-policy'));
  select coalesce(ts.package_code, t.package_code) into v_package_code from public.tenant_subscriptions ts join public.tenants t on t.id=ts.tenant_id where ts.tenant_id=p_tenant_id limit 1;
  select * into v_setting from public.platform_settings where setting_key='branch_feature' limit 1;
  select * into v_tenant_setting from public.tenant_branch_settings where tenant_id=p_tenant_id limit 1;
  v_limit:=public.powerhub_effective_tenant_quota(p_tenant_id,'branch');
  if v_tenant_setting.max_branches_override is not null and v_tenant_setting.max_branches_override >= 1 then v_limit:=v_tenant_setting.max_branches_override + public.powerhub_get_active_addon_delta(p_tenant_id,'branch'); end if;
  v_enabled:=coalesce(v_tenant_setting.is_enabled_override,coalesce(v_setting.is_enabled,false) and v_limit>1);
  if not v_enabled then raise exception 'BRANCH_FEATURE_DISABLED' using errcode='P0001'; end if;
  select count(*)::int into v_count from public.sites where tenant_id=p_tenant_id and status<>'archived';
  if v_count>=v_limit then raise exception 'BRANCH_LIMIT_REACHED' using errcode='P0001'; end if;
  insert into public.sites(tenant_id,name,code,city,address) values(p_tenant_id,btrim(p_name),btrim(p_code),nullif(btrim(p_city),''),nullif(btrim(p_address),'')) returning id into v_site_id;
  insert into public.site_portal_settings(tenant_id,site_id,portal_code,display_name) values(p_tenant_id,v_site_id,lower(btrim(p_code)),btrim(p_name));
  select platform_role into v_role from public.users where id=p_user_id;
  insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data) values(p_tenant_id,v_site_id,p_user_id,v_role,'site',v_site_id::text,'create',jsonb_build_object('name',p_name,'code',p_code,'city',p_city,'address',p_address));
  return query select v_site_id;
end; $;
create or replace function public.powerhub_enforce_field_user_quota()
returns trigger
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare v_limit integer; v_existing boolean;
begin
  if new.role<>'technician' or new.is_active is not true then return new; end if;
  v_limit:=public.powerhub_effective_tenant_quota(new.tenant_id,'fieldUser');
  select exists(select 1 from public.staff_profiles p where p.tenant_id=new.tenant_id and p.user_id=new.user_id and p.role='technician' and p.is_active=true and p.id<>coalesce(new.id,0)) into v_existing;
  if not v_existing and (select count(distinct p.user_id) from public.staff_profiles p where p.tenant_id=new.tenant_id and p.role='technician' and p.is_active=true)>=v_limit then
    raise exception 'FIELD_USER_LIMIT_REACHED' using errcode='P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists powerhub_enforce_field_user_quota on public.staff_profiles;
create trigger powerhub_enforce_field_user_quota before insert or update of role,is_active,user_id,tenant_id on public.staff_profiles for each row execute function public.powerhub_enforce_field_user_quota();
revoke all on function public.powerhub_enforce_field_user_quota() from public,anon,authenticated;
grant execute on function public.powerhub_enforce_field_user_quota() to service_role;

