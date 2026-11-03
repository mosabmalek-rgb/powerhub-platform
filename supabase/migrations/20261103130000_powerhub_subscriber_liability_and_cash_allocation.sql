-- Security deposits are subscriber liabilities; invoice overpayments are cash receipts split
-- between invoice settlement and an independently auditable available-credit ledger.
-- All financial writes below are transactional and scoped to tenant + site + subscriber.

alter table public.payments
  add column if not exists invoice_applied_amount numeric(14,2) not null default 0,
  add column if not exists subscriber_credit_amount numeric(14,2) not null default 0;

update public.payments
set invoice_applied_amount = case
      when payment_purpose='invoice_collection' then amount
      else 0
    end,
    subscriber_credit_amount = 0
where invoice_applied_amount=0 and subscriber_credit_amount=0;

alter table public.payments drop constraint if exists payments_payment_purpose_check;
alter table public.payments
  add constraint payments_payment_purpose_check
  check (payment_purpose in (
    'invoice_collection',
    'invoice_collection_with_credit',
    'subscriber_credit',
    'security_deposit',
    'security_deposit_refund'
  ));
update public.payments
set invoice_applied_amount=case
      when payment_purpose in ('invoice_collection','invoice_collection_with_credit') then amount
      else 0
    end,
    subscriber_credit_amount=case
      when payment_purpose='subscriber_credit' then amount
      else 0
    end
where invoice_applied_amount=0 and subscriber_credit_amount=0;

alter table public.payments drop constraint if exists payments_invoice_credit_split_check;
alter table public.payments
  add constraint payments_invoice_credit_split_check
  check (
    case payment_purpose
      when 'invoice_collection' then
        invoice_applied_amount=amount and subscriber_credit_amount=0
      when 'invoice_collection_with_credit' then
        invoice_applied_amount>0 and subscriber_credit_amount>0
        and round(invoice_applied_amount+subscriber_credit_amount,2)=round(amount,2)
      when 'subscriber_credit' then
        invoice_applied_amount=0 and subscriber_credit_amount=amount
      when 'security_deposit' then
        invoice_applied_amount=0 and subscriber_credit_amount=0
      when 'security_deposit_refund' then
        invoice_applied_amount=0 and subscriber_credit_amount=0
      else false
    end
  );

alter table public.subscriber_balance_ledger
  add column if not exists source_ledger_id bigint references public.subscriber_balance_ledger(id) on delete restrict;
alter table public.subscriber_balance_ledger
  drop constraint if exists subscriber_balance_ledger_entry_scope_check;
alter table public.subscriber_balance_ledger
  add constraint subscriber_balance_ledger_entry_scope_check check (
    (balance_type='available_credit' and entry_type in ('receipt','application','refund','adjustment','reversal'))
    or (balance_type='security_deposit' and entry_type in ('receipt','application','refund','adjustment','reversal'))
  );
alter table public.subscriber_balance_ledger
  drop constraint if exists subscriber_balance_ledger_application_scope_check;
alter table public.subscriber_balance_ledger
  add constraint subscriber_balance_ledger_application_scope_check check (
    (entry_type='application' and balance_type in ('available_credit','security_deposit') and direction='debit' and invoice_id is not null)
    or (entry_type<>'application' and invoice_id is null)
  );
alter table public.subscriber_balance_ledger
  drop constraint if exists subscriber_balance_ledger_refund_source_check;
alter table public.subscriber_balance_ledger
  add constraint subscriber_balance_ledger_refund_source_check check (
    (entry_type in ('refund','application') and balance_type='security_deposit' and direction='debit' and source_ledger_id is not null)
    or (entry_type not in ('refund','application') and source_ledger_id is null)
  );
alter table public.billing_adjustments drop constraint if exists billing_adjustments_adjustment_type_check;
alter table public.billing_adjustments
  add constraint billing_adjustments_adjustment_type_check
  check (adjustment_type in (
    'auto_fraction_discount','fraction_carried','carried_debt_applied','manual_collection_discount',
    'security_deposit_applied'
  ));
create index if not exists subscriber_balance_ledger_source_idx
  on public.subscriber_balance_ledger(source_ledger_id)
  where source_ledger_id is not null;

-- The former generic balance-receipt route allowed a separate credit top-up path.
-- New credit originates from a real invoice payment split; security deposits are recorded with subscriber creation.
drop function if exists public.powerhub_record_subscriber_balance_receipt(
  bigint,bigint,bigint,bigint,text,text,numeric,text,bigint,text,text,text,text,text,bigint,uuid
);

create or replace function public.powerhub_record_security_deposit_receipt(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_subscriber_id bigint,
  p_payment_no text,
  p_amount numeric,
  p_company_account_id bigint,
  p_payment_method text,
  p_reference_no text,
  p_client_operation_id uuid
)
returns table(payment_id bigint,replayed boolean)
language plpgsql
security definer
set search_path=''
as $$
declare
  v_subscriber public.subscribers%rowtype;
  v_account public.company_accounts%rowtype;
  v_existing_operation public.offline_sync_operations%rowtype;
  v_existing_payment public.payments%rowtype;
  v_payment_id bigint;
  v_fingerprint text;
begin
  if p_client_operation_id is null or p_tenant_id is null or p_site_id is null
     or p_user_id is null or p_subscriber_id is null
     or p_payment_no is null or length(btrim(p_payment_no))<3
     or p_amount is null or p_amount<=0 or round(p_amount,2)<>p_amount
     or p_company_account_id is null
     or p_payment_method not in ('cash','jawwal_pay','palpay','bank_of_palestine','wallet','bank_transfer','card') then
    raise exception 'SECURITY_DEPOSIT_INPUT_INVALID' using errcode='P0001';
  end if;

  v_fingerprint:=pg_catalog.md5(pg_catalog.jsonb_build_object(
    'tenantId',p_tenant_id,'siteId',p_site_id,'userId',p_user_id,'subscriberId',p_subscriber_id,
    'paymentNo',p_payment_no,'amount',round(p_amount,2),'companyAccountId',p_company_account_id,
    'paymentMethod',p_payment_method,'referenceNo',p_reference_no
  )::text);

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('security-deposit-receipt:'||p_client_operation_id::text,0));
  select * into v_existing_operation from public.offline_sync_operations op
  where op.client_operation_id=p_client_operation_id::text
  order by op.id limit 1 for update;
  if found then
    if v_existing_operation.user_id is distinct from p_user_id
       or v_existing_operation.tenant_id is distinct from p_tenant_id
       or v_existing_operation.site_id is distinct from p_site_id
       or v_existing_operation.operation_type is distinct from 'security_deposit_receipt'
       or v_existing_operation.entity_type is distinct from 'subscriber_balance'
       or v_existing_operation.request_fingerprint is distinct from v_fingerprint
       or coalesce(v_existing_operation.response->>'paymentId','') !~ '^[0-9]+$' then
      raise exception 'SECURITY_DEPOSIT_OPERATION_CONFLICT' using errcode='P0001';
    end if;
    select * into v_existing_payment from public.payments
    where id=(v_existing_operation.response->>'paymentId')::bigint for update;
    if not found
       or v_existing_payment.client_operation_id is distinct from p_client_operation_id::text
       or v_existing_payment.tenant_id is distinct from p_tenant_id
       or v_existing_payment.site_id is distinct from p_site_id
       or v_existing_payment.subscriber_id is distinct from p_subscriber_id
       or v_existing_payment.payment_no is distinct from p_payment_no
       or v_existing_payment.amount is distinct from round(p_amount,2)
       or v_existing_payment.payment_purpose is distinct from 'security_deposit'
       or not exists(
         select 1 from public.account_transactions t
         where t.related_payment_id=v_existing_payment.id
           and t.tenant_id=p_tenant_id and t.account_id=p_company_account_id
           and t.transaction_type='deposit' and t.amount=round(p_amount,2)
           and t.created_by_user_id=p_user_id
       )
       or not exists(
         select 1 from public.subscriber_balance_ledger l
         where l.payment_id=v_existing_payment.id
           and l.tenant_id=p_tenant_id and l.site_id=p_site_id and l.subscriber_id=p_subscriber_id
           and l.balance_type='security_deposit' and l.entry_type='receipt'
           and l.direction='credit' and l.amount=round(p_amount,2)
       ) then
      raise exception 'SECURITY_DEPOSIT_REPLAY_INVALID' using errcode='P0001';
    end if;
    return query select v_existing_payment.id,true;
    return;
  end if;

  perform 1 from public.subscribers s
  where s.id=p_subscriber_id and s.tenant_id=p_tenant_id and s.site_id=p_site_id
  for update;
  if not found then raise exception 'SUBSCRIBER_OUT_OF_SCOPE' using errcode='P0001'; end if;

  select * into v_account from public.company_accounts a
  where a.id=p_company_account_id and a.tenant_id=p_tenant_id and a.is_active=true
  for update;
  if not found then raise exception 'COMPANY_ACCOUNT_NOT_FOUND' using errcode='P0001'; end if;
  if (p_payment_method='cash' and v_account.account_type<>'cash')
     or (p_payment_method<>'cash' and v_account.account_type='cash') then
    raise exception 'COMPANY_ACCOUNT_TYPE_MISMATCH' using errcode='P0001';
  end if;
  if exists(select 1 from public.company_account_sites cs where cs.account_id=v_account.id)
     and not exists(select 1 from public.company_account_sites cs
                    where cs.account_id=v_account.id and cs.site_id=p_site_id and cs.tenant_id=p_tenant_id) then
    raise exception 'COMPANY_ACCOUNT_OUT_OF_SCOPE' using errcode='P0001';
  end if;
  if exists(select 1 from public.financial_settlements fs
            where fs.tenant_id=p_tenant_id and fs.site_id=p_site_id and fs.status='locked'
              and fs.period_start<=pg_catalog.now() and fs.period_end>=pg_catalog.now()) then
    raise exception 'FINANCIAL_PERIOD_LOCKED' using errcode='P0001';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_payment_no));
  if exists(select 1 from public.payments p where p.payment_no=p_payment_no) then
    raise exception 'DUPLICATE_PAYMENT_NO' using errcode='P0001';
  end if;

  insert into public.payments(
    tenant_id,site_id,subscriber_id,invoice_id,payment_no,client_operation_id,amount,payment_method,
    transfer_to_account,transfer_to_type,reference_no,payment_purpose,invoice_applied_amount,
    subscriber_credit_amount,collected_by_user_id
  ) values (
    p_tenant_id,p_site_id,p_subscriber_id,null,p_payment_no,p_client_operation_id::text,p_amount,p_payment_method,
    v_account.phone_number,
    case when v_account.account_type in('jawwal_pay','palpay','bank_of_palestine') then v_account.account_type else null end,
    p_reference_no,'security_deposit',0,0,p_user_id
  ) returning id into v_payment_id;

  -- Deposits are liability receipts, not operating collections.
  insert into public.account_transactions(
    tenant_id,account_id,transaction_type,amount,description,reference_no,related_payment_id,created_by_user_id
  ) values (
    p_tenant_id,v_account.id,'deposit',p_amount,
    'استلام تأمين المشترك '||p_payment_no,p_reference_no,v_payment_id,p_user_id
  );

  insert into public.subscriber_balance_ledger(
    tenant_id,site_id,subscriber_id,balance_type,entry_type,direction,amount,payment_id,
    idempotency_key,created_by_user_id,metadata
  ) values (
    p_tenant_id,p_site_id,p_subscriber_id,'security_deposit','receipt','credit',p_amount,v_payment_id,
    'security-deposit:receipt:'||p_client_operation_id::text,p_user_id,
    pg_catalog.jsonb_build_object('paymentNo',p_payment_no,'companyAccountId',v_account.id,'referenceNo',p_reference_no)
  );

  insert into public.audit_logs(
    tenant_id,site_id,user_id,entity_type,entity_id,action,after_data,metadata
  ) values (
    p_tenant_id,p_site_id,p_user_id,'subscriber_balance',p_subscriber_id::text,'security_deposit_received',
    pg_catalog.jsonb_build_object('amount',p_amount,'paymentId',v_payment_id,'paymentNo',p_payment_no),
    pg_catalog.jsonb_build_object('companyAccountId',v_account.id,'clientOperationId',p_client_operation_id)
  );

  insert into public.offline_sync_operations(
    tenant_id,site_id,user_id,client_operation_id,operation_type,entity_type,entity_id,response,request_fingerprint
  ) values (
    p_tenant_id,p_site_id,p_user_id,p_client_operation_id::text,'security_deposit_receipt','subscriber_balance',
    p_subscriber_id,pg_catalog.jsonb_build_object('paymentId',v_payment_id),v_fingerprint
  );

  return query select v_payment_id,false;
