-- يحمي تعديل المشترك من الكتابة المتزامنة ويحفظ إعادة التشغيل غير المتصل في معاملة واحدة.
create or replace function public.powerhub_update_subscriber(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_subscriber_id bigint,
  p_full_name text,
  p_phone text,
  p_address text,
  p_subscription_type text,
  p_service_status text,
  p_expected_updated_at timestamptz,
  p_client_operation_id uuid
)
returns table (updated_at timestamptz, replayed boolean)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_existing public.subscribers%rowtype;
  v_updated_at timestamptz;
  v_response jsonb;
  v_platform_role text;
begin
  if p_client_operation_id is not null then
    perform pg_advisory_xact_lock(hashtext('subscriber-update:' || p_user_id::text || ':' || p_client_operation_id::text));
    select response into v_response
    from public.offline_sync_operations
    where user_id = p_user_id and client_operation_id = p_client_operation_id::text
    limit 1;
    if found then
      if coalesce(v_response->>'updatedAt', '') = '' then
        raise exception 'INVALID_SUBSCRIBER_OPERATION_REPLAY' using errcode = 'P0001';
      end if;
      return query select (v_response->>'updatedAt')::timestamptz, true;
      return;
    end if;
  end if;

  perform pg_advisory_xact_lock(p_subscriber_id);

  select * into v_existing
  from public.subscribers
  where id = p_subscriber_id and tenant_id = p_tenant_id and site_id = p_site_id
  for update;
  if not found then
    raise exception 'SUBSCRIBER_OUT_OF_SCOPE' using errcode = 'P0001';
  end if;
  if p_expected_updated_at is not null and v_existing.updated_at <> p_expected_updated_at then
    raise exception 'SUBSCRIBER_VERSION_CONFLICT' using errcode = 'P0001';
  end if;

  update public.subscribers
  set full_name = p_full_name, phone = p_phone, address = nullif(p_address, ''), subscription_type = p_subscription_type, service_status = p_service_status
  where id = p_subscriber_id
  returning updated_at into v_updated_at;

  select platform_role into v_platform_role from public.users where id = p_user_id;
  insert into public.audit_logs (
    tenant_id, site_id, user_id, actor_platform_role, entity_type, entity_id, action, before_data, after_data
  ) values (
    p_tenant_id, p_site_id, p_user_id, v_platform_role, 'subscriber', p_subscriber_id::text, 'update',
    jsonb_build_object('fullName', v_existing.full_name, 'phone', v_existing.phone, 'address', v_existing.address, 'subscriptionType', v_existing.subscription_type, 'serviceStatus', v_existing.service_status, 'updatedAt', v_existing.updated_at),
    jsonb_build_object('siteId', p_site_id, 'fullName', p_full_name, 'phone', p_phone, 'address', nullif(p_address, ''), 'subscriptionType', p_subscription_type, 'serviceStatus', p_service_status, 'updatedAt', v_updated_at, 'clientOperationId', p_client_operation_id)
  );

  if p_client_operation_id is not null then
    insert into public.offline_sync_operations (
      tenant_id, site_id, user_id, client_operation_id, operation_type, entity_type, entity_id, response
    ) values (
      p_tenant_id, p_site_id, p_user_id, p_client_operation_id::text, 'subscriber_update', 'subscriber', p_subscriber_id,
      jsonb_build_object('success', true, 'updatedAt', v_updated_at)
    );
  end if;

  return query select v_updated_at, false;
end;
$$;

revoke execute on function public.powerhub_update_subscriber(bigint, bigint, bigint, bigint, text, text, text, text, text, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.powerhub_update_subscriber(bigint, bigint, bigint, bigint, text, text, text, text, text, timestamptz, uuid) to service_role;
