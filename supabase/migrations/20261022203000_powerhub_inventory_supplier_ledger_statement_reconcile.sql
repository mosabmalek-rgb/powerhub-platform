-- Reconcile the supplier-ledger statement RPC that exists in staging but was
-- missing from the production migration history. Keep scope, paging, and ACL explicit.
create or replace function public.powerhub_inventory_supplier_ledger_statement(
  p_tenant_id bigint,
  p_site_id bigint,
  p_supplier_id bigint,
  p_limit integer default 200
)
returns jsonb
language plpgsql
set search_path=public,pg_temp
as $function$
declare
  v_supplier public.suppliers%rowtype;
  v_balance numeric(14,2);
  v_entries jsonb;
begin
  if p_tenant_id is null or p_site_id is null or p_supplier_id is null then
    raise exception 'SUPPLIER_LEDGER_SCOPE_REQUIRED' using errcode='P0001';
  end if;
  if not exists(select 1 from public.sites s where s.id=p_site_id and s.tenant_id=p_tenant_id) then
    raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001';
  end if;
  select s.* into v_supplier
  from public.suppliers s
  where s.tenant_id=p_tenant_id and s.id=p_supplier_id;
  if not found then raise exception 'SUPPLIER_OUT_OF_SCOPE' using errcode='P0001'; end if;

  select coalesce(sum(e.credit_amount-e.debit_amount),0)::numeric(14,2)
  into v_balance
  from public.supplier_ledger_entries e
  where e.tenant_id=p_tenant_id and e.site_id=p_site_id and e.supplier_id=p_supplier_id;

  select coalesce(jsonb_agg(to_jsonb(page) order by page.occurred_at desc,page.id desc),'[]'::jsonb)
  into v_entries
  from (
    select e.id,e.entry_type,e.debit_amount,e.credit_amount,e.purchase_id,e.supplier_payment_id,e.supplier_return_id,
      e.entry_key,e.reference_no,e.description,e.occurred_at,e.created_at
    from public.supplier_ledger_entries e
    where e.tenant_id=p_tenant_id and e.site_id=p_site_id and e.supplier_id=p_supplier_id
    order by e.occurred_at desc,e.id desc
    limit greatest(1,least(coalesce(p_limit,200),500))
  ) page;

  return jsonb_build_object(
    'supplier',jsonb_build_object('id',v_supplier.id,'name',v_supplier.name,'supplier_code',v_supplier.supplier_code),
    'site_id',p_site_id,'balance',v_balance,
    'entry_count',(select count(*) from public.supplier_ledger_entries e
      where e.tenant_id=p_tenant_id and e.site_id=p_site_id and e.supplier_id=p_supplier_id),
    'entries',v_entries
  );
end;
$function$;

revoke all on function public.powerhub_inventory_supplier_ledger_statement(bigint,bigint,bigint,integer) from public,anon,authenticated;
grant execute on function public.powerhub_inventory_supplier_ledger_statement(bigint,bigint,bigint,integer) to service_role;
