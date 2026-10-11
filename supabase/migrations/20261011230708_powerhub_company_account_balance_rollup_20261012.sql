-- Keep company account dashboard balances accurate regardless of ledger size.
-- Transaction details can be bounded, but balances aggregate every ledger row.
create or replace function public.powerhub_company_account_balance_rollup(
  p_tenant_id bigint,
  p_account_ids bigint[]
)
returns table (account_id bigint, balance numeric)
language sql
stable
security definer
set search_path = ''
as $$
  select ca.id,
         ca.opening_balance + coalesce(sum(
           case when atx.transaction_type in ('deposit', 'transfer_in', 'collection')
             then atx.amount else -atx.amount end
         ), 0)
  from public.company_accounts ca
  left join public.account_transactions atx
    on atx.tenant_id = ca.tenant_id and atx.account_id = ca.id
  where ca.tenant_id = p_tenant_id and ca.is_active = true
    and ca.id = any(coalesce(p_account_ids, array[]::bigint[]))
  group by ca.id, ca.opening_balance;
$$;
revoke all on function public.powerhub_company_account_balance_rollup(bigint, bigint[]) from public, anon, authenticated;
grant execute on function public.powerhub_company_account_balance_rollup(bigint, bigint[]) to service_role;
