-- Correct monthly reading-cycle boundaries and preserve the actual actor role in audit.
-- This is a forward-only migration: do not edit already-applied migrations.

create or replace function public.powerhub_cycle_for_reading(
  p_tenant_id bigint,
  p_site_id bigint,
  p_reading_at timestamptz
)
returns table(cycle_key text, cycle_start_at timestamptz, cycle_end_at timestamptz, cycle_label text, billing_period text)
language plpgsql
stable
set search_path = public, pg_temp
as $function$
declare
  c record;
  local_at timestamp;
  start_local timestamp;
  end_local timestamp;
  next_month_local timestamp;
  last_day integer;
  next_last_day integer;
  start_day integer;
  next_start_day integer;
begin
  select * into c
  from public.tenant_reading_cycle_configurations
  where tenant_id = p_tenant_id
    and site_id = p_site_id;

  if not found then
    c.cycle_type := 'MONTHLY';
    c.weekly_start_day := 7;
    c.monthly_start_day := 1;
    c.timezone := 'Asia/Gaza';
  end if;

  local_at := p_reading_at at time zone c.timezone;

  if c.cycle_type = 'WEEKLY' then
    -- Android Calendar: Sunday=1 ... Saturday=7.
    -- PostgreSQL dow: Sunday=0 ... Saturday=6.
    start_local := date_trunc('day', local_at)
      - make_interval(days => mod(
          extract(dow from local_at)::integer
          - case when c.weekly_start_day = 7 then 6 else c.weekly_start_day - 1 end
          + 7,
          7
        ));
    end_local := start_local + interval '7 days' - interval '1 millisecond';

  elsif c.cycle_type = 'EVERY_10_DAYS' then
    start_day := case
      when extract(day from local_at)::integer between 1 and 10 then 1
      when extract(day from local_at)::integer between 11 and 20 then 11
      else 21
    end;
    start_local := date_trunc('month', local_at) + make_interval(days => start_day - 1);
    end_local := least(
      start_local + interval '10 days' - interval '1 millisecond',
      date_trunc('month', local_at) + interval '1 month' - interval '1 millisecond'
    );

  elsif c.cycle_type = 'EVERY_15_DAYS' then
    start_day := case when extract(day from local_at)::integer <= 15 then 1 else 16 end;
    start_local := date_trunc('month', local_at) + make_interval(days => start_day - 1);
    end_local := least(
      start_local + interval '15 days' - interval '1 millisecond',
      date_trunc('month', local_at) + interval '1 month' - interval '1 millisecond'
    );

  else
    -- A configured day 30 is clamped to day 28 in February (including leap years),
    -- preserving the existing product contract. Each cycle ends immediately before
    -- the next month's configured/clamped start, not at the end of its start month.
    last_day := extract(day from (
      date_trunc('month', local_at) + interval '1 month' - interval '1 day'
    ))::integer;
    start_day := case
      when c.monthly_start_day = 30 and extract(month from local_at)::integer = 2 then 28
      else least(c.monthly_start_day, last_day)
    end;
    start_local := date_trunc('month', local_at) + make_interval(days => start_day - 1);

    if local_at < start_local then
      start_local := date_trunc('month', local_at) - interval '1 month';
      last_day := extract(day from (
        date_trunc('month', start_local) + interval '1 month' - interval '1 day'
      ))::integer;
      start_day := case
        when c.monthly_start_day = 30 and extract(month from start_local)::integer = 2 then 28
        else least(c.monthly_start_day, last_day)
      end;
      start_local := date_trunc('month', start_local) + make_interval(days => start_day - 1);
    end if;

    next_month_local := date_trunc('month', start_local) + interval '1 month';
    next_last_day := extract(day from (
      next_month_local + interval '1 month' - interval '1 day'
    ))::integer;
    next_start_day := case
      when c.monthly_start_day = 30 and extract(month from next_month_local)::integer = 2 then 28
      else least(c.monthly_start_day, next_last_day)
    end;
    end_local := next_month_local
      + make_interval(days => next_start_day - 1)
      - interval '1 millisecond';
  end if;

  cycle_start_at := start_local at time zone c.timezone;
  cycle_end_at := end_local at time zone c.timezone;
  billing_period := to_char(local_at, 'YYYY-MM');
  cycle_key := c.cycle_type || ':' || to_char(cycle_start_at at time zone c.timezone, 'YYYY-MM-DD');
  cycle_label := c.cycle_type || ' ' ||
    to_char(cycle_start_at at time zone c.timezone, 'YYYY-MM-DD') || ' → ' ||
    to_char(cycle_end_at at time zone c.timezone, 'YYYY-MM-DD');
  return next;
