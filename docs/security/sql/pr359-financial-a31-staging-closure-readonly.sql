-- A31: read-only staging closure snapshot. No writes or artificial accounting certification.
WITH c AS (SELECT public.powerhub_financial_gl_source_coverage(1,1,'2026-11') AS v),
a AS (SELECT count(*) n FROM public.tenant_members m JOIN public.users u ON u.id=m.user_id
WHERE m.tenant_id=1 AND m.is_active AND m.membership_status='active'
AND (m.expires_at IS NULL OR m.expires_at>statement_timestamp())
AND u.account_status='active' AND m.role IN ('owner','manager','accountant')),
f AS (SELECT count(*) n,count(*) FILTER(WHERE status='verified') verified
FROM public.financial_gl_staging_fixture_manifests WHERE tenant_id=1 AND site_id=1),
technical AS (SELECT public.powerhub_financial_gl_verify_staging_fixture(1,1) AS proof),
fixture_accepted AS (
 SELECT ((f.verified>0 AND technical.proof->>'verificationMode'='HUMAN_INDEPENDENT_REVIEW')
    OR (technical.proof->>'verificationMode'='STAGING_PRELAUNCH_TECHNICAL'
      AND (technical.proof->>'humanReviewed')::boolean IS FALSE))
     AND (technical.proof->>'verified')::boolean IS TRUE
     AND (technical.proof->>'quarantinedCount')::bigint=250000 AS accepted
 FROM f CROSS JOIN technical),
o AS (SELECT count(*) posted FROM public.financial_gl_opening_batches
WHERE tenant_id=1 AND site_id=1 AND status='posted'),
g AS (SELECT count(*) posted FROM public.financial_gl_entries WHERE tenant_id=1 AND site_id=1)
SELECT jsonb_build_object('site',1,'period','2026-11',
 'reportType','READ_ONLY_NOT_CERTIFICATION','qualifiedReviewers',a.n,
 'fixtureManifests',f.n,'verifiedFixtureManifests',f.verified,
 'fixtureTechnicalVerification',technical.proof,
 'fixtureExclusionResolved',fixture_accepted.accepted,
 'postedOpenings',o.posted,'postedGLEntries',g.posted,
 'unreconciledSources',(c.v->>'unreconciledSourceCount')::bigint,
 'priorOperationalSources',c.v->'sources'->'priorOperationalSources',
 'sourceIntegrity',c.v->'sourceIntegrity','openingEvidenceAudit',c.v->'openingEvidenceAudit',
 'accountingCertification',c.v->>'accountingCertification',
 'blockers',to_jsonb(array_remove(ARRAY[
 CASE WHEN fixture_accepted.accepted IS DISTINCT FROM true
 THEN 'FIXTURE_VERIFICATION_PENDING' END,
 CASE WHEN o.posted=0 THEN 'OPENING_NOT_POSTED' END,
 CASE WHEN (c.v->>'unreconciledSourceCount')::bigint>0 THEN 'SOURCE_GL_INCOMPLETE' END,
 CASE WHEN (c.v->>'isOpeningReconciled')::boolean IS DISTINCT FROM true
 THEN 'OPENING_SUBLEDGER_RECONCILIATION_PENDING' END]::text[],NULL))
) AS snapshot FROM c CROSS JOIN a CROSS JOIN f CROSS JOIN o CROSS JOIN g
 CROSS JOIN technical CROSS JOIN fixture_accepted;