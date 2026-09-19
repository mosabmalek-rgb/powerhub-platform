create or replace function public.powerhub_open_collector_session(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_opening_cash numeric,
  p_notes text,
  p_client_operation_id text
)
returns table(session_id bigint,replayed boolean)
language plpgsql
set search_path=public,pg_temp
as $$
declare v_session_id bigint; v_platform_role text; v_op public.offline_sync_operations%rowtype;
begin
  if p_opening_cash < 0 then raise exception 'INVALID_OPENING_CASH'; end if;
  if nullif(btrim(p_client_operation_id),'') is null then raise exception 'CLIENT_OPERATION_REQUIRED'; end if;
  perform pg_advisory_xact_lock(hashtext('collector-session-op:' || p_user_id::text || ':' || p_client_operation_id)::bigint);
  select * into v_op from public.offline_sync_operations
    where user_id=p_user_id and client_operation_id=p_client_operation_id for update;
  if found then
    if v_op.operation_type <> 'collector_session_open'
       or v_op.tenant_id <> p_tenant_id
       or v_op.site_id <> p_site_id
       or coalesce(v_op.response->>'openingCash','') <> p_opening_cash::text
       or coalesce(v_op.response->>'notes','') <> coalesce(p_notes,'')
    then raise exception 'COLLECTOR_SESSION_OPERATION_CONFLICT'; end if;
    return query select (v_op.response->>'sessionId')::bigint,true; return;
  end if;
  perform pg_advisory_xact_lock(hashtext('collector-session:' || p_site_id::text || ':' || p_user_id::text)::bigint);
  if exists (select 1 from public.collector_sessions where tenant_id=p_tenant_id and site_id=p_site_id and collector_user_id=p_user_id and status='open') then
    raise exception 'COLLECTOR_SESSION_EXISTS';
  end if;
  insert into public.collector_sessions (tenant_id,site_id,collector_user_id,opening_cash,notes)
    values (p_tenant_id,p_site_id,p_user_id,p_opening_cash,p_notes) returning id into v_session_id;
  select platform_role into v_platform_role from public.users where id=p_user_id;
  insert into public.audit_logs (tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data)
    values (p_tenant_id,p_site_id,p_user_id,v_platform_role,'collector_session',v_session_id::text,'open',jsonb_build_object('openingCash',p_opening_cash));
  insert into public.offline_sync_operations(tenant_id,site_id,user_id,client_operation_id,operation_type,entity_type,entity_id,response)
    values(p_tenant_id,p_site_id,p_user_id,p_client_operation_id,'collector_session_open','collector_session',v_session_id,
      jsonb_build_object('sessionId',v_session_id,'openingCash',p_opening_cash::text,'notes',coalesce(p_notes,'')));
  return query select v_session_id,false;
end;
$$;

revoke execute on function public.powerhub_open_collector_session(bigint,bigint,bigint,numeric,text) from public,anon,authenticated;
revoke execute on function public.powerhub_open_collector_session(bigint,bigint,bigint,numeric,text,text) from public,anon,authenticated;
grant execute on function public.powerhub_open_collector_session(bigint,bigint,bigint,numeric,text) to service_role;
grant execute on function public.powerhub_open_collector_session(bigint,bigint,bigint,numeric,text,text) to service_role;
