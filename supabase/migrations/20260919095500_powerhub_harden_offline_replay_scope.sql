-- Defense-in-depth for offline replay scope and concurrent retry serialization.
create or replace function public.powerhub_create_payment(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_subscriber_id bigint,
  p_invoice_id bigint,
  p_payment_no text,
  p_amount numeric,
  p_payment_method text,
  p_company_account_id bigint,
  p_transfer_from_account text,
  p_transfer_from_type text,
  p_reference_no text,
  p_receipt_image_key text,
  p_receipt_image_hash text,
  p_collector_session_id bigint,
  p_client_operation_id uuid
)
returns table (payment_id bigint, replayed boolean)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_invoice public.invoices%rowtype;
  v_account public.company_accounts%rowtype;
  v_payment_id bigint;
  v_new_paid numeric(14,2);
  v_new_balance numeric(14,2);
  v_invoice_status text;
  v_platform_role text;
  v_response jsonb;
begin
  if p_amount <= 0 then raise exception 'INVALID_PAYMENT_AMOUNT' using errcode = 'P0001'; end if;
  if p_payment_method not in ('cash', 'jawwal_pay', 'palpay', 'bank_of_palestine', 'wallet', 'bank_transfer', 'card') then raise exception 'INVALID_PAYMENT_METHOD' using errcode = 'P0001'; end if;
  if (p_transfer_from_account is null) <> (p_transfer_from_type is null) then raise exception 'INVALID_TRANSFER_SOURCE' using errcode = 'P0001'; end if;
  if p_client_operation_id is not null then
    perform pg_advisory_xact_lock(hashtext('payment-create:' || p_user_id::text || ':' || p_client_operation_id::text));
    select response into v_response from public.offline_sync_operations
    where user_id = p_user_id and client_operation_id = p_client_operation_id::text limit 1;
    if found then
      if not exists (
        select 1 from public.offline_sync_operations op
        where op.user_id = p_user_id
          and op.client_operation_id = p_client_operation_id::text
          and op.tenant_id = p_tenant_id
          and op.site_id = p_site_id
          and op.operation_type = 'payment_create'
      ) then raise exception 'PAYMENT_OPERATION_SCOPE_CONFLICT' using errcode = 'P0001'; end if;
      if coalesce(v_response->>'id', '') = '' then raise exception 'INVALID_PAYMENT_OPERATION_REPLAY' using errcode = 'P0001'; end if;
      return query select (v_response->>'id')::bigint, true;
      return;
    end if;
    select id into v_payment_id from public.payments
    where client_operation_id = p_client_operation_id::text
      and tenant_id = p_tenant_id
      and site_id = p_site_id
    limit 1;
    if found then
      return query select v_payment_id, true;
      return;
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtext(p_payment_no));
  if exists (select 1 from public.payments where payment_no = p_payment_no) then raise exception 'DUPLICATE_PAYMENT_NO' using errcode = 'P0001'; end if;
  if exists (select 1 from public.financial_settlements where tenant_id = p_tenant_id and site_id = p_site_id and status = 'locked' and period_start <= now() and period_end >= now()) then
    raise exception 'FINANCIAL_PERIOD_LOCKED' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.subscribers where id = p_subscriber_id and tenant_id = p_tenant_id and site_id = p_site_id) then raise exception 'SUBSCRIBER_OUT_OF_SCOPE' using errcode = 'P0001'; end if;
  select * into v_account from public.company_accounts where id = p_company_account_id and tenant_id = p_tenant_id and is_active = true for update;
  if not found then raise exception 'COMPANY_ACCOUNT_NOT_FOUND' using errcode = 'P0001'; end if;
  if v_account.account_type <> p_payment_method then raise exception 'COMPANY_ACCOUNT_TYPE_MISMATCH' using errcode = 'P0001'; end if;
  if exists (select 1 from public.company_account_sites where account_id = v_account.id)
     and not exists (select 1 from public.company_account_sites where account_id = v_account.id and site_id = p_site_id and tenant_id = p_tenant_id) then
    raise exception 'COMPANY_ACCOUNT_OUT_OF_SCOPE' using errcode = 'P0001';
  end if;
  if p_collector_session_id is not null and not exists (
    select 1 from public.collector_sessions
    where id = p_collector_session_id and tenant_id = p_tenant_id and site_id = p_site_id and collector_user_id = p_user_id and status = 'open'
  ) then raise exception 'COLLECTOR_SESSION_NOT_OPEN' using errcode = 'P0001'; end if;

  if p_invoice_id is not null then
    perform pg_advisory_xact_lock(p_invoice_id);
    select * into v_invoice from public.invoices
    where id = p_invoice_id and tenant_id = p_tenant_id and site_id = p_site_id and subscriber_id = p_subscriber_id for update;
    if not found then raise exception 'INVOICE_OUT_OF_SCOPE' using errcode = 'P0001'; end if;
    if v_invoice.status in ('draft', 'cancelled') then raise exception 'INVOICE_NOT_COLLECTIBLE' using errcode = 'P0001'; end if;
    if p_amount > v_invoice.balance_due then raise exception 'INVOICE_BALANCE_CONFLICT' using errcode = 'P0001'; end if;
    v_new_paid := v_invoice.paid_amount + p_amount;
    v_new_balance := greatest(0, v_invoice.total_amount - v_new_paid);
    v_invoice_status := case when v_new_balance = 0 then 'paid' else 'partially_paid' end;
    update public.invoices set paid_amount = v_new_paid, balance_due = v_new_balance, status = v_invoice_status, updated_at = now() where id = v_invoice.id;
  end if;

  insert into public.payments (
    tenant_id, site_id, subscriber_id, invoice_id, payment_no, client_operation_id, amount, payment_method,
    transfer_from_account, transfer_from_type, transfer_to_account, transfer_to_type, reference_no,
    receipt_image_key, receipt_image_hash, collected_by_user_id, collector_session_id
  ) values (
    p_tenant_id, p_site_id, p_subscriber_id, p_invoice_id, p_payment_no, p_client_operation_id::text, p_amount, p_payment_method,
    p_transfer_from_account, p_transfer_from_type, v_account.phone_number,
    case when v_account.account_type in ('jawwal_pay', 'palpay', 'bank_of_palestine') then v_account.account_type else null end,
    p_reference_no, p_receipt_image_key, p_receipt_image_hash, p_user_id, p_collector_session_id
  ) returning id into v_payment_id;
  insert into public.account_transactions (tenant_id, account_id, transaction_type, amount, description, reference_no, related_payment_id, created_by_user_id)
  values (p_tenant_id, v_account.id, 'collection', p_amount, format('تحصيل الفاتورة %s', p_payment_no), p_reference_no, v_payment_id, p_user_id);
  select platform_role into v_platform_role from public.users where id = p_user_id;
  insert into public.audit_logs (tenant_id, site_id, user_id, actor_platform_role, entity_type, entity_id, action, after_data, metadata)
  values (
    p_tenant_id, p_site_id, p_user_id, v_platform_role, 'payment', v_payment_id::text, 'create',
    jsonb_build_object('paymentNo', p_payment_no, 'amount', p_amount, 'invoiceId', p_invoice_id, 'companyAccountId', v_account.id, 'paymentMethod', p_payment_method),
    jsonb_build_object('collectorSessionId', p_collector_session_id, 'receiptImageAttached', p_receipt_image_key is not null)
  );
  if p_client_operation_id is not null then
    insert into public.offline_sync_operations (tenant_id, site_id, user_id, client_operation_id, operation_type, entity_type, entity_id, response)
    values (p_tenant_id, p_site_id, p_user_id, p_client_operation_id::text, 'payment_create', 'payment', v_payment_id, jsonb_build_object('id', v_payment_id));
  end if;
  return query select v_payment_id, false;
