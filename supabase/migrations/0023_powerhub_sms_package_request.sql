create or replace function public.powerhub_request_sms_package(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_requested_messages integer,
  p_note text
)
returns table (request_id bigint, request_status text)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_request_id bigint;
  v_platform_role text;
begin
  if p_requested_messages is null or p_requested_messages < 1 or p_requested_messages > 100000000 then
    raise exception 'INVALID_SMS_PACKAGE_QUANTITY' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(p_tenant_id);

  if not exists (select 1 from public.sites where id = p_site_id and tenant_id = p_tenant_id and status = 'active') then
    raise exception 'SITE_OUT_OF_SCOPE' using errcode = 'P0001';
  end if;

  if exists (
    select 1 from public.sms_package_requests
    where tenant_id = p_tenant_id and status = 'pending'
    for update
  ) then
    raise exception 'SMS_PACKAGE_REQUEST_PENDING' using errcode = 'P0001';
  end if;

  insert into public.sms_package_requests (
    tenant_id, requested_by_user_id, requested_messages, note
  ) values (
    p_tenant_id, p_user_id, p_requested_messages, nullif(trim(coalesce(p_note, '')), '')
  ) returning id into v_request_id;

  select platform_role into v_platform_role from public.users where id = p_user_id;
  insert into public.audit_logs (
    tenant_id, site_id, user_id, actor_platform_role, entity_type, entity_id, action, after_data, metadata
  ) values (
    p_tenant_id, p_site_id, p_user_id, v_platform_role, 'sms_package_request', v_request_id::text, 'request_sms_package',
    jsonb_build_object('requestedMessages', p_requested_messages, 'status', 'pending'),
    jsonb_build_object('noteProvided', nullif(trim(coalesce(p_note, '')), '') is not null)
  );

  return query select v_request_id, 'pending'::text;
end;
$$;

revoke execute on function public.powerhub_request_sms_package(bigint, bigint, bigint, integer, text) from public, anon, authenticated;
grant execute on function public.powerhub_request_sms_package(bigint, bigint, bigint, integer, text) to service_role;
