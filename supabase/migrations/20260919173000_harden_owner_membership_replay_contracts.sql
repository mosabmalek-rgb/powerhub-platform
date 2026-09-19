drop function if exists public.powerhub_admin_attach_owner_user(bigint,bigint,bigint,bigint);

create or replace function public.powerhub_admin_attach_owner_user(p_actor_user_id bigint,p_tenant_id bigint,p_user_id bigint,p_site_id bigint default null)
returns table(success boolean,site_id bigint,replayed boolean)
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_role text;v_user_role text;v_user_platform_role text;v_user_status text;v_site bigint;v_existing_owner bigint;v_membership public.tenant_members%rowtype;v_profile boolean;v_owner_link boolean;v_prev jsonb;
begin
 select platform_role into v_role from public.users where id=p_actor_user_id and role='admin' and account_status='active' and platform_role in('platform_owner','platform_admin','finance_admin');
 if v_role is null then raise exception 'FORBIDDEN_PLATFORM_ROLE' using errcode='42501'; end if;
 select role,platform_role,account_status into v_user_role,v_user_platform_role,v_user_status from public.users where id=p_user_id;
 if v_user_role is null then raise exception 'OWNER_USER_NOT_FOUND' using errcode='P0002'; end if;
 if v_user_role<>'user' or v_user_platform_role is not null then raise exception 'PLATFORM_ACCOUNT_CANNOT_BE_OWNER' using errcode='42501'; end if;
 if v_user_status<>'active' then raise exception 'OWNER_USER_NOT_ACTIVE' using errcode='42501'; end if;
 if p_site_id is not null then select id into v_site from public.sites where id=p_site_id and tenant_id=p_tenant_id; else select id into v_site from public.sites where tenant_id=p_tenant_id order by id limit 1; end if;
 if v_site is null then raise exception 'SITE_NOT_FOUND' using errcode='P0002'; end if;
 perform pg_advisory_xact_lock(hashtext('tenant-owner-lifecycle:'||p_tenant_id::text)::bigint);
 select tm.user_id into v_existing_owner from public.tenant_members tm where tm.tenant_id=p_tenant_id and tm.role='owner' and tm.is_active=true and tm.membership_status='active' order by tm.updated_at desc nulls last,tm.id desc limit 1;
 select tm.* into v_membership from public.tenant_members tm where tm.tenant_id=p_tenant_id and tm.user_id=p_user_id limit 1;
 select exists(select 1 from public.staff_profiles sp where sp.tenant_id=p_tenant_id and sp.user_id=p_user_id and sp.site_id=v_site and sp.role='owner' and sp.is_active=true) into v_profile;
 select exists(select 1 from public.tenant_owner_profiles top where top.tenant_id=p_tenant_id and top.owner_user_id=p_user_id) into v_owner_link;
 if v_existing_owner=p_user_id and v_membership.id is not null and v_membership.role='owner' and v_membership.is_active and v_membership.membership_status='active' and v_membership.expires_at is null and v_profile and v_owner_link then
   return query select true,v_site,true; return;
 end if;
 select coalesce(jsonb_agg(jsonb_build_object('userId',tm.user_id,'membershipId',tm.id)),'[]'::jsonb) into v_prev from public.tenant_members tm where tm.tenant_id=p_tenant_id and tm.role='owner' and tm.user_id<>p_user_id;
 update public.tenant_members set role='member',updated_at=now() where tenant_id=p_tenant_id and role='owner' and user_id<>p_user_id;
 update public.staff_profiles set is_active=false,updated_at=now() where tenant_id=p_tenant_id and user_id<>p_user_id and role='owner';
 insert into public.tenant_members(tenant_id,user_id,role,is_active,membership_status,updated_at) values(p_tenant_id,p_user_id,'owner',true,'active',now()) on conflict(tenant_id,user_id) do update set role='owner',is_active=true,membership_status='active',expires_at=null,updated_at=now();
 insert into public.staff_profiles(tenant_id,site_id,user_id,role,is_active,updated_at) values(p_tenant_id,v_site,p_user_id,'owner',true,now()) on conflict(user_id,site_id,role) do update set is_active=true,updated_at=now();
 update public.tenant_owner_profiles set owner_user_id=p_user_id,claimed_at=now(),updated_at=now() where tenant_id=p_tenant_id;
 insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,metadata) values(p_tenant_id,v_site,p_actor_user_id,v_role,'tenant_owner_profile',p_tenant_id::text,'platform_admin_attach_owner_user',jsonb_build_object('attachedUserId',p_user_id,'previousOwners',v_prev,'ownershipTransferred',v_existing_owner is distinct from p_user_id));
 return query select true,v_site,false;