end;
$$;

revoke execute on function public.powerhub_create_payment(bigint, bigint, bigint, bigint, bigint, text, numeric, text, bigint, text, text, text, text, text, bigint, uuid) from public, anon, authenticated;
grant execute on function public.powerhub_create_payment(bigint, bigint, bigint, bigint, bigint, text, numeric, text, bigint, text, text, text, text, text, bigint, uuid) to service_role;

create or replace function public.powerhub_issue_invoice_from_reading(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_reading_id bigint,
  p_tariff_id bigint,
  p_billing_period text,
  p_due_date timestamptz,
  p_discount_amount numeric,
  p_client_operation_id uuid
)
returns table(invoice_id bigint,invoice_no text,total_amount numeric,replayed boolean)
language plpgsql security invoker set search_path=public,pg_temp as $$
declare
  v_reading public.meter_readings%rowtype;
  v_subscriber public.subscribers%rowtype;
  v_site public.sites%rowtype;
  v_tariff public.tariffs%rowtype;
  v_existing public.invoices%rowtype;
  v_response jsonb;
  v_invoice_id bigint;
  v_invoice_no text;
  v_energy_amount numeric(14,2);
  v_tax_amount numeric(14,2);
  v_total_amount numeric(14,2);
  v_platform_role text;
  v_sequence integer;
  v_invoice_year integer;
