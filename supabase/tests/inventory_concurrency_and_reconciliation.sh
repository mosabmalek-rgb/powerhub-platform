#!/usr/bin/env bash
set -euo pipefail

: "${PGPASSWORD:?PGPASSWORD is required}"
PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-postgres}"
PGDATABASE="${PGDATABASE:-inventory_purchase_receiving_test}"
export PGHOST PGPORT PGUSER PGDATABASE PGPASSWORD

psql_base=(psql --no-psqlrc --quiet --tuples-only --no-align --set ON_ERROR_STOP=1)
role_opts="-c role=service_role"
item_id="$("${psql_base[@]}" --command "select id from public.inventory_items where tenant_id=10 and sku='CONC-ITEM-01'")"
[[ "$item_id" =~ ^[0-9]+$ ]] || { echo "Could not resolve concurrency fixture item"; exit 1; }

# Race two independent sessions to issue 7 units each from a stock of 10.
# Exactly one must commit; the loser must be rejected after the stock lock is acquired.
PGOPTIONS="$role_opts" "${psql_base[@]}" --command "select movement_id from public.powerhub_inventory_record_stock_movement(10,100,1,1,${item_id},'issue',7,null,null,'CONC-RACE-A',null,'inventory-concurrency:race-a')" >/tmp/inventory-race-a.log 2>&1 &
pid_a=$!
PGOPTIONS="$role_opts" "${psql_base[@]}" --command "select movement_id from public.powerhub_inventory_record_stock_movement(10,100,1,1,${item_id},'issue',7,null,null,'CONC-RACE-B',null,'inventory-concurrency:race-b')" >/tmp/inventory-race-b.log 2>&1 &
pid_b=$!
set +e
wait "$pid_a"; rc_a=$?
wait "$pid_b"; rc_b=$?
set -e
if [[ $(( (rc_a == 0) + (rc_b == 0) )) -ne 1 ]]; then
  echo "Expected exactly one competing stock issue to commit (rc_a=$rc_a rc_b=$rc_b)"
  cat /tmp/inventory-race-a.log /tmp/inventory-race-b.log
  exit 1
fi
if ! grep -q 'INSUFFICIENT_STOCK' /tmp/inventory-race-a.log /tmp/inventory-race-b.log; then
  echo "The losing stock issue was not rejected specifically for insufficient stock"
  cat /tmp/inventory-race-a.log /tmp/inventory-race-b.log
  exit 1
fi

# Two sessions with the same operation key and identical payload must return the same row.
PGOPTIONS="$role_opts" "${psql_base[@]}" --command "select movement_id || ':' || replayed from public.powerhub_inventory_record_stock_movement(10,100,1,1,${item_id},'issue',1,null,null,'CONC-IDEM',null,'inventory-concurrency:idempotent')" >/tmp/inventory-idem-a.log 2>&1 &
pid_a=$!
PGOPTIONS="$role_opts" "${psql_base[@]}" --command "select movement_id || ':' || replayed from public.powerhub_inventory_record_stock_movement(10,100,1,1,${item_id},'issue',1,null,null,'CONC-IDEM',null,'inventory-concurrency:idempotent')" >/tmp/inventory-idem-b.log 2>&1 &
pid_b=$!
wait "$pid_a"
wait "$pid_b"

result_a="$(tr -d '[:space:]' </tmp/inventory-idem-a.log)"
result_b="$(tr -d '[:space:]' </tmp/inventory-idem-b.log)"
id_a="${result_a%%:*}"
id_b="${result_b%%:*}"
if [[ ! "$id_a" =~ ^[0-9]+$ || "$id_a" != "$id_b" ]]; then
  echo "Concurrent idempotent calls did not return the same movement ID"
  cat /tmp/inventory-idem-a.log /tmp/inventory-idem-b.log
  exit 1
fi
if ! { [[ "$result_a" == "$id_a:false" && "$result_b" == "$id_b:true" ]] || [[ "$result_a" == "$id_a:true" && "$result_b" == "$id_b:false" ]]; }; then
  echo "Expected one original result and one replay for concurrent idempotency"
  cat /tmp/inventory-idem-a.log /tmp/inventory-idem-b.log
  exit 1
fi

# Assert stock ledger reconciliation and uniqueness after both races.
"${psql_base[@]}" --command "
do \$assert\$
declare
  v_qty numeric(14,3);
  v_value numeric(14,2);
  v_race_count integer;
  v_idem_count integer;
  v_transfer_mismatch integer;
begin
  select coalesce(sum(case when movement_type in ('opening_balance','purchase_receipt','adjustment_in','return_from_issue') then quantity else -quantity end),0),
         coalesce(sum(case when movement_type in ('opening_balance','purchase_receipt','adjustment_in','return_from_issue') then total_cost_amount else -total_cost_amount end),0)
    into v_qty,v_value
  from public.inventory_stock_movements
  where tenant_id=10 and site_id=100 and warehouse_id=1 and item_id=${item_id};

  if v_qty<>2 or v_value<>6.66 then
    raise exception 'CONCURRENT_STOCK_RECONCILIATION_FAILED qty=% value=%',v_qty,v_value;
  end if;

  select count(*) into v_race_count
  from public.inventory_stock_movements
  where tenant_id=10 and operation_key in ('inventory-concurrency:race-a','inventory-concurrency:race-b');
  if v_race_count<>1 then
    raise exception 'CONCURRENT_ISSUE_DUPLICATE_OR_MISSING_MOVEMENT count=%',v_race_count;
  end if;

  select count(*) into v_idem_count
  from public.inventory_stock_movements
  where tenant_id=10 and operation_key='inventory-concurrency:idempotent';
  if v_idem_count<>1 then
    raise exception 'CONCURRENT_IDEMPOTENCY_DUPLICATE_OR_MISSING_MOVEMENT count=%',v_idem_count;
  end if;

  select count(*) into v_transfer_mismatch
  from public.inventory_stock_transfers t
  left join public.inventory_stock_movements o on o.tenant_id=t.tenant_id and o.id=t.source_movement_id
  left join public.inventory_stock_movements i on i.tenant_id=t.tenant_id and i.id=t.destination_movement_id
  where t.tenant_id=10 and (
    o.id is null or i.id is null or o.movement_type<>'issue' or i.movement_type<>'adjustment_in'
    or o.quantity<>t.quantity or i.quantity<>t.quantity
    or o.total_cost_amount<>t.total_cost_amount or i.total_cost_amount<>t.total_cost_amount
    or o.warehouse_id<>t.source_warehouse_id or i.warehouse_id<>t.destination_warehouse_id
    or o.item_id<>t.item_id or i.item_id<>t.item_id
  );
  if v_transfer_mismatch<>0 then
    raise exception 'WAREHOUSE_TRANSFER_LEDGER_RECONCILIATION_FAILED mismatches=%',v_transfer_mismatch;
  end if;
end;
\$assert\$;
"
echo "Inventory concurrency, idempotency, stock-value reconciliation, and transfer linkage checks passed."
