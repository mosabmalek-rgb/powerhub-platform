create or replace function public.powerhub_get_shared_invoice_by_token_hash(p_token_hash text)
returns jsonb
language plpgsql security invoker set search_path=public,pg_temp
as $$
declare
  v_link public.invoice_share_links%rowtype;
  v_invoice public.invoices%rowtype;
  v_subscriber record;
  v_lines jsonb;
begin
  if length(p_token_hash)<32 then
    raise exception 'SHARE_LINK_NOT_FOUND' using errcode='P0001';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_token_hash));
  select * into v_link
  from public.invoice_share_links
  where token_hash=p_token_hash
  for update;

  if not found
     or v_link.revoked_at is not null
     or (v_link.expires_at is not null and v_link.expires_at<=now()) then
    raise exception 'SHARE_LINK_NOT_FOUND' using errcode='P0001';
  end if;

  select * into v_invoice
  from public.invoices
  where id=v_link.invoice_id
    and tenant_id=v_link.tenant_id;

  if not found then
    raise exception 'SHARE_LINK_NOT_FOUND' using errcode='P0001';
  end if;

  select full_name,subscriber_no
  into v_subscriber
  from public.subscribers
  where id=v_invoice.subscriber_id
    and tenant_id=v_link.tenant_id
    and site_id=v_invoice.site_id;

  if not found then
    raise exception 'SHARE_LINK_NOT_FOUND' using errcode='P0001';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id',line.id,
        'description',line.description,
        'amount',line.amount,
        'quantity',line.quantity,
        'unitPrice',line.unit_price,
        'displayOrder',line.display_order
      )
      order by line.display_order
    ),
    '[]'::jsonb
  )
  into v_lines
  from public.invoice_lines line
  where line.invoice_id=v_invoice.id
    and line.tenant_id=v_link.tenant_id;

  update public.invoice_share_links
  set view_count=view_count+1,last_viewed_at=now()
  where id=v_link.id;

  return jsonb_build_object(
    'siteId',v_invoice.site_id,
    'tenantId',v_link.tenant_id,
    'invoice',jsonb_build_object(
      'id',v_invoice.id,
      'subscriberId',v_invoice.subscriber_id,
      'invoiceNo',v_invoice.invoice_no,
      'billingPeriod',v_invoice.billing_period,
      'issueDate',v_invoice.issue_date,
      'dueDate',v_invoice.due_date,
      'previousReading',v_invoice.previous_reading,
      'currentReading',v_invoice.current_reading,
      'consumptionKwh',v_invoice.consumption_kwh,
      'pricePerKwh',v_invoice.price_per_kwh,
      'fixedFee',v_invoice.fixed_fee,
      'taxAmount',v_invoice.tax_amount,
      'discountAmount',v_invoice.discount_amount,
      'totalAmount',v_invoice.total_amount,
      'paidAmount',v_invoice.paid_amount,
      'balanceDue',v_invoice.balance_due,
      'status',v_invoice.status
    ),
    'subscriber',
    case
      when v_subscriber is null then null
      else jsonb_build_object(
        'fullName',v_subscriber.full_name,
        'subscriberNo',v_subscriber.subscriber_no
      )
    end,
    'lines',v_lines
  );
end;
$$;

create or replace function public.powerhub_get_public_payment_documentation_context(p_token_hash text)
returns jsonb
language plpgsql security invoker set search_path=public,pg_temp
as $$
declare
  v_link public.invoice_share_links%rowtype;
  v_invoice public.invoices%rowtype;
  v_subscriber record;
  v_access record;
  v_accounts jsonb;
