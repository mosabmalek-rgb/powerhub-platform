-- Support both anchor patterns for 10-day and 15-day reading cycles.
-- monthly_start_day remains the persisted two-mode selector (1 = first pattern, 30 = alternate pattern).
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
    end_local := start_local + interval '7 days' - interval '1 microsecond';

  elsif c.cycle_type = 'EVERY_10_DAYS' then
    last_day := extract(day from (date_trunc('month', local_at) + interval '1 month' - interval '1 day'))::integer;
    if c.monthly_start_day = 1 then
      start_day := case
        when extract(day from local_at)::integer between 1 and 10 then 1
        when extract(day from local_at)::integer between 11 and 20 then 11
        else 21
      end;
      start_local := date_trunc('month', local_at) + make_interval(days => start_day - 1);
      end_local := case
        when start_day = 21 then date_trunc('month', local_at) + interval '1 month' - interval '1 microsecond'
        else start_local + interval '10 days' - interval '1 microsecond'
      end;
    else
      -- Alternate 10/20/30 anchor. Day 30 is clamped to the last day of February.
      start_day := null;
      start_local := null;
      if extract(day from local_at)::integer >= 30
        or (extract(month from local_at)::integer = 2 and extract(day from local_at)::integer >= 28) then
        start_day := case when extract(month from local_at)::integer = 2 then 28 else 30 end;
      elsif extract(day from local_at)::integer >= 20 then
        start_day := 20;
      elsif extract(day from local_at)::integer >= 10 then
        start_day := 10;
      else
        next_month_local := date_trunc('month', local_at) - interval '1 month';
        next_last_day := extract(day from (next_month_local + interval '1 month' - interval '1 day'))::integer;
        start_local := next_month_local + make_interval(days => (case when extract(month from next_month_local)::integer = 2 then 28 else least(30, next_last_day) end) - 1);
        start_day := null;
      end if;
      if start_local is null then
        start_local := date_trunc('month', local_at) + make_interval(days => start_day - 1);
      end if;
      if start_day is null then
        next_month_local := date_trunc('month', local_at) + make_interval(days => 9);
      elsif start_day = 10 then
        next_month_local := date_trunc('month', local_at) + interval '19 days';
      elsif start_day = 20 then
        start_day := case when extract(month from local_at)::integer = 2 then 28 else least(30, last_day) end;
        next_month_local := date_trunc('month', local_at) + make_interval(days => start_day - 1);
      else
        next_month_local := date_trunc('month', local_at) + interval '1 month' + interval '9 days';
      end if;
      end_local := next_month_local - interval '1 microsecond';
    end if;

  elsif c.cycle_type = 'EVERY_15_DAYS' then
    last_day := extract(day from (date_trunc('month', local_at) + interval '1 month' - interval '1 day'))::integer;
    if c.monthly_start_day = 1 then
      start_day := case when extract(day from local_at)::integer <= 15 then 1 else 16 end;
      start_local := date_trunc('month', local_at) + make_interval(days => start_day - 1);
      end_local := case
        when start_day = 16 then date_trunc('month', local_at) + interval '1 month' - interval '1 microsecond'
        else start_local + interval '15 days' - interval '1 microsecond'
      end;
    else
      -- Alternate 15/30 anchor. Day 30 is clamped to the last day of February.
      start_day := null;
      start_local := null;
      if extract(day from local_at)::integer >= 30
        or (extract(month from local_at)::integer = 2 and extract(day from local_at)::integer >= 28) then
        start_day := case when extract(month from local_at)::integer = 2 then 28 else 30 end;
      elsif extract(day from local_at)::integer >= 15 then
        start_day := 15;
      else
        next_month_local := date_trunc('month', local_at) - interval '1 month';
        next_last_day := extract(day from (next_month_local + interval '1 month' - interval '1 day'))::integer;
        start_local := next_month_local + make_interval(days => (case when extract(month from next_month_local)::integer = 2 then 28 else least(30, next_last_day) end) - 1);
        start_day := null;
      end if;
      if start_local is null then
        start_local := date_trunc('month', local_at) + make_interval(days => start_day - 1);
      end if;
      if start_day is null or start_day = (case when extract(month from local_at)::integer = 2 then 28 else least(30, last_day) end) then
        next_month_local := date_trunc('month', start_local) + interval '1 month' + interval '14 days';
      else
        start_day := case when extract(month from local_at)::integer = 2 then 28 else least(30, last_day) end;
        next_month_local := date_trunc('month', local_at) + make_interval(days => start_day - 1);
      end if;
      end_local := next_month_local - interval '1 microsecond';
    end if;

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
      - interval '1 microsecond';
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
