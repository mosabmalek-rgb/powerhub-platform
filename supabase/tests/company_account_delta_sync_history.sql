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


create table public.expenses (
 id bigint primary key, tenant_id bigint not null, site_id bigint not null, generator_id bigint,
 company_account_id bigint, category text not null, description text not null, amount numeric not null,
 occurred_at timestamptz not null default now(), reference_no text, created_by_user_id bigint,
 created_at timestamptz not null default now()
);
create table public.company_accounts (
 id bigint primary key, tenant_id bigint not null, name text not null, account_type text not null,
 phone_number text, color text, opening_balance numeric not null default 0, is_active boolean not null default true,
 allow_payment_documentation boolean not null default false, created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create table public.company_account_sites (
 tenant_id bigint not null, account_id bigint not null, site_id bigint not null,
 primary key (tenant_id,account_id,site_id)
);
create table public.account_transactions (
 id bigint primary key, tenant_id bigint not null, account_id bigint not null, transaction_type text not null,
 amount numeric not null, description text, reference_no text, related_payment_id bigint, related_account_id bigint,
 created_by_user_id bigint, occurred_at timestamptz not null default now(), created_at timestamptz not null default now()
);
create table public.inventory_items (
 id bigint primary key, tenant_id bigint not null, sku text, name text not null, category text not null,
 base_unit text not null, reorder_point numeric not null default 0, specification text, notes text,
 is_active boolean not null default true, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.inventory_item_units (
 id bigint primary key, tenant_id bigint not null, item_id bigint not null, unit_label text not null,
 factor_to_base numeric not null, is_active boolean not null default true,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.suppliers (
 id bigint primary key, tenant_id bigint not null, supplier_code text, name text not null,
 contact_name text, phone text, email text, address text, tax_number text,
 default_payment_terms_days integer not null default 0, supplier_type text not null default 'permanent',
 notes text, is_active boolean not null default true,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.inventory_warehouses (
 id bigint primary key, tenant_id bigint not null, site_id bigint not null, code text not null, name text not null,
 notes text, is_active boolean not null default true, location_type text not null default 'branch_warehouse',
 generator_id bigint, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
\ir ../migrations/20261024140000_powerhub_delta_sync_engine.sql
\ir ../migrations/20261027110000_powerhub_delta_invoice_history.sql
\ir ../migrations/20261027130000_powerhub_delta_payment_history.sql
\ir ../migrations/20261027140000_powerhub_delta_expense_history.sql
\ir ../migrations/20261027150000_powerhub_delta_company_account_history.sql
create table public.inventory_stock_movements (
 id bigint primary key, tenant_id bigint not null, site_id bigint not null, warehouse_id bigint not null, item_id bigint not null,
 generator_id bigint, movement_type text not null, quantity numeric(14,3) not null, unit_cost numeric(14,4) not null default 0,
 total_cost_amount numeric(14,2) generated always as (round(quantity * unit_cost, 2)) stored,
 purchase_id bigint, purchase_line_id bigint, reference_no text, notes text, operation_key text not null,
 occurred_at timestamptz not null default now(), created_by_user_id bigint, created_at timestamptz not null default now(),
 reversal_of_movement_id bigint, corrects_movement_id bigint, correction_reason text, corrected_by_movement_id bigint
);
-- The production correction migration installs this guard. Recreate the same trigger
-- in this isolated fixture because the test defines inventory_stock_movements locally.
create or replace function public.powerhub_inventory_reject_stock_movement_mutation()
returns trigger language plpgsql security invoker set search_path=public,pg_temp
as $stock_movement_guard$
begin
  raise exception 'INVENTORY_STOCK_MOVEMENT_IMMUTABLE'
    using errcode='P0001',detail=format('operation=%s movement_id=%s',tg_op,old.id);
end;
$stock_movement_guard$;
revoke all on function public.powerhub_inventory_reject_stock_movement_mutation() from public,anon,authenticated;
grant execute on function public.powerhub_inventory_reject_stock_movement_mutation() to service_role;
create trigger inventory_stock_movement_append_only before update or delete on public.inventory_stock_movements
for each row execute function public.powerhub_inventory_reject_stock_movement_mutation();

\ir ../migrations/20261029000000_powerhub_delta_inventory_catalog.sql
create table public.inventory_stocktakes (
  id bigint primary key, tenant_id bigint not null, site_id bigint not null, warehouse_id bigint not null,
  stocktake_number text, status text not null, reason text not null, notes text,
  operation_key text, operation_payload_hash text,
  snapshot_at timestamptz not null default now(), created_at timestamptz not null default now(),
  created_by_user_id bigint, submitted_at timestamptz, submitted_by_user_id bigint,
  posted_at timestamptz, posted_by_user_id bigint, cancelled_at timestamptz, cancelled_by_user_id bigint, cancel_reason text
);
create table public.inventory_stocktake_lines (
  id bigint primary key, tenant_id bigint not null, stocktake_id bigint not null, item_id bigint not null,
  system_quantity numeric(14,3) not null, system_value numeric(14,2) not null default 0,
  system_unit_cost numeric(14,4) not null default 0, counted_quantity numeric(14,3), counted_unit_cost numeric(14,4),
  variance_quantity numeric(14,3), count_notes text, updated_at timestamptz not null default now()
);
\ir ../migrations/20261029100000_powerhub_delta_inventory_stocktakes.sql
create table public.supplier_purchases (
  id bigint primary key, tenant_id bigint not null, site_id bigint not null, supplier_id bigint not null,
  warehouse_id bigint not null, purchase_number text not null, supplier_invoice_no text, invoice_date date not null,
  due_date date, status text not null, subtotal_amount numeric(14,2) not null default 0,
  discount_amount numeric(14,2) not null default 0, tax_amount numeric(14,2) not null default 0,
  other_charges_amount numeric(14,2) not null default 0,
  total_amount numeric(14,2) generated always as (subtotal_amount-discount_amount+tax_amount+other_charges_amount) stored,
  payment_terms_days integer not null default 0, reference_no text, notes text, operation_key text not null,
  received_at timestamptz, received_by_user_id bigint, confirmed_at timestamptz, confirmed_by_user_id bigint,
  cancelled_at timestamptz, cancelled_by_user_id bigint, created_by_user_id bigint,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.supplier_purchase_lines (
  id bigint primary key, tenant_id bigint not null, purchase_id bigint not null, item_id bigint not null,
  quantity numeric(14,3) not null, unit text not null, units_to_base_factor numeric(14,6) not null default 1,
  unit_price numeric(14,4) not null default 0, discount_amount numeric(14,2) not null default 0,
  tax_amount numeric(14,2) not null default 0, line_subtotal numeric(14,2) not null default 0,
  line_total numeric(14,2) not null default 0, received_quantity numeric(14,3) not null default 0,
  notes text, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
\ir ../migrations/20261029110000_powerhub_delta_purchase_headers.sql
do $test$
declare v_snapshot jsonb; v_delta jsonb; v_cursor bigint;
begin
 v_snapshot:=public.powerhub_get_sync_snapshot(1,10,'expenses');
 if v_snapshot->>'status' is distinct from 'ok' or jsonb_array_length(v_snapshot->'rows')<>0 then raise exception 'empty expense snapshot failed: %',v_snapshot; end if;
 insert into public.expenses(id,tenant_id,site_id,company_account_id,category,description,amount,occurred_at,reference_no,created_by_user_id)
 values(900,1,10,55,'fuel','Fuel delivery',25,timestamptz '2026-10-27 10:00:00+00','FUEL-900',7);
 select last_cursor into v_cursor from public.powerhub_sync_scope_state where tenant_id=1 and site_id=10 and entity_type='expenses';
 if v_cursor is distinct from 1 then raise exception 'expense insert cursor mismatch: %',v_cursor; end if;
 v_snapshot:=public.powerhub_get_sync_snapshot(1,10,'expenses');
 if jsonb_array_length(v_snapshot->'rows')<>1 or v_snapshot #>> '{rows,0,id}' is distinct from '900'
 or v_snapshot #>> '{rows,0,company_account_id}' is distinct from '55' or v_snapshot #>> '{rows,0,reference_no}' is distinct from 'FUEL-900'
 then raise exception 'expense snapshot projection failed: %',v_snapshot; end if;
 v_delta:=public.powerhub_pull_sync_delta(1,10,'expenses',0,null,200);
 if jsonb_array_length(v_delta->'changes')<>1 or v_delta #>> '{changes,0,operation}' is distinct from 'upsert'
 or v_delta #>> '{changes,0,row_data,amount}' is distinct from '25' then raise exception 'expense insert delta failed: %',v_delta; end if;
 update public.expenses set amount=30,category='maintenance',description='Generator repair' where id=900;
 v_delta:=public.powerhub_pull_sync_delta(1,10,'expenses',1,null,200);
 if jsonb_array_length(v_delta->'changes')<>1 or v_delta #>> '{changes,0,row_data,amount}' is distinct from '30'
 or v_delta #>> '{changes,0,row_data,category}' is distinct from 'maintenance' then raise exception 'expense update failed: %',v_delta; end if;
 delete from public.expenses where id=900;
 v_delta:=public.powerhub_pull_sync_delta(1,10,'expenses',2,null,200);
 if jsonb_array_length(v_delta->'changes')<>1 or v_delta #>> '{changes,0,operation}' is distinct from 'delete'
 or v_delta #>> '{changes,0,entity_id}' is distinct from '900' then raise exception 'expense tombstone failed: %',v_delta; end if;
 insert into public.expenses(id,tenant_id,site_id,company_account_id,category,description,amount)
 values(901,1,10,55,'fuel','Moved expense',10);
 update public.expenses set site_id=20 where id=901;
 v_delta:=public.powerhub_pull_sync_delta(1,10,'expenses',4,null,200);
 if jsonb_array_length(v_delta->'changes')<>1 or v_delta #>> '{changes,0,operation}' is distinct from 'delete'
 or v_delta #>> '{changes,0,entity_id}' is distinct from '901' then raise exception 'old-scope tombstone failed: %',v_delta; end if;
 v_snapshot:=public.powerhub_get_sync_snapshot(1,20,'expenses');
 if jsonb_array_length(v_snapshot->'rows')<>1 or v_snapshot #>> '{rows,0,id}' is distinct from '901' then raise exception 'new-scope snapshot failed: %',v_snapshot; end if;
 begin perform public.powerhub_get_sync_snapshot(2,10,'expenses'); raise exception 'expected scope rejection';
 exception when others then if sqlerrm<>'SITE_OUT_OF_SCOPE' then raise; end if; end;
 if has_function_privilege('anon','public.powerhub_delta_sync_project_row(text,jsonb)','EXECUTE')
 or has_function_privilege('authenticated','public.powerhub_pull_sync_delta(bigint,bigint,text,bigint,bigint,integer)','EXECUTE')
 or has_table_privilege('anon','public.powerhub_sync_changes','SELECT') then raise exception 'expense Delta ACL boundary weakened'; end if;
  insert into public.meter_readings(id,tenant_id,subscriber_id,reading_at)
  values (700,1,101,timestamptz '2026-10-27 10:00:00+00');
  v_snapshot := public.powerhub_get_sync_snapshot(1,10,'readings');
  if jsonb_array_length(v_snapshot->'rows') <> 1
     or v_snapshot #>> '{rows,0,reading,id}' is distinct from '700'
     or v_snapshot #>> '{rows,0,reading,site_id}' is distinct from '10' then
    raise exception 'Reading snapshot missing resolved site scope: %',v_snapshot;
  end if;
  v_delta := public.powerhub_pull_sync_delta(1,10,'readings',0,null,200);
  if jsonb_array_length(v_delta->'changes') <> 1
     or v_delta #>> '{changes,0,row_data,site_id}' is distinct from '10' then
    raise exception 'Reading upsert missing resolved site scope: %',v_delta;
  end if;
  update public.subscribers set site_id=20 where id=101;
  v_delta := public.powerhub_pull_sync_delta(1,10,'readings',1,null,200);
  if jsonb_array_length(v_delta->'changes') <> 1
     or v_delta #>> '{changes,0,operation}' is distinct from 'delete'
     or v_delta #>> '{changes,0,entity_id}' is distinct from '700' then
    raise exception 'Reading old-scope tombstone missing: %',v_delta;
  end if;
  v_snapshot := public.powerhub_get_sync_snapshot(1,20,'readings');
  if jsonb_array_length(v_snapshot->'rows') <> 1
     or v_snapshot #>> '{rows,0,reading,site_id}' is distinct from '20' then
    raise exception 'Reading destination snapshot missing site scope: %',v_snapshot;
  end if;
  v_delta := public.powerhub_pull_sync_delta(1,20,'readings',0,null,200);
  if jsonb_array_length(v_delta->'changes') <> 1
     or v_delta #>> '{changes,0,row_data,site_id}' is distinct from '20' then
    raise exception 'Reading destination upsert missing site scope: %',v_delta;
  end if;

end;
$test$;


do $company_account_test$
declare
 v_snapshot jsonb; v_delta jsonb; v_cursor bigint; v_next bigint;
begin
 insert into public.company_accounts(id,tenant_id,name,account_type,phone_number,color,opening_balance,is_active,allow_payment_documentation)
 values (700,1,'Cash box','cash','0590000000','#64748b',100,true,true);
 insert into public.company_account_sites(tenant_id,account_id,site_id) values (1,700,10),(1,700,20);

 v_snapshot:=public.powerhub_get_sync_snapshot(1,10,'company_accounts');
 if jsonb_array_length(v_snapshot->'rows')<>1
   or v_snapshot #>> '{rows,0,id}' is distinct from '700'
   or (v_snapshot #>> '{rows,0,balance}')::numeric<>100
   or v_snapshot #>> '{rows,0,linked_sites,0,site_id}' is distinct from '10'
   or v_snapshot #>> '{rows,0,linked_sites,1,site_id}' is distinct from '20'
 then raise exception 'Branch-scoped account snapshot failed: %',v_snapshot; end if;
 v_cursor:=(v_snapshot->>'snapshot_cursor')::bigint;

 v_snapshot:=public.powerhub_get_sync_snapshot(1,10,'company_accounts_all');
 if jsonb_array_length(v_snapshot->'rows')<>1
   or v_snapshot #>> '{rows,0,id}' is distinct from '700'
 then raise exception 'All-branch account snapshot failed: %',v_snapshot; end if;

 insert into public.account_transactions(id,tenant_id,account_id,transaction_type,amount,description,reference_no,occurred_at)
 values (800,1,700,'deposit',25,'Opening deposit','TX-800',timestamptz '2026-10-27 10:00:00+00');
 v_delta:=public.powerhub_pull_sync_delta(1,10,'company_accounts',v_cursor,null,200);
 if jsonb_array_length(v_delta->'changes')<>1
   or v_delta #>> '{changes,0,operation}' is distinct from 'upsert'
   or v_delta #>> '{changes,0,row_data,id}' is distinct from '700'
   or (v_delta #>> '{changes,0,row_data,balance}')::numeric<>125
   or v_delta #>> '{changes,0,row_data,transactions,0,id}' is distinct from '800'
 then raise exception 'Account ledger insert Delta failed: %',v_delta; end if;
 v_next:=(v_delta->>'next_cursor')::bigint;

 update public.account_transactions set amount=35,description='Corrected deposit' where id=800;
 v_delta:=public.powerhub_pull_sync_delta(1,10,'company_accounts',v_next,null,200);
 if jsonb_array_length(v_delta->'changes')<>1
   or v_delta #>> '{changes,0,operation}' is distinct from 'upsert'
   or (v_delta #>> '{changes,0,row_data,balance}')::numeric<>135
   or (v_delta #>> '{changes,0,row_data,transactions,0,amount}')::numeric<>35
 then raise exception 'Account ledger update Delta failed: %',v_delta; end if;
 v_next:=(v_delta->>'next_cursor')::bigint;

 delete from public.account_transactions where id=800;
 v_delta:=public.powerhub_pull_sync_delta(1,10,'company_accounts',v_next,null,200);
 if jsonb_array_length(v_delta->'changes')<>1
   or v_delta #>> '{changes,0,operation}' is distinct from 'upsert'
   or (v_delta #>> '{changes,0,row_data,balance}')::numeric<>100
   or jsonb_array_length(v_delta #> '{changes,0,row_data,transactions}')<>0
 then raise exception 'Account ledger delete Delta failed: %',v_delta; end if;
 v_next:=(v_delta->>'next_cursor')::bigint;

 delete from public.company_account_sites where tenant_id=1 and account_id=700 and site_id=10;
 v_delta:=public.powerhub_pull_sync_delta(1,10,'company_accounts',v_next,null,200);
 if jsonb_array_length(v_delta->'changes')<>1
   or v_delta #>> '{changes,0,operation}' is distinct from 'delete'
   or v_delta #>> '{changes,0,entity_id}' is distinct from '700'
 then raise exception 'Account branch-unlink tombstone failed: %',v_delta; end if;
 v_snapshot:=public.powerhub_get_sync_snapshot(1,10,'company_accounts');
 if jsonb_array_length(v_snapshot->'rows')<>0 then raise exception 'Unlinked account leaked into branch snapshot: %',v_snapshot; end if;
 v_snapshot:=public.powerhub_get_sync_snapshot(1,20,'company_accounts');
 if jsonb_array_length(v_snapshot->'rows')<>1
   or v_snapshot #>> '{rows,0,id}' is distinct from '700'
   or (v_snapshot #>> '{rows,0,balance}')::numeric<>100
 then raise exception 'Account remained missing from its still-linked branch: %',v_snapshot; end if;

 v_cursor:=(v_snapshot->>'snapshot_cursor')::bigint;
 update public.company_accounts set is_active=false where id=700 and tenant_id=1;
 v_delta:=public.powerhub_pull_sync_delta(1,20,'company_accounts',v_cursor,null,200);
 if jsonb_array_length(v_delta->'changes')<1
   or not exists(select 1 from jsonb_array_elements(v_delta->'changes') as c(value) where value->>'operation'='delete' and value->>'entity_id'='700')
 then raise exception 'Inactive account tombstone failed: %',v_delta; end if;

 begin
   perform public.powerhub_get_sync_snapshot(2,10,'company_accounts');
   raise exception 'Expected account snapshot to reject a cross-tenant site';
 exception when others then if sqlerrm<>'SITE_OUT_OF_SCOPE' then raise; end if; end;

 if has_function_privilege('anon','public.powerhub_delta_sync_project_company_account(bigint,bigint,bigint)','EXECUTE')
   or has_function_privilege('authenticated','public.powerhub_capture_company_account_delta_sync_change()','EXECUTE')
   or has_function_privilege('authenticated','public.powerhub_pull_sync_delta(bigint,bigint,text,bigint,bigint,integer)','EXECUTE')
   or has_table_privilege('anon','public.powerhub_sync_changes','SELECT')
   or has_table_privilege('authenticated','public.powerhub_sync_scope_state','SELECT')
 then raise exception 'Company-account Delta server-only ACL boundary was weakened'; end if;
 if not has_function_privilege('service_role','public.powerhub_delta_sync_project_company_account(bigint,bigint,bigint)','EXECUTE')
   or not has_function_privilege('service_role','public.powerhub_pull_sync_delta(bigint,bigint,text,bigint,bigint,integer)','EXECUTE')
 then raise exception 'service_role cannot execute company-account Delta functions'; end if;
end;
$company_account_test$;

-- Updating an existing branch link must remove the old scoped copy, publish
-- the new scoped copy, and refresh the tenant-wide feed without a full reload.
do $company_account_link_move_test$
declare
  v_snapshot jsonb;
  v_delta jsonb;
  v_site20_cursor bigint;
  v_site40_cursor bigint;
  v_all_cursor bigint;
begin
  insert into public.sites(id,tenant_id,name) values (40,1,'Move Test Destination');
  insert into public.company_accounts(id,tenant_id,name,account_type,opening_balance,is_active)
  values (701,1,'Move Test Account','cash',10,true);
  insert into public.company_account_sites(tenant_id,account_id,site_id)
  values (1,701,20);

  v_snapshot := public.powerhub_get_sync_snapshot(1,20,'company_accounts');
  if not exists (
    select 1 from jsonb_array_elements(v_snapshot->'rows') row_value
    where row_value->>'id'='701'
  ) then
    raise exception 'Move test setup failed: source branch does not contain account';
  end if;
  v_site20_cursor := (v_snapshot->>'snapshot_cursor')::bigint;

  v_snapshot := public.powerhub_get_sync_snapshot(1,40,'company_accounts');
  if jsonb_array_length(v_snapshot->'rows')<>0 then
    raise exception 'Move test setup failed: destination branch already contains account';
  end if;
  v_site40_cursor := (v_snapshot->>'snapshot_cursor')::bigint;

  v_snapshot := public.powerhub_get_sync_snapshot(1,10,'company_accounts_all');
  if not exists (
    select 1 from jsonb_array_elements(v_snapshot->'rows') row_value
    where row_value->>'id'='701'
  ) then
    raise exception 'Move test setup failed: all-branches feed lacks account';
  end if;
  v_all_cursor := (v_snapshot->>'snapshot_cursor')::bigint;

  update public.company_account_sites
  set site_id=40
  where tenant_id=1 and account_id=701 and site_id=20;

  v_delta := public.powerhub_pull_sync_delta(1,20,'company_accounts',v_site20_cursor,null,200);
  if jsonb_array_length(v_delta->'changes')<>1
     or v_delta #>> '{changes,0,operation}' is distinct from 'delete'
     or v_delta #>> '{changes,0,entity_id}' is distinct from '701' then
    raise exception 'Branch-link move did not tombstone the source branch: %',v_delta;
  end if;

  v_delta := public.powerhub_pull_sync_delta(1,40,'company_accounts',v_site40_cursor,null,200);
  if jsonb_array_length(v_delta->'changes')<>1
     or v_delta #>> '{changes,0,operation}' is distinct from 'upsert'
     or v_delta #>> '{changes,0,row_data,id}' is distinct from '701'
     or v_delta #>> '{changes,0,row_data,site_id}' is distinct from '40' then
    raise exception 'Branch-link move did not publish the destination upsert: %',v_delta;
  end if;

  v_snapshot := public.powerhub_get_sync_snapshot(1,20,'company_accounts');
  if exists (
    select 1 from jsonb_array_elements(v_snapshot->'rows') row_value
    where row_value->>'id'='701'
  ) then
    raise exception 'Moved account remained visible in the source branch snapshot';
  end if;
  v_snapshot := public.powerhub_get_sync_snapshot(1,40,'company_accounts');
  if not exists (
    select 1 from jsonb_array_elements(v_snapshot->'rows') row_value
    where row_value->>'id'='701'
  ) then
    raise exception 'Moved account missing from destination branch snapshot';
  end if;

  v_delta := public.powerhub_pull_sync_delta(1,10,'company_accounts_all',v_all_cursor,null,200);
  if jsonb_array_length(v_delta->'changes')<>1
     or v_delta #>> '{changes,0,operation}' is distinct from 'upsert'
     or v_delta #>> '{changes,0,row_data,id}' is distinct from '701' then
    raise exception 'Branch-link move did not refresh the all-branches feed: %',v_delta;
  end if;
end;
$company_account_link_move_test$;

-- Inventory catalog Delta: tenant-wide catalog changes must reach each tenant site;
-- warehouse changes are branch-scoped and inactive rows must emit tombstones.
do $inventory_catalog_delta_test$
declare
  v_snapshot jsonb;
  v_delta jsonb;
  v_cursor10 bigint;
  v_cursor20 bigint;
begin
  insert into public.inventory_items(id,tenant_id,sku,name,category,base_unit,reorder_point,is_active)
  values (1101,1,'SKU-1101','Diesel','fuel','liter',10,true);
  v_snapshot:=public.powerhub_get_inventory_sync_snapshot(1,10,'inventory_items');
  if jsonb_array_length(v_snapshot->'rows')<>1 or v_snapshot #>> '{rows,0,id}' is distinct from '1101' then
    raise exception 'Inventory item snapshot failed: %',v_snapshot;
  end if;
  v_snapshot:=public.powerhub_get_inventory_sync_snapshot(1,20,'inventory_items');
  if jsonb_array_length(v_snapshot->'rows')<>1 or v_snapshot #>> '{rows,0,id}' is distinct from '1101' then
    raise exception 'Tenant-wide inventory item did not reach second site: %',v_snapshot;
  end if;
  v_cursor10:=(v_snapshot->>'snapshot_cursor')::bigint;
  update public.inventory_items set is_active=false where tenant_id=1 and id=1101;
  v_delta:=public.powerhub_pull_inventory_sync_delta(1,20,'inventory_items',v_cursor10,null,200);
  if jsonb_array_length(v_delta->'changes')<>1
     or v_delta #>> '{changes,0,operation}' is distinct from 'delete'
     or v_delta #>> '{changes,0,entity_id}' is distinct from '1101' then
    raise exception 'Inactive item tombstone failed: %',v_delta;
  end if;

  update public.inventory_items set is_active=true where tenant_id=1 and id=1101;
  insert into public.inventory_item_units(id,tenant_id,item_id,unit_label,factor_to_base,is_active)
  values (1201,1,1101,'barrel',200,true);
  v_snapshot:=public.powerhub_get_inventory_sync_snapshot(1,10,'inventory_item_units');
  if jsonb_array_length(v_snapshot->'rows')<>1
     or v_snapshot #>> '{rows,0,item_id}' is distinct from '1101'
     or v_snapshot #>> '{rows,0,id}' is distinct from '1201' then
    raise exception 'Inventory item-unit snapshot failed: %',v_snapshot;
  end if;
  v_delta:=public.powerhub_pull_inventory_sync_delta(1,20,'inventory_item_units',0,null,200);
  if jsonb_array_length(v_delta->'changes')<>1
     or v_delta #>> '{changes,0,operation}' is distinct from 'upsert'
     or v_delta #>> '{changes,0,row_data,factor_to_base}' is distinct from '200' then
    raise exception 'Inventory item-unit Delta failed: %',v_delta;
  end if;
  update public.inventory_item_units set is_active=false where tenant_id=1 and id=1201;
  v_delta:=public.powerhub_pull_inventory_sync_delta(1,20,'inventory_item_units',1,null,200);
  if jsonb_array_length(v_delta->'changes')<>1
     or v_delta #>> '{changes,0,operation}' is distinct from 'delete'
     or v_delta #>> '{changes,0,entity_id}' is distinct from '1201' then
    raise exception 'Inactive item-unit tombstone failed: %',v_delta;
  end if;

  insert into public.suppliers(id,tenant_id,supplier_code,name,supplier_type,is_active)
  values (1301,1,'SUP-1301','Supplier Delta Test','permanent',true);
  v_snapshot:=public.powerhub_get_inventory_sync_snapshot(1,10,'suppliers');
  if jsonb_array_length(v_snapshot->'rows')<>1
     or v_snapshot #>> '{rows,0,id}' is distinct from '1301'
     or v_snapshot #>> '{rows,0,supplier_type}' is distinct from 'permanent' then
    raise exception 'Supplier catalog snapshot failed: %',v_snapshot;
  end if;

  insert into public.inventory_warehouses(id,tenant_id,site_id,code,name,is_active)
  values (1401,1,10,'WH-1401','Branch Warehouse',true);
  v_snapshot:=public.powerhub_get_inventory_sync_snapshot(1,10,'inventory_warehouses');
  if jsonb_array_length(v_snapshot->'rows')<>1 or v_snapshot #>> '{rows,0,id}' is distinct from '1401' then
    raise exception 'Warehouse snapshot failed: %',v_snapshot;
  end if;
  v_cursor10:=(v_snapshot->>'snapshot_cursor')::bigint;
  v_snapshot:=public.powerhub_get_inventory_sync_snapshot(1,20,'inventory_warehouses');
  if jsonb_array_length(v_snapshot->'rows')<>0 then
    raise exception 'Warehouse leaked into unrelated branch: %',v_snapshot;
  end if;
  v_cursor20:=(v_snapshot->>'snapshot_cursor')::bigint;
  update public.inventory_warehouses set site_id=20 where tenant_id=1 and id=1401;
  v_delta:=public.powerhub_pull_inventory_sync_delta(1,10,'inventory_warehouses',v_cursor10,null,200);
  if jsonb_array_length(v_delta->'changes')<>1 or v_delta #>> '{changes,0,operation}' is distinct from 'delete' then
    raise exception 'Warehouse move did not tombstone old branch: %',v_delta;
  end if;
  v_delta:=public.powerhub_pull_inventory_sync_delta(1,20,'inventory_warehouses',v_cursor20,null,200);
  if jsonb_array_length(v_delta->'changes')<>1
     or v_delta #>> '{changes,0,operation}' is distinct from 'upsert'
     or v_delta #>> '{changes,0,row_data,site_id}' is distinct from '20' then
    raise exception 'Warehouse move did not publish new branch: %',v_delta;
  end if;

  begin
    perform public.powerhub_get_inventory_sync_snapshot(2,10,'inventory_items');
    raise exception 'Expected inventory snapshot to reject cross-tenant site';
  exception when others then if sqlerrm<>'SITE_OUT_OF_SCOPE' then raise; end if; end;

  if has_function_privilege('anon','public.powerhub_get_inventory_sync_snapshot(bigint,bigint,text)','EXECUTE')
     or has_function_privilege('authenticated','public.powerhub_pull_inventory_sync_delta(bigint,bigint,text,bigint,bigint,integer)','EXECUTE')
     or has_function_privilege('authenticated','public.powerhub_append_inventory_sync_change(bigint,bigint,text,text,text,jsonb)','EXECUTE')
     or has_table_privilege('anon','public.powerhub_sync_changes','SELECT')
     or has_table_privilege('authenticated','public.powerhub_sync_scope_state','SELECT') then
    raise exception 'Inventory Delta server-only ACL boundary was weakened';
  end if;
  if not has_function_privilege('service_role','public.powerhub_get_inventory_sync_snapshot(bigint,bigint,text)','EXECUTE')
     or not has_function_privilege('service_role','public.powerhub_pull_inventory_sync_delta(bigint,bigint,text,bigint,bigint,integer)','EXECUTE') then
    raise exception 'service_role cannot execute inventory Delta functions';
  end if;
end;
$inventory_catalog_delta_test$;

-- Non-financial stock movement Delta is site-scoped and never projects costs.
do $inventory_movement_delta_test$
declare v_snapshot jsonb; v_delta jsonb; v_cursor bigint;
begin
  insert into public.inventory_items(id,tenant_id,sku,name,category,base_unit,reorder_point,is_active)
  values (2101,1,'SKU-2101','Diesel Movement','fuel','liter',0,true);
  insert into public.inventory_warehouses(id,tenant_id,site_id,code,name,is_active)
  values (2201,1,10,'WH-2201','Movement Warehouse',true);
  v_snapshot:=public.powerhub_get_inventory_sync_snapshot(1,10,'inventory_stock_movements');
  if jsonb_array_length(v_snapshot->'rows')<>0 then raise exception 'Expected empty stock movement snapshot: %',v_snapshot; end if;
  insert into public.inventory_stock_movements(
    id,tenant_id,site_id,warehouse_id,item_id,movement_type,quantity,unit_cost,reference_no,operation_key
  ) values (2301,1,10,2201,2101,'issue',2.500,3.5000,'ISS-2301','movement-test-2301');
  select last_cursor into v_cursor from public.powerhub_sync_scope_state
    where tenant_id=1 and site_id=10 and entity_type='inventory_stock_movements';
  if v_cursor is distinct from 1 then raise exception 'Stock movement Delta cursor mismatch: %',v_cursor; end if;
  v_delta:=public.powerhub_pull_inventory_sync_delta(1,10,'inventory_stock_movements',0,null,200);
  if jsonb_array_length(v_delta->'changes')<>1
     or v_delta #>> '{changes,0,entity_id}' is distinct from '2301'
     or v_delta #>> '{changes,0,row_data,movement_id}' is distinct from '2301'
     or v_delta #>> '{changes,0,row_data,quantity}' is distinct from '2.500'
     or (v_delta #> '{changes,0,row_data}') ? 'unit_cost'
     or (v_delta #> '{changes,0,row_data}') ? 'total_cost_amount' then
    raise exception 'Stock movement Delta projection failed or exposed financial values: %',v_delta;
  end if;
  -- Direct mutation/deletion must be blocked before it can bypass the append-only ledger.
  begin
    update public.inventory_stock_movements set quantity=99 where id=2301;
    raise exception 'Expected direct stock movement update to be blocked' using errcode='P9999';
  exception when sqlstate 'P0001' then
    if sqlerrm<>'INVENTORY_STOCK_MOVEMENT_IMMUTABLE' then raise; end if;
  end;
  begin
    delete from public.inventory_stock_movements where id=2301;
    raise exception 'Expected direct stock movement delete to be blocked' using errcode='P9999';
  exception when sqlstate 'P0001' then
    if sqlerrm<>'INVENTORY_STOCK_MOVEMENT_IMMUTABLE' then raise; end if;
  end;
  if not exists(select 1 from public.inventory_stock_movements
    where id=2301 and quantity=2.500 and corrected_by_movement_id is null) then
    raise exception 'Append-only guard did not preserve the original movement';
  end if;
  select last_cursor into v_cursor from public.powerhub_sync_scope_state
    where tenant_id=1 and site_id=10 and entity_type='inventory_stock_movements';
  if v_cursor is distinct from 1 then
    raise exception 'Rejected update/delete changed the Delta cursor: %',v_cursor;
  end if;
  v_delta:=public.powerhub_pull_inventory_sync_delta(1,10,'inventory_stock_movements',1,null,200);
  if jsonb_array_length(v_delta->'changes')<>0 then
    raise exception 'Rejected update/delete unexpectedly produced Delta changes: %',v_delta;
  end if;

  -- Mimic the immutable correction workflow: insert a reversal, then ensure the original
  -- projection is emitted again with its derived corrected_by_movement_id.
  insert into public.inventory_stock_movements(
    id,tenant_id,site_id,warehouse_id,item_id,movement_type,quantity,unit_cost,
    reference_no,operation_key,reversal_of_movement_id,correction_reason
  ) values (2302,1,10,2201,2101,'adjustment_in',2.500,3.5000,
    'CORR-2301','movement-test-2301:reversal',2301,'test correction');
  v_delta:=public.powerhub_pull_inventory_sync_delta(1,10,'inventory_stock_movements',1,null,200);
  if jsonb_array_length(v_delta->'changes')<>2
     or v_delta #>> '{changes,0,entity_id}' is distinct from '2302'
     or v_delta #>> '{changes,1,entity_id}' is distinct from '2301'
     or v_delta #>> '{changes,1,row_data,corrected_by_movement_id}' is distinct from '2302'
     or (v_delta #> '{changes,0,row_data}') ? 'unit_cost'
     or (v_delta #> '{changes,1,row_data}') ? 'unit_cost' then
    raise exception 'Stock movement correction metadata did not reach Delta safely: %',v_delta;
  end if;
  v_snapshot:=public.powerhub_get_inventory_sync_snapshot(1,10,'inventory_stock_movements');
  if jsonb_array_length(v_snapshot->'rows')<>2
     or (v_snapshot #> '{rows,0}') ? 'unit_cost'
     or (v_snapshot #> '{rows,0}') ? 'total_cost_amount'
     or v_snapshot #>> '{rows,1,corrected_by_movement_id}' is distinct from '2302' then
    raise exception 'Stock movement snapshot failed or exposed financial values: %',v_snapshot;
  end if;
  v_snapshot:=public.powerhub_get_inventory_sync_snapshot(1,20,'inventory_stock_movements');
  if jsonb_array_length(v_snapshot->'rows')<>0 then
    raise exception 'Stock movement leaked to another branch: %',v_snapshot;
  end if;
  if has_function_privilege('anon','public.powerhub_get_inventory_sync_snapshot(bigint,bigint,text)','EXECUTE')
     or has_function_privilege('authenticated','public.powerhub_pull_inventory_sync_delta(bigint,bigint,text,bigint,bigint,integer)','EXECUTE')
     or not has_function_privilege('service_role','public.powerhub_pull_inventory_sync_delta(bigint,bigint,text,bigint,bigint,integer)','EXECUTE') then
    raise exception 'Stock movement Delta server-only ACL boundary was weakened';
  end if;
end;
$inventory_movement_delta_test$;


-- Stocktake Delta projects scoped headers and safe aggregate counters only.
do $inventory_stocktake_delta_test$
declare v_snapshot jsonb; v_delta jsonb; v_cursor bigint;
begin
  insert into public.inventory_warehouses(id,tenant_id,site_id,code,name,is_active,location_type)
  values (2202,1,20,'WH-2202','Site Two Warehouse',true,'branch_warehouse');
  v_snapshot:=public.powerhub_get_inventory_sync_snapshot(1,10,'inventory_stocktakes');
  if jsonb_array_length(v_snapshot->'rows')<>0 or v_snapshot #>> '{snapshot_cursor}' is distinct from '0' then
    raise exception 'Initial stocktake snapshot/cursor failed: %',v_snapshot;
  end if;
  insert into public.inventory_stocktakes(id,tenant_id,site_id,warehouse_id,stocktake_number,status,reason,notes,operation_key,operation_payload_hash)
  values (2401,1,10,2201,'ST-2401','counting','Routine count','Initial count','test-stocktake-2401','hash-2401');
  select last_cursor into v_cursor from public.powerhub_sync_scope_state where tenant_id=1 and site_id=10 and entity_type='inventory_stocktakes';
  if v_cursor is distinct from 1 then raise exception 'Stocktake insert cursor mismatch: %',v_cursor; end if;
  v_delta:=public.powerhub_pull_inventory_sync_delta(1,10,'inventory_stocktakes',0,null,200);
  if jsonb_array_length(v_delta->'changes')<>1
     or v_delta #>> '{changes,0,entity_id}' is distinct from '2401'
     or v_delta #>> '{changes,0,row_data,stocktake_id}' is distinct from '2401'
     or v_delta #>> '{changes,0,row_data,item_count}' is distinct from '0'
     or (v_delta #> '{changes,0,row_data}') ? 'system_value'
     or (v_delta #> '{changes,0,row_data}') ? 'system_unit_cost' then
    raise exception 'Stocktake header projection failed or exposed line values: %',v_delta;
  end if;
  insert into public.inventory_stocktake_lines(id,tenant_id,stocktake_id,item_id,system_quantity,system_value,system_unit_cost,counted_quantity,variance_quantity)
  values (2501,1,2401,2101,10,30,3,null,null);
  v_delta:=public.powerhub_pull_inventory_sync_delta(1,10,'inventory_stocktakes',1,null,200);
  if jsonb_array_length(v_delta->'changes')<>1
     or v_delta #>> '{changes,0,row_data,item_count}' is distinct from '1'
     or v_delta #>> '{changes,0,row_data,counted_count}' is distinct from '0' then
    raise exception 'Stocktake line insert failed to refresh counts: %',v_delta;
  end if;
  update public.inventory_stocktake_lines set counted_quantity=15,variance_quantity=5,updated_at=now()
    where tenant_id=1 and stocktake_id=2401 and id=2501;
  v_delta:=public.powerhub_pull_inventory_sync_delta(1,10,'inventory_stocktakes',2,null,200);
  if jsonb_array_length(v_delta->'changes')<>1
     or v_delta #>> '{changes,0,row_data,counted_count}' is distinct from '1'
     or v_delta #>> '{changes,0,row_data,variance_count}' is distinct from '1'
     or v_delta #>> '{changes,0,row_data,variance_quantity}' is distinct from '5.000' then
    raise exception 'Stocktake count update failed to refresh safe counters: %',v_delta;
  end if;
  update public.inventory_warehouses set name='Renamed Warehouse' where tenant_id=1 and site_id=10 and id=2201;
  v_delta:=public.powerhub_pull_inventory_sync_delta(1,10,'inventory_stocktakes',3,null,200);
  if jsonb_array_length(v_delta->'changes')<>1 or v_delta #>> '{changes,0,row_data,warehouse_name}' is distinct from 'Renamed Warehouse' then
    raise exception 'Warehouse rename did not refresh stocktake projection: %',v_delta;
  end if;
  insert into public.inventory_stocktakes(id,tenant_id,site_id,warehouse_id,stocktake_number,status,reason,notes,operation_key,operation_payload_hash)
  values (2402,1,10,2201,'ST-2402','counting','Second count',null,'test-stocktake-2402','hash-2402');
  v_delta:=public.powerhub_pull_inventory_sync_delta(1,10,'inventory_stocktakes',4,null,200);
  if jsonb_array_length(v_delta->'changes')<>1 or v_delta #>> '{changes,0,entity_id}' is distinct from '2402' then
    raise exception 'Second stocktake insert Delta failed: %',v_delta;
  end if;
  delete from public.inventory_stocktakes where tenant_id=1 and site_id=10 and id=2402;
  v_delta:=public.powerhub_pull_inventory_sync_delta(1,10,'inventory_stocktakes',5,null,200);
  if jsonb_array_length(v_delta->'changes')<>1 or v_delta #>> '{changes,0,operation}' is distinct from 'delete'
     or v_delta #>> '{changes,0,entity_id}' is distinct from '2402'
     or v_delta #> '{changes,0,row_data}' is distinct from 'null'::jsonb then
    raise exception 'Stocktake delete tombstone failed: %',v_delta;
  end if;
  update public.inventory_stocktakes set site_id=20,warehouse_id=2202 where tenant_id=1 and site_id=10 and id=2401;
  v_delta:=public.powerhub_pull_inventory_sync_delta(1,10,'inventory_stocktakes',6,null,200);
  if jsonb_array_length(v_delta->'changes')<>1 or v_delta #>> '{changes,0,operation}' is distinct from 'delete'
     or v_delta #>> '{changes,0,entity_id}' is distinct from '2401' then
    raise exception 'Stocktake branch move did not tombstone old scope: %',v_delta;
  end if;
  v_snapshot:=public.powerhub_get_inventory_sync_snapshot(1,10,'inventory_stocktakes');
  if jsonb_array_length(v_snapshot->'rows')<>0 then raise exception 'Moved stocktake leaked to old branch: %',v_snapshot; end if;
  v_snapshot:=public.powerhub_get_inventory_sync_snapshot(1,20,'inventory_stocktakes');
  if jsonb_array_length(v_snapshot->'rows')<>1 or v_snapshot #>> '{rows,0,stocktake_id}' is distinct from '2401'
     or v_snapshot #>> '{rows,0,warehouse_name}' is distinct from 'Site Two Warehouse' then
    raise exception 'Moved stocktake missing from new branch snapshot: %',v_snapshot;
  end if;
  v_delta:=public.powerhub_pull_inventory_sync_delta(1,20,'inventory_stocktakes',0,null,200);
  if jsonb_array_length(v_delta->'changes')<>1 or v_delta #>> '{changes,0,operation}' is distinct from 'upsert'
     or v_delta #>> '{changes,0,row_data,site_id}' is distinct from '20' then
    raise exception 'Stocktake new-scope upsert failed: %',v_delta;
  end if;
  begin
    perform public.powerhub_get_inventory_sync_snapshot(2,10,'inventory_stocktakes');
    raise exception 'Expected cross-tenant stocktake snapshot denial';
  exception when others then if sqlerrm<>'SITE_OUT_OF_SCOPE' then raise; end if; end;
  if has_function_privilege('anon','public.powerhub_get_inventory_sync_snapshot(bigint,bigint,text)','EXECUTE')
     or has_function_privilege('authenticated','public.powerhub_pull_inventory_sync_delta(bigint,bigint,text,bigint,bigint,integer)','EXECUTE')
     or has_function_privilege('anon','public.powerhub_append_inventory_sync_change(bigint,bigint,text,text,text,jsonb)','EXECUTE')
     or has_table_privilege('anon','public.inventory_stocktakes','SELECT')
     or has_table_privilege('authenticated','public.inventory_stocktake_lines','SELECT') then
    raise exception 'Stocktake Delta server-only ACL boundary weakened';
  end if;
  if not has_function_privilege('service_role','public.powerhub_get_inventory_sync_snapshot(bigint,bigint,text)','EXECUTE')
     or not has_function_privilege('service_role','public.powerhub_pull_inventory_sync_delta(bigint,bigint,text,bigint,bigint,integer)','EXECUTE') then
    raise exception 'service_role cannot execute stocktake Delta functions';
  end if;
end;
$inventory_stocktake_delta_test$;


-- Operational purchase-header Delta excludes all financial and payment-sensitive fields.
do $inventory_purchase_header_delta_test$
declare v_snapshot jsonb; v_delta jsonb; v_cursor bigint;
begin
  insert into public.suppliers(id,tenant_id,supplier_code,name,is_active)
  values (7701,1,'SUP-7701','Supplier Header Test',true);
  insert into public.inventory_warehouses(id,tenant_id,site_id,code,name,is_active,location_type)
  values (7701,1,10,'WH-7701','Purchase Header Warehouse',true,'branch_warehouse'),
         (7702,1,20,'WH-7702','Second Branch Warehouse',true,'branch_warehouse');

  v_snapshot:=public.powerhub_get_inventory_sync_snapshot(1,10,'inventory_purchase_headers');
  if jsonb_array_length(v_snapshot->'rows')<>0 or v_snapshot #>> '{snapshot_cursor}' is distinct from '0' then
    raise exception 'Initial purchase-header snapshot failed: %',v_snapshot;
  end if;

  insert into public.supplier_purchases(id,tenant_id,site_id,supplier_id,warehouse_id,purchase_number,supplier_invoice_no,invoice_date,due_date,status,subtotal_amount,discount_amount,tax_amount,other_charges_amount,payment_terms_days,reference_no,notes,operation_key)
  values (8801,1,10,7701,7701,'PUR-8801','SUP-SECRET-INV',date '2026-10-29',date '2026-11-30','draft',1000,10,0,0,30,'FIN-REF-8801','private financial notes','purchase-header-test-8801');
  v_snapshot:=public.powerhub_get_inventory_sync_snapshot(1,10,'inventory_purchase_headers');
  if jsonb_array_length(v_snapshot->'rows')<>0 or (v_snapshot->>'snapshot_cursor') is distinct from '0' then
    raise exception 'Draft purchase must not enter operational header feed: %',v_snapshot;
  end if;

  update public.supplier_purchases set status='confirmed',confirmed_at=now(),confirmed_by_user_id=7,updated_at=now()
   where tenant_id=1 and site_id=10 and id=8801;
  select last_cursor into v_cursor from public.powerhub_sync_scope_state where tenant_id=1 and site_id=10 and entity_type='inventory_purchase_headers';
  if v_cursor is distinct from 1 then raise exception 'Confirmed purchase cursor mismatch: %',v_cursor; end if;
  v_delta:=public.powerhub_pull_inventory_sync_delta(1,10,'inventory_purchase_headers',0,null,200);
  if jsonb_array_length(v_delta->'changes')<>1
     or v_delta #>> '{changes,0,entity_id}' is distinct from '8801'
     or v_delta #>> '{changes,0,row_data,purchase_number}' is distinct from 'PUR-8801'
     or v_delta #>> '{changes,0,row_data,supplier_name}' is distinct from 'Supplier Header Test'
     or (v_delta #> '{changes,0,row_data}') ? 'total_amount'
     or (v_delta #> '{changes,0,row_data}') ? 'subtotal_amount'
     or (v_delta #> '{changes,0,row_data}') ? 'supplier_invoice_no'
     or (v_delta #> '{changes,0,row_data}') ? 'due_date'
     or (v_delta #> '{changes,0,row_data}') ? 'payment_terms_days'
     or (v_delta #> '{changes,0,row_data}') ? 'reference_no'
     or (v_delta #> '{changes,0,row_data}') ? 'notes' then
    raise exception 'Purchase header Delta exposed sensitive fields or omitted safe fields: %',v_delta;
  end if;

  insert into public.supplier_purchase_lines(id,tenant_id,purchase_id,item_id,quantity,unit,units_to_base_factor,received_quantity)
  values (8901,1,8801,2101,5,'piece',1,0);
  v_delta:=public.powerhub_pull_inventory_sync_delta(1,10,'inventory_purchase_headers',1,null,200);
  if jsonb_array_length(v_delta->'changes')<>1
     or v_delta #>> '{changes,0,row_data,item_count}' is distinct from '1'
     or v_delta #>> '{changes,0,row_data,received_line_count}' is distinct from '0' then
    raise exception 'Purchase line insert did not refresh safe counters: %',v_delta;
  end if;

  update public.supplier_purchase_lines set received_quantity=2,updated_at=now()
   where tenant_id=1 and purchase_id=8801 and id=8901;
  v_delta:=public.powerhub_pull_inventory_sync_delta(1,10,'inventory_purchase_headers',2,null,200);
  if jsonb_array_length(v_delta->'changes')<>1 or v_delta #>> '{changes,0,row_data,received_line_count}' is distinct from '1' then
    raise exception 'Receipt quantity update did not refresh purchase header: %',v_delta;
  end if;

  update public.suppliers set name='Renamed Header Supplier',supplier_code='SUP-7701A' where tenant_id=1 and id=7701;
  v_delta:=public.powerhub_pull_inventory_sync_delta(1,10,'inventory_purchase_headers',3,null,200);
  if jsonb_array_length(v_delta->'changes')<>1
     or v_delta #>> '{changes,0,row_data,supplier_name}' is distinct from 'Renamed Header Supplier'
     or v_delta #>> '{changes,0,row_data,supplier_code}' is distinct from 'SUP-7701A' then
    raise exception 'Supplier update failed to refresh purchase header projection: %',v_delta;
  end if;

  update public.inventory_warehouses set name='Renamed Purchase Warehouse' where tenant_id=1 and site_id=10 and id=7701;
  v_delta:=public.powerhub_pull_inventory_sync_delta(1,10,'inventory_purchase_headers',4,null,200);
  if jsonb_array_length(v_delta->'changes')<>1 or v_delta #>> '{changes,0,row_data,warehouse_name}' is distinct from 'Renamed Purchase Warehouse' then
    raise exception 'Warehouse rename failed to refresh purchase header projection: %',v_delta;
  end if;

  update public.supplier_purchases set site_id=20,warehouse_id=7702,updated_at=now() where tenant_id=1 and site_id=10 and id=8801;
  v_delta:=public.powerhub_pull_inventory_sync_delta(1,10,'inventory_purchase_headers',5,null,200);
  if jsonb_array_length(v_delta->'changes')<>1 or v_delta #>> '{changes,0,operation}' is distinct from 'delete'
     or v_delta #>> '{changes,0,entity_id}' is distinct from '8801' then
    raise exception 'Purchase branch move did not tombstone old branch: %',v_delta;
  end if;
  v_snapshot:=public.powerhub_get_inventory_sync_snapshot(1,10,'inventory_purchase_headers');
  if jsonb_array_length(v_snapshot->'rows')<>0 then raise exception 'Moved purchase leaked into old branch: %',v_snapshot; end if;
  v_snapshot:=public.powerhub_get_inventory_sync_snapshot(1,20,'inventory_purchase_headers');
  if jsonb_array_length(v_snapshot->'rows')<>1
     or v_snapshot #>> '{rows,0,purchase_number}' is distinct from 'PUR-8801'
     or v_snapshot #>> '{rows,0,warehouse_name}' is distinct from 'Second Branch Warehouse' then
    raise exception 'Moved purchase missing from new branch snapshot: %',v_snapshot;
  end if;
  v_delta:=public.powerhub_pull_inventory_sync_delta(1,20,'inventory_purchase_headers',0,null,200);
  if jsonb_array_length(v_delta->'changes')<>1 or v_delta #>> '{changes,0,operation}' is distinct from 'upsert'
     or v_delta #>> '{changes,0,row_data,site_id}' is distinct from '20' then
    raise exception 'Purchase move did not create the new branch upsert: %',v_delta;
  end if;

  update public.supplier_purchases set status='cancelled',cancelled_at=now(),cancelled_by_user_id=7,updated_at=now()
   where tenant_id=1 and site_id=20 and id=8801;
  v_delta:=public.powerhub_pull_inventory_sync_delta(1,20,'inventory_purchase_headers',1,null,200);
  if jsonb_array_length(v_delta->'changes')<>1
     or v_delta #>> '{changes,0,operation}' is distinct from 'delete'
     or v_delta #>> '{changes,0,entity_id}' is distinct from '8801' then
    raise exception 'Cancelled purchase did not create a tombstone: %',v_delta;
  end if;

  begin
    perform public.powerhub_get_inventory_sync_snapshot(2,10,'inventory_purchase_headers');
    raise exception 'Expected cross-tenant purchase header snapshot denial';
  exception when others then if sqlerrm<>'SITE_OUT_OF_SCOPE' then raise; end if; end;

  if has_function_privilege('anon','public.powerhub_get_inventory_sync_snapshot(bigint,bigint,text)','EXECUTE')
     or has_function_privilege('authenticated','public.powerhub_pull_inventory_sync_delta(bigint,bigint,text,bigint,bigint,integer)','EXECUTE')
     or has_table_privilege('anon','public.supplier_purchases','SELECT')
     or has_table_privilege('authenticated','public.supplier_purchase_lines','SELECT') then
    raise exception 'Purchase-header Delta server-only ACL boundary was weakened';
  end if;
  if not has_function_privilege('service_role','public.powerhub_get_inventory_sync_snapshot(bigint,bigint,text)','EXECUTE')
     or not has_function_privilege('service_role','public.powerhub_pull_inventory_sync_delta(bigint,bigint,text,bigint,bigint,integer)','EXECUTE') then
    raise exception 'service_role cannot execute purchase-header Delta functions';
  end if;
end;
$inventory_purchase_header_delta_test$;
