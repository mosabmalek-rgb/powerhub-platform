-- Production reconciliation for subaccount archive lifecycle and payment-documentation RPCs.

alter table public.staff_profiles add column if not exists archived_at timestamptz;
alter table public.staff_profiles add column if not exists archived_by_user_id bigint references public.users(id) on delete set null;

create index if not exists idx_staff_profiles_tenant_active_archived
  on public.staff_profiles(tenant_id,is_active,archived_at);
create index if not exists idx_staff_profiles_tenant_archived
  on public.staff_profiles(tenant_id,archived_at)
  where archived_at is not null;

create or replace function public.powerhub_update_company_account_payment_visibility(
 p_tenant_id bigint,p_site_id bigint,p_user_id bigint,p_account_id bigint,p_allow boolean
) returns table(account_id bigint,allow_payment_documentation boolean)
language plpgsql security definer set search_path to 'public','pg_temp' as $function$
declare v_account public.company_accounts%rowtype; v_access record; v_before boolean;
begin
 if not exists(select 1 from public.tenant_members tm where tm.tenant_id=p_tenant_id and tm.user_id=p_user_id and tm.role='owner' and tm.is_active=true and tm.membership_status='active')
 and not exists(select 1 from public.staff_profiles sp join public.tenant_members tm on tm.tenant_id=sp.tenant_id and tm.user_id=sp.user_id where sp.tenant_id=p_tenant_id and sp.user_id=p_user_id and sp.role='manager' and sp.is_active=true and sp.archived_at is null and (sp.site_id=p_site_id or sp.site_id is null) and tm.role='member' and tm.is_active=true and tm.membership_status='active')
 then raise exception 'COMPANY_ACCOUNT_PAYMENT_VISIBILITY_FORBIDDEN'; end if;
 select ca.* into v_account from public.company_accounts ca where ca.id=p_account_id and ca.tenant_id=p_tenant_id for update;
 if not found then raise exception 'ACCOUNT_NOT_FOUND'; end if;
 if not v_account.is_active then raise exception 'ACCOUNT_INACTIVE'; end if;
 if exists(select 1 from public.company_account_sites cas where cas.account_id=p_account_id)
 and not exists(select 1 from public.company_account_sites cas where cas.account_id=p_account_id and cas.site_id=p_site_id and cas.tenant_id=p_tenant_id)
 then raise exception 'ACCOUNT_SITE_OUT_OF_SCOPE'; end if;
 if p_allow then
   select * into v_access from public.powerhub_payment_documentation_access(p_tenant_id);
   if not coalesce(v_access.allowed,false) then raise exception 'PAYMENT_DOCUMENTATION_TENANT_DISABLED'; end if;
 end if;
 v_before:=v_account.allow_payment_documentation;
 update public.company_accounts ca set allow_payment_documentation=p_allow,updated_at=now() where ca.id=p_account_id;
 insert into public.audit_logs(tenant_id,site_id,user_id,entity_type,entity_id,action,before_data,after_data)
 values(p_tenant_id,p_site_id,p_user_id,'company_account',p_account_id::text,'update_payment_documentation_visibility',
   jsonb_build_object('allowPaymentDocumentation',v_before),jsonb_build_object('allowPaymentDocumentation',p_allow));
 return query select p_account_id,p_allow;
end;$function$;

