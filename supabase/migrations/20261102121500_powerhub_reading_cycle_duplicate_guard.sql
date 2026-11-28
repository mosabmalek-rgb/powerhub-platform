-- Enforce one operational meter reading per subscriber and configured reading cycle.
-- This is a forward-only guard shared by web, mobile, RPC, and offline-sync write paths.
-- It intentionally does not rewrite or delete historical readings.

create or replace function public.powerhub_enforce_single_reading_per_cycle()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_site_id bigint;
  v_cycle record;
  v_conflicting_reading_id bigint;
begin
  -- Match the existing reading-creation RPC lock so all writer paths serialize
  -- on the same subscriber before checking the cycle window.
  perform pg_advisory_xact_lock(new.subscriber_id);

  select s.site_id
    into v_site_id
  from public.subscribers s
  where s.id = new.subscriber_id
    and s.tenant_id = new.tenant_id
  for update;

  if not found then
    raise exception 'READING_SUBSCRIBER_SCOPE_INVALID' using errcode = '23503';
  end if;

  -- Opening baselines establish the meter value but do not consume a cycle.
  -- A rejected reading releases the cycle for a corrected replacement.
  if new.is_opening_baseline is true or new.status is not distinct from 'rejected' then
    return new;
  end if;

  select *
    into v_cycle
  from public.powerhub_cycle_for_reading(new.tenant_id, v_site_id, new.reading_at);

  if not found or v_cycle.cycle_start_at is null or v_cycle.cycle_end_at is null then
    raise exception 'READING_CYCLE_UNAVAILABLE' using errcode = 'P0001';
  end if;

  select mr.id
    into v_conflicting_reading_id
  from public.meter_readings mr
  where mr.tenant_id = new.tenant_id
    and mr.subscriber_id = new.subscriber_id
    and mr.id is distinct from new.id
    and mr.is_opening_baseline is not true
    and mr.status is distinct from 'rejected'
    and mr.reading_at >= v_cycle.cycle_start_at
    and mr.reading_at <= v_cycle.cycle_end_at
  order by mr.reading_at desc, mr.id desc
  limit 1;

  if found then
    raise exception using
      errcode = '23505',
      message = 'READING_ALREADY_EXISTS_IN_CYCLE',
      constraint = 'meter_readings_one_operational_reading_per_cycle',
      detail = format('A non-rejected operational reading already exists for cycle %s.', v_cycle.cycle_key);
  end if;

  return new;
end;
$function$;

revoke all on function public.powerhub_enforce_single_reading_per_cycle() from public, anon, authenticated;
grant execute on function public.powerhub_enforce_single_reading_per_cycle() to service_role;

drop trigger if exists powerhub_enforce_single_reading_per_cycle on public.meter_readings;
create trigger powerhub_enforce_single_reading_per_cycle
before insert or update of tenant_id, subscriber_id, reading_at, status, is_opening_baseline
on public.meter_readings
for each row
execute function public.powerhub_enforce_single_reading_per_cycle();
