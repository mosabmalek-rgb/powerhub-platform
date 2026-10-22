-- Fuel event and reading ledgers are append-only. Explicitly revoke previously
-- inherited/default service-role mutation privileges; the SECURITY DEFINER RPCs
-- own the only write path that may insert or correct by appending a new row.
revoke all privileges on table public.generator_fuel_events, public.generator_fuel_readings
  from public, anon, authenticated, service_role;
grant select, insert on table public.generator_fuel_events, public.generator_fuel_readings
  to service_role;

revoke all privileges on sequence public.generator_fuel_events_id_seq, public.generator_fuel_readings_id_seq
  from public, anon, authenticated, service_role;
grant usage, select on sequence public.generator_fuel_events_id_seq, public.generator_fuel_readings_id_seq
  to service_role;
