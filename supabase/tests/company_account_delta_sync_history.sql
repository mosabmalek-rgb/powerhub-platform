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
\ir ../migrations/20261024140000_powerhub_delta_sync_engine.sql
\ir ../migrations/20261027110000_powerhub_delta_invoice_history.sql
\ir ../migrations/20261027130000_powerhub_delta_payment_history.sql
\ir ../migrations/20261027140000_powerhub_delta_expense_history.sql
\ir ../migrations/20261027150000_powerhub_delta_company_account_history.sql
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

 update public.company_accounts set is_active=false where id=700 and tenant_id=1;
 v_delta:=public.powerhub_pull_sync_delta(1,20,'company_accounts',0,null,200);
 if v_delta->>'status' is distinct from 'reset_required' then
   -- Cursor zero may be retained; query the actual branch cursor to assert its tombstone.
   v_cursor:=(v_snapshot->>'snapshot_cursor')::bigint;
   v_delta:=public.powerhub_pull_sync_delta(1,20,'company_accounts',v_cursor,null,200);
 end if;
 if jsonb_array_length(v_delta->'changes')<1
   or not exists(select 1 from jsonb_array_elements(v_delta->'changes') c where c->>'operation'='delete' and c->>'entity_id'='700')
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
