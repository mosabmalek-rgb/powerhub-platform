\set ON_ERROR_STOP on

-- The purchase workflow integration has already created a scoped inventory fixture
-- and the server-only cursor metadata table in this disposable database. Its
-- supplier-ledger revision row is unrelated to the Delta table constraints below.
delete from public.powerhub_sync_scope_state where entity_type='supplier_ledger';

create table if not exists public.powerhub_sync_changes (
  tenant_id bigint not null,
  site_id bigint not null,
  entity_type text not null,
  cursor bigint not null check (cursor>0),
  entity_id text not null check (length(entity_id) between 1 and 100),
  change_type text not null check (change_type in ('upsert','delete')),
  row_data jsonb,
  changed_at timestamptz not null default clock_timestamp(),
  primary key (tenant_id,site_id,entity_type,cursor),
  check ((change_type='upsert' and row_data is not null) or (change_type='delete' and row_data is null))
);
create index if not exists powerhub_sync_changes_entity_idx
  on public.powerhub_sync_changes(tenant_id,site_id,entity_type,entity_id,cursor desc);
alter table public.powerhub_sync_changes enable row level security;
revoke all on table public.powerhub_sync_changes from public,anon,authenticated;
grant all on table public.powerhub_sync_changes to service_role;

\ir ../migrations/20261029000000_powerhub_delta_inventory_catalog.sql
\ir ../migrations/20261029100000_powerhub_delta_inventory_stocktakes.sql
\ir ../migrations/20261029110000_powerhub_delta_purchase_headers.sql
\ir ../migrations/20261029120000_powerhub_delta_receipt_return_headers.sql
\ir ../migrations/20261030180000_powerhub_inventory_delta_bounded_membership_reconcile.sql

-- The purchase workflow fixture already installs supplier-ledger revision triggers.
-- Keep that independent cursor type accepted while the isolated test exercises the
-- inventory feeds; the inventory migrations above intentionally do not own it.
alter table public.powerhub_sync_scope_state
  drop constraint if exists powerhub_sync_scope_state_entity_type_check;
alter table public.powerhub_sync_scope_state
  add constraint powerhub_sync_scope_state_test_entity_type_check
  check (
    entity_type in (
      'sites','subscribers','generators','readings','tariffs','invoices','payments','expenses',
      'company_accounts','company_accounts_all','inventory_items','inventory_item_units','suppliers',
      'inventory_warehouses','inventory_stock_movements','inventory_stocktakes','inventory_purchase_headers',
      'inventory_purchase_receipt_headers','inventory_supplier_return_headers','fuel_readings',
      'maintenance_preventive_plans','fuel_events','maintenance_work_orders','hr_employee_directory',
      'hr_attendance','supplier_ledger'
    ) or entity_type ~ '^maintenance_work_order_parts:[1-9][0-9]{0,15}$'
  );

do $bounded_inventory_delta_membership$
declare
  v_supplier_id bigint;
  v_warehouse_id bigint;
  v_purchase_id bigint;
  v_purchase_replacement_id bigint;
  v_purchase_cursor bigint;
  v_receipt_id bigint;
  v_receipt_replacement_id bigint;
  v_receipt_cursor bigint;
  v_return_id bigint;
  v_return_replacement_id bigint;
  v_return_cursor bigint;
  v_stocktake_id bigint;
  v_stocktake_replacement_id bigint;
  v_stocktake_cursor bigint;
  v_snapshot jsonb;
  v_delta jsonb;
  v_rows integer;