begin
  if p_billing_period !~ '^[0-9]{4}-[0-9]{2}$' then raise exception 'INVALID_BILLING_PERIOD' using errcode='P0001'; end if;
  if p_discount_amount<0 then raise exception 'INVALID_DISCOUNT' using errcode='P0001'; end if;
  if p_client_operation_id is not null then
    perform pg_advisory_xact_lock(hashtext('invoice-issue:' || p_user_id::text || ':' || p_client_operation_id::text));
    select response into v_response from public.offline_sync_operations where user_id=p_user_id and client_operation_id=p_client_operation_id::text limit 1;
    if found then
      if not exists (
        select 1 from public.offline_sync_operations op
        where op.user_id=p_user_id
          and op.client_operation_id=p_client_operation_id::text
          and op.tenant_id=p_tenant_id
          and op.site_id=p_site_id
          and op.operation_type='invoice_issue'
      ) then raise exception 'INVOICE_OPERATION_SCOPE_CONFLICT' using errcode='P0001'; end if;
      if coalesce(v_response->>'id','')='' or coalesce(v_response->>'invoiceNo','')='' then raise exception 'INVALID_INVOICE_OPERATION_REPLAY' using errcode='P0001'; end if;
      return query select (v_response->>'id')::bigint,v_response->>'invoiceNo',(v_response->>'totalAmount')::numeric,true;
      return;
    end if;
  end if;

  perform pg_advisory_xact_lock(p_reading_id);
  select r.* into v_reading from public.meter_readings r where r.id=p_reading_id and r.tenant_id=p_tenant_id for update;
  if not found then raise exception 'READING_OUT_OF_SCOPE' using errcode='P0001'; end if;
  select * into v_subscriber from public.subscribers where id=v_reading.subscriber_id and tenant_id=p_tenant_id and site_id=p_site_id;
  if not found then raise exception 'READING_OUT_OF_SCOPE' using errcode='P0001'; end if;
  select * into v_site from public.sites where id=p_site_id and tenant_id=p_tenant_id;
  if not found then raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001'; end if;
  if v_reading.status<>'approved' then raise exception 'READING_NOT_APPROVED' using errcode='P0001'; end if;
  select * into v_existing from public.invoices where reading_id=p_reading_id limit 1;
  if found then
    if v_existing.tenant_id<>p_tenant_id or v_existing.site_id<>p_site_id then raise exception 'INVOICE_OUT_OF_SCOPE' using errcode='P0001'; end if;
    return query select v_existing.id,v_existing.invoice_no,v_existing.total_amount,true; return;
  end if;
  if exists(select 1 from public.financial_settlements where tenant_id=p_tenant_id and site_id=p_site_id and status='locked' and period_start<=p_due_date and period_end>=p_due_date) then raise exception 'FINANCIAL_PERIOD_LOCKED' using errcode='P0001'; end if;
  select * into v_tariff from public.tariffs where id=p_tariff_id and tenant_id=p_tenant_id and site_id=p_site_id and is_active=true;
  if not found then raise exception 'TARIFF_NOT_FOUND' using errcode='P0001'; end if;

  -- Allocate from a persistent per-year sequence. The row-level upsert serializes
  -- concurrent issuances and, unlike COUNT(invoices), never reuses a deleted number.
  v_invoice_year:=left(p_billing_period,4)::integer;
  insert into public.powerhub_invoice_sequences(invoice_year,next_sequence)
  values(v_invoice_year,2)
  on conflict (invoice_year) do update
    set next_sequence=public.powerhub_invoice_sequences.next_sequence+1
    where public.powerhub_invoice_sequences.next_sequence<=9999
  returning next_sequence-1 into v_sequence;
  if not found or v_sequence is null or v_sequence>9999 then raise exception 'INVOICE_SEQUENCE_EXHAUSTED' using errcode='P0001'; end if;
  v_invoice_no:=format('INV-%s-%s',v_invoice_year,lpad(v_sequence::text,4,'0'));

  v_energy_amount:=round(coalesce(v_reading.consumption_kwh,0)*v_tariff.price_per_kwh,2);
  v_tax_amount:=round((v_energy_amount+v_tariff.fixed_fee)*(v_tariff.tax_rate/100),2);
  v_total_amount:=greatest(0,round(v_energy_amount+v_tariff.fixed_fee+v_tax_amount-p_discount_amount,2));
  insert into public.invoices(tenant_id,site_id,subscriber_id,reading_id,tariff_id,invoice_no,client_operation_id,billing_period,due_date,previous_reading,current_reading,consumption_kwh,price_per_kwh,fixed_fee,tax_amount,discount_amount,total_amount,balance_due,status,created_by_user_id)
  values(p_tenant_id,p_site_id,v_subscriber.id,p_reading_id,v_tariff.id,v_invoice_no,p_client_operation_id::text,p_billing_period,p_due_date,v_reading.previous_reading_value,v_reading.reading_value,coalesce(v_reading.consumption_kwh,0),v_tariff.price_per_kwh,v_tariff.fixed_fee,v_tax_amount,p_discount_amount,v_total_amount,v_total_amount,'issued',p_user_id)
  returning id into v_invoice_id;

  insert into public.invoice_lines(tenant_id,invoice_id,line_type,description,quantity,unit_price,amount,display_order)
  values(p_tenant_id,v_invoice_id,'energy','استهلاك الكهرباء',coalesce(v_reading.consumption_kwh,0),v_tariff.price_per_kwh,v_energy_amount,1),(p_tenant_id,v_invoice_id,'fixed_fee','رسم ثابت',1,v_tariff.fixed_fee,v_tariff.fixed_fee,2),(p_tenant_id,v_invoice_id,'tax','الضريبة',1,v_tariff.tax_rate,v_tax_amount,3);
  if p_discount_amount>0 then insert into public.invoice_lines(tenant_id,invoice_id,line_type,description,quantity,unit_price,amount,display_order) values(p_tenant_id,v_invoice_id,'discount','خصم',1,p_discount_amount,p_discount_amount,4); end if;
  select platform_role into v_platform_role from public.users where id=p_user_id;
  insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data)
  values(p_tenant_id,p_site_id,p_user_id,v_platform_role,'invoice',v_invoice_id::text,'issue',jsonb_build_object('readingId',p_reading_id,'tariffId',p_tariff_id,'invoiceNo',v_invoice_no,'billingPeriod',p_billing_period,'totalAmount',v_total_amount,'deliveryQueued',false));
  if p_client_operation_id is not null then
    insert into public.offline_sync_operations(tenant_id,site_id,user_id,client_operation_id,operation_type,entity_type,entity_id,response)
    values(p_tenant_id,p_site_id,p_user_id,p_client_operation_id::text,'invoice_issue','invoice',v_invoice_id,jsonb_build_object('id',v_invoice_id,'invoiceNo',v_invoice_no,'totalAmount',v_total_amount));
  end if;
  return query select v_invoice_id,v_invoice_no,v_total_amount,false;
