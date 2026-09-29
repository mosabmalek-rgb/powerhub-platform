-- PowerHub: fix ambiguous subscriber_no reference in the individual opening-reading RPC.
-- Keep this as a forward-only reconciliation migration; do not rewrite the historical migration.

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
returns table (
  subscriber_id bigint,
  subscriber_no text,
  opening_reading_id bigint,
  opening_reading_status text,
  replayed boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_subscriber_id bigint;
  v_subscriber_no text;
  v_reading_id bigint;
  v_response jsonb;
  v_platform_role text;
  v_current_count integer;
  v_effective_limit integer;
  v_feature_policy record;
  v_owner boolean := false;
begin
  if p_client_operation_id is not null then
    select response into v_response
    from public.offline_sync_operations
    where user_id = p_user_id
      and client_operation_id = p_client_operation_id::text
    limit 1;

    if found then
      if coalesce(v_response->>'id','') = '' then
        raise exception 'INVALID_SUBSCRIBER_OPERATION_REPLAY';
      end if;
      return query select
        (v_response->>'id')::bigint,
        v_response->>'subscriberNo',
        (v_response->>'openingReadingId')::bigint,
        v_response->>'openingReadingStatus',
        true;
      return;
    end if;
  end if;

  perform pg_advisory_xact_lock(p_tenant_id);

  if not exists (
    select 1 from public.sites
    where id = p_site_id and tenant_id = p_tenant_id and status <> 'archived'
  ) then
    raise exception 'SITE_OUT_OF_SCOPE' using errcode = 'P0001';
  end if;

  select * into v_feature_policy
  from public.powerhub_resolve_tenant_feature_policy(p_tenant_id, 'subscriber_management');

  if not coalesce(v_feature_policy.eligible, false)
     or not coalesce(v_feature_policy.enabled, false) then
    raise exception 'SUBSCRIBER_FEATURE_DISABLED' using errcode = 'P0001';
  end if;

  if p_full_name is null or length(trim(p_full_name)) < 2 then
    raise exception 'INVALID_SUBSCRIBER_NAME' using errcode = 'P0001';
  end if;
  if p_phone is null or length(trim(p_phone)) < 5 then
    raise exception 'INVALID_SUBSCRIBER_PHONE' using errcode = 'P0001';
  end if;
  if p_subscription_type not in ('residential','commercial') then
    raise exception 'INVALID_SUBSCRIPTION_TYPE' using errcode = 'P0001';
  end if;
  if p_opening_reading is null and (p_opening_image_key is not null or p_opening_image_hash is not null or p_opening_reading_approved) then
    raise exception 'OPENING_READING_REQUIRED' using errcode = 'P0001';
  end if;
  if p_opening_reading is not null and p_opening_reading < 0 then
    raise exception 'INVALID_OPENING_READING' using errcode = 'P0001';
  end if;

  select exists (
    select 1 from public.tenant_members tm
    where tm.tenant_id = p_tenant_id
      and tm.user_id = p_user_id
      and tm.role = 'owner'
      and tm.is_active
      and tm.membership_status = 'active'
  ) into v_owner;

  if p_opening_reading_approved and not v_owner then
    raise exception 'OPENING_READING_OWNER_REQUIRED' using errcode = 'P0001';
  end if;

  select count(*)::integer into v_current_count
  from public.subscribers where tenant_id = p_tenant_id;
  v_effective_limit := v_feature_policy.effective_limit;
  if v_effective_limit is not null and v_current_count >= v_effective_limit then
    raise exception 'SUBSCRIBER_QUOTA_REACHED' using errcode = 'P0001';
  end if;

  v_subscriber_no := format('SUB-%s', lpad(nextval('public.subscriber_global_number_seq')::text,6,'0'));

  insert into public.subscribers (
    tenant_id, site_id, subscriber_no, client_operation_id, full_name, phone,
    whatsapp_number, address, subscription_type
  ) values (
    p_tenant_id, p_site_id, v_subscriber_no, p_client_operation_id::text,
    trim(p_full_name), trim(p_phone), nullif(trim(p_whatsapp_number),''),
    nullif(trim(p_address),''), p_subscription_type
  )
  returning id into v_subscriber_id;

  if p_opening_reading is not null then
    insert into public.meter_readings (
      tenant_id, subscriber_id, client_operation_id, reading_at, reading_value,
      previous_reading_value, consumption_kwh, capture_method,
      image_key, image_hash, status, entered_by_user_id,
      reviewed_by_user_id, reviewed_at, notes, is_opening_baseline
    ) values (
      p_tenant_id, v_subscriber_id, p_client_operation_id::text,
      coalesce(p_opening_reading_at, now()),
      p_opening_reading, null, 0,
      case when nullif(trim(coalesce(p_opening_image_key,'')),'') is null then 'manual' else 'photo' end,
      nullif(trim(coalesce(p_opening_image_key,'')),''),
      nullif(trim(coalesce(p_opening_image_hash,'')),''),
      case when p_opening_reading_approved then 'approved' else 'pending_review' end,
      p_user_id,
      case when p_opening_reading_approved then p_user_id else null end,
      case when p_opening_reading_approved then now() else null end,
      'قراءة افتتاحية عند إضافة المشترك',
      true
    )
    returning id into v_reading_id;
  end if;

  select platform_role into v_platform_role
  from public.users where id = p_user_id;

  insert into public.audit_logs (
    tenant_id, site_id, user_id, actor_platform_role,
    entity_type, entity_id, action, after_data
  ) values (
    p_tenant_id, p_site_id, p_user_id, v_platform_role,
    'subscriber', v_subscriber_id::text, 'create_with_opening_reading',
    jsonb_build_object(
      'siteId', p_site_id,
      'subscriberNo', v_subscriber_no,
      'openingReadingId', v_reading_id,
      'openingReading', p_opening_reading,
      'openingReadingStatus', case when p_opening_reading is null then null when p_opening_reading_approved then 'approved' else 'pending_review' end
    )
  );

  if p_client_operation_id is not null then
    insert into public.offline_sync_operations (
      tenant_id, site_id, user_id, client_operation_id,
      operation_type, entity_type, entity_id, response
    ) values (
      p_tenant_id, p_site_id, p_user_id, p_client_operation_id::text,
      'subscriber_create', 'subscriber', v_subscriber_id,
      jsonb_build_object(
        'id', v_subscriber_id,
        'subscriberNo', v_subscriber_no,
        'openingReadingId', v_reading_id,
        'openingReadingStatus', case when p_opening_reading is null then null when p_opening_reading_approved then 'approved' else 'pending_review' end,
        'referenceNotifications', jsonb_build_array()
      )
    );
  end if;

  return query select
    v_subscriber_id,
    v_subscriber_no,
    v_reading_id,
    case when p_opening_reading is null then null
         when p_opening_reading_approved then 'approved'
         else 'pending_review' end,
    false;

exception when unique_violation then
  if p_client_operation_id is not null then
    select id, subscriber_no into v_subscriber_id, v_subscriber_no
    from public.subscribers
    where client_operation_id = p_client_operation_id::text
    limit 1;
    if found then
      select response into v_response
      from public.offline_sync_operations
      where user_id = p_user_id
        and client_operation_id = p_client_operation_id::text
      limit 1;
      return query select
        v_subscriber_id,
        v_subscriber_no,
        (v_response->>'openingReadingId')::bigint,
        v_response->>'openingReadingStatus',
        true;
      return;
    end if;
  end if;
  raise;
end;
$function$;

revoke execute on function public.powerhub_create_subscriber_with_opening_reading(
  bigint,bigint,bigint,text,text,text,text,text,uuid,integer,numeric,timestamptz,text,text,boolean
) from public, anon, authenticated;

grant execute on function public.powerhub_create_subscriber_with_opening_reading(
  bigint,bigint,bigint,text,text,text,text,text,uuid,integer,numeric,timestamptz,text,text,boolean
) to service_role;
