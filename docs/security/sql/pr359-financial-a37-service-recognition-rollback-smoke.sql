-- A37: extended staging-only GL posting smoke test. Every write rolls back.
-- Distinct existing test actors are only used to exercise role separation;
-- this is NEVER financial evidence or an attestation by these users.
-- Assumes the prelaunch synthetic tenant/site fixture (1/1) and November 2026.
BEGIN;
SET LOCAL statement_timeout='90000ms';
CREATE TEMP TABLE qa_a37_results (source_type text,source_id bigint,entry_id bigint) ON COMMIT DROP;
DO $test$
DECLARE v jsonb; item record;v_before bigint;v_after bigint;
BEGIN
 IF (SELECT count(*) FROM public.financial_gl_entries WHERE tenant_id=1 AND site_id=1)<>0
 OR (SELECT count(*) FROM public.financial_gl_opening_batches WHERE tenant_id=1 AND site_id=1)<>0
 OR public.powerhub_financial_gl_verify_staging_fixture(1,1)->>'verificationMode'<>'STAGING_PRELAUNCH_TECHNICAL'
 THEN RAISE EXCEPTION 'A37_QA_SCOPE_PRECONDITION_FAILED'; END IF;
 PERFORM public.powerhub_financial_gl_opening_create(1,1,4,'2026-09-30',
   'QA-ROLLBACK-NOT-CERTIFIED-20261110',
   'Synthetic opening for rollback-only testing, never financial certification',
   'qa-a37-opening-rollback-20261110',
   '[{"accountCode":"1700","side":"debit","amount":100,"evidenceReference":"QA-ROLLBACK-ONLY"},{"accountCode":"3100","side":"credit","amount":100,"evidenceReference":"QA-ROLLBACK-ONLY"}]'::jsonb);
 PERFORM public.powerhub_financial_gl_opening_post(1,1,(
   SELECT id FROM public.financial_gl_opening_batches WHERE tenant_id=1 AND site_id=1
     AND operation_key='qa-a37-opening-rollback-20261110'),260);
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
   THEN RAISE EXCEPTION 'A37_UNTRUSTED_POSTING_ACK: %, %',item.source_type,item.source_id;END IF;
   INSERT INTO pg_temp.qa_a37_results VALUES(item.source_type,item.source_id,(v->>'entryId')::bigint);
   v:=public.powerhub_financial_gl_post_source(1,1,item.source_type,item.source_id,4);
   IF v->>'status'<>'posted' OR (v->>'alreadyPosted')::boolean IS DISTINCT FROM true
   THEN RAISE EXCEPTION 'A37_NON_IDEMPOTENT_RETRY: %, %',item.source_type,item.source_id; END IF;
 END LOOP;
 -- October 2026 has ended, so independently recognize service earned
 -- by the three October-cycle invoices. November stays unrecognized.
 FOR item IN SELECT * FROM (VALUES (18::bigint),(19::bigint),(31::bigint)) q(source_id) LOOP
   v:=public.powerhub_financial_gl_recognize_billed_service(1,1,item.source_id,'2026-10',4);
   IF v->>'status'<>'posted' OR (v->>'alreadyPosted')::boolean IS DISTINCT FROM false
   THEN RAISE EXCEPTION 'A37_SERVICE_RECOGNITION_NOT_POSTED %',item.source_id;END IF;
   v:=public.powerhub_financial_gl_recognize_billed_service(1,1,item.source_id,'2026-10',4);
   IF v->>'status'<>'posted' OR (v->>'alreadyPosted')::boolean IS DISTINCT FROM true
   THEN RAISE EXCEPTION 'A37_SERVICE_RECOGNITION_REPLAY_NOT_IDEMPOTENT %',item.source_id;END IF;
 END LOOP;
 IF (SELECT count(*) FROM pg_temp.qa_a37_results)<>18
   OR (public.powerhub_financial_gl_source_coverage(1,1,'2026-11')->>'unreconciledSourceCount')::bigint<>0
   OR (public.powerhub_financial_gl_trial_balance(1,1,'2026-11')->>'difference')::numeric<>0
 THEN RAISE EXCEPTION 'A37_UNEXPECTED_COVERAGE_OR_UNBALANCED_GL'; END IF;
END;
$test$;
SELECT jsonb_build_object('status','PASS_ROLLBACK_ONLY','postedSources',(SELECT count(*) FROM pg_temp.qa_a37_results),
 'octoberServiceRecognitions',3,
 'remainingCoverageGaps',(public.powerhub_financial_gl_source_coverage(1,1,'2026-11')->>'unreconciledSourceCount')::bigint,
 'trialDifference',(public.powerhub_financial_gl_trial_balance(1,1,'2026-11')->>'difference')::numeric,
 'humanApproved',false,'accountingCertification','NOT_CERTIFIED') as a37_result;
ROLLBACK;
