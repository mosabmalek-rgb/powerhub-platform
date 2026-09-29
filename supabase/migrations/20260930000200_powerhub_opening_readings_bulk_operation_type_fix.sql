-- PowerHub: reconcile bulk subscriber opening-reading replay with offline operation type contract.
-- The opening-reading bulk RPC uses a dedicated operation type for idempotent replay,
-- so the existing allow-list must recognize it.

alter table public.offline_sync_operations
  drop constraint if exists offline_sync_operations_operation_type_check;

alter table public.offline_sync_operations
  add constraint offline_sync_operations_operation_type_check
  check (
    operation_type = any (array[
      'subscriber_create',
      'subscriber_update',
      'generator_create',
      'generator_update',
      'invoice_issue',
      'payment_create',
      'account_movement_create',
      'account_transfer_create',
      'expense_create',
      'employee_create',
      'site_create',
      'collector_session_open',
      'tariff_create',
      'company_account_create',
      'staff_create',
      'subscription_renew',
      'subscription_update',
      'subscription_quick_upgrade',
      'reading_update',
      'reading_delete',
      'subscriber_bulk_import'
    ]::text[])
  );