-- Canonical reading/billing cycle authority shared by the field app and web workspace.
-- Each site has one authoritative cycle. Invoice identity uses cycle_key, not billing_period,
-- so 10-day/15-day cycles can produce multiple invoices in the same calendar month.

create table if not exists public.tenant_reading_cycle_configurations (
  tenant_id bigint not null references public.tenants(id) on delete cascade,
  site_id bigint not null references public.sites(id) on delete cascade,
  cycle_type text not null default 'MONTHLY'
    check (cycle_type in ('WEEKLY','EVERY_10_DAYS','EVERY_15_DAYS','MONTHLY')),
  weekly_start_day integer not null default 7
    check (weekly_start_day between 1 and 7),
  monthly_start_day integer not null default 1
    check (monthly_start_day in (1,30)),
  timezone text not null default 'Asia/Gaza',
  updated_by bigint references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, site_id),
  unique (site_id)
);

alter table public.tenant_reading_cycle_configurations enable row level security;
revoke all on table public.tenant_reading_cycle_configurations from public, anon, authenticated;
grant select, insert, update, delete on table public.tenant_reading_cycle_configurations to service_role;

alter table public.invoices
  add column if not exists cycle_key text,
  add column if not exists cycle_start_at timestamptz,
  add column if not exists cycle_end_at timestamptz;

-- Historical invoices remain one-per-month because they predate cycle authority.
-- New invoices are protected by cycle_key after backfill.
update public.invoices
set cycle_key = coalesce(cycle_key, billing_period || ':legacy'),
    cycle_start_at = coalesce(cycle_start_at, issue_date),
    cycle_end_at = coalesce(cycle_end_at, due_date)
where cycle_key is null;

alter table public.invoices
  alter column cycle_key set not null;

alter table public.invoices
  drop constraint if exists invoices_subscriber_id_billing_period_key;

create unique index if not exists invoices_subscriber_cycle_unique
  on public.invoices(subscriber_id, cycle_key);

create index if not exists invoices_site_cycle_idx
  on public.invoices(tenant_id, site_id, cycle_key);

create or replace function public.powerhub_get_reading_cycle(
  p_tenant_id bigint,
  p_site_id bigint
)
returns table(cycle_type text, weekly_start_day integer, monthly_start_day integer, timezone text)
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
begin
  return query
  select c.cycle_type, c.weekly_start_day, c.monthly_start_day, c.timezone
  from public.tenant_reading_cycle_configurations c
  where c.tenant_id = p_tenant_id and c.site_id = p_site_id;
end;
$function$;

revoke execute on function public.powerhub_get_reading_cycle(bigint,bigint) from public, anon, authenticated;
grant execute on function public.powerhub_get_reading_cycle(bigint,bigint) to service_role;

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
  v_allowed boolean;
begin
  if p_cycle_type not in ('WEEKLY','EVERY_10_DAYS','EVERY_15_DAYS','MONTHLY') then
    raise exception 'INVALID_READING_CYCLE' using errcode='P0001';
  end if;
  if p_weekly_start_day not between 1 and 7 then
    raise exception 'INVALID_WEEKLY_START_DAY' using errcode='P0001';
  end if;
  if p_monthly_start_day not in (1,30) then
    raise exception 'INVALID_MONTHLY_START_DAY' using errcode='P0001';
  end if;

  select exists(
    select 1
    from public.tenant_members m
    join public.staff_profiles s
      on s.user_id=m.user_id and s.tenant_id=m.tenant_id and s.site_id=p_site_id and s.is_active
    where m.tenant_id=p_tenant_id
      and m.user_id=p_user_id
      and m.is_active
      and m.membership_status='active'
      and s.role in ('owner','manager')
      and (s.suspension_ends_at is null or s.suspension_ends_at <= now())
  ) into v_allowed;

  if not v_allowed then raise exception 'READING_CYCLE_PERMISSION_REQUIRED' using errcode='P0001'; end if;

  insert into public.tenant_reading_cycle_configurations(
    tenant_id,site_id,cycle_type,weekly_start_day,monthly_start_day,updated_by,updated_at
  ) values (
    p_tenant_id,p_site_id,p_cycle_type,p_weekly_start_day,p_monthly_start_day,p_user_id,now()
  )
  on conflict (tenant_id,site_id) do update set
    cycle_type=excluded.cycle_type,
    weekly_start_day=excluded.weekly_start_day,
    monthly_start_day=excluded.monthly_start_day,
    updated_by=excluded.updated_by,
    updated_at=now();

  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_tenant_role,entity_type,entity_id,action,after_data
  )
  values(
    p_tenant_id,p_site_id,p_user_id,'owner','reading_cycle',p_site_id::text,
    'configure',
    jsonb_build_object(
      'cycleType',p_cycle_type,
      'weeklyStartDay',p_weekly_start_day,
      'monthlyStartDay',p_monthly_start_day,
      'timezone','Asia/Gaza'
    )
  );

  return query select p_cycle_type,p_weekly_start_day,p_monthly_start_day,'Asia/Gaza'::text;
