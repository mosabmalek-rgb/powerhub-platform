-- Production fix: generator offline sync RPCs already exist and write these operation types.
-- Keep the durable operation registry aligned with the live generator sync contract.

alter table public.offline_sync_operations
  drop constraint if exists offline_sync_operations_operation_type_check;

alter table public.offline_sync_operations
  add constraint offline_sync_operations_operation_type_check
  check (operation_type in ('subscriber_create','subscriber_update','generator_create','generator_update','invoice_issue','payment_create'));
