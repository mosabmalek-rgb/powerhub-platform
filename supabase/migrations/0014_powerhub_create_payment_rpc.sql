-- تسجيل التحصيل داخل معاملة واحدة: قفل الفاتورة، حركة حساب الشركة، التكرار غير المتصل، والتدقيق.
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
    select response into v_response from public.offline_sync_operations
    where user_id = p_user_id and client_operation_id = p_client_operation_id::text limit 1;
    if found then
      if coalesce(v_response->>'id', '') = '' then raise exception 'INVALID_PAYMENT_OPERATION_REPLAY' using errcode = 'P0001'; end if;
      return query select (v_response->>'id')::bigint, true;
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
