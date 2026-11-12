-- B4.14.1: replaying an already-reversed supplier payment cannot claim success when the originally posted GL has no supported correction. Guard both original and flexible paths, regardless of payment status.
CREATE OR REPLACE FUNCTION public.powerhub_inventory_reverse_supplier_payment_flexible(p_tenant_id bigint, p_site_id bigint, p_user_id bigint, p_payment_id bigint, p_reason text)
 RETURNS TABLE(payment_id bigint, purchase_id bigint, status text, amount numeric, paid_amount numeric, outstanding_amount numeric, account_balance numeric, replayed boolean)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
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

  -- B4.14: no operational-only reversal when the supplier payment has posted GL.
  IF EXISTS (
    SELECT 1 FROM public.supplier_ledger_entries sl
    JOIN public.financial_gl_entries gl
      ON gl.tenant_id=sl.tenant_id AND gl.site_id=sl.site_id
      AND gl.source_type='supplier_ledger' AND gl.source_id=sl.id::text
      AND gl.source_revision=1
    WHERE sl.tenant_id=p_tenant_id AND sl.site_id=p_site_id
      AND sl.supplier_payment_id=v_payment.id AND sl.entry_type='payment'
  ) THEN
    RAISE EXCEPTION 'SUPPLIER_PAYMENT_POSTED_GL_SOURCE_REVERSAL_REQUIRED' USING ERRCODE='22023';
  END IF;

  if v_payment.status='reversed' then
    v_replayed:=true;
  else

    select exists(
      select 1 from public.financial_settlements fs
      where fs.tenant_id=p_tenant_id and fs.site_id=p_site_id and fs.status='locked'
        and fs.period_start::date<=v_payment.payment_date
          and fs.period_end::date>=v_payment.payment_date
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

    select u.platform_role into v_platform_role from public.users u where u.id=p_user_id;
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
$function$;

CREATE OR REPLACE FUNCTION public.powerhub_inventory_reverse_supplier_payment(p_tenant_id bigint, p_site_id bigint, p_user_id bigint, p_payment_id bigint, p_reason text)
 RETURNS TABLE(payment_id bigint, purchase_id bigint, status text, amount numeric, paid_amount numeric, outstanding_amount numeric, account_balance numeric, replayed boolean)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  v_return_credit numeric(14,2);
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

  if v_payment.supplier_id<>v_purchase.supplier_id
    or (select count(*) from public.supplier_payment_allocations a
        where a.tenant_id=p_tenant_id and a.payment_id=v_payment.id)<>1
    or v_allocation.amount<>v_payment.amount then
    raise exception 'SUPPLIER_PAYMENT_ALLOCATION_MISMATCH' using errcode='P0001';
  end if;

  if v_payment.account_transaction_id is null or not exists (
    select 1 from public.account_transactions atx
    where atx.tenant_id=p_tenant_id and atx.id=v_payment.account_transaction_id
      and atx.account_id=v_payment.company_account_id and atx.transaction_type='withdrawal'
      and atx.amount=v_payment.amount and atx.related_supplier_payment_id=v_payment.id
  ) then
    raise exception 'SUPPLIER_PAYMENT_ORIGINAL_TRANSACTION_MISMATCH' using errcode='P0001';
  end if;

  select u.platform_role into v_platform_role from public.users u where u.id=p_user_id;
  if not found then raise exception 'ACTOR_NOT_FOUND' using errcode='P0001'; end if;

  -- B4.14: no operational-only reversal when the supplier payment has posted GL.
  IF EXISTS (
    SELECT 1 FROM public.supplier_ledger_entries sl
    JOIN public.financial_gl_entries gl
      ON gl.tenant_id=sl.tenant_id AND gl.site_id=sl.site_id
      AND gl.source_type='supplier_ledger' AND gl.source_id=sl.id::text
      AND gl.source_revision=1
    WHERE sl.tenant_id=p_tenant_id AND sl.site_id=p_site_id
      AND sl.supplier_payment_id=v_payment.id AND sl.entry_type='payment'
  ) THEN
    RAISE EXCEPTION 'SUPPLIER_PAYMENT_POSTED_GL_SOURCE_REVERSAL_REQUIRED' USING ERRCODE='22023';
  END IF;

  if v_payment.status='reversed' then
    v_replayed := true;
  elsif v_payment.status='posted' then

    select exists (
      select 1 from public.financial_settlements fs
      where fs.tenant_id=p_tenant_id and fs.site_id=p_site_id and fs.status='locked'
        and fs.period_start::date<=v_payment.payment_date
          and fs.period_end::date>=v_payment.payment_date
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

  select coalesce(sum(r.total_credit_amount-r.refund_amount),0)::numeric(14,2)
  into v_return_credit
  from public.supplier_purchase_returns as r
  where r.tenant_id=p_tenant_id and r.purchase_id=v_purchase.id and r.status='posted';

  v_outstanding := greatest(0,v_purchase.total_amount-v_paid_amount-v_return_credit);
  return query select v_payment.id,v_purchase.id,v_payment.status,v_payment.amount,
    v_paid_amount,v_outstanding,v_account_balance,v_replayed;
end;
$function$;