-- Consolidated inventory/accounting completion batch.
-- All reversals are append-only and atomic; no original financial or stock rows are deleted.

create or replace function public.powerhub_inventory_cancel_purchase(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_purchase_id bigint,
  p_reason text
)
returns table(purchase_id bigint,purchase_number text,status text,replayed boolean)
language plpgsql
security invoker
set search_path=public,pg_temp
as $$
declare
  v_purchase public.supplier_purchases%rowtype;
  v_platform_role text;
  v_reason text := nullif(btrim(p_reason),'');
  v_period_locked boolean;
begin
  if v_reason is null or length(v_reason)>500 then
    raise exception 'PURCHASE_CANCELLATION_REASON_REQUIRED' using errcode='P0001';
  end if;

  select p.* into v_purchase
  from public.supplier_purchases p
  where p.tenant_id=p_tenant_id and p.site_id=p_site_id and p.id=p_purchase_id
  for update;
  if not found then raise exception 'PURCHASE_NOT_FOUND' using errcode='P0001'; end if;

  select u.platform_role into v_platform_role from public.users u where u.id=p_user_id;
  if not found then raise exception 'ACTOR_NOT_FOUND' using errcode='P0001'; end if;

  if v_purchase.status='cancelled' then
    return query select v_purchase.id,v_purchase.purchase_number,v_purchase.status,true;
    return;
  end if;
  if v_purchase.status not in ('draft','confirmed') then
    raise exception 'PURCHASE_CANNOT_BE_CANCELLED_AFTER_RECEIPT' using errcode='P0001';
  end if;

  if exists (
    select 1 from public.supplier_purchase_receipts r
    where r.tenant_id=p_tenant_id and r.purchase_id=v_purchase.id
  ) or exists (
    select 1 from public.inventory_stock_movements m
    where m.tenant_id=p_tenant_id and m.purchase_id=v_purchase.id
  ) then
    raise exception 'PURCHASE_CANNOT_BE_CANCELLED_AFTER_RECEIPT' using errcode='P0001';
  end if;

  if exists (
    select 1 from public.supplier_payment_allocations a
    join public.supplier_payments sp on sp.tenant_id=a.tenant_id and sp.id=a.payment_id
    where a.tenant_id=p_tenant_id and a.purchase_id=v_purchase.id and sp.status='posted'
  ) then
    raise exception 'PURCHASE_HAS_POSTED_PAYMENTS' using errcode='P0001';
  end if;

  select exists (
    select 1 from public.financial_settlements fs
    where fs.tenant_id=p_tenant_id and fs.site_id=p_site_id and fs.status='locked'
      and (
        (fs.period_start<=now() and fs.period_end>=now())
        or (fs.period_start::date<=v_purchase.invoice_date and fs.period_end::date>=v_purchase.invoice_date)
      )
  ) into v_period_locked;
  if v_period_locked then raise exception 'FINANCIAL_PERIOD_LOCKED' using errcode='P0001'; end if;

  if v_purchase.status='confirmed' and v_purchase.total_amount>0 then
    insert into public.supplier_ledger_entries(
      tenant_id,site_id,supplier_id,entry_type,debit_amount,purchase_id,entry_key,
      reference_no,description,occurred_at,created_by_user_id
    ) values (
      p_tenant_id,p_site_id,v_purchase.supplier_id,'reversal',v_purchase.total_amount,v_purchase.id,
      'purchase-cancellation:'||v_purchase.id,v_purchase.supplier_invoice_no,
      'عكس استحقاق فاتورة مشتريات ملغاة '||v_purchase.purchase_number||' — '||v_reason,now(),p_user_id
    );
  end if;

  update public.supplier_purchases p
  set status='cancelled',cancelled_at=now(),cancelled_by_user_id=p_user_id,
      notes=concat_ws(E'\n',nullif(p.notes,''),'سبب الإلغاء: '||v_reason),updated_at=now()
  where p.tenant_id=p_tenant_id and p.id=v_purchase.id
  returning * into v_purchase;

  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,
    before_data,after_data,metadata
  ) values (
    p_tenant_id,p_site_id,p_user_id,v_platform_role,'supplier_purchase',v_purchase.id::text,'cancel',
    jsonb_build_object('status',case when v_purchase.confirmed_at is null then 'draft' else 'confirmed' end,
      'totalAmount',v_purchase.total_amount),
    jsonb_build_object('status',v_purchase.status,'cancelledAt',v_purchase.cancelled_at,
      'reason',v_reason,'supplierId',v_purchase.supplier_id),
    jsonb_build_object('inventoryUnchanged',true,'financialReversal',v_purchase.confirmed_at is not null)
  );

  return query select v_purchase.id,v_purchase.purchase_number,v_purchase.status,false;
