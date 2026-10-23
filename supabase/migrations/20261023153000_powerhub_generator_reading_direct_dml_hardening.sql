-- Match production's prohibition on direct table mutations to generator configuration and raw meter readings.
-- All operational mutations must pass through the authorized server/RPC paths, which enforce capabilities, scope, audit and idempotency.
revoke insert, update, delete, truncate
  on table public.generators, public.meter_readings
  from anon, authenticated;