begin
  if length(p_token_hash)<32 then
    raise exception 'SHARE_LINK_NOT_FOUND' using errcode='P0001';
  end if;

  perform pg_advisory_xact_lock(hashtext('payment-context:' || p_token_hash));
  select * into v_link
  from public.invoice_share_links
  where token_hash=p_token_hash
  for update;

  if not found
     or v_link.revoked_at is not null
     or (v_link.expires_at is not null and v_link.expires_at<=now()) then
    raise exception 'SHARE_LINK_NOT_FOUND' using errcode='P0001';
  end if;

  select * into v_invoice
  from public.invoices
  where id=v_link.invoice_id
    and tenant_id=v_link.tenant_id;

  if not found then
    raise exception 'SHARE_LINK_NOT_FOUND' using errcode='P0001';
  end if;

  select full_name,subscriber_no
  into v_subscriber
  from public.subscribers
  where id=v_invoice.subscriber_id
    and tenant_id=v_link.tenant_id
    and site_id=v_invoice.site_id;

  if not found then
    raise exception 'SHARE_LINK_NOT_FOUND' using errcode='P0001';
  end if;

  select *
  into v_access
  from public.powerhub_payment_documentation_access(v_link.tenant_id)
  limit 1;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id',ca.id,
        'name',ca.name,
        'accountType',ca.account_type,
        'phoneNumber',ca.phone_number
      )
      order by ca.id
    ),
    '[]'::jsonb
  )
  into v_accounts
  from public.company_accounts ca
  where ca.tenant_id=v_link.tenant_id
    and ca.is_active=true
    and ca.allow_payment_documentation=true
    and (
      not exists (
        select 1
        from public.company_account_sites cas
        where cas.tenant_id=v_link.tenant_id
          and cas.account_id=ca.id
      )
      or exists (
        select 1
        from public.company_account_sites cas
        where cas.tenant_id=v_link.tenant_id
          and cas.account_id=ca.id
          and cas.site_id=v_invoice.site_id
      )
    );

  return jsonb_build_object(
    'siteId',v_invoice.site_id,
    'paymentDocumentationAvailable',coalesce(v_access.allowed,false),
    'invoice',jsonb_build_object(
      'id',v_invoice.id,
      'subscriberId',v_invoice.subscriber_id,
      'invoiceNo',v_invoice.invoice_no,
      'billingPeriod',v_invoice.billing_period,
      'issueDate',v_invoice.issue_date,
      'dueDate',v_invoice.due_date,
      'previousReading',v_invoice.previous_reading,
      'currentReading',v_invoice.current_reading,
      'consumptionKwh',v_invoice.consumption_kwh,
      'pricePerKwh',v_invoice.price_per_kwh,
      'fixedFee',v_invoice.fixed_fee,
      'taxAmount',v_invoice.tax_amount,
      'discountAmount',v_invoice.discount_amount,
      'totalAmount',v_invoice.total_amount,
      'paidAmount',v_invoice.paid_amount,
      'balanceDue',v_invoice.balance_due,
      'status',v_invoice.status
    ),
    'subscriber',jsonb_build_object(
      'fullName',v_subscriber.full_name,
      'subscriberNo',v_subscriber.subscriber_no
    ),
    'accounts',v_accounts
  );
end;
$$;

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
language plpgsql security invoker set search_path=public,pg_temp
as $$
declare
  v_link public.invoice_share_links%rowtype;
  v_invoice public.invoices%rowtype;
  v_subscriber public.subscribers%rowtype;
  v_account public.company_accounts%rowtype;
  v_access record;
  v_existing public.payment_documentation_requests%rowtype;
  v_request_id bigint;
  v_consumption_value numeric;
  v_sender_phone text;
