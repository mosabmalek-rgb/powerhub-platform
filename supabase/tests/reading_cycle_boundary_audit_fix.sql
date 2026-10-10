\set ON_ERROR_STOP on

-- Isolated PostgreSQL integration test for the forward-only reading-cycle migration.
-- All schema/data are created inside this disposable CI database, never in PowerHub.
create schema if not exists public;

do $roles$
begin
  create role anon;
exception when duplicate_object then null;
end
$roles$;
do $roles$
begin
  create role authenticated;
exception when duplicate_object then null;
end
$roles$;
do $roles$
begin
  create role service_role;
exception when duplicate_object then null;
end
$roles$;

create table public.sites (
  id bigint primary key,
  tenant_id bigint not null
);
create table public.tenant_members (
  tenant_id bigint not null,
  user_id bigint not null,
  role text not null,
  is_active boolean not null,
  membership_status text not null,
  expires_at timestamptz
);
create table public.staff_profiles (
  user_id bigint not null,
  tenant_id bigint not null,
  site_id bigint,
  role text not null,
  is_active boolean not null,
  archived_at timestamptz,
  suspension_started_at timestamptz,
  suspension_ends_at timestamptz
);
create table public.tenant_reading_cycle_configurations (
  tenant_id bigint not null,
  site_id bigint not null,
  cycle_type text not null,
  weekly_start_day integer not null,
  monthly_start_day integer not null,
  timezone text not null default 'Asia/Gaza',
  updated_by bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, site_id)
);
create table public.audit_logs (
  id bigint generated always as identity primary key,
  tenant_id bigint not null,
  site_id bigint not null,
  user_id bigint,
  actor_tenant_role text,
  entity_type text not null,
  entity_id text,
  action text not null,
  after_data jsonb
);

insert into public.sites(id, tenant_id) values (1, 1), (2, 2);
insert into public.tenant_reading_cycle_configurations(
  tenant_id, site_id, cycle_type, weekly_start_day, monthly_start_day, timezone
) values (1, 1, 'MONTHLY', 7, 30, 'Asia/Gaza');

\ir ../migrations/20261010153000_powerhub_reading_cycle_boundary_audit_fix.sql

do $test$
declare
  r record;
  v_count integer;
