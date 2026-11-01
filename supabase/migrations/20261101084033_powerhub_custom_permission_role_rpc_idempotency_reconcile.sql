-- Reconcile the Staging custom-role RPC with Production's idempotent contract.
-- Remove the legacy seven-argument overload so PostgREST resolves one unambiguous RPC.
drop function if exists public.powerhub_save_custom_permission_role(bigint,bigint,bigint,bigint,text,text,jsonb);

create or replace function public.powerhub_save_custom_permission_role(
  p_tenant_id bigint,p_site_id bigint,p_user_id bigint,p_role_id bigint,p_name text,p_description text,
  p_permissions jsonb,p_client_operation_id text default null,p_request_fingerprint text default null
)
returns table(role_id bigint,mutation text,replayed boolean)
language plpgsql set search_path=public,pg_temp
as $$
declare
  v_before jsonb; v_role_id bigint; v_actor_role text; v_actor_platform_role text; v_actor_tenant_role text;
  v_role public.custom_permission_roles%rowtype; v_current_permissions jsonb; v_requested_permissions jsonb;
begin
  if not exists(select 1 from public.sites where id=p_site_id and tenant_id=p_tenant_id) then raise exception 'SITE_OUT_OF_SCOPE'; end if;
  select role,platform_role into v_actor_role,v_actor_platform_role from public.users where id=p_user_id;
  if not found then raise exception 'ACTOR_NOT_FOUND'; end if;
  if v_actor_role<>'admin' then
    select role into v_actor_tenant_role from public.tenant_members where tenant_id=p_tenant_id and user_id=p_user_id and is_active=true and membership_status='active';
    if v_actor_tenant_role<>'owner' then raise exception 'ROLE_MANAGEMENT_FORBIDDEN'; end if;
  else v_actor_tenant_role:='platform_admin'; end if;
  if p_name is null or char_length(btrim(p_name))<2 or char_length(btrim(p_name))>120 or p_permissions is null or jsonb_typeof(p_permissions)<>'array' or jsonb_array_length(p_permissions)<1 then raise exception 'INVALID_CUSTOM_ROLE_INPUT'; end if;
  if exists(select 1 from jsonb_array_elements_text(p_permissions) capability(value) where capability.value not in (
    'manageSubscribers','manageGenerators','recordReadings','accessFieldApp','approveReadings','manageTariffs',
    'issueInvoices','collectPayments','approvePaymentDocumentation','manageExpenses','managePayroll','manageTeam','manageMessaging','viewAudit'
  )) then raise exception 'INVALID_CUSTOM_ROLE_CAPABILITY'; end if;
  if p_role_id is null and (nullif(trim(p_client_operation_id),'') is null or nullif(trim(p_request_fingerprint),'') is null) then raise exception 'INVALID_OPERATION_ID'; end if;
  perform pg_advisory_xact_lock(hashtextextended('custom-permission-role:'||p_tenant_id::text||':'||coalesce(p_role_id::text,trim(p_client_operation_id)),0));
  if p_role_id is null then
    select * into v_role from public.custom_permission_roles where tenant_id=p_tenant_id and created_by_user_id=p_user_id and client_operation_id=trim(p_client_operation_id) for update;
    if found then
      if v_role.request_fingerprint is distinct from p_request_fingerprint then raise exception 'OPERATION_CONFLICT'; end if;
      return query select v_role.id,'create'::text,true; return;
    end if;
    insert into public.custom_permission_roles(tenant_id,name,description,permissions,is_active,created_by_user_id,client_operation_id,request_fingerprint)
      values(p_tenant_id,btrim(p_name),nullif(btrim(coalesce(p_description,'')),''),p_permissions,true,p_user_id,trim(p_client_operation_id),p_request_fingerprint)
      returning id into v_role_id;
    insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,actor_tenant_role,entity_type,entity_id,action,after_data)
      values(p_tenant_id,p_site_id,p_user_id,v_actor_platform_role,v_actor_tenant_role,'custom_permission_role',v_role_id::text,'create',
        jsonb_build_object('name',btrim(p_name),'description',nullif(btrim(coalesce(p_description,'')),''),'permissions',p_permissions,'isActive',true));
    return query select v_role_id,'create'::text,false; return;
  end if;
  select * into v_role from public.custom_permission_roles where id=p_role_id and tenant_id=p_tenant_id for update;
  if not found then raise exception 'CUSTOM_ROLE_NOT_FOUND'; end if;
  v_current_permissions:=coalesce((select jsonb_agg(value order by value) from jsonb_array_elements_text(coalesce(v_role.permissions,'[]'::jsonb)) value),'[]'::jsonb);
  v_requested_permissions:=coalesce((select jsonb_agg(value order by value) from jsonb_array_elements_text(p_permissions) value),'[]'::jsonb);
  if v_role.name=btrim(p_name) and coalesce(v_role.description,'')=coalesce(nullif(btrim(coalesce(p_description,'')),''),'') and v_current_permissions=v_requested_permissions and v_role.is_active=true then
    return query select p_role_id,'update'::text,true; return;
  end if;
  v_before:=to_jsonb(v_role);
  update public.custom_permission_roles set name=btrim(p_name),description=nullif(btrim(coalesce(p_description,'')),''),permissions=v_requested_permissions,updated_at=now()
    where id=p_role_id and tenant_id=p_tenant_id;
  insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,actor_tenant_role,entity_type,entity_id,action,before_data,after_data)
    values(p_tenant_id,p_site_id,p_user_id,v_actor_platform_role,v_actor_tenant_role,'custom_permission_role',p_role_id::text,'update',v_before,
      jsonb_build_object('name',btrim(p_name),'description',nullif(btrim(coalesce(p_description,'')),''),'permissions',v_requested_permissions));
  return query select p_role_id,'update'::text,false;
end;
$$;

alter function public.powerhub_save_custom_permission_role(bigint,bigint,bigint,bigint,text,text,jsonb,text,text) owner to postgres;
revoke all on function public.powerhub_save_custom_permission_role(bigint,bigint,bigint,bigint,text,text,jsonb,text,text) from public, anon, authenticated;
grant execute on function public.powerhub_save_custom_permission_role(bigint,bigint,bigint,bigint,text,text,jsonb,text,text) to service_role;

notify pgrst, 'reload schema';
