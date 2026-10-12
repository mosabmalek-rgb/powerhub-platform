-- Restore the public payment-documentation RPC bridge in a new migration.
-- Production verification found these RPCs missing even though the older
-- 20260930210000 migration exists in the repository. This idempotent repair
-- preserves service-role-only access and aligns account scope between context
-- lookup and submission.

create or replace function public.powerhub_get_public_payment_documentation_context(p_token_hash text)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_link public.invoice_share_links%rowtype;
  v_invoice public.invoices%rowtype;
  v_subscriber record;
  v_payment_documentation_allowed boolean := false;
  v_accounts jsonb := '[]'::jsonb;
begin
  if coalesce(p_token_hash, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'SHARE_LINK_NOT_FOUND' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtext('payment-context:' || p_token_hash)::bigint);

  select *
    into v_link
  from public.invoice_share_links
  where token_hash = p_token_hash
  for update;

  if not found
     or v_link.revoked_at is not null
     or (v_link.expires_at is not null and v_link.expires_at <= now()) then
    raise exception 'SHARE_LINK_NOT_FOUND' using errcode = 'P0001';
  end if;

  select invoice.*
    into v_invoice
  from public.invoices as invoice
  join public.sites as site
    on site.id = invoice.site_id
   and site.tenant_id = invoice.tenant_id
   and site.status = 'active'
  where invoice.id = v_link.invoice_id
    and invoice.tenant_id = v_link.tenant_id;

  if not found then
    raise exception 'SHARE_LINK_NOT_FOUND' using errcode = 'P0001';
  end if;

  select subscriber.id, subscriber.full_name, subscriber.subscriber_no
    into v_subscriber
  from public.subscribers as subscriber
  where subscriber.id = v_invoice.subscriber_id
    and subscriber.tenant_id = v_link.tenant_id
    and subscriber.site_id = v_invoice.site_id;

  if not found then
    raise exception 'SHARE_LINK_NOT_FOUND' using errcode = 'P0001';
  end if;

  select coalesce(access.allowed, false)
    into v_payment_documentation_allowed
  from public.powerhub_payment_documentation_access(v_link.tenant_id) as access
  limit 1;

  v_payment_documentation_allowed := coalesce(v_payment_documentation_allowed, false);

  if v_payment_documentation_allowed
     and coalesce(v_invoice.balance_due, 0) > 0
     and v_invoice.status not in ('draft', 'cancelled', 'paid') then
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', account.id,
          'name', account.name,
          'accountType', account.account_type,
          'phoneNumber', account.phone_number
        )
        order by account.id
      ),
      '[]'::jsonb
    )
      into v_accounts
    from public.company_accounts as account
    where account.tenant_id = v_link.tenant_id
      and account.is_active = true
      and account.allow_payment_documentation = true
      and (
        not exists (
          select 1
          from public.company_account_sites as mapping
          where mapping.tenant_id = v_link.tenant_id
            and mapping.account_id = account.id
        )
        or exists (
          select 1
          from public.company_account_sites as mapping
          where mapping.tenant_id = v_link.tenant_id
            and mapping.account_id = account.id
            and mapping.site_id = v_invoice.site_id
        )
      );
  end if;

  return jsonb_build_object(
    'siteId', v_invoice.site_id,
    'paymentDocumentationAvailable', v_payment_documentation_allowed,
    'invoice', jsonb_build_object(
      'id', v_invoice.id,
      'subscriberId', v_invoice.subscriber_id,
      'invoiceNo', v_invoice.invoice_no,
      'billingPeriod', v_invoice.billing_period,
      'issueDate', v_invoice.issue_date,
      'dueDate', v_invoice.due_date,
      'previousReading', v_invoice.previous_reading,
      'currentReading', v_invoice.current_reading,
      'consumptionKwh', v_invoice.consumption_kwh,
      'pricePerKwh', v_invoice.price_per_kwh,
      'fixedFee', v_invoice.fixed_fee,
      'taxAmount', v_invoice.tax_amount,
      'discountAmount', v_invoice.discount_amount,
      'totalAmount', v_invoice.total_amount,
      'paidAmount', v_invoice.paid_amount,
      'balanceDue', v_invoice.balance_due,
      'status', v_invoice.status
    ),
    'subscriber', jsonb_build_object(
      'subscriberId', v_subscriber.id,
      'fullName', v_subscriber.full_name,
      'subscriberNo', v_subscriber.subscriber_no
    ),
    'accounts', v_accounts
  );
end;
$function$;

revoke all on function public.powerhub_get_public_payment_documentation_context(text) from public, anon, authenticated;
grant execute on function public.powerhub_get_public_payment_documentation_context(text) to service_role;


