-- A47: Staging-only durable engineering acceptance; no persistent writes.
-- DO NOT SET TRANSACTION READ ONLY: source_plan uses SELECT ... FOR SHARE.
-- This transaction contains no DML/DDL, rolls back, and must never be
-- interpreted as independent accounting attestation.
BEGIN;
SET LOCAL statement_timeout='85000ms';
DO $acceptance$
DECLARE c jsonb;tb jsonb;si jsonb;ta jsonb;
 entry_count bigint;service_count bigint;opening_count bigint;
BEGIN
 c:=public.powerhub_financial_gl_source_coverage(1,1,'2026-11');
 tb:=public.powerhub_financial_gl_trial_balance(1,1,'2026-11');
 si:=public.powerhub_financial_gl_source_integrity(1,1,'2026-11');
 ta:=c->'technicalAcceptance';
 SELECT count(*),count(*) FILTER(WHERE source_type='service_recognition')
 INTO entry_count,service_count
 FROM public.financial_gl_entries WHERE tenant_id=1 AND site_id=1;
 SELECT count(*) INTO opening_count FROM public.financial_gl_opening_batches
 WHERE tenant_id=1 AND site_id=1;
 IF entry_count<>21 OR service_count<>3 OR opening_count<>0
 OR (c->>'unreconciledSourceCount')::bigint<>0
 OR (si->>'isClean')::boolean IS DISTINCT FROM true
 OR (si->>'driftedEntries')::bigint<>0
 OR (si->>'invalidSources')::bigint<>0
 OR (si->>'unauditedEntries')::bigint<>0
 OR (tb->>'difference')::numeric<>0
 OR ta->>'status'<>'PASS_PRELAUNCH_ENGINEERING_ONLY'
 OR (ta->>'isEngineeringAccepted')::boolean IS DISTINCT FROM true
 OR (ta->>'isFinalFinancialAcceptance')::boolean IS DISTINCT FROM false
 OR ta->>'accountingCertification'<>'NOT_CERTIFIED'
 OR c->>'accountingCertification'<>'NOT_CERTIFIED'
 OR (ta->>'technicalBootstrapActive')::boolean IS DISTINCT FROM
   public.powerhub_financial_gl_prelaunch_tech_valid(1,1,'2026-11')
 OR (ta->>'humanApproved')::boolean IS DISTINCT FROM false
 OR (ta->>'technicalFixtureProven')::boolean IS DISTINCT FROM true
 OR (ta->>'technicalAuditRecorded')::boolean IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'A47_NOT_ENGINEERING_ACCEPTED'; END IF;
 IF EXISTS(
  SELECT 1 FROM public.financial_gl_entries e
  LEFT JOIN public.financial_gl_lines l ON l.entry_id=e.id
  WHERE e.tenant_id=1 AND e.site_id=1
  GROUP BY e.id
  HAVING count(l.id)<2
    OR coalesce(sum(CASE WHEN l.side='debit' THEN l.amount ELSE -l.amount END),0)<>0
 ) THEN RAISE EXCEPTION 'A47_UNBALANCED_OR_INCOMPLETE_ENTRY'; END IF;
 IF EXISTS(
  SELECT 1 FROM public.financial_gl_entries
  WHERE tenant_id=1 AND site_id=1
  GROUP BY operation_key HAVING count(*)>1
 ) THEN RAISE EXCEPTION 'A47_DUPLICATE_OPERATION_KEY'; END IF;
 IF NOT EXISTS(
  SELECT 1 FROM public.financial_gl_prelaunch_technical_bootstrap
  WHERE tenant_id=1 AND site_id=1 AND human_approved=false
   AND accounting_certification='NOT_CERTIFIED'
   AND expires_at<'2026-12-01'::timestamptz
 ) THEN RAISE EXCEPTION 'A47_BOOTSTRAP_NOT_BOUNDED'; END IF;
 IF EXISTS(
  SELECT 1 FROM pg_proc f WHERE f.pronamespace='public'::regnamespace
  AND f.proname IN ('powerhub_financial_gl_post_source',
   'powerhub_financial_gl_recognize_billed_service',
   'powerhub_financial_gl_prelaunch_tech_valid',
   'powerhub_financial_gl_source_plan')
  AND (has_function_privilege('anon',f.oid,'EXECUTE')
    OR has_function_privilege('authenticated',f.oid,'EXECUTE'))
 ) THEN RAISE EXCEPTION 'A47_GL_RPC_EXPOSED_TO_CLIENT_ROLE'; END IF;
 IF public.powerhub_financial_gl_prelaunch_tech_valid(1,2,'2026-11') IS DISTINCT FROM false
 OR public.powerhub_financial_gl_prelaunch_tech_valid(2,1,'2026-11') IS DISTINCT FROM false
 OR public.powerhub_financial_gl_prelaunch_tech_valid(1,1,'2026-09') IS DISTINCT FROM false
 THEN RAISE EXCEPTION 'A47_STAGING_SCOPE_BYPASS'; END IF;
END;
$acceptance$;
SELECT 'PASS_STAGING_ENGINEERING_ONLY' AS result,
 jsonb_build_object('postedGL',
    (SELECT count(*) FROM public.financial_gl_entries WHERE tenant_id=1 AND site_id=1),
  'openingCount',
    (SELECT count(*) FROM public.financial_gl_opening_batches WHERE tenant_id=1 AND site_id=1),
  'financeCertification',public.powerhub_financial_gl_source_coverage(1,1,'2026-11')->>'accountingCertification',
  'technicalStatus',public.powerhub_financial_gl_source_coverage(1,1,'2026-11')->'technicalAcceptance'->>'status'
 ) AS evidence;
ROLLBACK;
