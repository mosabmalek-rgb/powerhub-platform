alter table public.offline_sync_operations drop constraint if exists offline_sync_operations_operation_type_check;
alter table public.offline_sync_operations add constraint offline_sync_operations_operation_type_check
check (operation_type = any (array[
'subscriber_create','subscriber_update','generator_create','generator_update',
'invoice_issue','payment_create','account_movement_create','account_transfer_create',
'expense_create','employee_create','site_create','collector_session_open','tariff_create'
]::text[]));