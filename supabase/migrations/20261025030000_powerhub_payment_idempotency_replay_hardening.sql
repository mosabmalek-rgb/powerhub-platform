-- Forward-only hardening for payment idempotency across retries, payload collisions and tenant/user boundaries.
-- The RPCs retain their existing signatures; the request fingerprint is server-derived.
ALTER TABLE public.offline_sync_operations ADD COLUMN IF NOT EXISTS request_fingerprint text;

create or replace function public.powerhub_create_payment(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_subscriber_id bigint,
  p_invoice_id bigint,
  p_payment_no text,
  p_amount numeric,
  p_payment_method text,
  p_company_account_id bigint,
  p_transfer_from_account text,
  p_transfer_from_type text,
  p_reference_no text,
  p_receipt_image_key text,
  p_receipt_image_hash text,
  p_collector_session_id bigint,
  p_client_operation_id uuid
)
returns table(payment_id bigint, replayed boolean)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
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
begin
  if p_amount <= 0 then raise exception 'INVALID_PAYMENT_AMOUNT' using errcode = 'P0001'; end if;
  if p_payment_method not in ('cash', 'jawwal_pay', 'palpay', 'bank_of_palestine', 'wallet', 'bank_transfer', 'card') then raise exception 'INVALID_PAYMENT_METHOD' using errcode = 'P0001'; end if;
  if (p_transfer_from_account is null) <> (p_transfer_from_type is null) then raise exception 'INVALID_TRANSFER_SOURCE' using errcode = 'P0001'; end if;
  v_request_fingerprint := md5(jsonb_build_object(
      'tenantId',p_tenant_id,'siteId',p_site_id,'userId',p_user_id,
      'subscriberId',p_subscriber_id,'invoiceId',p_invoice_id,'paymentNo',p_payment_no,
      'amount',round(p_amount,2),'paymentMethod',p_payment_method,'companyAccountId',p_company_account_id,
      'transferFromAccount',p_transfer_from_account,'transferFromType',p_transfer_from_type,
      'referenceNo',p_reference_no,'receiptImageHash',p_receipt_image_hash,
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
     or v_existing_payment.receipt_image_hash is distinct from p_receipt_image_hash
     or v_existing_payment.collector_session_id is distinct from p_collector_session_id
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
     or v_existing_payment.receipt_image_hash is distinct from p_receipt_image_hash
     or v_existing_payment.collector_session_id is distinct from p_collector_session_id
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
  if not exists(select 1 from public.subscribers where id=p_subscriber_id and tenant_id=p_tenant_id and site_id=p_site_id and service_status='active' and archived_at is null) then raise exception 'SUBSCRIBER_OUT_OF_SCOPE_OR_INACTIVE' using errcode='P0001'; end if;
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
    if p_amount>v_invoice.balance_due then raise exception 'INVOICE_BALANCE_CONFLICT' using errcode='P0001'; end if;
    v_new_paid:=v_invoice.paid_amount+p_amount;
    v_new_balance:=greatest(0,v_invoice.total_amount-v_new_paid);
    v_invoice_status:=case when v_new_balance=0 then 'paid' else 'partially_paid' end;
    update public.invoices set paid_amount=v_new_paid,balance_due=v_new_balance,status=v_invoice_status,updated_at=now() where id=v_invoice.id;
  end if;

  insert into public.payments(tenant_id,site_id,subscriber_id,invoice_id,payment_no,client_operation_id,amount,payment_method,transfer_from_account,transfer_from_type,transfer_to_account,transfer_to_type,reference_no,receipt_image_key,receipt_image_hash,collected_by_user_id,collector_session_id)
  values(p_tenant_id,p_site_id,p_subscriber_id,p_invoice_id,p_payment_no,p_client_operation_id::text,p_amount,p_payment_method,p_transfer_from_account,p_transfer_from_type,v_account.phone_number,case when v_account.account_type in('jawwal_pay','palpay','bank_of_palestine') then v_account.account_type else null end,p_reference_no,p_receipt_image_key,p_receipt_image_hash,p_user_id,p_collector_session_id)
  returning id into v_payment_id;
  insert into public.account_transactions(tenant_id,account_id,transaction_type,amount,description,reference_no,related_payment_id,created_by_user_id)
  values(p_tenant_id,v_account.id,'collection',p_amount,format('تحصيل الفاتورة %s',p_payment_no),p_reference_no,v_payment_id,p_user_id);

  select u.platform_role, m.role into v_platform_role, v_tenant_role
  from public.users u
  left join public.tenant_members m on m.user_id=u.id and m.tenant_id=p_tenant_id
  where u.id=p_user_id;
  if v_platform_role not in ('platform_owner','platform_admin','finance_admin') then v_platform_role:=null; end if;
  insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,actor_tenant_role,entity_type,entity_id,action,after_data,metadata)
  values(p_tenant_id,p_site_id,p_user_id,v_platform_role,v_tenant_role,'payment',v_payment_id::text,'create',
    jsonb_build_object('paymentNo',p_payment_no,'amount',p_amount,'invoiceId',p_invoice_id,'companyAccountId',v_account.id,'paymentMethod',p_payment_method),
    jsonb_build_object('collectorSessionId',p_collector_session_id,'receiptImageAttached',p_receipt_image_key is not null));
  if p_client_operation_id is not null then
    insert into public.offline_sync_operations(tenant_id,site_id,user_id,client_operation_id,operation_type,entity_type,entity_id,response,request_fingerprint)
    values(p_tenant_id,p_site_id,p_user_id,p_client_operation_id::text,'payment_create','payment',v_payment_id,jsonb_build_object('id',v_payment_id),v_request_fingerprint);
  end if;
  return query select v_payment_id,false;
end;
$$;

create or replace function public.powerhub_create_payment_with_discount(
  p_tenant_id bigint,p_site_id bigint,p_user_id bigint,p_subscriber_id bigint,p_invoice_id bigint,
  p_payment_no text,p_amount numeric,p_payment_method text,p_company_account_id bigint,
  p_transfer_from_account text,p_transfer_from_type text,p_reference_no text,
  p_receipt_image_key text,p_receipt_image_hash text,p_collector_session_id bigint,
  p_client_operation_id uuid,p_manual_discount_amount numeric,p_manual_discount_reason text
)
returns table(payment_id bigint,replayed boolean)
language plpgsql security invoker set search_path=public,pg_temp as $$
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
    'referenceNo',p_reference_no,'receiptImageHash',p_receipt_image_hash,
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
     or v_existing_payment.receipt_image_hash is distinct from p_receipt_image_hash
     or v_existing_payment.collector_session_id is distinct from p_collector_session_id
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
     or v_existing_payment.receipt_image_hash is distinct from p_receipt_image_hash
     or v_existing_payment.collector_session_id is distinct from p_collector_session_id
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
  if p_amount>round(v_invoice.balance_due-p_manual_discount_amount,2) then raise exception 'PAYMENT_AND_DISCOUNT_EXCEED_BALANCE' using errcode='P0001'; end if;
  v_new_total:=greatest(0,round(v_invoice.total_amount-p_manual_discount_amount,2));
  v_new_balance:=greatest(0,round(v_new_total-v_invoice.paid_amount,2));
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
end;$;

REVOKE EXECUTE ON FUNCTION public.powerhub_create_payment(bigint,bigint,bigint,bigint,bigint,text,numeric,text,bigint,text,text,text,text,text,bigint,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_create_payment(bigint,bigint,bigint,bigint,bigint,text,numeric,text,bigint,text,text,text,text,text,bigint,uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.powerhub_create_payment_with_discount(bigint,bigint,bigint,bigint,bigint,text,numeric,text,bigint,text,text,text,text,text,bigint,uuid,numeric,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_create_payment_with_discount(bigint,bigint,bigint,bigint,bigint,text,numeric,text,bigint,text,text,text,text,text,bigint,uuid,numeric,text) TO service_role;