end;
$$;
revoke all on function public.powerhub_record_security_deposit_receipt(bigint,bigint,bigint,bigint,text,numeric,bigint,text,text,uuid) from public,anon,authenticated;
grant execute on function public.powerhub_record_security_deposit_receipt(bigint,bigint,bigint,bigint,text,numeric,bigint,text,text,uuid) to service_role;

create or replace function public.powerhub_create_subscriber_with_security_deposit(
  p_tenant_id bigint,p_site_id bigint,p_user_id bigint,p_full_name text,p_phone text,
  p_whatsapp_number text,p_address text,p_subscription_type text,p_client_operation_id uuid,p_quota_limit integer,
  p_opening_reading numeric,p_opening_reading_at timestamptz,p_opening_image_key text,p_opening_image_hash text,
  p_opening_reading_approved boolean,p_offline_device_id uuid,p_offline_grant_id uuid,p_offline_number_value text,
  p_security_deposit_amount numeric,p_security_deposit_company_account_id bigint,p_security_deposit_payment_method text,
  p_security_deposit_payment_no text,p_security_deposit_reference_no text,p_security_deposit_operation_id uuid
)
returns table(subscriber_id bigint,subscriber_no text,opening_reading_id bigint,opening_reading_status text,replayed boolean,security_deposit_payment_id bigint)
language plpgsql
security definer
set search_path=''
as $$
declare
  v_subscriber_id bigint;
  v_subscriber_no text;
  v_opening_reading_id bigint;
  v_opening_reading_status text;
  v_replayed boolean;
  v_deposit_payment_id bigint;
  v_base record;
begin
  if p_security_deposit_amount is null or p_security_deposit_amount<=0
     or round(p_security_deposit_amount,2)<>p_security_deposit_amount
     or p_security_deposit_company_account_id is null
     or p_security_deposit_payment_no is null or length(btrim(p_security_deposit_payment_no))<3
     or p_security_deposit_operation_id is null
     or p_client_operation_id is null then
    raise exception 'SECURITY_DEPOSIT_INPUT_INVALID' using errcode='P0001';
  end if;
  if p_offline_grant_id is not null then
    if p_offline_device_id is null or p_offline_number_value is null
       or p_opening_reading is not null or p_opening_image_key is not null
       or p_opening_image_hash is not null or p_opening_reading_approved then
      raise exception 'OFFLINE_SUBSCRIBER_INPUT_INVALID' using errcode='P0001';
    end if;
    select x.subscriber_id,x.subscriber_no,null::bigint,null::text,x.replayed
      into v_subscriber_id,v_subscriber_no,v_opening_reading_id,v_opening_reading_status,v_replayed
    from public.powerhub_create_subscriber_with_offline_number(
      p_tenant_id,p_site_id,p_user_id,p_offline_device_id,p_offline_grant_id,p_offline_number_value,
      p_full_name,p_phone,p_whatsapp_number,p_address,p_subscription_type,p_client_operation_id
    ) x;
  elsif p_opening_reading is not null or p_opening_image_key is not null then
    select x.subscriber_id,x.subscriber_no,x.opening_reading_id,x.opening_reading_status,x.replayed
      into v_subscriber_id,v_subscriber_no,v_opening_reading_id,v_opening_reading_status,v_replayed
    from public.powerhub_create_subscriber_with_opening_reading(
      p_tenant_id,p_site_id,p_user_id,p_full_name,p_phone,p_whatsapp_number,p_address,p_subscription_type,
      p_client_operation_id,p_quota_limit,p_opening_reading,p_opening_reading_at,p_opening_image_key,
      p_opening_image_hash,p_opening_reading_approved
    ) x;
  else
    select x.subscriber_id,x.subscriber_no,null::bigint,null::text,x.replayed
      into v_subscriber_id,v_subscriber_no,v_opening_reading_id,v_opening_reading_status,v_replayed
    from public.powerhub_create_subscriber(
      p_tenant_id,p_site_id,p_user_id,p_full_name,p_phone,p_whatsapp_number,p_address,p_subscription_type,
      p_client_operation_id,p_quota_limit
    ) x;
  end if;

  select r.payment_id into v_deposit_payment_id
  from public.powerhub_record_security_deposit_receipt(
    p_tenant_id,p_site_id,p_user_id,v_subscriber_id,p_security_deposit_payment_no,
    p_security_deposit_amount,p_security_deposit_company_account_id,p_security_deposit_payment_method,
    p_security_deposit_reference_no,p_security_deposit_operation_id
  ) r;

  return query select v_subscriber_id,v_subscriber_no,v_opening_reading_id,v_opening_reading_status,
    coalesce(v_replayed,false),v_deposit_payment_id;
end;
$$;
revoke all on function public.powerhub_create_subscriber_with_security_deposit(bigint,bigint,bigint,text,text,text,text,text,uuid,integer,numeric,timestamptz,text,text,boolean,uuid,uuid,text,numeric,bigint,text,text,text,uuid) from public,anon,authenticated;
grant execute on function public.powerhub_create_subscriber_with_security_deposit(bigint,bigint,bigint,text,text,text,text,text,uuid,integer,numeric,timestamptz,text,text,boolean,uuid,uuid,text,numeric,bigint,text,text,text,uuid) to service_role;

drop function if exists public.powerhub_refund_subscriber_security_deposit(bigint,bigint,bigint,bigint,numeric,text,bigint,text,text,uuid);
create function public.powerhub_refund_subscriber_security_deposit(
  p_tenant_id bigint,p_site_id bigint,p_user_id bigint,p_subscriber_id bigint,p_amount numeric,
  p_payment_no text,p_company_account_id bigint,p_payment_method text,p_reference_no text,
  p_client_operation_id uuid,p_terminate_subscription boolean default false
)
returns table(
  payment_id bigint,replayed boolean,security_deposit_balance numeric,
  applied_to_invoices numeric,refunded_amount numeric,remaining_outstanding numeric,
  terminated boolean,termination_blocked boolean
)
language plpgsql
security definer
set search_path=''
as $$
declare
  v_subscriber public.subscribers%rowtype;
  v_account public.company_accounts%rowtype;
  v_operation public.offline_sync_operations%rowtype;
  v_existing_payment public.payments%rowtype;
  v_invoice public.invoices%rowtype;
  v_receipt record;
  v_receipt_used numeric(14,2);
  v_receipt_remaining numeric(14,2);
  v_invoice_remaining numeric(14,2);
  v_remaining numeric(14,2);
  v_chunk numeric(14,2);
  v_apply numeric(14,2);
  v_balance numeric(14,2);
  v_account_balance numeric(14,2);
  v_total_applied numeric(14,2):=0;
  v_refund_amount numeric(14,2):=0;
  v_remaining_outstanding numeric(14,2):=0;
  v_payment_id bigint;
  v_fingerprint text;
  v_platform_role text;
  v_tenant_role text;
  v_terminated boolean:=false;