begin
  if length(p_token_hash)<32 then
    raise exception 'SHARE_LINK_NOT_FOUND' using errcode='P0001';
  end if;
  if p_client_operation_id is null then
    raise exception 'CLIENT_OPERATION_REQUIRED' using errcode='P0001';
  end if;
  if p_payment_amount<=0 then
    raise exception 'INVALID_PAYMENT_AMOUNT' using errcode='P0001';
  end if;
  if p_payment_method not in ('cash','jawwal_pay','palpay','bank_of_palestine','wallet','bank_transfer','card') then
    raise exception 'INVALID_PAYMENT_METHOD' using errcode='P0001';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('public-payment-documentation:' || p_client_operation_id::text,0)
  );

  select * into v_link
  from public.invoice_share_links
  where token_hash=p_token_hash
  for update;

  if not found
     or v_link.revoked_at is not null
     or (v_link.expires_at is not null and v_link.expires_at<=now()) then
    raise exception 'SHARE_LINK_NOT_FOUND' using errcode='P0001';
  end if;

  select *
  into v_invoice
  from public.invoices
  where id=v_link.invoice_id
    and tenant_id=v_link.tenant_id
    and site_id=(select i.site_id from public.invoices i where i.id=v_link.invoice_id);

  if not found then
    raise exception 'SHARE_LINK_NOT_FOUND' using errcode='P0001';
  end if;

  select * into v_access
  from public.powerhub_payment_documentation_access(v_link.tenant_id)
  limit 1;

  if not coalesce(v_access.allowed,false) then
    raise exception 'PAYMENT_DOCUMENTATION_DISABLED' using errcode='P0001';
  end if;

  select *
  into v_existing
  from public.payment_documentation_requests
  where client_operation_id=p_client_operation_id
    and tenant_id=v_link.tenant_id
    and site_id=v_invoice.site_id
    and invoice_id=v_invoice.id
    and submitted_by_user_id is null
  for update;

  if found then
    return query select v_existing.id,true;
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

  select * into v_invoice
  from public.invoices
  where id=v_link.invoice_id
    and tenant_id=v_link.tenant_id
    and site_id=v_invoice.site_id
  for update;

  if not found then
    raise exception 'INVOICE_OUT_OF_SCOPE' using errcode='P0001';
  end if;
  if v_invoice.status in ('draft','cancelled') then
    raise exception 'INVOICE_NOT_COLLECTIBLE' using errcode='P0001';
  end if;
  if v_invoice.balance_due<=0 then
    raise exception 'INVOICE_ALREADY_PAID' using errcode='P0001';
  end if;
  if p_payment_amount>v_invoice.balance_due then
    raise exception 'PAYMENT_AMOUNT_EXCEEDS_BALANCE' using errcode='P0001';
  end if;

  select *
  into v_subscriber
  from public.subscribers
  where id=v_invoice.subscriber_id
    and tenant_id=v_link.tenant_id
    and site_id=v_invoice.site_id;

  if not found then
    raise exception 'SUBSCRIBER_OUT_OF_SCOPE' using errcode='P0001';
  end if;

  select *
  into v_account
  from public.company_accounts
  where id=p_destination_account_id
    and tenant_id=v_link.tenant_id
    and is_active=true
  for update;

  if not found then
    raise exception 'COMPANY_ACCOUNT_NOT_FOUND' using errcode='P0001';
  end if;
  if not v_account.allow_payment_documentation then
    raise exception 'COMPANY_ACCOUNT_NOT_ENABLED' using errcode='P0001';
  end if;
  if v_account.account_type<>p_payment_method then
    raise exception 'COMPANY_ACCOUNT_TYPE_MISMATCH' using errcode='P0001';
  end if;
  if not exists (
    select 1 from public.company_account_sites
    where tenant_id=v_link.tenant_id
      and account_id=v_account.id
      and site_id=v_invoice.site_id
  ) then
    raise exception 'COMPANY_ACCOUNT_OUT_OF_SCOPE' using errcode='P0001';
  end if;

  if exists (
    select 1
    from public.payment_documentation_requests
    where tenant_id=v_link.tenant_id
      and invoice_id=v_invoice.id
      and status='pending'
  ) then
    raise exception 'PAYMENT_DOCUMENTATION_ALREADY_PENDING' using errcode='P0001';
  end if;

  if p_payment_method='cash' then
    v_sender_phone:=null;
  else
    v_sender_phone:=nullif(btrim(coalesce(p_sender_phone,'')),'');
    if v_sender_phone is null then
      raise exception 'TRANSFER_SOURCE_PHONE_REQUIRED' using errcode='P0001';
    end if;
    if v_sender_phone !~ '^\\+?[0-9]{7,20}$' then
      raise exception 'INVALID_TRANSFER_SOURCE_PHONE' using errcode='P0001';
    end if;
    if nullif(btrim(coalesce(p_receipt_image_key,'')),'') is null then
      raise exception 'RECEIPT_IMAGE_REQUIRED' using errcode='P0001';
    end if;
  end if;

  v_consumption_value:=coalesce(v_invoice.consumption_kwh,0)*coalesce(v_invoice.price_per_kwh,0);

  insert into public.payment_documentation_requests(
    tenant_id,site_id,subscriber_id,invoice_id,destination_account_id,
    invoice_no_snapshot,subscriber_name_snapshot,subscriber_no_snapshot,
    billing_period_snapshot,previous_reading_snapshot,current_reading_snapshot,
    consumption_kwh_snapshot,price_per_kwh_snapshot,consumption_value_snapshot,
    invoice_total_snapshot,invoice_balance_snapshot,payment_amount,
    payment_method,sender_phone,reference_no,receipt_image_key,receipt_image_hash,
    status,submitted_by_user_id,client_operation_id
  ) values (
    v_link.tenant_id,v_invoice.site_id,v_invoice.subscriber_id,v_invoice.id,v_account.id,
    v_invoice.invoice_no,v_subscriber.full_name,v_subscriber.subscriber_no,
    v_invoice.billing_period,v_invoice.previous_reading,v_invoice.current_reading,
    coalesce(v_invoice.consumption_kwh,0),coalesce(v_invoice.price_per_kwh,0),v_consumption_value,
    v_invoice.total_amount,v_invoice.balance_due,p_payment_amount,
    p_payment_method,v_sender_phone,nullif(btrim(p_reference_no),''),
    p_receipt_image_key,p_receipt_image_hash,
    'pending',null,p_client_operation_id
  )
  returning id into v_request_id;

  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,
    after_data,metadata
  ) values (
    v_link.tenant_id,v_invoice.site_id,null,'public',
    'payment_documentation_request',v_request_id::text,'submit',
    jsonb_build_object(
      'invoiceId',v_invoice.id,
      'paymentAmount',p_payment_amount,
      'paymentMethod',p_payment_method,
      'destinationAccountId',v_account.id
    ),
    jsonb_build_object(
      'submissionSource','public_invoice_share_link',
      'shareLinkId',v_link.id,
      'clientOperationId',p_client_operation_id
    )
  );

  return query select v_request_id,false;
end;
$$;

alter table public.payment_documentation_requests
  alter column submitted_by_user_id drop not null;

revoke execute on function public.powerhub_get_public_payment_documentation_context(text) from public,anon,authenticated;
grant execute on function public.powerhub_get_public_payment_documentation_context(text) to service_role;

revoke execute on function public.powerhub_submit_public_payment_documentation(text,bigint,numeric,text,text,text,text,text,uuid) from public,anon,authenticated;
grant execute on function public.powerhub_submit_public_payment_documentation(text,bigint,numeric,text,text,text,text,text,uuid) to service_role;
