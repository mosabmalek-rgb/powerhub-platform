-- Harden company-account mutations with the same retry contract used by
-- payments/readings: a stable client operation key replays the original
-- financial effect instead of creating a second one.

alter table public.offline_sync_operations
  drop constraint if exists offline_sync_operations_operation_type_check;

alter table public.offline_sync_operations
  add constraint offline_sync_operations_operation_type_check
  check (
    operation_type = any (array[
      'subscriber_create',
      'subscriber_update',
      'generator_create',
      'generator_update',
      'invoice_issue',
      'payment_create',
      'account_movement_create',
      'account_transfer_create'
    ]::text[])
  );

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
returns table(transaction_id bigint, replayed boolean)
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_account public.company_accounts%rowtype;
  v_balance numeric(14,2);
  v_transaction_id bigint;
  v_platform_role text;
  v_operation public.offline_sync_operations%rowtype;
  v_operation_key text;
begin
  if p_transaction_type not in ('deposit','withdrawal') or p_amount <= 0 then
    raise exception 'INVALID_ACCOUNT_MOVEMENT' using errcode='P0001';
  end if;

  v_operation_key := nullif(btrim(p_client_operation_id), '');

  if v_operation_key is not null then
    perform pg_advisory_xact_lock(
      hashtext('account-movement:' || p_user_id::text || ':' || v_operation_key)::bigint
    );

    select * into v_operation
    from public.offline_sync_operations
    where user_id=p_user_id and client_operation_id=v_operation_key
    limit 1
    for update;

    if found then
      if v_operation.tenant_id<>p_tenant_id
         or v_operation.site_id<>p_site_id
         or v_operation.operation_type<>'account_movement_create'
         or v_operation.response->>'accountId' <> p_account_id::text
         or v_operation.response->>'transactionType' <> p_transaction_type
         or (v_operation.response->>'amount')::numeric is distinct from p_amount then
        raise exception 'ACCOUNT_MOVEMENT_OPERATION_CONFLICT' using errcode='P0001';
      end if;

      return query
        select (v_operation.response->>'transactionId')::bigint, true;
      return;
    end if;
  end if;

  perform pg_advisory_xact_lock(p_account_id);

  select * into v_account
  from public.company_accounts
  where id=p_account_id and tenant_id=p_tenant_id and is_active=true
  for update;

  if not found then
    raise exception 'ACCOUNT_NOT_FOUND' using errcode='P0001';
  end if;

  if exists (
    select 1 from public.company_account_sites
    where account_id=p_account_id
  )
  and not exists (
    select 1 from public.company_account_sites
    where account_id=p_account_id
      and tenant_id=p_tenant_id
      and site_id=p_site_id
  ) then
    raise exception 'ACCOUNT_SITE_OUT_OF_SCOPE' using errcode='P0001';
  end if;

  if exists (
    select 1
    from public.financial_settlements
    where tenant_id=p_tenant_id
      and site_id=p_site_id
      and status='locked'
      and period_start<=now()
      and period_end>=now()
  ) then
    raise exception 'FINANCIAL_PERIOD_LOCKED' using errcode='P0001';
  end if;

  select v_account.opening_balance + coalesce(sum(
    case when transaction_type in ('deposit','transfer_in','collection')
      then amount else -amount end
  ),0)
  into v_balance
  from public.account_transactions
  where tenant_id=p_tenant_id and account_id=p_account_id;

  if p_transaction_type='withdrawal' and p_amount>v_balance then
    raise exception 'INSUFFICIENT_ACCOUNT_BALANCE' using errcode='P0001';
  end if;

  insert into public.account_transactions(
    tenant_id,account_id,transaction_type,amount,description,reference_no,created_by_user_id
  )
  values(
    p_tenant_id,p_account_id,p_transaction_type,p_amount,p_description,p_reference_no,p_user_id
  )
  returning id into v_transaction_id;

  select platform_role into v_platform_role
  from public.users
  where id=p_user_id;

  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data
  )
  values(
    p_tenant_id,p_site_id,p_user_id,v_platform_role,'company_account',
    p_account_id::text,p_transaction_type,
    jsonb_build_object(
      'transactionId',v_transaction_id,
      'amount',p_amount,
      'referenceNo',p_reference_no,
      'clientOperationId',v_operation_key
    )
  );

  if v_operation_key is not null then
    insert into public.offline_sync_operations(
      tenant_id,site_id,user_id,client_operation_id,operation_type,entity_type,entity_id,response
    )
    values(
      p_tenant_id,p_site_id,p_user_id,v_operation_key,'account_movement_create',
      'account_transaction',v_transaction_id,
      jsonb_build_object(
        'transactionId',v_transaction_id,
        'accountId',p_account_id,
        'transactionType',p_transaction_type,
        'amount',p_amount
      )
    );
  end if;

  return query select v_transaction_id,false;
