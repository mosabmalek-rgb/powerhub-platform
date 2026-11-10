-- A27 assertion fragment; execute only inside a transaction that already
-- ran A25 + A24 setup without their final ROLLBACK, then ROLLBACK once.
-- This file is NOT an independent script and MUST NOT create certifications.
DO $a27$
DECLARE c jsonb; t jsonb; i jsonb; o jsonb; totals jsonb;
BEGIN
 c:=public.powerhub_financial_gl_source_coverage(1,1,'2026-11');
 t:=public.powerhub_financial_gl_trial_balance(1,1,'2026-11');
 i:=c->'sourceIntegrity';o:=c->'openingEvidenceAudit';
 SELECT jsonb_object_agg(source_type,n) INTO totals
 FROM (SELECT source_type,count(*) n FROM public.financial_gl_entries
 WHERE tenant_id=1 AND site_id=1 GROUP BY source_type) z;
 IF (c->>'unreconciledSourceCount')::bigint<>0
  OR (c->>'isSourceCoverageComplete')::boolean IS DISTINCT FROM true
  OR (i->>'isClean')::boolean IS DISTINCT FROM true
  OR (i->>'checkedEntries')::bigint<>22
  OR (i->>'driftedEntries')::bigint<>0
  OR (i->>'unauditedEntries')::bigint<>0
  OR (t->>'difference')::numeric<>0
  OR (t->>'postedEntryCount')::bigint<>22
  OR totals->>'invoice'<>'4' OR totals->>'payment'<>'6'
  OR totals->>'supplier_ledger'<>'5'
  OR totals->>'service_recognition'<>'3'
  OR totals->>'stock_movement'<>'1'
  OR totals->>'payroll'<>'1'
  OR totals->>'expense'<>'1'
  OR totals->>'opening_balance'<>'1'
  OR (c->'sources'->'priorOperationalSources'->>'quarantinedTestMovements')::bigint<>250000
 THEN RAISE EXCEPTION 'A27_SOURCE_COVERAGE_OR_GL_INTEGRITY_DRIFT';END IF;
 IF (c->>'isOpeningStructurallyPosted')::boolean IS DISTINCT FROM true
  OR (c->>'isOpeningReconciled')::boolean IS DISTINCT FROM false
  OR (o->>'sourceSubledgersIndependentlyVerified')::boolean IS DISTINCT FROM false
  OR o->>'status'<>'INDEPENDENT_SUBLEDGER_RECONCILIATION_REQUIRED'
  OR c->>'accountingCertification'<>'NOT_CERTIFIED'
  OR t->>'accountingCertification'<>'NOT_CERTIFIED'
 THEN RAISE EXCEPTION 'A27_FALSE_ACCOUNTING_CERTIFICATION';END IF;
END;
$a27$;
SELECT jsonb_build_object(
 'unreconciled',(c.v->>'unreconciledSourceCount')::bigint,
 'quarantined',(c.v->'sources'->'priorOperationalSources'->>'quarantinedTestMovements')::bigint,
 'sourceIntegrity',c.v->'sourceIntegrity',
 'openingAudit',c.v->'openingEvidenceAudit',
 'postedEntryCount',(t.v->>'postedEntryCount')::bigint,
 'trialDifference',(t.v->>'difference')::numeric,
 'accountingCertification',c.v->>'accountingCertification'
) AS a27_result
FROM (SELECT public.powerhub_financial_gl_source_coverage(1,1,'2026-11') v) c
CROSS JOIN (SELECT public.powerhub_financial_gl_trial_balance(1,1,'2026-11') v) t;