begin
  if p_client_operation_id is null or p_amount is null or p_amount<=0
     or round(p_amount,2)<>p_amount or p_payment_no is null or length(btrim(p_payment_no))<3
     or p_company_account_id is null
     or p_payment_method not in ('cash','jawwal_pay','palpay','bank_of_palestine','wallet','bank_transfer','card') then
    raise exception 'SECURITY_DEPOSIT_REFUND_INPUT_INVALID' using errcode='P0001';
  end if;

  v_fingerprint:=pg_catalog.md5(pg_catalog.jsonb_build_object(
    'tenantId',p_tenant_id,'siteId',p_site_id,'userId',p_user_id,'subscriberId',p_subscriber_id,
    'expectedDepositBalance',round(p_amount,2),'paymentNo',p_payment_no,
    'companyAccountId',p_company_account_id,'paymentMethod',p_payment_method,
    'referenceNo',p_reference_no,'terminateSubscription',coalesce(p_terminate_subscription,false)
  )::text);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('security-deposit-refund:'||p_client_operation_id::text,0));

  select * into v_operation from public.offline_sync_operations op
  where op.client_operation_id=p_client_operation_id::text order by op.id limit 1 for update;
  if found then
    if v_operation.user_id is distinct from p_user_id or v_operation.tenant_id is distinct from p_tenant_id
       or v_operation.site_id is distinct from p_site_id
       or v_operation.operation_type is distinct from 'security_deposit_refund'
       or v_operation.entity_type is distinct from 'subscriber_balance'
       or v_operation.request_fingerprint is distinct from v_fingerprint
       or v_operation.response->>'securityDepositSettlement' is distinct from 'true' then
      raise exception 'SECURITY_DEPOSIT_REFUND_OPERATION_CONFLICT' using errcode='P0001';
    end if;

    v_payment_id:=case when coalesce(v_operation.response->>'paymentId','') ~ '^[0-9]+$'
      then (v_operation.response->>'paymentId')::bigint else null end;
    if v_payment_id is not null then
      select * into v_existing_payment from public.payments where id=v_payment_id for update;
      if not found or v_existing_payment.tenant_id is distinct from p_tenant_id
         or v_existing_payment.site_id is distinct from p_site_id
         or v_existing_payment.subscriber_id is distinct from p_subscriber_id
         or v_existing_payment.payment_purpose is distinct from 'security_deposit_refund'
         or v_existing_payment.amount is distinct from (v_operation.response->>'refundedAmount')::numeric
         or v_existing_payment.payment_no is distinct from p_payment_no
         or not exists(
           select 1 from public.account_transactions t
           where t.related_payment_id=v_payment_id and t.tenant_id=p_tenant_id
             and t.account_id=p_company_account_id and t.transaction_type='withdrawal'
             and t.amount=v_existing_payment.amount and t.created_by_user_id=p_user_id
         )
         or not exists(
           select 1 from public.subscriber_balance_ledger l
           where l.payment_id=v_payment_id and l.tenant_id=p_tenant_id and l.site_id=p_site_id
             and l.subscriber_id=p_subscriber_id and l.balance_type='security_deposit'
             and l.entry_type='refund' and l.direction='debit' and l.amount=v_existing_payment.amount
         ) then
        raise exception 'SECURITY_DEPOSIT_REFUND_REPLAY_INVALID' using errcode='P0001';
      end if;
    elsif coalesce((v_operation.response->>'refundedAmount')::numeric,0)<>0 then
      raise exception 'SECURITY_DEPOSIT_REFUND_REPLAY_INVALID' using errcode='P0001';
    end if;

    if coalesce((v_operation.response->>'appliedToInvoices')::numeric,0)>0
       and not exists(
         select 1 from public.subscriber_balance_ledger l
         where l.tenant_id=p_tenant_id and l.site_id=p_site_id and l.subscriber_id=p_subscriber_id
           and l.balance_type='security_deposit' and l.entry_type='application'
           and l.direction='debit' and l.metadata->>'settlementOperationId'=p_client_operation_id::text
       ) then
      raise exception 'SECURITY_DEPOSIT_SETTLEMENT_REPLAY_INVALID' using errcode='P0001';
    end if;

    return query select
      v_payment_id,true,
      coalesce((v_operation.response->>'securityDepositBalance')::numeric,0),
      coalesce((v_operation.response->>'appliedToInvoices')::numeric,0),
      coalesce((v_operation.response->>'refundedAmount')::numeric,0),
      coalesce((v_operation.response->>'remainingOutstanding')::numeric,0),
      coalesce((v_operation.response->>'terminated')::boolean,false),
      coalesce((v_operation.response->>'terminationBlocked')::boolean,false);
    return;
  end if;

  select * into v_subscriber from public.subscribers s
  where s.id=p_subscriber_id and s.tenant_id=p_tenant_id and s.site_id=p_site_id
  for update;
  if not found then raise exception 'SUBSCRIBER_OUT_OF_SCOPE' using errcode='P0001'; end if;

  select coalesce(sum(case when l.direction='credit' then l.amount else -l.amount end),0)::numeric(14,2)
    into v_balance
  from public.subscriber_balance_ledger l
  where l.tenant_id=p_tenant_id and l.site_id=p_site_id and l.subscriber_id=p_subscriber_id
    and l.balance_type='security_deposit';
  if round(p_amount,2)<>v_balance then
    raise exception 'SECURITY_DEPOSIT_BALANCE_CHANGED' using errcode='P0001';
  end if;
  if v_balance<=0 then raise exception 'SECURITY_DEPOSIT_BALANCE_INSUFFICIENT' using errcode='P0001'; end if;

  select * into v_account from public.company_accounts a
  where a.id=p_company_account_id and a.tenant_id=p_tenant_id and a.is_active=true
  for update;
  if not found then raise exception 'COMPANY_ACCOUNT_NOT_FOUND' using errcode='P0001'; end if;
  if (p_payment_method='cash' and v_account.account_type<>'cash')
     or (p_payment_method<>'cash' and v_account.account_type='cash') then
    raise exception 'COMPANY_ACCOUNT_TYPE_MISMATCH' using errcode='P0001';
  end if;
  if exists(select 1 from public.company_account_sites cs where cs.account_id=v_account.id)
     and not exists(select 1 from public.company_account_sites cs
                    where cs.account_id=v_account.id and cs.site_id=p_site_id and cs.tenant_id=p_tenant_id) then
    raise exception 'COMPANY_ACCOUNT_OUT_OF_SCOPE' using errcode='P0001';
  end if;
  if exists(select 1 from public.financial_settlements fs
            where fs.tenant_id=p_tenant_id and fs.site_id=p_site_id and fs.status='locked'
              and fs.period_start<=pg_catalog.now() and fs.period_end>=pg_catalog.now()) then
    raise exception 'FINANCIAL_PERIOD_LOCKED' using errcode='P0001';
  end if;

  -- Use the subscriber deposit to settle outstanding invoices in oldest-first order.
  for v_invoice in
    select i.* from public.invoices i
    where i.tenant_id=p_tenant_id and i.site_id=p_site_id and i.subscriber_id=p_subscriber_id
      and i.balance_due>0 and i.status not in ('draft','cancelled','paid')
    order by i.issue_date asc,i.id asc
    for update
  loop
    exit when round(v_balance-v_total_applied,2)<=0;
    v_apply:=least(greatest(0,round(v_balance-v_total_applied,2)),v_invoice.balance_due);
    if v_apply<=0 then exit; end if;

    v_invoice_remaining:=v_apply;
    for v_receipt in
      select l.id,l.amount
      from public.subscriber_balance_ledger l
      where l.tenant_id=p_tenant_id and l.site_id=p_site_id and l.subscriber_id=p_subscriber_id
        and l.balance_type='security_deposit' and l.entry_type='receipt' and l.direction='credit'
      order by l.created_at,l.id
      for update
    loop
      exit when v_invoice_remaining<=0;
      select coalesce(sum(r.amount),0)::numeric(14,2) into v_receipt_used
      from public.subscriber_balance_ledger r
      where r.source_ledger_id=v_receipt.id and r.entry_type in ('application','refund');
      v_receipt_remaining:=greatest(0,v_receipt.amount-v_receipt_used);
      if v_receipt_remaining<=0 then continue; end if;
      v_chunk:=least(v_invoice_remaining,v_receipt_remaining);
      insert into public.subscriber_balance_ledger(
        tenant_id,site_id,subscriber_id,balance_type,entry_type,direction,amount,invoice_id,source_ledger_id,
        idempotency_key,created_by_user_id,metadata
      ) values (
        p_tenant_id,p_site_id,p_subscriber_id,'security_deposit','application','debit',v_chunk,v_invoice.id,v_receipt.id,
        'security-deposit:application:'||p_client_operation_id::text||':'||v_invoice.id::text||':'||v_receipt.id::text,
        p_user_id,pg_catalog.jsonb_build_object(
          'invoiceNo',v_invoice.invoice_no,'settlementOperationId',p_client_operation_id,
          'companyAccountId',p_company_account_id,'amount',v_chunk
        )
      );
      v_invoice_remaining:=v_invoice_remaining-v_chunk;
    end loop;
    if v_invoice_remaining>0 then raise exception 'SECURITY_DEPOSIT_LEDGER_ALLOCATION_FAILED' using errcode='P0001'; end if;

    update public.invoices
    set credit_applied_amount=coalesce(credit_applied_amount,0)+v_apply,
        balance_due=greatest(0,round(balance_due-v_apply,2)),
        status=case
          when greatest(0,round(balance_due-v_apply,2))=0 then 'paid'
          when coalesce(paid_amount,0)+coalesce(credit_applied_amount,0)+v_apply>0 then 'partially_paid'
          when due_date<pg_catalog.now() then 'overdue'
          else 'issued'
        end,
        updated_at=pg_catalog.now()
    where id=v_invoice.id and tenant_id=p_tenant_id and site_id=p_site_id and subscriber_id=p_subscriber_id;

    insert into public.invoice_lines(tenant_id,invoice_id,line_type,description,quantity,unit_price,amount,display_order)
    values(
      p_tenant_id,v_invoice.id,'other','تسوية من تأمين المشترك',1,-v_apply,-v_apply,
      coalesce((select max(il.display_order)+1 from public.invoice_lines il where il.tenant_id=p_tenant_id and il.invoice_id=v_invoice.id),1)
    );
    insert into public.billing_adjustments(
      tenant_id,site_id,subscriber_id,invoice_id,adjustment_type,amount,state,idempotency_key,created_by_user_id,metadata
    ) values (
      p_tenant_id,p_site_id,p_subscriber_id,v_invoice.id,'security_deposit_applied',v_apply,'applied',
      'security-deposit:settlement:'||p_client_operation_id::text||':invoice:'||v_invoice.id::text,
      p_user_id,pg_catalog.jsonb_build_object('paymentNo',p_payment_no,'operationId',p_client_operation_id,'appliedAmount',v_apply)
    );
    insert into public.audit_logs(tenant_id,site_id,user_id,entity_type,entity_id,action,before_data,after_data,metadata)
    values (
      p_tenant_id,p_site_id,p_user_id,'invoice',v_invoice.id::text,'security_deposit_applied',
      pg_catalog.jsonb_build_object('balanceDue',v_invoice.balance_due,'creditAppliedAmount',coalesce(v_invoice.credit_applied_amount,0)),
      pg_catalog.jsonb_build_object('balanceDue',greatest(0,round(v_invoice.balance_due-v_apply,2)),'creditAppliedAmount',coalesce(v_invoice.credit_applied_amount,0)+v_apply),
      pg_catalog.jsonb_build_object('subscriberId',p_subscriber_id,'amount',v_apply,'operationId',p_client_operation_id)
    );
    v_total_applied:=v_total_applied+v_apply;
  end loop;

  select coalesce(sum(i.balance_due),0)::numeric(14,2) into v_remaining_outstanding
  from public.invoices i
  where i.tenant_id=p_tenant_id and i.site_id=p_site_id and i.subscriber_id=p_subscriber_id
    and i.balance_due>0 and i.status not in ('draft','cancelled','paid');

  if v_remaining_outstanding=0 then
    v_refund_amount:=greatest(0,round(v_balance-v_total_applied,2));
  end if;

  if v_refund_amount>0 then
    select coalesce(b.balance,0) into v_account_balance
    from public.powerhub_company_account_balance_rollup(p_tenant_id,array[p_company_account_id]::bigint[]) b
    where b.account_id=p_company_account_id;
    if coalesce(v_account_balance,0)<v_refund_amount then
      raise exception 'INSUFFICIENT_ACCOUNT_BALANCE' using errcode='P0001';
    end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_payment_no));
    if exists(select 1 from public.payments p where p.payment_no=p_payment_no) then
      raise exception 'DUPLICATE_PAYMENT_NO' using errcode='P0001';
    end if;

    insert into public.payments(
      tenant_id,site_id,subscriber_id,invoice_id,payment_no,client_operation_id,amount,payment_method,
      transfer_to_account,transfer_to_type,reference_no,payment_purpose,invoice_applied_amount,
      subscriber_credit_amount,collected_by_user_id
    ) values (
      p_tenant_id,p_site_id,p_subscriber_id,null,p_payment_no,p_client_operation_id::text,v_refund_amount,p_payment_method,
      v_account.phone_number,
      case when v_account.account_type in('jawwal_pay','palpay','bank_of_palestine') then v_account.account_type else null end,
      p_reference_no,'security_deposit_refund',0,0,p_user_id
    ) returning id into v_payment_id;
    insert into public.account_transactions(
      tenant_id,account_id,transaction_type,amount,description,reference_no,related_payment_id,created_by_user_id
    ) values (
      p_tenant_id,v_account.id,'withdrawal',v_refund_amount,
      'رد تأمين المشترك '||p_payment_no||case when v_total_applied>0 then ' بعد تسوية الفواتير' else '' end,
      p_reference_no,v_payment_id,p_user_id
    );

    v_remaining:=v_refund_amount;
    for v_receipt in
      select l.id,l.amount from public.subscriber_balance_ledger l
      where l.tenant_id=p_tenant_id and l.site_id=p_site_id and l.subscriber_id=p_subscriber_id
        and l.balance_type='security_deposit' and l.entry_type='receipt' and l.direction='credit'
      order by l.created_at,l.id
      for update
    loop
      exit when v_remaining<=0;
      select coalesce(sum(r.amount),0)::numeric(14,2) into v_receipt_used
      from public.subscriber_balance_ledger r
      where r.source_ledger_id=v_receipt.id and r.entry_type in ('application','refund');
      v_receipt_remaining:=greatest(0,v_receipt.amount-v_receipt_used);
      if v_receipt_remaining<=0 then continue; end if;
      v_chunk:=least(v_remaining,v_receipt_remaining);
      insert into public.subscriber_balance_ledger(
        tenant_id,site_id,subscriber_id,balance_type,entry_type,direction,amount,payment_id,source_ledger_id,
        idempotency_key,created_by_user_id,metadata
      ) values (
        p_tenant_id,p_site_id,p_subscriber_id,'security_deposit','refund','debit',v_chunk,v_payment_id,v_receipt.id,
        'security-deposit:refund:'||p_client_operation_id::text||':'||v_receipt.id::text,p_user_id,
        pg_catalog.jsonb_build_object('paymentNo',p_payment_no,'companyAccountId',v_account.id,'sourceReceiptLedgerId',v_receipt.id)
      );
      v_remaining:=v_remaining-v_chunk;
    end loop;
    if v_remaining>0 then raise exception 'SECURITY_DEPOSIT_BALANCE_INSUFFICIENT' using errcode='P0001'; end if;
  end if;

  if coalesce(p_terminate_subscription,false) and v_remaining_outstanding=0 then
    update public.subscribers set service_status='disconnected',updated_at=pg_catalog.now()
    where id=p_subscriber_id and tenant_id=p_tenant_id and site_id=p_site_id;
    v_terminated:=true;
  end if;

  select u.platform_role,m.role into v_platform_role,v_tenant_role
  from public.users u left join public.tenant_members m on m.user_id=u.id and m.tenant_id=p_tenant_id
  where u.id=p_user_id;
  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,actor_tenant_role,entity_type,entity_id,action,after_data,metadata
  ) values (
    p_tenant_id,p_site_id,p_user_id,v_platform_role,v_tenant_role,'subscriber_balance',p_subscriber_id::text,
    case when v_terminated then 'security_deposit_refunded_and_subscriber_disconnected'
         when v_refund_amount>0 then 'security_deposit_refunded'
         else 'security_deposit_applied_to_outstanding_invoices' end,
    pg_catalog.jsonb_build_object(
      'appliedToInvoices',v_total_applied,'refundedAmount',v_refund_amount,
      'remainingOutstanding',v_remaining_outstanding,'terminated',v_terminated
    ),
    pg_catalog.jsonb_build_object(
      'companyAccountId',v_account.id,'clientOperationId',p_client_operation_id,
      'paymentId',v_payment_id,'paymentNo',p_payment_no,'expectedDepositBalance',v_balance,
      'terminationRequested',coalesce(p_terminate_subscription,false),
      'terminationBlocked',coalesce(p_terminate_subscription,false) and not v_terminated
    )
  );

  insert into public.offline_sync_operations(
    tenant_id,site_id,user_id,client_operation_id,operation_type,entity_type,entity_id,response,request_fingerprint
  ) values (
    p_tenant_id,p_site_id,p_user_id,p_client_operation_id::text,'security_deposit_refund','subscriber_balance',
    p_subscriber_id,pg_catalog.jsonb_build_object(
      'securityDepositSettlement',true,'paymentId',v_payment_id,
      'securityDepositBalance',greatest(0,round(v_balance-v_total_applied-v_refund_amount,2)),
      'appliedToInvoices',v_total_applied,'refundedAmount',v_refund_amount,
      'remainingOutstanding',v_remaining_outstanding,'terminated',v_terminated,
      'terminationBlocked',coalesce(p_terminate_subscription,false) and not v_terminated
    ),v_fingerprint
  );

  return query select
    v_payment_id,false,
    greatest(0,round(v_balance-v_total_applied-v_refund_amount,2)),
    v_total_applied,v_refund_amount,v_remaining_outstanding,v_terminated,
    coalesce(p_terminate_subscription,false) and not v_terminated;
