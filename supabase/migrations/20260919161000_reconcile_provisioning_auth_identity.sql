-- Reconcile Auth only when the orphaned Auth account carries this operation identity.
create or replace function public.powerhub_admin_begin_generator_owner_provisioning(
  p_actor_user_id bigint,p_client_operation_id uuid,p_owner_email text,p_request_fingerprint text
)
returns table(client_operation_id uuid,auth_user_id uuid,status text,replayed boolean)
language plpgsql security definer set search_path=public,pg_temp
as $function$
declare v_role text;v_op public.generator_owner_provisioning_operations%rowtype;v_existing_public_user_id bigint;v_existing_auth_user_id uuid;
begin
 select platform_role into v_role from public.users where id=p_actor_user_id and role='admin' and account_status='active' and platform_role in('platform_owner','platform_admin');
 if v_role is null then raise exception 'FORBIDDEN_PLATFORM_ROLE' using errcode='42501'; end if;
 if p_client_operation_id is null then raise exception 'CLIENT_OPERATION_REQUIRED' using errcode='P0001'; end if;
 if nullif(trim(p_owner_email),'') is null then raise exception 'OWNER_EMAIL_REQUIRED' using errcode='22023'; end if;
 if nullif(trim(p_request_fingerprint),'') is null then raise exception 'REQUEST_FINGERPRINT_REQUIRED' using errcode='P0001'; end if;
 perform pg_advisory_xact_lock(hashtext('generator-owner-provision:'||p_client_operation_id::text)::bigint);
 select * into v_op from public.generator_owner_provisioning_operations where client_operation_id=p_client_operation_id for update;
 if found then
   if v_op.actor_user_id<>p_actor_user_id or v_op.request_fingerprint<>trim(p_request_fingerprint) then raise exception 'GENERATOR_OWNER_PROVISIONING_OPERATION_CONFLICT' using errcode='P0001'; end if;
   return query select v_op.client_operation_id,v_op.auth_user_id,v_op.status,true; return;
 end if;
 select u.id into v_existing_public_user_id from public.users u where lower(u.email)=lower(trim(p_owner_email)) limit 1;
 if v_existing_public_user_id is not null then raise exception 'OWNER_EMAIL_ALREADY_PROVISIONED' using errcode='23505'; end if;
 if exists(select 1 from public.tenant_owner_profiles top where lower(top.email)=lower(trim(p_owner_email))) then raise exception 'OWNER_EMAIL_ALREADY_PROVISIONED' using errcode='23505'; end if;
 select au.id into v_existing_auth_user_id from auth.users au
 where lower(au.email)=lower(trim(p_owner_email))
   and coalesce(au.raw_user_meta_data->>'provisioning_operation_id','')=p_client_operation_id::text limit 1;
 if v_existing_auth_user_id is null and exists(select 1 from auth.users au where lower(au.email)=lower(trim(p_owner_email))) then
   raise exception 'AUTH_EMAIL_ALREADY_EXISTS' using errcode='23505';
 end if;
 insert into public.generator_owner_provisioning_operations(client_operation_id,actor_user_id,owner_email,request_fingerprint,auth_user_id,status)
 values(p_client_operation_id,p_actor_user_id,lower(trim(p_owner_email)),trim(p_request_fingerprint),v_existing_auth_user_id,'pending');
 return query select p_client_operation_id,v_existing_auth_user_id,'pending'::text,(v_existing_auth_user_id is not null);
end;
$function$;

revoke execute on function public.powerhub_admin_begin_generator_owner_provisioning(bigint,uuid,text,text) from public,anon,authenticated;
grant execute on function public.powerhub_admin_begin_generator_owner_provisioning(bigint,uuid,text,text) to service_role;