end;
$$;

-- Backward-compatible server-only wrapper for callers that have not yet
-- migrated to the idempotency-aware signature.
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
returns table(transaction_id bigint)
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_transaction_id bigint;
  v_replayed boolean;
begin
  select m.transaction_id,m.replayed
    into v_transaction_id,v_replayed
  from public.powerhub_add_account_movement(
    p_tenant_id,p_site_id,p_user_id,p_account_id,
    p_transaction_type,p_amount,p_description,p_reference_no,null
  ) m;
  return query select v_transaction_id;
end;
$$;

-- PostgreSQL cannot overload the function above by adding a default-only
-- argument, so the idempotency-aware implementation is provided under an
-- explicit ninth argument signature.
create or replace function public.powerhub_add_account_movement(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_account_id bigint,
  p_transaction_type text,
  p_amount numeric,
  p_description text,
  p_reference_no text,
  p_client_operation_id text
)
returns table(transaction_id bigint, replayed boolean)
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_account public.company_accounts%rowtype;
  v_balance numeric(14,2);
  v_transaction_id bigint;
  v_platform_role text;
  v_operation public.offline_sync_operations%rowtype;
  v_operation_key text;
begin
  if p_transaction_type not in ('deposit','withdrawal') or p_amount <= 0 then
    raise exception 'INVALID_ACCOUNT_MOVEMENT' using errcode='P0001';
  end if;

  v_operation_key := nullif(btrim(p_client_operation_id), '');

  if v_operation_key is not null then
    perform pg_advisory_xact_lock(
      hashtext('account-movement:' || p_user_id::text || ':' || v_operation_key)::bigint
    );

    select * into v_operation
    from public.offline_sync_operations
    where user_id=p_user_id and client_operation_id=v_operation_key
    limit 1
    for update;

    if found then
      if v_operation.tenant_id<>p_tenant_id
         or v_operation.site_id<>p_site_id
         or v_operation.operation_type<>'account_movement_create'
         or v_operation.response->>'accountId' <> p_account_id::text
         or v_operation.response->>'transactionType' <> p_transaction_type
         or (v_operation.response->>'amount')::numeric is distinct from p_amount then
        raise exception 'ACCOUNT_MOVEMENT_OPERATION_CONFLICT' using errcode='P0001';
      end if;
      return query select (v_operation.response->>'transactionId')::bigint,true;
      return;
    end if;
  end if;

  perform pg_advisory_xact_lock(p_account_id);

  select * into v_account
  from public.company_accounts
  where id=p_account_id and tenant_id=p_tenant_id and is_active=true
  for update;
  if not found then raise exception 'ACCOUNT_NOT_FOUND' using errcode='P0001'; end if;

  if exists (select 1 from public.company_account_sites where account_id=p_account_id)
     and not exists (
       select 1 from public.company_account_sites
       where account_id=p_account_id and tenant_id=p_tenant_id and site_id=p_site_id
     ) then
    raise exception 'ACCOUNT_SITE_OUT_OF_SCOPE' using errcode='P0001';
  end if;

  if exists (
    select 1 from public.financial_settlements
    where tenant_id=p_tenant_id and site_id=p_site_id and status='locked'
      and period_start<=now() and period_end>=now()
  ) then
    raise exception 'FINANCIAL_PERIOD_LOCKED' using errcode='P0001';
  end if;

  select v_account.opening_balance + coalesce(sum(
    case when transaction_type in ('deposit','transfer_in','collection') then amount else -amount end
  ),0)
  into v_balance
  from public.account_transactions
  where tenant_id=p_tenant_id and account_id=p_account_id;

  if p_transaction_type='withdrawal' and p_amount>v_balance then
    raise exception 'INSUFFICIENT_ACCOUNT_BALANCE' using errcode='P0001';
  end if;

  insert into public.account_transactions(
    tenant_id,account_id,transaction_type,amount,description,reference_no,created_by_user_id
  )
  values(p_tenant_id,p_account_id,p_transaction_type,p_amount,p_description,p_reference_no,p_user_id)
  returning id into v_transaction_id;

  select platform_role into v_platform_role from public.users where id=p_user_id;

  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data
  )
  values(
    p_tenant_id,p_site_id,p_user_id,v_platform_role,'company_account',p_account_id::text,p_transaction_type,
    jsonb_build_object('transactionId',v_transaction_id,'amount',p_amount,'referenceNo',p_reference_no,'clientOperationId',v_operation_key)
  );

  if v_operation_key is not null then
    insert into public.offline_sync_operations(
      tenant_id,site_id,user_id,client_operation_id,operation_type,entity_type,entity_id,response
    )
    values(
      p_tenant_id,p_site_id,p_user_id,v_operation_key,'account_movement_create','account_transaction',v_transaction_id,
      jsonb_build_object('transactionId',v_transaction_id,'accountId',p_account_id,'transactionType',p_transaction_type,'amount',p_amount)
    );
  end if;

  return query select v_transaction_id,false;
