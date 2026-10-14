-- Atomic manual collection discount and date-filtered realized discount metrics.
-- The discount changes the invoice debt, never the amount of money recorded as collected.
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
  if p_client_operation_id is not null then
    perform pg_advisory_xact_lock(hashtext('payment-create:' || p_user_id::text || ':' || p_client_operation_id::text));
    select op.response into v_response from public.offline_sync_operations op
    where op.user_id=p_user_id and op.client_operation_id=p_client_operation_id::text limit 1;
    if found then
      if not exists(select 1 from public.offline_sync_operations op where op.user_id=p_user_id and op.client_operation_id=p_client_operation_id::text and op.tenant_id=p_tenant_id and op.site_id=p_site_id and op.operation_type='payment_create' and op.entity_type='payment') then raise exception 'PAYMENT_OPERATION_SCOPE_CONFLICT' using errcode='P0001'; end if;
      if coalesce(v_response->>'id','')='' then raise exception 'INVALID_PAYMENT_OPERATION_REPLAY' using errcode='P0001'; end if;
      return query select (v_response->>'id')::bigint,true; return;
    end if;
    select p.id into v_payment_id from public.payments p where p.client_operation_id=p_client_operation_id::text and p.tenant_id=p_tenant_id and p.site_id=p_site_id limit 1;
    if found then
      if not exists(select 1 from public.payments p where p.id=v_payment_id and p.subscriber_id=p_subscriber_id and p.invoice_id is not distinct from p_invoice_id) then raise exception 'PAYMENT_OPERATION_SCOPE_CONFLICT' using errcode='P0001'; end if;
      return query select v_payment_id,true; return;
    end if;
  end if;
  perform pg_advisory_xact_lock(hashtext(p_payment_no));
  if exists(select 1 from public.payments where payment_no=p_payment_no) then raise exception 'DUPLICATE_PAYMENT_NO' using errcode='P0001'; end if;
  if exists(select 1 from public.financial_settlements where tenant_id=p_tenant_id and site_id=p_site_id and status='locked' and period_start<=now() and period_end>=now()) then raise exception 'FINANCIAL_PERIOD_LOCKED' using errcode='P0001'; end if;
  if not exists(select 1 from public.subscribers where id=p_subscriber_id and tenant_id=p_tenant_id and site_id=p_site_id  ) then raise exception 'SUBSCRIBER_OUT_OF_SCOPE_OR_INACTIVE' using errcode='P0001'; end if;
  select * into v_account from public.company_accounts where id=p_company_account_id and tenant_id=p_tenant_id and is_active=true for update;
  if not found then raise exception 'COMPANY_ACCOUNT_NOT_FOUND' using errcode='P0001'; end if;
  if v_account.account_type<>p_payment_method then raise exception 'COMPANY_ACCOUNT_TYPE_MISMATCH' using errcode='P0001'; end if;
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
  return query select created.payment_id,created.replayed from public.powerhub_create_payment(
    p_tenant_id,p_site_id,p_user_id,p_subscriber_id,p_invoice_id,p_payment_no,p_amount,p_payment_method,p_company_account_id,
    p_transfer_from_account,p_transfer_from_type,p_reference_no,p_receipt_image_key,p_receipt_image_hash,p_collector_session_id,p_client_operation_id
  ) as created;
end;$$;
revoke execute on function public.powerhub_create_payment_with_discount(bigint,bigint,bigint,bigint,bigint,text,numeric,text,bigint,text,text,text,text,text,bigint,uuid,numeric,text) from public,anon,authenticated;
grant execute on function public.powerhub_create_payment_with_discount(bigint,bigint,bigint,bigint,bigint,text,numeric,text,bigint,text,text,text,text,text,bigint,uuid,numeric,text) to service_role;

create or replace function public.powerhub_billing_discount_summary(
  p_tenant_id bigint,p_site_id bigint,p_from timestamptz default null,p_to timestamptz default null
)
returns table(automatic_discount_total numeric,manual_discount_total numeric,total_discount numeric,automatic_discount_count bigint,manual_discount_count bigint)
language plpgsql security invoker set search_path=public,pg_temp as $$
begin
  if p_from is not null and p_to is not null and p_from>p_to then raise exception 'INVALID_DATE_RANGE' using errcode='P0001'; end if;
  if not exists(select 1 from public.sites where id=p_site_id and tenant_id=p_tenant_id) then raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001'; end if;
  return query select
    coalesce(sum(a.amount) filter (where a.adjustment_type='auto_fraction_discount'),0)::numeric,
    coalesce(sum(a.amount) filter (where a.adjustment_type='manual_collection_discount'),0)::numeric,
    coalesce(sum(a.amount) filter (where a.adjustment_type in ('auto_fraction_discount','manual_collection_discount')),0)::numeric,
    count(*) filter (where a.adjustment_type='auto_fraction_discount'),
    count(*) filter (where a.adjustment_type='manual_collection_discount')
  from public.billing_adjustments a where a.tenant_id=p_tenant_id and a.site_id=p_site_id and a.state='applied'
    and a.adjustment_type in ('auto_fraction_discount','manual_collection_discount')
    and (p_from is null or a.created_at>=p_from) and (p_to is null or a.created_at<=p_to);
end;$$;
revoke execute on function public.powerhub_billing_discount_summary(bigint,bigint,timestamptz,timestamptz) from public,anon,authenticated;
grant execute on function public.powerhub_billing_discount_summary(bigint,bigint,timestamptz,timestamptz) to service_role;
