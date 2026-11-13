-- Run on Staging after the protected migration, read-only proof. Never records acceptance.
DO $check$
DECLARE v jsonb;
BEGIN
 IF to_regprocedure('public.powerhub_financial_gl_monthly_comparison(bigint,bigint,text,text)') IS NULL
 THEN RAISE EXCEPTION 'C_COMPARE_RPC_NOT_INSTALLED';END IF;
 SELECT public.powerhub_financial_gl_monthly_comparison(1,1,'2026-11','2026-10') INTO v;
 IF v->>'accountingCertification'<>'NOT_CERTIFIED'
   OR v->>'status'<>'BLOCKED'
   OR (v->>'canExport')::boolean IS DISTINCT FROM false
   OR v->>'periodTimeZone'<>'Asia/Gaza'
   OR (v->>'sourceSnapshotAtomic')::boolean IS DISTINCT FROM true
   OR (v->>'currentRecognitionPolicyVersion') IS NOT NULL
   OR NOT (v->'blockers' ? 'RECOGNITION_POLICY_NOT_PROVEN')
 THEN RAISE EXCEPTION 'C_COMPARE_STAGING_FAIL_CLOSED_PROOF'; END IF;
 IF has_function_privilege('anon','public.powerhub_financial_gl_monthly_comparison(bigint,bigint,text,text)','EXECUTE')
 OR has_function_privilege('authenticated','public.powerhub_financial_gl_monthly_comparison(bigint,bigint,text,text)','EXECUTE')
 OR NOT has_function_privilege('service_role','public.powerhub_financial_gl_monthly_comparison(bigint,bigint,text,text)','EXECUTE')
 THEN RAISE EXCEPTION 'C_COMPARE_RPC_ACL_INVALID';END IF;
 RAISE NOTICE 'C_GL_COMPARISON_STAGING_BLOCKED_SOURCE_AND_ACL_PASS_NOT_CERTIFIED';
END
$check$;