end;
$$;


create or replace function public.powerhub_transfer_company_accounts(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_from_account_id bigint,
  p_to_account_id bigint,
  p_amount numeric,
  p_description text,
  p_client_operation_id text
)
returns table(from_transaction_id bigint, to_transaction_id bigint, replayed boolean)
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_source public.company_accounts%rowtype;
  v_destination public.company_accounts%rowtype;
  v_balance numeric(14,2);
  v_from_transaction_id bigint;
  v_to_transaction_id bigint;
  v_platform_role text;
  v_operation public.offline_sync_operations%rowtype;
  v_operation_key text;
begin
  if p_from_account_id=p_to_account_id then
    raise exception 'SAME_TRANSFER_ACCOUNT' using errcode='P0001';
  end if;
  if p_amount<=0 then
    raise exception 'INVALID_TRANSFER_AMOUNT' using errcode='P0001';
  end if;

  v_operation_key := nullif(btrim(p_client_operation_id), '');

  if v_operation_key is not null then
    perform pg_advisory_xact_lock(
      hashtext('account-transfer:' || p_user_id::text || ':' || v_operation_key)::bigint
    );

    select * into v_operation
    from public.offline_sync_operations
    where user_id=p_user_id and client_operation_id=v_operation_key
    limit 1
    for update;

    if found then
      if v_operation.tenant_id<>p_tenant_id
         or v_operation.site_id<>p_site_id
         or v_operation.operation_type<>'account_transfer_create'
         or v_operation.response->>'fromAccountId' <> p_from_account_id::text
         or v_operation.response->>'toAccountId' <> p_to_account_id::text
         or (v_operation.response->>'amount')::numeric is distinct from p_amount then
        raise exception 'ACCOUNT_TRANSFER_OPERATION_CONFLICT' using errcode='P0001';
      end if;
      return query select
        (v_operation.response->>'fromTransactionId')::bigint,
        (v_operation.response->>'toTransactionId')::bigint,
        true;
      return;
    end if;
  end if;

  perform pg_advisory_xact_lock(
    hashtext('company-transfer:' || least(p_from_account_id,p_to_account_id)::text || ':' || greatest(p_from_account_id,p_to_account_id)::text)::bigint
  );

  select * into v_source
  from public.company_accounts
  where id=p_from_account_id and tenant_id=p_tenant_id and is_active=true
  for update;
  select * into v_destination
  from public.company_accounts
  where id=p_to_account_id and tenant_id=p_tenant_id and is_active=true
  for update;

  if v_source.id is null or v_destination.id is null then
    raise exception 'ACCOUNT_NOT_FOUND' using errcode='P0001';
  end if;

  if exists (select 1 from public.company_account_sites where account_id=p_from_account_id)
     and not exists (
       select 1 from public.company_account_sites
       where account_id=p_from_account_id and tenant_id=p_tenant_id and site_id=p_site_id
     ) then
    raise exception 'SOURCE_ACCOUNT_OUT_OF_SCOPE' using errcode='P0001';
  end if;

  if exists (select 1 from public.company_account_sites where account_id=p_to_account_id)
     and not exists (
       select 1 from public.company_account_sites
       where account_id=p_to_account_id and tenant_id=p_tenant_id and site_id=p_site_id
     ) then
    raise exception 'DESTINATION_ACCOUNT_OUT_OF_SCOPE' using errcode='P0001';
  end if;

  if exists (
    select 1 from public.financial_settlements
    where tenant_id=p_tenant_id and site_id=p_site_id and status='locked'
      and period_start<=now() and period_end>=now()
  ) then
    raise exception 'FINANCIAL_PERIOD_LOCKED' using errcode='P0001';
  end if;

  select v_source.opening_balance + coalesce(sum(
    case when transaction_type in ('deposit','transfer_in','collection') then amount else -amount end
  ),0)
  into v_balance
  from public.account_transactions
  where tenant_id=p_tenant_id and account_id=p_from_account_id;

  if p_amount>v_balance then
    raise exception 'INSUFFICIENT_ACCOUNT_BALANCE' using errcode='P0001';
  end if;

  insert into public.account_transactions(
    tenant_id,account_id,related_account_id,transaction_type,amount,description,created_by_user_id
  )
  values(p_tenant_id,p_from_account_id,p_to_account_id,'transfer_out',p_amount,p_description,p_user_id)
  returning id into v_from_transaction_id;

  insert into public.account_transactions(
    tenant_id,account_id,related_account_id,transaction_type,amount,description,created_by_user_id
  )
  values(p_tenant_id,p_to_account_id,p_from_account_id,'transfer_in',p_amount,p_description,p_user_id)
  returning id into v_to_transaction_id;

  select platform_role into v_platform_role from public.users where id=p_user_id;

  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data
  )
  values(
    p_tenant_id,p_site_id,p_user_id,v_platform_role,'company_account',
    p_from_account_id::text,'transfer',
    jsonb_build_object(
      'toAccountId',p_to_account_id,
      'amount',p_amount,
      'fromTransactionId',v_from_transaction_id,
      'toTransactionId',v_to_transaction_id,
      'clientOperationId',v_operation_key
    )
  );

  if v_operation_key is not null then
    insert into public.offline_sync_operations(
      tenant_id,site_id,user_id,client_operation_id,operation_type,entity_type,entity_id,response
    )
    values(
      p_tenant_id,p_site_id,p_user_id,v_operation_key,'account_transfer_create','account_transaction',v_from_transaction_id,
      jsonb_build_object(
        'fromTransactionId',v_from_transaction_id,
        'toTransactionId',v_to_transaction_id,
        'fromAccountId',p_from_account_id,
        'toAccountId',p_to_account_id,
        'amount',p_amount
      )
    );
  end if;

  return query select v_from_transaction_id,v_to_transaction_id,false;
