-- PowerHub C4: ONLY Staging tenant 1/site 1 synthetic fixture.
-- Requires 20261113203000 C4 lock-guard migration already installed, or applied
-- transaction-locally before this file. ALL changes are rolled back.
-- SQL identities 4 and 260 are fixture actors, NOT human attestations.
BEGIN;
SET LOCAL statement_timeout='120000ms';
DO $c4$
DECLARE
 evidence jsonb;
 id1 bigint;
 result jsonb;
 rejected boolean;
 before_gl bigint;
 before_lines bigint;
BEGIN
 SELECT count(*) INTO before_gl FROM public.financial_gl_entries WHERE tenant_id=1;
 SELECT count(*) INTO before_lines FROM public.financial_gl_lines WHERE tenant_id=1;
 IF before_gl<>25 OR before_lines<>51
    OR EXISTS(SELECT 1 FROM public.financial_accrual_period_reviews
      WHERE tenant_id=1 AND site_id=1 AND period IN ('2026-09','2026-10','2026-11'))
 THEN RAISE EXCEPTION 'C4_STAGING_BASELINE_DRIFT'; END IF;
 IF has_function_privilege('anon','public.powerhub_financial_accrual_period_lock(bigint,bigint,text,bigint)','EXECUTE')
    OR has_function_privilege('authenticated','public.powerhub_financial_accrual_period_lock(bigint,bigint,text,bigint)','EXECUTE')
    OR NOT has_function_privilege('service_role','public.powerhub_financial_accrual_period_lock(bigint,bigint,text,bigint)','EXECUTE')
 THEN RAISE EXCEPTION 'C4_PERIOD_LOCK_ACL_WIDENED'; END IF;
 evidence:=jsonb_build_object(
  'unbilled_service','Staging synthetic test evidence',
  'invoice_cutoff','Staging synthetic test evidence',
  'supplier_reconciliation','Staging synthetic test evidence',
  'inventory_reconciliation','Staging synthetic test evidence',
  'payroll_reconciliation','Staging synthetic test evidence',
  'depreciation_register','Staging synthetic test evidence',
  'provision_assessment','Staging synthetic test evidence',
  'tax_reconciliation','Staging synthetic test evidence'
 );
 id1:=public.powerhub_financial_accrual_period_save_review(1,1,'2026-09',4,evidence);
 rejected:=false;
 BEGIN
  PERFORM public.powerhub_financial_accrual_period_lock(1,1,'2026-09',4);
 EXCEPTION WHEN OTHERS THEN rejected:=SQLERRM LIKE '%ACCRUAL_SEPARATION_OF_DUTIES%'; END;
 IF NOT rejected THEN RAISE EXCEPTION 'C4_SELF_APPROVAL_ALLOWED'; END IF;
 result:=public.powerhub_financial_accrual_period_lock(1,1,'2026-09',260);
 IF result->>'status' IS DISTINCT FROM 'locked'
    OR (result->>'alreadyLocked')::boolean IS DISTINCT FROM false
    OR (result->>'isCertifiedProfit')::boolean IS DISTINCT FROM false
 THEN RAISE EXCEPTION 'C4_CLEAN_PERIOD_FAILED'; END IF;
 result:=public.powerhub_financial_accrual_period_lock(1,1,'2026-09',260);
 IF (result->>'alreadyLocked')::boolean IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'C4_REPLAY_NOT_IDEMPOTENT'; END IF;
 rejected:=false;
 BEGIN
  PERFORM public.powerhub_financial_accrual_period_lock(1,1,'2026-09',4);
 EXCEPTION WHEN OTHERS THEN rejected:=SQLERRM LIKE '%PERIOD_ALREADY_LOCKED%'; END;
 IF NOT rejected THEN RAISE EXCEPTION 'C4_LOCK_OWNERSHIP_BYPASS'; END IF;
 PERFORM public.powerhub_financial_accrual_period_save_review(1,1,'2026-10',4,evidence);
 rejected:=false;
 BEGIN
  PERFORM public.powerhub_financial_accrual_period_lock(1,1,'2026-10',260);
 EXCEPTION WHEN OTHERS THEN
  rejected:=SQLERRM LIKE '%ACCRUAL_CLOSE_UNRESOLVED_SOURCE_issuedOutsideServiceMonthCount%';
 END;
 IF NOT rejected THEN RAISE EXCEPTION 'C4_CUTOFF_NOT_BLOCKED'; END IF;
 PERFORM public.powerhub_financial_accrual_period_save_review(1,1,'2026-11',4,evidence);
 rejected:=false;
 BEGIN
  PERFORM public.powerhub_financial_accrual_period_lock(1,1,'2026-11',260);
 EXCEPTION WHEN OTHERS THEN rejected:=SQLERRM LIKE '%ACCRUAL_PERIOD_NOT_FINISHED%'; END;
 IF NOT rejected THEN RAISE EXCEPTION 'C4_CURRENT_PERIOD_NOT_BLOCKED'; END IF;
 rejected:=false;
 BEGIN
  PERFORM public.powerhub_financial_accrual_period_lock(1,99999,'2026-09',260);
 EXCEPTION WHEN OTHERS THEN rejected:=SQLERRM LIKE '%INVALID_ACCRUAL_CLOSE_SCOPE%'; END;
 IF NOT rejected THEN RAISE EXCEPTION 'C4_WRONG_SITE_NOT_BLOCKED'; END IF;
 IF EXISTS(SELECT 1 FROM public.financial_accrual_period_reviews
    WHERE tenant_id=1 AND site_id=1 AND period='2026-10' AND status='locked')
    OR (SELECT count(*) FROM public.financial_gl_entries WHERE tenant_id=1)<>before_gl
    OR (SELECT count(*) FROM public.financial_gl_lines WHERE tenant_id=1)<>before_lines
 THEN RAISE EXCEPTION 'C4_POST_TEST_LEDGER_OR_PERIOD_DRIFT'; END IF;
END $c4$;
SELECT 'C4_SOURCE_LOCK_MAKER_CHECKER_REPLAY_PASS_ROLLBACK' AS acceptance;
ROLLBACK;
