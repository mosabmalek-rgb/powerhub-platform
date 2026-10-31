-- Idempotent replay boundary for offline expense intents.
-- The existing RPC remains the only code path that posts the expense and account withdrawal.
create table if not exists public.powerhub_expense_offline_operation_results (
  tenant_id bigint not null,
  operation_key uuid not null,
  site_id bigint not null,
  user_id bigint not null,
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{32}$'),
  expense_id bigint not null references public.expenses(id) on delete restrict,
  transaction_id bigint not null references public.account_transactions(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  primary key (tenant_id, operation_key)
);
create index if not exists powerhub_expense_offline_operation_recent_idx
  on public.powerhub_expense_offline_operation_results(tenant_id,site_id,created_at desc);
alter table public.powerhub_expense_offline_operation_results enable row level security;
revoke all on table public.powerhub_expense_offline_operation_results from public,anon,authenticated;
grant all on table public.powerhub_expense_offline_operation_results to service_role;

create or replace function public.powerhub_create_expense_with_account_idempotent(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_generator_id bigint,
  p_company_account_id bigint,
  p_category text,
  p_description text,
  p_amount numeric,
  p_reference_no text,
  p_client_operation_id uuid
)
returns table(expense_id bigint,transaction_id bigint,replayed boolean)
language plpgsql
security invoker
set search_path=public,pg_temp
as $$
declare
  v_existing public.powerhub_expense_offline_operation_results%rowtype;
  v_created record;
  v_hash text;
begin
  if p_client_operation_id is null then
    raise exception 'INVALID_EXPENSE_OPERATION_KEY' using errcode='P0001';
  end if;
  v_hash:=md5(jsonb_build_object(
    'tenantId',p_tenant_id,'siteId',p_site_id,'userId',p_user_id,
    'generatorId',p_generator_id,'companyAccountId',p_company_account_id,
    'category',p_category,'description',trim(p_description),'amount',p_amount,
    'referenceNo',nullif(trim(p_reference_no),'')
  )::text);
  perform pg_advisory_xact_lock(hashtextextended(
    p_tenant_id::text||':expense-offline:'||p_client_operation_id::text,0
  ));
  select r.* into v_existing
  from public.powerhub_expense_offline_operation_results r
  where r.tenant_id=p_tenant_id and r.operation_key=p_client_operation_id
  for update;
  if found then
    if v_existing.site_id<>p_site_id or v_existing.user_id<>p_user_id or v_existing.payload_hash<>v_hash then
      raise exception 'IDEMPOTENCY_KEY_REUSED' using errcode='P0001';
    end if;
    return query select v_existing.expense_id,v_existing.transaction_id,true;
    return;
  end if;

  select r.expense_id,r.transaction_id into v_created
  from public.powerhub_create_expense_with_account(
    p_tenant_id,p_site_id,p_user_id,p_generator_id,p_company_account_id,
    p_category,p_description,p_amount,p_reference_no
  ) r;
  if v_created.expense_id is null or v_created.transaction_id is null then
    raise exception 'EXPENSE_RESULT_MISSING' using errcode='P0001';
  end if;
  insert into public.powerhub_expense_offline_operation_results(
    tenant_id,operation_key,site_id,user_id,payload_hash,expense_id,transaction_id
  ) values (
    p_tenant_id,p_client_operation_id,p_site_id,p_user_id,v_hash,
    v_created.expense_id,v_created.transaction_id
  );
  return query select v_created.expense_id,v_created.transaction_id,false;
end;
$$;
alter function public.powerhub_create_expense_with_account_idempotent(bigint,bigint,bigint,bigint,bigint,text,text,numeric,text,uuid) owner to postgres;
revoke all on function public.powerhub_create_expense_with_account_idempotent(bigint,bigint,bigint,bigint,bigint,text,text,numeric,text,uuid) from public,anon,authenticated;
grant execute on function public.powerhub_create_expense_with_account_idempotent(bigint,bigint,bigint,bigint,bigint,text,text,numeric,text,uuid) to service_role;