end;
$$;

-- Backward-compatible server-only wrapper for the original transfer signature.
create or replace function public.powerhub_transfer_company_accounts(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_from_account_id bigint,
  p_to_account_id bigint,
  p_amount numeric,
  p_description text
)
returns table(from_transaction_id bigint,to_transaction_id bigint)
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_from bigint;
  v_to bigint;
  v_replayed boolean;
begin
  select x.from_transaction_id,x.to_transaction_id,x.replayed
    into v_from,v_to,v_replayed
  from public.powerhub_transfer_company_accounts(
    p_tenant_id,p_site_id,p_user_id,p_from_account_id,p_to_account_id,p_amount,p_description,null
  ) x;
  return query select v_from,v_to;
end;
$$;

revoke execute on function public.powerhub_add_account_movement(bigint,bigint,bigint,bigint,text,numeric,text,text,text) from public,anon,authenticated;
grant execute on function public.powerhub_add_account_movement(bigint,bigint,bigint,bigint,text,numeric,text,text,text) to service_role;
revoke execute on function public.powerhub_add_account_movement(bigint,bigint,bigint,bigint,text,numeric,text,text) from public,anon,authenticated;
grant execute on function public.powerhub_add_account_movement(bigint,bigint,bigint,bigint,text,numeric,text,text) to service_role;

revoke execute on function public.powerhub_transfer_company_accounts(bigint,bigint,bigint,bigint,bigint,numeric,text,text) from public,anon,authenticated;
grant execute on function public.powerhub_transfer_company_accounts(bigint,bigint,bigint,bigint,bigint,numeric,text,text) to service_role;
revoke execute on function public.powerhub_transfer_company_accounts(bigint,bigint,bigint,bigint,bigint,numeric,text) from public,anon,authenticated;
grant execute on function public.powerhub_transfer_company_accounts(bigint,bigint,bigint,bigint,bigint,numeric,text) to service_role;
