-- Production reconciliation for the already-deployed offline generator RPC bodies.
-- The canonical #108 migration contains the same function bodies but Production
-- retained SECURITY INVOKER because the migration had not yet been applied.
-- Only execution context and browser ACLs are reconciled here.

alter function public.powerhub_sync_generator_create(
  bigint,text,text,text,numeric,text,text
) security definer
set search_path = public, pg_temp;

alter function public.powerhub_sync_generator_update(
  bigint,bigint,text,numeric,numeric,numeric,text,timestamptz,text
) security definer
set search_path = public, pg_temp;

revoke execute on function public.powerhub_sync_generator_create(
  bigint,text,text,text,numeric,text,text
) from public, anon;

revoke execute on function public.powerhub_sync_generator_update(
  bigint,bigint,text,numeric,numeric,numeric,text,timestamptz,text
) from public, anon;

grant execute on function public.powerhub_sync_generator_create(
  bigint,text,text,text,numeric,text,text
) to authenticated;

grant execute on function public.powerhub_sync_generator_update(
  bigint,bigint,text,numeric,numeric,numeric,text,timestamptz,text
) to authenticated;
