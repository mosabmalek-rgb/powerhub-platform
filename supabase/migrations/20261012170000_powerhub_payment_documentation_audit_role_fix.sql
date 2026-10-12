-- Keep audit role columns semantically correct for tenant-scoped payment operations.
-- Tenant roles (owner/accountant/etc.) must never be written to actor_platform_role.
-- Platform role values remain constrained by audit_logs_actor_platform_role_check.

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
begin
  if p_amount <= 0 then raise exception 'INVALID_PAYMENT_AMOUNT' using errcode = 'P0001'; end if;
  if p_payment_method not in ('cash', 'jawwal_pay', 'palpay', 'bank_of_palestine', 'wallet', 'bank_transfer', 'card') then raise exception 'INVALID_PAYMENT_METHOD' using errcode = 'P0001'; end if;
  if (p_transfer_from_account is null) <> (p_transfer_from_type is null) then raise exception 'INVALID_TRANSFER_SOURCE' using errcode = 'P0001'; end if;
  if p_client_operation_id is not null then
    perform pg_advisory_xact_lock(hashtext('payment-create:' || p_user_id::text || ':' || p_client_operation_id::text));
    select response into v_response from public.offline_sync_operations
    where user_id = p_user_id and client_operation_id = p_client_operation_id::text limit 1;
    if found then
      if not exists(select 1 from public.offline_sync_operations op where op.user_id=p_user_id and op.client_operation_id=p_client_operation_id::text and op.tenant_id=p_tenant_id and op.site_id=p_site_id and op.operation_type='payment_create') then raise exception 'PAYMENT_OPERATION_SCOPE_CONFLICT' using errcode='P0001'; end if;
      if coalesce(v_response->>'id','') = '' then raise exception 'INVALID_PAYMENT_OPERATION_REPLAY' using errcode='P0001'; end if;
      return query select (v_response->>'id')::bigint, true; return;
    end if;
    select id into v_payment_id from public.payments where client_operation_id=p_client_operation_id::text and tenant_id=p_tenant_id and site_id=p_site_id limit 1;
    if found then return query select v_payment_id,true; return; end if;
  end if;

  perform pg_advisory_xact_lock(hashtext(p_payment_no));
  if exists(select 1 from public.payments where payment_no=p_payment_no) then raise exception 'DUPLICATE_PAYMENT_NO' using errcode='P0001'; end if;
  if exists(select 1 from public.financial_settlements where tenant_id=p_tenant_id and site_id=p_site_id and status='locked' and period_start<=now() and period_end>=now()) then raise exception 'FINANCIAL_PERIOD_LOCKED' using errcode='P0001'; end if;
  if not exists(select 1 from public.subscribers where id=p_subscriber_id and tenant_id=p_tenant_id and site_id=p_site_id and service_status='active' and archived_at is null) then raise exception 'SUBSCRIBER_OUT_OF_SCOPE_OR_INACTIVE' using errcode='P0001'; end if;
  select * into v_account from public.company_accounts where id=p_company_account_id and tenant_id=p_tenant_id and is_active=true for update;
  if not found then raise exception 'COMPANY_ACCOUNT_NOT_FOUND' using errcode='P0001'; end if;
  if v_account.account_type<>p_payment_method then raise exception 'COMPANY_ACCOUNT_TYPE_MISMATCH' using errcode='P0001'; end if;
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
    insert into public.offline_sync_operations(tenant_id,site_id,user_id,client_operation_id,operation_type,entity_type,entity_id,response)
    values(p_tenant_id,p_site_id,p_user_id,p_client_operation_id::text,'payment_create','payment',v_payment_id,jsonb_build_object('id',v_payment_id));
  end if;
  return query select v_payment_id,false;
end;
$$;

create or replace function public.powerhub_approve_payment_documentation(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_request_id bigint
) returns table(payment_id bigint,replayed boolean)
language plpgsql
set search_path to 'public','pg_temp'
as $function$
declare
  v_request public.payment_documentation_requests%rowtype;
  v_payment_id bigint;
  v_replayed boolean;
  v_payment_no text;
  v_platform_role text;
  v_tenant_role text;
  v_retention_until timestamptz;
