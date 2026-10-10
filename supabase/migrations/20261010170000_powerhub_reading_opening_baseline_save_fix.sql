-- Keep opening baselines from blocking the first operational reading on the same date.
-- Preserve active + non-archived subscriber checks and the established RPC signature.
create or replace function public.powerhub_create_reading(
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
  p_field_verified boolean,
  p_can_override_same_day boolean
)
returns table(reading_id bigint, consumption_kwh numeric, status text, replayed boolean)
language plpgsql
security invoker
set search_path=public,pg_temp
as $$
declare
  v_subscriber public.subscribers%rowtype;
  v_existing public.meter_readings%rowtype;
  v_previous_value numeric := 0;
  v_consumption numeric;
  v_notes text;
  v_reading_id bigint;
  v_platform_role text;
  v_day_start timestamptz;
  v_day_end timestamptz;
begin
  perform pg_advisory_xact_lock(p_subscriber_id);

  select * into v_subscriber
  from public.subscribers
  where id=p_subscriber_id
    and tenant_id=p_tenant_id
    and site_id=p_site_id
    and service_status='active'
    and archived_at is null
  for update;

  if not found then
    raise exception 'SUBSCRIBER_OUT_OF_SCOPE_OR_INACTIVE' using errcode='P0001';
  end if;

  if p_client_operation_id is not null then
    select * into v_existing
    from public.meter_readings
    where client_operation_id=p_client_operation_id::text
    limit 1;
    if found then
      return query select v_existing.id,coalesce(v_existing.consumption_kwh,0),v_existing.status,true;
      return;
    end if;
  end if;

  v_day_start:=date_trunc('day',p_reading_at at time zone 'UTC') at time zone 'UTC';
  v_day_end:=v_day_start+interval '1 day';

  if exists(
    select 1
    from public.meter_readings mr
    where mr.subscriber_id=p_subscriber_id
      and mr.reading_at>=v_day_start
      and mr.reading_at<v_day_end
      and mr.status<>'rejected'
      and coalesce(mr.is_opening_baseline,false)=false
  ) and not p_can_override_same_day then
    raise exception 'SAME_DAY_READING_EXISTS' using errcode='P0001';
  end if;

  select coalesce(mr.reading_value,0) into v_previous_value
  from public.meter_readings mr
  where mr.subscriber_id=p_subscriber_id
    and mr.status='approved'
  order by mr.reading_at desc
  limit 1;

  if p_reading_value<v_previous_value and not p_is_reading_reset then
    raise exception 'READING_BELOW_PREVIOUS' using errcode='P0001';
  end if;

  if p_reading_value<v_previous_value and coalesce(trim(p_notes),'')='' then
    raise exception 'READING_RESET_NOTES_REQUIRED' using errcode='P0001';
  end if;

  v_consumption:=case
    when p_is_reading_reset and p_reading_value<v_previous_value then p_reading_value
    else p_reading_value-v_previous_value
  end;

  v_notes:=concat_ws(
    ' ',
    case when p_is_reading_reset then '[إعادة ضبط سجل القراءة]' end,
    case when p_field_verified then '[تم التحقق ميدانياً]' end,
    nullif(trim(p_notes),'')
  );

  insert into public.meter_readings(
    tenant_id,subscriber_id,client_operation_id,reading_at,reading_value,
    previous_reading_value,consumption_kwh,capture_method,image_key,image_hash,
    notes,entered_by_user_id
  ) values(
    p_tenant_id,p_subscriber_id,p_client_operation_id::text,p_reading_at,p_reading_value,
    nullif(v_previous_value,0),v_consumption,p_capture_method,
    nullif(p_image_key,''),nullif(p_image_hash,''),nullif(v_notes,''),p_user_id
  ) returning id into v_reading_id;

  select platform_role into v_platform_role from public.users where id=p_user_id;

  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data
  ) values(
    p_tenant_id,p_site_id,p_user_id,v_platform_role,'meter_reading',v_reading_id::text,'create',
    jsonb_build_object(
      'siteId',p_site_id,'subscriberId',p_subscriber_id,'readingAt',p_reading_at,
      'readingValue',p_reading_value,'consumptionKwh',v_consumption,
      'captureMethod',p_capture_method,'imageKey',nullif(p_image_key,''),
      'notes',nullif(v_notes,'')
    )
  );

  return query select v_reading_id,v_consumption,'pending_review'::text,false;
end;
$$;


revoke execute on function public.powerhub_create_reading(bigint,bigint,bigint,bigint,uuid,timestamptz,numeric,text,text,text,text,boolean,boolean,boolean) from public, anon, authenticated;
grant execute on function public.powerhub_create_reading(bigint,bigint,bigint,bigint,uuid,timestamptz,numeric,text,text,text,text,boolean,boolean,boolean) to service_role;
