-- Cover foreign-key lookups introduced by Phase A inventory, units and stocktake workflows.
-- Partial indexes keep rows without an actor out of the index while supporting user deletion/update checks.
create index if not exists inventory_item_units_created_by_user_idx
  on public.inventory_item_units(created_by_user_id)
  where created_by_user_id is not null;

create index if not exists inventory_stocktakes_created_by_user_idx
  on public.inventory_stocktakes(created_by_user_id)
  where created_by_user_id is not null;
create index if not exists inventory_stocktakes_submitted_by_user_idx
  on public.inventory_stocktakes(submitted_by_user_id)
  where submitted_by_user_id is not null;
create index if not exists inventory_stocktakes_posted_by_user_idx
  on public.inventory_stocktakes(posted_by_user_id)
  where posted_by_user_id is not null;
create index if not exists inventory_stocktakes_cancelled_by_user_idx
  on public.inventory_stocktakes(cancelled_by_user_id)
  where cancelled_by_user_id is not null;

create index if not exists inventory_stocktake_lines_counted_by_user_idx
  on public.inventory_stocktake_lines(counted_by_user_id)
  where counted_by_user_id is not null;
create index if not exists inventory_stocktake_lines_tenant_item_idx
  on public.inventory_stocktake_lines(tenant_id,item_id);
