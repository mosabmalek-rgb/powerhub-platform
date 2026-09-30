-- Link every manually-created expense to the company account that paid it.
-- The expense row and its account withdrawal are created atomically in one RPC.
alter table public.expenses
  add column if not exists company_account_id bigint references public.company_accounts(id) on delete restrict;

alter table public.account_transactions
  add column if not exists related_expense_id bigint references public.expenses(id) on delete set null;

create index if not exists expenses_company_account_id_idx
  on public.expenses (tenant_id, company_account_id, occurred_at desc);

create index if not exists account_transactions_related_expense_id_idx
  on public.account_transactions (tenant_id, related_expense_id)
  where related_expense_id is not null;

create or replace function public.powerhub_create_expense_with_account(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_generator_id bigint,
  p_company_account_id bigint,
  p_category text,
  p_description text,
  p_amount numeric,
  p_reference_no text
)
returns table (expense_id bigint, transaction_id bigint)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_expense_id bigint;
  v_transaction_id bigint;
  v_account public.company_accounts%rowtype;
  v_balance numeric(14,2);
  v_platform_role text;
begin
  if p_amount <= 0 then
    raise exception 'INVALID_EXPENSE_AMOUNT' using errcode = 'P0001';
  end if;

  if p_category not in ('fuel', 'maintenance', 'payroll', 'parts', 'transport', 'other') then
    raise exception 'INVALID_EXPENSE_CATEGORY' using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from public.sites
    where id = p_site_id and tenant_id = p_tenant_id and status <> 'archived'
  ) then
    raise exception 'SITE_OUT_OF_SCOPE' using errcode = 'P0001';
  end if;

  if p_generator_id is not null and not exists (
    select 1 from public.generators
    where id = p_generator_id and tenant_id = p_tenant_id and site_id = p_site_id
  ) then
    raise exception 'GENERATOR_OUT_OF_SCOPE' using errcode = 'P0001';
  end if;

  if exists (
    select 1 from public.financial_settlements
    where tenant_id = p_tenant_id
      and site_id = p_site_id
      and status = 'locked'
      and period_start <= now()
      and period_end >= now()
  ) then
    raise exception 'FINANCIAL_PERIOD_LOCKED' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(p_company_account_id);

  select * into v_account
  from public.company_accounts
  where id = p_company_account_id
    and tenant_id = p_tenant_id
    and is_active = true
  for update;

  if not found then
    raise exception 'COMPANY_ACCOUNT_NOT_FOUND' using errcode = 'P0001';
  end if;

  if exists (select 1 from public.company_account_sites where account_id = p_company_account_id)
     and not exists (
       select 1 from public.company_account_sites
       where account_id = p_company_account_id
         and tenant_id = p_tenant_id
         and site_id = p_site_id
     ) then
    raise exception 'COMPANY_ACCOUNT_OUT_OF_SCOPE' using errcode = 'P0001';
  end if;

  select v_account.opening_balance + coalesce(sum(
    case
      when transaction_type in ('deposit','transfer_in','collection') then amount
      else -amount
    end
  ), 0)
  into v_balance
  from public.account_transactions
  where tenant_id = p_tenant_id
    and account_id = p_company_account_id;

  if p_amount > v_balance then
    raise exception 'INSUFFICIENT_ACCOUNT_BALANCE' using errcode = 'P0001';
  end if;

  insert into public.expenses (
    tenant_id, site_id, generator_id, company_account_id,
    category, description, amount, reference_no, created_by_user_id
  ) values (
    p_tenant_id, p_site_id, p_generator_id, p_company_account_id,
    p_category, trim(p_description), p_amount, nullif(trim(p_reference_no), ''), p_user_id
  )
  returning id into v_expense_id;

  insert into public.account_transactions (
    tenant_id, account_id, transaction_type, amount, description,
    reference_no, related_expense_id, created_by_user_id
  ) values (
    p_tenant_id, p_company_account_id, 'withdrawal', p_amount,
    trim(p_description), nullif(trim(p_reference_no), ''),
    v_expense_id, p_user_id
  )
  returning id into v_transaction_id;

  select platform_role into v_platform_role
  from public.users where id = p_user_id;

  insert into public.audit_logs (
    tenant_id, site_id, user_id, actor_platform_role,
    entity_type, entity_id, action, after_data
  ) values (
    p_tenant_id, p_site_id, p_user_id, v_platform_role,
    'expense', v_expense_id::text, 'create',
    jsonb_build_object(
      'generatorId', p_generator_id,
      'companyAccountId', p_company_account_id,
      'accountTransactionId', v_transaction_id,
      'category', p_category,
      'amount', p_amount,
      'referenceNo', p_reference_no
    )
  );

  return query select v_expense_id, v_transaction_id;
end;
$$;

revoke execute on function public.powerhub_create_expense_with_account(bigint,bigint,bigint,bigint,bigint,text,text,numeric,text)
  from public, anon, authenticated;
grant execute on function public.powerhub_create_expense_with_account(bigint,bigint,bigint,bigint,bigint,text,text,numeric,text)
  to service_role;
