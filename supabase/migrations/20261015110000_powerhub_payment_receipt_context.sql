-- Collapse the post-approval payment/SMS context lookups into one indexed read.
-- This is strictly a read helper: the approval RPC remains the sole authority for
-- creating the payment, updating the invoice, recording the collection, and auditing.
create or replace function public.powerhub_payment_receipt_context(
  p_tenant_id bigint,
  p_site_id bigint,
  p_payment_id bigint
)
returns table(
  payment_id bigint,
  invoice_id bigint,
  subscriber_id bigint,
  payment_no text,
  payment_amount numeric,
  invoice_no text,
  balance_due numeric,
  subscriber_name text,
  subscriber_phone text,
  template_body text
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $function$
  select
    p.id,
    i.id,
    s.id,
    p.payment_no,
    p.amount,
    i.invoice_no,
    i.balance_due,
    s.full_name,
    s.phone,
    template.body
  from public.payments p
  join public.invoices i
    on i.id = p.invoice_id
   and i.tenant_id = p.tenant_id
   and i.site_id = p.site_id
  join public.subscribers s
    on s.id = p.subscriber_id
   and s.tenant_id = p.tenant_id
   and s.site_id = p.site_id
  left join lateral (
    select t.body
    from public.tenant_payment_receipt_message_templates t
    where t.tenant_id = p_tenant_id
      and t.channel = 'sms'
      and t.is_active = true
    order by t.updated_at desc
    limit 1
  ) template on true
  where p.id = p_payment_id
    and p.tenant_id = p_tenant_id
    and p.site_id = p_site_id
    and p.invoice_id is not null
  limit 1;
$function$;

revoke all on function public.powerhub_payment_receipt_context(bigint, bigint, bigint) from public, anon, authenticated;
grant execute on function public.powerhub_payment_receipt_context(bigint, bigint, bigint) to service_role;
