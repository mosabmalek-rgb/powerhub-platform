create or replace function public.powerhub_create_company_account(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_name text,
  p_account_type text,
  p_phone_number text,
  p_opening_balance numeric,
  p_color text,
  p_site_ids bigint[]
)
returns table (account_id bigint)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_account_id bigint;
  v_platform_role text;
begin
  if coalesce(array_length(p_site_ids, 1), 0) = 0 then raise exception 'ACCOUNT_SITES_REQUIRED' using errcode = 'P0001'; end if;
  if p_opening_balance < 0 then raise exception 'INVALID_OPENING_BALANCE' using errcode = 'P0001'; end if;
  if p_account_type not in ('cash', 'jawwal_pay', 'palpay', 'bank_of_palestine', 'other') then raise exception 'INVALID_ACCOUNT_TYPE' using errcode = 'P0001'; end if;
  if (select count(*) from public.sites where tenant_id = p_tenant_id and id = any(p_site_ids)) <> cardinality(p_site_ids) then
    raise exception 'ACCOUNT_SITE_OUT_OF_SCOPE' using errcode = 'P0001';
  end if;
  insert into public.company_accounts (tenant_id, name, account_type, phone_number, opening_balance, color)
  values (p_tenant_id, p_name, p_account_type, p_phone_number, p_opening_balance, coalesce(p_color, '#64748b'))
  returning id into v_account_id;
  insert into public.company_account_sites (tenant_id, account_id, site_id)
  select p_tenant_id, v_account_id, site_id from unnest(p_site_ids) as site_id;
  select platform_role into v_platform_role from public.users where id = p_user_id;
  insert into public.audit_logs (tenant_id, site_id, user_id, actor_platform_role, entity_type, entity_id, action, after_data)
  values (p_tenant_id, p_site_id, p_user_id, v_platform_role, 'company_account', v_account_id::text, 'create', jsonb_build_object('name', p_name, 'accountType', p_account_type, 'siteIds', p_site_ids, 'openingBalance', p_opening_balance));
  return query select v_account_id;
end;
$$;

create or replace function public.powerhub_add_account_movement(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_account_id bigint,
  p_transaction_type text,
  p_amount numeric,
  p_description text,
  p_reference_no text
)
returns table (transaction_id bigint)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_account public.company_accounts%rowtype;
  v_balance numeric(14,2);
  v_transaction_id bigint;
  v_platform_role text;
begin
  if p_transaction_type not in ('deposit', 'withdrawal') or p_amount <= 0 then raise exception 'INVALID_ACCOUNT_MOVEMENT' using errcode = 'P0001'; end if;
  perform pg_advisory_xact_lock(p_account_id);
  select * into v_account from public.company_accounts where id = p_account_id and tenant_id = p_tenant_id for update;
  if not found then raise exception 'ACCOUNT_NOT_FOUND' using errcode = 'P0001'; end if;
  if exists (select 1 from public.company_account_sites where account_id = p_account_id)
     and not exists (select 1 from public.company_account_sites where account_id = p_account_id and tenant_id = p_tenant_id and site_id = p_site_id) then raise exception 'ACCOUNT_SITE_OUT_OF_SCOPE' using errcode = 'P0001'; end if;
  if exists (select 1 from public.financial_settlements where tenant_id = p_tenant_id and site_id = p_site_id and status = 'locked' and period_start <= now() and period_end >= now()) then raise exception 'FINANCIAL_PERIOD_LOCKED' using errcode = 'P0001'; end if;
  select v_account.opening_balance + coalesce(sum(case when transaction_type in ('deposit','transfer_in','collection') then amount else -amount end), 0) into v_balance from public.account_transactions where tenant_id = p_tenant_id and account_id = p_account_id;
  if p_transaction_type = 'withdrawal' and p_amount > v_balance then raise exception 'INSUFFICIENT_ACCOUNT_BALANCE' using errcode = 'P0001'; end if;
  insert into public.account_transactions (tenant_id, account_id, transaction_type, amount, description, reference_no, created_by_user_id)
  values (p_tenant_id, p_account_id, p_transaction_type, p_amount, p_description, p_reference_no, p_user_id)
  returning id into v_transaction_id;
  select platform_role into v_platform_role from public.users where id = p_user_id;
  insert into public.audit_logs (tenant_id, site_id, user_id, actor_platform_role, entity_type, entity_id, action, after_data)
  values (p_tenant_id, p_site_id, p_user_id, v_platform_role, 'company_account', p_account_id::text, p_transaction_type, jsonb_build_object('transactionId', v_transaction_id, 'amount', p_amount, 'referenceNo', p_reference_no));
  return query select v_transaction_id;
