-- Harden expense creation against timeout/retry duplication.
-- Reuse the existing operation ledger instead of introducing another table.

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
      'account_transfer_create',
      'expense_create'
    ]::text[])
  );

create or replace function public.powerhub_create_expense(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_generator_id bigint,
  p_category text,
  p_description text,
  p_amount numeric,
  p_reference_no text,
  p_client_operation_id text
)
returns table(expense_id bigint, replayed boolean)
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_expense_id bigint;
  v_platform_role text;
  v_operation public.offline_sync_operations%rowtype;
  v_operation_key text;
begin
  if p_amount <= 0 then
    raise exception 'INVALID_EXPENSE_AMOUNT' using errcode='P0001';
  end if;
  if p_category not in ('fuel','maintenance','payroll','parts','transport','other') then
    raise exception 'INVALID_EXPENSE_CATEGORY' using errcode='P0001';
  end if;
  if not exists(
    select 1 from public.sites
    where id=p_site_id and tenant_id=p_tenant_id and status<>'archived'
  ) then
    raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001';
  end if;

  v_operation_key := nullif(btrim(p_client_operation_id), '');

  if v_operation_key is not null then
    perform pg_advisory_xact_lock(
      hashtext('expense-create:' || p_user_id::text || ':' || v_operation_key)::bigint
    );

    select * into v_operation
    from public.offline_sync_operations
    where user_id=p_user_id and client_operation_id=v_operation_key
    limit 1
    for update;

    if found then
      if v_operation.tenant_id<>p_tenant_id
         or v_operation.site_id<>p_site_id
         or v_operation.operation_type<>'expense_create'
         or v_operation.response->>'category' <> p_category
         or v_operation.response->>'description' <> p_description
         or (v_operation.response->>'amount')::numeric is distinct from p_amount
         or coalesce(v_operation.response->>'generatorId','') <> coalesce(p_generator_id::text,'')
         or coalesce(v_operation.response->>'referenceNo','') <> coalesce(p_reference_no,'') then
        raise exception 'EXPENSE_OPERATION_CONFLICT' using errcode='P0001';
      end if;

      return query select (v_operation.response->>'expenseId')::bigint, true;
      return;
    end if;
  end if;

  perform pg_advisory_xact_lock(p_site_id);
  perform public.powerhub_assert_financial_period_open(p_tenant_id,p_site_id,now());

  if p_generator_id is not null and not exists(
    select 1 from public.generators
    where id=p_generator_id and tenant_id=p_tenant_id and site_id=p_site_id
  ) then
    raise exception 'GENERATOR_OUT_OF_SCOPE' using errcode='P0001';
  end if;

  insert into public.expenses(
    tenant_id,site_id,generator_id,category,description,amount,reference_no,created_by_user_id
  )
  values(
    p_tenant_id,p_site_id,p_generator_id,p_category,p_description,p_amount,p_reference_no,p_user_id
  )
  returning id into v_expense_id;

  select platform_role into v_platform_role
  from public.users where id=p_user_id;

  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data
  )
  values(
    p_tenant_id,p_site_id,p_user_id,v_platform_role,'expense',v_expense_id::text,'create',
    jsonb_build_object(
      'generatorId',p_generator_id,
      'category',p_category,
      'description',p_description,
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
      p_tenant_id,p_site_id,p_user_id,v_operation_key,'expense_create','expense',v_expense_id,
      jsonb_build_object(
        'expenseId',v_expense_id,
        'generatorId',p_generator_id,
        'category',p_category,
        'description',p_description,
        'amount',p_amount,
        'referenceNo',p_reference_no
      )
    );
  end if;

  return query select v_expense_id,false;
end;
$$;

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
returns table(expense_id bigint)
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_expense_id bigint;
  v_replayed boolean;
begin
  select x.expense_id,x.replayed
  into v_expense_id,v_replayed
  from public.powerhub_create_expense(
    p_tenant_id,p_site_id,p_user_id,p_generator_id,p_category,p_description,p_amount,p_reference_no,null
  ) x;

  return query select v_expense_id;
end;
$$;

revoke execute on function public.powerhub_create_expense(bigint,bigint,bigint,bigint,text,text,numeric,text,text) from public,anon,authenticated;
grant execute on function public.powerhub_create_expense(bigint,bigint,bigint,bigint,text,text,numeric,text,text) to service_role;

revoke execute on function public.powerhub_create_expense(bigint,bigint,bigint,bigint,text,text,numeric,text) from public,anon,authenticated;
grant execute on function public.powerhub_create_expense(bigint,bigint,bigint,bigint,text,text,numeric,text) to service_role;
