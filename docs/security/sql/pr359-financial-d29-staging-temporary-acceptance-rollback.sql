-- Run this fixture in same BEGIN transaction immediately after loading the D29 migration source; fully rolled back.

DO $a$
DECLARE a jsonb;b jsonb;c jsonb;denied boolean:=false;
BEGIN
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
 OR a->>'fullShaRecomputedOnThisRequest' IS DISTINCT FROM 'false'
 OR (b->>'verifiedTechnicalFixtureMovementCountForAnalysisOnly')::bigint<>0
 OR (b->>'unlinkedMovementCountAfterEvidencePartitionNotCertified')::bigint<>84434
 OR (b->>'rawInternalTransferMovementCount')::bigint<>21110
 OR b->>'partitionStatus' IS DISTINCT FROM 'BLOCKED_SOURCE_COVERAGE_OR_EVIDENCE'
 OR (c->>'verifiedTechnicalFixtureMovementCountForAnalysisOnly')::bigint<>0
 OR c->>'accountingCertification' IS DISTINCT FROM 'NOT_CERTIFIED'
 THEN RAISE EXCEPTION 'D29_POSITIVE_SCOPE_OR_CERTIFICATION_INVALID';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.powerhub_financial_d29_fixture_evidence_partition(bigint,text)'::regprocedure AND provolatile='s' AND prosecdef=false)
 OR has_function_privilege('anon','public.powerhub_financial_d29_fixture_evidence_partition(bigint,text)','EXECUTE')
 OR has_function_privilege('authenticated','public.powerhub_financial_d29_fixture_evidence_partition(bigint,text)','EXECUTE')
 OR NOT has_function_privilege('service_role','public.powerhub_financial_d29_fixture_evidence_partition(bigint,text)','EXECUTE')
 THEN RAISE EXCEPTION 'D29_ACL_INCORRECT';END IF;
 BEGIN PERFORM public.powerhub_financial_d29_fixture_evidence_partition(9000000000002,'2026-11');
 EXCEPTION WHEN SQLSTATE '22023' THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'D29_UNKNOWN_TENANT_ALLOWED'; END IF;
END $a$;
SAVEPOINT fixture_guard_disabled;
ALTER TABLE public.account_transactions DISABLE TRIGGER powerhub_financial_gl_fixture_freeze_write;
DO $a$
DECLARE j jsonb;
BEGIN
 j:=public.powerhub_financial_d29_fixture_evidence_partition(1,'2026-11');
 IF (j->>'verifiedTechnicalFixtureMovementCountForAnalysisOnly')::bigint<>0
 OR (j->>'unlinkedMovementCountAfterEvidencePartitionNotCertified')::bigint<>250000
 OR j->>'partitionStatus' IS DISTINCT FROM 'BLOCKED_SOURCE_COVERAGE_OR_EVIDENCE'
 OR NOT (j->'blockers' @> '["KNOWN_TECHNICAL_COHORT_EVIDENCE_MISSING_OR_DRIFTED"]'::jsonb)
 THEN RAISE EXCEPTION 'D29_DISABLED_FREEZE_GUARD_FAILED_CLOSED %',j; END IF;
END $a$;
ROLLBACK TO SAVEPOINT fixture_guard_disabled;
DO $a$
DECLARE j jsonb;
BEGIN
 j:=public.powerhub_financial_d29_fixture_evidence_partition(1,'2026-11');
 IF (j->>'verifiedTechnicalFixtureMovementCountForAnalysisOnly')::bigint<>250000
 OR (SELECT count(*) FROM public.financial_gl_entries)<>25
 OR (SELECT count(*) FROM public.financial_gl_lines)<>51
 OR (SELECT count(*) FROM public.account_transactions)<>361009
 THEN RAISE EXCEPTION 'D29_ROLLBACK_BASELINE_NOT_RESTORED';END IF;
END $a$;
SELECT 'D29_STAGING_TECHNICAL_EVIDENCE_PARTITION_FAIL_CLOSED_ROLLBACK_PASS' AS result;
