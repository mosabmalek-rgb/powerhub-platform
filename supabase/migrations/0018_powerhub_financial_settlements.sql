create or replace function public.powerhub_create_financial_settlement(
  p_tenant_id bigint, p_site_id bigint, p_user_id bigint, p_period_start timestamptz, p_period_end timestamptz,
  p_total_collected numeric, p_total_expenses numeric, p_actual_cash numeric default null, p_notes text default null
)
returns table (settlement_id bigint)
language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_id bigint; v_role text; v_profit numeric(14,2); v_difference numeric(14,2);
begin
  if p_period_start >= p_period_end then raise exception 'INVALID_SETTLEMENT_PERIOD' using errcode = 'P0001'; end if;
  if p_total_collected < 0 or p_total_expenses < 0 or (p_actual_cash is not null and p_actual_cash < 0) then raise exception 'INVALID_SETTLEMENT_AMOUNT' using errcode = 'P0001'; end if;
  if not exists (select 1 from public.sites where id = p_site_id and tenant_id = p_tenant_id and status <> 'archived') then raise exception 'SITE_OUT_OF_SCOPE' using errcode = 'P0001'; end if;
  perform pg_advisory_xact_lock(p_site_id, hashtext(p_period_start::text || ':' || p_period_end::text));
  if exists (select 1 from public.financial_settlements where tenant_id = p_tenant_id and site_id = p_site_id and status = 'locked' and period_start <= p_period_end and period_end >= p_period_start) then raise exception 'SETTLEMENT_PERIOD_OVERLAPS_LOCKED' using errcode = 'P0001'; end if;
  v_profit := p_total_collected - p_total_expenses;
  v_difference := case when p_actual_cash is null then null else p_actual_cash - v_profit end;
  insert into public.financial_settlements (tenant_id, site_id, period_start, period_end, total_collected, total_expenses, book_profit, actual_cash, difference, notes, created_by_user_id)
  values (p_tenant_id, p_site_id, p_period_start, p_period_end, p_total_collected, p_total_expenses, v_profit, p_actual_cash, v_difference, p_notes, p_user_id) returning id into v_id;
  select platform_role into v_role from public.users where id = p_user_id;
  insert into public.audit_logs (tenant_id, site_id, user_id, actor_platform_role, entity_type, entity_id, action, after_data)
  values (p_tenant_id, p_site_id, p_user_id, v_role, 'financial_settlement', v_id::text, 'create', jsonb_build_object('periodStart', p_period_start, 'periodEnd', p_period_end, 'totalCollected', p_total_collected, 'totalExpenses', p_total_expenses, 'bookProfit', v_profit, 'actualCash', p_actual_cash));
  return query select v_id;
end;
$$;

revoke execute on function public.powerhub_create_financial_settlement(bigint,bigint,bigint,timestamptz,timestamptz,numeric,numeric,numeric,text) from public, anon, authenticated;
grant execute on function public.powerhub_create_financial_settlement(bigint,bigint,bigint,timestamptz,timestamptz,numeric,numeric,numeric,text) to service_role;
