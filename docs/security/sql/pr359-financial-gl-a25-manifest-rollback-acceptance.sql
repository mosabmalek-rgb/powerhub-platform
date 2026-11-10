-- A25: Staging-only rollback test of exact cohort approval.
-- No durable users, manifest, or financial certification.
BEGIN;
CREATE TEMP TABLE a25_results(kind text,proof jsonb) ON COMMIT DROP;
DO $a25$
DECLARE mid bigint; reviewed jsonb; proof jsonb; coverage jsonb; blocked boolean;
BEGIN
 IF EXISTS(SELECT 1 FROM public.financial_gl_staging_fixture_manifests
   WHERE tenant_id=1 AND site_id=1)
 THEN RAISE EXCEPTION 'A25_MANIFEST_ALREADY_EXISTS';END IF;
 INSERT INTO auth.users(id,email) VALUES
 ('a2500000-0000-4000-8000-000000000001','a25-maker@invalid.example'),
 ('a2500000-0000-4000-8000-000000000002','a25-checker@invalid.example');
 INSERT INTO public.users(id,auth_user_id,name,role) VALUES
 (90000000002501,'a2500000-0000-4000-8000-000000000001','A25 TEMP MAKER','user'),
 (90000000002502,'a2500000-0000-4000-8000-000000000002','A25 TEMP CHECKER','user');
 INSERT INTO public.tenant_members(id,tenant_id,user_id,role,is_active,membership_status)
 VALUES (90000000002501,1,90000000002501,'owner',true,'active'),
 (90000000002502,1,90000000002502,'owner',true,'active');
 mid:=public.powerhub_financial_gl_fixture_manifest_prepare(1,1,90000000002501);
 blocked:=false;
 BEGIN
   PERFORM public.powerhub_financial_gl_fixture_manifest_review(1,1,mid,90000000002501);
 EXCEPTION WHEN SQLSTATE '22023' THEN
   IF SQLERRM='GL_FIXTURE_SELF_REVIEW' THEN blocked:=true; ELSE RAISE; END IF;
 END;
 IF NOT blocked THEN RAISE EXCEPTION 'A25_SELF_REVIEW_ACCEPTED';END IF;
 UPDATE public.tenant_members SET expires_at=statement_timestamp()-interval '1 day'
 WHERE tenant_id=1 AND user_id=90000000002502;
 blocked:=false;
 BEGIN
   PERFORM public.powerhub_financial_gl_fixture_manifest_review(1,1,mid,90000000002502);
 EXCEPTION WHEN SQLSTATE '22023' THEN
   IF SQLERRM='GL_FIXTURE_REVIEWER_FORBIDDEN' THEN blocked:=true;ELSE RAISE;END IF;
 END;
 IF NOT blocked THEN RAISE EXCEPTION 'A25_EXPIRED_REVIEWER_ACCEPTED';END IF;
 UPDATE public.tenant_members SET expires_at=NULL
 WHERE tenant_id=1 AND user_id=90000000002502;
 reviewed:=public.powerhub_financial_gl_fixture_manifest_review(1,1,mid,90000000002502);
 proof:=public.powerhub_financial_gl_verify_staging_fixture(1,1);
 IF reviewed->>'status'<>'verified' OR (proof->>'verified')::boolean IS DISTINCT FROM true
   OR (proof->>'quarantinedCount')::bigint<>250000
   OR proof->>'financialCertification'<>'NOT_CERTIFIED'
 THEN RAISE EXCEPTION 'A25_INDEPENDENT_COHORT_PROOF_FAILED';END IF;
 coverage:=public.powerhub_financial_gl_source_coverage(1,1,'2026-11');
 IF (coverage->>'unreconciledSourceCount')::bigint<>27
   OR (coverage->'sources'->'priorOperationalSources'->>'quarantinedTestMovements')::bigint<>250000
   OR coverage->>'accountingCertification'<>'NOT_CERTIFIED'
 THEN RAISE EXCEPTION 'A25_COVERAGE_NOT_EXACT: %',coverage->>'unreconciledSourceCount';END IF;
 INSERT INTO a25_results VALUES
 ('manifest',reviewed),('verification',proof),
 ('coverage',jsonb_build_object('unresolved',27,'quarantined',250000,'certification','NOT_CERTIFIED'));
END;
$a25$;
SELECT kind,proof FROM a25_results ORDER BY kind;
ROLLBACK;
