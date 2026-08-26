create or replace function public.powerhub_open_collector_session(
  p_tenant_id bigint, p_site_id bigint, p_user_id bigint, p_opening_cash numeric, p_notes text
)
returns table (session_id bigint)
language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_session_id bigint; v_platform_role text;
begin
  if p_opening_cash < 0 then raise exception 'INVALID_OPENING_CASH' using errcode = 'P0001'; end if;
  perform pg_advisory_xact_lock(p_site_id, p_user_id::integer);
  if exists (select 1 from public.collector_sessions where tenant_id=p_tenant_id and site_id=p_site_id and collector_user_id=p_user_id and status='open') then raise exception 'COLLECTOR_SESSION_EXISTS' using errcode='P0001'; end if;
  insert into public.collector_sessions (tenant_id,site_id,collector_user_id,opening_cash,notes) values (p_tenant_id,p_site_id,p_user_id,p_opening_cash,p_notes) returning id into v_session_id;
  select platform_role into v_platform_role from public.users where id=p_user_id;
  insert into public.audit_logs (tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data) values (p_tenant_id,p_site_id,p_user_id,v_platform_role,'collector_session',v_session_id::text,'open',jsonb_build_object('openingCash',p_opening_cash));
  return query select v_session_id;
end; $$;

create or replace function public.powerhub_close_collector_session(
  p_tenant_id bigint, p_site_id bigint, p_user_id bigint, p_session_id bigint, p_declared_cash numeric, p_notes text, p_allow_foreign_close boolean
)
returns table (expected_cash numeric, variance_amount numeric)
language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_session public.collector_sessions%rowtype; v_expected numeric(14,2); v_variance numeric(14,2); v_platform_role text;
begin
  if p_declared_cash < 0 then raise exception 'INVALID_DECLARED_CASH' using errcode='P0001'; end if;
  perform pg_advisory_xact_lock(p_session_id);
  select * into v_session from public.collector_sessions where id=p_session_id and tenant_id=p_tenant_id and site_id=p_site_id for update;
  if not found then raise exception 'COLLECTOR_SESSION_NOT_FOUND' using errcode='P0001'; end if;
  if v_session.status <> 'open' then raise exception 'COLLECTOR_SESSION_CLOSED' using errcode='P0001'; end if;
  if not p_allow_foreign_close and v_session.collector_user_id <> p_user_id then raise exception 'COLLECTOR_SESSION_FORBIDDEN' using errcode='P0001'; end if;
  select v_session.opening_cash + coalesce(sum(amount),0) into v_expected from public.payments where collector_session_id=p_session_id and payment_method='cash' and status='completed';
  v_variance := p_declared_cash-v_expected;
  update public.collector_sessions set status='closed',expected_cash=v_expected,declared_cash=p_declared_cash,variance_amount=v_variance,notes=coalesce(p_notes,v_session.notes),closed_at=now(),closed_by_user_id=p_user_id,updated_at=now() where id=p_session_id;
  select platform_role into v_platform_role from public.users where id=p_user_id;
  insert into public.audit_logs (tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,before_data,after_data) values (p_tenant_id,p_site_id,p_user_id,v_platform_role,'collector_session',p_session_id::text,'close',jsonb_build_object('status','open'),jsonb_build_object('declaredCash',p_declared_cash,'expectedCash',v_expected,'varianceAmount',v_variance));
  return query select v_expected,v_variance;
end; $$;

revoke execute on function public.powerhub_open_collector_session(bigint,bigint,bigint,numeric,text) from public,anon,authenticated;
revoke execute on function public.powerhub_close_collector_session(bigint,bigint,bigint,bigint,numeric,text,boolean) from public,anon,authenticated;
grant execute on function public.powerhub_open_collector_session(bigint,bigint,bigint,numeric,text) to service_role;
grant execute on function public.powerhub_close_collector_session(bigint,bigint,bigint,bigint,numeric,text,boolean) to service_role;