begin
  perform pg_advisory_xact_lock(hashtextextended('payment-documentation-request:'||p_request_id::text,0));
  select * into v_request from public.payment_documentation_requests
  where id=p_request_id and tenant_id=p_tenant_id and site_id=p_site_id for update;
  if not found then raise exception 'PAYMENT_DOCUMENTATION_NOT_FOUND' using errcode='P0001'; end if;
  if v_request.status='approved' and v_request.payment_id is not null then return query select v_request.payment_id,true; return; end if;
  if v_request.status='rejected' then raise exception 'PAYMENT_DOCUMENTATION_REJECTED' using errcode='P0001'; end if;
  if v_request.status<>'pending' then raise exception 'PAYMENT_DOCUMENTATION_INVALID_STATE' using errcode='P0001'; end if;

  v_payment_no:=format('PH-EDOC-%s-%s',to_char(clock_timestamp(),'YYYYMMDDHH24MISSMS'),v_request.id);
  select payment_id,replayed into v_payment_id,v_replayed
  from public.powerhub_create_payment(p_tenant_id,p_site_id,p_user_id,v_request.subscriber_id,v_request.invoice_id,
    v_payment_no,v_request.payment_amount,v_request.payment_method,v_request.destination_account_id,v_request.sender_phone,
    case when v_request.payment_method<>'cash' then v_request.payment_method else null end,
    v_request.reference_no,v_request.receipt_image_key,v_request.receipt_image_hash,null,gen_random_uuid());

  v_retention_until:=now()+interval '2 months';
  update public.payment_documentation_requests set status='approved',reviewed_by_user_id=p_user_id,reviewed_at=now(),
    payment_id=v_payment_id,receipt_image_retention_until=v_retention_until,updated_at=now()
  where id=v_request.id and status='pending';
  if not found then raise exception 'PAYMENT_DOCUMENTATION_STATE_RACE' using errcode='P0001'; end if;

  select u.platform_role,m.role into v_platform_role,v_tenant_role
  from public.users u left join public.tenant_members m on m.user_id=u.id and m.tenant_id=p_tenant_id
  where u.id=p_user_id;
  if v_platform_role not in ('platform_owner','platform_admin','finance_admin') then v_platform_role:=null; end if;
  insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,actor_tenant_role,entity_type,entity_id,action,after_data)
  values(p_tenant_id,p_site_id,p_user_id,v_platform_role,v_tenant_role,'payment_documentation_request',v_request.id::text,'approve',
    jsonb_build_object('paymentId',v_payment_id,'paymentNo',v_payment_no,'receiptRetentionUntil',v_retention_until));
  return query select v_payment_id,coalesce(v_replayed,false);
end;
$function$;

create or replace function public.powerhub_reject_payment_documentation(
  p_tenant_id bigint,p_site_id bigint,p_user_id bigint,p_request_id bigint,p_rejection_reason text
) returns table(request_id bigint)
language plpgsql
set search_path to 'public','pg_temp'
as $function$
declare v_request public.payment_documentation_requests%rowtype; v_platform_role text; v_tenant_role text;
begin
  if nullif(btrim(p_rejection_reason),'') is null then raise exception 'REJECTION_REASON_REQUIRED' using errcode='P0001'; end if;
  perform pg_advisory_xact_lock(hashtextextended('payment-documentation-request:'||p_request_id::text,0));
  select * into v_request from public.payment_documentation_requests where id=p_request_id and tenant_id=p_tenant_id and site_id=p_site_id for update;
  if not found then raise exception 'PAYMENT_DOCUMENTATION_NOT_FOUND' using errcode='P0001'; end if;
  if v_request.status='approved' then raise exception 'PAYMENT_DOCUMENTATION_ALREADY_APPROVED' using errcode='P0001'; end if;
  if v_request.status='rejected' then return query select v_request.id; return; end if;
  update public.payment_documentation_requests set status='rejected',rejection_reason=btrim(p_rejection_reason),
    reviewed_by_user_id=p_user_id,reviewed_at=now(),updated_at=now() where id=v_request.id;
  select u.platform_role,m.role into v_platform_role,v_tenant_role from public.users u
  left join public.tenant_members m on m.user_id=u.id and m.tenant_id=p_tenant_id where u.id=p_user_id;
  if v_platform_role not in ('platform_owner','platform_admin','finance_admin') then v_platform_role:=null; end if;
  insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,actor_tenant_role,entity_type,entity_id,action,after_data)
  values(p_tenant_id,p_site_id,p_user_id,v_platform_role,v_tenant_role,'payment_documentation_request',v_request.id::text,'reject',
    jsonb_build_object('reason',btrim(p_rejection_reason)));
  return query select v_request.id;
end;
$function$;

revoke execute on function public.powerhub_create_payment(bigint,bigint,bigint,bigint,bigint,text,numeric,text,bigint,text,text,text,text,text,bigint,uuid) from public,anon,authenticated;
grant execute on function public.powerhub_create_payment(bigint,bigint,bigint,bigint,bigint,text,numeric,text,bigint,text,text,text,text,text,bigint,uuid) to service_role;
