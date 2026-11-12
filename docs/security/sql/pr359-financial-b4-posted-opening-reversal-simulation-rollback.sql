-- B4.8 revalidation AFTER B4.10 durable synthetic test opening correction.
-- Original entry immutable, exactly one correction, and duplicate reversal denied.
BEGIN;
SET LOCAL statement_timeout='120000ms';
DO $qa$
DECLARE v_entry public.financial_gl_entries%ROWTYPE;
  v_roll jsonb; v_evidence jsonb; v_cash jsonb;
  base_entries bigint; base_lines bigint; blocked boolean:=false;
BEGIN
 SELECT count(*) INTO base_entries FROM public.financial_gl_entries WHERE tenant_id=1;
 SELECT count(*) INTO base_lines FROM public.financial_gl_lines WHERE tenant_id=1;
 IF base_entries<>25 OR base_lines<>51 THEN RAISE EXCEPTION 'B4_8_BASELINE_CHANGED'; END IF;
 SELECT * INTO v_entry FROM public.financial_gl_entries
 WHERE tenant_id=1 AND site_id=9000000000099 AND reverses_entry_id=168;
 IF v_entry.id IS NULL OR v_entry.source_type<>'correction'
    OR v_entry.accounting_policy_version<>'staging-prelaunch-technical-disposition-v1'
    OR (SELECT count(*) FROM public.financial_gl_lines WHERE entry_id=v_entry.id)<>2
    OR NOT EXISTS(SELECT 1 FROM public.financial_gl_lines WHERE entry_id=v_entry.id
       AND account_code='1010' AND side='credit' AND amount=2000)
    OR NOT EXISTS(SELECT 1 FROM public.financial_gl_lines WHERE entry_id=v_entry.id
       AND account_code='3100' AND side='debit' AND amount=2000)
 THEN RAISE EXCEPTION 'B4_8_FALSE_REVERSAL_ACCEPTANCE'; END IF;
 BEGIN
   INSERT INTO public.financial_gl_entries
      (tenant_id,site_id,period,source_type,source_id,source_revision,operation_key,
       source_fingerprint,accounting_policy_version,posted_by_user_id,reverses_entry_id)
   VALUES(1,9000000000099,'2026-11','correction','staging-opening-19-duplicate-probe',1,
     'gl:correction:staging-opening-19:duplicate-probe',
     encode(digest('staging-opening-19-duplicate-probe','sha256'),'hex'),
     'staging-test-reversal-duplicate-probe',4,168);
 EXCEPTION WHEN unique_violation THEN blocked:=true;
 END;
 IF blocked IS DISTINCT FROM true THEN RAISE EXCEPTION 'B4_8_DUPLICATE_REVERSAL_NOT_BLOCKED'; END IF;
 SELECT x INTO v_cash FROM jsonb_array_elements(
   public.powerhub_financial_gl_subledger_reconciliation(1,9000000000099,'2026-11')->'checks') x
 WHERE x->>'code'='1010';
 v_evidence:=public.powerhub_financial_gl_opening_evidence_status(1,9000000000099,'2026-11');
 v_roll:=public.powerhub_financial_gl_tenant_rollup(1,'2026-11');
 IF v_cash->>'status'<>'MATCHED' OR (v_cash->>'difference')::numeric<>0
    OR (SELECT count(*) FROM public.financial_gl_entries WHERE tenant_id=1)<>base_entries
    OR (SELECT count(*) FROM public.financial_gl_lines WHERE tenant_id=1)<>base_lines
    OR v_evidence->>'isIndependentlyReconciled'<>'false'
    OR v_roll->>'accountingCertification'<>'NOT_CERTIFIED'
    OR (v_roll->>'isConsolidatedFinancialStatements')::boolean IS DISTINCT FROM false
 THEN RAISE EXCEPTION 'B4_8_FALSE_REVERSAL_ACCEPTANCE'; END IF;
END;$qa$;
SELECT 'B4_8_POSTED_TEST_OPENING_REVERSAL_SIMULATION_PASS' AS result;
ROLLBACK;
