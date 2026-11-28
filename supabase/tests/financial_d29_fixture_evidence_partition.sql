-- D29 disposable PostgreSQL contract: exact migration SQL with small deterministic
-- upstream D28/B5 proof stubs (NOT a replacement for installed-Staging acceptance).
\set ON_ERROR_STOP on
DO $roles$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN;END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN;END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN;END IF;
END $roles$;
CREATE TABLE public.sites(id bigint PRIMARY KEY,tenant_id bigint,status text);
INSERT INTO public.sites VALUES(1,1,'active'),(2,9000000000001,'active');
GRANT USAGE ON SCHEMA public TO service_role;
GRANT SELECT ON public.sites TO service_role;
CREATE FUNCTION public.powerhub_financial_cash_source_gl_chain(p_tenant bigint,p_period text)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER AS $stub$
BEGIN
 IF p_tenant NOT IN (1,9000000000001)
 THEN RAISE EXCEPTION 'UNKNOWN_TEST_TENANT' USING ERRCODE='22023';END IF;
 IF p_tenant=1 THEN
  IF p_period='2026-11' THEN
   RETURN jsonb_build_object('tenantId',1,'period',p_period,
    'accountingCertification','NOT_CERTIFIED',
    'independentFullLedgerReconciliation',false,'glCashLegOnlyProof',true,
    'status','BLOCKED_SOURCE_CASH_GL_RECONCILIATION',
    'totalCashMovementCount',250009,'explicitSourceLinkedMovementCount',9,
    'unverifiedSourceCashGlMovementCount',0,
    'unlinkedNonTransferCashMovementCount',250000,'internalTransferMovementCount',0,
    'technicalPerformancePrefixMovementCountNotExcluded',250000,
    'verifiedSourceCashGlMovementCount',9);
  ELSE
   RETURN jsonb_build_object('tenantId',1,'period',p_period,
    'accountingCertification','NOT_CERTIFIED',
    'independentFullLedgerReconciliation',false,'glCashLegOnlyProof',true,
    'status','BLOCKED_SOURCE_CASH_GL_RECONCILIATION',
    'totalCashMovementCount',0,'explicitSourceLinkedMovementCount',0,
    'unverifiedSourceCashGlMovementCount',0,
    'unlinkedNonTransferCashMovementCount',0,'internalTransferMovementCount',0,
    'technicalPerformancePrefixMovementCountNotExcluded',0,
    'verifiedSourceCashGlMovementCount',0);
  END IF;
 END IF;
 RETURN jsonb_build_object('tenantId',p_tenant,'period',p_period,
    'accountingCertification','NOT_CERTIFIED',
    'independentFullLedgerReconciliation',false,'glCashLegOnlyProof',true,
    'status','BLOCKED_SOURCE_CASH_GL_RECONCILIATION',
    'totalCashMovementCount',105544,'explicitSourceLinkedMovementCount',0,
    'unverifiedSourceCashGlMovementCount',0,
    'unlinkedNonTransferCashMovementCount',84434,'internalTransferMovementCount',21110,
    'technicalPerformancePrefixMovementCountNotExcluded',0,
    'verifiedSourceCashGlMovementCount',0);
END $stub$;
CREATE FUNCTION public.powerhub_financial_gl_fast_staging_fixture_proof(pt bigint,ps bigint)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER AS $stub$
DECLARE v_good boolean:=coalesce(current_setting('powerhub.test_fixture_guard',true),'on')='on';
BEGIN
 RETURN jsonb_build_object('verified',v_good AND pt=1 AND ps=1,
  'quarantinedCount',CASE WHEN v_good AND pt=1 AND ps=1 THEN 250000 ELSE 0 END,
  'verificationMode','STAGING_PRELAUNCH_TECHNICAL','humanReviewed',false,
  'retainedRawRows',true,'financialCertification','NOT_CERTIFIED',
  'sha256','f1b25e8562328a0f6e916beb4d54b2ee88366e78b4459c5d0ebc444616997df9',
  'reason',CASE WHEN v_good THEN 'HASH_ANCHORED_IMMUTABLE_STAGING_TEST_COHORT'
                ELSE 'FAST_PROOF_UNAVAILABLE_OR_DRIFTED' END);
END $stub$;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_cash_source_gl_chain(bigint,text),
 public.powerhub_financial_gl_fast_staging_fixture_proof(bigint,bigint) TO service_role;
