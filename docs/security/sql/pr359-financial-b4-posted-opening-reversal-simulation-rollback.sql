-- B4.8: Demonstrate append-only reversal of unsupported posted synthetic opening.
-- This is a technical simulation, NOT an approved accounting disposition.
-- All test GL entries are rolled back; original posted opening remains immutable.
BEGIN;
SET LOCAL statement_timeout='120000ms';
DO $qa$
DECLARE v_id bigint; v_rec jsonb; v_cash jsonb; v_evidence jsonb;
  v_roll jsonb; base_entries bigint; base_lines bigint;
BEGIN
 SELECT count(*) INTO base_entries FROM public.financial_gl_entries WHERE tenant_id=1;
 SELECT count(*) INTO base_lines FROM public.financial_gl_lines WHERE tenant_id=1;
 IF base_entries<>24 OR base_lines<>49 THEN RAISE EXCEPTION 'B4_8_BASELINE_CHANGED'; END IF;
 INSERT INTO public.financial_gl_entries
  (tenant_id,site_id,period,source_type,source_id,source_revision,
   operation_key,source_fingerprint,accounting_policy_version,
   posted_by_user_id,reverses_entry_id)
 VALUES(1,9000000000099,'2026-11','correction',
   'staging-posted-opening-19-reversal-test',1,
   'gl:correction:staging-opening-19:v1',
   encode(digest('staging-opening-19-reversal-test','sha256'),'hex'),
   'staging-prelaunch-reversal-test-v1',4,168)
 RETURNING id INTO v_id;
 INSERT INTO public.financial_gl_lines
   (entry_id,tenant_id,site_id,account_code,side,amount)
 VALUES (v_id,1,9000000000099,'3100','debit',2000),
        (v_id,1,9000000000099,'1010','credit',2000);
 v_rec:=public.powerhub_financial_gl_subledger_reconciliation(1,9000000000099,'2026-11');
 SELECT c INTO v_cash FROM jsonb_array_elements(v_rec->'checks') c WHERE c->>'code'='1010';
 v_evidence:=public.powerhub_financial_gl_opening_evidence_status(1,9000000000099,'2026-11');
 v_roll:=public.powerhub_financial_gl_tenant_rollup(1,'2026-11');
 IF v_cash->>'status'<>'MATCHED' OR (v_cash->>'difference')::numeric<>0
    OR (SELECT count(*) FROM public.financial_gl_entries WHERE tenant_id=1)<>base_entries+1
    OR (SELECT count(*) FROM public.financial_gl_lines WHERE tenant_id=1)<>base_lines+2
    OR v_evidence->>'isIndependentlyReconciled'<>'false'
    OR v_roll->>'accountingCertification'<>'NOT_CERTIFIED'
    OR (v_roll->>'isConsolidatedFinancialStatements')::boolean IS DISTINCT FROM false
 THEN RAISE EXCEPTION 'B4_8_FALSE_REVERSAL_ACCEPTANCE'; END IF;
END;$qa$;
SELECT 'B4_8_POSTED_TEST_OPENING_REVERSAL_SIMULATION_PASS' result;
ROLLBACK;
