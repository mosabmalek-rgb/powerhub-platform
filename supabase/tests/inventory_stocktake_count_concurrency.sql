\set ON_ERROR_STOP on

-- Exercises the stocktake count idempotency lock with two real PostgreSQL sessions.
-- This runs only against the disposable inventory_purchase_receiving_test database.

create extension if not exists dblink;

do $prepare_stocktake$
declare
  v_warehouse_id bigint;
  v_item_id bigint;
  v_stocktake_id bigint;
  v_status text;
  v_replayed boolean;
begin
  select id into v_warehouse_id
  from public.inventory_warehouses
  where tenant_id=10 and site_id=100 and code='FIXED-TANK-WF-01' and is_active;

  select id into v_item_id
  from public.inventory_items
  where tenant_id=10 and sku='DSL-01' and is_active;

  if v_warehouse_id is null or v_item_id is null then
    raise exception 'STOCKTAKE_CONCURRENCY_FIXTURE_MISSING';
  end if;

  select stocktake_id,status,replayed
  into v_stocktake_id,v_status,v_replayed
  from public.powerhub_inventory_create_stocktake(
    10,100,1,v_warehouse_id,'Concurrent idempotency regression',
    'Disposable PostgreSQL concurrency fixture','stocktake-concurrency:create-001'
  );

  if v_stocktake_id is null or v_status<>'counting' or v_replayed then
    raise exception 'STOCKTAKE_CONCURRENCY_FIXTURE_CREATE_FAILED status=% replayed=%',
      v_status,v_replayed;
  end if;

  if not exists (
    select 1 from public.inventory_stocktake_lines
    where tenant_id=10 and stocktake_id=v_stocktake_id and item_id=v_item_id
  ) then
    raise exception 'STOCKTAKE_CONCURRENCY_LINE_FIXTURE_MISSING';
  end if;
end;
$prepare_stocktake$;

do $concurrent_stocktake_count$
declare
  v_stocktake_id bigint;
  v_item_id bigint;
  v_line_id bigint;
  v_operation_key text:='stocktake-count:concurrent:line-1';
  v_lock_key bigint;
  v_request_sql text;
  v_waiting integer:=0;
  v_attempt integer;
  v_a record;
  v_b record;
  v_audit_before integer;
  v_audit_after integer;
  v_operation_count integer;
  v_status text;
  v_replayed boolean;
