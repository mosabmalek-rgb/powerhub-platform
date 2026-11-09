-- Phase A acceptance. Strictly read-only: produces evidence for one
-- tenant/site and a through-period, and never manufactures GL/opening values.
-- Run under an authorized SQL review connection on Staging only.
-- Set via psql: \set tenant_id 1 \set site_id 1 \set period '2026-11'
-- For Supabase SQL editor, replace params in the input CTE.
WITH input AS (
 SELECT 1::bigint AS tenant_id,1::bigint AS site_id,'2026-11'::text AS period
), reports AS MATERIALIZED (
 SELECT i.*, public.powerhub_financial_gl_source_coverage(i.tenant_id,i.site_id,i.period) AS coverage,
   public.powerhub_financial_gl_trial_balance(i.tenant_id,i.site_id,i.period) AS trial
 FROM input i
), evidence AS (
 SELECT r.*,
  COALESCE((coverage->>'unreconciledSourceCount')::bigint,-1) AS unresolved,
  (coverage->'sourceIntegrity'->>'isClean')::boolean AS source_clean,
  (coverage->>'isSourceCoverageComplete')::boolean AS sources_complete,
  (coverage->>'isOpeningStructurallyPosted')::boolean AS opening_posted,
  (coverage->>'isOpeningReconciled')::boolean AS opening_reconciled,
  (coverage->'openingEvidenceAudit'->>'accountBalancesMatchedToOpening')::boolean AS matched_opening,
  (coverage->'openingEvidenceAudit'->>'sourceSubledgersIndependentlyVerified')::boolean AS verified_subledgers,
  coalesce((coverage->'sources'->'priorOperationalSources'->>'performanceFixtureTagged')::bigint,0) AS performance_fixtures,
  (trial->>'difference')::numeric AS balance_difference,
  (trial->>'postedEntryCount')::bigint AS gl_entries
 FROM reports r
)
SELECT tenant_id,site_id,period,
  CASE WHEN gl_entries>0 AND balance_difference=0 AND source_clean IS TRUE
    THEN 'PASS' ELSE 'BLOCKED' END AS gl_structural_check,
  CASE WHEN sources_complete IS TRUE AND unresolved=0
    THEN 'PASS' ELSE 'BLOCKED' END AS source_completeness_check,
  CASE WHEN opening_posted IS TRUE AND opening_reconciled IS TRUE
   AND matched_opening IS TRUE AND verified_subledgers IS TRUE
    THEN 'PASS' ELSE 'BLOCKED' END AS opening_independent_evidence_check,
  CASE WHEN performance_fixtures=0
    THEN 'PASS' ELSE 'BLOCKED' END AS performance_fixture_segregation_check,
  CASE WHEN coverage->>'accountingCertification'='CERTIFIED'
    AND trial->>'accountingCertification'='CERTIFIED'
    AND trial->>'isFinalBalanceSheet'='true'
    AND sources_complete IS TRUE AND unresolved=0
    AND opening_reconciled IS TRUE AND verified_subledgers IS TRUE
    AND matched_opening IS TRUE AND source_clean IS TRUE
    AND performance_fixtures=0 AND balance_difference=0 AND gl_entries>0
   THEN 'PASS' ELSE 'BLOCKED' END AS phase_a_accounting_acceptance,
  unresolved AS unresolved_source_count,gl_entries AS posted_gl_count,
  performance_fixtures AS performance_fixture_count,
  balance_difference,
  coverage->'openingEvidenceAudit' AS opening_evidence,
  coverage->'sourceIntegrity' AS source_integrity,
  coverage->'sources' AS source_groups,
  coverage->>'accountingCertification' AS accounting_certification
FROM evidence;
