-- Phase A: supplier opening payable balances, payment allocations across multiple invoices,
-- safe whole-payment reversal, and a date-aware supplier payable-aging report.
-- All financial side effects are atomic. Direct execution is restricted to service_role;
-- the trusted tRPC layer must enforce the user's fine-grained capability and site scope.

alter table public.supplier_payment_allocations
  alter column purchase_id drop not null;

alter table public.supplier_payment_allocations
  add column if not exists supplier_ledger_entry_id bigint;

alter table public.supplier_payment_allocations
  drop constraint if exists supplier_payment_allocations_opening_balance_fk;
alter table public.supplier_payment_allocations
  add constraint supplier_payment_allocations_opening_balance_fk
  foreign key (tenant_id,supplier_ledger_entry_id)
  references public.supplier_ledger_entries(tenant_id,id) on delete restrict;

alter table public.supplier_payment_allocations
  drop constraint if exists supplier_payment_allocations_document_target_ck;
alter table public.supplier_payment_allocations
  add constraint supplier_payment_allocations_document_target_ck
  check ((purchase_id is not null and supplier_ledger_entry_id is null)
      or (purchase_id is null and supplier_ledger_entry_id is not null));

create unique index if not exists supplier_payment_allocations_opening_balance_unique_idx
  on public.supplier_payment_allocations(tenant_id,payment_id,supplier_ledger_entry_id)
  where supplier_ledger_entry_id is not null;

create unique index if not exists supplier_ledger_opening_balance_unique_idx
  on public.supplier_ledger_entries(tenant_id,site_id,supplier_id)
  where entry_type='opening_balance' and purchase_id is null and supplier_payment_id is null;

create index if not exists supplier_payment_allocations_opening_balance_idx
  on public.supplier_payment_allocations(tenant_id,supplier_ledger_entry_id,payment_id)
  where supplier_ledger_entry_id is not null;

create or replace function public.powerhub_inventory_record_supplier_opening_balance(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_supplier_id bigint,
  p_amount numeric,
  p_as_of_date date,
  p_reference_no text,
  p_notes text
)
returns table(ledger_entry_id bigint,supplier_id bigint,amount numeric,as_of_date date,replayed boolean)
language plpgsql
security invoker
set search_path=public,pg_temp
as $$
declare
  v_existing public.supplier_ledger_entries%rowtype;
  v_supplier public.suppliers%rowtype;
  v_entry public.supplier_ledger_entries%rowtype;
  v_actor_platform_role text;
  v_date date:=coalesce(p_as_of_date,current_date);
  v_reference text:=nullif(btrim(p_reference_no),'');
  v_notes text:=nullif(btrim(p_notes),'');
  v_entry_key text;