begin
  select id into v_stocktake_id
  from public.inventory_stocktakes
  where tenant_id=10 and site_id=100 and operation_key='stocktake-concurrency:create-001';

  select id into v_item_id
  from public.inventory_items
  where tenant_id=10 and sku='DSL-01';

  select id into v_line_id
  from public.inventory_stocktake_lines
  where tenant_id=10 and stocktake_id=v_stocktake_id and item_id=v_item_id;

  if v_stocktake_id is null or v_item_id is null or v_line_id is null then
    raise exception 'STOCKTAKE_CONCURRENCY_FIXTURE_LOOKUP_FAILED';
  end if;

  select count(*)::integer into v_audit_before
  from public.audit_logs
  where tenant_id=10 and site_id=100 and entity_type='inventory_stocktake_line'
    and entity_id=v_line_id::text and action='record_count';

  -- Hold the exact advisory key used by the RPC until both remote transactions
  -- are demonstrably blocked on it. Releasing it makes them race for the same key.
  v_lock_key:=hashtextextended(
    jsonb_build_array('inventory-stocktake-count',10,v_operation_key)::text,0
  );
  perform pg_advisory_lock(v_lock_key);

  perform dblink_connect(
    'stocktake_parallel_a',
    'host=/var/run/postgresql dbname='||current_database()||
      ' user='||current_user||' application_name=stocktake_parallel_a'
  );
  perform dblink_connect(
    'stocktake_parallel_b',
    'host=/var/run/postgresql dbname='||current_database()||
      ' user='||current_user||' application_name=stocktake_parallel_b'
  );

  v_request_sql:=format(
    'select stocktake_id,item_id,system_quantity,counted_quantity,variance_quantity,counted_at,replayed '||
    'from public.powerhub_inventory_record_stocktake_count(10,100,1,%s,%s,3.000,6.0000,%L,%L)',
    v_stocktake_id,v_item_id,'Two requests submitted concurrently',v_operation_key
  );

  if dblink_send_query('stocktake_parallel_a',v_request_sql)<>1
    or dblink_send_query('stocktake_parallel_b',v_request_sql)<>1 then
    raise exception 'STOCKTAKE_CONCURRENCY_QUERY_DISPATCH_FAILED';
  end if;

  for v_attempt in 1..100 loop
    select count(*)::integer into v_waiting
    from pg_stat_activity
    where application_name in ('stocktake_parallel_a','stocktake_parallel_b')
      and wait_event_type='Lock'
      and wait_event='advisory';
    exit when v_waiting=2;
    perform pg_sleep(0.05);
  end loop;

  if v_waiting<>2 then
    perform pg_advisory_unlock(v_lock_key);
    raise exception 'STOCKTAKE_CONCURRENT_CALLS_DID_NOT_REACH_IDEMPOTENCY_LOCK waiting=%',
      v_waiting;
  end if;

  if not pg_advisory_unlock(v_lock_key) then
    raise exception 'STOCKTAKE_CONCURRENCY_TEST_LOCK_RELEASE_FAILED';
  end if;

  select * into v_a
  from dblink_get_result('stocktake_parallel_a') as result(
    stocktake_id bigint,item_id bigint,system_quantity numeric,counted_quantity numeric,
    variance_quantity numeric,counted_at timestamptz,replayed boolean
  );

  select * into v_b
  from dblink_get_result('stocktake_parallel_b') as result(
    stocktake_id bigint,item_id bigint,system_quantity numeric,counted_quantity numeric,
    variance_quantity numeric,counted_at timestamptz,replayed boolean
  );

  perform dblink_disconnect('stocktake_parallel_a');
  perform dblink_disconnect('stocktake_parallel_b');

  if v_a.stocktake_id<>v_stocktake_id or v_b.stocktake_id<>v_stocktake_id
    or v_a.item_id<>v_item_id or v_b.item_id<>v_item_id
    or v_a.counted_quantity<>3.000 or v_b.counted_quantity<>3.000
    or v_a.counted_at is distinct from v_b.counted_at
    or v_a.replayed=v_b.replayed then
    raise exception 'STOCKTAKE_CONCURRENT_REPLAY_RESULT_MISMATCH a=% b=%',
      row_to_json(v_a),row_to_json(v_b);
  end if;

  select count(*)::integer into v_operation_count
  from public.powerhub_inventory_stocktake_count_operations
  where tenant_id=10 and operation_key=v_operation_key;

  select count(*)::integer into v_audit_after
  from public.audit_logs
  where tenant_id=10 and site_id=100 and entity_type='inventory_stocktake_line'
    and entity_id=v_line_id::text and action='record_count';

  if v_operation_count<>1 then
    raise exception 'STOCKTAKE_CONCURRENT_OPERATION_RECEIPT_COUNT_MISMATCH count=%',
      v_operation_count;
  end if;

  if v_audit_after<>v_audit_before+1 then
    raise exception 'STOCKTAKE_CONCURRENT_REPLAY_DUPLICATED_AUDIT before=% after=%',
      v_audit_before,v_audit_after;
  end if;

  -- A tenant-wide operation key cannot be replayed against another site.
  begin
    perform * from public.powerhub_inventory_record_stocktake_count(
      10,101,1,v_stocktake_id,v_item_id,3.000,6.0000,
      'Two requests submitted concurrently',v_operation_key
    );
    raise exception 'STOCKTAKE_CONCURRENT_KEY_REPLAYED_FOR_DIFFERENT_SITE';
  exception when others then
    if sqlerrm='STOCKTAKE_CONCURRENT_KEY_REPLAYED_FOR_DIFFERENT_SITE' then raise; end if;
    if sqlerrm not like '%IDEMPOTENCY_KEY_REUSED%' then raise; end if;
  end;

  select status,replayed into v_status,v_replayed
  from public.powerhub_inventory_cancel_stocktake(
    10,100,1,v_stocktake_id,'Close concurrent idempotency test session'
  );

  if v_status<>'cancelled' or v_replayed then
    raise exception 'STOCKTAKE_CONCURRENCY_FIXTURE_CLEANUP_FAILED status=% replayed=%',
      v_status,v_replayed;
  end if;
end;
$concurrent_stocktake_count$;

drop extension if exists dblink;
