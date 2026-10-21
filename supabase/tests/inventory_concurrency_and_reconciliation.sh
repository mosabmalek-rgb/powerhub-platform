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
PGOPTIONS="$role_opts" "${psql_base[@]}" --command "select pg_sleep(0.15); select movement_id from public.powerhub_inventory_record_stock_movement(10,100,1,1,${item_id},'issue',7,null,null,'CONC-RACE-A',null,'inventory-concurrency:race-a')" >/tmp/inventory-race-a.log 2>&1 &
pid_a=$!
PGOPTIONS="$role_opts" "${psql_base[@]}" --command "select pg_sleep(0.15); select movement_id from public.powerhub_inventory_record_stock_movement(10,100,1,1,${item_id},'issue',7,null,null,'CONC-RACE-B',null,'inventory-concurrency:race-b')" >/tmp/inventory-race-b.log 2>&1 &
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
PGOPTIONS="$role_opts" "${psql_base[@]}" --command "select pg_sleep(0.15); select movement_id::text || ':' || replayed::text from public.powerhub_inventory_record_stock_movement(10,100,1,1,${item_id},'issue',1,null,null,'CONC-IDEM',null,'inventory-concurrency:idempotent')" >/tmp/inventory-idem-a.log 2>&1 &
pid_a=$!
PGOPTIONS="$role_opts" "${psql_base[@]}" --command "select pg_sleep(0.15); select movement_id::text || ':' || replayed::text from public.powerhub_inventory_record_stock_movement(10,100,1,1,${item_id},'issue',1,null,null,'CONC-IDEM',null,'inventory-concurrency:idempotent')" >/tmp/inventory-idem-b.log 2>&1 &
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

# Race two warehouse transfers against the same source balance.
# Seed a separate item with 3 units / $10.00, then try to transfer 2 units twice.
source_warehouse_id="$("${psql_base[@]}" --command "select id from public.inventory_warehouses where tenant_id=10 and site_id=100 and code='TRF-SOURCE'")"
destination_warehouse_id="$("${psql_base[@]}" --command "select id from public.inventory_warehouses where tenant_id=10 and site_id=100 and code='TRF-DEST'")"
[[ "$source_warehouse_id" =~ ^[0-9]+$ && "$destination_warehouse_id" =~ ^[0-9]+$ ]] || {
  echo "Could not resolve warehouse transfer race fixtures"
  exit 1
}
transfer_item_id="$("${psql_base[@]}" --command "insert into public.inventory_items(tenant_id,sku,name,category,base_unit,reorder_point,created_by_user_id) values (10,'CONC-TRANSFER-01','Concurrent transfer item','other','piece',0,1) returning id")"
[[ "$transfer_item_id" =~ ^[0-9]+$ ]] || { echo "Could not seed transfer race item"; exit 1; }
PGOPTIONS="$role_opts" "${psql_base[@]}" --command "select movement_id from public.powerhub_inventory_record_stock_movement(10,100,1,${source_warehouse_id},${transfer_item_id},'opening_balance',3,3.3333,null,'CONC-TRANSFER-OPEN','transfer concurrency fixture','inventory-concurrency:transfer-opening')" >/tmp/inventory-transfer-open.log 2>&1

PGOPTIONS="$role_opts" "${psql_base[@]}" --command "select pg_sleep(0.15); select transfer_id from public.powerhub_inventory_transfer_stock(10,100,1,${transfer_item_id},${source_warehouse_id},${destination_warehouse_id},2,'inventory-concurrency:transfer-a','CONC-TRANSFER-A','competing transfer A')" >/tmp/inventory-transfer-a.log 2>&1 &
pid_a=$!
PGOPTIONS="$role_opts" "${psql_base[@]}" --command "select pg_sleep(0.15); select transfer_id from public.powerhub_inventory_transfer_stock(10,100,1,${transfer_item_id},${source_warehouse_id},${destination_warehouse_id},2,'inventory-concurrency:transfer-b','CONC-TRANSFER-B','competing transfer B')" >/tmp/inventory-transfer-b.log 2>&1 &
pid_b=$!
set +e
wait "$pid_a"; rc_a=$?
wait "$pid_b"; rc_b=$?
set -e
if [[ $(( (rc_a == 0) + (rc_b == 0) )) -ne 1 ]]; then
  echo "Expected exactly one competing warehouse transfer to commit (rc_a=$rc_a rc_b=$rc_b)"
  cat /tmp/inventory-transfer-a.log /tmp/inventory-transfer-b.log
  exit 1
