-- Keep public invoice verification aligned with the inquiry lookup's Palestinian
-- mobile normalization, and enforce payment-documentation entitlement and unpaid
-- balance at the database boundary before issuing a public share link.

create or replace function public.powerhub_subscriber_portal_invoice(
  p_portal_code text,
  p_subscriber_no text,
  p_phone text,
  p_invoice_no text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_portal record;
  v_subscriber record;
  v_invoice record;
  v_lines jsonb;
begin
  select
    settings.portal_code,
    case when logo_access.allowed then settings.display_name else 'صفحة استعلامات المشتركين' end as display_name,
    settings.primary_color,
    settings.accent_color,
    case when logo_access.allowed then settings.logo_key else null end as logo_key,
    settings.tenant_id as tenant_id,
    site.id as site_id,
    case when logo_access.allowed then site.name else 'صفحة استعلامات المشتركين' end as site_name
  into v_portal
  from public.site_portal_settings as settings
  join public.sites as site on site.id = settings.site_id
  cross join lateral public.powerhub_subscriber_portal_logo_access(settings.tenant_id) as logo_access
  where settings.portal_code = lower(btrim(p_portal_code))
    and settings.is_enabled = true
    and site.status = 'active'
  limit 1;

  if not found then
    return null;
  end if;

  with input_phone as (
    select regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g') as digits
  ),
  input_canonical as (
    select case
      when digits ~ '^00(970|972)(56|59)[0-9]{7}$' then '0' || substring(digits from 6)
      when digits ~ '^(970|972)(56|59)[0-9]{7}$' then '0' || substring(digits from 4)
      when digits ~ '^0(56|59)[0-9]{7}$' then digits
      when digits ~ '^(56|59)[0-9]{7}$' then '0' || digits
      else digits
    end as phone
    from input_phone
  )
  select
    subscriber.id,
    subscriber.subscriber_no,
    subscriber.full_name,
    subscriber.phone,
    subscriber.address
  into v_subscriber
  from public.subscribers as subscriber
  cross join input_canonical as input
  cross join lateral (
    select regexp_replace(coalesce(subscriber.phone, ''), '[^0-9]', '', 'g') as digits
  ) as stored_digits
  cross join lateral (
    select case
      when stored_digits.digits ~ '^00(970|972)(56|59)[0-9]{7}$' then '0' || substring(stored_digits.digits from 6)
      when stored_digits.digits ~ '^(970|972)(56|59)[0-9]{7}$' then '0' || substring(stored_digits.digits from 4)
      when stored_digits.digits ~ '^0(56|59)[0-9]{7}$' then stored_digits.digits
      when stored_digits.digits ~ '^(56|59)[0-9]{7}$' then '0' || stored_digits.digits
      else stored_digits.digits
    end as phone
  ) as stored_canonical
  where subscriber.site_id = v_portal.site_id
    and subscriber.tenant_id = v_portal.tenant_id
    and subscriber.archived_at is null
    and subscriber.subscriber_no = btrim(p_subscriber_no)
    and stored_canonical.phone = input.phone
  limit 1;

  if not found then
    return null;
  end if;

  select
    invoice.id,
    invoice.invoice_no,
    invoice.billing_period,
    invoice.issue_date,
    invoice.due_date,
    invoice.previous_reading,
    invoice.current_reading,
    invoice.consumption_kwh,
    invoice.price_per_kwh,
    invoice.fixed_fee,
    invoice.tax_amount,
    invoice.discount_amount,
    invoice.total_amount,
    invoice.paid_amount,
    invoice.balance_due,
    invoice.status
  into v_invoice
  from public.invoices as invoice
  where invoice.site_id = v_portal.site_id
    and invoice.tenant_id = v_portal.tenant_id
    and invoice.subscriber_id = v_subscriber.id
    and invoice.invoice_no = btrim(p_invoice_no)
    and invoice.status not in ('draft', 'cancelled')
  limit 1;

  if not found then
    return null;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'description', line.description,
    'quantity', line.quantity,
    'unitPrice', line.unit_price,
    'amount', line.amount
  ) order by line.display_order asc), '[]'::jsonb)
  into v_lines
  from public.invoice_lines as line
  where line.invoice_id = v_invoice.id
    and line.tenant_id = v_portal.tenant_id;

  return jsonb_build_object(
    'portal', jsonb_build_object(
      'displayName', v_portal.display_name,
      'primaryColor', v_portal.primary_color,
      'accentColor', v_portal.accent_color,
      'logoKey', v_portal.logo_key
    ),
    'subscriber', jsonb_build_object(
      'fullName', v_subscriber.full_name,
      'subscriberNo', v_subscriber.subscriber_no,
      'phone', v_subscriber.phone,
      'address', v_subscriber.address
    ),
    'invoice', jsonb_build_object(
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
    'lines', v_lines
  );
end;
$function$;

revoke all on function public.powerhub_subscriber_portal_invoice(text, text, text, text) from public, anon, authenticated;
grant execute on function public.powerhub_subscriber_portal_invoice(text, text, text, text) to service_role;

create or replace function public.powerhub_create_portal_invoice_share_link(
  p_portal_code text,
  p_subscriber_no text,
  p_phone text,
  p_invoice_no text,
  p_token_hash text,
  p_token_preview text
)
returns table(share_link_id bigint, site_id bigint, tenant_id bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_portal_invoice jsonb;
  v_site_id bigint;
  v_tenant_id bigint;
  v_invoice_id bigint;
  v_invoice_balance_due numeric;
  v_invoice_status text;
  v_link_id bigint;
begin
  if coalesce(p_token_hash, '') !~ '^[0-9a-f]{64}$'
     or length(coalesce(p_token_preview, '')) < 1
     or length(coalesce(p_token_preview, '')) > 16 then
    raise exception 'INVALID_SHARE_TOKEN' using errcode = 'P0001';
  end if;

  -- This verifier canonicalizes Palestinian mobile formats (059/056 and
  -- 970/972/00970/00972), matches the subscriber + invoice in the same site,
  -- and returns null for disabled portals, archived subscribers, or invalid data.
  v_portal_invoice := public.powerhub_subscriber_portal_invoice(
    p_portal_code, p_subscriber_no, p_phone, p_invoice_no
  );
  if v_portal_invoice is null
     or v_portal_invoice->'subscriber' is null
     or v_portal_invoice->'invoice' is null
     or (v_portal_invoice->'subscriber'->>'subscriberNo') is distinct from btrim(p_subscriber_no)
     or (v_portal_invoice->'invoice'->>'invoiceNo') is distinct from btrim(p_invoice_no) then
    raise exception 'PORTAL_INVOICE_NOT_FOUND' using errcode = 'P0001';
  end if;

  select settings.site_id, site.tenant_id
    into v_site_id, v_tenant_id
  from public.site_portal_settings as settings
  join public.sites as site on site.id = settings.site_id
  where settings.portal_code = lower(btrim(p_portal_code))
    and settings.is_enabled = true
    and site.status = 'active'
  limit 1;

  if v_site_id is null or v_tenant_id is null then
    raise exception 'PORTAL_NOT_AVAILABLE' using errcode = 'P0001';
  end if;

  if not exists (
    select 1
    from public.powerhub_payment_documentation_access(v_tenant_id) as access
    where access.allowed = true
  ) then
    raise exception 'PAYMENT_DOCUMENTATION_NOT_AVAILABLE' using errcode = 'P0001';
  end if;

  -- Re-check and lock the exact invoice after identity verification. Do not
  -- issue a payment-documentation link for a paid/zero-balance invoice.
  select invoice.id, invoice.balance_due, invoice.status
    into v_invoice_id, v_invoice_balance_due, v_invoice_status
  from public.invoices as invoice
  join public.subscribers as subscriber
    on subscriber.id = invoice.subscriber_id
   and subscriber.tenant_id = invoice.tenant_id
   and subscriber.site_id = invoice.site_id
  where invoice.site_id = v_site_id
    and invoice.tenant_id = v_tenant_id
    and subscriber.archived_at is null
    and subscriber.subscriber_no = btrim(p_subscriber_no)
    and invoice.invoice_no = btrim(p_invoice_no)
    and invoice.status not in ('draft', 'cancelled')
  limit 1
  for update of invoice;

  if v_invoice_id is null then
    raise exception 'PORTAL_INVOICE_NOT_FOUND' using errcode = 'P0001';
  end if;

  if coalesce(v_invoice_balance_due, 0) <= 0 or v_invoice_status = 'paid' then
    raise exception 'INVOICE_ALREADY_PAID' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(
    hashtext('portal-invoice-share:' || v_tenant_id::text || ':' || v_invoice_id::text)::bigint
  );

  insert into public.invoice_share_links(tenant_id, invoice_id, token_hash, token_preview, expires_at)
  values(v_tenant_id, v_invoice_id, p_token_hash, p_token_preview, now() + interval '7 days')
  returning id into v_link_id;

  share_link_id := v_link_id;
  site_id := v_site_id;
  tenant_id := v_tenant_id;
  return next;
end;
$$;

revoke all on function public.powerhub_create_portal_invoice_share_link(text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.powerhub_create_portal_invoice_share_link(text, text, text, text, text, text) to service_role;
