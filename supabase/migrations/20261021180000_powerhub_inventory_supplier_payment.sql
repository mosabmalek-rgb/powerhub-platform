-- Atomic supplier payment posting against an existing PowerHub company account.
-- The account withdrawal, supplier payment/allocation, supplier ledger, and audit event
-- are a single PostgreSQL transaction. No deployed database is modified by adding this file.

alter table public.supplier_payments
  add column if not exists operation_payload_hash text;

create or replace function public.powerhub_inventory_record_supplier_payment(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_purchase_id bigint,
  p_company_account_id bigint,
  p_amount numeric,
  p_payment_date date,
  p_reference_no text,
  p_notes text,
  p_operation_key text
)
returns table(
  payment_id bigint,
  purchase_id bigint,
  company_account_id bigint,
  account_transaction_id bigint,
  amount numeric,
  payment_date date,
  paid_amount numeric,
  outstanding_amount numeric,
  account_balance numeric,
  replayed boolean
)
language plpgsql
security invoker
set search_path=public,pg_temp
as $$
declare
  v_payment public.supplier_payments%rowtype;
  v_purchase public.supplier_purchases%rowtype;
  v_account public.company_accounts%rowtype;
  v_actor_platform_role text;
  v_operation_key text;
  v_payment_date date;
  v_payload_hash text;
  v_account_balance numeric(14,2);
  v_paid_before numeric(14,2);
  v_paid_after numeric(14,2);
  v_outstanding_before numeric(14,2);
  v_outstanding_after numeric(14,2);
  v_account_transaction_id bigint;
