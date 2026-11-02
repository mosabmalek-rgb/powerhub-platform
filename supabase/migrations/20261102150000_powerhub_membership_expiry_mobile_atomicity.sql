-- Enforce membership expiry consistently for mobile field writes and reconcile
-- field-reader assignments after a selected member expires without a row update.

create or replace function public.powerhub_mobile_create_field_reading(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_subscriber_id bigint,
  p_client_operation_id uuid,
  p_reading_at timestamptz,
  p_reading_value numeric,
  p_capture_method text,
  p_image_key text,
  p_image_hash text,
  p_notes text,
  p_is_reading_reset boolean,
  p_field_verified boolean
)
returns table (reading_id bigint, consumption_kwh numeric, status text, replayed boolean)
language plpgsql
security invoker
set search_path = public, pg_temp
as $function$
declare
  v_existing public.meter_readings%rowtype;
  v_subscriber public.subscribers%rowtype;
  v_distribution_enabled boolean := false;
begin
  if p_client_operation_id is null then
    raise exception 'MOBILE_READING_OPERATION_ID_REQUIRED' using errcode = '22023';
  end if;

  -- client_operation_id is globally unique on meter_readings. Serialize retries
  -- by operation key before checking ownership or locking the subscriber.
  perform pg_advisory_xact_lock(hashtextextended(
    'powerhub-mobile-reading-operation:' || p_client_operation_id::text, 0
  ));

  select * into v_existing
    from public.meter_readings
   where client_operation_id = p_client_operation_id::text
   limit 1;

  if found then
    if v_existing.tenant_id is distinct from p_tenant_id
       or v_existing.subscriber_id is distinct from p_subscriber_id
       or v_existing.entered_by_user_id is distinct from p_user_id then
      raise exception 'MOBILE_READING_IDEMPOTENCY_KEY_REUSED' using errcode = '23505';
    end if;

    -- A completed operation belongs to its original actor. A later transfer
    -- must not turn a valid retry into a 404 or create another reading.
    return query
      select v_existing.id, coalesce(v_existing.consumption_kwh, 0), v_existing.status, true;
    return;
  end if;

  -- Match the lock order used by the canonical reading RPC. The row lock is
  -- deliberately acquired before checking assignment so a concurrent transfer
  -- is observed either before or after this write, never between check/insert.
  perform pg_advisory_xact_lock(p_subscriber_id);

  select subscriber.* into v_subscriber
    from public.subscribers subscriber
   where subscriber.id = p_subscriber_id
     and subscriber.tenant_id = p_tenant_id
     and subscriber.site_id = p_site_id
     and subscriber.service_status = 'active'
     and subscriber.archived_at is null
   for update;

  if not found then
    raise exception 'SUBSCRIBER_OUT_OF_SCOPE_OR_INACTIVE' using errcode = 'P0001';
  end if;

  if not exists (
    select 1
      from public.users reader
      join public.tenant_members membership
        on membership.user_id = reader.id
       and membership.tenant_id = p_tenant_id
       and membership.role = 'member'
       and membership.is_active = true
       and membership.membership_status = 'active'
       and (membership.expires_at is null or membership.expires_at > now())
      join public.staff_profiles profile
        on profile.user_id = reader.id
       and profile.tenant_id = p_tenant_id
       and profile.role = 'technician'
       and profile.is_active = true
       and profile.archived_at is null
       and (profile.site_id = p_site_id or profile.site_id is null)
       and (
         profile.permissions is null
         or profile.permissions @> '["recordReadings","accessFieldApp"]'::jsonb
       )
     where reader.id = p_user_id
       and reader.account_status = 'active'
       and not (
         profile.suspension_started_at is not null
         and profile.suspension_started_at <= now()
         and (profile.suspension_ends_at is null or profile.suspension_ends_at > now())
       )
  ) then
    raise exception 'MOBILE_FIELD_READER_NOT_ELIGIBLE' using errcode = '42501';
  end if;

  select coalesce(
    (
      select settings.is_enabled
        from public.field_reading_distribution_settings settings
       where settings.tenant_id = p_tenant_id
         and settings.site_id = p_site_id
    ),
    false
  ) into v_distribution_enabled;

  if v_distribution_enabled
     and v_subscriber.assigned_reader_user_id is distinct from p_user_id then
    raise exception 'FIELD_READER_ASSIGNMENT_CHANGED' using errcode = '42501';
  end if;

  -- Keep mobile's established same-day behavior; the shared cycle trigger
  -- below remains the cross-channel duplicate guard.
  select coalesce(reading.reading_value, 0)
    into v_previous_value
    from public.meter_readings reading
   where reading.subscriber_id = p_subscriber_id
     and reading.status = 'approved'
   order by reading.reading_at desc
   limit 1;
  v_previous_value := coalesce(v_previous_value, 0);

  if p_reading_value < v_previous_value and not p_is_reading_reset then
    raise exception 'READING_BELOW_PREVIOUS' using errcode = 'P0001';
  end if;
  if p_reading_value < v_previous_value and coalesce(trim(p_notes), '') = '' then
    raise exception 'READING_RESET_NOTES_REQUIRED' using errcode = 'P0001';
  end if;

  v_consumption := case
    when p_is_reading_reset and p_reading_value < v_previous_value then p_reading_value
    else p_reading_value - v_previous_value
  end;
  v_notes := concat_ws(' ',
    case when p_is_reading_reset then '[إعادة ضبط سجل القراءة]' end,
    case when p_field_verified then '[تم التحقق ميدانياً]' end,
    nullif(trim(p_notes), '')
  );

  insert into public.meter_readings (
    tenant_id, subscriber_id, client_operation_id, reading_at, reading_value,
    previous_reading_value, consumption_kwh, capture_method, image_key,
    image_hash, notes, entered_by_user_id
  ) values (
    p_tenant_id, p_subscriber_id, p_client_operation_id::text, p_reading_at,
    p_reading_value, nullif(v_previous_value, 0), v_consumption,
    p_capture_method, nullif(p_image_key, ''), nullif(p_image_hash, ''),
    nullif(v_notes, ''), p_user_id
  )
  returning * into v_existing;

  insert into public.audit_logs (
    tenant_id, site_id, user_id, entity_type, entity_id, action, after_data
  ) values (
    p_tenant_id, p_site_id, p_user_id, 'meter_reading', v_existing.id::text,
    'mobile_create',
    jsonb_build_object(
      'clientOperationId', p_client_operation_id,
      'subscriberId', p_subscriber_id,
      'readingAt', p_reading_at,
      'readingValue', p_reading_value,
      'consumptionKwh', v_consumption,
      'captureMethod', p_capture_method,
      'imageKey', nullif(p_image_key, ''),
      'latitude', null,
      'longitude', null
    )
  );

  return query select v_existing.id, v_consumption, v_existing.status, false;
