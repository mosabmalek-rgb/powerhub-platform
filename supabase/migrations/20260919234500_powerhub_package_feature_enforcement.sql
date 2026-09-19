-- Central package catalog is the source of staff/platform account quotas.
create or replace function public.powerhub_assign_existing_staff(
  p_tenant_id bigint,p_site_id bigint,p_actor_user_id bigint,p_target_user_id bigint,p_role text,p_all_branches boolean
) returns table(profile_id bigint,target_user_id bigint,replayed boolean)
language plpgsql set search_path to 'public','pg_temp' as $$
declare
 v_actor_role text; v_actor_platform_role text; v_actor_tenant_role text; v_existing_member_role text;
 v_existing_member_active boolean; v_existing_membership_status text; v_target_membership_role text;
 v_target_site_id bigint; v_plan text; v_package_code text; v_policy_enabled boolean; v_roles_policy jsonb;
 v_catalog jsonb; v_package jsonb; v_overrides_policy jsonb; v_override jsonb; v_limit int; v_current_count int;
 v_already_active_subaccount boolean:=false; v_before_member jsonb; v_before_profiles jsonb; v_profile_id bigint; v_profile public.staff_profiles%rowtype;
begin
 if p_role not in ('owner','manager','accountant','collector','technician','viewer') then raise exception 'INVALID_STAFF_ROLE'; end if;
 if not exists(select 1 from public.sites where id=p_site_id and tenant_id=p_tenant_id) then raise exception 'SITE_OUT_OF_SCOPE'; end if;
 select role,platform_role into v_actor_role,v_actor_platform_role from public.users where id=p_actor_user_id;
 if not found then raise exception 'ACTOR_NOT_FOUND'; end if;
 if not exists(select 1 from public.users where id=p_target_user_id) then raise exception 'TARGET_USER_NOT_FOUND'; end if;
 if v_actor_role<>'admin' then
   select role into v_actor_tenant_role from public.tenant_members where tenant_id=p_tenant_id and user_id=p_actor_user_id and is_active=true and membership_status='active';
   if v_actor_tenant_role<>'owner' then raise exception 'STAFF_ASSIGNMENT_FORBIDDEN'; end if;
 else v_actor_tenant_role:='platform_admin'; end if;
 perform pg_advisory_xact_lock(p_tenant_id,hashtext('staff-assignment'));
 select to_jsonb(member),member.role,member.is_active,member.membership_status into v_before_member,v_existing_member_role,v_existing_member_active,v_existing_membership_status from public.tenant_members member where member.tenant_id=p_tenant_id and member.user_id=p_target_user_id for update;
 v_already_active_subaccount:=found and v_existing_member_role='member' and v_existing_member_active=true and v_existing_membership_status='active';
 v_target_membership_role:=case when found and v_existing_member_role='owner' then 'owner' else 'member' end;
 v_target_site_id:=case when p_all_branches then null else p_site_id end;
 select coalesce(jsonb_agg(to_jsonb(profile) order by profile.id),'[]'::jsonb) into v_before_profiles from public.staff_profiles profile where profile.tenant_id=p_tenant_id and profile.user_id=p_target_user_id and (profile.site_id=p_site_id or (p_all_branches and profile.site_id is null));
 select profile.* into v_profile from public.staff_profiles profile where profile.tenant_id=p_tenant_id and profile.user_id=p_target_user_id and profile.site_id is not distinct from v_target_site_id and profile.role=p_role and profile.is_active=true order by profile.id desc limit 1 for update;
 if found and v_existing_member_role=v_target_membership_role and v_existing_member_active=true and v_existing_membership_status='active' then
   if not exists(select 1 from public.staff_profiles other where other.tenant_id=p_tenant_id and other.user_id=p_target_user_id and (other.site_id=p_site_id or (p_all_branches and other.site_id is null)) and other.is_active=true and other.role<>p_role) then
     return query select v_profile.id,p_target_user_id,true; return;
   end if;
 end if;
 select ts.plan,ts.package_code into v_plan,v_package_code from public.tenant_subscriptions ts where ts.tenant_id=p_tenant_id order by ts.created_at desc,ts.id desc limit 1;
 if v_plan is null then select plan into v_plan from public.tenants where id=p_tenant_id; end if;
 v_package_code:=lower(nullif(btrim(v_package_code),''));
 if v_package_code not in ('basic','advanced','professional','business','vip') then v_package_code:=case v_plan when 'starter' then 'basic' when 'professional' then 'advanced' when 'enterprise' then 'business' end; end if;
 if v_package_code is null then raise exception 'TENANT_PACKAGE_NOT_FOUND'; end if;
 select is_enabled,value into v_policy_enabled,v_roles_policy from public.platform_settings where setting_key='owner_subaccount_roles';
 select value into v_catalog from public.platform_settings where setting_key='subscription_package_catalog' and is_enabled=true;
 select value into v_overrides_policy from public.platform_settings where setting_key='owner_limit_overrides';
 v_override:=case when jsonb_typeof(v_overrides_policy->'overrides')='object' then v_overrides_policy->'overrides'->p_tenant_id::text else null end;
 if v_actor_role<>'admin' then
   if v_policy_enabled=false then raise exception 'SUBACCOUNT_ROLE_NOT_ALLOWED'; end if;
   if p_role='owner' then raise exception 'SUBACCOUNT_ROLE_NOT_ALLOWED'; end if;
   if jsonb_typeof(v_roles_policy->'allowedRoles')='array' and not (v_roles_policy->'allowedRoles' ? p_role) then raise exception 'SUBACCOUNT_ROLE_NOT_ALLOWED'; end if;
   if jsonb_typeof(v_override->'allowedRoles')='array' and not (v_override->'allowedRoles' ? p_role) then raise exception 'SUBACCOUNT_ROLE_NOT_ALLOWED'; end if;
 end if;
 select p into v_package from jsonb_array_elements(coalesce(v_catalog->'packages','[]'::jsonb)) p where p->>'code'=v_package_code and coalesce((p->>'active')::boolean,true)=true limit 1;
 v_limit:=coalesce((v_package->'features'->'platformUsers'->>'limit')::int,(v_package->>'platformUsers')::int,0);
 if v_limit<0 then raise exception 'INVALID_PLATFORM_ACCOUNT_QUOTA'; end if;
 if jsonb_typeof(v_override)='object' and (v_override->>'subaccountLimit') ~ '^\\d+$' then v_limit:=(v_override->>'subaccountLimit')::int; end if;
 select count(*)::int into v_current_count from public.tenant_members where tenant_id=p_tenant_id and role='member' and is_active=true and membership_status='active';
 if not v_already_active_subaccount and v_current_count>=v_limit then raise exception 'SUBACCOUNT_LIMIT_REACHED'; end if;
 insert into public.tenant_members(tenant_id,user_id,role,is_active,membership_status,expires_at,invited_by_user_id) values(p_tenant_id,p_target_user_id,v_target_membership_role,true,'active',null,p_actor_user_id)
 on conflict(tenant_id,user_id) do update set role=excluded.role,is_active=true,membership_status='active',expires_at=null,updated_at=now();
 update public.staff_profiles set is_active=false,updated_at=now() where tenant_id=p_tenant_id and user_id=p_target_user_id and (site_id=p_site_id or (p_all_branches and site_id is null));
 insert into public.staff_profiles(tenant_id,site_id,user_id,role,is_active) values(p_tenant_id,v_target_site_id,p_target_user_id,p_role,true)
 on conflict(user_id,site_id,role) do update set is_active=true,updated_at=now() returning id into v_profile_id;
 insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,actor_tenant_role,entity_type,entity_id,action,before_data,after_data)
 values(p_tenant_id,p_site_id,p_actor_user_id,v_actor_platform_role,v_actor_tenant_role,'staff_profile',v_profile_id::text,'assign_role',jsonb_build_object('membership',v_before_member,'profiles',v_before_profiles),jsonb_build_object('targetUserId',p_target_user_id,'role',p_role,'allBranches',p_all_branches,'assignedSiteId',v_target_site_id,'membershipRole',v_target_membership_role,'packageCode',v_package_code,'platformAccountLimit',v_limit));
 return query select v_profile_id,p_target_user_id,false;
end; $$;