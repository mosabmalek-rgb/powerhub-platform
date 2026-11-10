-- A39/A38: extended staging-only GL posting smoke test. Every write rolls back.
-- A38 removes a nonexistent salary advance asset from the synthetic opening.
-- Distinct existing test actors are only used to exercise role separation;
-- this is NEVER financial evidence or an attestation by these users.
-- Assumes the prelaunch synthetic tenant/site fixture (1/1) and November 2026.
BEGIN;
SET LOCAL statement_timeout='90000ms';
CREATE TEMP TABLE qa_a39_results (source_type text,source_id bigint,entry_id bigint) ON COMMIT DROP;
DO $test$
DECLARE v jsonb; item record;v_before bigint;v_after bigint;
BEGIN
 IF (SELECT count(*) FROM public.financial_gl_entries WHERE tenant_id=1 AND site_id=1)<>0
 OR (SELECT count(*) FROM public.financial_gl_opening_batches WHERE tenant_id=1 AND site_id=1)<>0
 OR public.powerhub_financial_gl_verify_staging_fixture(1,1)->>'verificationMode'<>'STAGING_PRELAUNCH_TECHNICAL'
 THEN RAISE EXCEPTION 'A39_QA_SCOPE_PRECONDITION_FAILED'; END IF;
 PERFORM public.powerhub_financial_gl_opening_create(1,1,4,'2026-09-30',
   'QA-ROLLBACK-NOT-CERTIFIED-20261110',
   'Synthetic opening for rollback-only testing, never financial certification',
   'qa-a39-opening-rollback-20261110',
   '[{"accountCode":"1010","side":"debit","amount":0.01,"evidenceReference":"QA-ROLLBACK-ONLY"},{"accountCode":"3100","side":"credit","amount":0.01,"evidenceReference":"QA-ROLLBACK-ONLY"}]'::jsonb);
 PERFORM public.powerhub_financial_gl_opening_post(1,1,(
   SELECT id FROM public.financial_gl_opening_batches WHERE tenant_id=1 AND site_id=1
     AND operation_key='qa-a39-opening-rollback-20261110'),260);
 FOR item IN SELECT * FROM (VALUES
 ('invoice'::text,18::bigint,1),('invoice',19,2),('invoice',31,3),('invoice',32,4),
 ('supplier_ledger',16,5),('supplier_ledger',19,6),('supplier_ledger',17,7),
 ('payroll',1,8),('expense',1,9),('supplier_ledger',18,10),
 ('supplier_ledger',20,11),('stock_movement',25,12),
 ('payment',2,13),('payment',3,14),('payment',4,15),
 ('payment',5,16),('payment',7,17),('payment',8,18)
 ) AS desired(source_type,source_id,sort_order) ORDER BY sort_order
 LOOP
   v:=public.powerhub_financial_gl_post_source(1,1,item.source_type,item.source_id,4);
   IF v->>'status'<>'posted' OR (v->>'alreadyPosted')::boolean IS DISTINCT FROM false
      OR (v->>'entryId')::bigint IS NULL
   THEN RAISE EXCEPTION 'A39_UNTRUSTED_POSTING_ACK: %, %',item.source_type,item.source_id;END IF;
   INSERT INTO pg_temp.qa_a39_results VALUES(item.source_type,item.source_id,(v->>'entryId')::bigint);
   v:=public.powerhub_financial_gl_post_source(1,1,item.source_type,item.source_id,4);
   IF v->>'status'<>'posted' OR (v->>'alreadyPosted')::boolean IS DISTINCT FROM true
   THEN RAISE EXCEPTION 'A39_NON_IDEMPOTENT_RETRY: %, %',item.source_type,item.source_id; END IF;
 END LOOP;
 -- October 2026 has ended, so independently recognize service earned
 -- by the three October-cycle invoices. November stays unrecognized.
 FOR item IN SELECT * FROM (VALUES (18::bigint),(19::bigint),(31::bigint)) q(source_id) LOOP
   v:=public.powerhub_financial_gl_recognize_billed_service(1,1,item.source_id,'2026-10',4);
   IF v->>'status'<>'posted' OR (v->>'alreadyPosted')::boolean IS DISTINCT FROM false
   THEN RAISE EXCEPTION 'A39_SERVICE_RECOGNITION_NOT_POSTED %',item.source_id;END IF;
   v:=public.powerhub_financial_gl_recognize_billed_service(1,1,item.source_id,'2026-10',4);
   IF v->>'status'<>'posted' OR (v->>'alreadyPosted')::boolean IS DISTINCT FROM true
   THEN RAISE EXCEPTION 'A39_SERVICE_RECOGNITION_REPLAY_NOT_IDEMPOTENT %',item.source_id;END IF;
 END LOOP;
 IF (SELECT count(*) FROM pg_temp.qa_a39_results)<>18
   OR (public.powerhub_financial_gl_source_coverage(1,1,'2026-11')->>'unreconciledSourceCount')::bigint<>0
   OR (public.powerhub_financial_gl_trial_balance(1,1,'2026-11')->>'difference')::numeric<>0
 THEN RAISE EXCEPTION 'A39_UNEXPECTED_COVERAGE_OR_UNBALANCED_GL'; END IF;