end;
$$;
revoke all on function public.powerhub_refund_subscriber_security_deposit(bigint,bigint,bigint,bigint,numeric,text,bigint,text,text,uuid,boolean) from public,anon,authenticated;
grant execute on function public.powerhub_refund_subscriber_security_deposit(bigint,bigint,bigint,bigint,numeric,text,bigint,text,text,uuid,boolean) to service_role;

create or replace function public.powerhub_security_deposit_overview(p_tenant_id bigint,p_site_id bigint)
returns table(total_amount numeric,subscriber_count bigint,items jsonb)
language sql
stable
security definer
set search_path=''
as $$
  with balances as (
    select l.subscriber_id,
      sum(case when l.direction='credit' then l.amount else -l.amount end)::numeric(14,2) as balance,
      max(l.created_at) as last_movement_at
    from public.subscriber_balance_ledger l
    where l.tenant_id=p_tenant_id and l.site_id=p_site_id and l.balance_type='security_deposit'
    group by l.subscriber_id
    having sum(case when l.direction='credit' then l.amount else -l.amount end)>0
  ),
  rows as (
    select b.subscriber_id,s.full_name,s.subscriber_no,s.phone,b.balance,b.last_movement_at
    from balances b
    join public.subscribers s on s.id=b.subscriber_id and s.tenant_id=p_tenant_id and s.site_id=p_site_id
    order by s.full_name,s.id
  )
  select
    coalesce(sum(r.balance),0)::numeric(14,2),
    count(*)::bigint,
    coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'subscriberId',r.subscriber_id,'fullName',r.full_name,'subscriberNo',r.subscriber_no,
      'phone',r.phone,'amount',r.balance,'lastMovementAt',r.last_movement_at
    ) order by r.full_name,r.subscriber_id),'[]'::jsonb)
  from rows r;
$$;
revoke all on function public.powerhub_security_deposit_overview(bigint,bigint) from public,anon,authenticated;
grant execute on function public.powerhub_security_deposit_overview(bigint,bigint) to service_role;

-- Replace the payment RPC in-place: it applies existing credit first, then splits the
-- newly received cash between this invoice's due amount and a new subscriber-credit entry.
CREATE OR REPLACE FUNCTION public.powerhub_create_payment(p_tenant_id bigint, p_site_id bigint, p_user_id bigint, p_subscriber_id bigint, p_invoice_id bigint, p_payment_no text, p_amount numeric, p_payment_method text, p_company_account_id bigint, p_transfer_from_account text, p_transfer_from_type text, p_reference_no text, p_receipt_image_key text, p_receipt_image_hash text, p_collector_session_id bigint, p_client_operation_id uuid)
 RETURNS TABLE(payment_id bigint, replayed boolean)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_invoice public.invoices%rowtype;
  v_account public.company_accounts%rowtype;
  v_payment_id bigint;
  v_new_paid numeric(14,2);
  v_new_balance numeric(14,2);
  v_invoice_status text;
  v_platform_role text;
  v_tenant_role text;
  v_response jsonb;
  v_operation public.offline_sync_operations%rowtype;
  v_existing_payment public.payments%rowtype;
  v_request_fingerprint text;
  v_invoice_applied_amount numeric(14,2) := 0;
  v_subscriber_credit_amount numeric(14,2) := 0;
