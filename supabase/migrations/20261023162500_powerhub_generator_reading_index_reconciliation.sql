-- Reconcile proven generator/reading hot-path indexes and the generator updated_at trigger.
-- These objects are present in Production and are used by live query paths; no application data is changed.

create index if not exists generators_created_at_idx
  on public.generators (created_at desc);

create unique index if not exists meter_readings_approval_operation_uidx
  on public.meter_readings (approval_client_operation_id)
  where approval_client_operation_id is not null;

create index if not exists meter_readings_opening_baseline_idx
  on public.meter_readings (tenant_id, subscriber_id, is_opening_baseline, reading_at desc);

create index if not exists meter_readings_status_idx
  on public.meter_readings (status);

create index if not exists meter_readings_status_reading_at_idx
  on public.meter_readings (status, reading_at desc);

create index if not exists meter_readings_subscriber_date_idx
  on public.meter_readings (subscriber_id, reading_at desc);

create index if not exists meter_readings_subscriber_id_idx
  on public.meter_readings (subscriber_id);

create index if not exists meter_readings_tenant_reading_at_id_desc_idx
  on public.meter_readings (tenant_id, reading_at desc, id desc);

drop trigger if exists generators_set_updated_at on public.generators;
create trigger generators_set_updated_at
before update on public.generators
for each row execute function public.powerhub_set_updated_at();