fi
if ! grep -q 'INSUFFICIENT_STOCK' /tmp/inventory-transfer-a.log /tmp/inventory-transfer-b.log; then
  echo "The losing warehouse transfer was not rejected specifically for insufficient stock"
  cat /tmp/inventory-transfer-a.log /tmp/inventory-transfer-b.log
  exit 1
fi

"${psql_base[@]}" --command "
do \$transfer_race_assert\$
declare
  v_source_qty numeric(14,3);
  v_source_value numeric(14,2);
  v_destination_qty numeric(14,3);
  v_destination_value numeric(14,2);
  v_transfer_count integer;
  v_out_count integer;
  v_in_count integer;
begin
  select coalesce(sum(case when movement_type in ('opening_balance','purchase_receipt','adjustment_in','return_from_issue') then quantity else -quantity end),0),
         coalesce(sum(case when movement_type in ('opening_balance','purchase_receipt','adjustment_in','return_from_issue') then total_cost_amount else -total_cost_amount end),0)
    into v_source_qty,v_source_value
  from public.inventory_stock_movements
  where tenant_id=10 and site_id=100 and warehouse_id=${source_warehouse_id} and item_id=${transfer_item_id};

  select coalesce(sum(case when movement_type in ('opening_balance','purchase_receipt','adjustment_in','return_from_issue') then quantity else -quantity end),0),
         coalesce(sum(case when movement_type in ('opening_balance','purchase_receipt','adjustment_in','return_from_issue') then total_cost_amount else -total_cost_amount end),0)
    into v_destination_qty,v_destination_value
  from public.inventory_stock_movements
  where tenant_id=10 and site_id=100 and warehouse_id=${destination_warehouse_id} and item_id=${transfer_item_id};

  select count(*) into v_transfer_count from public.inventory_stock_transfers
  where tenant_id=10 and item_id=${transfer_item_id}
    and operation_key in ('inventory-concurrency:transfer-a','inventory-concurrency:transfer-b');
  select count(*) into v_out_count from public.inventory_stock_movements
  where tenant_id=10 and item_id=${transfer_item_id} and operation_key in (
    'trf:inventory-concurrency:transfer-a:out','trf:inventory-concurrency:transfer-b:out');
  select count(*) into v_in_count from public.inventory_stock_movements
  where tenant_id=10 and item_id=${transfer_item_id} and operation_key in (
    'trf:inventory-concurrency:transfer-a:in','trf:inventory-concurrency:transfer-b:in');

  if v_source_qty<>1 or v_source_value<>3.33 or v_destination_qty<>2 or v_destination_value<>6.67 then
    raise exception 'CONCURRENT_TRANSFER_BALANCE_RECONCILIATION_FAILED source=(%,%) destination=(%,%)',
      v_source_qty,v_source_value,v_destination_qty,v_destination_value;
  end if;
  if v_transfer_count<>1 or v_out_count<>1 or v_in_count<>1 then
    raise exception 'CONCURRENT_TRANSFER_DUPLICATE_OR_PARTIAL_WRITES transfer=% out=% in=%',
      v_transfer_count,v_out_count,v_in_count;
  end if;
  if v_source_value+v_destination_value<>10.00 then
    raise exception 'CONCURRENT_TRANSFER_COST_NOT_CONSERVED source=% destination=%',v_source_value,v_destination_value;
  end if;
end;
\$transfer_race_assert\$;
"


