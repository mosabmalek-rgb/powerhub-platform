-- Aggregate subscriber statement totals in PostgreSQL instead of transferring
-- every historical invoice, payment, and reading row to the application server.
-- Recent details remain bounded separately by getSupabaseSubscriberAccountStatement.
create or replace function public.powerhub_subscriber_statement_summary(
  p_tenant_id bigint,
  p_site_id bigint,
  p_subscriber_id bigint
)
returns table (
  invoice_count bigint,
  payment_count bigint,
  reading_count bigint,
  total_invoiced numeric,
  total_collected numeric,
  total_outstanding numeric,
  total_consumption_kwh numeric,
  last_payment_at timestamptz
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $function$
  select
    (
      select count(*)::bigint
      from public.invoices i
      where i.tenant_id = p_tenant_id
        and i.site_id = p_site_id
        and i.subscriber_id = p_subscriber_id
        and i.status <> 'cancelled'
    ),
    (
      select count(*)::bigint
      from public.payments p
      where p.tenant_id = p_tenant_id
        and p.site_id = p_site_id
        and p.subscriber_id = p_subscriber_id
        and p.status = 'completed'
    ),
    (
      select count(*)::bigint
      from public.meter_readings r
      where r.tenant_id = p_tenant_id
        and r.subscriber_id = p_subscriber_id
    ),
    (
      select coalesce(sum(i.total_amount), 0)::numeric
      from public.invoices i
      where i.tenant_id = p_tenant_id
        and i.site_id = p_site_id
        and i.subscriber_id = p_subscriber_id
        and i.status <> 'cancelled'
    ),
    (
      select coalesce(sum(p.amount), 0)::numeric
      from public.payments p
      where p.tenant_id = p_tenant_id
        and p.site_id = p_site_id
        and p.subscriber_id = p_subscriber_id
        and p.status = 'completed'
    ),
    (
      select coalesce(sum(i.balance_due), 0)::numeric
      from public.invoices i
      where i.tenant_id = p_tenant_id
        and i.site_id = p_site_id
        and i.subscriber_id = p_subscriber_id
        and i.status <> 'cancelled'
    ),
    (
      select coalesce(sum(i.consumption_kwh), 0)::numeric
      from public.invoices i
      where i.tenant_id = p_tenant_id
        and i.site_id = p_site_id
        and i.subscriber_id = p_subscriber_id
        and i.status <> 'cancelled'
    ),
    (
      select max(p.paid_at)
      from public.payments p
      where p.tenant_id = p_tenant_id
        and p.site_id = p_site_id
        and p.subscriber_id = p_subscriber_id
        and p.status = 'completed'
    );
$function$;

revoke all on function public.powerhub_subscriber_statement_summary(bigint, bigint, bigint) from public, anon, authenticated;
grant execute on function public.powerhub_subscriber_statement_summary(bigint, bigint, bigint) to service_role;
