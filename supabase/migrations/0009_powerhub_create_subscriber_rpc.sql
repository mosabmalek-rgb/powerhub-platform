-- ينفذ إنشاء المشترك داخل Postgres لتبقى حصة الباقة والمفتاح غير المتصل والتدقيق متسقة عند الطلبات المتزامنة.
create or replace function public.powerhub_create_subscriber(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_subscriber_no text,
  p_full_name text,
  p_phone text,
  p_whatsapp_number text,
  p_address text,
  p_subscription_type text,
  p_client_operation_id uuid,
  p_quota_limit integer
)
returns table (subscriber_id bigint, subscriber_no text, replayed boolean)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_subscriber_id bigint;
  v_subscriber_no text;
  v_response jsonb;
  v_platform_role text;
  v_current_count integer;
begin
  if p_client_operation_id is not null then
    select response into v_response
    from public.offline_sync_operations
    where user_id = p_user_id and client_operation_id = p_client_operation_id::text
    limit 1;
    if found then
      if coalesce(v_response->>'id', '') = '' or coalesce(v_response->>'subscriberNo', '') = '' then
        raise exception 'INVALID_SUBSCRIBER_OPERATION_REPLAY' using errcode = 'P0001';
      end if;
      return query select (v_response->>'id')::bigint, v_response->>'subscriberNo', true;
      return;
    end if;
  end if;

  perform pg_advisory_xact_lock(p_tenant_id);

  if not exists (select 1 from public.sites where id = p_site_id and tenant_id = p_tenant_id) then
    raise exception 'SITE_OUT_OF_SCOPE' using errcode = 'P0001';
  end if;

  if p_client_operation_id is not null then
    select id, subscriber_no into v_subscriber_id, v_subscriber_no
    from public.subscribers
    where client_operation_id = p_client_operation_id::text
    limit 1;
    if found then
      return query select v_subscriber_id, v_subscriber_no, true;
      return;
    end if;
  end if;

  select count(*)::integer into v_current_count
  from public.subscribers
  where tenant_id = p_tenant_id;
  if v_current_count >= p_quota_limit then
    raise exception 'SUBSCRIBER_QUOTA_REACHED' using errcode = 'P0001';
  end if;

  insert into public.subscribers (
    tenant_id, site_id, subscriber_no, client_operation_id, full_name, phone, whatsapp_number, address, subscription_type
  ) values (
    p_tenant_id, p_site_id, p_subscriber_no, p_client_operation_id::text, p_full_name, p_phone, nullif(p_whatsapp_number, ''), nullif(p_address, ''), p_subscription_type
  ) returning id, subscriber_no into v_subscriber_id, v_subscriber_no;

  select platform_role into v_platform_role from public.users where id = p_user_id;
  insert into public.audit_logs (
    tenant_id, site_id, user_id, actor_platform_role, entity_type, entity_id, action, after_data
  ) values (
    p_tenant_id, p_site_id, p_user_id, v_platform_role, 'subscriber', v_subscriber_id::text, 'create',
    jsonb_build_object(
      'siteId', p_site_id, 'fullName', p_full_name, 'phone', p_phone, 'whatsappNumber', nullif(p_whatsapp_number, ''),
      'address', nullif(p_address, ''), 'subscriptionType', p_subscription_type, 'subscriberNo', v_subscriber_no, 'clientOperationId', p_client_operation_id
    )
  );

  if p_client_operation_id is not null then
    insert into public.offline_sync_operations (
      tenant_id, site_id, user_id, client_operation_id, operation_type, entity_type, entity_id, response
    ) values (
      p_tenant_id, p_site_id, p_user_id, p_client_operation_id::text, 'subscriber_create', 'subscriber', v_subscriber_id,
      jsonb_build_object('id', v_subscriber_id, 'subscriberNo', v_subscriber_no, 'referenceNotifications', jsonb_build_array())
    );
  end if;

  return query select v_subscriber_id, v_subscriber_no, false;
end;
$$;

revoke execute on function public.powerhub_create_subscriber(bigint, bigint, bigint, text, text, text, text, text, text, uuid, integer) from public, anon, authenticated;
grant execute on function public.powerhub_create_subscriber(bigint, bigint, bigint, text, text, text, text, text, text, uuid, integer) to service_role;
