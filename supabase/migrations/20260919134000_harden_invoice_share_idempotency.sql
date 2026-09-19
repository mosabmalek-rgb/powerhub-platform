-- Reconcile the production invoice-share retry contract with the branch.
alter table public.invoice_share_links
  add column if not exists client_operation_id text,
  add column if not exists created_by_user_id bigint;

create unique index if not exists invoice_share_links_client_operation_id_key
  on public.invoice_share_links(client_operation_id)
  where client_operation_id is not null;
