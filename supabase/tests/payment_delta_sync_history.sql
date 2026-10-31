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
create table public.tenants (id bigint primary key, name text not null);
create table public.sites (
 id bigint primary key, tenant_id bigint not null, name text not null, code text, city text, address text,
 status text, anomaly_alert_percent numeric, invoice_due_days integer, invoice_due_hours integer,
 created_at timestamptz not null default now()
);
create table public.subscribers (
 id bigint primary key, tenant_id bigint not null, site_id bigint not null, subscriber_no text,
 client_operation_id text, full_name text, phone text, whatsapp_number text, address text,
 subscription_type text, service_status text, archived_at timestamptz,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.generators (
 id bigint primary key, tenant_id bigint not null, site_id bigint not null, code text, name text,
 serial_number text, rated_capacity_kw numeric, fuel_type text, fuel_level_liters numeric,
 operating_hours numeric, status text, last_maintenance_at timestamptz,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.meter_readings (id bigint primary key, tenant_id bigint not null, subscriber_id bigint not null, reading_at timestamptz not null default now());
create table public.tariffs (
 id bigint primary key, tenant_id bigint not null, site_id bigint not null, name text, code text,
 price_per_kwh numeric, fixed_fee numeric, tax_rate numeric, is_active boolean,
 effective_from timestamptz not null default now(), created_at timestamptz not null default now()
);
create table public.invoices (
 id bigint primary key, tenant_id bigint not null, site_id bigint not null, subscriber_id bigint,
 reading_id bigint, tariff_id bigint, invoice_no text, client_operation_id text, billing_period text,
 issue_date date not null, due_date date, previous_reading numeric, current_reading numeric,
 consumption_kwh numeric, price_per_kwh numeric, fixed_fee numeric, tax_amount numeric, discount_amount numeric,
 total_amount numeric not null, paid_amount numeric not null default 0, balance_due numeric not null,
 status text not null, cycle_key text, cycle_start_at timestamptz, cycle_end_at timestamptz,
 created_by_user_id bigint, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 internal_notes text
);
create table public.payments (
 id bigint primary key, tenant_id bigint not null, site_id bigint not null, subscriber_id bigint not null,
 invoice_id bigint, payment_no text not null, client_operation_id text, amount numeric not null,
 payment_method text not null, transfer_from_account text, transfer_from_type text, transfer_to_account text,
 transfer_to_type text, reference_no text, receipt_image_key text, receipt_image_hash text,
 status text not null, collected_by_user_id bigint, collector_session_id bigint,
 paid_at timestamptz not null default now(), created_at timestamptz not null default now()
);
insert into public.tenants(id,name) values (1,'Tenant One'),(2,'Tenant Two');
insert into public.sites(id,tenant_id,name) values (10,1,'Site One'),(20,1,'Site Two'),(30,2,'Other Tenant Site');
insert into public.subscribers(id,tenant_id,site_id,subscriber_no,full_name,phone)
values (101,1,10,'SUB-000101','Subscriber One','0590000000'),
       (102,1,20,'SUB-000102','Subscriber Two','0590000001'),
       (201,2,30,'SUB-000201','Subscriber Other Tenant','0590000002');
insert into public.invoices(id,tenant_id,site_id,subscriber_id,invoice_no,issue_date,total_amount,paid_amount,balance_due,status)
values (501,1,10,101,'INV-TEST-501',date '2026-10-27',100,0,100,'issued');

\ir ../migrations/20261024140000_powerhub_delta_sync_engine.sql
\ir ../migrations/20261027110000_powerhub_delta_invoice_history.sql
\ir ../migrations/20261027130000_powerhub_delta_payment_history.sql

do $test$
declare v_snapshot jsonb; v_delta jsonb; v_cursor bigint;
begin
  v_snapshot := public.powerhub_get_sync_snapshot(1,10,'payments');
  if v_snapshot->>'status' is distinct from 'ok' or v_snapshot->>'snapshot_cursor' is distinct from '0'
    or jsonb_array_length(v_snapshot->'rows') <> 0 then raise exception 'Empty payment snapshot failed: %',v_snapshot; end if;

  insert into public.payments(id,tenant_id,site_id,subscriber_id,invoice_id,payment_no,amount,payment_method,
    transfer_to_account,transfer_to_type,receipt_image_key,receipt_image_hash,status,paid_at)
  values (900,1,10,101,501,'PAY-900',25,'cash','0590000000','cash',
    'private/payment-receipts/secret.png','private-hash','completed',timestamptz '2026-10-27 10:00:00+00');
  select last_cursor into v_cursor from public.powerhub_sync_scope_state where tenant_id=1 and site_id=10 and entity_type='payments';
  if v_cursor is distinct from 1 then raise exception 'Payment insert cursor mismatch: %',v_cursor; end if;

  v_snapshot := public.powerhub_get_sync_snapshot(1,10,'payments');
  if v_snapshot->>'snapshot_cursor' is distinct from '1'
    or jsonb_array_length(v_snapshot->'rows') <> 1
    or v_snapshot #>> '{rows,0,id}' is distinct from '900'
    or v_snapshot #>> '{rows,0,payment,amount}' is distinct from '25'
    or v_snapshot #>> '{rows,0,payment,has_receipt_image}' is distinct from 'true'
    or v_snapshot #> '{rows,0,payment,receipt_image_key}' is not null
    or v_snapshot #> '{rows,0,payment,receipt_image_hash}' is not null
     or v_snapshot #>> '{rows,0,subscriber,full_name}' is distinct from 'Subscriber One'
     or v_snapshot #>> '{rows,0,invoice_no}' is distinct from 'INV-TEST-501' then
    raise exception 'Payment snapshot or receipt secret filter failed: %',v_snapshot;
  end if;

  v_delta := public.powerhub_pull_sync_delta(1,10,'payments',0,null,200);
  if jsonb_array_length(v_delta->'changes') <> 1
    or v_delta #>> '{changes,0,operation}' is distinct from 'upsert'
    or v_delta #>> '{changes,0,row_data,payment,amount}' is distinct from '25'
    or v_delta #> '{changes,0,row_data,payment,receipt_image_key}' is not null
     or v_delta #>> '{changes,0,row_data,subscriber,full_name}' is distinct from 'Subscriber One'
     or v_delta #>> '{changes,0,row_data,invoice_no}' is distinct from 'INV-TEST-501' then
    raise exception 'Payment insert Delta failed: %',v_delta;
  end if;

  update public.payments set amount=30,status='corrected',reference_no='REF-900' where id=900;
  v_delta := public.powerhub_pull_sync_delta(1,10,'payments',1,null,200);
  if jsonb_array_length(v_delta->'changes') <> 1
    or v_delta #>> '{changes,0,row_data,payment,amount}' is distinct from '30'
    or v_delta #>> '{changes,0,row_data,payment,status}' is distinct from 'corrected' then
    raise exception 'Payment update Delta failed: %',v_delta;
  end if;

  delete from public.payments where id=900;
  v_delta := public.powerhub_pull_sync_delta(1,10,'payments',2,null,200);
  if jsonb_array_length(v_delta->'changes') <> 1
    or v_delta #>> '{changes,0,operation}' is distinct from 'delete'
    or v_delta #>> '{changes,0,entity_id}' is distinct from '900'
    or v_delta #>> '{next_cursor}' is distinct from '3' then
    raise exception 'Payment delete tombstone failed: %',v_delta;
  end if;

  insert into public.payments(id,tenant_id,site_id,subscriber_id,invoice_id,payment_no,amount,payment_method,status,paid_at)
  values (901,1,10,101,501,'PAY-901',50,'cash','completed',timestamptz '2026-10-27 11:00:00+00');
  update public.payments set site_id=20,subscriber_id=102 where id=901;
  v_delta := public.powerhub_pull_sync_delta(1,10,'payments',4,null,200);
  if jsonb_array_length(v_delta->'changes') <> 1
    or v_delta #>> '{changes,0,operation}' is distinct from 'delete'
    or v_delta #>> '{changes,0,entity_id}' is distinct from '901' then
    raise exception 'Payment old scope tombstone failed: %',v_delta;
  end if;
  v_snapshot := public.powerhub_get_sync_snapshot(1,20,'payments');
  if jsonb_array_length(v_snapshot->'rows') <> 1
    or v_snapshot #>> '{rows,0,id}' is distinct from '901' then
    raise exception 'Payment new scope snapshot failed: %',v_snapshot;
  end if;
  v_delta := public.powerhub_pull_sync_delta(1,20,'payments',0,null,200);
  if jsonb_array_length(v_delta->'changes') <> 1
    or v_delta #>> '{changes,0,operation}' is distinct from 'upsert'
    or v_delta #>> '{changes,0,row_data,id}' is distinct from '901' then
    raise exception 'Payment new scope Delta failed: %',v_delta;
  end if;

  begin
    perform public.powerhub_get_sync_snapshot(2,10,'payments');
    raise exception 'Expected cross-tenant snapshot rejection';
  exception when others then if sqlerrm <> 'SITE_OUT_OF_SCOPE' then raise; end if; end;

  if has_function_privilege('anon','public.powerhub_delta_sync_project_row(text,jsonb)','EXECUTE')
    or has_function_privilege('authenticated','public.powerhub_capture_delta_sync_change()','EXECUTE')
    or has_function_privilege('authenticated','public.powerhub_pull_sync_delta(bigint,bigint,text,bigint,bigint,integer)','EXECUTE')
    or has_table_privilege('anon','public.powerhub_sync_changes','SELECT')
    or has_table_privilege('authenticated','public.powerhub_sync_scope_state','SELECT') then
    raise exception 'Payment Delta server-only ACL boundary was weakened';
  end if;
  v_delta := public.powerhub_pull_sync_delta(1,10,'payments',null,null,200);
  if v_delta->>'status' is distinct from 'reset_required'
    or v_delta #>> '{snapshot_cursor}' is distinct from '5' then raise exception 'Payment reset-required failed: %',v_delta; end if;
end
$test$;
