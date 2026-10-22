-- Cover fuel-domain foreign keys with indexes for efficient joins and referential checks.
-- These supporting indexes are added as a follow-up because B1 and B2 migrations are already
-- applied in staging; do not edit or replay the historical migrations.

create index if not exists generator_fuel_events_created_by_idx
  on public.generator_fuel_events(created_by_user_id);

create index if not exists generator_fuel_events_destination_movement_fk_idx
  on public.generator_fuel_events(tenant_id,destination_movement_id);

create index if not exists generator_fuel_events_destination_warehouse_fk_idx
  on public.generator_fuel_events(tenant_id,site_id,destination_warehouse_id);

create index if not exists generator_fuel_events_item_fk_idx
  on public.generator_fuel_events(tenant_id,fuel_item_id);

create index if not exists generator_fuel_events_source_movement_fk_idx
  on public.generator_fuel_events(tenant_id,source_movement_id);

create index if not exists generator_fuel_events_source_warehouse_fk_idx
  on public.generator_fuel_events(tenant_id,site_id,source_warehouse_id);

create index if not exists generator_fuel_readings_created_by_idx
  on public.generator_fuel_readings(created_by_user_id);

create index if not exists generator_fuel_alert_settings_tank_scope_idx
  on public.generator_fuel_alert_settings(tenant_id,site_id,tank_warehouse_id);

create index if not exists generator_fuel_alert_settings_updated_by_idx
  on public.generator_fuel_alert_settings(updated_by_user_id);

create index if not exists generator_fuel_alert_setting_operations_setting_idx
  on public.generator_fuel_alert_setting_operations(tenant_id,site_id,settings_id);

create index if not exists generator_fuel_alert_setting_operations_created_by_idx
  on public.generator_fuel_alert_setting_operations(created_by_user_id);
