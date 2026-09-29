-- PowerHub: individual subscriber creation with an optional opening baseline.
-- The subscriber and baseline are committed atomically; the baseline is never billable.
create or replace function public.powerhub_create_subscriber_with_opening_reading(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_full_name text,
  p_phone text,
  p_whatsapp_number text,
  p_address text,
  p_subscription_type text,
  p_client_operation_id uuid,
  p_quota_limit integer,
  p_opening_reading numeric,
  p_opening_reading_at timestamptz,
  p_opening_image_key text,
  p_opening_image_hash text,
  p_opening_reading_approved boolean
)
returns table (subscriber_id bigint, subscriber_no text, opening_reading_id bigint, opening_reading_status text, replayed boolean)
language plpgsql security invoker set search_path = public, pg_temp
as $$
declare
  v_subscriber_id bigint;
  v_subscriber_no text;
  v_reading_id bigint;
  v_role text;
  v_site_role text;
  v_response jsonb;
  v_policy record;
  v_count integer;
  v_status text;
begin
  if p_client_operation_id is not null then
    select response into v_response from public.offline_sync_operations
      where user_id = p_user_id and client_operation_id = p_client_operation_id::text limit 1;
    if found then
      return query select (v_response->>'id')::bigint, v_response->>'subscriberNo', null::bigint, null::text, true;
      return;
    end if;
  end if;

  perform pg_advisory_xact_lock(p_tenant_id);
  if not exists (select 1 from public.sites where id = p_site_id and tenant_id = p_tenant_id) then
    raise exception 'SITE_OUT_OF_SCOPE' using errcode = 'P0001';
  end if;
  if length(trim(coalesce(p_full_name, ''))) < 2 then raise exception 'INVALID_SUBSCRIBER_NAME' using errcode = 'P0001'; end if;
  if length(trim(coalesce(p_phone, ''))) < 5 then raise exception 'INVALID_SUBSCRIBER_PHONE' using errcode = 'P0001'; end if;
  if p_subscription_type not in ('residential', 'commercial') then raise exception 'INVALID_SUBSCRIPTION_TYPE' using errcode = 'P0001'; end if;
  if p_opening_reading is not null and p_opening_reading < 0 then raise exception 'INVALID_OPENING_READING' using errcode = 'P0001'; end if;

  select role into v_site_role from public.staff_profiles
    where user_id = p_user_id and tenant_id = p_tenant_id and site_id = p_site_id and is_active = true limit 1;
  if p_opening_reading_approved and coalesce(v_site_role, '') <> 'owner' then
    raise exception 'OPENING_READING_OWNER_REQUIRED' using errcode = 'P0001';
  end if;

  select * into v_policy from public.powerhub_resolve_tenant_feature_policy(p_tenant_id, 'subscriber_management');
  if not coalesce(v_policy.eligible, false) or not coalesce(v_policy.enabled, false) then raise exception 'SUBSCRIBER_FEATURE_DISABLED' using errcode = 'P0001'; end if;
  select count(*)::integer into v_count from public.subscribers where tenant_id = p_tenant_id;
  if v_policy.effective_limit is not null and v_count >= v_policy.effective_limit then raise exception 'SUBSCRIBER_QUOTA_REACHED' using errcode = 'P0001'; end if;

  v_subscriber_no := format('SUB-%s', lpad(nextval('public.subscriber_global_number_seq')::text, 6, '0'));
  insert into public.subscribers (tenant_id, site_id, subscriber_no, client_operation_id, full_name, phone, whatsapp_number, address, subscription_type)
  values (p_tenant_id, p_site_id, v_subscriber_no, p_client_operation_id::text, trim(p_full_name), trim(p_phone), nullif(trim(p_whatsapp_number), ''), nullif(trim(p_address), ''), p_subscription_type)
  returning id, subscriber_no into v_subscriber_id, v_subscriber_no;

  if p_opening_reading is not null then
    v_status := case when p_opening_reading_approved then 'approved' else 'pending_review' end;
    insert into public.meter_readings (
      tenant_id, subscriber_id, reading_at, reading_value, previous_reading_value, consumption_kwh,
      capture_method, image_key, image_hash, status, entered_by_user_id, reviewed_by_user_id, reviewed_at,
      notes, is_opening_baseline
    ) values (
      p_tenant_id, v_subscriber_id, coalesce(p_opening_reading_at, now()), p_opening_reading, null, 0,
      case when nullif(trim(coalesce(p_opening_image_key, '')), '') is null then 'manual' else 'photo' end,
      nullif(trim(coalesce(p_opening_image_key, '')), ''), nullif(trim(coalesce(p_opening_image_hash, '')), ''), v_status,
      p_user_id, case when p_opening_reading_approved then p_user_id else null end,
      case when p_opening_reading_approved then now() else null end,
      'قراءة افتتاحية عند إضافة المشترك', true
    ) returning id into v_reading_id;
  end if;

  select platform_role into v_role from public.users where id = p_user_id;
  insert into public.audit_logs (tenant_id, site_id, user_id, actor_platform_role, entity_type, entity_id, action, after_data)
  values (p_tenant_id, p_site_id, p_user_id, v_role, 'subscriber', v_subscriber_id::text, 'create_with_opening_reading',
    jsonb_build_object('subscriberNo', v_subscriber_no, 'openingReadingId', v_reading_id, 'openingReading', p_opening_reading, 'openingReadingStatus', v_status));

  if p_client_operation_id is not null then
    insert into public.offline_sync_operations (tenant_id, site_id, user_id, client_operation_id, operation_type, entity_type, entity_id, response)
    values (p_tenant_id, p_site_id, p_user_id, p_client_operation_id::text, 'subscriber_create', 'subscriber', v_subscriber_id,
      jsonb_build_object('id', v_subscriber_id, 'subscriberNo', v_subscriber_no, 'referenceNotifications', jsonb_build_array()));
  end if;

  return query select v_subscriber_id, v_subscriber_no, v_reading_id, v_status, false;
end;
$$;

revoke all on function public.powerhub_create_subscriber_with_opening_reading(bigint,bigint,bigint,text,text,text,text,text,uuid,integer,numeric,timestamptz,text,text,boolean) from public, anon, authenticated;
grant execute on function public.powerhub_create_subscriber_with_opening_reading(bigint,bigint,bigint,text,text,text,text,text,uuid,integer,numeric,timestamptz,text,text,boolean) to service_role;