begin
  if p_amount <= 0 then raise exception 'INVALID_PAYMENT_AMOUNT' using errcode = 'P0001'; end if;
  if p_payment_method not in ('cash', 'jawwal_pay', 'palpay', 'bank_of_palestine', 'wallet', 'bank_transfer', 'card') then raise exception 'INVALID_PAYMENT_METHOD' using errcode = 'P0001'; end if;
  if (p_transfer_from_account is null) <> (p_transfer_from_type is null) then raise exception 'INVALID_TRANSFER_SOURCE' using errcode = 'P0001'; end if;
  v_request_fingerprint := md5(jsonb_build_object(
      'tenantId',p_tenant_id,'siteId',p_site_id,'userId',p_user_id,
      'subscriberId',p_subscriber_id,'invoiceId',p_invoice_id,'paymentNo',p_payment_no,
      'amount',round(p_amount,2),'paymentMethod',p_payment_method,'companyAccountId',p_company_account_id,
      'transferFromAccount',p_transfer_from_account,'transferFromType',p_transfer_from_type,
      'referenceNo',p_reference_no,'receiptImageKey',p_receipt_image_key,'receiptImageHash',p_receipt_image_hash,
      'collectorSessionId',p_collector_session_id
    )::text);

  if p_client_operation_id is not null then
    -- The payment operation key is globally locked because payments.client_operation_id is globally unique.
    perform pg_advisory_xact_lock(hashtextextended('payment-create:' || p_client_operation_id::text, 0));
    if exists(
      select 1 from public.offline_sync_operations op
      where op.client_operation_id=p_client_operation_id::text
        and (op.user_id is distinct from p_user_id
          or op.tenant_id is distinct from p_tenant_id
          or op.site_id is distinct from p_site_id
          or op.operation_type is distinct from 'payment_create'
          or op.entity_type is distinct from 'payment')
    ) then
      raise exception 'PAYMENT_OPERATION_SCOPE_CONFLICT' using errcode='P0001';
    end if;

    select * into v_operation from public.offline_sync_operations op
    where op.user_id=p_user_id and op.client_operation_id=p_client_operation_id::text
    order by op.id limit 1 for update;
    if found then
      if v_operation.tenant_id is distinct from p_tenant_id
         or v_operation.site_id is distinct from p_site_id
         or v_operation.operation_type is distinct from 'payment_create'
         or v_operation.entity_type is distinct from 'payment'
         or coalesce(v_operation.response->>'id','') !~ '^[0-9]+$' then
        raise exception 'PAYMENT_OPERATION_SCOPE_CONFLICT' using errcode='P0001';
      end if;
      if v_operation.request_fingerprint is not null
         and v_operation.request_fingerprint is distinct from v_request_fingerprint then
        raise exception 'PAYMENT_OPERATION_SCOPE_CONFLICT' using errcode='P0001';
      end if;
      select * into v_existing_payment from public.payments
      where id=(v_operation.response->>'id')::bigint for update;
      if not found then raise exception 'INVALID_PAYMENT_OPERATION_REPLAY' using errcode='P0001'; end if;
  if v_existing_payment.client_operation_id is distinct from p_client_operation_id::text
     or v_existing_payment.tenant_id is distinct from p_tenant_id
     or v_existing_payment.site_id is distinct from p_site_id
     or v_existing_payment.collected_by_user_id is distinct from p_user_id
     or v_existing_payment.subscriber_id is distinct from p_subscriber_id
     or v_existing_payment.invoice_id is distinct from p_invoice_id
     or v_existing_payment.payment_no is distinct from p_payment_no
     or v_existing_payment.amount is distinct from round(p_amount,2)
     or v_existing_payment.payment_method is distinct from p_payment_method
     or v_existing_payment.transfer_from_account is distinct from p_transfer_from_account
     or v_existing_payment.transfer_from_type is distinct from p_transfer_from_type
     or v_existing_payment.reference_no is distinct from p_reference_no
     or v_existing_payment.receipt_image_key is distinct from p_receipt_image_key
     or v_existing_payment.receipt_image_hash is distinct from p_receipt_image_hash
     or v_existing_payment.collector_session_id is distinct from p_collector_session_id
      or round(coalesce(v_existing_payment.invoice_applied_amount,0)+coalesce(v_existing_payment.subscriber_credit_amount,0),2) is distinct from round(p_amount,2)
      or (
        coalesce(v_existing_payment.subscriber_credit_amount,0)>0
        and not exists(
          select 1 from public.subscriber_balance_ledger l
          where l.payment_id=v_existing_payment.id and l.tenant_id=p_tenant_id
            and l.site_id=p_site_id and l.subscriber_id=p_subscriber_id
            and l.balance_type='available_credit' and l.entry_type='receipt'
            and l.direction='credit' and l.amount=v_existing_payment.subscriber_credit_amount
            and l.idempotency_key='subscriber-credit:payment:'||v_existing_payment.id::text
        )
      )
     or not exists(
       select 1 from public.account_transactions t
       where t.related_payment_id=v_existing_payment.id
         and t.tenant_id=p_tenant_id and t.account_id=p_company_account_id
         and t.transaction_type='collection' and t.amount=round(p_amount,2)
         and t.reference_no is not distinct from p_reference_no
         and t.created_by_user_id=p_user_id
     ) then
    raise exception 'PAYMENT_OPERATION_SCOPE_CONFLICT' using errcode='P0001';
  end if;

      -- Legacy operation rows get a fingerprint only after persisted financial evidence matches.
      if v_operation.request_fingerprint is null then
        update public.offline_sync_operations set request_fingerprint=v_request_fingerprint where id=v_operation.id;
      end if;
      return query select v_existing_payment.id,true;
      return;
    end if;

    select * into v_existing_payment from public.payments
    where client_operation_id=p_client_operation_id::text order by id limit 1 for update;
    if found then
  if v_existing_payment.client_operation_id is distinct from p_client_operation_id::text
     or v_existing_payment.tenant_id is distinct from p_tenant_id
     or v_existing_payment.site_id is distinct from p_site_id
     or v_existing_payment.collected_by_user_id is distinct from p_user_id
     or v_existing_payment.subscriber_id is distinct from p_subscriber_id
     or v_existing_payment.invoice_id is distinct from p_invoice_id
     or v_existing_payment.payment_no is distinct from p_payment_no
     or v_existing_payment.amount is distinct from round(p_amount,2)
     or v_existing_payment.payment_method is distinct from p_payment_method
     or v_existing_payment.transfer_from_account is distinct from p_transfer_from_account
     or v_existing_payment.transfer_from_type is distinct from p_transfer_from_type
     or v_existing_payment.reference_no is distinct from p_reference_no
     or v_existing_payment.receipt_image_key is distinct from p_receipt_image_key
     or v_existing_payment.receipt_image_hash is distinct from p_receipt_image_hash
     or v_existing_payment.collector_session_id is distinct from p_collector_session_id
      or round(coalesce(v_existing_payment.invoice_applied_amount,0)+coalesce(v_existing_payment.subscriber_credit_amount,0),2) is distinct from round(p_amount,2)
      or (
        coalesce(v_existing_payment.subscriber_credit_amount,0)>0
        and not exists(
          select 1 from public.subscriber_balance_ledger l
          where l.payment_id=v_existing_payment.id and l.tenant_id=p_tenant_id
            and l.site_id=p_site_id and l.subscriber_id=p_subscriber_id
            and l.balance_type='available_credit' and l.entry_type='receipt'
            and l.direction='credit' and l.amount=v_existing_payment.subscriber_credit_amount
            and l.idempotency_key='subscriber-credit:payment:'||v_existing_payment.id::text
        )
      )
     or not exists(
       select 1 from public.account_transactions t
       where t.related_payment_id=v_existing_payment.id
         and t.tenant_id=p_tenant_id and t.account_id=p_company_account_id
         and t.transaction_type='collection' and t.amount=round(p_amount,2)
         and t.reference_no is not distinct from p_reference_no
         and t.created_by_user_id=p_user_id
     ) then
    raise exception 'PAYMENT_OPERATION_SCOPE_CONFLICT' using errcode='P0001';
  end if;
      insert into public.offline_sync_operations(
        tenant_id,site_id,user_id,client_operation_id,operation_type,entity_type,entity_id,response,request_fingerprint
      ) values (
        p_tenant_id,p_site_id,p_user_id,p_client_operation_id::text,'payment_create','payment',
        v_existing_payment.id,jsonb_build_object('id',v_existing_payment.id),v_request_fingerprint
      );
      return query select v_existing_payment.id,true;
      return;
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtext(p_payment_no));
  if exists(select 1 from public.payments where payment_no=p_payment_no) then raise exception 'DUPLICATE_PAYMENT_NO' using errcode='P0001'; end if;
  if exists(select 1 from public.financial_settlements where tenant_id=p_tenant_id and site_id=p_site_id and status='locked' and period_start<=now() and period_end>=now()) then raise exception 'FINANCIAL_PERIOD_LOCKED' using errcode='P0001'; end if;
  perform 1 from public.subscribers
  where id=p_subscriber_id and tenant_id=p_tenant_id and site_id=p_site_id
    and service_status='active' and archived_at is null
  for update;
  if not found then raise exception 'SUBSCRIBER_OUT_OF_SCOPE_OR_INACTIVE' using errcode='P0001'; end if;
  select * into v_account from public.company_accounts where id=p_company_account_id and tenant_id=p_tenant_id and is_active=true for update;
  if not found then raise exception 'COMPANY_ACCOUNT_NOT_FOUND' using errcode='P0001'; end if;
  if (p_payment_method='cash' and v_account.account_type<>'cash') or (p_payment_method<>'cash' and v_account.account_type='cash') then raise exception 'COMPANY_ACCOUNT_TYPE_MISMATCH' using errcode='P0001'; end if;
  if exists(select 1 from public.company_account_sites where account_id=v_account.id)
     and not exists(select 1 from public.company_account_sites where account_id=v_account.id and site_id=p_site_id and tenant_id=p_tenant_id) then raise exception 'COMPANY_ACCOUNT_OUT_OF_SCOPE' using errcode='P0001'; end if;
  if p_collector_session_id is not null and not exists(select 1 from public.collector_sessions where id=p_collector_session_id and tenant_id=p_tenant_id and site_id=p_site_id and collector_user_id=p_user_id and status='open') then raise exception 'COLLECTOR_SESSION_NOT_OPEN' using errcode='P0001'; end if;

  if p_invoice_id is not null then
    perform pg_advisory_xact_lock(p_invoice_id);
    select * into v_invoice from public.invoices where id=p_invoice_id and tenant_id=p_tenant_id and site_id=p_site_id and subscriber_id=p_subscriber_id for update;
    if not found then raise exception 'INVOICE_OUT_OF_SCOPE' using errcode='P0001'; end if;
    if v_invoice.status in ('draft','cancelled') then raise exception 'INVOICE_NOT_COLLECTIBLE' using errcode='P0001'; end if;

    -- Consume already available subscriber credit before applying the new cash receipt.
    perform public.powerhub_apply_subscriber_credit_to_invoice(
      p_tenant_id,p_site_id,p_subscriber_id,p_invoice_id,p_user_id
    );
    select * into v_invoice from public.invoices
    where id=p_invoice_id and tenant_id=p_tenant_id and site_id=p_site_id and subscriber_id=p_subscriber_id
    for update;
    if not found then raise exception 'INVOICE_OUT_OF_SCOPE' using errcode='P0001'; end if;

    v_invoice_applied_amount:=least(round(p_amount,2),greatest(0,v_invoice.balance_due));
    v_subscriber_credit_amount:=greatest(0,round(p_amount-v_invoice_applied_amount,2));
    v_new_paid:=v_invoice.paid_amount+v_invoice_applied_amount;
    v_new_balance:=greatest(0,round(v_invoice.total_amount-v_new_paid-coalesce(v_invoice.credit_applied_amount,0),2));
    v_invoice_status:=case
      when v_new_balance=0 then 'paid'
      when v_new_paid+coalesce(v_invoice.credit_applied_amount,0)>0 then 'partially_paid'
      when v_invoice.due_date<now() then 'overdue'
      else 'issued'
    end;
    update public.invoices
    set paid_amount=v_new_paid,balance_due=v_new_balance,status=v_invoice_status,updated_at=now()
    where id=v_invoice.id and tenant_id=p_tenant_id and site_id=p_site_id;
  else
    v_subscriber_credit_amount:=round(p_amount,2);
  end if;

  insert into public.payments(
    tenant_id,site_id,subscriber_id,invoice_id,payment_no,client_operation_id,amount,payment_method,
    transfer_from_account,transfer_from_type,transfer_to_account,transfer_to_type,reference_no,
    receipt_image_key,receipt_image_hash,payment_purpose,invoice_applied_amount,subscriber_credit_amount,
    collected_by_user_id,collector_session_id
  ) values (
    p_tenant_id,p_site_id,p_subscriber_id,p_invoice_id,p_payment_no,p_client_operation_id::text,p_amount,p_payment_method,
    p_transfer_from_account,p_transfer_from_type,v_account.phone_number,
    case when v_account.account_type in('jawwal_pay','palpay','bank_of_palestine') then v_account.account_type else null end,
    p_reference_no,p_receipt_image_key,p_receipt_image_hash,
    case
      when v_subscriber_credit_amount>0 and v_invoice_applied_amount=0 then 'subscriber_credit'
      when v_subscriber_credit_amount>0 then 'invoice_collection_with_credit'
      else 'invoice_collection'
    end,
    v_invoice_applied_amount,v_subscriber_credit_amount,p_user_id,p_collector_session_id
  ) returning id into v_payment_id;

  insert into public.account_transactions(tenant_id,account_id,transaction_type,amount,description,reference_no,related_payment_id,created_by_user_id)
  values(
    p_tenant_id,v_account.id,'collection',p_amount,
    case when v_subscriber_credit_amount>0
      then format('مبلغ مستلم عن الفاتورة %s — تسديد %s ورصيد دائن %s',p_payment_no,v_invoice_applied_amount,v_subscriber_credit_amount)
      else format('تحصيل الفاتورة %s',p_payment_no) end,
    p_reference_no,v_payment_id,p_user_id
  );

  if v_subscriber_credit_amount>0 then
    insert into public.subscriber_balance_ledger(
      tenant_id,site_id,subscriber_id,balance_type,entry_type,direction,amount,payment_id,
      idempotency_key,created_by_user_id,metadata
    ) values (
      p_tenant_id,p_site_id,p_subscriber_id,'available_credit','receipt','credit',v_subscriber_credit_amount,v_payment_id,
      'subscriber-credit:payment:'||v_payment_id::text,p_user_id,
      jsonb_build_object(
        'paymentNo',p_payment_no,'invoiceId',p_invoice_id,
        'cashReceived',p_amount,'invoiceAppliedAmount',v_invoice_applied_amount,
        'subscriberCreditAmount',v_subscriber_credit_amount,'companyAccountId',v_account.id
      )
    );
  end if;

  select u.platform_role, m.role into v_platform_role, v_tenant_role
  from public.users u
  left join public.tenant_members m on m.user_id=u.id and m.tenant_id=p_tenant_id
  where u.id=p_user_id;
  if v_platform_role not in ('platform_owner','platform_admin','finance_admin') then v_platform_role:=null; end if;
  insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,actor_tenant_role,entity_type,entity_id,action,after_data,metadata)
  values(p_tenant_id,p_site_id,p_user_id,v_platform_role,v_tenant_role,'payment',v_payment_id::text,'create',
    jsonb_build_object('paymentNo',p_payment_no,'amount',p_amount,'invoiceId',p_invoice_id,'invoiceAppliedAmount',v_invoice_applied_amount,'subscriberCreditAmount',v_subscriber_credit_amount,'companyAccountId',v_account.id,'paymentMethod',p_payment_method),
    jsonb_build_object('collectorSessionId',p_collector_session_id,'receiptImageAttached',p_receipt_image_key is not null));
  if p_client_operation_id is not null then
    insert into public.offline_sync_operations(tenant_id,site_id,user_id,client_operation_id,operation_type,entity_type,entity_id,response,request_fingerprint)
    values(p_tenant_id,p_site_id,p_user_id,p_client_operation_id::text,'payment_create','payment',v_payment_id,jsonb_build_object('id',v_payment_id),v_request_fingerprint);
  end if;
  return query select v_payment_id,false;
end;
$function$


-- Keep manual discounts separate from both cash and subscriber credit.
CREATE OR REPLACE FUNCTION public.powerhub_create_payment_with_discount(p_tenant_id bigint, p_site_id bigint, p_user_id bigint, p_subscriber_id bigint, p_invoice_id bigint, p_payment_no text, p_amount numeric, p_payment_method text, p_company_account_id bigint, p_transfer_from_account text, p_transfer_from_type text, p_reference_no text, p_receipt_image_key text, p_receipt_image_hash text, p_collector_session_id bigint, p_client_operation_id uuid, p_manual_discount_amount numeric, p_manual_discount_reason text)
 RETURNS TABLE(payment_id bigint, replayed boolean)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_invoice public.invoices%rowtype;
  v_account public.company_accounts%rowtype;
  v_payment_id bigint;
  v_response jsonb;
  v_platform_role text;
  v_tenant_role text;
  v_new_total numeric(14,2);
  v_new_balance numeric(14,2);
  v_new_status text;
  v_operation public.offline_sync_operations%rowtype;
  v_existing_payment public.payments%rowtype;
  v_request_fingerprint text;
  v_replayed boolean;
