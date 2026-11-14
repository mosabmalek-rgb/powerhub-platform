-- Reconcile supplier payable aging allocations to the payment's exact branch and supplier.
-- Fail closed on malformed posted allocations rather than silently under/overstating branch balances.
create or replace function public.powerhub_inventory_supplier_payables_aging(
  p_tenant_id bigint,
  p_site_id bigint,
  p_as_of_date date default current_date
)
returns jsonb
language plpgsql
stable
security invoker
set search_path=public,pg_temp
as $$
declare
  v_as_of date:=coalesce(p_as_of_date,current_date);
  v_result jsonb;
begin
  if not exists(select 1 from public.sites s where s.tenant_id=p_tenant_id and s.id=p_site_id) then
    raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001';
  end if;

  -- Reject malformed posted allocations when either the payment or target document
  -- belongs to this branch. This prevents cross-branch payments from altering local balances.
  if exists (
    select 1
    from public.supplier_payment_allocations a
    join public.supplier_payments sp
      on sp.tenant_id=a.tenant_id and sp.id=a.payment_id and sp.status='posted'
    left join public.supplier_purchases p
      on p.tenant_id=a.tenant_id and p.id=a.purchase_id
    left join public.supplier_ledger_entries opening
      on opening.tenant_id=a.tenant_id and opening.id=a.supplier_ledger_entry_id
    where a.tenant_id=p_tenant_id
      and (
        sp.site_id=p_site_id
        or p.site_id=p_site_id
        or opening.site_id=p_site_id
      )
      and (
        (a.purchase_id is null)=(a.supplier_ledger_entry_id is null)
        or (
          a.purchase_id is not null
          and (p.id is null or p.site_id<>sp.site_id or p.supplier_id<>sp.supplier_id)
        )
        or (
          a.supplier_ledger_entry_id is not null
          and (
            opening.id is null or opening.site_id<>sp.site_id
            or opening.supplier_id<>sp.supplier_id
            or opening.entry_type<>'opening_balance'
            or opening.purchase_id is not null
            or opening.supplier_payment_id is not null
          )
        )
      )
  ) then
    raise exception 'SUPPLIER_PAYMENT_ALLOCATION_SCOPE_INVALID' using errcode='P0001';
  end if;

  with invoice_docs as (
    select
      'purchase_invoice'::text as document_type,
      p.id as document_id,
      p.supplier_id,
      s.name as supplier_name,
      p.purchase_number as document_number,
      p.invoice_date as document_date,
      coalesce(p.due_date,p.invoice_date+p.payment_terms_days) as due_date,
      p.total_amount::numeric(14,2) as gross_amount,
      coalesce(pay.paid_amount,0)::numeric(14,2) as paid_amount,
      coalesce(ret.return_credit,0)::numeric(14,2) as credit_amount,
      greatest(0,p.total_amount-coalesce(pay.paid_amount,0)-coalesce(ret.return_credit,0))::numeric(14,2) as outstanding_amount
    from public.supplier_purchases p
    join public.suppliers s on s.tenant_id=p.tenant_id and s.id=p.supplier_id
    left join lateral (
      select coalesce(sum(a.amount),0)::numeric(14,2) as paid_amount
      from public.supplier_payment_allocations a
      join public.supplier_payments sp on sp.tenant_id=a.tenant_id and sp.id=a.payment_id and sp.status='posted'
      where a.tenant_id=p.tenant_id and a.purchase_id=p.id
        and sp.site_id=p.site_id and sp.supplier_id=p.supplier_id
    ) pay on true
    left join lateral (
      select public.powerhub_inventory_purchase_supplier_return_credit(p.tenant_id,p.id)::numeric(14,2) as return_credit
    ) ret on true
    where p.tenant_id=p_tenant_id and p.site_id=p_site_id
      and p.status in ('confirmed','partially_received','received')
  ), opening_docs as (
    select
      'opening_balance'::text as document_type,
      e.id as document_id,
      e.supplier_id,
      s.name as supplier_name,
      coalesce(nullif(e.reference_no,''),'رصيد افتتاحي') as document_number,
      e.occurred_at::date as document_date,
      e.occurred_at::date as due_date,
      e.credit_amount::numeric(14,2) as gross_amount,
      coalesce(pay.paid_amount,0)::numeric(14,2) as paid_amount,
      0::numeric(14,2) as credit_amount,
      greatest(0,e.credit_amount-coalesce(pay.paid_amount,0))::numeric(14,2) as outstanding_amount
    from public.supplier_ledger_entries e
    join public.suppliers s on s.tenant_id=e.tenant_id and s.id=e.supplier_id
    left join lateral (
      select coalesce(sum(a.amount),0)::numeric(14,2) as paid_amount
      from public.supplier_payment_allocations a
      join public.supplier_payments sp on sp.tenant_id=a.tenant_id and sp.id=a.payment_id and sp.status='posted'
      where a.tenant_id=e.tenant_id and a.supplier_ledger_entry_id=e.id
        and sp.site_id=e.site_id and sp.supplier_id=e.supplier_id
    ) pay on true
    where e.tenant_id=p_tenant_id and e.site_id=p_site_id
      and e.entry_type='opening_balance' and e.purchase_id is null
      and e.supplier_payment_id is null and e.credit_amount>0
  ), all_docs as (
    select * from invoice_docs
    union all
    select * from opening_docs
  ), due_docs as (
    select d.*,
      greatest(0,(v_as_of-d.due_date))::integer as days_overdue,
      case
        when d.due_date>=v_as_of then 'not_due'
        when v_as_of-d.due_date between 1 and 30 then 'days_1_30'
        when v_as_of-d.due_date between 31 and 60 then 'days_31_60'
        when v_as_of-d.due_date between 61 and 90 then 'days_61_90'
        else 'days_91_plus'
      end as aging_bucket
    from all_docs d
    where d.outstanding_amount>0
  )
  select jsonb_build_object(
    'as_of_date',v_as_of,
    'totals',jsonb_build_object(
      'not_due',coalesce(sum(d.outstanding_amount) filter(where d.aging_bucket='not_due'),0),
      'days_1_30',coalesce(sum(d.outstanding_amount) filter(where d.aging_bucket='days_1_30'),0),
      'days_31_60',coalesce(sum(d.outstanding_amount) filter(where d.aging_bucket='days_31_60'),0),
      'days_61_90',coalesce(sum(d.outstanding_amount) filter(where d.aging_bucket='days_61_90'),0),
      'days_91_plus',coalesce(sum(d.outstanding_amount) filter(where d.aging_bucket='days_91_plus'),0),
      'total_outstanding',coalesce(sum(d.outstanding_amount),0)
    ),
    'rows',coalesce(jsonb_agg(to_jsonb(d) order by d.supplier_name,d.due_date,d.document_number),'[]'::jsonb)
  ) into v_result from due_docs d;
  return coalesce(v_result,jsonb_build_object('as_of_date',v_as_of,'totals',jsonb_build_object(),'rows','[]'::jsonb));
end;
$$;

revoke all on function public.powerhub_inventory_supplier_payables_aging(bigint,bigint,date)
  from public,anon,authenticated;
grant execute on function public.powerhub_inventory_supplier_payables_aging(bigint,bigint,date)
  to service_role;