end;
$function$;

revoke execute on function public.powerhub_upsert_reading_cycle(bigint,bigint,bigint,text,integer,integer) from public, anon, authenticated;
grant execute on function public.powerhub_upsert_reading_cycle(bigint,bigint,bigint,text,integer,integer) to service_role;

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
  last_day integer;
  start_day integer;
begin
  select * into c
  from public.tenant_reading_cycle_configurations
  where tenant_id=p_tenant_id and site_id=p_site_id;

  if not found then
    c.cycle_type := 'MONTHLY';
    c.weekly_start_day := 7;
    c.monthly_start_day := 1;
    c.timezone := 'Asia/Gaza';
  end if;

  local_at := p_reading_at at time zone c.timezone;

  if c.cycle_type='WEEKLY' then
    -- Android Calendar: Sunday=1 ... Saturday=7.
    -- PostgreSQL dow: Sunday=0 ... Saturday=6.
    start_local := date_trunc('day', local_at)
      - make_interval(days => mod(
          extract(dow from local_at)::integer
          - case when c.weekly_start_day=7 then 6 else c.weekly_start_day-1 end
          + 7,
          7
        ));
    end_local := start_local + interval '7 days' - interval '1 millisecond';
  elsif c.cycle_type='EVERY_10_DAYS' then
    start_day := case when extract(day from local_at)::integer between 1 and 10 then 1
                      when extract(day from local_at)::integer between 11 and 20 then 11
                      else 21 end;
    start_local := date_trunc('month',local_at) + make_interval(days => start_day-1);
    end_local := least(
      start_local + interval '10 days' - interval '1 millisecond',
      (date_trunc('month',local_at)+interval '1 month'-interval '1 millisecond')
    );
  elsif c.cycle_type='EVERY_15_DAYS' then
    start_day := case when extract(day from local_at)::integer <= 15 then 1 else 16 end;
    start_local := date_trunc('month',local_at) + make_interval(days => start_day-1);
    end_local := least(
      start_local + interval '15 days' - interval '1 millisecond',
      (date_trunc('month',local_at)+interval '1 month'-interval '1 millisecond')
    );
  else
    start_day := case
      when c.monthly_start_day=30 and extract(month from local_at)::integer=2 then 28
      else least(c.monthly_start_day, extract(day from (date_trunc('month',local_at)+interval '1 month'-interval '1 day'))::integer)
    end;
    start_local := date_trunc('month',local_at) + make_interval(days => start_day-1);
    if local_at < start_local then
      start_local := date_trunc('month',local_at)-interval '1 month';
      start_day := case
        when c.monthly_start_day=30 and extract(month from (date_trunc('month',local_at)-interval '1 day'))::integer=2 then 28
        else least(c.monthly_start_day, extract(day from (date_trunc('month',local_at)-interval '1 day'))::integer)
      end;
      start_local := date_trunc('month',local_at)-interval '1 month' + make_interval(days => start_day-1);
    end if;
    end_local := date_trunc('month',start_local)+interval '1 month'-interval '1 millisecond';
  end if;

  cycle_start_at := start_local at time zone c.timezone;
  cycle_end_at := end_local at time zone c.timezone;
  billing_period := to_char(local_at,'YYYY-MM');
  cycle_key := c.cycle_type || ':' || to_char(cycle_start_at at time zone c.timezone,'YYYY-MM-DD');
  cycle_label := c.cycle_type || ' ' || to_char(cycle_start_at at time zone c.timezone,'YYYY-MM-DD') || ' → ' || to_char(cycle_end_at at time zone c.timezone,'YYYY-MM-DD');
  return next;
end;
$function$;

revoke execute on function public.powerhub_cycle_for_reading(bigint,bigint,timestamptz) from public, anon, authenticated;
grant execute on function public.powerhub_cycle_for_reading(bigint,bigint,timestamptz) to service_role;
