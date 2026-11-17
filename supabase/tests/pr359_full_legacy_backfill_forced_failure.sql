-- Controlled failure AFTER the actual migration completes inside the same transaction.
DO $assert$
BEGIN
 IF (SELECT count(*) FROM public.subscriber_balance_ledger)<>5
 OR (SELECT count(*) FROM public.audit_logs)<>3
 THEN RAISE EXCEPTION 'MIGRATION_FAILED_BEFORE_INJECTION'; END IF;
 RAISE EXCEPTION 'PR359_CONTROLLED_FAILURE_AFTER_FULL_MIGRATION';
END $assert$;
