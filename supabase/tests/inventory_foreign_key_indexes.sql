\set ON_ERROR_STOP on

do $inventory_foreign_key_index_assertions$
declare
  v_missing text[];
begin
  select array_agg(required.index_name order by required.index_name)
    into v_missing
  from (values
    ('inventory_stock_transfers_created_by_user_idx'),
    ('inventory_stock_transfers_destination_movement_idx'),
    ('inventory_stock_transfers_destination_warehouse_idx'),
    ('inventory_stock_transfers_source_movement_idx'),
    ('inventory_stock_transfers_source_warehouse_idx'),
    ('suppliers_created_by_user_idx')
  ) as required(index_name)
  where not exists (
    select 1 from pg_indexes i
    where i.schemaname='public' and i.indexname=required.index_name
  );

  if v_missing is not null then
    raise exception 'INVENTORY_FOREIGN_KEY_INDEXES_MISSING: %', array_to_string(v_missing, ',');
  end if;
end;
$inventory_foreign_key_index_assertions$;

select 'inventory supplier and warehouse-transfer foreign-key indexes passed' as result;
