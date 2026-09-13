-- Fix phone normalization in portal hardening: keep only digits and leading +.
-- This avoids regex escaping/range issues while preserving the portal's existing matching semantics.

create or replace function public.powerhub_subscriber_portal_lookup(p_portal_code text, p_subscriber_no text, p_phone text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_portal record; v_subscriber record; v_invoices jsonb; v_payments jsonb; v_key text; v_allowed boolean;
begin
  v_key := md5(lower(btrim(coalesce(p_portal_code, ''))) || '|' || btrim(coalesce(p_subscriber_no, '')) || '|' || regexp_replace(btrim(coalesce(p_phone, '')), '[^0-9+]', '', 'g'));
  v_allowed := public.powerhub_subscriber_portal_check_rate_limit(lower(btrim(coalesce(p_portal_code, ''))), v_key, 300, 8);
  if not v_allowed then perform public.powerhub_subscriber_portal_record_attempt(lower(btrim(coalesce(p_portal_code, ''))), v_key, false); return null; end if;
  select settings.portal_code, settings.display_name, settings.primary_color, settings.accent_color, site.id as site_id, site.name as site_name, site.city into v_portal
  from public.site_portal_settings settings inner join public.sites site on site.id=settings.site_id
  where settings.portal_code=lower(btrim(p_portal_code)) and settings.is_enabled=true and site.status='active' limit 1;
  if not found then perform public.powerhub_subscriber_portal_record_attempt(lower(btrim(coalesce(p_portal_code,''))),v_key,false); return null; end if;
  select subscriber.id,subscriber.subscriber_no,subscriber.full_name,subscriber.phone,subscriber.address,subscriber.subscription_type,subscriber.service_status,subscriber.created_at into v_subscriber
  from public.subscribers subscriber where subscriber.site_id=v_portal.site_id and subscriber.subscriber_no=btrim(p_subscriber_no)
    and regexp_replace(subscriber.phone,'[^0-9+]','','g')=regexp_replace(btrim(p_phone),'[^0-9+]','','g') limit 1;
  if not found then perform public.powerhub_subscriber_portal_record_attempt(lower(btrim(coalesce(p_portal_code,''))),v_key,false); return null; end if;
  select coalesce(jsonb_agg(jsonb_build_object('invoiceNo',invoice.invoice_no,'billingPeriod',invoice.billing_period,'issueDate',invoice.issue_date,'dueDate',invoice.due_date,'consumptionKwh',invoice.consumption_kwh,'totalAmount',invoice.total_amount,'paidAmount',invoice.paid_amount,'balanceDue',invoice.balance_due,'status',invoice.status) order by invoice.issue_date desc),'[]'::jsonb) into v_invoices from (select * from public.invoices where site_id=v_portal.site_id and subscriber_id=v_subscriber.id and status not in ('draft','cancelled') order by issue_date desc limit 24) invoice;
  select coalesce(jsonb_agg(jsonb_build_object('id',payment.id,'paymentNo',payment.payment_no,'amount',payment.amount,'paymentMethod',payment.payment_method,'status',payment.status,'paidAt',payment.paid_at,'invoiceNo',invoice.invoice_no) order by payment.paid_at desc),'[]'::jsonb) into v_payments from (select * from public.payments where site_id=v_portal.site_id and subscriber_id=v_subscriber.id order by paid_at desc limit 24) payment left join public.invoices invoice on invoice.id=payment.invoice_id where payment.status='completed';
  perform public.powerhub_subscriber_portal_record_attempt(lower(btrim(coalesce(p_portal_code,''))),v_key,true);
  return jsonb_build_object('portal',jsonb_build_object('portalCode',v_portal.portal_code,'displayName',coalesce(v_portal.display_name,v_portal.site_name),'primaryColor',v_portal.primary_color,'accentColor',v_portal.accent_color,'city',v_portal.city),'subscriber',jsonb_build_object('subscriberNo',v_subscriber.subscriber_no,'fullName',v_subscriber.full_name,'phone',v_subscriber.phone,'address',v_subscriber.address,'subscriptionType',v_subscriber.subscription_type,'serviceStatus',v_subscriber.service_status,'joinedAt',v_subscriber.created_at),'invoices',v_invoices,'payments',v_payments);
end;
$$;

create or replace function public.powerhub_subscriber_portal_invoice(p_portal_code text,p_subscriber_no text,p_phone text,p_invoice_no text)
returns jsonb language plpgsql volatile security definer set search_path=''
as $$
declare v_portal record;v_subscriber record;v_invoice record;v_lines jsonb;v_key text;v_allowed boolean;
begin
  v_key:=md5(lower(btrim(coalesce(p_portal_code,'')))||'|'||btrim(coalesce(p_subscriber_no,''))||'|'||regexp_replace(btrim(coalesce(p_phone,'')),'[^0-9+]','','g'));
  v_allowed:=public.powerhub_subscriber_portal_check_rate_limit(lower(btrim(coalesce(p_portal_code,''))),v_key,300,8);
  if not v_allowed then perform public.powerhub_subscriber_portal_record_attempt(lower(btrim(coalesce(p_portal_code,''))),v_key,false);return null;end if;
  select settings.portal_code,settings.display_name,settings.primary_color,settings.accent_color,site.id site_id,site.name site_name into v_portal from public.site_portal_settings settings inner join public.sites site on site.id=settings.site_id where settings.portal_code=lower(btrim(p_portal_code)) and settings.is_enabled=true and site.status='active' limit 1;
  if not found then perform public.powerhub_subscriber_portal_record_attempt(lower(btrim(coalesce(p_portal_code,''))),v_key,false);return null;end if;
  select subscriber.id,subscriber.subscriber_no,subscriber.full_name,subscriber.phone,subscriber.address into v_subscriber from public.subscribers subscriber where subscriber.site_id=v_portal.site_id and subscriber.subscriber_no=btrim(p_subscriber_no) and regexp_replace(subscriber.phone,'[^0-9+]','','g')=regexp_replace(btrim(p_phone),'[^0-9+]','','g') limit 1;
  if not found then perform public.powerhub_subscriber_portal_record_attempt(lower(btrim(coalesce(p_portal_code,''))),v_key,false);return null;end if;
  select invoice.id,invoice.invoice_no,invoice.billing_period,invoice.issue_date,invoice.due_date,invoice.previous_reading,invoice.current_reading,invoice.consumption_kwh,invoice.price_per_kwh,invoice.fixed_fee,invoice.tax_amount,invoice.discount_amount,invoice.total_amount,invoice.paid_amount,invoice.balance_due,invoice.status into v_invoice from public.invoices invoice where invoice.site_id=v_portal.site_id and invoice.subscriber_id=v_subscriber.id and invoice.invoice_no=btrim(p_invoice_no) and invoice.status not in ('draft','cancelled') limit 1;
  if not found then perform public.powerhub_subscriber_portal_record_attempt(lower(btrim(coalesce(p_portal_code,''))),v_key,false);return null;end if;
  select coalesce(jsonb_agg(jsonb_build_object('description',line.description,'quantity',line.quantity,'unitPrice',line.unit_price,'amount',line.amount) order by line.display_order asc),'[]'::jsonb) into v_lines from public.invoice_lines line where line.invoice_id=v_invoice.id;
  perform public.powerhub_subscriber_portal_record_attempt(lower(btrim(coalesce(p_portal_code,''))),v_key,true);
  return jsonb_build_object('portal',jsonb_build_object('displayName',coalesce(v_portal.display_name,v_portal.site_name),'primaryColor',v_portal.primary_color,'accentColor',v_portal.accent_color),'subscriber',jsonb_build_object('fullName',v_subscriber.full_name,'subscriberNo',v_subscriber.subscriber_no,'phone',v_subscriber.phone,'address',v_subscriber.address),'invoice',jsonb_build_object('invoiceNo',v_invoice.invoice_no,'billingPeriod',v_invoice.billing_period,'issueDate',v_invoice.issue_date,'dueDate',v_invoice.due_date,'previousReading',v_invoice.previous_reading,'currentReading',v_invoice.current_reading,'consumptionKwh',v_invoice.consumption_kwh,'pricePerKwh',v_invoice.price_per_kwh,'fixedFee',v_invoice.fixed_fee,'taxAmount',v_invoice.tax_amount,'discountAmount',v_invoice.discount_amount,'totalAmount',v_invoice.total_amount,'paidAmount',v_invoice.paid_amount,'balanceDue',v_invoice.balance_due,'status',v_invoice.status),'lines',v_lines);
end;
$$;

revoke all on function public.powerhub_subscriber_portal_lookup(text,text,text) from public,anon,authenticated;
grant execute on function public.powerhub_subscriber_portal_lookup(text,text,text) to service_role;
revoke all on function public.powerhub_subscriber_portal_invoice(text,text,text,text) from public,anon,authenticated;
grant execute on function public.powerhub_subscriber_portal_invoice(text,text,text,text) to service_role;
