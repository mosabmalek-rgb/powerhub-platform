-- Reconcile public payment-documentation RPCs required by server routes.
-- Staging lacked the status/target fast-path functions and had an older
-- locking context reader. Reinstall the reviewed Production read-only contract.

-- Expose policy-applied invoice line items on the public payment documentation form.
-- Keep the token context read-only and separate the lightweight pending-status check
-- from the heavier context fetch so opening an invoice does not contend on a row lock.
create or replace function public.powerhub_get_public_payment_documentation_context(p_token_hash text)
returns jsonb
language plpgsql
set search_path to ''
as $function$
declare
  v_link public.invoice_share_links%rowtype;
  v_invoice public.invoices%rowtype;
  v_subscriber record;
  v_payment_documentation_allowed boolean := false;
  v_accounts jsonb := '[]'::jsonb;
  v_lines jsonb := '[]'::jsonb;
begin
  if coalesce(p_token_hash, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'SHARE_LINK_NOT_FOUND' using errcode = 'P0001';
  end if;

  -- This endpoint only reads context. Submission, revocation, and approval paths
  -- perform their own atomic validation and do not rely on locks held by this read.
  select *
    into v_link
  from public.invoice_share_links
  where token_hash = p_token_hash;

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

  -- Invoice lines include the explicit floor, automatic fractional discount,
  -- and carried-fraction entries persisted by the central policy-aware issuer.
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', line.id,
        'lineType', line.line_type,
        'description', line.description,
        'amount', line.amount,
        'quantity', line.quantity,
        'unitPrice', line.unit_price,
        'displayOrder', line.display_order
      )
      order by line.display_order, line.id
    ),
    '[]'::jsonb
  )
    into v_lines
  from public.invoice_lines as line
  where line.invoice_id = v_invoice.id
    and line.tenant_id = v_link.tenant_id;

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
    'accounts', v_accounts,
    'lines', v_lines
  );
end;
$function$;

revoke all on function public.powerhub_get_public_payment_documentation_context(text) from public, anon, authenticated;
grant execute on function public.powerhub_get_public_payment_documentation_context(text) to service_role;

create or replace function public.powerhub_get_public_payment_documentation_status(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_link public.invoice_share_links%rowtype;
  v_invoice_id bigint;
  v_site_id bigint;
  v_has_pending boolean := false;
  v_submitted_at timestamptz;
begin
  if coalesce(p_token_hash, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'SHARE_LINK_NOT_FOUND' using errcode = 'P0001';
  end if;

  select *
    into v_link
  from public.invoice_share_links
  where token_hash = p_token_hash;

  if not found
     or v_link.revoked_at is not null
     or (v_link.expires_at is not null and v_link.expires_at <= now()) then
    raise exception 'SHARE_LINK_NOT_FOUND' using errcode = 'P0001';
  end if;

  select invoice.id, invoice.site_id
    into v_invoice_id, v_site_id
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

  select request.submitted_at
    into v_submitted_at
  from public.payment_documentation_requests as request
  where request.tenant_id = v_link.tenant_id
    and request.site_id = v_site_id
    and request.invoice_id = v_invoice_id
    and request.status = 'pending'
  order by request.submitted_at desc
  limit 1;

  v_has_pending := found;

  return jsonb_build_object(
    'hasPendingSubmission', v_has_pending,
    'submittedAt', v_submitted_at
  );
end;
$function$;

revoke all on function public.powerhub_get_public_payment_documentation_status(text) from public, anon, authenticated;
grant execute on function public.powerhub_get_public_payment_documentation_status(text) to service_role;

-- Submission only needs the current invoice scope and feature gate before uploading
-- an optional receipt. Avoid loading account lists and invoice lines on that path.
create or replace function public.powerhub_get_public_payment_documentation_target(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_link public.invoice_share_links%rowtype;
  v_invoice public.invoices%rowtype;
  v_allowed boolean := false;
begin
  if p_token_hash is null or coalesce(p_token_hash, '') = '' or length(p_token_hash) <> 64 or p_token_hash ~ '[^0-9a-f]' then
    raise exception 'SHARE_LINK_NOT_FOUND' using errcode = 'P0001';
  end if;

  select *
    into v_link
  from public.invoice_share_links
  where token_hash = p_token_hash;

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
    into v_allowed
  from public.powerhub_payment_documentation_access(v_link.tenant_id) as access
  limit 1;

  return jsonb_build_object(
    'siteId', v_invoice.site_id,
    'paymentDocumentationAvailable', coalesce(v_allowed, false),
    'invoice', jsonb_build_object(
      'id', v_invoice.id,
      'balanceDue', v_invoice.balance_due,
      'status', v_invoice.status
    )
  );
end;
$function$;

revoke all on function public.powerhub_get_public_payment_documentation_target(text) from public, anon, authenticated;
grant execute on function public.powerhub_get_public_payment_documentation_target(text) to service_role;

notify pgrst, 'reload schema';

DO $reject_acl_preflight$
BEGIN
  IF to_regprocedure('public.powerhub_reject_payment_documentation(bigint,bigint,bigint,bigint,text)') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    RAISE EXCEPTION 'PAYMENT_DOCUMENTATION_REJECT_RPC_OR_SERVICE_ROLE_MISSING';
  END IF;
END
$reject_acl_preflight$;

REVOKE ALL ON FUNCTION public.powerhub_reject_payment_documentation(bigint,bigint,bigint,bigint,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_reject_payment_documentation(bigint,bigint,bigint,bigint,text)
  TO service_role;
