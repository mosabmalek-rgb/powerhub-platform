-- PowerHub subscriber portal branding: administrator-controlled logo availability.
alter table public.site_portal_settings
  add column if not exists logo_key text;

comment on column public.site_portal_settings.logo_key is
  'Storage key for the generator owner logo shown in the public subscriber portal. Visible only when the platform feature is enabled.';

insert into public.platform_settings(
  setting_key,
  is_enabled,
  value,
  message,
  updated_at
)
values (
  'subscriber_portal_logo',
  false,
  '{}'::jsonb,
  'إتاحة شعار صاحب المولد في صفحة الاستعلامات العامة.',
  now()
)
on conflict (setting_key) do nothing;

create or replace function public.powerhub_update_site_portal_logo(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_logo_key text
)
returns table(
  site_id bigint,
  logo_key text,
  previous_logo_key text
)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_before jsonb;
  v_role text;
  v_previous_logo_key text;
begin
  if p_tenant_id is null or p_site_id is null or p_user_id is null then
    raise exception 'INVALID_PORTAL_LOGO_UPDATE' using errcode = 'P0001';
  end if;

  if p_logo_key is not null
    and (
      char_length(p_logo_key) > 500
      or p_logo_key !~ '^tenant-portal-branding/[0-9]+/logo-[^/]+\\.(png|jpg|webp)$'
    ) then
    raise exception 'INVALID_PORTAL_LOGO_KEY' using errcode = 'P0001';
  end if;

  if p_logo_key is not null
    and not exists (
      select 1
      from public.platform_settings
      where setting_key = 'subscriber_portal_logo'
        and is_enabled = true
    ) then
    raise exception 'PORTAL_LOGO_FEATURE_DISABLED' using errcode = 'P0001';
  end if;

  if not exists (
    select 1
    from public.tenant_members as membership
    where membership.tenant_id = p_tenant_id
      and membership.user_id = p_user_id
      and membership.role = 'owner'
      and membership.is_active = true
      and membership.membership_status = 'active'
  ) then
    raise exception 'OWNER_ACCESS_REQUIRED' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(
    hashtext('site-portal-logo:' || p_tenant_id::text || ':' || p_site_id::text)::bigint
  );

  perform 1
  from public.sites as site_row
  where site_row.id = p_site_id
    and site_row.tenant_id = p_tenant_id
    and site_row.status <> 'archived'
  for update;

  if not found then
    raise exception 'SITE_OUT_OF_SCOPE' using errcode = 'P0001';
  end if;

  select
    to_jsonb(settings),
    settings.logo_key
  into
    v_before,
    v_previous_logo_key
  from public.site_portal_settings as settings
  where settings.site_id = p_site_id
    and settings.tenant_id = p_tenant_id
  for update;

  if not found then
    raise exception 'PORTAL_SETTINGS_NOT_FOUND' using errcode = 'P0001';
  end if;

  update public.site_portal_settings as settings
  set logo_key = p_logo_key,
      updated_at = now()
  where settings.site_id = p_site_id
    and settings.tenant_id = p_tenant_id
  returning settings.site_id, settings.logo_key
  into site_id, logo_key;

  select u.platform_role
    into v_role
    from public.users as u
   where u.id = p_user_id;

  insert into public.audit_logs(
    tenant_id,
    site_id,
    user_id,
    actor_platform_role,
    entity_type,
    entity_id,
    action,
    before_data,
    after_data
  )
  values (
    p_tenant_id,
    p_site_id,
    p_user_id,
    v_role,
    'site_portal_settings',
    p_site_id::text,
    case when p_logo_key is null then 'remove_portal_logo' else 'update_portal_logo' end,
    v_before,
    jsonb_build_object(
      'logoKey', p_logo_key,
      'logoConfigured', p_logo_key is not null
    )
  );

  previous_logo_key := v_previous_logo_key;
  return next;
end;
$$;

revoke execute on function public.powerhub_update_site_portal_logo(bigint, bigint, bigint, text) from public, anon, authenticated;
grant execute on function public.powerhub_update_site_portal_logo(bigint, bigint, bigint, text) to service_role;