begin
  if p_tenant_id is null or p_site_id is null or p_user_id is null or p_supplier_id is null then
    raise exception 'SUPPLIER_OPENING_BALANCE_SCOPE_REQUIRED' using errcode='P0001';
  end if;
  if p_amount is null or p_amount<=0 or p_amount>1000000000 or p_amount<>round(p_amount,2) then
    raise exception 'INVALID_SUPPLIER_OPENING_BALANCE' using errcode='P0001';
  end if;
  if not exists(select 1 from public.sites s where s.tenant_id=p_tenant_id and s.id=p_site_id) then
    raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001';
  end if;

  v_entry_key:='supplier-opening-balance:'||p_site_id::text||':'||p_supplier_id::text;
  perform pg_advisory_xact_lock(hashtextextended(
    p_tenant_id::text||':supplier-opening-balance:'||p_site_id::text||':'||p_supplier_id::text,0
  ));

  select s.* into v_supplier from public.suppliers s
  where s.tenant_id=p_tenant_id and s.id=p_supplier_id for update;
  if not found then raise exception 'SUPPLIER_OUT_OF_SCOPE' using errcode='P0001'; end if;
  if not v_supplier.is_active then raise exception 'SUPPLIER_INACTIVE' using errcode='P0001'; end if;

  select e.* into v_existing from public.supplier_ledger_entries e
  where e.tenant_id=p_tenant_id and e.site_id=p_site_id and e.supplier_id=p_supplier_id
    and e.entry_type='opening_balance' and e.purchase_id is null and e.supplier_payment_id is null
  order by e.id limit 1 for update;
  if found then
    if v_existing.entry_key=v_entry_key
      and v_existing.credit_amount=p_amount and v_existing.debit_amount=0
      and v_existing.occurred_at::date=v_date
      and coalesce(v_existing.reference_no,'')=coalesce(v_reference,'')
      and coalesce(v_existing.description,'')=(
        'رصيد افتتاحي مستحق للمورد: '||v_supplier.name||
        case when v_notes is not null then ' — '||v_notes else '' end
      ) then
      return query select v_existing.id,v_supplier.id,p_amount,v_date,true;
      return;
    end if;
    raise exception 'SUPPLIER_OPENING_BALANCE_ALREADY_EXISTS' using errcode='P0001';
  end if;

  if exists(
    select 1 from public.financial_settlements fs
    where fs.tenant_id=p_tenant_id and fs.site_id=p_site_id and fs.status='locked'
      and ((fs.period_start<=now() and fs.period_end>=now())
        or (fs.period_start::date<=v_date and fs.period_end::date>=v_date))
  ) then
    raise exception 'FINANCIAL_PERIOD_LOCKED' using errcode='P0001';
  end if;

  select coalesce(u.platform_role,'tenant_user') into v_actor_platform_role
  from public.users u where u.id=p_user_id;
  if not found then raise exception 'ACTOR_NOT_FOUND' using errcode='P0001'; end if;

  insert into public.supplier_ledger_entries(
    tenant_id,site_id,supplier_id,entry_type,debit_amount,credit_amount,purchase_id,supplier_payment_id,
    entry_key,reference_no,description,occurred_at,created_by_user_id
  ) values (
    p_tenant_id,p_site_id,p_supplier_id,'opening_balance',0,p_amount,null,null,
    v_entry_key,v_reference,
    'رصيد افتتاحي مستحق للمورد: '||v_supplier.name||case when v_notes is not null then ' — '||v_notes else '' end,
    v_date::timestamp at time zone 'UTC',p_user_id
  ) returning * into v_entry;

  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,
    before_data,after_data,metadata
  ) values (
    p_tenant_id,p_site_id,p_user_id,v_actor_platform_role,'supplier_opening_balance',v_entry.id::text,'create',
    null,jsonb_build_object('supplierId',p_supplier_id,'amount',p_amount,'asOfDate',v_date,
      'referenceNo',v_reference,'notes',v_notes),
    jsonb_build_object('entryKey',v_entry_key,'direction','payable')
  );

  return query select v_entry.id,v_supplier.id,p_amount,v_date,false;
end;
$$;

create or replace function public.powerhub_inventory_record_supplier_payment_batch(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_supplier_id bigint,
  p_company_account_id bigint,
  p_amount numeric,
  p_payment_date date,
  p_reference_no text,
  p_notes text,
  p_operation_key text,
  p_allocations jsonb
)
returns table(
  payment_id bigint,
  supplier_id bigint,
  company_account_id bigint,
  account_transaction_id bigint,
  amount numeric,
  payment_date date,
  allocation_count integer,
  allocation_summary jsonb,
  account_balance numeric,
  replayed boolean
)
language plpgsql
security invoker
set search_path=public,pg_temp
as $$
declare
  v_payment public.supplier_payments%rowtype;
  v_supplier public.suppliers%rowtype;
  v_purchase public.supplier_purchases%rowtype;
  v_opening public.supplier_ledger_entries%rowtype;
  v_account public.company_accounts%rowtype;
  v_actor_platform_role text;
  v_operation_key text:=nullif(btrim(p_operation_key),'');
  v_date date:=coalesce(p_payment_date,current_date);
  v_reference text:=nullif(btrim(p_reference_no),'');
  v_notes text:=nullif(btrim(p_notes),'');
  v_payload_hash text;
  v_canonical_allocations jsonb;
  v_summary jsonb;
  v_allocation record;
  v_invoice_ids bigint[]:='{}'::bigint[];
  v_account_balance numeric(14,2):=0;
  v_paid_before numeric(14,2);
  v_return_credit numeric(14,2);
  v_outstanding numeric(14,2);
  v_allocation_total numeric(14,2):=0;
  v_allocation_count integer:=0;
  v_distinct_count integer:=0;
  v_account_transaction_id bigint;
  v_invoice_summary text;
