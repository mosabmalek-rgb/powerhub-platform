-- Release hardening: cover foreign-key lookups on inventory transfers and suppliers.
-- These indexes keep FK checks/deletes and joins predictable as the inventory ledger grows.
create index if not exists inventory_stock_transfers_created_by_user_idx
  on public.inventory_stock_transfers(created_by_user_id)
  where created_by_user_id is not null;

create index if not exists inventory_stock_transfers_destination_movement_idx
  on public.inventory_stock_transfers(tenant_id, destination_movement_id)
  where destination_movement_id is not null;

create index if not exists inventory_stock_transfers_destination_warehouse_idx
  on public.inventory_stock_transfers(tenant_id, destination_warehouse_id);

create index if not exists inventory_stock_transfers_source_movement_idx
  on public.inventory_stock_transfers(tenant_id, source_movement_id)
  where source_movement_id is not null;

create index if not exists inventory_stock_transfers_source_warehouse_idx
  on public.inventory_stock_transfers(tenant_id, source_warehouse_id);

create index if not exists suppliers_created_by_user_idx
  on public.suppliers(created_by_user_id)
  where created_by_user_id is not null;