create or replace function public.powerhub_owner_set_payment_documentation(
 p_user_id bigint,p_site_id bigint,p_is_enabled boolean
) returns table(success boolean,tenant_id bigint,feature_key text,is_enabled boolean,policy text)
language plpgsql security definer set search_path to 'public','pg_temp' as $function$
declare v_tenant_id bigint; v_access record; v_global_enabled boolean:=false; v_now timestamptz:=now();
begin
 select s.tenant_id into v_tenant_id from public.sites s
 join public.tenant_members tm on tm.tenant_id=s.tenant_id and tm.user_id=p_user_id and tm.role='owner' and tm.is_active=true and tm.membership_status='active'
 join public.tenants t on t.id=s.tenant_id
 where s.id=p_site_id and s.status='active' and t.status='active' limit 1;
 if v_tenant_id is null then raise exception 'OWNER_SITE_FORBIDDEN' using errcode='P0001'; end if;
 select coalesce(ps.is_enabled,false) into v_global_enabled from public.platform_settings ps where ps.setting_key='payment_documentation' limit 1;
 select * into v_access from public.powerhub_payment_documentation_access(v_tenant_id);
 if p_is_enabled and not v_global_enabled then raise exception 'FEATURE_GLOBALLY_DISABLED' using errcode='P0001'; end if;
 if p_is_enabled and coalesce(v_access.policy,'not_included')='not_included' then raise exception 'FEATURE_NOT_AVAILABLE' using errcode='P0001'; end if;
 update public.tenant_feature_controls tfc
 set status=case when p_is_enabled then 'enabled' else 'disabled' end,updated_by_user_id=p_user_id,updated_at=v_now
 where tfc.tenant_id=v_tenant_id and tfc.feature_key='payment_documentation';
 if not found then
   insert into public.tenant_feature_controls(tenant_id,feature_key,status,limit_mode,manual_limit,override_reason,updated_by_user_id,created_at,updated_at)
   values(v_tenant_id,'payment_documentation',case when p_is_enabled then 'enabled' else 'disabled' end,'inherit',null,'owner_toggle',p_user_id,v_now,v_now);
 end if;
 update public.tenant_feature_entitlements tfe
 set is_enabled=p_is_enabled,activated_by_user_id=p_user_id,activated_at=case when p_is_enabled then v_now else null end,updated_at=v_now
 where tfe.tenant_id=v_tenant_id and tfe.feature_key='payment_documentation';
 if not found then
   insert into public.tenant_feature_entitlements(tenant_id,feature_key,is_enabled,activated_by_user_id,activated_at,created_at,updated_at)
   values(v_tenant_id,'payment_documentation',p_is_enabled,p_user_id,case when p_is_enabled then v_now else null end,v_now,v_now);
 end if;
 insert into public.audit_logs(tenant_id,site_id,user_id,entity_type,entity_id,action,after_data)
 values(v_tenant_id,p_site_id,p_user_id,'tenant_feature_entitlement','payment_documentation',
   case when p_is_enabled then 'enable' else 'disable' end,
   jsonb_build_object('featureKey','payment_documentation','policy',v_access.policy,'isEnabled',p_is_enabled));
 return query select true,v_tenant_id,'payment_documentation'::text,p_is_enabled,coalesce(v_access.policy,'not_included');
end;$function$;

