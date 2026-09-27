-- Remove the duplicate meter-readings hot-path index introduced by the first production application.
drop index if exists public.meter_readings_tenant_site_reading_at_id_idx;