end;$$;
revoke all on function public.powerhub_admin_attach_owner_user(bigint,bigint,bigint,bigint) from public,anon,authenticated;
grant execute on function public.powerhub_admin_attach_owner_user(bigint,bigint,bigint,bigint) to service_role;

drop function if exists public.powerhub_admin_set_tenant_membership_status(bigint,bigint,bigint,text);

create or replace function public.powerhub_admin_set_tenant_membership_status(p_actor_user_id bigint,p_tenant_id bigint,p_user_id bigint,p_status text)
returns table(success boolean,membership_id bigint,site_id bigint,status text,replayed boolean)
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_role text;v_m public.tenant_members%rowtype;v_site bigint;v_active boolean;v_count integer;
begin
 select platform_role into v_role from public.users where id=p_actor_user_id and role='admin' and account_status='active' and platform_role in('platform_owner','platform_admin','finance_admin');
 if v_role is null then raise exception 'FORBIDDEN_PLATFORM_ROLE' using errcode='42501'; end if;
 if p_status not in('active','suspended','revoked') then raise exception 'INVALID_MEMBERSHIP_STATUS' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtext('tenant-owner-lifecycle:'||p_tenant_id::text)::bigint);
 select * into v_m from public.tenant_members where tenant_id=p_tenant_id and user_id=p_user_id limit 1;
 select id into v_site from public.sites where tenant_id=p_tenant_id order by id limit 1;
 if v_m.id is null or v_site is null then raise exception 'MEMBERSHIP_OR_SITE_NOT_FOUND' using errcode='P0002'; end if;
 v_active:=p_status='active';
 if v_m.membership_status=p_status and v_m.is_active=v_active and ((p_status='revoked' and v_m.expires_at is not null) or (p_status<>'revoked' and v_m.expires_at is null)) then
   return query select true,v_m.id,v_site,p_status,true; return;
 end if;
 if v_m.role='owner' and p_status<>'active' then
   select count(*)::integer into v_count from public.tenant_members where tenant_id=p_tenant_id and role='owner' and is_active=true and membership_status='active' and user_id<>p_user_id;
   if v_count=0 then raise exception 'LAST_ACTIVE_OWNER_PROTECTED' using errcode='P0001'; end if;
 end if;
 update public.tenant_members set membership_status=p_status,is_active=v_active,expires_at=case when p_status='revoked' then coalesce(v_m.expires_at,now()) else null end,updated_at=now() where id=v_m.id;
 update public.staff_profiles set is_active=v_active,updated_at=now() where tenant_id=p_tenant_id and user_id=p_user_id;
 insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,before_data,after_data) values(p_tenant_id,v_site,p_actor_user_id,v_role,'tenant_membership',v_m.id::text,'platform_admin_set_tenant_membership_status',jsonb_build_object('status',v_m.membership_status,'isActive',v_m.is_active,'expiresAt',v_m.expires_at),jsonb_build_object('status',p_status,'isActive',v_active,'staffProfilesSynchronized',true));
 return query select true,v_m.id,v_site,p_status,false;
end;$$;
revoke all on function public.powerhub_admin_set_tenant_membership_status(bigint,bigint,bigint,text) from public,anon,authenticated;
grant execute on function public.powerhub_admin_set_tenant_membership_status(bigint,bigint,bigint,text) to service_role;