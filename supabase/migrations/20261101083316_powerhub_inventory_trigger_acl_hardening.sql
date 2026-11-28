-- Trigger-only inventory guard: never expose EXECUTE through the Supabase Data API.
-- The trigger remains attached to inventory_stock_movements; service_role is the
-- only application role that can write these server-posted stock movements.
do $inventory_trigger_acl$
begin
  if to_regprocedure('public.powerhub_inventory_validate_location_item()') is null then
    raise exception 'INVENTORY_LOCATION_GUARD_TRIGGER_FUNCTION_MISSING';
  end if;
  if not exists (
    select 1
    from pg_trigger t
    where t.tgrelid='public.inventory_stock_movements'::regclass
      and t.tgname='inventory_stock_movements_location_item_guard'
      and not t.tgisinternal
      and t.tgfoid='public.powerhub_inventory_validate_location_item()'::regprocedure
  ) then
    raise exception 'INVENTORY_LOCATION_GUARD_TRIGGER_NOT_ATTACHED';
  end if;
end
$inventory_trigger_acl$;

revoke all on function public.powerhub_inventory_validate_location_item() from public, anon, authenticated;
grant execute on function public.powerhub_inventory_validate_location_item() to service_role;
