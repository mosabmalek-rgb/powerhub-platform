-- D28 installed-Staging acceptance; no DDL or financial writes.
BEGIN READ ONLY;
SET LOCAL statement_timeout='120000ms';
DO $accept$
DECLARE a jsonb;b jsonb;n bigint;e bigint;l bigint;t bigint;denied boolean:=false;
BEGIN
 SELECT count(*) INTO n FROM supabase_migrations.schema_migrations
 WHERE version='20261115230000'
 AND name='powerhub_financial_d28_cash_source_gl_chain';
 SELECT count(*) INTO e FROM public.financial_gl_entries;
 SELECT count(*) INTO l FROM public.financial_gl_lines;
 SELECT count(*) INTO t FROM public.account_transactions;
 IF n<>1 OR e<>25 OR l<>51 OR t<>361009
 OR to_regprocedure('public.powerhub_financial_cash_source_gl_chain(bigint,text)') IS NULL
 THEN RAISE EXCEPTION 'D28_INSTALLED_VERSION_OR_FIXTURE_NOT_VERIFIED';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=
 'public.powerhub_financial_cash_source_gl_chain(bigint,text)'::regprocedure
 AND provolatile='s' AND prosecdef=false
 AND 'search_path=pg_catalog, public, pg_temp'=ANY(proconfig))
 OR has_function_privilege('anon','public.powerhub_financial_cash_source_gl_chain(bigint,text)','EXECUTE')
 OR has_function_privilege('authenticated','public.powerhub_financial_cash_source_gl_chain(bigint,text)','EXECUTE')
 OR NOT has_function_privilege('service_role','public.powerhub_financial_cash_source_gl_chain(bigint,text)','EXECUTE')
 THEN RAISE EXCEPTION 'D28_INSTALLED_ACL_OR_FUNCTION_SECURITY_INVALID'; END IF;
 a:=public.powerhub_financial_cash_source_gl_chain(1,'2026-11');
 b:=public.powerhub_financial_cash_source_gl_chain(9000000000001,'2026-10');
 IF a->>'status' IS DISTINCT FROM 'BLOCKED_SOURCE_CASH_GL_RECONCILIATION'
 OR (a->>'totalCashMovementCount')::bigint<>250009
 OR (a->>'explicitSourceLinkedMovementCount')::bigint<>9
 OR (a->>'verifiedSourceCashGlMovementCount')::bigint<>9
 OR (a->>'unverifiedSourceCashGlMovementCount')::bigint<>0
 OR (a->>'verifiedPaymentCount')::bigint<>6
 OR (a->>'verifiedExpenseCount')::bigint<>1
 OR (a->>'verifiedSupplierPaymentCount')::bigint<>2
 OR (a->>'verifiedPaymentAmount')::numeric<>667
 OR (a->>'verifiedExpenseAmount')::numeric<>85
 OR (a->>'verifiedSupplierPaymentAmount')::numeric<>360
 OR (a->>'unlinkedNonTransferCashMovementCount')::bigint<>250000
 OR (a->>'technicalPerformancePrefixMovementCountNotExcluded')::bigint<>250000
 OR NOT (a->'blockers' @> '["UNLINKED_NON_TRANSFER_CASH_MOVEMENTS"]'::jsonb)
 OR a->>'accountingCertification' IS DISTINCT FROM 'NOT_CERTIFIED'
 OR a->>'independentFullLedgerReconciliation' IS DISTINCT FROM 'false'
 OR b->>'status' IS DISTINCT FROM 'BLOCKED_SOURCE_CASH_GL_RECONCILIATION'
 OR (b->>'totalCashMovementCount')::bigint<>105544
 OR (b->>'explicitSourceLinkedMovementCount')::bigint<>0
 OR (b->>'verifiedSourceCashGlMovementCount')::bigint<>0
 OR (b->>'unlinkedNonTransferCashMovementCount')::bigint<>84434
 OR (b->>'internalTransferMovementCount')::bigint<>21110
 OR NOT (b->'blockers' @> '["TRANSFERS_REQUIRE_SEPARATE_D27_AND_GL_PROOF","UNLINKED_NON_TRANSFER_CASH_MOVEMENTS"]'::jsonb)
 OR b->>'accountingCertification' IS DISTINCT FROM 'NOT_CERTIFIED'
 THEN RAISE EXCEPTION 'D28_INSTALLED_PROVENANCE_RECONCILIATION_FALSELY_CLEARED % %',a,b;
 END IF;
 BEGIN
 PERFORM public.powerhub_financial_cash_source_gl_chain(9000000000002,'2026-10');
 EXCEPTION WHEN SQLSTATE '22023' THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'D28_UNKNOWN_TENANT_NOT_REJECTED';END IF;
 IF (SELECT count(*) FROM public.financial_gl_entries)<>e
 OR (SELECT count(*) FROM public.financial_gl_lines)<>l
 OR (SELECT count(*) FROM public.account_transactions)<>t
 THEN RAISE EXCEPTION 'D28_FINANCIAL_BASELINE_CHANGED';END IF;
END $accept$;
SET LOCAL ROLE service_role;
DO $actor$
DECLARE a jsonb;b jsonb;
BEGIN
 a:=public.powerhub_financial_cash_source_gl_chain(1,'2026-11');
 b:=public.powerhub_financial_cash_source_gl_chain(9000000000001,'2026-10');
 IF (a->>'verifiedSourceCashGlMovementCount')::bigint<>9
 OR (b->>'internalTransferMovementCount')::bigint<>21110
 THEN RAISE EXCEPTION 'D28_INSTALLED_SERVICE_ROLE_NOT_WORKING';END IF;
END $actor$;
RESET ROLE;
SELECT 'D28_INSTALLED_STAGING_SOURCE_CASH_GL_ACL_AND_SERVICE_SCOPED_PASS' AS result;
ROLLBACK;