-- D29 acceptance AFTER exact versioned migration is installed on Staging.
-- Read only. The fast proof does not recompute SHA on this invocation.
BEGIN READ ONLY;
SET LOCAL statement_timeout='120000ms';
DO $proof$
DECLARE a jsonb;b jsonb;c jsonb;e bigint;l bigint;t bigint;denied boolean:=false;
BEGIN
 SELECT count(*) INTO e FROM public.financial_gl_entries;
 SELECT count(*) INTO l FROM public.financial_gl_lines;
 SELECT count(*) INTO t FROM public.account_transactions;
 IF e<>25 OR l<>51 OR t<>361009
 OR NOT EXISTS(SELECT 1 FROM supabase_migrations.schema_migrations
    WHERE version='20261115233000'
    AND name='powerhub_financial_d29_fixture_evidence_partition')
 OR to_regprocedure('public.powerhub_financial_d29_fixture_evidence_partition(bigint,text)') IS NULL
 THEN RAISE EXCEPTION 'D29_MIGRATION_NOT_INSTALLED_OR_FINANCIAL_BASELINE_DRIFT';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=
    'public.powerhub_financial_d29_fixture_evidence_partition(bigint,text)'::regprocedure
    AND provolatile='s' AND prosecdef=false)
 OR has_function_privilege('anon','public.powerhub_financial_d29_fixture_evidence_partition(bigint,text)','EXECUTE')
 OR has_function_privilege('authenticated','public.powerhub_financial_d29_fixture_evidence_partition(bigint,text)','EXECUTE')
 OR NOT has_function_privilege('service_role','public.powerhub_financial_d29_fixture_evidence_partition(bigint,text)','EXECUTE')
 THEN RAISE EXCEPTION 'D29_UNSAFE_INSTALLED_FUNCTION_OR_ACL'; END IF;
 a:=public.powerhub_financial_d29_fixture_evidence_partition(1,'2026-11');
 b:=public.powerhub_financial_d29_fixture_evidence_partition(9000000000001,'2026-10');
 c:=public.powerhub_financial_d29_fixture_evidence_partition(1,'2026-04');
 IF a->>'partitionStatus' IS DISTINCT FROM 'PRELIMINARY_TECHNICAL_COHORT_SEPARATED'
 OR (a->>'rawAccountMovementCount')::bigint<>250009
 OR (a->>'rawExplicitSourceLinkedCount')::bigint<>9
 OR (a->>'rawUnlinkedNonTransferMovementCount')::bigint<>250000
 OR (a->>'verifiedTechnicalFixtureMovementCountForAnalysisOnly')::bigint<>250000
 OR (a->>'unlinkedMovementCountAfterEvidencePartitionNotCertified')::bigint<>0
 OR a->>'sourceReportStatus' IS DISTINCT FROM 'BLOCKED_SOURCE_CASH_GL_RECONCILIATION'
 OR a->>'technicalPartitionAuthorizesAccountingExclusion' IS DISTINCT FROM 'false'
 OR a->>'accountingCertification' IS DISTINCT FROM 'NOT_CERTIFIED'
 OR a->>'humanReviewedTechnicalFixture' IS DISTINCT FROM 'false'
 OR a->>'fullShaRecomputedOnThisRequest' IS DISTINCT FROM 'false'
 OR (b->>'rawAccountMovementCount')::bigint<>105544
 OR (b->>'verifiedTechnicalFixtureMovementCountForAnalysisOnly')::bigint<>0
 OR (b->>'unlinkedMovementCountAfterEvidencePartitionNotCertified')::bigint<>84434
 OR (b->>'rawInternalTransferMovementCount')::bigint<>21110
 OR b->>'partitionStatus' IS DISTINCT FROM 'BLOCKED_SOURCE_COVERAGE_OR_EVIDENCE'
 OR (c->>'verifiedTechnicalFixtureMovementCountForAnalysisOnly')::bigint<>0
 OR c->>'accountingCertification' IS DISTINCT FROM 'NOT_CERTIFIED'
 THEN RAISE EXCEPTION 'D29_INSTALLED_FALSE_PARTITION_OR_CERTIFICATION';END IF;
 BEGIN
  PERFORM public.powerhub_financial_d29_fixture_evidence_partition(9000000000002,'2026-11');
 EXCEPTION WHEN SQLSTATE '22023' THEN denied:=true;END;
 IF NOT denied THEN RAISE EXCEPTION 'D29_UNKNOWN_TENANT_ALLOWED';END IF;
END $proof$;
SET LOCAL ROLE service_role;
DO $service$
DECLARE j jsonb;
BEGIN
 j:=public.powerhub_financial_d29_fixture_evidence_partition(1,'2026-11');
 IF (j->>'verifiedTechnicalFixtureMovementCountForAnalysisOnly')::bigint<>250000
 OR j->>'accountingCertification' IS DISTINCT FROM 'NOT_CERTIFIED'
 THEN RAISE EXCEPTION 'D29_SERVICE_ROLE_INSTALLED_PROOF_FAILURE';END IF;
END $service$;
RESET ROLE;
SELECT 'D29_INSTALLED_STAGING_TECHNICAL_FIXTURE_EVIDENCE_SCOPED_PASS' AS result;
ROLLBACK;