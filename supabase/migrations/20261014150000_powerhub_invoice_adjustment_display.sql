-- Expose line type in subscriber and shared invoice payloads so applied discounts
-- are displayed as deductions rather than positive charges.
create or replace function public.powerhub_subscriber_portal_invoice(
  p_portal_code text,
  p_subscriber_no text,
  p_phone text,
  p_invoice_no text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_portal record;
  v_subscriber record;
  v_invoice record;
  v_lines jsonb;
  v_input_digits text;
  v_input_phone text;
  v_stored_digits text;
  v_stored_phone text;
  v_key text;
  v_allowed boolean;
begin
  v_input_digits := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  v_input_phone := case
    when v_input_digits ~ '^00(970|972)(56|59)[0-9]{7}$' then '0' || substring(v_input_digits from 6)
    when v_input_digits ~ '^(970|972)(56|59)[0-9]{7}$' then '0' || substring(v_input_digits from 4)
    when v_input_digits ~ '^0(56|59)[0-9]{7}$' then v_input_digits
    when v_input_digits ~ '^(56|59)[0-9]{7}$' then '0' || v_input_digits
    else v_input_digits
  end;

  -- Canonicalizing the key prevents bypassing the same identity's rate limit by
  -- switching between 059..., +970..., 00970..., or other equivalent formatting.
  v_key := md5(
    lower(btrim(coalesce(p_portal_code, ''))) || '|' ||
    btrim(coalesce(p_subscriber_no, '')) || '|' || v_input_phone
  );
  v_allowed := public.powerhub_subscriber_portal_check_rate_limit(
    lower(btrim(coalesce(p_portal_code, ''))), v_key, 300, 8
  );
  if not v_allowed then
    perform public.powerhub_subscriber_portal_record_attempt(
      lower(btrim(coalesce(p_portal_code, ''))), v_key, false
    );
    return null;
  end if;

  select
    settings.portal_code,
    case when logo_access.allowed then settings.display_name else 'صفحة استعلامات المشتركين' end as display_name,
    settings.primary_color,
    settings.accent_color,
    case when logo_access.allowed then settings.logo_key else null end as logo_key,
    settings.tenant_id,
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
    perform public.powerhub_subscriber_portal_record_attempt(
      lower(btrim(coalesce(p_portal_code, ''))), v_key, false
    );
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
  cross join lateral (
    select regexp_replace(coalesce(subscriber.phone, ''), '[^0-9]', '', 'g') as digits
  ) as stored_digits
  where subscriber.site_id = v_portal.site_id
    and subscriber.tenant_id = v_portal.tenant_id
    and subscriber.archived_at is null
    and subscriber.subscriber_no = btrim(p_subscriber_no)
    and (
      case
        when stored_digits.digits ~ '^00(970|972)(56|59)[0-9]{7}$' then '0' || substring(stored_digits.digits from 6)
        when stored_digits.digits ~ '^(970|972)(56|59)[0-9]{7}$' then '0' || substring(stored_digits.digits from 4)
        when stored_digits.digits ~ '^0(56|59)[0-9]{7}$' then stored_digits.digits
        when stored_digits.digits ~ '^(56|59)[0-9]{7}$' then '0' || stored_digits.digits
        else stored_digits.digits
      end
    ) = v_input_phone
  limit 1;

  if not found then
    perform public.powerhub_subscriber_portal_record_attempt(
      lower(btrim(coalesce(p_portal_code, ''))), v_key, false
    );
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
    perform public.powerhub_subscriber_portal_record_attempt(
      lower(btrim(coalesce(p_portal_code, ''))), v_key, false
    );
    return null;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'lineType', line.line_type,
    'description', line.description,
    'quantity', line.quantity,
    'unitPrice', line.unit_price,
    'amount', line.amount
  ) order by line.display_order asc), '[]'::jsonb)
  into v_lines
  from public.invoice_lines as line
  where line.invoice_id = v_invoice.id
    and line.tenant_id = v_portal.tenant_id;

  perform public.powerhub_subscriber_portal_record_attempt(
    lower(btrim(coalesce(p_portal_code, ''))), v_key, true
  );

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


revoke all on function public.powerhub_subscriber_portal_invoice(text,text,text,text) from public,anon,authenticated;
grant execute on function public.powerhub_subscriber_portal_invoice(text,text,text,text) to service_role;

create or replace function public.powerhub_get_shared_invoice_by_token_hash(p_token_hash text)
returns jsonb
language plpgsql
security invoker
set search_path=public,pg_temp
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
  select * into v_link from public.invoice_share_links where token_hash=p_token_hash for update;
  if not found or v_link.revoked_at is not null or (v_link.expires_at is not null and v_link.expires_at<=now()) then
    raise exception 'SHARE_LINK_NOT_FOUND' using errcode='P0001';
  end if;
  select * into v_invoice from public.invoices
  where id=v_link.invoice_id and tenant_id=v_link.tenant_id;
  if not found then
    raise exception 'SHARE_LINK_NOT_FOUND' using errcode='P0001';
  end if;
  select full_name,subscriber_no into v_subscriber
  from public.subscribers
  where id=v_invoice.subscriber_id and tenant_id=v_link.tenant_id;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',line.id,'lineType',line.line_type,'description',line.description,'amount',line.amount,
    'quantity',line.quantity,'unitPrice',line.unit_price,'displayOrder',line.display_order
  ) order by line.display_order),'[]'::jsonb)
  into v_lines
  from public.invoice_lines line
  where line.invoice_id=v_invoice.id and line.tenant_id=v_link.tenant_id;
  update public.invoice_share_links
  set view_count=view_count+1,last_viewed_at=now()
  where id=v_link.id;
  return jsonb_build_object(
    'siteId',v_invoice.site_id,
    'tenantId',v_link.tenant_id,
    'invoice',jsonb_build_object(
      'id',v_invoice.id,'subscriberId',v_invoice.subscriber_id,'invoiceNo',v_invoice.invoice_no,
      'billingPeriod',v_invoice.billing_period,'issueDate',v_invoice.issue_date,'dueDate',v_invoice.due_date,
      'previousReading',v_invoice.previous_reading,'currentReading',v_invoice.current_reading,
      'consumptionKwh',v_invoice.consumption_kwh,'pricePerKwh',v_invoice.price_per_kwh,
      'fixedFee',v_invoice.fixed_fee,'taxAmount',v_invoice.tax_amount,'discountAmount',v_invoice.discount_amount,
      'totalAmount',v_invoice.total_amount,'paidAmount',v_invoice.paid_amount,'balanceDue',v_invoice.balance_due,'status',v_invoice.status
    ),
    'subscriber',case when v_subscriber is null then null else jsonb_build_object('fullName',v_subscriber.full_name,'subscriberNo',v_subscriber.subscriber_no) end,
    'lines',v_lines
  );
end;
$$;


revoke all on function public.powerhub_get_shared_invoice_by_token_hash(text) from public,anon,authenticated;
grant execute on function public.powerhub_get_shared_invoice_by_token_hash(text) to service_role;
