-- Phase D security hardening: filter event types inside PostgreSQL before keyset pagination.
-- A page cursor must never reveal the date/type/id of a financial event hidden by user permissions.
drop function if exists public.powerhub_inventory_phase_d_financial_details(bigint,bigint,date,date,integer,date,text,bigint);

create function public.powerhub_inventory_phase_d_financial_details(
  p_tenant_id bigint,
  p_site_id bigint,
  p_from_date date,
  p_to_date date,
  p_limit integer default 201,
  p_after_date date default null,
  p_after_event_type text default null,
  p_after_event_id bigint default null,
  p_include_purchase_invoices boolean default true,
  p_include_supplier_events boolean default true
)
returns table(
  event_date date,
  event_type text,
  event_id bigint,
  reference_no text,
  counterparty_name text,
  status text,
  amount numeric,
  related_reference text,
  refund_amount numeric,
  allocation_count bigint
)
language plpgsql
stable
security invoker
set search_path=public,pg_temp
as $phase_d_details$
begin
  if p_tenant_id is null or p_site_id is null
    or p_from_date is null or p_to_date is null
    or p_from_date>p_to_date or (p_to_date-p_from_date)>365 then
    raise exception 'INVALID_PHASE_D_FINANCIAL_RANGE' using errcode='P0001';
  end if;
  if p_limit is null or p_limit<1 or p_limit>201 then
    raise exception 'INVALID_PHASE_D_FINANCIAL_PAGE_SIZE' using errcode='P0001';
  end if;
  if num_nonnulls(p_after_date,p_after_event_type,p_after_event_id) not in (0,3) then
    raise exception 'INVALID_PHASE_D_FINANCIAL_CURSOR' using errcode='P0001';
  end if;
  if p_after_event_type is not null and p_after_event_type not in ('purchase_invoice','supplier_payment','supplier_return') then
    raise exception 'INVALID_PHASE_D_FINANCIAL_CURSOR' using errcode='P0001';
  end if;
  if p_include_purchase_invoices is null or p_include_supplier_events is null then
    raise exception 'INVALID_PHASE_D_FINANCIAL_FILTER_FLAGS' using errcode='P0001';
  end if;
  if not exists (
    select 1 from public.sites s where s.tenant_id=p_tenant_id and s.id=p_site_id
  ) then
    raise exception 'PHASE_D_FINANCIAL_SITE_OUT_OF_SCOPE' using errcode='P0001';
  end if;

  return query
  with events as (
    select p.invoice_date as event_date,'purchase_invoice'::text as event_type,p.id as event_id,
      p.purchase_number as reference_no,s.name as counterparty_name,p.status,
      p.total_amount::numeric(14,2) as amount,
      coalesce(nullif(btrim(p.supplier_invoice_no),''),p.purchase_number) as related_reference,
      0::numeric(14,2) as refund_amount,0::bigint as allocation_count
    from public.supplier_purchases p
    join public.suppliers s on s.tenant_id=p.tenant_id and s.id=p.supplier_id
    where p.tenant_id=p_tenant_id and p.site_id=p_site_id
      and p.invoice_date between p_from_date and p_to_date
      and p.status in ('confirmed','partially_received','received')
      and p_include_purchase_invoices

    union all

    select sp.payment_date as event_date,'supplier_payment'::text as event_type,sp.id as event_id,
      coalesce(nullif(btrim(sp.reference_no),''),'دفعة #'||sp.id::text) as reference_no,
      s.name as counterparty_name,sp.status,sp.amount::numeric(14,2) as amount,
      coalesce((
        select string_agg(coalesce(p.purchase_number,'سجل مورد #'||a.supplier_ledger_entry_id::text),', ' order by a.id)
        from public.supplier_payment_allocations a
        left join public.supplier_purchases p on p.tenant_id=a.tenant_id and p.id=a.purchase_id
        where a.tenant_id=sp.tenant_id and a.payment_id=sp.id
      ),'—') as related_reference,
      0::numeric(14,2) as refund_amount,
      (select count(*)::bigint from public.supplier_payment_allocations a
        where a.tenant_id=sp.tenant_id and a.payment_id=sp.id) as allocation_count
    from public.supplier_payments sp
    join public.suppliers s on s.tenant_id=sp.tenant_id and s.id=sp.supplier_id
    where sp.tenant_id=p_tenant_id and sp.site_id=p_site_id
      and sp.payment_date between p_from_date and p_to_date
      and sp.status='posted'
      and p_include_supplier_events

    union all

    select r.return_date as event_date,'supplier_return'::text as event_type,r.id as event_id,
      r.return_number as reference_no,s.name as counterparty_name,r.status,
      r.total_credit_amount::numeric(14,2) as amount,p.purchase_number as related_reference,
      r.refund_amount::numeric(14,2) as refund_amount,0::bigint as allocation_count
    from public.supplier_purchase_returns r
    join public.suppliers s on s.tenant_id=r.tenant_id and s.id=r.supplier_id
    join public.supplier_purchases p on p.tenant_id=r.tenant_id and p.id=r.purchase_id
    where r.tenant_id=p_tenant_id and r.site_id=p_site_id
      and r.return_date between p_from_date and p_to_date
      and r.status='posted'
      and p_include_supplier_events
  )
  select e.event_date,e.event_type,e.event_id,e.reference_no,e.counterparty_name,e.status,
    e.amount,e.related_reference,e.refund_amount,e.allocation_count
  from events e
  where p_after_date is null or (e.event_date,e.event_type,e.event_id)>(p_after_date,p_after_event_type,p_after_event_id)
  order by e.event_date asc,e.event_type asc,e.event_id asc
  limit p_limit;
end;
$phase_d_details$;

revoke all on function public.powerhub_inventory_phase_d_financial_details(bigint,bigint,date,date,integer,date,text,bigint,boolean,boolean)
  from public,anon,authenticated;
grant execute on function public.powerhub_inventory_phase_d_financial_details(bigint,bigint,date,date,integer,date,text,bigint,boolean,boolean)
  to service_role;