create or replace function public.powerhub_update_staff_profile_status(
 p_tenant_id bigint,p_site_id bigint,p_actor_user_id bigint,p_profile_id bigint,p_operation text,
 p_suspension_started_at timestamptz,p_suspension_ends_at timestamptz,p_is_active boolean
) returns table(profile_id bigint,is_active boolean,suspension_ends_at timestamptz,archived_at timestamptz,replayed boolean)
language plpgsql security definer set search_path to 'public','pg_temp' as $function$
declare v_profile public.staff_profiles%rowtype; v_actor_role text; v_actor_platform_role text; v_actor_tenant_role text;
v_before jsonb; v_after jsonb; v_action text; v_now timestamptz:=now(); v_policy record; v_count int; v_limit int;
begin
 if p_operation not in ('suspend','clear_suspension','archive','restore','set_active') then raise exception 'INVALID_STAFF_STATUS_OPERATION'; end if;
 if p_operation='set_active' then p_operation:=case when p_is_active then 'restore' else 'archive' end; end if;
 if not exists(select 1 from public.sites s where s.id=p_site_id and s.tenant_id=p_tenant_id and s.status='active') then raise exception 'SITE_OUT_OF_SCOPE'; end if;
 select u.role,u.platform_role into v_actor_role,v_actor_platform_role from public.users u where u.id=p_actor_user_id;
 if not found then raise exception 'ACTOR_NOT_FOUND'; end if;
 if v_actor_role<>'admin' then
   select tm.role into v_actor_tenant_role from public.tenant_members tm where tm.tenant_id=p_tenant_id and tm.user_id=p_actor_user_id and tm.role='owner' and tm.is_active=true and tm.membership_status='active';
   if v_actor_tenant_role is distinct from 'owner' then raise exception 'STAFF_STATUS_MANAGEMENT_FORBIDDEN'; end if;
 else v_actor_tenant_role:='platform_admin'; end if;
 perform pg_advisory_xact_lock(hashtextextended('staff-account-status:'||p_tenant_id||':'||p_profile_id,0));
 select sp.* into v_profile from public.staff_profiles sp where sp.id=p_profile_id and sp.tenant_id=p_tenant_id and (sp.site_id=p_site_id or sp.site_id is null) for update;
 if not found then raise exception 'STAFF_PROFILE_OUT_OF_SCOPE'; end if;
 if v_profile.role='owner' then raise exception 'OWNER_PROFILE_PROTECTED'; end if;
 if p_operation='archive' then
   if v_profile.archived_at is not null and not v_profile.is_active then return query select v_profile.id,v_profile.is_active,v_profile.suspension_ends_at,v_profile.archived_at,true; return; end if;
   v_before:=to_jsonb(v_profile);
   update public.staff_profiles sp set is_active=false,suspension_started_at=null,suspension_ends_at=null,archived_at=coalesce(sp.archived_at,v_now),archived_by_user_id=p_actor_user_id,updated_at=v_now where sp.tenant_id=p_tenant_id and sp.user_id=v_profile.user_id;
   update public.tenant_members tm set is_active=false,membership_status='suspended',updated_at=v_now where tm.tenant_id=p_tenant_id and tm.user_id=v_profile.user_id and tm.role='member';
   v_action:='archive'; v_after:=jsonb_build_object('targetUserId',v_profile.user_id,'isActive',false,'archivedAt',v_now);
 elsif p_operation='restore' then
   if v_profile.archived_at is null and v_profile.is_active then return query select v_profile.id,v_profile.is_active,v_profile.suspension_ends_at,v_profile.archived_at,true; return; end if;
   if v_profile.role='technician' then select * into v_policy from public.powerhub_resolve_tenant_feature_policy(p_tenant_id,'field_users'); else select * into v_policy from public.powerhub_resolve_tenant_feature_policy(p_tenant_id,'platform_users'); end if;
   if not coalesce(v_policy.eligible,false) or not coalesce(v_policy.enabled,false) then if v_profile.role='technician' then raise exception 'FIELD_USERS_FEATURE_DISABLED'; else raise exception 'PLATFORM_USERS_FEATURE_DISABLED'; end if; end if;
   v_limit:=v_policy.effective_limit;
   if v_limit is not null then
     select count(distinct sp.user_id)::int into v_count from public.staff_profiles sp join public.tenant_members tm on tm.tenant_id=sp.tenant_id and tm.user_id=sp.user_id
     where sp.tenant_id=p_tenant_id and sp.is_active=true and sp.archived_at is null and tm.role='member' and tm.is_active=true and tm.membership_status='active' and sp.user_id<>v_profile.user_id
       and (case when v_profile.role='technician' then sp.role='technician' else sp.role in ('manager','accountant','collector','viewer') end);
     if v_count>=v_limit then if v_profile.role='technician' then raise exception 'FIELD_USER_LIMIT_REACHED'; else raise exception 'SUBACCOUNT_LIMIT_REACHED'; end if; end if;
   end if;
   v_before:=to_jsonb(v_profile);
   update public.tenant_members tm set role='member',is_active=true,membership_status='active',expires_at=null,updated_at=v_now where tm.tenant_id=p_tenant_id and tm.user_id=v_profile.user_id;
   if not found then insert into public.tenant_members(tenant_id,user_id,role,is_active,membership_status,expires_at,invited_by_user_id) values(p_tenant_id,v_profile.user_id,'member',true,'active',null,p_actor_user_id); end if;
   update public.staff_profiles sp set is_active=true,suspension_started_at=null,suspension_ends_at=null,archived_at=null,archived_by_user_id=null,updated_at=v_now where sp.id=v_profile.id and sp.tenant_id=p_tenant_id;
   v_action:='restore'; v_after:=jsonb_build_object('targetUserId',v_profile.user_id,'role',v_profile.role,'isActive',true,'archivedAt',null);
 elsif p_operation='suspend' then
   if p_suspension_started_at is null or p_suspension_ends_at is null or p_suspension_ends_at<=p_suspension_started_at then raise exception 'INVALID_SUSPENSION_WINDOW'; end if;
   if v_profile.archived_at is not null then raise exception 'STAFF_PROFILE_ARCHIVED'; end if;
   if v_profile.suspension_started_at=p_suspension_started_at and v_profile.suspension_ends_at=p_suspension_ends_at then return query select v_profile.id,v_profile.is_active,v_profile.suspension_ends_at,v_profile.archived_at,true; return; end if;
   v_before:=to_jsonb(v_profile); update public.staff_profiles sp set suspension_started_at=p_suspension_started_at,suspension_ends_at=p_suspension_ends_at,updated_at=v_now where sp.id=p_profile_id and sp.tenant_id=p_tenant_id;
   v_action:='suspend_until'; v_after:=jsonb_build_object('targetUserId',v_profile.user_id,'suspensionEndsAt',p_suspension_ends_at);
 else
   if v_profile.archived_at is not null then raise exception 'STAFF_PROFILE_ARCHIVED'; end if;
   if v_profile.suspension_started_at is null and v_profile.suspension_ends_at is null then return query select v_profile.id,v_profile.is_active,null::timestamptz,v_profile.archived_at,true; return; end if;
   v_before:=to_jsonb(v_profile); update public.staff_profiles sp set suspension_started_at=null,suspension_ends_at=null,updated_at=v_now where sp.id=p_profile_id and sp.tenant_id=p_tenant_id;
   v_action:='clear_suspension'; v_after:=jsonb_build_object('targetUserId',v_profile.user_id);
 end if;
 insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,actor_tenant_role,entity_type,entity_id,action,before_data,after_data)
 values(p_tenant_id,p_site_id,p_actor_user_id,v_actor_platform_role,v_actor_tenant_role,'staff_profile',p_profile_id::text,v_action,v_before,v_after);
 select sp.* into v_profile from public.staff_profiles sp where sp.id=p_profile_id and sp.tenant_id=p_tenant_id;
 return query select v_profile.id,v_profile.is_active,v_profile.suspension_ends_at,v_profile.archived_at,false;
end;$function$;

revoke all on function public.powerhub_owner_set_payment_documentation(bigint,bigint,boolean) from public,anon,authenticated;
grant execute on function public.powerhub_owner_set_payment_documentation(bigint,bigint,boolean) to service_role;
revoke all on function public.powerhub_update_company_account_payment_visibility(bigint,bigint,bigint,bigint,boolean) from public,anon,authenticated;
grant execute on function public.powerhub_update_company_account_payment_visibility(bigint,bigint,bigint,bigint,boolean) to service_role;
revoke all on function public.powerhub_update_staff_profile_status(bigint,bigint,bigint,bigint,text,timestamptz,timestamptz,boolean) from public,anon,authenticated;
grant execute on function public.powerhub_update_staff_profile_status(bigint,bigint,bigint,bigint,text,timestamptz,timestamptz,boolean) to service_role;
