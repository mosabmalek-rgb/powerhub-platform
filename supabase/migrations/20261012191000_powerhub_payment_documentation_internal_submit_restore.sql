-- Restore the internal payment-documentation submission RPC from the deployed contract.
-- Some staging snapshots are missing this routine despite the application calling it.
-- Preserve current validation, snapshots, locking and audit behavior while allowing
-- different electronic source/destination providers; cash still requires cash.
CREATE OR REPLACE FUNCTION public.powerhub_submit_payment_documentation(p_tenant_id bigint, p_site_id bigint, p_user_id bigint, p_subscriber_id bigint, p_invoice_id bigint, p_destination_account_id bigint, p_payment_amount numeric, p_payment_method text, p_sender_phone text, p_reference_no text, p_receipt_image_key text, p_receipt_image_hash text, p_client_operation_id uuid)
 RETURNS TABLE(request_id bigint, replayed boolean)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_invoice public.invoices%rowtype;
  v_subscriber public.subscribers%rowtype;
  v_account public.company_accounts%rowtype;
  v_existing public.payment_documentation_requests%rowtype;
  v_request_id bigint;
  v_platform_role text;
  v_tenant_role text;
  v_consumption_value numeric;
  v_sender_phone text;
begin
  if p_payment_amount <= 0 then raise exception 'INVALID_PAYMENT_AMOUNT' using errcode='P0001'; end if;
  if p_payment_method not in ('cash','jawwal_pay','palpay','bank_of_palestine','wallet','bank_transfer','card') then raise exception 'INVALID_PAYMENT_METHOD' using errcode='P0001'; end if;

  if p_payment_method = 'cash' then
    v_sender_phone := null;
  else
    v_sender_phone := nullif(btrim(coalesce(p_sender_phone,'')),'');
    if v_sender_phone is null then raise exception 'TRANSFER_SOURCE_PHONE_REQUIRED' using errcode='P0001'; end if;
    if v_sender_phone !~ '^\+?[0-9]{7,20}$' then raise exception 'INVALID_TRANSFER_SOURCE_PHONE' using errcode='P0001'; end if;
    if nullif(btrim(coalesce(p_receipt_image_key,'')),'') is null then raise exception 'RECEIPT_IMAGE_REQUIRED' using errcode='P0001'; end if;
  end if;

  if p_client_operation_id is not null then
    select * into v_existing
    from public.payment_documentation_requests
    where client_operation_id = p_client_operation_id
      and tenant_id = p_tenant_id
      and site_id = p_site_id
      and submitted_by_user_id = p_user_id
    limit 1;
    if found then
      return query select v_existing.id, true;
      return;
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('payment-documentation-invoice:'||p_tenant_id::text||':'||p_site_id::text||':'||p_invoice_id::text,0));

  select * into v_invoice
  from public.invoices
  where id=p_invoice_id and tenant_id=p_tenant_id and site_id=p_site_id and subscriber_id=p_subscriber_id
  for update;
  if not found then raise exception 'INVOICE_OUT_OF_SCOPE' using errcode='P0001'; end if;
  if v_invoice.status in ('draft','cancelled') then raise exception 'INVOICE_NOT_COLLECTIBLE' using errcode='P0001'; end if;
  if v_invoice.balance_due <= 0 then raise exception 'INVOICE_ALREADY_PAID' using errcode='P0001'; end if;
  if p_payment_amount > v_invoice.balance_due then raise exception 'PAYMENT_AMOUNT_EXCEEDS_BALANCE' using errcode='P0001'; end if;

  select * into v_subscriber
  from public.subscribers
  where id=p_subscriber_id and tenant_id=p_tenant_id and site_id=p_site_id;
  if not found then raise exception 'SUBSCRIBER_OUT_OF_SCOPE' using errcode='P0001'; end if;

  select * into v_account
  from public.company_accounts
  where id=p_destination_account_id and tenant_id=p_tenant_id and is_active=true
  for update;
  if not found then raise exception 'COMPANY_ACCOUNT_NOT_FOUND' using errcode='P0001'; end if;
  if not v_account.allow_payment_documentation then raise exception 'COMPANY_ACCOUNT_NOT_ENABLED_FOR_PAYMENT_DOCUMENTATION' using errcode='P0001'; end if;
  if (p_payment_method='cash' and v_account.account_type<>'cash') or (p_payment_method<>'cash' and v_account.account_type='cash') then raise exception 'COMPANY_ACCOUNT_TYPE_MISMATCH' using errcode='P0001'; end if;

  if exists (
    select 1 from public.company_account_sites
    where account_id=v_account.id and tenant_id=p_tenant_id
  ) and not exists (
    select 1 from public.company_account_sites
    where account_id=v_account.id and tenant_id=p_tenant_id and site_id=p_site_id
  ) then
    raise exception 'COMPANY_ACCOUNT_OUT_OF_SCOPE' using errcode='P0001';
  end if;

  if exists (
    select 1 from public.payment_documentation_requests
    where tenant_id=p_tenant_id and invoice_id=p_invoice_id and status='pending'
  ) then
    raise exception 'PAYMENT_DOCUMENTATION_ALREADY_PENDING' using errcode='P0001';
  end if;

  v_consumption_value := coalesce(v_invoice.consumption_kwh,0) * coalesce(v_invoice.price_per_kwh,0);

  insert into public.payment_documentation_requests(
    tenant_id, site_id, subscriber_id, invoice_id, destination_account_id,
    invoice_no_snapshot, subscriber_name_snapshot, subscriber_no_snapshot,
    billing_period_snapshot, previous_reading_snapshot, current_reading_snapshot,
    consumption_kwh_snapshot, price_per_kwh_snapshot, consumption_value_snapshot,
    invoice_total_snapshot, invoice_balance_snapshot, payment_amount,
    payment_method, sender_phone, reference_no, receipt_image_key, receipt_image_hash,
    status, submitted_by_user_id, client_operation_id
  ) values (
    p_tenant_id, p_site_id, p_subscriber_id, p_invoice_id, p_destination_account_id,
    v_invoice.invoice_no, v_subscriber.full_name, v_subscriber.subscriber_no,
    v_invoice.billing_period, v_invoice.previous_reading, v_invoice.current_reading,
    coalesce(v_invoice.consumption_kwh,0), coalesce(v_invoice.price_per_kwh,0), v_consumption_value,
    v_invoice.total_amount, v_invoice.balance_due, p_payment_amount,
    p_payment_method, v_sender_phone, nullif(btrim(p_reference_no),''), p_receipt_image_key, p_receipt_image_hash,
    'pending', p_user_id, p_client_operation_id
  )
  returning id into v_request_id;

  select u.platform_role, m.role into v_platform_role, v_tenant_role
  from public.users u
  left join public.tenant_members m on m.user_id=u.id and m.tenant_id=p_tenant_id
  where u.id=p_user_id;
  if v_platform_role not in ('platform_owner','platform_admin','finance_admin') then v_platform_role:=null; end if;
  insert into public.audit_logs(
    tenant_id, site_id, user_id, actor_platform_role, actor_tenant_role, entity_type, entity_id, action,
    after_data, metadata
  ) values (
    p_tenant_id, p_site_id, p_user_id, v_platform_role, v_tenant_role, 'payment_documentation_request',
    v_request_id::text, 'submit',
    jsonb_build_object('invoiceId', p_invoice_id, 'paymentAmount', p_payment_amount, 'paymentMethod', p_payment_method, 'destinationAccountId', p_destination_account_id),
    jsonb_build_object('receiptImageAttached', p_receipt_image_key is not null)
  );

  return query select v_request_id, false;
end;
$function$;


revoke all on function public.powerhub_submit_payment_documentation(bigint,bigint,bigint,bigint,bigint,bigint,numeric,text,text,text,text,text,uuid) from public, anon, authenticated;
grant execute on function public.powerhub_submit_payment_documentation(bigint,bigint,bigint,bigint,bigint,bigint,numeric,text,text,text,text,text,uuid) to service_role;