end;
$function$;

revoke execute on function public.powerhub_cycle_for_reading(bigint,bigint,timestamptz) from public, anon, authenticated;
grant execute on function public.powerhub_cycle_for_reading(bigint,bigint,timestamptz) to service_role;

create or replace function public.powerhub_upsert_reading_cycle(
  p_user_id bigint,
  p_tenant_id bigint,
  p_site_id bigint,
  p_cycle_type text,
  p_weekly_start_day integer,
  p_monthly_start_day integer
)
returns table(cycle_type text, weekly_start_day integer, monthly_start_day integer, timezone text)
language plpgsql
security invoker
set search_path = public, pg_temp
as $function$
declare
  v_actor_role text;
begin
  if p_cycle_type not in ('WEEKLY', 'EVERY_10_DAYS', 'EVERY_15_DAYS', 'MONTHLY') then
    raise exception 'INVALID_READING_CYCLE' using errcode = 'P0001';
  end if;
  if p_weekly_start_day not between 1 and 7 then
    raise exception 'INVALID_WEEKLY_START_DAY' using errcode = 'P0001';
  end if;
  if p_monthly_start_day not in (1, 30) then
    raise exception 'INVALID_MONTHLY_START_DAY' using errcode = 'P0001';
  end if;

  -- Bind the site to the same tenant and derive the real role used for auditing.
  select s.role into v_actor_role
  from public.tenant_members m
  join public.staff_profiles s
    on s.user_id = m.user_id
   and s.tenant_id = m.tenant_id
   and s.site_id = p_site_id
   and s.is_active
  join public.sites site
    on site.id = s.site_id
   and site.tenant_id = m.tenant_id
  where m.tenant_id = p_tenant_id
    and m.user_id = p_user_id
    and m.is_active
    and m.membership_status = 'active'
    and s.role in ('owner', 'manager')
    and (s.suspension_ends_at is null or s.suspension_ends_at <= now())
  limit 1;

  if v_actor_role is null then
    raise exception 'READING_CYCLE_PERMISSION_REQUIRED' using errcode = 'P0001';
  end if;

  insert into public.tenant_reading_cycle_configurations(
    tenant_id, site_id, cycle_type, weekly_start_day, monthly_start_day, updated_by, updated_at
  ) values (
    p_tenant_id, p_site_id, p_cycle_type, p_weekly_start_day, p_monthly_start_day, p_user_id, now()
  )
  on conflict (tenant_id, site_id) do update set
    cycle_type = excluded.cycle_type,
    weekly_start_day = excluded.weekly_start_day,
    monthly_start_day = excluded.monthly_start_day,
    updated_by = excluded.updated_by,
    updated_at = now();

  insert into public.audit_logs(
    tenant_id, site_id, user_id, actor_tenant_role, entity_type, entity_id, action, after_data
  ) values (
    p_tenant_id, p_site_id, p_user_id, v_actor_role, 'reading_cycle', p_site_id::text,
    'configure',
    jsonb_build_object(
      'cycleType', p_cycle_type,
      'weeklyStartDay', p_weekly_start_day,
      'monthlyStartDay', p_monthly_start_day,
      'timezone', 'Asia/Gaza'
    )
  );

  return query select p_cycle_type, p_weekly_start_day, p_monthly_start_day, 'Asia/Gaza'::text;
end;
$function$;

revoke execute on function public.powerhub_upsert_reading_cycle(bigint,bigint,bigint,text,integer,integer) from public, anon, authenticated;
grant execute on function public.powerhub_upsert_reading_cycle(bigint,bigint,bigint,text,integer,integer) to service_role;
