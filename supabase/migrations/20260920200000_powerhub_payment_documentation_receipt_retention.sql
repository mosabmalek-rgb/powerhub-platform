-- Payment documentation receipt-image retention policy:
-- rejected requests: delete immediately;
-- approved requests: retain for two months after approval, then delete.

alter table public.payment_documentation_requests
  add column if not exists receipt_image_retention_until timestamptz null,
  add column if not exists receipt_image_deleted_at timestamptz null;

create index if not exists payment_documentation_requests_receipt_retention_idx
  on public.payment_documentation_requests(receipt_image_retention_until)
  where receipt_image_retention_until is not null
    and receipt_image_key is not null;

create or replace function public.powerhub_approve_payment_documentation(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_request_id bigint
) returns table(payment_id bigint, replayed boolean)
language plpgsql
set search_path to 'public','pg_temp'
as $function$
declare
  v_request public.payment_documentation_requests%rowtype;
  v_payment_id bigint;
  v_replayed boolean;
  v_payment_no text;
  v_platform_role text;
  v_retention_until timestamptz;
begin
  perform pg_advisory_xact_lock(hashtextextended('payment-documentation-request:'||p_request_id::text,0));
  select * into v_request from public.payment_documentation_requests
  where id=p_request_id and tenant_id=p_tenant_id and site_id=p_site_id for update;
  if not found then raise exception 'PAYMENT_DOCUMENTATION_NOT_FOUND' using errcode='P0001'; end if;
  if v_request.status='approved' and v_request.payment_id is not null then return query select v_request.payment_id, true; return; end if;
  if v_request.status='rejected' then raise exception 'PAYMENT_DOCUMENTATION_REJECTED' using errcode='P0001'; end if;
  if v_request.status<>'pending' then raise exception 'PAYMENT_DOCUMENTATION_INVALID_STATE' using errcode='P0001'; end if;

  v_payment_no := format('PH-EDOC-%s-%s', to_char(clock_timestamp(),'YYYYMMDDHH24MISSMS'), v_request.id);
  select payment_id, replayed into v_payment_id, v_replayed
  from public.powerhub_create_payment(
    p_tenant_id, p_site_id, p_user_id, v_request.subscriber_id, v_request.invoice_id,
    v_payment_no, v_request.payment_amount, v_request.payment_method, v_request.destination_account_id,
    v_request.sender_phone,
    case when v_request.payment_method <> 'cash' then v_request.payment_method else null end,
    v_request.reference_no, v_request.receipt_image_key, v_request.receipt_image_hash,
    null, gen_random_uuid()
  );

  v_retention_until := now() + interval '2 months';
  update public.payment_documentation_requests
  set status='approved', reviewed_by_user_id=p_user_id, reviewed_at=now(),
      payment_id=v_payment_id, receipt_image_retention_until=v_retention_until, updated_at=now()
  where id=v_request.id and status='pending';
  if not found then raise exception 'PAYMENT_DOCUMENTATION_STATE_RACE' using errcode='P0001'; end if;

  select platform_role into v_platform_role from public.users where id=p_user_id;
  insert into public.audit_logs(tenant_id, site_id, user_id, actor_platform_role, entity_type, entity_id, action, after_data)
  values (p_tenant_id, p_site_id, p_user_id, v_platform_role, 'payment_documentation_request', v_request.id::text, 'approve',
    jsonb_build_object('paymentId', v_payment_id, 'paymentNo', v_payment_no, 'receiptRetentionUntil', v_retention_until));

  return query select v_payment_id, coalesce(v_replayed,false);
end;
$function$;

create or replace function public.powerhub_reject_payment_documentation(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_request_id bigint,
  p_rejection_reason text
) returns table(request_id bigint)
language plpgsql
set search_path to 'public','pg_temp'
as $function$
declare
  v_request public.payment_documentation_requests%rowtype;
  v_platform_role text;
begin
  if nullif(btrim(p_rejection_reason),'') is null then raise exception 'REJECTION_REASON_REQUIRED' using errcode='P0001'; end if;
  perform pg_advisory_xact_lock(hashtextextended('payment-documentation-request:'||p_request_id::text,0));
  select * into v_request from public.payment_documentation_requests
  where id=p_request_id and tenant_id=p_tenant_id and site_id=p_site_id for update;
  if not found then raise exception 'PAYMENT_DOCUMENTATION_NOT_FOUND' using errcode='P0001'; end if;
  if v_request.status='approved' then raise exception 'PAYMENT_DOCUMENTATION_ALREADY_APPROVED' using errcode='P0001'; end if;
  if v_request.status='rejected' then return query select v_request.id; return; end if;
  update public.payment_documentation_requests
  set status='rejected', rejection_reason=btrim(p_rejection_reason),
      reviewed_by_user_id=p_user_id, reviewed_at=now(), updated_at=now()
  where id=v_request.id;
  select platform_role into v_platform_role from public.users where id=p_user_id;
  insert into public.audit_logs(tenant_id, site_id, user_id, actor_platform_role, entity_type, entity_id, action, after_data)
  values (p_tenant_id, p_site_id, p_user_id, v_platform_role, 'payment_documentation_request', v_request.id::text, 'reject',
    jsonb_build_object('reason', btrim(p_rejection_reason)));
  return query select v_request.id;
end;
$function$;