begin
  if p_manual_discount_amount is null or p_manual_discount_amount<0 then raise exception 'INVALID_MANUAL_DISCOUNT' using errcode='P0001'; end if;
  if p_manual_discount_amount>0 and (p_invoice_id is null or length(btrim(coalesce(p_manual_discount_reason,'')))<3) then raise exception 'MANUAL_DISCOUNT_REASON_REQUIRED' using errcode='P0001'; end if;
  if p_manual_discount_amount=0 then
    return query select created.payment_id,created.replayed from public.powerhub_create_payment(
      p_tenant_id,p_site_id,p_user_id,p_subscriber_id,p_invoice_id,p_payment_no,p_amount,p_payment_method,p_company_account_id,
      p_transfer_from_account,p_transfer_from_type,p_reference_no,p_receipt_image_key,p_receipt_image_hash,p_collector_session_id,p_client_operation_id
    ) as created; return;
  end if;
  if p_amount<=0 then raise exception 'INVALID_PAYMENT_AMOUNT' using errcode='P0001'; end if;
  v_request_fingerprint := md5(jsonb_build_object(
    'tenantId',p_tenant_id,'siteId',p_site_id,'userId',p_user_id,
    'subscriberId',p_subscriber_id,'invoiceId',p_invoice_id,'paymentNo',p_payment_no,
    'amount',round(p_amount,2),'paymentMethod',p_payment_method,'companyAccountId',p_company_account_id,
    'transferFromAccount',p_transfer_from_account,'transferFromType',p_transfer_from_type,
    'referenceNo',p_reference_no,'receiptImageKey',p_receipt_image_key,'receiptImageHash',p_receipt_image_hash,
    'collectorSessionId',p_collector_session_id,'manualDiscountAmount',round(p_manual_discount_amount,2),
    'manualDiscountReason',btrim(p_manual_discount_reason)
  )::text);

  if p_client_operation_id is not null then
    perform pg_advisory_xact_lock(hashtextextended('payment-create:' || p_client_operation_id::text, 0));
    if exists(
      select 1 from public.offline_sync_operations op
      where op.client_operation_id=p_client_operation_id::text
        and (op.user_id is distinct from p_user_id
          or op.tenant_id is distinct from p_tenant_id
          or op.site_id is distinct from p_site_id
          or op.operation_type is distinct from 'payment_create'
          or op.entity_type is distinct from 'payment')
    ) then
      raise exception 'PAYMENT_OPERATION_SCOPE_CONFLICT' using errcode='P0001';
    end if;

    select * into v_operation from public.offline_sync_operations op
    where op.user_id=p_user_id and op.client_operation_id=p_client_operation_id::text
    order by op.id limit 1 for update;
    if found then
      if v_operation.tenant_id is distinct from p_tenant_id
         or v_operation.site_id is distinct from p_site_id
         or v_operation.operation_type is distinct from 'payment_create'
         or v_operation.entity_type is distinct from 'payment'
         or coalesce(v_operation.response->>'id','') !~ '^[0-9]+$' then
        raise exception 'PAYMENT_OPERATION_SCOPE_CONFLICT' using errcode='P0001';
      end if;
      if v_operation.request_fingerprint is not null
         and v_operation.request_fingerprint is distinct from v_request_fingerprint then
        raise exception 'PAYMENT_OPERATION_SCOPE_CONFLICT' using errcode='P0001';
      end if;
      select * into v_existing_payment from public.payments
      where id=(v_operation.response->>'id')::bigint for update;
      if not found then raise exception 'INVALID_PAYMENT_OPERATION_REPLAY' using errcode='P0001'; end if;
  if v_existing_payment.client_operation_id is distinct from p_client_operation_id::text
     or v_existing_payment.tenant_id is distinct from p_tenant_id
     or v_existing_payment.site_id is distinct from p_site_id
     or v_existing_payment.collected_by_user_id is distinct from p_user_id
     or v_existing_payment.subscriber_id is distinct from p_subscriber_id
     or v_existing_payment.invoice_id is distinct from p_invoice_id
     or v_existing_payment.payment_no is distinct from p_payment_no
     or v_existing_payment.amount is distinct from round(p_amount,2)
     or v_existing_payment.payment_method is distinct from p_payment_method
     or v_existing_payment.transfer_from_account is distinct from p_transfer_from_account
     or v_existing_payment.transfer_from_type is distinct from p_transfer_from_type
     or v_existing_payment.reference_no is distinct from p_reference_no
     or v_existing_payment.receipt_image_key is distinct from p_receipt_image_key
     or v_existing_payment.receipt_image_hash is distinct from p_receipt_image_hash
     or v_existing_payment.collector_session_id is distinct from p_collector_session_id
      or round(coalesce(v_existing_payment.invoice_applied_amount,0)+coalesce(v_existing_payment.subscriber_credit_amount,0),2) is distinct from round(p_amount,2)
      or (
        coalesce(v_existing_payment.subscriber_credit_amount,0)>0
        and not exists(
          select 1 from public.subscriber_balance_ledger l
          where l.payment_id=v_existing_payment.id and l.tenant_id=p_tenant_id
            and l.site_id=p_site_id and l.subscriber_id=p_subscriber_id
            and l.balance_type='available_credit' and l.entry_type='receipt'
            and l.direction='credit' and l.amount=v_existing_payment.subscriber_credit_amount
            and l.idempotency_key='subscriber-credit:payment:'||v_existing_payment.id::text
        )
      )
     or not exists(
       select 1 from public.account_transactions t
       where t.related_payment_id=v_existing_payment.id
         and t.tenant_id=p_tenant_id and t.account_id=p_company_account_id
         and t.transaction_type='collection' and t.amount=round(p_amount,2)
         and t.reference_no is not distinct from p_reference_no
         and t.created_by_user_id=p_user_id
     ) then
    raise exception 'PAYMENT_OPERATION_SCOPE_CONFLICT' using errcode='P0001';
  end if;

  if not exists(
    select 1 from public.billing_adjustments a
    where a.tenant_id=p_tenant_id and a.site_id=p_site_id
      and a.subscriber_id=p_subscriber_id and a.invoice_id=p_invoice_id
      and a.adjustment_type='manual_collection_discount' and a.state='applied'
      and a.idempotency_key='payment:'||p_client_operation_id::text||':manual-discount'
      and a.amount=round(p_manual_discount_amount,2)
      and a.created_by_user_id=p_user_id
      and a.metadata->>'reason'=btrim(p_manual_discount_reason)
      and a.metadata->>'paymentNo'=p_payment_no
      and (a.metadata->>'cashCollected')::numeric=round(p_amount,2)
  ) then
    raise exception 'PAYMENT_OPERATION_SCOPE_CONFLICT' using errcode='P0001';
  end if;

      if v_operation.request_fingerprint is null then
        update public.offline_sync_operations set request_fingerprint=v_request_fingerprint where id=v_operation.id;
      end if;
      return query select v_existing_payment.id,true;
      return;
    end if;

    select * into v_existing_payment from public.payments
    where client_operation_id=p_client_operation_id::text order by id limit 1 for update;
    if found then
  if v_existing_payment.client_operation_id is distinct from p_client_operation_id::text
     or v_existing_payment.tenant_id is distinct from p_tenant_id
     or v_existing_payment.site_id is distinct from p_site_id
     or v_existing_payment.collected_by_user_id is distinct from p_user_id
     or v_existing_payment.subscriber_id is distinct from p_subscriber_id
     or v_existing_payment.invoice_id is distinct from p_invoice_id
     or v_existing_payment.payment_no is distinct from p_payment_no
     or v_existing_payment.amount is distinct from round(p_amount,2)
     or v_existing_payment.payment_method is distinct from p_payment_method
     or v_existing_payment.transfer_from_account is distinct from p_transfer_from_account
     or v_existing_payment.transfer_from_type is distinct from p_transfer_from_type
     or v_existing_payment.reference_no is distinct from p_reference_no
     or v_existing_payment.receipt_image_key is distinct from p_receipt_image_key
     or v_existing_payment.receipt_image_hash is distinct from p_receipt_image_hash
     or v_existing_payment.collector_session_id is distinct from p_collector_session_id
      or round(coalesce(v_existing_payment.invoice_applied_amount,0)+coalesce(v_existing_payment.subscriber_credit_amount,0),2) is distinct from round(p_amount,2)
      or (
        coalesce(v_existing_payment.subscriber_credit_amount,0)>0
        and not exists(
          select 1 from public.subscriber_balance_ledger l
          where l.payment_id=v_existing_payment.id and l.tenant_id=p_tenant_id
            and l.site_id=p_site_id and l.subscriber_id=p_subscriber_id
            and l.balance_type='available_credit' and l.entry_type='receipt'
            and l.direction='credit' and l.amount=v_existing_payment.subscriber_credit_amount
            and l.idempotency_key='subscriber-credit:payment:'||v_existing_payment.id::text
        )
      )
     or not exists(
       select 1 from public.account_transactions t
       where t.related_payment_id=v_existing_payment.id
         and t.tenant_id=p_tenant_id and t.account_id=p_company_account_id
         and t.transaction_type='collection' and t.amount=round(p_amount,2)
         and t.reference_no is not distinct from p_reference_no
         and t.created_by_user_id=p_user_id
     ) then
    raise exception 'PAYMENT_OPERATION_SCOPE_CONFLICT' using errcode='P0001';
  end if;

  if not exists(
    select 1 from public.billing_adjustments a
    where a.tenant_id=p_tenant_id and a.site_id=p_site_id
      and a.subscriber_id=p_subscriber_id and a.invoice_id=p_invoice_id
      and a.adjustment_type='manual_collection_discount' and a.state='applied'
      and a.idempotency_key='payment:'||p_client_operation_id::text||':manual-discount'
      and a.amount=round(p_manual_discount_amount,2)
      and a.created_by_user_id=p_user_id
      and a.metadata->>'reason'=btrim(p_manual_discount_reason)
      and a.metadata->>'paymentNo'=p_payment_no
      and (a.metadata->>'cashCollected')::numeric=round(p_amount,2)
  ) then
    raise exception 'PAYMENT_OPERATION_SCOPE_CONFLICT' using errcode='P0001';
  end if;
      insert into public.offline_sync_operations(
        tenant_id,site_id,user_id,client_operation_id,operation_type,entity_type,entity_id,response,request_fingerprint
      ) values (
        p_tenant_id,p_site_id,p_user_id,p_client_operation_id::text,'payment_create','payment',
        v_existing_payment.id,jsonb_build_object('id',v_existing_payment.id),v_request_fingerprint
      );
      return query select v_existing_payment.id,true;
      return;
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtext(p_payment_no));
  if exists(select 1 from public.payments where payment_no=p_payment_no) then raise exception 'DUPLICATE_PAYMENT_NO' using errcode='P0001'; end if;
  if exists(select 1 from public.financial_settlements where tenant_id=p_tenant_id and site_id=p_site_id and status='locked' and period_start<=now() and period_end>=now()) then raise exception 'FINANCIAL_PERIOD_LOCKED' using errcode='P0001'; end if;
  if not exists(select 1 from public.subscribers where id=p_subscriber_id and tenant_id=p_tenant_id and site_id=p_site_id  ) then raise exception 'SUBSCRIBER_OUT_OF_SCOPE_OR_INACTIVE' using errcode='P0001'; end if;
  select * into v_account from public.company_accounts where id=p_company_account_id and tenant_id=p_tenant_id and is_active=true for update;
  if not found then raise exception 'COMPANY_ACCOUNT_NOT_FOUND' using errcode='P0001'; end if;
  if (p_payment_method='cash' and v_account.account_type<>'cash') or (p_payment_method<>'cash' and v_account.account_type='cash') then raise exception 'COMPANY_ACCOUNT_TYPE_MISMATCH' using errcode='P0001'; end if;
  if exists(select 1 from public.company_account_sites where account_id=v_account.id) and not exists(select 1 from public.company_account_sites where account_id=v_account.id and site_id=p_site_id and tenant_id=p_tenant_id) then raise exception 'COMPANY_ACCOUNT_OUT_OF_SCOPE' using errcode='P0001'; end if;
  if p_collector_session_id is not null and not exists(select 1 from public.collector_sessions where id=p_collector_session_id and tenant_id=p_tenant_id and site_id=p_site_id and collector_user_id=p_user_id and status='open') then raise exception 'COLLECTOR_SESSION_NOT_OPEN' using errcode='P0001'; end if;
  perform pg_advisory_xact_lock(p_invoice_id);
  select * into v_invoice from public.invoices where id=p_invoice_id and tenant_id=p_tenant_id and site_id=p_site_id and subscriber_id=p_subscriber_id for update;
  if not found then raise exception 'INVOICE_OUT_OF_SCOPE' using errcode='P0001'; end if;
  if v_invoice.status in ('draft','cancelled') then raise exception 'INVOICE_NOT_COLLECTIBLE' using errcode='P0001'; end if;
  if p_manual_discount_amount>v_invoice.balance_due then raise exception 'MANUAL_DISCOUNT_EXCEEDS_BALANCE' using errcode='P0001'; end if;
  -- A cash amount above the discounted invoice remainder is permitted: the payment RPC
  -- splits the actual cash receipt into invoice settlement and subscriber credit.
  v_new_total:=greatest(0,round(v_invoice.total_amount-p_manual_discount_amount,2));
  v_new_balance:=greatest(0,round(v_new_total-v_invoice.paid_amount-coalesce(v_invoice.credit_applied_amount,0),2));
  v_new_status:=case when v_new_balance=0 then 'paid' when v_invoice.paid_amount>0 then 'partially_paid' when v_invoice.due_date<now() then 'overdue' else 'issued' end;
  update public.invoices set total_amount=v_new_total,discount_amount=discount_amount+p_manual_discount_amount,balance_due=v_new_balance,status=v_new_status,updated_at=now() where id=v_invoice.id and tenant_id=p_tenant_id and site_id=p_site_id;
  insert into public.invoice_lines(tenant_id,invoice_id,line_type,description,quantity,unit_price,amount,display_order)
  values(p_tenant_id,v_invoice.id,'discount','خصم يدوي عند التحصيل',1,p_manual_discount_amount,p_manual_discount_amount,coalesce((select max(display_order)+1 from public.invoice_lines where invoice_id=v_invoice.id),1));
  insert into public.billing_adjustments(tenant_id,site_id,subscriber_id,invoice_id,adjustment_type,amount,state,idempotency_key,created_by_user_id,metadata)
  values(p_tenant_id,p_site_id,p_subscriber_id,v_invoice.id,'manual_collection_discount',p_manual_discount_amount,'applied','payment:'||coalesce(p_client_operation_id::text,p_payment_no)||':manual-discount',p_user_id,jsonb_build_object('reason',btrim(p_manual_discount_reason),'paymentNo',p_payment_no,'cashCollected',p_amount));
  select platform_role into v_platform_role from public.users where id=p_user_id;
  select coalesce(s.role,m.role,'member') into v_tenant_role from public.users u
  left join public.staff_profiles s on s.user_id=u.id and s.tenant_id=p_tenant_id and s.site_id=p_site_id and s.is_active
  left join public.tenant_members m on m.user_id=u.id and m.tenant_id=p_tenant_id and m.is_active and m.membership_status='active'
  where u.id=p_user_id limit 1;
  insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,actor_tenant_role,entity_type,entity_id,action,before_data,after_data,metadata)
  values(p_tenant_id,p_site_id,p_user_id,v_platform_role,v_tenant_role,'invoice',v_invoice.id::text,'manual_collection_discount',
    jsonb_build_object('totalAmount',v_invoice.total_amount,'balanceDue',v_invoice.balance_due,'discountAmount',v_invoice.discount_amount),
    jsonb_build_object('totalAmount',v_new_total,'balanceDue',v_new_balance,'discountAmount',v_invoice.discount_amount+p_manual_discount_amount),
    jsonb_build_object('reason',btrim(p_manual_discount_reason),'discountAmount',p_manual_discount_amount,'cashCollected',p_amount,'paymentNo',p_payment_no));
  select created.payment_id,created.replayed into v_payment_id,v_replayed
  from public.powerhub_create_payment(
    p_tenant_id,p_site_id,p_user_id,p_subscriber_id,p_invoice_id,p_payment_no,p_amount,p_payment_method,p_company_account_id,
    p_transfer_from_account,p_transfer_from_type,p_reference_no,p_receipt_image_key,p_receipt_image_hash,p_collector_session_id,p_client_operation_id
  ) as created;

  if p_client_operation_id is not null then
    update public.offline_sync_operations set request_fingerprint=v_request_fingerprint
    where user_id=p_user_id and client_operation_id=p_client_operation_id::text
      and operation_type='payment_create' and entity_type='payment'
      and tenant_id=p_tenant_id and site_id=p_site_id;
  end if;
  return query select v_payment_id,coalesce(v_replayed,false);
  return;
