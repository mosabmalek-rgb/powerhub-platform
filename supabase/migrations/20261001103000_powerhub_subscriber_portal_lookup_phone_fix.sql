-- Fix subscriber portal phone normalization and preserve portal branding.
-- Digits-only comparison avoids the invalid character-class escaping that
-- previously caused powerhub_subscriber_portal_lookup to raise 2201B.

create or replace function public.powerhub_subscriber_portal_lookup(p_portal_code text, p_subscriber_no text, p_phone text)
returns jsonb
language plpgsql
stable security definer
set search_path=''
as $function$
declare v_portal record; v_subscriber record; v_invoices jsonb; v_payments jsonb;
begin
 select
   s.portal_code,
   case when access.allowed then s.display_name else 'صفحة استعلامات المشتركين' end as display_name,
   s.primary_color,
   s.accent_color,
   case when access.allowed then s.logo_key else null end as logo_key,
   case when access.allowed then site.city else null end as city,
   case when access.allowed then site.name else 'صفحة استعلامات المشتركين' end as site_name,
   site.id as site_id
 into v_portal
 from public.site_portal_settings s
 join public.sites site on site.id=s.site_id
 cross join lateral public.powerhub_subscriber_portal_logo_access(s.tenant_id) access
 where s.portal_code=lower(btrim(p_portal_code)) and s.is_enabled=true and site.status='active' limit 1;
 if not found then return null; end if;

 select sub.id,sub.subscriber_no,sub.full_name,sub.phone,sub.address,sub.subscription_type,sub.service_status,sub.created_at
 into v_subscriber
 from public.subscribers sub
 where sub.site_id=v_portal.site_id
   and sub.subscriber_no=btrim(p_subscriber_no)
   and regexp_replace(coalesce(sub.phone,''),'[^0-9]','','g')=regexp_replace(btrim(coalesce(p_phone,'')),'[^0-9]','','g')
 limit 1;
 if not found then return null; end if;

 select coalesce(jsonb_agg(jsonb_build_object('invoiceNo',i.invoice_no,'billingPeriod',i.billing_period,'issueDate',i.issue_date,'dueDate',i.due_date,'consumptionKwh',i.consumption_kwh,'totalAmount',i.total_amount,'paidAmount',i.paid_amount,'balanceDue',i.balance_due,'status',i.status) order by i.issue_date desc),'[]'::jsonb)
 into v_invoices from (select * from public.invoices where site_id=v_portal.site_id and subscriber_id=v_subscriber.id and status not in ('draft','cancelled') order by issue_date desc limit 24)i;

 select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'paymentNo',p.payment_no,'amount',p.amount,'paymentMethod',p.payment_method,'status',p.status,'paidAt',p.paid_at,'invoiceNo',i.invoice_no) order by p.paid_at desc),'[]'::jsonb)
 into v_payments from (select * from public.payments where site_id=v_portal.site_id and subscriber_id=v_subscriber.id order by paid_at desc limit 24)p
 left join public.invoices i on i.id=p.invoice_id where p.status='completed';

 return jsonb_build_object(
  'portal',jsonb_build_object('portalCode',v_portal.portal_code,'displayName',v_portal.display_name,'primaryColor',v_portal.primary_color,'accentColor',v_portal.accent_color,'city',v_portal.city,'logoKey',v_portal.logo_key),
  'subscriber',jsonb_build_object('subscriberNo',v_subscriber.subscriber_no,'fullName',v_subscriber.full_name,'phone',v_subscriber.phone,'address',v_subscriber.address,'subscriptionType',v_subscriber.subscription_type,'serviceStatus',v_subscriber.service_status,'joinedAt',v_subscriber.created_at),
  'invoices',v_invoices,'payments',v_payments
 );
end;
$function$;

revoke all on function public.powerhub_subscriber_portal_lookup(text,text,text) from public,anon,authenticated;
grant execute on function public.powerhub_subscriber_portal_lookup(text,text,text) to service_role;
