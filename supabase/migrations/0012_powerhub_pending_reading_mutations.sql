-- تعدّل أو تحذف القراءة المعلقة فقط مع تفادي ضياع تعديل متزامن.
create or replace function public.powerhub_update_pending_reading(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_reading_id bigint,
  p_base_version integer,
  p_reading_value numeric,
  p_reading_at timestamptz,
  p_notes text
)
returns table (consumption_kwh numeric, updated_at timestamptz)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_reading public.meter_readings%rowtype;
  v_previous_value numeric := 0;
  v_consumption numeric;
  v_updated_at timestamptz;
  v_platform_role text;
begin
  perform pg_advisory_xact_lock(p_reading_id);
  select r.* into v_reading
  from public.meter_readings r
  join public.subscribers s on s.id = r.subscriber_id
  where r.id = p_reading_id and r.tenant_id = p_tenant_id and s.site_id = p_site_id
  for update of r;
  if not found then raise exception 'READING_OUT_OF_SCOPE' using errcode = 'P0001'; end if;
  if v_reading.status <> 'pending_review' then raise exception 'READING_NOT_PENDING' using errcode = 'P0001'; end if;
  if v_reading.version_no <> p_base_version then raise exception 'READING_VERSION_CONFLICT' using errcode = 'P0001'; end if;

  select coalesce(reading_value, 0) into v_previous_value
  from public.meter_readings
  where subscriber_id = v_reading.subscriber_id and status = 'approved'
  order by reading_at desc
  limit 1;
  if p_reading_value < v_previous_value then raise exception 'READING_BELOW_PREVIOUS' using errcode = 'P0001'; end if;
  v_consumption := p_reading_value - v_previous_value;

  update public.meter_readings
  set reading_value = p_reading_value, reading_at = p_reading_at, previous_reading_value = nullif(v_previous_value, 0),
      consumption_kwh = v_consumption, notes = nullif(trim(p_notes), ''), version_no = version_no + 1
  where id = p_reading_id
  returning updated_at into v_updated_at;

  select platform_role into v_platform_role from public.users where id = p_user_id;
  insert into public.audit_logs (tenant_id, site_id, user_id, actor_platform_role, entity_type, entity_id, action, before_data, after_data)
  values (
    p_tenant_id, p_site_id, p_user_id, v_platform_role, 'meter_reading', p_reading_id::text, 'update_pending',
    jsonb_build_object('readingValue', v_reading.reading_value, 'readingAt', v_reading.reading_at, 'notes', v_reading.notes, 'versionNo', v_reading.version_no),
    jsonb_build_object('readingValue', p_reading_value, 'readingAt', p_reading_at, 'notes', nullif(trim(p_notes), ''), 'consumptionKwh', v_consumption, 'versionNo', p_base_version + 1)
  );
  return query select v_consumption, v_updated_at;
end;
$$;

create or replace function public.powerhub_delete_pending_reading(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_reading_id bigint,
  p_base_version integer
)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_reading public.meter_readings%rowtype;
  v_platform_role text;
begin
  perform pg_advisory_xact_lock(p_reading_id);
  select r.* into v_reading
  from public.meter_readings r
  join public.subscribers s on s.id = r.subscriber_id
  where r.id = p_reading_id and r.tenant_id = p_tenant_id and s.site_id = p_site_id
  for update of r;
  if not found then raise exception 'READING_OUT_OF_SCOPE' using errcode = 'P0001'; end if;
  if v_reading.status <> 'pending_review' then raise exception 'READING_NOT_PENDING' using errcode = 'P0001'; end if;
  if v_reading.version_no <> p_base_version then raise exception 'READING_VERSION_CONFLICT' using errcode = 'P0001'; end if;

  delete from public.meter_readings where id = p_reading_id;
  select platform_role into v_platform_role from public.users where id = p_user_id;
  insert into public.audit_logs (tenant_id, site_id, user_id, actor_platform_role, entity_type, entity_id, action, before_data)
  values (
    p_tenant_id, p_site_id, p_user_id, v_platform_role, 'meter_reading', p_reading_id::text, 'delete_pending',
    jsonb_build_object('subscriberId', v_reading.subscriber_id, 'readingValue', v_reading.reading_value, 'readingAt', v_reading.reading_at, 'versionNo', v_reading.version_no)
  );
end;
$$;

revoke execute on function public.powerhub_update_pending_reading(bigint, bigint, bigint, bigint, integer, numeric, timestamptz, text) from public, anon, authenticated;
revoke execute on function public.powerhub_delete_pending_reading(bigint, bigint, bigint, bigint, integer) from public, anon, authenticated;
grant execute on function public.powerhub_update_pending_reading(bigint, bigint, bigint, bigint, integer, numeric, timestamptz, text) to service_role;
grant execute on function public.powerhub_delete_pending_reading(bigint, bigint, bigint, bigint, integer) to service_role;
