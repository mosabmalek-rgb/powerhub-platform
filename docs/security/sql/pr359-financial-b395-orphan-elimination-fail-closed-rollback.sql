-- B3.9.5 simulated orphan approved elimination: fail closed before showing totals.
BEGIN;
SET LOCAL statement_timeout='120000ms';
DO $test$
DECLARE before_gl bigint;before_lines bigint;report jsonb;
BEGIN
 SELECT count(*) INTO before_gl FROM public.financial_gl_entries WHERE tenant_id=1;
 SELECT count(*) INTO before_lines FROM public.financial_gl_lines WHERE tenant_id=1;
 IF before_gl<>25 OR before_lines<>51 THEN RAISE EXCEPTION 'B395_STAGING_BASELINE_CHANGED';END IF;
 INSERT INTO public.financial_gl_inter_site_eliminations
 (tenant_id,from_site_id,to_site_id,source_primary_id,operation_key,period,
  from_gl_entry_id,to_gl_entry_id,amount,source_fingerprint,evidence_reference,
  status,prepared_by_user_id,approved_by_user_id,approved_at)
 VALUES(1,1,9000000000099,900000000004110,
  '26a35dbf-f540-4e0b-8fbe-b7c5a947a4c8','2026-11',
  900000000004112,900000000004113,12.30,repeat('a',64),
  'B395 synthetic orphan test only', 'approved',4,260,now());
 report:=public.powerhub_financial_gl_inter_site_posting_audit(1,'2026-11');
 IF report->>'status'<>'BLOCKED_INTEGRITY'
 OR (report->>'orphanEliminationCount')::bigint<>1
 OR report->>'approvedEliminationAmount' IS NOT NULL
 OR report->>'approvedEliminationAssetReduction' IS NOT NULL
 OR report->>'approvedEliminationLiabilityReduction' IS NOT NULL
 OR report->>'accountingCertification'<>'NOT_CERTIFIED'
 OR (report->>'isConsolidatedFinancialStatements')::boolean IS DISTINCT FROM false
 OR (SELECT count(*) FROM public.financial_gl_entries WHERE tenant_id=1)<>before_gl
 OR (SELECT count(*) FROM public.financial_gl_lines WHERE tenant_id=1)<>before_lines
 THEN RAISE EXCEPTION 'B395_ORPHAN_ELIMINATION_FALSE_SUCCESS';END IF;
END;$test$;
SELECT 'B395_ORPHAN_APPROVED_ELIMINATION_FAIL_CLOSED_PASS_ROLLBACK' result;
ROLLBACK;