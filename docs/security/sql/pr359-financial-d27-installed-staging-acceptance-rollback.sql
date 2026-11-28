-- D27 acceptance AFTER versioned migration is installed on Supabase Staging.
-- Source-backed transfer pairs are not inferred from equal sums.
-- Non-mutating and rolled back, not a GL or accounting certification.
BEGIN;
SET LOCAL statement_timeout='120000ms';
DO $proof$
DECLARE a jsonb;b jsonb; e bigint; l bigint; t bigint; denied boolean:=false;
BEGIN
 SELECT count(*) INTO e FROM public.financial_gl_entries;
 SELECT count(*) INTO l FROM public.financial_gl_lines;
 SELECT count(*) INTO t FROM public.account_transactions;
 IF e<>25 OR l<>51 OR t<>361009
 OR NOT EXISTS(SELECT 1 FROM supabase_migrations.schema_migrations
   WHERE version='20261115193000'
   AND name='powerhub_financial_d27_transfer_operation_pair_provenance')
 OR to_regprocedure('public.powerhub_financial_company_transfer_pair_provenance(bigint,text)') IS NULL
 THEN RAISE EXCEPTION 'D27_VERSIONED_STAGING_NOT_INSTALLED_OR_BASELINE_CHANGED';END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_proc
   WHERE oid='public.powerhub_financial_company_transfer_pair_provenance(bigint,text)'::regprocedure
   AND provolatile='s' AND prosecdef=false)
 OR has_function_privilege('anon','public.powerhub_financial_company_transfer_pair_provenance(bigint,text)','EXECUTE')
 OR has_function_privilege('authenticated','public.powerhub_financial_company_transfer_pair_provenance(bigint,text)','EXECUTE')
 OR NOT has_function_privilege('service_role','public.powerhub_financial_company_transfer_pair_provenance(bigint,text)','EXECUTE')
 THEN RAISE EXCEPTION 'D27_INSTALLED_ACL_OR_FUNCTION_SECURITY_INVALID';END IF;
 a:=public.powerhub_financial_company_transfer_pair_provenance(9000000000001,'2026-10');
 b:=public.powerhub_financial_company_transfer_pair_provenance(1,'2026-10');
 IF a->>'status' IS DISTINCT FROM 'BLOCKED_TRANSFER_PROVENANCE'
 OR (a->>'transferMovementCount')::bigint<>21110
 OR (a->>'operationPairCount')::bigint<>0
 OR (a->>'verifiedOperationPairCount')::bigint<>0
 OR (a->>'unverifiedTransferMovementCount')::bigint<>21110
 OR (a->>'transferAmountDifference')::numeric<>10555
 OR NOT (a->'blockers' @> '["TRANSFER_SIDES_UNBALANCED","TRANSFER_MOVEMENT_WITHOUT_VERIFIED_OPERATION_PAIR" ]'::jsonb)
 OR a->>'pairCoverageComplete' IS DISTINCT FROM 'false'
 OR a->>'accountingCertification' IS DISTINCT FROM 'NOT_CERTIFIED'
 OR a->>'glAndCashIndependentlyReconciled' IS DISTINCT FROM 'false'
 OR b->>'status' IS DISTINCT FROM 'NO_TRANSFERS_PRELIMINARY'
 OR (b->>'transferMovementCount')::bigint<>0
 OR b->>'pairCoverageComplete' IS DISTINCT FROM 'false'
 OR b->>'accountingCertification' IS DISTINCT FROM 'NOT_CERTIFIED'
 THEN RAISE EXCEPTION 'D27_STAGING_PAIR_PROVENANCE_FALSELY_CLEARED'; END IF;
 BEGIN
  PERFORM public.powerhub_financial_company_transfer_pair_provenance(9000000000002,'2026-10');
 EXCEPTION WHEN SQLSTATE '22023' THEN denied:=true;END;
 IF NOT denied THEN RAISE EXCEPTION 'D27_UNKNOWN_TENANT_NOT_REJECTED';END IF;
 IF (SELECT count(*) FROM public.financial_gl_entries)<>e
 OR (SELECT count(*) FROM public.financial_gl_lines)<>l
 OR (SELECT count(*) FROM public.account_transactions)<>t
 THEN RAISE EXCEPTION 'D27_FINANCIAL_TABLES_CHANGED';END IF;
END $proof$;
SELECT 'D27_INSTALLED_STAGING_OPERATION_PAIR_PROVENANCE_SCOPED_PASS' AS result;
ROLLBACK;