begin
  if p_tenant_id is null or p_site_id is null or p_user_id is null or p_supplier_id is null or p_company_account_id is null then
    raise exception 'SUPPLIER_PAYMENT_SCOPE_REQUIRED' using errcode='P0001';
  end if;
  if v_operation_key is null or length(v_operation_key)>180 then
    raise exception 'INVALID_OPERATION_KEY' using errcode='P0001';
  end if;
  if p_amount is null or p_amount<=0 or p_amount>1000000000 or p_amount<>round(p_amount,2) then
    raise exception 'INVALID_SUPPLIER_PAYMENT_AMOUNT' using errcode='P0001';
  end if;
  if p_allocations is null or jsonb_typeof(p_allocations)<>'array'
    or jsonb_array_length(p_allocations)<1 or jsonb_array_length(p_allocations)>100 then
    raise exception 'INVALID_SUPPLIER_PAYMENT_ALLOCATIONS' using errcode='P0001';
  end if;
  if exists(
    select 1 from jsonb_to_recordset(p_allocations) as a(purchase_id bigint,supplier_ledger_entry_id bigint,amount numeric)
    where (a.purchase_id is null)=(a.supplier_ledger_entry_id is null)
      or a.amount is null or a.amount<=0 or a.amount>1000000000 or a.amount<>round(a.amount,2)
      or coalesce(a.purchase_id,0)<0 or coalesce(a.supplier_ledger_entry_id,0)<0
  ) then
    raise exception 'INVALID_SUPPLIER_PAYMENT_ALLOCATIONS' using errcode='P0001';
  end if;

  select count(*)::integer,
    count(distinct case when a.purchase_id is not null then 'p:'||a.purchase_id::text else 'l:'||a.supplier_ledger_entry_id::text end)::integer,
    coalesce(sum(a.amount),0)::numeric(14,2),
    jsonb_agg(jsonb_build_object('purchase_id',a.purchase_id,'supplier_ledger_entry_id',a.supplier_ledger_entry_id,'amount',a.amount)
      order by coalesce(a.purchase_id,0),coalesce(a.supplier_ledger_entry_id,0))
  into v_allocation_count,v_distinct_count,v_allocation_total,v_canonical_allocations
  from jsonb_to_recordset(p_allocations) as a(purchase_id bigint,supplier_ledger_entry_id bigint,amount numeric);
  if v_allocation_count<1 or v_allocation_count<>v_distinct_count then
    raise exception 'DUPLICATE_OR_INVALID_SUPPLIER_PAYMENT_ALLOCATION' using errcode='P0001';
  end if;
  if v_allocation_total<>p_amount then
    raise exception 'SUPPLIER_PAYMENT_ALLOCATION_TOTAL_MISMATCH' using errcode='P0001';
  end if;

  v_payload_hash:=md5(jsonb_build_object(
    'site_id',p_site_id,'supplier_id',p_supplier_id,'company_account_id',p_company_account_id,
    'amount',p_amount,'payment_date',v_date,'reference_no',v_reference,'notes',v_notes,
    'allocations',v_canonical_allocations
  )::text);

  perform pg_advisory_xact_lock(hashtextextended(
    p_tenant_id::text||':supplier-payment:'||v_operation_key,0
  ));

  select sp.* into v_payment from public.supplier_payments sp
  where sp.tenant_id=p_tenant_id and sp.operation_key=v_operation_key for update;
  if found then
    if v_payment.operation_payload_hash is distinct from v_payload_hash then
      raise exception 'IDEMPOTENCY_KEY_REUSED' using errcode='P0001';
    end if;
    select ca.* into v_account from public.company_accounts ca
    where ca.tenant_id=p_tenant_id and ca.id=v_payment.company_account_id;
    if not found then raise exception 'COMPANY_ACCOUNT_NOT_FOUND' using errcode='P0001'; end if;
    select v_account.opening_balance+coalesce(sum(
      case when atx.transaction_type in ('deposit','transfer_in','collection') then atx.amount else -atx.amount end
    ),0)::numeric(14,2) into v_account_balance
    from public.account_transactions atx where atx.tenant_id=p_tenant_id and atx.account_id=v_account.id;
    select coalesce(jsonb_agg(jsonb_build_object(
      'purchase_id',a.purchase_id,'supplier_ledger_entry_id',a.supplier_ledger_entry_id,
      'document_reference',coalesce(p.purchase_number,e.reference_no,'رصيد افتتاحي'),'amount',a.amount
    ) order by coalesce(a.purchase_id,0),coalesce(a.supplier_ledger_entry_id,0)),'[]'::jsonb)
    into v_summary
    from public.supplier_payment_allocations a
    left join public.supplier_purchases p on p.tenant_id=a.tenant_id and p.id=a.purchase_id
    left join public.supplier_ledger_entries e on e.tenant_id=a.tenant_id and e.id=a.supplier_ledger_entry_id
    where a.tenant_id=p_tenant_id and a.payment_id=v_payment.id;
    return query select v_payment.id,v_payment.supplier_id,v_payment.company_account_id,
      v_payment.account_transaction_id,v_payment.amount,v_payment.payment_date,
      v_allocation_count,v_summary,v_account_balance,true;
    return;
  end if;

  if not exists(select 1 from public.sites s where s.tenant_id=p_tenant_id and s.id=p_site_id) then
    raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001';
  end if;
  select s.* into v_supplier from public.suppliers s
  where s.tenant_id=p_tenant_id and s.id=p_supplier_id for update;
  if not found then raise exception 'SUPPLIER_OUT_OF_SCOPE' using errcode='P0001'; end if;
  if not v_supplier.is_active then raise exception 'SUPPLIER_INACTIVE' using errcode='P0001'; end if;

  -- Keep the canonical account -> documents lock order to serialize against other payments
  -- and stock-return workflows that share company-account balances.
  perform pg_advisory_xact_lock(p_company_account_id);
  select ca.* into v_account from public.company_accounts ca
  where ca.tenant_id=p_tenant_id and ca.id=p_company_account_id for update;
  if not found then raise exception 'COMPANY_ACCOUNT_NOT_FOUND' using errcode='P0001'; end if;
  if not v_account.is_active then raise exception 'COMPANY_ACCOUNT_INACTIVE' using errcode='P0001'; end if;
  if exists(select 1 from public.company_account_sites cas where cas.tenant_id=p_tenant_id and cas.account_id=v_account.id)
    and not exists(select 1 from public.company_account_sites cas where cas.tenant_id=p_tenant_id and cas.account_id=v_account.id and cas.site_id=p_site_id) then
    raise exception 'COMPANY_ACCOUNT_OUT_OF_SCOPE' using errcode='P0001';
  end if;
  if exists(
    select 1 from public.financial_settlements fs
    where fs.tenant_id=p_tenant_id and fs.site_id=p_site_id and fs.status='locked'
      and ((fs.period_start<=now() and fs.period_end>=now())
        or (fs.period_start::date<=v_date and fs.period_end::date>=v_date))
  ) then
    raise exception 'FINANCIAL_PERIOD_LOCKED' using errcode='P0001';
  end if;

  -- Lock invoice rows in deterministic order; the account lock above prevents concurrent
  -- withdrawals from spending the same balance while this operation validates all allocations.
  for v_allocation in
    select * from jsonb_to_recordset(v_canonical_allocations)
      as a(purchase_id bigint,supplier_ledger_entry_id bigint,amount numeric)
    where a.purchase_id is not null order by a.purchase_id
  loop
    select p.* into v_purchase from public.supplier_purchases p
    where p.tenant_id=p_tenant_id and p.site_id=p_site_id and p.id=v_allocation.purchase_id
    for update;
    if not found then raise exception 'PURCHASE_NOT_FOUND' using errcode='P0001'; end if;
    if v_purchase.supplier_id<>p_supplier_id then raise exception 'SUPPLIER_PAYMENT_SUPPLIER_MISMATCH' using errcode='P0001'; end if;
    if v_purchase.status not in ('confirmed','partially_received','received') then
      raise exception 'PURCHASE_NOT_PAYABLE' using errcode='P0001';
    end if;
    select coalesce(sum(a.amount),0)::numeric(14,2) into v_paid_before
    from public.supplier_payment_allocations a
    join public.supplier_payments sp on sp.tenant_id=a.tenant_id and sp.id=a.payment_id and sp.status='posted'
    where a.tenant_id=p_tenant_id and a.purchase_id=v_purchase.id;
    v_return_credit:=public.powerhub_inventory_purchase_supplier_return_credit(p_tenant_id,v_purchase.id);
    v_outstanding:=greatest(0,v_purchase.total_amount-v_paid_before-v_return_credit);
    if v_allocation.amount>v_outstanding then raise exception 'PURCHASE_BALANCE_EXCEEDED' using errcode='P0001'; end if;
    v_invoice_ids:=array_append(v_invoice_ids,v_purchase.id);
  end loop;

  for v_allocation in
    select * from jsonb_to_recordset(v_canonical_allocations)
      as a(purchase_id bigint,supplier_ledger_entry_id bigint,amount numeric)
    where a.supplier_ledger_entry_id is not null order by a.supplier_ledger_entry_id
  loop
    select e.* into v_opening from public.supplier_ledger_entries e
    where e.tenant_id=p_tenant_id and e.site_id=p_site_id and e.supplier_id=p_supplier_id
      and e.id=v_allocation.supplier_ledger_entry_id and e.entry_type='opening_balance'
      and e.purchase_id is null and e.supplier_payment_id is null and e.credit_amount>0
    for update;
    if not found then raise exception 'SUPPLIER_OPENING_BALANCE_NOT_PAYABLE' using errcode='P0001'; end if;
    select coalesce(sum(a.amount),0)::numeric(14,2) into v_paid_before
    from public.supplier_payment_allocations a
    join public.supplier_payments sp on sp.tenant_id=a.tenant_id and sp.id=a.payment_id and sp.status='posted'
    where a.tenant_id=p_tenant_id and a.supplier_ledger_entry_id=v_opening.id;
    v_outstanding:=greatest(0,v_opening.credit_amount-v_paid_before);
    if v_allocation.amount>v_outstanding then raise exception 'SUPPLIER_OPENING_BALANCE_EXCEEDED' using errcode='P0001'; end if;
  end loop;

  select coalesce(u.platform_role,'tenant_user') into v_actor_platform_role
  from public.users u where u.id=p_user_id;
  if not found then raise exception 'ACTOR_NOT_FOUND' using errcode='P0001'; end if;

  select v_account.opening_balance+coalesce(sum(
    case when atx.transaction_type in ('deposit','transfer_in','collection') then atx.amount else -atx.amount end
  ),0)::numeric(14,2) into v_account_balance
  from public.account_transactions atx where atx.tenant_id=p_tenant_id and atx.account_id=v_account.id;
  if p_amount>v_account_balance then raise exception 'INSUFFICIENT_ACCOUNT_BALANCE' using errcode='P0001'; end if;

  select string_agg(p.purchase_number,', ' order by p.purchase_number) into v_invoice_summary
  from public.supplier_purchases p where p.tenant_id=p_tenant_id and p.id=any(v_invoice_ids);

  insert into public.supplier_payments(
    tenant_id,site_id,supplier_id,company_account_id,amount,payment_date,status,
    reference_no,notes,operation_key,operation_payload_hash,posted_at,posted_by_user_id
  ) values (
    p_tenant_id,p_site_id,p_supplier_id,p_company_account_id,p_amount,v_date,'posted',
    v_reference,v_notes,v_operation_key,v_payload_hash,now(),p_user_id
  ) returning * into v_payment;

  insert into public.account_transactions(
    tenant_id,account_id,transaction_type,amount,description,reference_no,
    related_supplier_payment_id,created_by_user_id,occurred_at
  ) values (
    p_tenant_id,v_account.id,'withdrawal',p_amount,
    'دفعة للمورد '||v_supplier.name||
      case when v_invoice_summary is not null then ' — فواتير: '||v_invoice_summary else ' — تسوية رصيد افتتاحي' end,
    v_reference,v_payment.id,p_user_id,v_date::timestamptz
  ) returning id into v_account_transaction_id;

  update public.supplier_payments sp set account_transaction_id=v_account_transaction_id,updated_at=now()
  where sp.tenant_id=p_tenant_id and sp.id=v_payment.id;

  for v_allocation in
    select * from jsonb_to_recordset(v_canonical_allocations)
      as a(purchase_id bigint,supplier_ledger_entry_id bigint,amount numeric)
    order by coalesce(a.purchase_id,0),coalesce(a.supplier_ledger_entry_id,0)
  loop
    insert into public.supplier_payment_allocations(
      tenant_id,payment_id,purchase_id,supplier_ledger_entry_id,amount
    ) values (p_tenant_id,v_payment.id,v_allocation.purchase_id,v_allocation.supplier_ledger_entry_id,v_allocation.amount);
  end loop;

  -- One supplier-level posting per payment keeps the existing uniqueness and statement model.
  -- Per-document allocation detail is carried by supplier_payment_allocations.
  insert into public.supplier_ledger_entries(
    tenant_id,site_id,supplier_id,entry_type,debit_amount,purchase_id,supplier_payment_id,
    entry_key,reference_no,description,occurred_at,created_by_user_id
  ) values (
    p_tenant_id,p_site_id,p_supplier_id,'payment',p_amount,null,v_payment.id,
    'supplier-payment:'||v_payment.id,v_reference,
    'دفعة للمورد '||v_supplier.name||case when v_invoice_summary is not null then ' — فواتير: '||v_invoice_summary else ' — تسوية رصيد افتتاحي' end,
    v_date::timestamptz,p_user_id
  );

  select coalesce(jsonb_agg(jsonb_build_object(
    'purchase_id',a.purchase_id,'supplier_ledger_entry_id',a.supplier_ledger_entry_id,
    'document_reference',coalesce(p.purchase_number,e.reference_no,'رصيد افتتاحي'),'amount',a.amount
  ) order by coalesce(a.purchase_id,0),coalesce(a.supplier_ledger_entry_id,0)),'[]'::jsonb)
  into v_summary
  from public.supplier_payment_allocations a
  left join public.supplier_purchases p on p.tenant_id=a.tenant_id and p.id=a.purchase_id
  left join public.supplier_ledger_entries e on e.tenant_id=a.tenant_id and e.id=a.supplier_ledger_entry_id
  where a.tenant_id=p_tenant_id and a.payment_id=v_payment.id;

  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,before_data,after_data,metadata
  ) values (
    p_tenant_id,p_site_id,p_user_id,v_actor_platform_role,'supplier_payment',v_payment.id::text,'post_batch_payment',
    jsonb_build_object('accountBalance',v_account_balance),
    jsonb_build_object('supplierId',p_supplier_id,'amount',p_amount,'paymentDate',v_date,
      'companyAccountId',v_account.id,'accountTransactionId',v_account_transaction_id,
      'allocations',v_summary,'accountBalanceAfter',v_account_balance-p_amount),
    jsonb_build_object('operationKey',v_operation_key,'payloadHash',v_payload_hash,'referenceNo',v_reference)
  );

  return query select v_payment.id,p_supplier_id,v_account.id,v_account_transaction_id,p_amount,v_date,
    v_allocation_count,v_summary,v_account_balance-p_amount,false;
