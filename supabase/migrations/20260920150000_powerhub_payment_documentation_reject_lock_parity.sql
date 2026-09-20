-- Keep payment-documentation state transitions serialized.
-- Approve and Reject must use the same advisory lock key.

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
  if nullif(btrim(p_rejection_reason),'') is null then
    raise exception 'REJECTION_REASON_REQUIRED' using errcode='P0001';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('payment-documentation-request:'||p_request_id::text,0)
  );

  select * into v_request
  from public.payment_documentation_requests
  where id=p_request_id and tenant_id=p_tenant_id and site_id=p_site_id
  for update;

  if not found then raise exception 'PAYMENT_DOCUMENTATION_NOT_FOUND' using errcode='P0001'; end if;
  if v_request.status='approved' then raise exception 'PAYMENT_DOCUMENTATION_ALREADY_APPROVED' using errcode='P0001'; end if;
  if v_request.status='rejected' then return query select v_request.id; return; end if;

  update public.payment_documentation_requests
  set status='rejected',
      rejection_reason=btrim(p_rejection_reason),
      reviewed_by_user_id=p_user_id,
      reviewed_at=now(),
      updated_at=now()
  where id=v_request.id;

  select platform_role into v_platform_role from public.users where id=p_user_id;

  insert into public.audit_logs(
    tenant_id, site_id, user_id, actor_platform_role, entity_type, entity_id, action,
    after_data
  ) values (
    p_tenant_id, p_site_id, p_user_id, v_platform_role,
    'payment_documentation_request', v_request.id::text, 'reject',
    jsonb_build_object('reason', btrim(p_rejection_reason))
  );

  return query select v_request.id;
end;
$function$;