create or replace function public.powerhub_submit_public_payment_documentation(
  p_token_hash text,
  p_destination_account_id bigint,
  p_payment_amount numeric,
  p_payment_method text,
  p_sender_phone text,
  p_reference_no text,
  p_receipt_image_key text,
  p_receipt_image_hash text,
  p_client_operation_id uuid
)
returns table(request_id bigint, replayed boolean)
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_link public.invoice_share_links%rowtype;
  v_invoice public.invoices%rowtype;
  v_subscriber public.subscribers%rowtype;
  v_account public.company_accounts%rowtype;
  v_payment_documentation_allowed boolean := false;
  v_existing public.payment_documentation_requests%rowtype;
  v_request_id bigint;
  v_consumption_value numeric;
  v_sender_phone text;
  v_account_has_site_mappings boolean := false;
begin
  if coalesce(p_token_hash, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'SHARE_LINK_NOT_FOUND' using errcode = 'P0001';
  end if;
  if p_client_operation_id is null then
    raise exception 'CLIENT_OPERATION_REQUIRED' using errcode = 'P0001';
  end if;
  if p_payment_amount is null or p_payment_amount <= 0 then
    raise exception 'INVALID_PAYMENT_AMOUNT' using errcode = 'P0001';
  end if;
  if p_payment_method not in ('cash', 'jawwal_pay', 'palpay', 'bank_of_palestine', 'wallet', 'bank_transfer', 'card') then
    raise exception 'INVALID_PAYMENT_METHOD' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('public-payment-documentation:' || p_client_operation_id::text, 0)
  );

  select *
    into v_link
  from public.invoice_share_links
  where token_hash = p_token_hash
  for update;

  if not found
     or v_link.revoked_at is not null
     or (v_link.expires_at is not null and v_link.expires_at <= now()) then
    raise exception 'SHARE_LINK_NOT_FOUND' using errcode = 'P0001';
  end if;

  select invoice.*
    into v_invoice
  from public.invoices as invoice
  join public.sites as site
    on site.id = invoice.site_id
   and site.tenant_id = invoice.tenant_id
   and site.status = 'active'
  where invoice.id = v_link.invoice_id
    and invoice.tenant_id = v_link.tenant_id;

  if not found then
    raise exception 'SHARE_LINK_NOT_FOUND' using errcode = 'P0001';
  end if;

  select coalesce(access.allowed, false)
    into v_payment_documentation_allowed
  from public.powerhub_payment_documentation_access(v_link.tenant_id) as access
  limit 1;

  if not coalesce(v_payment_documentation_allowed, false) then
    raise exception 'PAYMENT_DOCUMENTATION_DISABLED' using errcode = 'P0001';
  end if;

  select *
    into v_existing
  from public.payment_documentation_requests
  where client_operation_id = p_client_operation_id
    and tenant_id = v_link.tenant_id
    and site_id = v_invoice.site_id
    and invoice_id = v_invoice.id
    and submitted_by_user_id is null
  for update;

  if found then
    return query select v_existing.id, true;
    return;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'payment-documentation-invoice:' ||
      v_link.tenant_id::text || ':' ||
      v_invoice.site_id::text || ':' ||
      v_invoice.id::text,
      0
    )
  );

  select invoice.*
    into v_invoice
  from public.invoices as invoice
  where invoice.id = v_link.invoice_id
    and invoice.tenant_id = v_link.tenant_id
  for update;

  if not found then
    raise exception 'INVOICE_OUT_OF_SCOPE' using errcode = 'P0001';
  end if;
  if v_invoice.status in ('draft', 'cancelled') then
    raise exception 'INVOICE_NOT_COLLECTIBLE' using errcode = 'P0001';
  end if;
  if coalesce(v_invoice.balance_due, 0) <= 0 or v_invoice.status = 'paid' then
    raise exception 'INVOICE_ALREADY_PAID' using errcode = 'P0001';
  end if;
  if p_payment_amount > v_invoice.balance_due then
    raise exception 'PAYMENT_AMOUNT_EXCEEDS_BALANCE' using errcode = 'P0001';
  end if;

  select *
    into v_subscriber
  from public.subscribers as subscriber
  where subscriber.id = v_invoice.subscriber_id
    and subscriber.tenant_id = v_link.tenant_id
    and subscriber.site_id = v_invoice.site_id;

  if not found then
    raise exception 'SUBSCRIBER_OUT_OF_SCOPE' using errcode = 'P0001';
  end if;

  select *
    into v_account
  from public.company_accounts as account
  where account.id = p_destination_account_id
    and account.tenant_id = v_link.tenant_id
    and account.is_active = true
  for update;

  if not found then
    raise exception 'COMPANY_ACCOUNT_NOT_FOUND' using errcode = 'P0001';
  end if;
  if not v_account.allow_payment_documentation then
    raise exception 'COMPANY_ACCOUNT_NOT_ENABLED' using errcode = 'P0001';
  end if;
  if v_account.account_type <> p_payment_method then
    raise exception 'COMPANY_ACCOUNT_TYPE_MISMATCH' using errcode = 'P0001';
  end if;

  select exists (
    select 1
    from public.company_account_sites as mapping
    where mapping.tenant_id = v_link.tenant_id
      and mapping.account_id = v_account.id
  ) into v_account_has_site_mappings;

  if v_account_has_site_mappings and not exists (
    select 1
    from public.company_account_sites as mapping
    where mapping.tenant_id = v_link.tenant_id
      and mapping.account_id = v_account.id
      and mapping.site_id = v_invoice.site_id
  ) then
    raise exception 'COMPANY_ACCOUNT_OUT_OF_SCOPE' using errcode = 'P0001';
  end if;

  if exists (
    select 1
    from public.payment_documentation_requests as request
    where request.tenant_id = v_link.tenant_id
      and request.site_id = v_invoice.site_id
      and request.invoice_id = v_invoice.id
      and request.status = 'pending'
  ) then
    raise exception 'PAYMENT_DOCUMENTATION_ALREADY_PENDING' using errcode = 'P0001';
  end if;

  if p_payment_method = 'cash' then
    v_sender_phone := null;
  else
    v_sender_phone := nullif(btrim(coalesce(p_sender_phone, '')), '');
    if v_sender_phone is null then
      raise exception 'TRANSFER_SOURCE_PHONE_REQUIRED' using errcode = 'P0001';
    end if;
    if v_sender_phone !~ '^\+?[0-9]{7,20}$' then
      raise exception 'INVALID_TRANSFER_SOURCE_PHONE' using errcode = 'P0001';
    end if;
    if nullif(btrim(coalesce(p_receipt_image_key, '')), '') is null then
      raise exception 'RECEIPT_IMAGE_REQUIRED' using errcode = 'P0001';
    end if;
  end if;

  v_consumption_value := coalesce(v_invoice.consumption_kwh, 0) * coalesce(v_invoice.price_per_kwh, 0);

  insert into public.payment_documentation_requests (
    tenant_id, site_id, subscriber_id, invoice_id, destination_account_id,
    invoice_no_snapshot, subscriber_name_snapshot, subscriber_no_snapshot,
    billing_period_snapshot, previous_reading_snapshot, current_reading_snapshot,
    consumption_kwh_snapshot, price_per_kwh_snapshot, consumption_value_snapshot,
    invoice_total_snapshot, invoice_balance_snapshot, payment_amount,
    payment_method, sender_phone, reference_no, receipt_image_key, receipt_image_hash,
    status, submitted_by_user_id, client_operation_id
  ) values (
    v_link.tenant_id, v_invoice.site_id, v_invoice.subscriber_id, v_invoice.id, v_account.id,
    v_invoice.invoice_no, v_subscriber.full_name, v_subscriber.subscriber_no,
    v_invoice.billing_period, v_invoice.previous_reading, v_invoice.current_reading,
    coalesce(v_invoice.consumption_kwh, 0), coalesce(v_invoice.price_per_kwh, 0), v_consumption_value,
    v_invoice.total_amount, v_invoice.balance_due, p_payment_amount,
    p_payment_method, v_sender_phone, nullif(btrim(p_reference_no), ''),
    p_receipt_image_key, p_receipt_image_hash,
    'pending', null, p_client_operation_id
  )
  returning id into v_request_id;

  insert into public.audit_logs (
    tenant_id, site_id, user_id, actor_platform_role, entity_type, entity_id, action,
    after_data, metadata
  ) values (
    v_link.tenant_id, v_invoice.site_id, null, 'public',
    'payment_documentation_request', v_request_id::text, 'submit',
    jsonb_build_object(
      'invoiceId', v_invoice.id,
      'paymentAmount', p_payment_amount,
      'paymentMethod', p_payment_method,
      'destinationAccountId', v_account.id
    ),
    jsonb_build_object(
      'submissionSource', 'public_invoice_share_link',
      'shareLinkId', v_link.id,
      'clientOperationId', p_client_operation_id
    )
  );

  return query select v_request_id, false;
end;
$function$;

alter table public.payment_documentation_requests
  alter column submitted_by_user_id drop not null;

revoke all on function public.powerhub_submit_public_payment_documentation(text, bigint, numeric, text, text, text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.powerhub_submit_public_payment_documentation(text, bigint, numeric, text, text, text, text, text, uuid) to service_role;