# Race duplicate supplier-return submissions against the same received purchase line.
purchase_id="$("${psql_base[@]}" --command "select id from public.supplier_purchases where tenant_id=10 and operation_key='purchase-workflow:cost-rounding:create'")"
purchase_line_id="$("${psql_base[@]}" --command "select id from public.supplier_purchase_lines where tenant_id=10 and purchase_id=${purchase_id} order by id limit 1")"
[[ "$purchase_id" =~ ^[0-9]+$ && "$purchase_line_id" =~ ^[0-9]+$ ]] || {
  echo "Could not resolve received purchase line for concurrent supplier-return test"
  exit 1
}

PGOPTIONS="$role_opts" "${psql_base[@]}" --command "select pg_sleep(0.15); select return_id::text || ':' || replayed::text from public.powerhub_inventory_return_to_supplier(10,100,1,${purchase_id},current_date,'inventory-concurrency:supplier-return:once','Concurrent idempotent supplier return',null,jsonb_build_array(jsonb_build_object('purchase_line_id',${purchase_line_id},'quantity',1)),0,null)" >/tmp/inventory-supplier-return-a.log 2>&1 &
pid_a=$!
PGOPTIONS="$role_opts" "${psql_base[@]}" --command "select pg_sleep(0.15); select return_id::text || ':' || replayed::text from public.powerhub_inventory_return_to_supplier(10,100,1,${purchase_id},current_date,'inventory-concurrency:supplier-return:once','Concurrent idempotent supplier return',null,jsonb_build_array(jsonb_build_object('purchase_line_id',${purchase_line_id},'quantity',1)),0,null)" >/tmp/inventory-supplier-return-b.log 2>&1 &
pid_b=$!
wait "$pid_a"
wait "$pid_b"

result_a="$(tr -d '[:space:]' </tmp/inventory-supplier-return-a.log)"
result_b="$(tr -d '[:space:]' </tmp/inventory-supplier-return-b.log)"
return_id_a="${result_a%%:*}"
return_id_b="${result_b%%:*}"
if [[ ! "$return_id_a" =~ ^[0-9]+$ || "$return_id_a" != "$return_id_b" ]]; then
  echo "Concurrent supplier-return calls did not return the same return ID"
  cat /tmp/inventory-supplier-return-a.log /tmp/inventory-supplier-return-b.log
  exit 1
fi
if ! { [[ "$result_a" == "$return_id_a:false" && "$result_b" == "$return_id_b:true" ]] || [[ "$result_a" == "$return_id_a:true" && "$result_b" == "$return_id_b:false" ]]; }; then
  echo "Expected one original supplier-return result and one idempotent replay"
  cat /tmp/inventory-supplier-return-a.log /tmp/inventory-supplier-return-b.log
  exit 1
fi

# Final reconciliation across receipt quantities, supplier returns, stock ledger,
# supplier financial ledger, company-account refunds, and audit entries.
"${psql_base[@]}" --command "
do \$inventory_prelaunch_reconciliation\$
declare
  v_mismatches integer;
