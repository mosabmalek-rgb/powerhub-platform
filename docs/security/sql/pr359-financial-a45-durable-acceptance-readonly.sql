-- A45 durable/read-only acceptance gate. No modifications.
DO $verify$
DECLARE a jsonb;prev jsonb;
BEGIN
 a:=public.powerhub_financial_gl_source_coverage(1,1,'2026-11');
 prev:=public.powerhub_financial_gl_source_coverage(1,1,'2026-10');
 IF a->'technicalAcceptance'->>'status'<>'PASS_PRELAUNCH_ENGINEERING_ONLY'
 OR (a->'technicalAcceptance'->>'isEngineeringAccepted')::boolean IS DISTINCT FROM true
 OR (a->'technicalAcceptance'->>'postedGL')::bigint<>21
 OR (a->'technicalAcceptance'->>'operationalSources')::bigint<>18
 OR (a->'technicalAcceptance'->>'serviceRecognitionEntries')::bigint<>3
 OR (a->>'unreconciledSourceCount')::bigint<>0
 OR (a->'sourceIntegrity'->>'isClean')::boolean IS DISTINCT FROM true
 OR (a->>'isOpeningReconciled')::boolean IS DISTINCT FROM false
 OR (a->>'isSourceCoverageComplete')::boolean IS DISTINCT FROM false
 OR a->>'accountingCertification'<>'NOT_CERTIFIED'
 OR a->'technicalAcceptance'->>'accountingCertification'<>'NOT_CERTIFIED'
 OR (a->'technicalAcceptance'->>'humanApproved')::boolean IS DISTINCT FROM false
 OR (a->'technicalAcceptance'->>'isFinalFinancialAcceptance')::boolean IS DISTINCT FROM false
 OR (prev->'technicalAcceptance'->>'isEngineeringAccepted')::boolean IS DISTINCT FROM false
 THEN RAISE EXCEPTION 'A45_ACCEPTANCE_FAILED_CLOSED';END IF;
END;$verify$;
SELECT jsonb_build_object('status','PASS_READ_ONLY',
 'technical',public.powerhub_financial_gl_source_coverage(1,1,'2026-11')->'technicalAcceptance',
 'certification','NOT_CERTIFIED') AS result;
