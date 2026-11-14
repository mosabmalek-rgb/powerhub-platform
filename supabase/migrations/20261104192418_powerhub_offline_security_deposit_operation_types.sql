-- The security-deposit RPCs persist idempotency records using dedicated
-- operation types. Keep the existing 21-value contract and explicitly permit
-- receipt/refund so the financial write and its idempotency row commit atomically.
DO $operation_type_preflight$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.offline_sync_operations
    WHERE NOT (operation_type = ANY (ARRAY[
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
    'subscriber_bulk_import',
    'security_deposit_receipt',
    'security_deposit_refund'
    ]::text[]))
  ) THEN
    RAISE EXCEPTION 'OFFLINE_SECURITY_DEPOSIT_OPERATION_TYPE_UNSUPPORTED_EXISTING_ROWS';
  END IF;
END
$operation_type_preflight$;

ALTER TABLE public.offline_sync_operations
  DROP CONSTRAINT IF EXISTS offline_sync_operations_operation_type_check;

ALTER TABLE public.offline_sync_operations
  ADD CONSTRAINT offline_sync_operations_operation_type_check
  CHECK (operation_type = ANY (ARRAY[
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
    'subscriber_bulk_import',
    'security_deposit_receipt',
    'security_deposit_refund'
  ]::text[]));