begin
  select count(*) into v_mismatches
  from public.supplier_purchase_lines pl
  join public.supplier_purchases p on p.tenant_id=pl.tenant_id and p.id=pl.purchase_id
  where p.tenant_id=10 and p.operation_key like 'purchase-workflow:%'
    and pl.received_quantity is distinct from coalesce((
      select sum(rl.quantity)::numeric(14,3)
      from public.supplier_purchase_receipt_lines rl
      where rl.tenant_id=pl.tenant_id and rl.purchase_id=pl.purchase_id and rl.purchase_line_id=pl.id
    ),0)::numeric(14,3);
  if v_mismatches<>0 then
    raise exception 'PRELAUNCH_PURCHASE_RECEIPT_QUANTITY_RECONCILIATION_FAILED mismatches=%',v_mismatches;
  end if;

  select count(*) into v_mismatches
  from public.supplier_purchase_returns r
  left join lateral (
    select count(*)::integer line_count,
      coalesce(sum(rl.supplier_credit_amount),0)::numeric(14,2) credit_amount,
      coalesce(sum(rl.stock_cost_amount),0)::numeric(14,2) stock_cost_amount,
      count(*) filter (where m.id is not null and m.movement_type='supplier_return'
        and m.purchase_id=rl.purchase_id and m.purchase_line_id=rl.purchase_line_id
        and m.quantity=rl.base_quantity and m.total_cost_amount=rl.stock_cost_amount)::integer linked_movements
    from public.supplier_purchase_return_lines rl
    left join public.inventory_stock_movements m on m.tenant_id=rl.tenant_id and m.id=rl.stock_movement_id
    where rl.tenant_id=r.tenant_id and rl.return_id=r.id
  ) lines on true
  left join lateral (
    select coalesce(sum(e.debit_amount) filter (where e.entry_type='supplier_return'),0)::numeric(14,2) gross_debit,
      coalesce(sum(e.credit_amount) filter (where e.entry_type='credit_note'),0)::numeric(14,2) refunds
    from public.supplier_ledger_entries e
    where e.tenant_id=r.tenant_id and e.supplier_return_id=r.id
  ) ledger on true
  left join lateral (
    select coalesce(sum(atx.amount) filter (where atx.transaction_type='deposit'),0)::numeric(14,2) refunds
    from public.account_transactions atx
    where atx.tenant_id=r.tenant_id and atx.related_supplier_return_id=r.id
  ) cash on true
  left join lateral (
    select count(*)::integer audits
    from public.audit_logs a
    where a.tenant_id=r.tenant_id and a.site_id=r.site_id
      and a.entity_type='supplier_purchase_return' and a.entity_id=r.id::text and a.action='post'
  ) audit on true
  where r.tenant_id=10 and r.status='posted'
    and (
      lines.line_count=0
      or r.total_credit_amount is distinct from lines.credit_amount
      or r.stock_cost_amount is distinct from lines.stock_cost_amount
      or lines.linked_movements<>lines.line_count
      or ledger.gross_debit is distinct from r.total_credit_amount
      or ledger.refunds is distinct from r.refund_amount
      or cash.refunds is distinct from r.refund_amount
      or audit.audits<>1
    );
  if v_mismatches<>0 then
    raise exception 'PRELAUNCH_SUPPLIER_RETURN_FINANCIAL_RECONCILIATION_FAILED mismatches=%',v_mismatches;
  end if;

  if (select count(*) from public.supplier_purchase_returns
      where tenant_id=10 and operation_key='inventory-concurrency:supplier-return:once')<>1
     or (select count(*) from public.supplier_purchase_return_lines rl
         join public.supplier_purchase_returns r on r.tenant_id=rl.tenant_id and r.id=rl.return_id
         where r.tenant_id=10 and r.operation_key='inventory-concurrency:supplier-return:once')<>1
     or (select count(*) from public.inventory_stock_movements
         where tenant_id=10 and operation_key like 'supplier-return:'||
           (select id::text from public.supplier_purchase_returns where tenant_id=10 and operation_key='inventory-concurrency:supplier-return:once')||':line:%')<>1
     or (select count(*) from public.supplier_ledger_entries
         where tenant_id=10 and supplier_return_id=(select id from public.supplier_purchase_returns where tenant_id=10 and operation_key='inventory-concurrency:supplier-return:once')
           and entry_type='supplier_return')<>1
     or (select count(*) from public.audit_logs
         where tenant_id=10 and entity_type='supplier_purchase_return'
           and entity_id=(select id::text from public.supplier_purchase_returns where tenant_id=10 and operation_key='inventory-concurrency:supplier-return:once')
           and action='post')<>1 then
    raise exception 'PRELAUNCH_CONCURRENT_SUPPLIER_RETURN_DUPLICATED_OR_PARTIAL_POSTING';
  end if;
end;
\$inventory_prelaunch_reconciliation\$;
"

echo "Inventory issue/transfer/supplier-return concurrency and complete pre-release ledger reconciliation checks passed."