end;$function$


-- The dashboard's "collected" metric is invoice settlement, not refundable deposits,
-- deposit refunds, or the customer-credit portion of an overpayment.
CREATE OR REPLACE FUNCTION public.powerhub_dashboard_financial_overview(p_tenant_id bigint, p_site_id bigint DEFAULT NULL::bigint, p_now timestamp with time zone DEFAULT now(), p_include_details boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_now timestamptz := coalesce(p_now, now());
  v_today_start timestamptz;
  v_tomorrow_start timestamptz;
  v_month_start timestamptz;
  v_next_month_start timestamptz;
  v_trend_start timestamptz;
begin
  -- The existing UI and financial calculations use UTC day/month boundaries.
  v_today_start := date_trunc('day', v_now at time zone 'UTC') at time zone 'UTC';
  v_tomorrow_start := v_today_start + interval '1 day';
  v_month_start := date_trunc('month', v_now at time zone 'UTC') at time zone 'UTC';
  v_next_month_start := v_month_start + interval '1 month';
  v_trend_start := v_tomorrow_start - interval '31 days';

  return (
    with scope_sites as materialized (
      select s.id, s.name
      from public.sites s
      where s.tenant_id = p_tenant_id
        and s.status <> 'archived'
        and (p_site_id is null or s.id = p_site_id)
    ),
    -- Lifetime debt is needed, but settled historical invoice rows are never sent
    -- to the application. The database returns grouped debt and current-period KPIs.
    open_invoices as materialized (
      select i.id, i.site_id, i.subscriber_id, i.invoice_no, i.issue_date,
        i.due_date, i.total_amount, i.paid_amount, i.balance_due, i.status
      from public.invoices i
      join scope_sites ss on ss.id = i.site_id
      where i.tenant_id = p_tenant_id
        and i.status not in ('cancelled', 'draft')
        and i.balance_due > 0
    ),
    current_month_invoices as materialized (
      select i.id, i.site_id, i.issue_date, i.total_amount
      from public.invoices i
      join scope_sites ss on ss.id = i.site_id
      where i.tenant_id = p_tenant_id
        and i.status not in ('cancelled', 'draft')
        and i.issue_date >= v_month_start
        and i.issue_date < v_next_month_start
    ),
    invoice_stats as (
      select
        coalesce(sum(i.total_amount) filter (where i.issue_date >= v_today_start and i.issue_date < v_tomorrow_start), 0)::numeric as today_invoiced,
        coalesce(sum(i.total_amount), 0)::numeric as month_invoiced
      from current_month_invoices i
    ),
    payment_window as materialized (
      select p.site_id, p.subscriber_id, p.invoice_applied_amount as amount, p.status, p.paid_at
      from public.payments p
      join scope_sites ss on ss.id = p.site_id
      where p.tenant_id = p_tenant_id
        and p.status = 'completed'
        and p.payment_purpose in ('invoice_collection','invoice_collection_with_credit')
        and p.paid_at >= v_trend_start
        and p.paid_at < v_tomorrow_start
    ),
    payment_stats as (
      select
        coalesce(sum(p.amount) filter (where p.paid_at >= v_today_start and p.paid_at < v_tomorrow_start), 0)::numeric as today_collected,
        coalesce(sum(p.amount) filter (where p.paid_at >= v_month_start and p.paid_at < v_next_month_start), 0)::numeric as month_collected
      from payment_window p
    ),
    expense_window as materialized (
      select e.site_id, e.amount, e.occurred_at
      from public.expenses e
      join scope_sites ss on ss.id = e.site_id
      where e.tenant_id = p_tenant_id
        and e.occurred_at >= v_trend_start
        and e.occurred_at < v_tomorrow_start
    ),
    expense_stats as (
      select coalesce(sum(e.amount) filter (where e.occurred_at >= v_month_start and e.occurred_at < v_next_month_start), 0)::numeric as month_expenses
      from expense_window e
    ),
    open_invoice_totals as (
      select
        coalesce(sum(i.balance_due), 0)::numeric as total_outstanding,
        coalesce(sum(i.balance_due) filter (where i.due_date < v_now), 0)::numeric as overdue_outstanding,
        count(*) filter (where i.status = 'partially_paid')::bigint as partial_invoice_count
      from open_invoices i
    ),
    debtor_totals as (
      select i.site_id, i.subscriber_id,
        coalesce(sum(i.balance_due), 0)::numeric as outstanding,
        count(*)::bigint as invoice_count,
        count(*) filter (where i.status = 'partially_paid')::bigint as partial_invoice_count,
        min(i.due_date) as oldest_due_date,
        bool_or(i.due_date < v_now) as is_overdue
      from open_invoices i
      group by i.site_id, i.subscriber_id
    ),
    branch_rows as (
      select ss.id, ss.name,
        (select count(*)::bigint from public.subscribers s
          where s.tenant_id = p_tenant_id and s.site_id = ss.id and s.service_status = 'active' and s.archived_at is null) as active_subscribers,
        coalesce((select sum(i.total_amount) from current_month_invoices i where i.site_id = ss.id), 0)::numeric as invoiced,
        coalesce((select sum(p.amount) from payment_window p
          where p.site_id = ss.id and p.paid_at >= v_month_start and p.paid_at < v_next_month_start), 0)::numeric as collected,
        coalesce((select sum(i.balance_due) from open_invoices i where i.site_id = ss.id), 0)::numeric as outstanding,
        coalesce((select sum(i.balance_due) from open_invoices i where i.site_id = ss.id and i.due_date < v_now), 0)::numeric as overdue,
        coalesce((select count(*) from open_invoices i where i.site_id = ss.id and i.status = 'partially_paid'), 0)::bigint as partial_invoice_count
      from scope_sites ss
    ),
    debtor_rows as (
      select d.*,
        coalesce(s.full_name, 'مشترك') as subscriber_name,
        coalesce(s.subscriber_no, '—') as subscriber_no,
        ss.name as branch_name,
        oldest.id as invoice_id,
        oldest.invoice_no,
        last_payment.last_payment_at
      from debtor_totals d
      join scope_sites ss on ss.id = d.site_id
      left join public.subscribers s
        on s.id = d.subscriber_id and s.tenant_id = p_tenant_id and s.site_id = d.site_id
      left join lateral (
        select i.id, i.invoice_no
        from open_invoices i
        where i.site_id = d.site_id and i.subscriber_id = d.subscriber_id
        order by i.due_date asc, i.id asc
        limit 1
      ) oldest on true
      left join lateral (
        select max(p.paid_at) as last_payment_at
        from public.payments p
        where p.tenant_id = p_tenant_id
          and p.site_id = d.site_id
          and p.subscriber_id = d.subscriber_id
          and p.status = 'completed'
      ) last_payment on true
      order by d.is_overdue desc, d.outstanding desc, d.site_id, d.subscriber_id
      limit 10
    ),
    outstanding_invoice_rows as (
      select i.*,
        coalesce(s.full_name, 'مشترك') as subscriber_name,
        coalesce(s.subscriber_no, '—') as subscriber_no,
        (i.due_date < v_now) as is_overdue,
        case when i.due_date < v_now then greatest(1, floor(extract(epoch from (v_now - i.due_date)) / 86400)::integer) else 0 end as age_days
      from open_invoices i
      left join public.subscribers s
        on s.id = i.subscriber_id and s.tenant_id = p_tenant_id and s.site_id = i.site_id
      where p_include_details
      order by (i.due_date < v_now) desc, i.balance_due desc,
        greatest(0, floor(extract(epoch from (v_now - i.due_date)) / 86400)::integer) desc,
        i.id desc
    ),
    outstanding_invoices_json as (
      select coalesce(jsonb_agg(jsonb_build_object(
        'siteId', i.site_id,
        'subscriberId', i.subscriber_id,
        'subscriber', i.subscriber_name,
        'subscriberNo', i.subscriber_no,
        'invoiceId', i.id,
        'invoiceNo', i.invoice_no,
        'outstanding', i.balance_due,
        'dueDate', to_char(i.due_date at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'isOverdue', i.is_overdue,
        'ageDays', i.age_days,
        'partialInvoices', case when i.status = 'partially_paid' then 1 else 0 end,
        'status', i.status
      ) order by i.is_overdue desc, i.balance_due desc, i.age_days desc, i.id desc), '[]'::jsonb) as value
      from outstanding_invoice_rows i
    ),
    top_debtors_json as (
      select coalesce(jsonb_agg(jsonb_build_object(
        'siteId', d.site_id,
        'subscriberId', d.subscriber_id,
        'subscriber', d.subscriber_name,
        'subscriberNo', d.subscriber_no,
        'outstanding', d.outstanding,
        'invoiceCount', d.invoice_count,
        'partialInvoices', d.partial_invoice_count,
        'invoiceId', d.invoice_id,
        'invoiceNo', d.invoice_no,
        'oldestDueDate', to_char(d.oldest_due_date at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'isOverdue', d.is_overdue,
        'ageDays', case when d.is_overdue then greatest(1, floor(extract(epoch from (v_now - d.oldest_due_date)) / 86400)::integer) else 0 end,
        'lastPaymentAt', case when d.last_payment_at is null then null else to_char(d.last_payment_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
        'branchName', d.branch_name
      ) order by d.is_overdue desc, d.outstanding desc, d.site_id, d.subscriber_id), '[]'::jsonb) as value
      from debtor_rows d
    ),
    trend_dates as (
      select generate_series(
        ((v_trend_start at time zone 'UTC')::date)::timestamp,
        ((v_today_start at time zone 'UTC')::date)::timestamp,
        interval '1 day'
      )::date as day
    ),
    invoice_daily as (
      select (i.issue_date at time zone 'UTC')::date as day, sum(i.total_amount)::numeric as invoiced
      from public.invoices i
      join scope_sites ss on ss.id = i.site_id
      where i.tenant_id = p_tenant_id
        and i.status not in ('cancelled', 'draft')
        and i.issue_date >= v_trend_start
        and i.issue_date < v_tomorrow_start
      group by (i.issue_date at time zone 'UTC')::date
    ),
    payment_daily as (
      select (p.paid_at at time zone 'UTC')::date as day, sum(p.amount)::numeric as collected
      from payment_window p
      group by (p.paid_at at time zone 'UTC')::date
    ),
    expense_daily as (
      select (e.occurred_at at time zone 'UTC')::date as day, sum(e.amount)::numeric as expenses
      from expense_window e
      group by (e.occurred_at at time zone 'UTC')::date
    ),
    trend_json as (
      select coalesce(jsonb_agg(jsonb_build_object(
        'date', to_char(d.day, 'YYYY-MM-DD'),
        'invoiced', coalesce(i.invoiced, 0),
        'collected', coalesce(p.collected, 0),
        'expenses', coalesce(e.expenses, 0),
        'netCash', coalesce(p.collected, 0) - coalesce(e.expenses, 0)
      ) order by d.day), '[]'::jsonb) as value
      from trend_dates d
      left join invoice_daily i on i.day = d.day
      left join payment_daily p on p.day = d.day
      left join expense_daily e on e.day = d.day
    ),
    branch_json as (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', b.id,
        'name', b.name,
        'activeSubscribers', b.active_subscribers,
        'invoiced', b.invoiced,
        'collected', b.collected,
        'outstanding', b.outstanding,
        'overdue', b.overdue,
        'partialInvoices', b.partial_invoice_count,
        'collectionRate', case when b.invoiced > 0 then b.collected / b.invoiced * 100 else 0 end
      ) order by b.outstanding desc, case when b.invoiced > 0 then b.collected / b.invoiced * 100 else 0 end asc), '[]'::jsonb) as value
      from branch_rows b
    )
    select jsonb_build_object(
      'generatedAt', to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'period', jsonb_build_object(
        'today', to_char(v_today_start at time zone 'UTC', 'YYYY-MM-DD'),
        'month', to_char(v_month_start at time zone 'UTC', 'YYYY-MM')
      ),
      'today', jsonb_build_object(
        'invoiced', (select today_invoiced from invoice_stats),
        'collected', (select today_collected from payment_stats),
        'collectionRate', case when (select today_invoiced from invoice_stats) > 0
          then (select today_collected from payment_stats) / (select today_invoiced from invoice_stats) * 100 else 0 end
      ),
      'month', jsonb_build_object(
        'invoiced', (select month_invoiced from invoice_stats),
        'collected', (select month_collected from payment_stats),
        'expenses', (select month_expenses from expense_stats),
        'netCash', (select month_collected from payment_stats) - (select month_expenses from expense_stats),
        'collectionRate', case when (select month_invoiced from invoice_stats) > 0
          then (select month_collected from payment_stats) / (select month_invoiced from invoice_stats) * 100 else 0 end
      ),
      'outstanding', jsonb_build_object(
        'total', (select total_outstanding from open_invoice_totals),
        'overdue', (select overdue_outstanding from open_invoice_totals),
        'partialInvoices', (select partial_invoice_count from open_invoice_totals),
        'accountCount', (select count(*)::bigint from debtor_totals)
      ),
      'branchSummaries', (select value from branch_json),
      'topDebtors', (select value from top_debtors_json),
      'outstandingInvoices', case when p_include_details then (select value from outstanding_invoices_json) else '[]'::jsonb end,
      'trend', (select value from trend_json)
    )
  );
end;
$function$


-- The account statement keeps all financial movements in its history, while total_collected
-- measures only the amount actually applied to invoices.
CREATE OR REPLACE FUNCTION public.powerhub_subscriber_statement_summary(p_tenant_id bigint, p_site_id bigint, p_subscriber_id bigint)
 RETURNS TABLE(invoice_count bigint, payment_count bigint, reading_count bigint, total_invoiced numeric, total_collected numeric, total_outstanding numeric, total_consumption_kwh numeric, last_payment_at timestamp with time zone)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  with invoice_summary as (
    select
      count(*)::bigint as invoice_count,
      coalesce(sum(i.total_amount), 0)::numeric as total_invoiced,
      coalesce(sum(i.balance_due), 0)::numeric as total_outstanding,
      coalesce(sum(i.consumption_kwh), 0)::numeric as total_consumption_kwh
    from public.invoices i
    where i.tenant_id = p_tenant_id
      and i.site_id = p_site_id
      and i.subscriber_id = p_subscriber_id
      and i.status <> 'cancelled'
  ),
  payment_summary as (
    select
      count(*)::bigint as payment_count,
      coalesce(sum(p.invoice_applied_amount), 0)::numeric as total_collected,
      max(p.paid_at) as last_payment_at
    from public.payments p
    where p.tenant_id = p_tenant_id
      and p.site_id = p_site_id
      and p.subscriber_id = p_subscriber_id
      and p.status = 'completed'
  ),
  reading_summary as (
    select count(*)::bigint as reading_count
    from public.meter_readings r
    where r.tenant_id = p_tenant_id
      and r.subscriber_id = p_subscriber_id
  )
  select
    invoice_summary.invoice_count,
    payment_summary.payment_count,
    reading_summary.reading_count,
    invoice_summary.total_invoiced,
    payment_summary.total_collected,
    invoice_summary.total_outstanding,
    invoice_summary.total_consumption_kwh,
    payment_summary.last_payment_at
  from invoice_summary
  cross join payment_summary
  cross join reading_summary;
$function$



-- The public share link may expose invoice credit available to settle this invoice,
-- but never discloses refundable security-deposit liabilities.
CREATE OR REPLACE FUNCTION public.powerhub_get_shared_invoice_by_token_hash(p_token_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_link public.invoice_share_links%rowtype;
  v_invoice public.invoices%rowtype;
  v_subscriber record;
  v_lines jsonb;
  v_available_credit numeric(14,2) := 0;
begin
  if length(p_token_hash)<32 then
    raise exception 'SHARE_LINK_NOT_FOUND' using errcode='P0001';
  end if;
  perform pg_advisory_xact_lock(hashtext(p_token_hash));
  select * into v_link from public.invoice_share_links where token_hash=p_token_hash for update;
  if not found or v_link.revoked_at is not null or (v_link.expires_at is not null and v_link.expires_at<=now()) then
    raise exception 'SHARE_LINK_NOT_FOUND' using errcode='P0001';
  end if;
  select * into v_invoice from public.invoices
  where id=v_link.invoice_id and tenant_id=v_link.tenant_id;
  if not found then
    raise exception 'SHARE_LINK_NOT_FOUND' using errcode='P0001';
  end if;
  select full_name,subscriber_no into v_subscriber
  from public.subscribers
  where id=v_invoice.subscriber_id and tenant_id=v_link.tenant_id;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',line.id,'lineType',line.line_type,'description',line.description,'amount',line.amount,
    'quantity',line.quantity,'unitPrice',line.unit_price,'displayOrder',line.display_order
  ) order by line.display_order),'[]'::jsonb)
  into v_lines
  from public.invoice_lines line
  where line.invoice_id=v_invoice.id and line.tenant_id=v_link.tenant_id;
  select coalesce(sum(case when l.direction='credit' then l.amount else -l.amount end),0)
  into v_available_credit
  from public.subscriber_balance_ledger l
  where l.tenant_id=v_link.tenant_id and l.site_id=v_invoice.site_id
    and l.subscriber_id=v_invoice.subscriber_id and l.balance_type='available_credit';
  update public.invoice_share_links
  set view_count=view_count+1,last_viewed_at=now()
  where id=v_link.id;
  return jsonb_build_object(
    'siteId',v_invoice.site_id,
    'tenantId',v_link.tenant_id,
    'invoice',jsonb_build_object(
      'id',v_invoice.id,'subscriberId',v_invoice.subscriber_id,'invoiceNo',v_invoice.invoice_no,
      'billingPeriod',v_invoice.billing_period,'issueDate',v_invoice.issue_date,'dueDate',v_invoice.due_date,
      'previousReading',v_invoice.previous_reading,'currentReading',v_invoice.current_reading,
      'consumptionKwh',v_invoice.consumption_kwh,'pricePerKwh',v_invoice.price_per_kwh,
      'fixedFee',v_invoice.fixed_fee,'taxAmount',v_invoice.tax_amount,'discountAmount',v_invoice.discount_amount,
      'totalAmount',v_invoice.total_amount,'paidAmount',v_invoice.paid_amount,'creditAppliedAmount',coalesce(v_invoice.credit_applied_amount,0),'balanceDue',v_invoice.balance_due,'status',v_invoice.status
    ),
    'subscriber',case when v_subscriber is null then null else jsonb_build_object('fullName',v_subscriber.full_name,'subscriberNo',v_subscriber.subscriber_no) end,
    'lines',v_lines,
    'subscriberBalance',jsonb_build_object('availableCredit',v_available_credit)
  );
