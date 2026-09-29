-- Production-safe reconciliation for the already-deployed offline generator update RPC.
-- The canonical implementation qualifies target columns; this function-level
-- setting provides equivalent resolution for the legacy Production body without
-- replacing the entire function definition.
alter function public.powerhub_sync_generator_update(
  bigint,bigint,text,numeric,numeric,numeric,text,timestamptz,text
) set plpgsql.variable_conflict = use_column;