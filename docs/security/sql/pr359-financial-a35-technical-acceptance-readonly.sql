-- A35 final read-only technical fixture verification (after the migration).
WITH s AS (SELECT public.powerhub_financial_gl_verify_staging_fixture(1,1) proof),
c AS (SELECT public.powerhub_financial_gl_source_coverage(1,1,'2026-11') coverage),
t AS (SELECT count(*) n FROM public.financial_gl_staging_technical_exclusions
       WHERE tenant_id=1 AND site_id=1),
a AS (SELECT count(*) n FROM public.audit_logs
 WHERE tenant_id=1 AND site_id=1
 AND action='STAGING_PRELAUNCH_FIXTURE_TECHNICAL_EXCLUSION')
SELECT jsonb_build_object(
 'status',CASE WHEN (s.proof->>'verified')::boolean IS TRUE
  AND s.proof->>'verificationMode'='STAGING_PRELAUNCH_TECHNICAL'
  AND (s.proof->>'humanReviewed')::boolean IS FALSE
  AND (s.proof->>'quarantinedCount')::bigint=250000
  AND (c.coverage->>'unreconciledSourceCount')::bigint=27
  AND c.coverage->>'accountingCertification'='NOT_CERTIFIED'
  AND t.n=1 AND a.n=1 THEN 'PASS' ELSE 'FAIL' END,
 'verificationMode',s.proof->>'verificationMode',
 'humanReviewed',s.proof->>'humanReviewed',
 'retainedRawRows',s.proof->>'retainedRawRows',
 'remainingOperationalGaps',c.coverage->>'unreconciledSourceCount',
 'accountingCertification',c.coverage->>'accountingCertification',
 'technicalMarkers',t.n,'auditEvents',a.n
 ) evidence FROM s CROSS JOIN c CROSS JOIN t CROSS JOIN a;