end;
$$;

create or replace function public.powerhub_inventory_reverse_supplier_payment(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_payment_id bigint,
  p_reason text
)
returns table(
  payment_id bigint,purchase_id bigint,status text,amount numeric,
  paid_amount numeric,outstanding_amount numeric,account_balance numeric,replayed boolean
)
language plpgsql
security invoker
set search_path=public,pg_temp
as $$
declare
  v_payment public.supplier_payments%rowtype;
  v_purchase public.supplier_purchases%rowtype;
  v_account public.company_accounts%rowtype;
  v_allocation public.supplier_payment_allocations%rowtype;
  v_platform_role text;
  v_reason text := nullif(btrim(p_reason),'');
  v_account_balance numeric(14,2);
  v_paid_amount numeric(14,2);
  v_outstanding numeric(14,2);
  v_period_locked boolean;
  v_replayed boolean := false;
begin
  if v_reason is null or length(v_reason)>500 then
    raise exception 'SUPPLIER_PAYMENT_REVERSAL_REASON_REQUIRED' using errcode='P0001';
  end if;

  -- Read the immutable account link first; lock order matches payment posting (account -> purchase -> payment).
  select sp.* into v_payment
  from public.supplier_payments sp
  where sp.tenant_id=p_tenant_id and sp.site_id=p_site_id and sp.id=p_payment_id;
  if not found then raise exception 'SUPPLIER_PAYMENT_NOT_FOUND' using errcode='P0001'; end if;

  perform pg_advisory_xact_lock(v_payment.company_account_id);
  select ca.* into v_account
  from public.company_accounts ca
  where ca.tenant_id=p_tenant_id and ca.id=v_payment.company_account_id
  for update;
  if not found then raise exception 'COMPANY_ACCOUNT_NOT_FOUND' using errcode='P0001'; end if;

  select a.* into v_allocation
  from public.supplier_payment_allocations a
  where a.tenant_id=p_tenant_id and a.payment_id=p_payment_id
  order by a.id limit 1;
  if not found then raise exception 'SUPPLIER_PAYMENT_ALLOCATION_NOT_FOUND' using errcode='P0001'; end if;

  select p.* into v_purchase
  from public.supplier_purchases p
  where p.tenant_id=p_tenant_id and p.site_id=p_site_id and p.id=v_allocation.purchase_id
  for update;
  if not found then raise exception 'PURCHASE_NOT_FOUND' using errcode='P0001'; end if;

  select sp.* into v_payment
  from public.supplier_payments sp
  where sp.tenant_id=p_tenant_id and sp.site_id=p_site_id and sp.id=p_payment_id
  for update;
  if not found then raise exception 'SUPPLIER_PAYMENT_NOT_FOUND' using errcode='P0001'; end if;

  select u.platform_role into v_platform_role from public.users u where u.id=p_user_id;
  if not found then raise exception 'ACTOR_NOT_FOUND' using errcode='P0001'; end if;

  if v_payment.status='reversed' then
    v_replayed := true;
  elsif v_payment.status='posted' then
    select exists (
      select 1 from public.financial_settlements fs
      where fs.tenant_id=p_tenant_id and fs.site_id=p_site_id and fs.status='locked'
        and (
          (fs.period_start<=now() and fs.period_end>=now())
          or (fs.period_start::date<=v_payment.payment_date and fs.period_end::date>=v_payment.payment_date)
        )
    ) into v_period_locked;
    if v_period_locked then raise exception 'FINANCIAL_PERIOD_LOCKED' using errcode='P0001'; end if;

    -- Preserve history: compensate the withdrawal with a new deposit, never edit/delete the original transaction.
    insert into public.account_transactions(
      tenant_id,account_id,transaction_type,amount,description,reference_no,
      related_supplier_payment_id,created_by_user_id,occurred_at
    ) values (
      p_tenant_id,v_account.id,'deposit',v_payment.amount,
      'عكس دفعة مورد #'||v_payment.id||' — '||v_reason,
      'REV-SUPPLIER-PAYMENT-'||v_payment.id,
      null,p_user_id,now()
    );

    insert into public.supplier_ledger_entries(
      tenant_id,site_id,supplier_id,entry_type,credit_amount,purchase_id,supplier_payment_id,
      entry_key,reference_no,description,occurred_at,created_by_user_id
    ) values (
      p_tenant_id,p_site_id,v_payment.supplier_id,'reversal',v_payment.amount,v_purchase.id,v_payment.id,
      'supplier-payment-reversal:'||v_payment.id,v_payment.reference_no,
      'عكس دفعة المورد #'||v_payment.id||' — '||v_reason,now(),p_user_id
    );

    update public.supplier_payments sp
    set status='reversed',reversed_at=now(),reversed_by_user_id=p_user_id,
        reversal_reason=v_reason,updated_at=now()
    where sp.tenant_id=p_tenant_id and sp.id=v_payment.id
    returning * into v_payment;

    insert into public.audit_logs(
      tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,
      before_data,after_data,metadata
    ) values (
      p_tenant_id,p_site_id,p_user_id,v_platform_role,'supplier_payment',v_payment.id::text,'reverse',
      jsonb_build_object('status','posted','amount',v_payment.amount,
        'companyAccountId',v_account.id,'accountTransactionId',v_payment.account_transaction_id),
      jsonb_build_object('status',v_payment.status,'reversedAt',v_payment.reversed_at,
        'reason',v_reason,'purchaseId',v_purchase.id),
      jsonb_build_object('compensatingDepositReference','REV-SUPPLIER-PAYMENT-'||v_payment.id)
    );
  end if;

  select v_account.opening_balance + coalesce(sum(
    case when atx.transaction_type in ('deposit','transfer_in','collection')
      then atx.amount else -atx.amount end
  ),0)
  into v_account_balance
  from public.account_transactions atx
  where atx.tenant_id=p_tenant_id and atx.account_id=v_account.id;

  select coalesce(sum(a.amount),0)::numeric(14,2)
  into v_paid_amount
  from public.supplier_payment_allocations a
  join public.supplier_payments sp on sp.tenant_id=a.tenant_id and sp.id=a.payment_id
  where a.tenant_id=p_tenant_id and a.purchase_id=v_purchase.id and sp.status='posted';

  v_outstanding := greatest(0,v_purchase.total_amount-v_paid_amount);
  return query select v_payment.id,v_purchase.id,v_payment.status,v_payment.amount,
    v_paid_amount,v_outstanding,v_account_balance,v_replayed;