end;$$;

revoke execute on function public.powerhub_issue_invoice_from_reading(bigint,bigint,bigint,bigint,bigint,text,timestamptz,numeric,uuid) from public,anon,authenticated;
grant execute on function public.powerhub_issue_invoice_from_reading(bigint,bigint,bigint,bigint,bigint,text,timestamptz,numeric,uuid) to service_role;

create or replace function public.powerhub_update_subscriber(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_subscriber_id bigint,
  p_full_name text,
  p_phone text,
  p_address text,
  p_subscription_type text,
  p_service_status text,
  p_expected_updated_at timestamptz,
  p_client_operation_id uuid
)
returns table (updated_at timestamptz, replayed boolean)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_existing public.subscribers%rowtype;
  v_updated_at timestamptz;
  v_response jsonb;
  v_platform_role text;
begin
  if p_client_operation_id is not null then
    perform pg_advisory_xact_lock(hashtext('subscriber-update:' || p_user_id::text || ':' || p_client_operation_id::text));
    select response into v_response
    from public.offline_sync_operations
    where user_id = p_user_id and client_operation_id = p_client_operation_id::text
    limit 1;
    if found then
      if not exists (
        select 1 from public.offline_sync_operations op
        where op.user_id = p_user_id
          and op.client_operation_id = p_client_operation_id::text
          and op.tenant_id = p_tenant_id
          and op.site_id = p_site_id
          and op.operation_type = 'subscriber_update'
          and op.entity_id = p_subscriber_id
      ) then raise exception 'SUBSCRIBER_OPERATION_SCOPE_CONFLICT' using errcode = 'P0001'; end if;
      if coalesce(v_response->>'updatedAt', '') = '' then
        raise exception 'INVALID_SUBSCRIBER_OPERATION_REPLAY' using errcode = 'P0001';
      end if;
      return query select (v_response->>'updatedAt')::timestamptz, true;
      return;
    end if;
  end if;

  perform pg_advisory_xact_lock(p_subscriber_id);

  select * into v_existing
  from public.subscribers
  where id = p_subscriber_id and tenant_id = p_tenant_id and site_id = p_site_id
  for update;
  if not found then
    raise exception 'SUBSCRIBER_OUT_OF_SCOPE' using errcode = 'P0001';
  end if;
  if p_expected_updated_at is not null and v_existing.updated_at <> p_expected_updated_at then
    raise exception 'SUBSCRIBER_VERSION_CONFLICT' using errcode = 'P0001';
  end if;

  update public.subscribers
  set full_name = p_full_name, phone = p_phone, address = nullif(p_address, ''), subscription_type = p_subscription_type, service_status = p_service_status
  where id = p_subscriber_id
  returning updated_at into v_updated_at;

  select platform_role into v_platform_role from public.users where id = p_user_id;
  insert into public.audit_logs (
    tenant_id, site_id, user_id, actor_platform_role, entity_type, entity_id, action, before_data, after_data
  ) values (
    p_tenant_id, p_site_id, p_user_id, v_platform_role, 'subscriber', p_subscriber_id::text, 'update',
    jsonb_build_object('fullName', v_existing.full_name, 'phone', v_existing.phone, 'address', v_existing.address, 'subscriptionType', v_existing.subscription_type, 'serviceStatus', v_existing.service_status, 'updatedAt', v_existing.updated_at),
    jsonb_build_object('siteId', p_site_id, 'fullName', p_full_name, 'phone', p_phone, 'address', nullif(p_address, ''), 'subscriptionType', p_subscription_type, 'serviceStatus', p_service_status, 'updatedAt', v_updated_at, 'clientOperationId', p_client_operation_id)
  );

  if p_client_operation_id is not null then
    insert into public.offline_sync_operations (
      tenant_id, site_id, user_id, client_operation_id, operation_type, entity_type, entity_id, response
    ) values (
      p_tenant_id, p_site_id, p_user_id, p_client_operation_id::text, 'subscriber_update', 'subscriber', p_subscriber_id,
      jsonb_build_object('success', true, 'updatedAt', v_updated_at)
    );
  end if;

  return query select v_updated_at, false;
end;
$$;

revoke execute on function public.powerhub_update_subscriber(bigint, bigint, bigint, bigint, text, text, text, text, text, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.powerhub_update_subscriber(bigint, bigint, bigint, bigint, text, text, text, text, text, timestamptz, uuid) to service_role;