begin
  -- Monthly day-30 anchor: the cycle before Jan 30 ends Jan 29, not Jan 31.
  select * into r from public.powerhub_cycle_for_reading(1, 1, timestamp '2027-01-29 12:00:00' at time zone 'Asia/Gaza');
  if (r.cycle_start_at at time zone 'Asia/Gaza')::date <> date '2026-12-30'
     or (r.cycle_end_at at time zone 'Asia/Gaza')::date <> date '2027-01-29'
     or r.cycle_key <> 'MONTHLY:2026-12-30' then
    raise exception 'monthly pre-anchor boundary failed: %', row_to_json(r);
  end if;

  select * into r from public.powerhub_cycle_for_reading(1, 1, timestamp '2027-01-30 12:00:00' at time zone 'Asia/Gaza');
  if (r.cycle_start_at at time zone 'Asia/Gaza')::date <> date '2027-01-30'
     or (r.cycle_end_at at time zone 'Asia/Gaza')::date <> date '2027-02-27' then
    raise exception 'monthly day-30 boundary failed: %', row_to_json(r);
  end if;

  select * into r from public.powerhub_cycle_for_reading(1, 1, timestamp '2027-02-28 12:00:00' at time zone 'Asia/Gaza');
  if (r.cycle_start_at at time zone 'Asia/Gaza')::date <> date '2027-02-28'
     or (r.cycle_end_at at time zone 'Asia/Gaza')::date <> date '2027-03-29' then
    raise exception 'non-leap February clamp failed: %', row_to_json(r);
  end if;

  select * into r from public.powerhub_cycle_for_reading(1, 1, timestamp '2028-02-29 12:00:00' at time zone 'Asia/Gaza');
  if (r.cycle_start_at at time zone 'Asia/Gaza')::date <> date '2028-02-28'
     or (r.cycle_end_at at time zone 'Asia/Gaza')::date <> date '2028-03-29' then
    raise exception 'leap February clamp failed: %', row_to_json(r);
  end if;

  update public.tenant_reading_cycle_configurations
    set cycle_type = 'EVERY_10_DAYS'
    where tenant_id = 1 and site_id = 1;
  select * into r from public.powerhub_cycle_for_reading(1, 1, timestamp '2027-01-31 12:00:00' at time zone 'Asia/Gaza');
  if (r.cycle_start_at at time zone 'Asia/Gaza')::date <> date '2027-01-21'
     or (r.cycle_end_at at time zone 'Asia/Gaza')::date <> date '2027-01-31' then
    raise exception '10-day month-end boundary failed: %', row_to_json(r);
  end if;

  update public.tenant_reading_cycle_configurations
    set cycle_type = 'EVERY_15_DAYS'
    where tenant_id = 1 and site_id = 1;
  select * into r from public.powerhub_cycle_for_reading(1, 1, timestamp '2027-04-30 12:00:00' at time zone 'Asia/Gaza');
  if (r.cycle_start_at at time zone 'Asia/Gaza')::date <> date '2027-04-16'
     or (r.cycle_end_at at time zone 'Asia/Gaza')::date <> date '2027-04-30' then
    raise exception '15-day month-end boundary failed: %', row_to_json(r);
  end if;

  update public.tenant_reading_cycle_configurations
    set cycle_type = 'WEEKLY', weekly_start_day = 7
    where tenant_id = 1 and site_id = 1;
  select * into r from public.powerhub_cycle_for_reading(1, 1, timestamp '2027-01-31 12:00:00' at time zone 'Asia/Gaza');
  if (r.cycle_start_at at time zone 'Asia/Gaza')::date <> date '2027-01-30'
     or (r.cycle_end_at at time zone 'Asia/Gaza')::date <> date '2027-02-05' then
    raise exception 'weekly Saturday-start boundary failed: %', row_to_json(r);
  end if;

  -- Owner membership can configure without a staff profile; manager role is audited accurately.
  insert into public.tenant_members values
    (1, 101, 'owner', true, 'active', null),
    (1, 102, 'member', true, 'active', null),
    (1, 103, 'member', true, 'active', null),
    (1, 104, 'member', true, 'active', null),
    (1, 105, 'member', true, 'active', now() - interval '1 day'),
    (1, 106, 'member', true, 'active', null);
  insert into public.staff_profiles values
    (102, 1, 1, 'manager', true, null, null, null),
    (103, 1, null, 'manager', true, null, null, null),
    (104, 1, 1, 'manager', true, now(), null, null),
    (105, 1, 1, 'manager', true, null, null, null),
    (106, 1, 1, 'manager', true, null, now() - interval '1 minute', now() + interval '1 minute');

  perform * from public.powerhub_upsert_reading_cycle(101, 1, 1, 'MONTHLY', 7, 30);
  perform * from public.powerhub_upsert_reading_cycle(102, 1, 1, 'WEEKLY', 7, 1);
  perform * from public.powerhub_upsert_reading_cycle(103, 1, 1, 'MONTHLY', 7, 30);

  select count(*) into v_count from public.audit_logs
    where tenant_id = 1 and site_id = 1 and user_id = 102
      and actor_tenant_role = 'manager' and entity_type = 'reading_cycle';
  if v_count <> 1 then raise exception 'manager audit role not preserved'; end if;

  select count(*) into v_count from public.audit_logs
    where tenant_id = 1 and site_id = 1 and user_id = 101
      and actor_tenant_role = 'owner' and entity_type = 'reading_cycle';
  if v_count <> 1 then raise exception 'owner membership audit role failed'; end if;

  -- Archived, expired, suspended, and cross-tenant actors must be rejected.
  begin
    perform * from public.powerhub_upsert_reading_cycle(104, 1, 1, 'MONTHLY', 7, 1);
    raise exception 'archived manager unexpectedly allowed';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'READING_CYCLE_PERMISSION_REQUIRED' then raise; end if;
  end;

  begin
    perform * from public.powerhub_upsert_reading_cycle(105, 1, 1, 'MONTHLY', 7, 1);
    raise exception 'expired membership unexpectedly allowed';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'READING_CYCLE_PERMISSION_REQUIRED' then raise; end if;
  end;

  begin
    perform * from public.powerhub_upsert_reading_cycle(106, 1, 1, 'MONTHLY', 7, 1);
    raise exception 'suspended manager unexpectedly allowed';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'READING_CYCLE_PERMISSION_REQUIRED' then raise; end if;
  end;

  begin
    perform * from public.powerhub_upsert_reading_cycle(102, 1, 2, 'MONTHLY', 7, 1);
    raise exception 'cross-tenant site unexpectedly allowed';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'READING_CYCLE_PERMISSION_REQUIRED' then raise; end if;
  end;

  if has_function_privilege('anon', 'public.powerhub_cycle_for_reading(bigint,bigint,timestamp with time zone)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.powerhub_cycle_for_reading(bigint,bigint,timestamp with time zone)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.powerhub_cycle_for_reading(bigint,bigint,timestamp with time zone)', 'EXECUTE') then
    raise exception 'cycle lookup RPC grants are incorrect';
  end if;
  if has_function_privilege('anon', 'public.powerhub_upsert_reading_cycle(bigint,bigint,bigint,text,integer,integer)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.powerhub_upsert_reading_cycle(bigint,bigint,bigint,text,integer,integer)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.powerhub_upsert_reading_cycle(bigint,bigint,bigint,text,integer,integer)', 'EXECUTE') then
    raise exception 'cycle upsert RPC grants are incorrect';
  end if;
end
$test$;

\echo 'reading-cycle SQL integration assertions passed'