\ir ../migrations/20261115233000_powerhub_financial_d29_fixture_evidence_partition.sql
DO $positive$
DECLARE a jsonb;b jsonb;c jsonb;denied boolean:=false;
BEGIN
 a:=public.powerhub_financial_d29_fixture_evidence_partition(1,'2026-11');
 b:=public.powerhub_financial_d29_fixture_evidence_partition(9000000000001,'2026-10');
 c:=public.powerhub_financial_d29_fixture_evidence_partition(1,'2026-04');
 IF a->>'partitionStatus' IS DISTINCT FROM 'PRELIMINARY_TECHNICAL_COHORT_SEPARATED'
 OR (a->>'verifiedTechnicalFixtureMovementCountForAnalysisOnly')::bigint<>250000
 OR (a->>'unlinkedMovementCountAfterEvidencePartitionNotCertified')::bigint<>0
 OR a->>'technicalPartitionAuthorizesAccountingExclusion' IS DISTINCT FROM 'false'
 OR a->>'accountingCertification' IS DISTINCT FROM 'NOT_CERTIFIED'
 OR a->>'sourceReportStatus' IS DISTINCT FROM 'BLOCKED_SOURCE_CASH_GL_RECONCILIATION'
 OR b->>'partitionStatus' IS DISTINCT FROM 'BLOCKED_SOURCE_COVERAGE_OR_EVIDENCE'
 OR (b->>'verifiedTechnicalFixtureMovementCountForAnalysisOnly')::bigint<>0
 OR (b->>'rawInternalTransferMovementCount')::bigint<>21110
 OR (c->>'verifiedTechnicalFixtureMovementCountForAnalysisOnly')::bigint<>0
 THEN RAISE EXCEPTION 'D29_DISPOSABLE_VALIDATION_INVALID % % %',a,b,c; END IF;
 IF has_function_privilege('anon','public.powerhub_financial_d29_fixture_evidence_partition(bigint,text)','EXECUTE')
 OR has_function_privilege('authenticated','public.powerhub_financial_d29_fixture_evidence_partition(bigint,text)','EXECUTE')
 OR NOT has_function_privilege('service_role','public.powerhub_financial_d29_fixture_evidence_partition(bigint,text)','EXECUTE')
 THEN RAISE EXCEPTION 'D29_BROAD_EXECUTE_PRIVILEGE';END IF;
 BEGIN
 PERFORM public.powerhub_financial_d29_fixture_evidence_partition(999,'2026-11');
 EXCEPTION WHEN SQLSTATE '22023' THEN denied:=true;END;
 IF NOT denied THEN RAISE EXCEPTION 'D29_UNKNOWN_TENANT_ALLOWED';END IF;
END $positive$;
SET ROLE service_role;
DO $actor$
DECLARE j jsonb;
BEGIN
 j:=public.powerhub_financial_d29_fixture_evidence_partition(1,'2026-11');
 IF (j->>'verifiedTechnicalFixtureMovementCountForAnalysisOnly')::bigint<>250000
 OR j->>'accountingCertification' IS DISTINCT FROM 'NOT_CERTIFIED'
 THEN RAISE EXCEPTION 'D29_SERVICE_ROLE_TEST_FAILED';END IF;
END $actor$;
RESET ROLE;
SELECT set_config('powerhub.test_fixture_guard','off',false);
DO $negative$
DECLARE j jsonb;
BEGIN
 j:=public.powerhub_financial_d29_fixture_evidence_partition(1,'2026-11');
 IF j->>'partitionStatus' IS DISTINCT FROM 'BLOCKED_SOURCE_COVERAGE_OR_EVIDENCE'
 OR (j->>'verifiedTechnicalFixtureMovementCountForAnalysisOnly')::bigint<>0
 OR (j->>'unlinkedMovementCountAfterEvidencePartitionNotCertified')::bigint<>250000
 OR NOT j->'blockers' @> '["KNOWN_TECHNICAL_COHORT_EVIDENCE_MISSING_OR_DRIFTED"]'::jsonb
 THEN RAISE EXCEPTION 'D29_UNVERIFIED_PROOF_WRONGLY_EXCLUDED';END IF;
END $negative$;
SELECT set_config('powerhub.test_fixture_guard','on',false);
SELECT 'D29_DISPOSABLE_SCOPED_FIXTURE_PROOF_AND_FAIL_CLOSED_PASS' AS result;