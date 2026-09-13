-- P7.3: generator offline replay identity.
-- Production remains unchanged until the P7 release gate is explicitly approved.

alter table public.generators
  add column if not exists client_operation_id text;

create unique index if not exists generators_client_operation_id_key
  on public.generators (client_operation_id)
  where client_operation_id is not null;