begin
  v_operation_key := nullif(btrim(p_operation_key),'');
  v_payment_date := coalesce(p_payment_date,current_date);

  if v_operation_key is null or length(v_operation_key)>180 then
    raise exception 'INVALID_OPERATION_KEY' using errcode='P0001';
  end if;
  if p_amount is null or p_amount<=0 or p_amount<>round(p_amount,2) then
    raise exception 'INVALID_SUPPLIER_PAYMENT_AMOUNT' using errcode='P0001';
  end if;

  v_payload_hash := md5(jsonb_build_object(
    'site_id',p_site_id,
    'purchase_id',p_purchase_id,
    'company_account_id',p_company_account_id,
    'amount',p_amount,
    'payment_date',v_payment_date,
    'reference_no',nullif(btrim(p_reference_no),''),
    'notes',nullif(btrim(p_notes),'')
  )::text);

  -- Same key is serialized, and a key cannot be replayed with different payment data.
  perform pg_advisory_xact_lock(hashtextextended(
    p_tenant_id::text||':supplier-payment:'||v_operation_key,0
  ));
  select sp.* into v_payment
  from public.supplier_payments as sp
  where sp.tenant_id=p_tenant_id and sp.operation_key=v_operation_key
  for update;

  if found then
    if v_payment.operation_payload_hash is distinct from v_payload_hash then
      raise exception 'IDEMPOTENCY_KEY_REUSED' using errcode='P0001';
    end if;

    select p.* into v_purchase
    from public.supplier_purchases as p
    where p.tenant_id=p_tenant_id and p.site_id=p_site_id and p.id=v_payment.purchase_id;
    if not found then raise exception 'PURCHASE_NOT_FOUND' using errcode='P0001'; end if;

    select ca.* into v_account
    from public.company_accounts as ca
    where ca.tenant_id=p_tenant_id and ca.id=v_payment.company_account_id;
    if not found then raise exception 'COMPANY_ACCOUNT_NOT_FOUND' using errcode='P0001'; end if;

    select v_account.opening_balance + coalesce(sum(
      case when atx.transaction_type in ('deposit','transfer_in','collection')
        then atx.amount else -atx.amount end
    ),0)
    into v_account_balance
    from public.account_transactions as atx
    where atx.tenant_id=p_tenant_id and atx.account_id=v_account.id;

    select coalesce(sum(a.amount),0)::numeric(14,2)
    into v_paid_after
    from public.supplier_payment_allocations as a
    join public.supplier_payments as sp
      on sp.tenant_id=a.tenant_id and sp.id=a.payment_id
    where a.tenant_id=p_tenant_id and a.purchase_id=v_purchase.id and sp.status='posted';

    return query select v_payment.id,v_purchase.id,v_account.id,
      v_payment.account_transaction_id,v_payment.amount,v_payment.payment_date,
      v_paid_after,greatest(0,v_purchase.total_amount-v_paid_after),
      v_account_balance,true;
    return;
  end if;

  -- Use the same advisory account lock as powerhub_add_account_movement so a
  -- concurrent expense/withdrawal cannot spend the same balance twice.
  perform pg_advisory_xact_lock(p_company_account_id);
  select ca.* into v_account
  from public.company_accounts as ca
  where ca.tenant_id=p_tenant_id and ca.id=p_company_account_id
  for update;
  if not found then raise exception 'COMPANY_ACCOUNT_NOT_FOUND' using errcode='P0001'; end if;
  if not v_account.is_active then raise exception 'COMPANY_ACCOUNT_INACTIVE' using errcode='P0001'; end if;

  -- Accounts with no explicit site links are tenant-wide, matching existing PowerHub semantics.
  if exists (
    select 1 from public.company_account_sites as cas
    where cas.tenant_id=p_tenant_id and cas.account_id=v_account.id
  ) and not exists (
    select 1 from public.company_account_sites as cas
    where cas.tenant_id=p_tenant_id and cas.account_id=v_account.id and cas.site_id=p_site_id
  ) then
    raise exception 'COMPANY_ACCOUNT_OUT_OF_SCOPE' using errcode='P0001';
  end if;

  select p.* into v_purchase
  from public.supplier_purchases as p
  where p.tenant_id=p_tenant_id and p.site_id=p_site_id and p.id=p_purchase_id
  for update;
  if not found then raise exception 'PURCHASE_NOT_FOUND' using errcode='P0001'; end if;
  if v_purchase.status not in ('confirmed','partially_received','received') then
    raise exception 'PURCHASE_NOT_PAYABLE' using errcode='P0001';
  end if;

  if exists (
    select 1 from public.financial_settlements as fs
    where fs.tenant_id=p_tenant_id and fs.site_id=p_site_id and fs.status='locked'
      and (
        (fs.period_start<=now() and fs.period_end>=now())
        or (fs.period_start::date<=v_payment_date and fs.period_end::date>=v_payment_date)
      )
  ) then
    raise exception 'FINANCIAL_PERIOD_LOCKED' using errcode='P0001';
  end if;

  select coalesce(sum(a.amount),0)::numeric(14,2)
  into v_paid_before
  from public.supplier_payment_allocations as a
  join public.supplier_payments as sp
    on sp.tenant_id=a.tenant_id and sp.id=a.payment_id
  where a.tenant_id=p_tenant_id and a.purchase_id=v_purchase.id and sp.status='posted';

  v_outstanding_before := greatest(0,v_purchase.total_amount-v_paid_before);
  if p_amount>v_outstanding_before then
    raise exception 'PURCHASE_BALANCE_EXCEEDED' using errcode='P0001';
  end if;

  select coalesce(u.platform_role,'tenant_user') into v_actor_platform_role
  from public.users as u where u.id=p_user_id;
  if not found then raise exception 'ACTOR_NOT_FOUND' using errcode='P0001'; end if;

  select v_account.opening_balance + coalesce(sum(
    case when atx.transaction_type in ('deposit','transfer_in','collection')
      then atx.amount else -atx.amount end
  ),0)
  into v_account_balance
  from public.account_transactions as atx
  where atx.tenant_id=p_tenant_id and atx.account_id=v_account.id;

  if p_amount>v_account_balance then
    raise exception 'INSUFFICIENT_ACCOUNT_BALANCE' using errcode='P0001';
  end if;

  insert into public.supplier_payments(
    tenant_id,site_id,supplier_id,company_account_id,amount,payment_date,status,
    reference_no,notes,operation_key,operation_payload_hash,posted_at,posted_by_user_id
  ) values (
    p_tenant_id,p_site_id,v_purchase.supplier_id,v_account.id,p_amount,v_payment_date,'posted',
    nullif(btrim(p_reference_no),''),nullif(btrim(p_notes),''),v_operation_key,
    v_payload_hash,now(),p_user_id
  ) returning * into v_payment;

  insert into public.account_transactions(
    tenant_id,account_id,transaction_type,amount,description,reference_no,
    related_supplier_payment_id,created_by_user_id,occurred_at
  ) values (
    p_tenant_id,v_account.id,'withdrawal',p_amount,
    'دفعة مورد — فاتورة '||v_purchase.purchase_number,
    nullif(btrim(p_reference_no),''),v_payment.id,p_user_id,v_payment_date::timestamptz
  ) returning id into v_account_transaction_id;

  update public.supplier_payments as sp
  set account_transaction_id=v_account_transaction_id,updated_at=now()
  where sp.tenant_id=p_tenant_id and sp.id=v_payment.id;

  insert into public.supplier_payment_allocations(
    tenant_id,payment_id,purchase_id,amount
  ) values(p_tenant_id,v_payment.id,v_purchase.id,p_amount);

  insert into public.supplier_ledger_entries(
    tenant_id,site_id,supplier_id,entry_type,debit_amount,purchase_id,supplier_payment_id,
    entry_key,reference_no,description,occurred_at,created_by_user_id
  ) values (
    p_tenant_id,p_site_id,v_purchase.supplier_id,'payment',p_amount,v_purchase.id,v_payment.id,
    'supplier-payment:'||v_payment.id,nullif(btrim(p_reference_no),''),
    'دفعة للمورد — فاتورة '||v_purchase.purchase_number,
    v_payment_date::timestamptz,p_user_id
  );

  v_paid_after := v_paid_before+p_amount;
  v_outstanding_after := greatest(0,v_purchase.total_amount-v_paid_after);

  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,
    before_data,after_data,metadata
  ) values (
    p_tenant_id,p_site_id,p_user_id,v_actor_platform_role,'supplier_payment',
    v_payment.id::text,'post_payment',
    jsonb_build_object('accountBalance',v_account_balance,'paidAmount',v_paid_before,
      'outstandingAmount',v_outstanding_before),
    jsonb_build_object('purchaseId',v_purchase.id,'purchaseNumber',v_purchase.purchase_number,
      'companyAccountId',v_account.id,'accountTransactionId',v_account_transaction_id,
      'amount',p_amount,'paymentDate',v_payment_date,'paidAmount',v_paid_after,
      'outstandingAmount',v_outstanding_after,'accountBalance',v_account_balance-p_amount),
    jsonb_build_object('operationKey',v_operation_key,'referenceNo',nullif(btrim(p_reference_no),''))
  );

  return query select v_payment.id,v_purchase.id,v_account.id,v_account_transaction_id,
    v_payment.amount,v_payment.payment_date,v_paid_after,v_outstanding_after,
    v_account_balance-p_amount,false;
end;
$$;

revoke execute on function public.powerhub_inventory_record_supplier_payment(bigint,bigint,bigint,bigint,bigint,numeric,date,text,text,text) from public,anon,authenticated;
grant execute on function public.powerhub_inventory_record_supplier_payment(bigint,bigint,bigint,bigint,bigint,numeric,date,text,text,text) to service_role;