end;
$$;

create or replace function public.powerhub_inventory_reverse_supplier_payment_flexible(
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
  v_account public.company_accounts%rowtype;
  v_purchase public.supplier_purchases%rowtype;
  v_opening public.supplier_ledger_entries%rowtype;
  v_allocations_json jsonb;
  v_platform_role text;
  v_reason text:=nullif(btrim(p_reason),'');
  v_allocation record;
  v_allocation_count integer:=0;
  v_allocation_sum numeric(14,2):=0;
  v_single_purchase_id bigint;
  v_single_opening_id bigint;
  v_account_balance numeric(14,2):=0;
  v_paid_amount numeric(14,2):=0;
  v_outstanding numeric(14,2):=0;
  v_period_locked boolean:=false;
  v_replayed boolean:=false;
begin
  if p_tenant_id is null or p_site_id is null or p_user_id is null or p_payment_id is null then
    raise exception 'SUPPLIER_PAYMENT_SCOPE_REQUIRED' using errcode='P0001';
  end if;
  if v_reason is null or length(v_reason) not between 3 and 500 then
    raise exception 'SUPPLIER_PAYMENT_REVERSAL_REASON_REQUIRED' using errcode='P0001';
  end if;

  select sp.* into v_payment from public.supplier_payments sp
  where sp.tenant_id=p_tenant_id and sp.site_id=p_site_id and sp.id=p_payment_id
  for update;
  if not found then raise exception 'SUPPLIER_PAYMENT_NOT_FOUND' using errcode='P0001'; end if;

  select count(*)::integer,coalesce(sum(a.amount),0)::numeric(14,2),
    case when count(*)=1 then min(a.purchase_id) else null end,
    case when count(*)=1 then min(a.supplier_ledger_entry_id) else null end
  into v_allocation_count,v_allocation_sum,v_single_purchase_id,v_single_opening_id
  from public.supplier_payment_allocations a
  where a.tenant_id=p_tenant_id and a.payment_id=v_payment.id;
  if v_allocation_count<1 or v_allocation_sum<>v_payment.amount then
    raise exception 'SUPPLIER_PAYMENT_ALLOCATION_MISMATCH' using errcode='P0001';
  end if;

  perform pg_advisory_xact_lock(v_payment.company_account_id);
  select ca.* into v_account from public.company_accounts ca
  where ca.tenant_id=p_tenant_id and ca.id=v_payment.company_account_id
  for update;
  if not found then raise exception 'COMPANY_ACCOUNT_NOT_FOUND' using errcode='P0001'; end if;

  if v_payment.account_transaction_id is null or not exists(
    select 1 from public.account_transactions atx
    where atx.tenant_id=p_tenant_id and atx.id=v_payment.account_transaction_id
      and atx.account_id=v_payment.company_account_id and atx.transaction_type='withdrawal'
      and atx.amount=v_payment.amount and atx.related_supplier_payment_id=v_payment.id
  ) then
    raise exception 'SUPPLIER_PAYMENT_ORIGINAL_TRANSACTION_MISMATCH' using errcode='P0001';
  end if;

  -- Acquire all document locks in ascending order after the account lock.
  for v_allocation in
    select * from public.supplier_payment_allocations a
    where a.tenant_id=p_tenant_id and a.payment_id=v_payment.id and a.purchase_id is not null
    order by a.purchase_id
  loop
    select p.* into v_purchase from public.supplier_purchases p
    where p.tenant_id=p_tenant_id and p.site_id=p_site_id and p.id=v_allocation.purchase_id
    for update;
    if not found or v_purchase.supplier_id<>v_payment.supplier_id then
      raise exception 'SUPPLIER_PAYMENT_ALLOCATION_MISMATCH' using errcode='P0001';
    end if;
  end loop;
  for v_allocation in
    select * from public.supplier_payment_allocations a
    where a.tenant_id=p_tenant_id and a.payment_id=v_payment.id and a.supplier_ledger_entry_id is not null
    order by a.supplier_ledger_entry_id
  loop
    select e.* into v_opening from public.supplier_ledger_entries e
    where e.tenant_id=p_tenant_id and e.site_id=p_site_id and e.supplier_id=v_payment.supplier_id
      and e.id=v_allocation.supplier_ledger_entry_id and e.entry_type='opening_balance'
    for update;
    if not found then raise exception 'SUPPLIER_PAYMENT_ALLOCATION_MISMATCH' using errcode='P0001'; end if;
  end loop;

  select v_account.opening_balance+coalesce(sum(
    case when atx.transaction_type in ('deposit','transfer_in','collection') then atx.amount else -atx.amount end
  ),0)::numeric(14,2) into v_account_balance
  from public.account_transactions atx where atx.tenant_id=p_tenant_id and atx.account_id=v_account.id;

  if v_payment.status='reversed' then
    v_replayed:=true;
  else
    select exists(
      select 1 from public.financial_settlements fs
      where fs.tenant_id=p_tenant_id and fs.site_id=p_site_id and fs.status='locked'
        and ((fs.period_start<=now() and fs.period_end>=now())
          or (fs.period_start::date<=v_payment.payment_date and fs.period_end::date>=v_payment.payment_date))
    ) into v_period_locked;
    if v_period_locked then raise exception 'FINANCIAL_PERIOD_LOCKED' using errcode='P0001'; end if;

    insert into public.account_transactions(
      tenant_id,account_id,transaction_type,amount,description,reference_no,
      related_supplier_payment_id,created_by_user_id,occurred_at
    ) values (
      p_tenant_id,v_account.id,'deposit',v_payment.amount,
      'عكس دفعة مورد #'||v_payment.id||' — '||v_reason,
      'REV-SUPPLIER-PAYMENT-'||v_payment.id,null,p_user_id,now()
    );

    insert into public.supplier_ledger_entries(
      tenant_id,site_id,supplier_id,entry_type,credit_amount,purchase_id,supplier_payment_id,
      entry_key,reference_no,description,occurred_at,created_by_user_id
    ) values (
      p_tenant_id,p_site_id,v_payment.supplier_id,'reversal',v_payment.amount,
      v_single_purchase_id,v_payment.id,'supplier-payment-reversal:'||v_payment.id,
      v_payment.reference_no,'عكس دفعة المورد #'||v_payment.id||' — '||v_reason,now(),p_user_id
    );

    update public.supplier_payments sp set status='reversed',reversed_at=now(),
      reversed_by_user_id=p_user_id,reversal_reason=v_reason,updated_at=now()
    where sp.tenant_id=p_tenant_id and sp.id=v_payment.id returning * into v_payment;

    select coalesce(jsonb_agg(jsonb_build_object(
      'purchaseId',a.purchase_id,'openingBalanceEntryId',a.supplier_ledger_entry_id,'amount',a.amount
    ) order by coalesce(a.purchase_id,0),coalesce(a.supplier_ledger_entry_id,0)),'[]'::jsonb)
    into v_allocations_json
    from public.supplier_payment_allocations a
    where a.tenant_id=p_tenant_id and a.payment_id=v_payment.id;

    select coalesce(u.platform_role,'tenant_user') into v_platform_role from public.users u where u.id=p_user_id;
    insert into public.audit_logs(
      tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,before_data,after_data,metadata
    ) values (
      p_tenant_id,p_site_id,p_user_id,v_platform_role,'supplier_payment',v_payment.id::text,'reverse',
      jsonb_build_object('status','posted','amount',v_payment.amount,'companyAccountId',v_account.id,
        'accountTransactionId',v_payment.account_transaction_id),
      jsonb_build_object('status','reversed','reversedAt',v_payment.reversed_at,'reason',v_reason),
      jsonb_build_object('allocations',v_allocations_json,'compensatingDepositReference','REV-SUPPLIER-PAYMENT-'||v_payment.id)
    );
  end if;

  select v_account.opening_balance+coalesce(sum(
    case when atx.transaction_type in ('deposit','transfer_in','collection') then atx.amount else -atx.amount end
  ),0)::numeric(14,2) into v_account_balance
  from public.account_transactions atx where atx.tenant_id=p_tenant_id and atx.account_id=v_account.id;

  if v_allocation_count=1 and v_single_purchase_id is not null then
    select p.* into v_purchase from public.supplier_purchases p
    where p.tenant_id=p_tenant_id and p.site_id=p_site_id and p.id=v_single_purchase_id;
    select coalesce(sum(a.amount),0)::numeric(14,2) into v_paid_amount
    from public.supplier_payment_allocations a
    join public.supplier_payments sp on sp.tenant_id=a.tenant_id and sp.id=a.payment_id and sp.status='posted'
    where a.tenant_id=p_tenant_id and a.purchase_id=v_single_purchase_id;
    v_outstanding:=greatest(0,v_purchase.total_amount-public.powerhub_inventory_purchase_supplier_return_credit(p_tenant_id,v_single_purchase_id)-v_paid_amount);
  elsif v_allocation_count=1 and v_single_opening_id is not null then
    select e.* into v_opening from public.supplier_ledger_entries e where e.tenant_id=p_tenant_id and e.id=v_single_opening_id;
    select coalesce(sum(a.amount),0)::numeric(14,2) into v_paid_amount
    from public.supplier_payment_allocations a
    join public.supplier_payments sp on sp.tenant_id=a.tenant_id and sp.id=a.payment_id and sp.status='posted'
    where a.tenant_id=p_tenant_id and a.supplier_ledger_entry_id=v_single_opening_id;
    v_outstanding:=greatest(0,v_opening.credit_amount-v_paid_amount);
  else
    v_single_purchase_id:=null;
    v_paid_amount:=null;
    v_outstanding:=null;
  end if;

  return query select v_payment.id,v_single_purchase_id,v_payment.status,v_payment.amount,
    v_paid_amount,v_outstanding,v_account_balance,v_replayed;
end;
$$;

revoke all on function public.powerhub_inventory_record_supplier_opening_balance(bigint,bigint,bigint,bigint,numeric,date,text,text)
  from public,anon,authenticated;
revoke all on function public.powerhub_inventory_record_supplier_payment_batch(bigint,bigint,bigint,bigint,bigint,numeric,date,text,text,text,jsonb)
  from public,anon,authenticated;
revoke all on function public.powerhub_inventory_reverse_supplier_payment_flexible(bigint,bigint,bigint,bigint,text)
  from public,anon,authenticated;
grant execute on function public.powerhub_inventory_record_supplier_opening_balance(bigint,bigint,bigint,bigint,numeric,date,text,text)
  to service_role;
grant execute on function public.powerhub_inventory_record_supplier_payment_batch(bigint,bigint,bigint,bigint,bigint,numeric,date,text,text,text,jsonb)
  to service_role;
grant execute on function public.powerhub_inventory_reverse_supplier_payment_flexible(bigint,bigint,bigint,bigint,text)
  to service_role;

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
