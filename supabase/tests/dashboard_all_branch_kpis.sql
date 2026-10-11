\set ON_ERROR_STOP on

-- Disposable PostgreSQL integration test for dashboard all-branch aggregates.
-- Synthetic rows only; this suite never connects to PowerHub's production database.
select 'create role anon nologin' where not exists (select 1 from pg_roles where rolname = 'anon') \gexec
select 'create role authenticated nologin' where not exists (select 1 from pg_roles where rolname = 'authenticated') \gexec
select 'create role service_role nologin bypassrls' where not exists (select 1 from pg_roles where rolname = 'service_role') \gexec

create table public.sites (
  id bigint primary key,
  tenant_id bigint not null,
  status text not null
);
create table public.subscribers (
  id bigint primary key,
  tenant_id bigint not null,
  site_id bigint not null
);
create table public.meter_readings (
  id bigint primary key,
  tenant_id bigint not null,
  subscriber_id bigint not null,
  status text not null,
  reading_at timestamptz not null,
  consumption_kwh numeric
);
create table public.users (
  id bigint primary key,
  name text,
  email text
);
create table public.collector_sessions (
  id bigint primary key,
  tenant_id bigint not null,
  site_id bigint not null,
  collector_user_id bigint,
  status text not null,
  expected_cash numeric,
  declared_cash numeric,
  variance_amount numeric,
  opened_at timestamptz,
  closed_at timestamptz
);

insert into public.sites(id, tenant_id, status) values
  (10, 1, 'active'), (11, 1, 'inactive'), (12, 1, 'archived'), (20, 2, 'active');
insert into public.subscribers(id, tenant_id, site_id) values
  (100, 1, 10), (101, 1, 11), (102, 1, 12), (200, 2, 20);
insert into public.meter_readings(id, tenant_id, subscriber_id, status, reading_at, consumption_kwh) values
  (1, 1, 100, 'approved', '2026-10-05T10:00:00Z', 10),
  (2, 1, 101, 'approved', '2026-10-06T10:00:00Z', 20),
  (3, 1, 100, 'pending_review', '2026-10-06T11:00:00Z', 5),
  (4, 1, 102, 'approved', '2026-10-07T10:00:00Z', 100),
  (5, 2, 200, 'approved', '2026-10-07T10:00:00Z', 999);

insert into public.users(id, name, email) values
  (1, 'أحمد', 'ahmad@example.test'),
  (2, 'محمد', 'mohammad@example.test');
insert into public.collector_sessions(
  id, tenant_id, site_id, collector_user_id, status,
  expected_cash, declared_cash, variance_amount, opened_at, closed_at
) values
  (1, 1, 10, 1, 'closed', 10, 9, -1, '2026-10-05T10:00:00Z', '2026-10-05T11:00:00Z'),
  (2, 1, 11, 1, 'closed', 20, 18, -2, '2026-10-06T10:00:00Z', '2026-10-06T11:00:00Z'),
  (3, 1, 10, 2, 'open', 5, null, 0, '2026-10-06T12:00:00Z', null),
  (4, 1, 12, 2, 'closed', 100, 0, -100, '2026-10-07T10:00:00Z', '2026-10-07T11:00:00Z'),
  (5, 2, 20, 1, 'closed', 999, 0, -999, '2026-10-07T10:00:00Z', '2026-10-07T11:00:00Z');

\ir ../migrations/20261012110000_powerhub_dashboard_all_branch_kpis.sql

do $test$
declare
  kpis jsonb;
  collectors jsonb;
begin
  kpis := public.powerhub_dashboard_reading_kpis_all_branches(
    1, '2026-10-01T00:00:00Z', '2026-10-08T00:00:00Z'
  );
  if (kpis->>'consumption')::numeric <> 30
     or (kpis->>'average')::numeric <> 15
     or (kpis->>'approvedCount')::integer <> 2
     or (kpis->>'pendingCount')::integer <> 1
     or (kpis->>'latestReadingAt')::timestamptz <> '2026-10-06T10:00:00Z'::timestamptz then
    raise exception 'all-branch reading aggregate mismatch: %', kpis;
  end if;

  -- Inactive branches count, archived branches and other tenants do not.
  collectors := public.powerhub_dashboard_collector_performance_all_branches(
    1, '2026-10-01T00:00:00Z', '2026-10-08T00:00:00Z'
  );
  if (collectors->>'openCount')::integer <> 1
     or (collectors->>'closedCount')::integer <> 2
     or (collectors->>'varianceCount')::integer <> 2
     or (collectors->>'netVariance')::numeric <> -3
     or jsonb_array_length(collectors->'collectors') <> 2
     or collectors->'collectors'->0->>'name' <> 'أحمد'
     or (collectors->'collectors'->0->>'sessions')::integer <> 2
     or (collectors->'collectors'->0->>'variance')::numeric <> -3 then
    raise exception 'all-branch collector aggregate mismatch: %', collectors;
  end if;

  if has_function_privilege('anon', 'public.powerhub_dashboard_reading_kpis_all_branches(bigint,timestamp with time zone,timestamp with time zone)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.powerhub_dashboard_reading_kpis_all_branches(bigint,timestamp with time zone,timestamp with time zone)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.powerhub_dashboard_reading_kpis_all_branches(bigint,timestamp with time zone,timestamp with time zone)', 'EXECUTE') then
    raise exception 'all-branch reading KPI RPC grants are incorrect';
  end if;
  if has_function_privilege('anon', 'public.powerhub_dashboard_collector_performance_all_branches(bigint,timestamp with time zone,timestamp with time zone)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.powerhub_dashboard_collector_performance_all_branches(bigint,timestamp with time zone,timestamp with time zone)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.powerhub_dashboard_collector_performance_all_branches(bigint,timestamp with time zone,timestamp with time zone)', 'EXECUTE') then
    raise exception 'all-branch collector RPC grants are incorrect';
  end if;
end
$test$;

\echo 'dashboard all-branch KPI SQL integration assertions passed'