end;
$$;

create or replace function public.powerhub_transfer_company_accounts(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_from_account_id bigint,
  p_to_account_id bigint,
  p_amount numeric,
  p_description text
)
returns table (from_transaction_id bigint, to_transaction_id bigint)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_source public.company_accounts%rowtype;
  v_destination public.company_accounts%rowtype;
  v_balance numeric(14,2);
  v_from_transaction_id bigint;
  v_to_transaction_id bigint;
  v_platform_role text;
begin
  if p_from_account_id = p_to_account_id then raise exception 'SAME_TRANSFER_ACCOUNT' using errcode = 'P0001'; end if;
  if p_amount <= 0 then raise exception 'INVALID_TRANSFER_AMOUNT' using errcode = 'P0001'; end if;
  perform pg_advisory_xact_lock(least(p_from_account_id, p_to_account_id));
  perform pg_advisory_xact_lock(greatest(p_from_account_id, p_to_account_id));
  select * into v_source from public.company_accounts where id = p_from_account_id and tenant_id = p_tenant_id for update;
  select * into v_destination from public.company_accounts where id = p_to_account_id and tenant_id = p_tenant_id for update;
  if v_source.id is null or v_destination.id is null then raise exception 'ACCOUNT_NOT_FOUND' using errcode = 'P0001'; end if;
  if exists (select 1 from public.financial_settlements where tenant_id = p_tenant_id and site_id = p_site_id and status = 'locked' and period_start <= now() and period_end >= now()) then raise exception 'FINANCIAL_PERIOD_LOCKED' using errcode = 'P0001'; end if;
  select v_source.opening_balance + coalesce(sum(case when transaction_type in ('deposit','transfer_in','collection') then amount else -amount end), 0) into v_balance from public.account_transactions where tenant_id = p_tenant_id and account_id = p_from_account_id;
  if p_amount > v_balance then raise exception 'INSUFFICIENT_ACCOUNT_BALANCE' using errcode = 'P0001'; end if;
  insert into public.account_transactions (tenant_id, account_id, related_account_id, transaction_type, amount, description, created_by_user_id)
  values (p_tenant_id, p_from_account_id, p_to_account_id, 'transfer_out', p_amount, p_description, p_user_id) returning id into v_from_transaction_id;
  insert into public.account_transactions (tenant_id, account_id, related_account_id, transaction_type, amount, description, created_by_user_id)
  values (p_tenant_id, p_to_account_id, p_from_account_id, 'transfer_in', p_amount, p_description, p_user_id) returning id into v_to_transaction_id;
  select platform_role into v_platform_role from public.users where id = p_user_id;
  insert into public.audit_logs (tenant_id, site_id, user_id, actor_platform_role, entity_type, entity_id, action, after_data)
  values (p_tenant_id, p_site_id, p_user_id, v_platform_role, 'company_account', p_from_account_id::text, 'transfer', jsonb_build_object('toAccountId', p_to_account_id, 'amount', p_amount, 'fromTransactionId', v_from_transaction_id, 'toTransactionId', v_to_transaction_id));
  return query select v_from_transaction_id, v_to_transaction_id;
end;
$$;

revoke execute on function public.powerhub_create_company_account(bigint, bigint, bigint, text, text, text, numeric, text, bigint[]) from public, anon, authenticated;
revoke execute on function public.powerhub_add_account_movement(bigint, bigint, bigint, bigint, text, numeric, text, text) from public, anon, authenticated;
revoke execute on function public.powerhub_transfer_company_accounts(bigint, bigint, bigint, bigint, bigint, numeric, text) from public, anon, authenticated;
grant execute on function public.powerhub_create_company_account(bigint, bigint, bigint, text, text, text, numeric, text, bigint[]) to service_role;
grant execute on function public.powerhub_add_account_movement(bigint, bigint, bigint, bigint, text, numeric, text, text) to service_role;
grant execute on function public.powerhub_transfer_company_accounts(bigint, bigint, bigint, bigint, bigint, numeric, text) to service_role;