end;
$function$;

revoke all on function public.powerhub_mobile_create_field_reading(
  bigint,bigint,bigint,bigint,uuid,timestamptz,numeric,text,text,text,text,boolean,boolean
) from public, anon, authenticated;
grant execute on function public.powerhub_mobile_create_field_reading(
  bigint,bigint,bigint,bigint,uuid,timestamptz,numeric,text,text,text,text,boolean,boolean
) to service_role;


-- Evaluate reader membership at a supplied instant. This lets the periodic
-- reconciler process a future expires_at even though no UPDATE event fires
-- when wall-clock time crosses that timestamp.
create or replace function public.powerhub_reconcile_field_reader_selection_at(
  p_tenant_id bigint,
  p_user_id bigint,
  p_site_id bigint,
  p_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_setting record;
  v_eligible boolean;
  v_remaining_readers bigint[];
begin
  for v_setting in
    select settings.tenant_id, settings.site_id, settings.is_enabled, settings.reader_user_ids
      from public.field_reading_distribution_settings settings
     where (p_tenant_id is null or settings.tenant_id = p_tenant_id)
       and (p_site_id is null or settings.site_id = p_site_id)
       and (
         p_user_id = any(settings.reader_user_ids)
         or exists (
           select 1 from public.subscribers subscriber
            where subscriber.tenant_id = settings.tenant_id
              and subscriber.site_id = settings.site_id
              and subscriber.assigned_reader_user_id = p_user_id
         )
       )
     for update
  loop
    select exists (
      select 1
        from public.users reader
        join public.tenant_members membership
          on membership.user_id = reader.id
         and membership.tenant_id = v_setting.tenant_id
         and membership.role = 'member'
         and membership.is_active = true
         and membership.membership_status = 'active'
         and (membership.expires_at is null or membership.expires_at > p_at)
        join public.staff_profiles profile
          on profile.user_id = reader.id
         and profile.tenant_id = v_setting.tenant_id
         and profile.role = 'technician'
         and profile.is_active = true
         and profile.archived_at is null
         and (profile.site_id = v_setting.site_id or profile.site_id is null)
         and (
           profile.permissions is null
           or profile.permissions @> '["recordReadings","accessFieldApp"]'::jsonb
         )
       where reader.id = p_user_id
         and reader.account_status = 'active'
         and not (
           profile.suspension_started_at is not null
           and profile.suspension_started_at <= p_at
           and (profile.suspension_ends_at is null or profile.suspension_ends_at > p_at)
         )
    ) into v_eligible;

    if not v_setting.is_enabled
       or not (p_user_id = any(v_setting.reader_user_ids))
       or not v_eligible then
      if v_setting.is_enabled and p_user_id = any(v_setting.reader_user_ids) then
        v_remaining_readers := array_remove(v_setting.reader_user_ids, p_user_id);
        if cardinality(v_remaining_readers) < 2 then
          update public.field_reading_distribution_settings
             set is_enabled = false,
                 reader_user_ids = '{}'::bigint[],
                 updated_at = now()
           where tenant_id = v_setting.tenant_id and site_id = v_setting.site_id;

          update public.subscribers
             set assigned_reader_user_id = null
           where tenant_id = v_setting.tenant_id and site_id = v_setting.site_id;

          insert into public.audit_logs
            (tenant_id, site_id, user_id, entity_type, entity_id, action, after_data)
          values
            (v_setting.tenant_id, v_setting.site_id, null, 'field_reading_distribution',
             v_setting.site_id::text, 'auto_disable_no_active_readers',
             jsonb_build_object('disabledUserId', p_user_id, 'remainingReaderCount', cardinality(v_remaining_readers),
               'evaluatedAt', p_at));
        else
          update public.field_reading_distribution_settings
             set reader_user_ids = v_remaining_readers,
                 updated_at = now()
           where tenant_id = v_setting.tenant_id and site_id = v_setting.site_id;

          update public.subscribers
             set assigned_reader_user_id = null
           where tenant_id = v_setting.tenant_id
             and site_id = v_setting.site_id
             and assigned_reader_user_id = p_user_id;

          insert into public.audit_logs
            (tenant_id, site_id, user_id, entity_type, entity_id, action, after_data)
          values
            (v_setting.tenant_id, v_setting.site_id, null, 'field_reading_distribution',
             p_user_id::text, 'remove_ineligible_reader',
             jsonb_build_object('remainingReaderUserIds', to_jsonb(v_remaining_readers),
               'evaluatedAt', p_at));
        end if;
      else
        update public.subscribers
           set assigned_reader_user_id = null
         where tenant_id = v_setting.tenant_id
           and site_id = v_setting.site_id
           and assigned_reader_user_id = p_user_id;
      end if;
    end if;
  end loop;
end;
$function$;

revoke all on function public.powerhub_reconcile_field_reader_selection_at(bigint,bigint,bigint,timestamptz)
  from public, anon, authenticated;
grant execute on function public.powerhub_reconcile_field_reader_selection_at(bigint,bigint,bigint,timestamptz)
  to service_role;


create or replace function public.powerhub_reconcile_expired_field_readers(
  p_at timestamptz default now(),
  p_batch_size integer default 200
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_candidate record;
  v_processed integer := 0;
begin
  for v_candidate in
    select distinct settings.tenant_id, selected.reader_id
      from public.field_reading_distribution_settings settings
      cross join lateral unnest(settings.reader_user_ids) selected(reader_id)
      join public.tenant_members membership
        on membership.tenant_id = settings.tenant_id
       and membership.user_id = selected.reader_id
     where settings.is_enabled = true
       and membership.expires_at is not null
       and membership.expires_at <= p_at
     order by settings.tenant_id, selected.reader_id
     limit greatest(1, least(1000, coalesce(p_batch_size, 200)))
  loop
    perform public.powerhub_reconcile_field_reader_selection_at(
      v_candidate.tenant_id,
      v_candidate.reader_id,
      null,
      p_at
    );
    v_processed := v_processed + 1;
  end loop;

  return v_processed;
end;
$function$;

revoke all on function public.powerhub_reconcile_expired_field_readers(timestamptz,integer)
  from public, anon, authenticated;
grant execute on function public.powerhub_reconcile_expired_field_readers(timestamptz,integer)
  to service_role;


-- Supabase Cron is optional. When pg_cron is installed, schedule the
-- reconciliation using cron.schedule (never mutate cron.job directly).
do $schedule$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule(
      'powerhub_reconcile_expired_field_readers',
      '*/5 * * * *',
      'select public.powerhub_reconcile_expired_field_readers(now(), 200);'
    );
  end if;
end
$schedule$;
