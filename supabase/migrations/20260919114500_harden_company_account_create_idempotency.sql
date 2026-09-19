-- Add true retry identity to company-account creation.
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
      'expense_create',
      'employee_create',
      'site_create',
      'collector_session_open',
      'tariff_create',
      'company_account_create'
    ]::text[])
  );

create or replace function public.powerhub_create_company_account_online(
  p_tenant_id bigint, p_site_id bigint, p_user_id bigint, p_name text,
  p_account_type text, p_phone_number text, p_opening_balance numeric,
  p_color text, p_site_ids bigint[], p_client_operation_id text
)
returns table(account_id bigint, replayed boolean)
language plpgsql
set search_path = public, pg_temp
as $function$
declare
  v_operation_key text := nullif(btrim(p_client_operation_id), '');
  v_operation public.offline_sync_operations%rowtype;
  v_account_id bigint;
  v_site_ids bigint[];
begin
  if v_operation_key is null then
    raise exception 'CLIENT_OPERATION_REQUIRED' using errcode='P0001';
  end if;

  v_site_ids := array(
    select distinct site_id from unnest(coalesce(p_site_ids, '{}'::bigint[])) as site_id
    order by site_id
  );
  if coalesce(array_length(v_site_ids, 1), 0) = 0 then
    raise exception 'ACCOUNT_SITES_REQUIRED' using errcode='P0001';
  end if;

  perform pg_advisory_xact_lock(
    hashtext('company-account-create:' || p_user_id::text || ':' || v_operation_key)::bigint
  );

  select * into v_operation
  from public.offline_sync_operations
  where user_id = p_user_id and client_operation_id = v_operation_key
  limit 1 for update;

  if found then
    if v_operation.tenant_id <> p_tenant_id
       or v_operation.site_id <> p_site_id
       or v_operation.operation_type <> 'company_account_create'
       or v_operation.response->>'accountName' <> btrim(p_name)
       or v_operation.response->>'accountType' <> p_account_type
       or v_operation.response->>'phoneNumber' <> btrim(p_phone_number)
       or (v_operation.response->>'openingBalance')::numeric is distinct from p_opening_balance
       or v_operation.response->'siteIds' is distinct from to_jsonb(v_site_ids) then
      raise exception 'COMPANY_ACCOUNT_OPERATION_CONFLICT' using errcode='P0001';
    end if;
    return query select (v_operation.response->>'accountId')::bigint, true;
    return;
  end if;

  select x.account_id into v_account_id
  from public.powerhub_create_company_account(
    p_tenant_id, p_site_id, p_user_id, btrim(p_name), p_account_type,
    btrim(p_phone_number), p_opening_balance, p_color, v_site_ids
  ) x limit 1;

  if v_account_id is null then
    raise exception 'COMPANY_ACCOUNT_CREATE_FAILED' using errcode='P0001';
  end if;

  insert into public.offline_sync_operations(
    tenant_id, site_id, user_id, client_operation_id, operation_type,
    entity_type, entity_id, response
  )
  values(
    p_tenant_id, p_site_id, p_user_id, v_operation_key, 'company_account_create',
    'company_account', v_account_id,
    jsonb_build_object(
      'accountId', v_account_id, 'accountName', btrim(p_name),
      'accountType', p_account_type, 'phoneNumber', btrim(p_phone_number),
      'openingBalance', p_opening_balance, 'siteIds', to_jsonb(v_site_ids)
    )
  );

  return query select v_account_id, false;
end;
$function$;

revoke execute on function public.powerhub_create_company_account_online(bigint,bigint,bigint,text,text,text,numeric,text,bigint[],text)
  from public, anon, authenticated;
grant execute on function public.powerhub_create_company_account_online(bigint,bigint,bigint,text,text,text,numeric,text,bigint[],text)
  to service_role;
