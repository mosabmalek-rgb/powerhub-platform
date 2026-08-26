create or replace function public.powerhub_create_expense(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_generator_id bigint,
  p_category text,
  p_description text,
  p_amount numeric,
  p_reference_no text
)
returns table (expense_id bigint)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_expense_id bigint;
  v_platform_role text;
begin
  if p_amount <= 0 then raise exception 'INVALID_EXPENSE_AMOUNT' using errcode = 'P0001'; end if;
  if p_category not in ('fuel', 'maintenance', 'payroll', 'parts', 'transport', 'other') then raise exception 'INVALID_EXPENSE_CATEGORY' using errcode = 'P0001'; end if;
  if exists (select 1 from public.financial_settlements where tenant_id = p_tenant_id and site_id = p_site_id and status = 'locked' and period_start <= now() and period_end >= now()) then
    raise exception 'FINANCIAL_PERIOD_LOCKED' using errcode = 'P0001';
  end if;
  if p_generator_id is not null and not exists (select 1 from public.generators where id = p_generator_id and tenant_id = p_tenant_id and site_id = p_site_id) then
    raise exception 'GENERATOR_OUT_OF_SCOPE' using errcode = 'P0001';
  end if;
  insert into public.expenses (tenant_id, site_id, generator_id, category, description, amount, reference_no, created_by_user_id)
  values (p_tenant_id, p_site_id, p_generator_id, p_category, p_description, p_amount, p_reference_no, p_user_id)
  returning id into v_expense_id;
  select platform_role into v_platform_role from public.users where id = p_user_id;
  insert into public.audit_logs (tenant_id, site_id, user_id, actor_platform_role, entity_type, entity_id, action, after_data)
  values (p_tenant_id, p_site_id, p_user_id, v_platform_role, 'expense', v_expense_id::text, 'create', jsonb_build_object('generatorId', p_generator_id, 'category', p_category, 'amount', p_amount, 'referenceNo', p_reference_no));
  return query select v_expense_id;
end;
$$;

revoke execute on function public.powerhub_create_expense(bigint, bigint, bigint, bigint, text, text, numeric, text) from public, anon, authenticated;
grant execute on function public.powerhub_create_expense(bigint, bigint, bigint, bigint, text, text, numeric, text) to service_role;
