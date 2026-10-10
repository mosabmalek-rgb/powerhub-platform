-- Align recurring monthly automation with the UI's day-of-month selection.
-- For example, day 31 runs on March 31 and May 31, not April 30.
create or replace function public.powerhub_unified_messaging_next_occurrence(
  p_schedule_type text,
  p_schedule_anchor_at timestamptz,
  p_timezone text,
  p_now timestamptz
)
returns table(due boolean, occurrence_at timestamptz, occurrence_key text)
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $function$
declare
  v_tz text := coalesce(nullif(trim(p_timezone),''),'Asia/Gaza');
  v_anchor_local timestamp := p_schedule_anchor_at at time zone v_tz;
  v_now_local timestamp := p_now at time zone v_tz;
  v_candidate_local timestamp;
  v_week_start timestamp;
  v_anchor_dow integer;
  v_index bigint;
  v_day integer;
  v_month_start timestamp;
  v_next_month timestamp;
  v_last_day integer;
begin
  if p_schedule_anchor_at is null or p_now < p_schedule_anchor_at then
    return query select false, null::timestamptz, null::text;
    return;
  end if;

  if p_schedule_type='one_time' then
    return query select true, p_schedule_anchor_at, 'one_time:' || to_char(v_anchor_local,'YYYY-MM-DD"T"HH24:MI:SS');
    return;
  end if;

  if p_schedule_type='weekly' then
    v_anchor_dow := extract(isodow from v_anchor_local)::integer;
    v_week_start := date_trunc('week',v_now_local);
    v_candidate_local := v_week_start + make_interval(days => v_anchor_dow-1)
      + (v_anchor_local-date_trunc('day',v_anchor_local));
    if v_candidate_local > v_now_local then
      v_candidate_local := v_candidate_local - interval '7 days';
    end if;
    if v_candidate_local < v_anchor_local then
      return query select false, null::timestamptz, null::text;
      return;
    end if;
    return query select true, v_candidate_local at time zone v_tz,
      'weekly:' || to_char(v_candidate_local,'YYYY-MM-DD"T"HH24:MI:SS');
    return;
  end if;

  if p_schedule_type in ('every_10_days','every_15_days') then
    v_day := case when p_schedule_type='every_10_days' then 10 else 15 end;
    v_index := floor(extract(epoch from (p_now - p_schedule_anchor_at))/86400 / v_day)::bigint;
    v_candidate_local := v_anchor_local + make_interval(days => (greatest(v_index,0)*v_day)::integer);
    if v_candidate_local at time zone v_tz > p_now then
      v_candidate_local := v_candidate_local - make_interval(days => v_day);
    end if;
    return query select true, v_candidate_local at time zone v_tz,
      p_schedule_type || ':' || to_char(v_candidate_local,'YYYY-MM-DD"T"HH24:MI:SS');
    return;
  end if;

  if p_schedule_type='monthly' then
    -- Match the UI: a selected day is skipped in months that do not contain it.
    v_day := extract(day from v_anchor_local)::integer;
    v_month_start := date_trunc('month',v_now_local);

    for v_index in 0..480 loop
      v_next_month := v_month_start + interval '1 month';
      v_last_day := extract(day from (v_next_month - interval '1 day'))::integer;

      if v_day <= v_last_day then
        v_candidate_local := v_month_start
          + make_interval(days => v_day - 1)
          + (v_anchor_local-date_trunc('day',v_anchor_local));
        if v_candidate_local <= v_now_local then
          exit;
        end if;
      end if;

      v_candidate_local := null;
      v_month_start := v_month_start - interval '1 month';
    end loop;

    if v_candidate_local is null or v_candidate_local < v_anchor_local then
      return query select false, null::timestamptz, null::text;
      return;
    end if;

    return query select true, v_candidate_local at time zone v_tz,
      'monthly:' || to_char(v_candidate_local,'YYYY-MM-DD');
    return;
  end if;

  return query select false, null::timestamptz, null::text;
end;
$function$;

revoke execute on function public.powerhub_unified_messaging_next_occurrence(text, timestamptz, text, timestamptz) from public, anon, authenticated;
grant execute on function public.powerhub_unified_messaging_next_occurrence(text, timestamptz, text, timestamptz) to service_role;
