-- Preserve explicit permission semantics for staff profiles.
-- NULL = inherit from custom role; [] = explicit deny-all.
-- This mirrors the production migration already applied at version 20260920114622.

create or replace function public.powerhub_update_staff_profile_permissions(
 p_tenant_id bigint,
 p_site_id bigint,
 p_actor_user_id bigint,
 p_profile_id bigint,
 p_custom_role_id bigint,
 p_permissions jsonb
) returns table(profile_id bigint, target_user_id bigint, replayed boolean)
language plpgsql
set search_path to 'public','pg_temp'
as $function$
declare
 v_before jsonb; v_actor_role text; v_actor_platform_role text; v_actor_tenant_role text;
 v_profile public.staff_profiles%rowtype; v_current_permissions jsonb; v_requested_permissions jsonb;
begin
 if not exists(select 1 from public.sites where id=p_site_id and tenant_id=p_tenant_id) then raise exception 'SITE_OUT_OF_SCOPE'; end if;
 select role,platform_role into v_actor_role,v_actor_platform_role from public.users where id=p_actor_user_id;
 if not found then raise exception 'ACTOR_NOT_FOUND'; end if;
 if v_actor_role<>'admin' then
   select role into v_actor_tenant_role from public.tenant_members where tenant_id=p_tenant_id and user_id=p_actor_user_id and is_active=true and membership_status='active';
   if v_actor_tenant_role<>'owner' then raise exception 'STAFF_PERMISSION_MANAGEMENT_FORBIDDEN'; end if;
 else v_actor_tenant_role:='platform_admin'; end if;
 if p_permissions is null or jsonb_typeof(p_permissions)<>'array' then raise exception 'INVALID_STAFF_PERMISSIONS'; end if;
 if exists(select 1 from jsonb_array_elements_text(p_permissions) capability(value)
   where capability.value not in ('manageSubscribers','manageGenerators','recordReadings','accessFieldApp','approveReadings','manageTariffs','issueInvoices','collectPayments','approvePaymentDocumentation','manageExpenses','managePayroll','manageTeam','manageMessaging','viewAudit'))
 then raise exception 'INVALID_STAFF_PERMISSION_CAPABILITY'; end if;
 perform pg_advisory_xact_lock(hashtext('staff-profile-permissions:'||p_tenant_id::text||':'||p_profile_id::text)::bigint);
 if p_custom_role_id is not null and not exists(select 1 from public.custom_permission_roles where id=p_custom_role_id and tenant_id=p_tenant_id and is_active=true for key share) then raise exception 'CUSTOM_ROLE_NOT_FOUND'; end if;
 select * into v_profile from public.staff_profiles where id=p_profile_id and tenant_id=p_tenant_id and (site_id=p_site_id or site_id is null) for update;
 if not found then raise exception 'STAFF_PROFILE_OUT_OF_SCOPE'; end if;
 v_current_permissions:=coalesce((select jsonb_agg(value order by value) from jsonb_array_elements_text(coalesce(v_profile.permissions,'[]'::jsonb)) value),'[]'::jsonb);
 v_requested_permissions:=coalesce((select jsonb_agg(value order by value) from jsonb_array_elements_text(p_permissions) value),'[]'::jsonb);
 if v_profile.custom_role_id is not distinct from p_custom_role_id and v_current_permissions=v_requested_permissions then return query select p_profile_id,v_profile.user_id,true; return; end if;
 v_before:=to_jsonb(v_profile);
 update public.staff_profiles set custom_role_id=p_custom_role_id,permissions=v_requested_permissions,updated_at=now() where id=p_profile_id and tenant_id=p_tenant_id;
 insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,actor_tenant_role,entity_type,entity_id,action,before_data,after_data)
 values(p_tenant_id,p_site_id,p_actor_user_id,v_actor_platform_role,v_actor_tenant_role,'staff_profile',p_profile_id::text,'update_permissions',v_before,jsonb_build_object('customRoleId',p_custom_role_id,'permissions',v_requested_permissions,'targetUserId',v_profile.user_id));
 return query select p_profile_id,v_profile.user_id,false;
end; $function$;