end;
$function$

-- Disconnection is a financial close-out action, not a normal profile edit.
-- This database guard prevents direct update RPCs or legacy paths from bypassing settlement.
create or replace function public.powerhub_guard_subscriber_disconnection_financial_closeout()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
declare
  v_outstanding numeric(14,2);
  v_security_deposit numeric(14,2);
begin
  if new.service_status='disconnected' and old.service_status is distinct from 'disconnected' then
    select coalesce(sum(i.balance_due),0)::numeric(14,2)
      into v_outstanding
    from public.invoices i
    where i.tenant_id=new.tenant_id and i.site_id=new.site_id and i.subscriber_id=new.id
      and i.balance_due>0 and i.status not in ('draft','cancelled','paid');
    if v_outstanding>0 then
      raise exception 'SUBSCRIBER_HAS_OUTSTANDING_INVOICES'
        using errcode='P0001', detail='Remaining invoice balance: '||v_outstanding::text;
    end if;

    select coalesce(sum(case when l.direction='credit' then l.amount else -l.amount end),0)::numeric(14,2)
      into v_security_deposit
    from public.subscriber_balance_ledger l
    where l.tenant_id=new.tenant_id and l.site_id=new.site_id and l.subscriber_id=new.id
      and l.balance_type='security_deposit';
    if v_security_deposit>0 then
      raise exception 'SUBSCRIBER_SECURITY_DEPOSIT_NOT_SETTLED'
        using errcode='P0001', detail='Remaining security deposit: '||v_security_deposit::text;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists powerhub_guard_subscriber_disconnection_financial_closeout on public.subscribers;
create trigger powerhub_guard_subscriber_disconnection_financial_closeout
before update of service_status on public.subscribers
for each row
execute function public.powerhub_guard_subscriber_disconnection_financial_closeout();
revoke all on function public.powerhub_guard_subscriber_disconnection_financial_closeout() from public,anon,authenticated;

