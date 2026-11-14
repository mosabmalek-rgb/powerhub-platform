-- B5.23: read-only, staging-scoped regression for the compact exact-fixture
-- count index. Does not fabricate ledger entries or bypass source verification.
-- Expected to be executed against the isolated B5 test tenant and site only.
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout='16000ms';
DO $test$
DECLARE
 p jsonb; report jsonb; current_count bigint; index_state record;
BEGIN
 SELECT ic.relname AS index_name, ix.indisvalid, ix.indisready,
        pg_get_expr(ix.indpred,ix.indrelid) AS predicate
 INTO index_state
 FROM pg_index ix JOIN pg_class ic ON ic.oid=ix.indexrelid
 WHERE ix.indrelid='public.account_transactions'::regclass
   AND ic.relname='account_transactions_b523_fixture_count_compact_idx';

 IF index_state.index_name IS NULL
   OR NOT index_state.indisvalid OR NOT index_state.indisready
   OR index_state.predicate NOT ILIKE '%STG-PERF-%'
 THEN RAISE EXCEPTION 'B523_INDEX_MISSING_OR_INVALID'; END IF;

 SELECT count(*) INTO current_count FROM public.account_transactions
 WHERE tenant_id=1 AND site_id=1 AND reference_no LIKE 'STG-PERF-%';
 IF current_count<>250000 THEN RAISE EXCEPTION 'B523_FIXTURE_COUNT_DRIFT'; END IF;
 p:=public.powerhub_financial_gl_fast_staging_fixture_proof(1,1);
 IF (p->>'verified')::boolean IS DISTINCT FROM true
   OR (p->>'quarantinedCount')::bigint IS DISTINCT FROM 250000
   OR p->>'sha256' IS DISTINCT FROM
      'f1b25e8562328a0f6e916beb4d54b2ee88366e78b4459c5d0ebc444616997df9'
   OR p->>'financialCertification' IS DISTINCT FROM 'NOT_CERTIFIED'
 THEN RAISE EXCEPTION 'B523_HASH_ANCHORED_FIXTURE_NOT_VERIFIED'; END IF;

 report:=public.powerhub_financial_gl_subledger_reconciliation(1,1,'2026-11');
 IF report->>'accountingCertification' IS DISTINCT FROM 'NOT_CERTIFIED'
   OR (report->>'tenantId')::bigint IS DISTINCT FROM 1
   OR (report->>'siteId')::bigint IS DISTINCT FROM 1
   OR (report->>'isApproved')::boolean IS DISTINCT FROM false
 THEN RAISE EXCEPTION 'B523_REPORT_SCOPE_OR_CERTIFICATION_DRIFT'; END IF;

 IF (public.powerhub_financial_gl_fast_staging_fixture_proof(1,99999)->>'verified')::boolean
    IS DISTINCT FROM false
 THEN RAISE EXCEPTION 'B523_OTHER_SITE_VERIFICATION_LEAK'; END IF;
END $test$;
SELECT 'B523_STAGING_READ_ONLY_PROOF_PASS' AS acceptance;
ROLLBACK;