end;
$$;

create or replace function public.powerhub_inventory_supplier_ledger_statement(
  p_tenant_id bigint,
  p_site_id bigint,
  p_supplier_id bigint,
  p_limit integer default 200
)
returns jsonb
language plpgsql
security invoker
set search_path=public,pg_temp
as $$
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
  select s.* into v_supplier from public.suppliers s where s.tenant_id=p_tenant_id and s.id=p_supplier_id;
  if not found then raise exception 'SUPPLIER_OUT_OF_SCOPE' using errcode='P0001'; end if;

  select coalesce(sum(e.credit_amount-e.debit_amount),0)::numeric(14,2)
  into v_balance from public.supplier_ledger_entries e
  where e.tenant_id=p_tenant_id and e.site_id=p_site_id and e.supplier_id=p_supplier_id;

  select coalesce(jsonb_agg(to_jsonb(page) order by page.occurred_at desc,page.id desc),'[]'::jsonb)
  into v_entries from (
    select e.id,e.entry_type,e.debit_amount,e.credit_amount,e.purchase_id,e.supplier_payment_id,
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
$$;

revoke all on function public.powerhub_inventory_cancel_purchase(bigint,bigint,bigint,bigint,text) from public,anon,authenticated;
revoke all on function public.powerhub_inventory_reverse_supplier_payment(bigint,bigint,bigint,bigint,text) from public,anon,authenticated;
revoke all on function public.powerhub_inventory_supplier_ledger_statement(bigint,bigint,bigint,integer) from public,anon,authenticated;
grant execute on function public.powerhub_inventory_cancel_purchase(bigint,bigint,bigint,bigint,text) to service_role;
grant execute on function public.powerhub_inventory_reverse_supplier_payment(bigint,bigint,bigint,bigint,text) to service_role;
grant execute on function public.powerhub_inventory_supplier_ledger_statement(bigint,bigint,bigint,integer) to service_role;