begin
  select id into v_supplier_id from public.suppliers
    where tenant_id=10 and supplier_code='PUR-WF-SUP';
  select id into v_warehouse_id from public.inventory_warehouses
    where tenant_id=10 and site_id=100 and code='PUR-WF-MAIN';
  if v_supplier_id is null or v_warehouse_id is null then
    raise exception 'BOUNDED_DELTA_FIXTURE_REFERENCE_MISSING';
  end if;

  -- Purchase headers: after deleting the newest of 201, rank 201 must be
  -- re-emitted so a client retaining 200 headers can refill its local view.
  insert into public.supplier_purchases(
    tenant_id,site_id,supplier_id,warehouse_id,purchase_number,invoice_date,status,
    subtotal_amount,discount_amount,tax_amount,other_charges_amount,payment_terms_days,
    operation_key,confirmed_at,confirmed_by_user_id,created_by_user_id
  )
  select 10,100,v_supplier_id,v_warehouse_id,
    'BDELTA-PO-'||lpad(g::text,4,'0'),date '2100-01-01'+g,'confirmed',
    10,0,0,0,30,'bounded-delta-purchase-'||g::text,
    timestamptz '2100-01-01 00:00:00+00',1,1
  from generate_series(1,201) g;

  select public.powerhub_get_inventory_sync_snapshot(10,100,'inventory_purchase_headers') into v_snapshot;
  if v_snapshot->>'status'<>'ok' or jsonb_array_length(v_snapshot->'rows')<>200 then
    raise exception 'BOUNDED_PURCHASE_SNAPSHOT_NOT_200';
  end if;
  v_purchase_cursor:=(v_snapshot->>'snapshot_cursor')::bigint;
  select id into v_purchase_id from public.supplier_purchases
    where tenant_id=10 and operation_key='bounded-delta-purchase-201';
  select id into v_purchase_replacement_id from public.supplier_purchases
    where tenant_id=10 and operation_key='bounded-delta-purchase-1';
  if exists(select 1 from jsonb_array_elements(v_snapshot->'rows') r where r->>'id'=v_purchase_replacement_id::text) then
    raise exception 'BOUNDED_PURCHASE_RANK_201_SHOULD_NOT_BE_IN_SNAPSHOT';
  end if;
  delete from public.supplier_purchases where tenant_id=10 and id=v_purchase_id;
  select public.powerhub_pull_inventory_sync_delta(10,100,'inventory_purchase_headers',v_purchase_cursor,null,500) into v_delta;
  if not exists(select 1 from jsonb_array_elements(v_delta->'changes') c
      where c->>'entity_id'=v_purchase_id::text and c->>'operation'='delete')
     or not exists(select 1 from jsonb_array_elements(v_delta->'changes') c
      where c->>'entity_id'=v_purchase_replacement_id::text and c->>'operation'='upsert') then
    raise exception 'BOUNDED_PURCHASE_DELETE_DID_NOT_REFILL_RANK_201';
  end if;

  -- Receipt headers use received_at ordering and share the same replacement rule.
  insert into public.supplier_purchase_receipts(
    tenant_id,site_id,purchase_id,receipt_number,receipt_date,operation_key,payload_hash,
    received_at,created_at,received_by_user_id
  )
  select 10,100,
    (select id from public.supplier_purchases where tenant_id=10 and operation_key='purchase-workflow:create-001'),
    'BDELTA-REC-'||lpad(g::text,4,'0'),date '2100-01-01'+g,
    'bounded-delta-receipt-'||g::text,md5('bounded-delta-receipt-'||g::text),
    timestamptz '2100-01-01 00:00:00+00'+g*interval '1 second',
    timestamptz '2100-01-01 00:00:00+00'+g*interval '1 second',1
  from generate_series(1,201) g;

  select public.powerhub_get_inventory_sync_snapshot(10,100,'inventory_purchase_receipt_headers') into v_snapshot;
  if v_snapshot->>'status'<>'ok' or jsonb_array_length(v_snapshot->'rows')<>200 then
    raise exception 'BOUNDED_RECEIPT_SNAPSHOT_NOT_200';
  end if;
  v_receipt_cursor:=(v_snapshot->>'snapshot_cursor')::bigint;
  select id into v_receipt_id from public.supplier_purchase_receipts
    where tenant_id=10 and operation_key='bounded-delta-receipt-201';
  select id into v_receipt_replacement_id from public.supplier_purchase_receipts
    where tenant_id=10 and operation_key='bounded-delta-receipt-1';
  delete from public.supplier_purchase_receipts where tenant_id=10 and id=v_receipt_id;
  select public.powerhub_pull_inventory_sync_delta(10,100,'inventory_purchase_receipt_headers',v_receipt_cursor,null,500) into v_delta;
  if not exists(select 1 from jsonb_array_elements(v_delta->'changes') c
      where c->>'entity_id'=v_receipt_id::text and c->>'operation'='delete')
     or not exists(select 1 from jsonb_array_elements(v_delta->'changes') c
      where c->>'entity_id'=v_receipt_replacement_id::text and c->>'operation'='upsert') then
    raise exception 'BOUNDED_RECEIPT_DELETE_DID_NOT_REFILL_RANK_201';
  end if;

  -- Posted supplier returns use return_date ordering.
  insert into public.supplier_purchase_returns(
    tenant_id,site_id,purchase_id,supplier_id,warehouse_id,return_number,return_date,status,
    operation_key,payload_hash,reason,total_credit_amount,stock_cost_amount,refund_amount,
    refund_company_account_id,returned_at,returned_by_user_id
  )
  select 10,100,
    (select id from public.supplier_purchases where tenant_id=10 and operation_key='purchase-workflow:create-001'),
    v_supplier_id,v_warehouse_id,'BDELTA-RET-'||lpad(g::text,4,'0'),date '2100-01-01'+g,'posted',
    'bounded-delta-return-'||g::text,md5('bounded-delta-return-'||g::text),
    'Bounded Delta test return',0,0,0,null,
    timestamptz '2100-01-01 00:00:00+00'+g*interval '1 second',1
  from generate_series(1,201) g;

  select public.powerhub_get_inventory_sync_snapshot(10,100,'inventory_supplier_return_headers') into v_snapshot;
  if v_snapshot->>'status'<>'ok' or jsonb_array_length(v_snapshot->'rows')<>200 then
    raise exception 'BOUNDED_RETURN_SNAPSHOT_NOT_200';
  end if;
  v_return_cursor:=(v_snapshot->>'snapshot_cursor')::bigint;
  select id into v_return_id from public.supplier_purchase_returns
    where tenant_id=10 and operation_key='bounded-delta-return-201';
  select id into v_return_replacement_id from public.supplier_purchase_returns
    where tenant_id=10 and operation_key='bounded-delta-return-1';
  delete from public.supplier_purchase_returns where tenant_id=10 and id=v_return_id;
  select public.powerhub_pull_inventory_sync_delta(10,100,'inventory_supplier_return_headers',v_return_cursor,null,500) into v_delta;
  if not exists(select 1 from jsonb_array_elements(v_delta->'changes') c
      where c->>'entity_id'=v_return_id::text and c->>'operation'='delete')
     or not exists(select 1 from jsonb_array_elements(v_delta->'changes') c
      where c->>'entity_id'=v_return_replacement_id::text and c->>'operation'='upsert') then
    raise exception 'BOUNDED_RETURN_DELETE_DID_NOT_REFILL_RANK_201';
  end if;

  -- Stocktake snapshots also retain only their newest 200 headers.
  insert into public.inventory_stocktakes(
    tenant_id,site_id,warehouse_id,stocktake_number,status,reason,operation_key,
    operation_payload_hash,created_by_user_id,created_at,posted_at,posted_by_user_id
  )
  select 10,100,v_warehouse_id,'BDELTA-ST-'||lpad(g::text,4,'0'),'posted',
    'Bounded Delta stocktake','bounded-delta-stocktake-'||g::text,
    md5('bounded-delta-stocktake-'||g::text),1,
    timestamptz '2100-01-01 00:00:00+00'+g*interval '1 second',
    timestamptz '2100-01-01 00:00:00+00'+g*interval '1 second',1
  from generate_series(1,201) g;

  select public.powerhub_get_inventory_sync_snapshot(10,100,'inventory_stocktakes') into v_snapshot;
  if v_snapshot->>'status'<>'ok' or jsonb_array_length(v_snapshot->'rows')<>200 then
    raise exception 'BOUNDED_STOCKTAKE_SNAPSHOT_NOT_200';
  end if;
  v_stocktake_cursor:=(v_snapshot->>'snapshot_cursor')::bigint;
  select id into v_stocktake_id from public.inventory_stocktakes
    where tenant_id=10 and operation_key='bounded-delta-stocktake-201';
  select id into v_stocktake_replacement_id from public.inventory_stocktakes
    where tenant_id=10 and operation_key='bounded-delta-stocktake-1';
  delete from public.inventory_stocktakes where tenant_id=10 and id=v_stocktake_id;
  select public.powerhub_pull_inventory_sync_delta(10,100,'inventory_stocktakes',v_stocktake_cursor,null,500) into v_delta;
  if not exists(select 1 from jsonb_array_elements(v_delta->'changes') c
      where c->>'entity_id'=v_stocktake_id::text and c->>'operation'='delete')
     or not exists(select 1 from jsonb_array_elements(v_delta->'changes') c
      where c->>'entity_id'=v_stocktake_replacement_id::text and c->>'operation'='upsert') then
    raise exception 'BOUNDED_STOCKTAKE_DELETE_DID_NOT_REFILL_RANK_201';
  end if;

  -- New server-only reconciliation functions must never be callable by a browser role.
  if has_function_privilege('authenticated','public.powerhub_refresh_inventory_purchase_header_delta_scope(bigint,bigint)','EXECUTE')
     or has_function_privilege('authenticated','public.powerhub_refresh_inventory_purchase_receipt_header_delta_scope(bigint,bigint)','EXECUTE')
     or has_function_privilege('authenticated','public.powerhub_refresh_inventory_supplier_return_header_delta_scope(bigint,bigint)','EXECUTE')
     or has_function_privilege('authenticated','public.powerhub_refresh_inventory_stocktake_delta_scope(bigint,bigint)','EXECUTE')
     or not has_function_privilege('service_role','public.powerhub_refresh_inventory_stocktake_delta_scope(bigint,bigint)','EXECUTE') then
    raise exception 'BOUNDED_INVENTORY_DELTA_RECONCILIATION_ACL_FAILED';
  end if;
end;
$bounded_inventory_delta_membership$;

select 'Bounded inventory Delta snapshots refill rank 201 after delete for purchases, receipts, returns, and stocktakes' as result;