END;
$test$;
-- A39 engineering acceptance: a balanced synthetic ledger is not an
-- independent documentary opening or a certified set of accounts.
DO $a39$
DECLARE v_trial jsonb; v_coverage jsonb; v_evidence jsonb; v_integrity jsonb;
 v_entry_count bigint;
BEGIN
 v_trial:=public.powerhub_financial_gl_trial_balance(1,1,'2026-11');
 v_coverage:=public.powerhub_financial_gl_source_coverage(1,1,'2026-11');
 v_evidence:=public.powerhub_financial_gl_opening_evidence_status(1,1,'2026-11');
 v_integrity:=public.powerhub_financial_gl_source_integrity(1,1,'2026-11');
 SELECT count(*) INTO v_entry_count FROM public.financial_gl_entries
 WHERE tenant_id=1 AND site_id=1;
 IF v_entry_count<>22 OR (v_trial->>'postedEntryCount')::bigint<>22
    OR (v_trial->>'difference')::numeric<>0
    OR (v_trial->>'debitBalances')::numeric<>(v_trial->>'creditBalances')::numeric
    OR (v_trial->>'debitTurnover')::numeric<>(v_trial->>'creditTurnover')::numeric
    OR (v_coverage->>'unreconciledSourceCount')::bigint<>0
    OR (v_coverage->>'isSourceCoverageComplete')::boolean IS DISTINCT FROM true
    OR (v_integrity->>'isClean')::boolean IS DISTINCT FROM true
    OR (v_integrity->>'driftedEntries')::bigint<>0
    OR (v_integrity->>'invalidSources')::bigint<>0
    OR (v_integrity->>'unauditedEntries')::bigint<>0
 THEN RAISE EXCEPTION 'A39_BALANCE_COVERAGE_OR_INTEGRITY_FAILED'; END IF;
 -- Deterministic fingerprints of *test outputs*, not real subledger balances.
 IF EXISTS(
  SELECT 1 FROM (VALUES
    ('1200',2005.50::numeric),('1300',1843.00::numeric),
    ('2300',-1518.00::numeric),('2400',-5525.00::numeric),
    ('2450',-25.00::numeric),('4100',-2621.50::numeric),
    ('5200',5550.00::numeric)) expected(account_code,amount)
  LEFT JOIN LATERAL (
    SELECT coalesce(sum(CASE WHEN l.side='debit' THEN l.amount ELSE -l.amount END),0) balance
    FROM public.financial_gl_lines l JOIN public.financial_gl_entries e ON e.id=l.entry_id
    WHERE e.tenant_id=1 AND e.site_id=1 AND l.account_code=expected.account_code
  ) measured ON true
  WHERE expected.amount<>measured.balance
 ) THEN RAISE EXCEPTION 'A39_DETERMINISTIC_SUBLEDGER_ACCOUNT_MISMATCH'; END IF;
 IF v_evidence->>'status'<>'EVIDENCE_MISSING_OR_UNREVIEWED'
    OR (v_evidence->>'isIndependentlyReconciled')::boolean IS DISTINCT FROM false
    OR (v_evidence->>'sourceSubledgersIndependentlyVerified')::boolean IS DISTINCT FROM false
    OR (v_coverage->>'isOpeningReconciled')::boolean IS DISTINCT FROM false
    OR (v_trial->>'isFinalBalanceSheet')::boolean IS DISTINCT FROM false
    OR v_trial->>'accountingCertification'<>'NOT_CERTIFIED'
    OR v_coverage->>'accountingCertification'<>'NOT_CERTIFIED'
 THEN RAISE EXCEPTION 'A39_FALSE_FINANCIAL_CERTIFICATION'; END IF;
END;
$a39$;
SELECT jsonb_build_object(
 'status','ENGINEERING_PASS_ROLLBACK_ONLY',
 'postedSources',(SELECT count(*) FROM pg_temp.qa_a39_results),
 'recognizedOctoberInvoices',3,
 'glEntries',(SELECT count(*) FROM public.financial_gl_entries WHERE tenant_id=1 AND site_id=1),
 'unreconciledSources',(public.powerhub_financial_gl_source_coverage(1,1,'2026-11')->>'unreconciledSourceCount')::bigint,
 'balanceDifference',(public.powerhub_financial_gl_trial_balance(1,1,'2026-11')->>'difference')::numeric,
 'openingIndependentlyReconciled',(public.powerhub_financial_gl_opening_evidence_status(1,1,'2026-11')->>'isIndependentlyReconciled')::boolean,
 'sourceIntegrityClean',(public.powerhub_financial_gl_source_integrity(1,1,'2026-11')->>'isClean')::boolean,
 'financialCertification','NOT_CERTIFIED',
 'humanApproved',false,
 'rawTransactionDeletes',0
) AS a39_result;
ROLLBACK;