create or replace function public.powerhub_subscriber_portal_theme(
  p_portal_code text
)
returns table (
  portal_code text,
  display_name text,
  primary_color text,
  accent_color text,
  site_name text,
  city text,
  logo_key text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    settings.portal_code,
    settings.display_name,
    settings.primary_color,
    settings.accent_color,
    site.name,
    site.city,
    settings.logo_key
  from public.site_portal_settings as settings
  inner join public.sites as site on site.id = settings.site_id
  where settings.portal_code = lower(btrim(p_portal_code))
    and settings.is_enabled = true
    and site.status = 'active'
  limit 1;
$$;

create or replace function public.powerhub_subscriber_portal_lookup(
  p_portal_code text,
  p_subscriber_no text,
  p_phone text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_portal record;
  v_subscriber record;
  v_invoices jsonb;
  v_payments jsonb;
begin
  select
    settings.portal_code,
    settings.display_name,
    settings.primary_color,
    settings.accent_color,
    settings.logo_key,
    site.id as site_id,
    site.name as site_name,
    site.city
  into v_portal
  from public.site_portal_settings as settings
  inner join public.sites as site on site.id = settings.site_id
  where settings.portal_code = lower(btrim(p_portal_code))
    and settings.is_enabled = true
    and site.status = 'active'
  limit 1;

  if not found then
    return null;
  end if;

  select
    subscriber.id,
    subscriber.subscriber_no,
    subscriber.full_name,
    subscriber.phone,
    subscriber.address,
    subscriber.subscription_type,
    subscriber.service_status,
    subscriber.created_at
  into v_subscriber
  from public.subscribers as subscriber
  where subscriber.site_id = v_portal.site_id
    and subscriber.subscriber_no = btrim(p_subscriber_no)
    and regexp_replace(subscriber.phone, '[[:space:]\\-()]', '', 'g') = regexp_replace(btrim(p_phone), '[[:space:]\\-()]', '', 'g')
  limit 1;

  if not found then
    return null;
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'invoiceNo', invoice.invoice_no,
        'billingPeriod', invoice.billing_period,
        'issueDate', invoice.issue_date,
        'dueDate', invoice.due_date,
        'consumptionKwh', invoice.consumption_kwh,
        'totalAmount', invoice.total_amount,
        'paidAmount', invoice.paid_amount,
        'balanceDue', invoice.balance_due,
        'status', invoice.status
      )
      order by invoice.issue_date desc
    ),
    '[]'::jsonb
  )
  into v_invoices
  from (
    select *
    from public.invoices
    where site_id = v_portal.site_id
      and subscriber_id = v_subscriber.id
      and status not in ('draft', 'cancelled')
    order by issue_date desc
    limit 24
  ) as invoice;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', payment.id,
        'paymentNo', payment.payment_no,
        'amount', payment.amount,
        'paymentMethod', payment.payment_method,
        'status', payment.status,
        'paidAt', payment.paid_at,
        'invoiceNo', invoice.invoice_no
      )
      order by payment.paid_at desc
    ),
    '[]'::jsonb
  )
  into v_payments
  from (
    select *
    from public.payments
    where site_id = v_portal.site_id
      and subscriber_id = v_subscriber.id
    order by paid_at desc
    limit 24
  ) as payment
  left join public.invoices as invoice on invoice.id = payment.invoice_id
  where payment.status = 'completed';

  return jsonb_build_object(
    'portal', jsonb_build_object(
      'portalCode', v_portal.portal_code,
      'displayName', coalesce(v_portal.display_name, v_portal.site_name),
      'primaryColor', v_portal.primary_color,
      'accentColor', v_portal.accent_color,
      'city', v_portal.city,
      'logoKey', v_portal.logo_key
    ),
    'subscriber', jsonb_build_object(
      'subscriberNo', v_subscriber.subscriber_no,
      'fullName', v_subscriber.full_name,
      'phone', v_subscriber.phone,
      'address', v_subscriber.address,
      'subscriptionType', v_subscriber.subscription_type,
      'serviceStatus', v_subscriber.service_status,
      'joinedAt', v_subscriber.created_at
    ),
    'invoices', v_invoices,
    'payments', v_payments
  );
end;
$$;

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
as $$
declare
  v_portal record;
  v_subscriber record;
  v_invoice record;
  v_lines jsonb;
begin
  select
    settings.portal_code,
    settings.display_name,
    settings.primary_color,
    settings.accent_color,
    settings.logo_key,
    site.id as site_id,
    site.name as site_name
  into v_portal
  from public.site_portal_settings as settings
  inner join public.sites as site on site.id = settings.site_id
  where settings.portal_code = lower(btrim(p_portal_code))
    and settings.is_enabled = true
    and site.status = 'active'
  limit 1;

  if not found then
    return null;
  end if;

  select
    subscriber.id,
    subscriber.subscriber_no,
    subscriber.full_name,
    subscriber.phone,
    subscriber.address
  into v_subscriber
  from public.subscribers as subscriber
  where subscriber.site_id = v_portal.site_id
    and subscriber.subscriber_no = btrim(p_subscriber_no)
    and regexp_replace(subscriber.phone, '[[:space:]\\-()]', '', 'g') = regexp_replace(btrim(p_phone), '[[:space:]\\-()]', '', 'g')
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
    and invoice.subscriber_id = v_subscriber.id
    and invoice.invoice_no = btrim(p_invoice_no)
    and invoice.status not in ('draft', 'cancelled')
  limit 1;

  if not found then
    return null;
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'description', line.description,
        'quantity', line.quantity,
        'unitPrice', line.unit_price,
        'amount', line.amount
      )
      order by line.display_order asc
    ),
    '[]'::jsonb
  )
  into v_lines
  from public.invoice_lines as line
  where line.invoice_id = v_invoice.id;

  return jsonb_build_object(
    'portal', jsonb_build_object(
      'displayName', coalesce(v_portal.display_name, v_portal.site_name),
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
$$;

revoke all on function public.powerhub_subscriber_portal_theme(text) from public, anon, authenticated;
revoke all on function public.powerhub_subscriber_portal_lookup(text, text, text) from public, anon, authenticated;
revoke all on function public.powerhub_subscriber_portal_invoice(text, text, text, text) from public, anon, authenticated;

grant execute on function public.powerhub_subscriber_portal_theme(text) to service_role;
grant execute on function public.powerhub_subscriber_portal_lookup(text, text, text) to service_role;
grant execute on function public.powerhub_subscriber_portal_invoice(text, text, text, text) to service_role;
