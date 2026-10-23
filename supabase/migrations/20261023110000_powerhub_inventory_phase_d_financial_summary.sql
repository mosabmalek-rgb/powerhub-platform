-- Phase D: source-backed procurement, settlement and supplier-credit summary.
-- These are distinct financial events; purchase totals and payments must not be added together
-- and re-labeled as operating expenses or generator consumption costs.
create or replace function public.powerhub_inventory_phase_d_financial_summary(
  p_tenant_id bigint,
  p_site_id bigint,
  p_from_date date,
  p_to_date date
)
returns table(
  purchase_invoice_count bigint,
  purchase_invoice_amount numeric,
  supplier_payment_count bigint,
  supplier_payment_amount numeric,
  supplier_return_count bigint,
  supplier_return_credit_amount numeric
)
language plpgsql
stable
security invoker
set search_path=public,pg_temp
as $phase_d$
begin
  if p_tenant_id is null or p_site_id is null
    or p_from_date is null or p_to_date is null
    or p_from_date>p_to_date or (p_to_date-p_from_date)>365 then
    raise exception 'INVALID_PHASE_D_FINANCIAL_RANGE' using errcode='P0001';
  end if;

  if not exists (
    select 1 from public.sites s
    where s.tenant_id=p_tenant_id and s.id=p_site_id
  ) then
    raise exception 'PHASE_D_FINANCIAL_SITE_OUT_OF_SCOPE' using errcode='P0001';
  end if;

  return query
  select
    (select count(*)::bigint
       from public.supplier_purchases p
      where p.tenant_id=p_tenant_id and p.site_id=p_site_id
        and p.invoice_date between p_from_date and p_to_date
        and p.status in ('confirmed','partially_received','received')),
    (select coalesce(sum(p.total_amount),0)::numeric(14,2)
       from public.supplier_purchases p
      where p.tenant_id=p_tenant_id and p.site_id=p_site_id
        and p.invoice_date between p_from_date and p_to_date
        and p.status in ('confirmed','partially_received','received')),
    (select count(*)::bigint
       from public.supplier_payments p
      where p.tenant_id=p_tenant_id and p.site_id=p_site_id
        and p.payment_date between p_from_date and p_to_date
        and p.status='posted'),
    (select coalesce(sum(p.amount),0)::numeric(14,2)
       from public.supplier_payments p
      where p.tenant_id=p_tenant_id and p.site_id=p_site_id
        and p.payment_date between p_from_date and p_to_date
        and p.status='posted'),
    (select count(*)::bigint
       from public.supplier_purchase_returns r
      where r.tenant_id=p_tenant_id and r.site_id=p_site_id
        and r.return_date between p_from_date and p_to_date
        and r.status='posted'),
    (select coalesce(sum(r.total_credit_amount),0)::numeric(14,2)
       from public.supplier_purchase_returns r
      where r.tenant_id=p_tenant_id and r.site_id=p_site_id
        and r.return_date between p_from_date and p_to_date
        and r.status='posted');
end;
$phase_d$;

revoke all on function public.powerhub_inventory_phase_d_financial_summary(bigint,bigint,date,date)
  from public,anon,authenticated;
grant execute on function public.powerhub_inventory_phase_d_financial_summary(bigint,bigint,date,date)
  to service_role;
