\set ON_ERROR_STOP on

do $roles$
begin create role anon nologin; exception when duplicate_object then null; end
$roles$;
do $roles$
begin create role authenticated nologin; exception when duplicate_object then null; end
$roles$;
do $roles$
begin create role service_role nologin bypassrls; exception when duplicate_object then null; end
$roles$;

-- Small isolated schema fixture: migrations and trigger bodies are tested without live user data.
create table public.tenants (id bigint primary key, name text not null);
create table public.sites (
  id bigint primary key,
  tenant_id bigint not null,
  name text not null,
  code text,
  city text,
  address text,
  status text,
  anomaly_alert_percent numeric,
  invoice_due_days integer,
  invoice_due_hours integer,
  created_at timestamptz not null default now()
);
create table public.subscribers (
  id bigint primary key, tenant_id bigint not null, site_id bigint not null,
  subscriber_no text, client_operation_id text, full_name text, phone text,
  whatsapp_number text, address text, subscription_type text, service_status text,
  archived_at timestamptz, created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.generators (
  id bigint primary key, tenant_id bigint not null, site_id bigint not null,
  code text, name text, serial_number text, rated_capacity_kw numeric, fuel_type text,
  fuel_level_liters numeric, operating_hours numeric, status text, last_maintenance_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.meter_readings (
  id bigint primary key, tenant_id bigint not null, subscriber_id bigint not null,
  reading_at timestamptz not null default now()
);
create table public.tariffs (
  id bigint primary key, tenant_id bigint not null, site_id bigint not null,
  name text, code text, price_per_kwh numeric, fixed_fee numeric, tax_rate numeric,
  is_active boolean, effective_from timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create table public.invoices (
  id bigint primary key,
  tenant_id bigint not null,
  site_id bigint not null,
  subscriber_id bigint,
  reading_id bigint,
  tariff_id bigint,
  invoice_no text,
  client_operation_id text,
  billing_period text,
  issue_date date not null,
  due_date date,
  previous_reading numeric,
  current_reading numeric,
  consumption_kwh numeric,
  price_per_kwh numeric,
  fixed_fee numeric,
  tax_amount numeric,
  discount_amount numeric,
  total_amount numeric not null,
  paid_amount numeric not null default 0,
  balance_due numeric not null,
  status text not null,
  cycle_key text,
  cycle_start_at timestamptz,
  cycle_end_at timestamptz,
  created_by_user_id bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  internal_notes text
);

-- Seed base scope before the sync triggers are installed.
insert into public.tenants(id, name) values (1, 'Tenant One'), (2, 'Tenant Two');
insert into public.sites(id, tenant_id, name) values (10, 1, 'Site One'), (20, 2, 'Site Two');

\ir ../migrations/20261024140000_powerhub_delta_sync_engine.sql
\ir ../migrations/20261027110000_powerhub_delta_invoice_history.sql

do $test$
declare
  v_snapshot jsonb;
  v_delta jsonb;
  v_cursor bigint;
begin
  v_snapshot := public.powerhub_get_sync_snapshot(1, 10, 'invoices');
  if v_snapshot->>'status' <> 'ok'
     or v_snapshot->>'snapshot_cursor' <> '0'
     or jsonb_array_length(v_snapshot->'rows') <> 0 then
    raise exception 'Invoice initial snapshot contract failed: %', v_snapshot;
  end if;

  insert into public.invoices(
    id, tenant_id, site_id, invoice_no, issue_date, total_amount, paid_amount, balance_due, status, internal_notes
  ) values (100, 1, 10, 'INV-TEST-100', date '2026-10-27', 100, 0, 100, 'issued', 'must never leave server');

  select last_cursor into v_cursor
  from public.powerhub_sync_scope_state
  where tenant_id = 1 and site_id = 10 and entity_type = 'invoices';
  if v_cursor is distinct from 1 then
    raise exception 'Invoice insert did not advance exactly one cursor: %', v_cursor;
  end if;

  v_snapshot := public.powerhub_get_sync_snapshot(1, 10, 'invoices');
  if v_snapshot->>'snapshot_cursor' is distinct from '1'
     or jsonb_array_length(v_snapshot->'rows') <> 1
     or v_snapshot #>> '{rows,0,id}' is distinct from '100'
     or v_snapshot #>> '{rows,0,total_amount}' is distinct from '100'
     or v_snapshot #> '{rows,0,internal_notes}' is not null then
    raise exception 'Invoice snapshot projection/cursor failed: %', v_snapshot;
  end if;

  v_delta := public.powerhub_pull_sync_delta(1, 10, 'invoices', 0, null, 200);
  if v_delta->>'status' is distinct from 'ok'
     or v_delta #>> '{next_cursor}' is distinct from '1'
     or jsonb_array_length(v_delta->'changes') <> 1
     or v_delta #>> '{changes,0,operation}' is distinct from 'upsert'
     or v_delta #>> '{changes,0,row_data,id}' is distinct from '100'
     or v_delta #>> '{changes,0,row_data,balance_due}' is distinct from '100'
     or v_delta #> '{changes,0,row_data,internal_notes}' is not null then
    raise exception 'Invoice insert Delta contract failed: %', v_delta;
  end if;

  update public.invoices
  set paid_amount = 25, balance_due = 75, status = 'partial', updated_at = now()
  where id = 100;
  v_delta := public.powerhub_pull_sync_delta(1, 10, 'invoices', 1, null, 200);
  if jsonb_array_length(v_delta->'changes') <> 1
     or v_delta #>> '{changes,0,operation}' is distinct from 'upsert'
     or v_delta #>> '{changes,0,row_data,paid_amount}' is distinct from '25'
     or v_delta #>> '{changes,0,row_data,balance_due}' is distinct from '75'
     or v_delta #>> '{changes,0,row_data,status}' is distinct from 'partial' then
    raise exception 'Invoice payment/balance update Delta contract failed: %', v_delta;
  end if;

  delete from public.invoices where id = 100;
  v_delta := public.powerhub_pull_sync_delta(1, 10, 'invoices', 2, null, 200);
  if jsonb_array_length(v_delta->'changes') <> 1
     or v_delta #>> '{changes,0,operation}' is distinct from 'delete'
     or v_delta #> '{changes,0,row_data}' is distinct from 'null'::jsonb
     or v_delta #>> '{next_cursor}' is distinct from '3' then
    raise exception 'Invoice deletion tombstone/cursor contract failed: %', v_delta;
  end if;

  insert into public.invoices(id, tenant_id, site_id, invoice_no, issue_date, total_amount, balance_due, status)
  values (101, 1, 10, 'INV-TEST-101', date '2026-10-27', 55, 55, 'issued');
  update public.invoices set tenant_id = 2, site_id = 20 where id = 101;

  v_delta := public.powerhub_pull_sync_delta(1, 10, 'invoices', 4, null, 200);
  if jsonb_array_length(v_delta->'changes') <> 1
     or v_delta #>> '{changes,0,operation}' is distinct from 'delete'
     or v_delta #>> '{changes,0,entity_id}' is distinct from '101' then
    raise exception 'Invoice old-scope move tombstone failed: %', v_delta;
  end if;

  v_snapshot := public.powerhub_get_sync_snapshot(1, 10, 'invoices');
  if jsonb_array_length(v_snapshot->'rows') <> 0 then
    raise exception 'Moved invoice leaked into its former branch: %', v_snapshot;
  end if;
  v_snapshot := public.powerhub_get_sync_snapshot(2, 20, 'invoices');
  if jsonb_array_length(v_snapshot->'rows') <> 1
     or v_snapshot #>> '{rows,0,id}' is distinct from '101' then
    raise exception 'Moved invoice missing from its new scoped snapshot: %', v_snapshot;
  end if;
  v_delta := public.powerhub_pull_sync_delta(2, 20, 'invoices', 0, null, 200);
  if jsonb_array_length(v_delta->'changes') <> 1
     or v_delta #>> '{changes,0,operation}' is distinct from 'upsert'
     or v_delta #>> '{changes,0,row_data,id}' is distinct from '101' then
    raise exception 'Invoice new-scope upsert failed: %', v_delta;
  end if;

  begin
    perform public.powerhub_get_sync_snapshot(1, 20, 'invoices');
    raise exception 'Expected invoice snapshot to reject a cross-tenant site';
  exception when others then
    if sqlerrm <> 'SITE_OUT_OF_SCOPE' then raise; end if;
  end;

  if has_function_privilege('anon', 'public.powerhub_append_sync_change(bigint,bigint,text,text,text,jsonb)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.powerhub_append_sync_change(bigint,bigint,text,text,text,jsonb)', 'EXECUTE')
     or has_function_privilege('anon', 'public.powerhub_pull_sync_delta(bigint,bigint,text,bigint,bigint,integer)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.powerhub_get_sync_snapshot(bigint,bigint,text)', 'EXECUTE')
     or has_table_privilege('anon', 'public.powerhub_sync_changes', 'SELECT')
     or has_table_privilege('authenticated', 'public.powerhub_sync_scope_state', 'SELECT') then
    raise exception 'Delta server-only ACL boundary was weakened';
  end if;
  if not has_function_privilege('service_role', 'public.powerhub_append_sync_change(bigint,bigint,text,text,text,jsonb)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.powerhub_pull_sync_delta(bigint,bigint,text,bigint,bigint,integer)', 'EXECUTE') then
    raise exception 'service_role cannot execute the required Delta functions';
  end if;

  v_delta := public.powerhub_pull_sync_delta(1, 10, 'invoices', null, null, 200);
  if v_delta->>'status' is distinct from 'reset_required'
     or v_delta #>> '{snapshot_cursor}' is distinct from '5' then
    raise exception 'Expired/missing invoice cursor reset contract failed: %', v_delta;
  end if;
end
$test$;
