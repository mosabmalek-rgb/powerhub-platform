-- B4.9: actual company account transfer RPC -> source backed GL -> B4 reconciliation.
-- All source and GL writes rolled back in synthetic Staging.
BEGIN;
SET LOCAL statement_timeout='120000ms';
DO $qa$
DECLARE op record; posted jsonb; replay jsonb; before_report jsonb;
  after_report jsonb; cash jsonb; wallet jsonb; base_entries bigint;
BEGIN
 SELECT count(*) INTO base_entries FROM public.financial_gl_entries WHERE tenant_id=1;
 SELECT * INTO op FROM public.powerhub_transfer_company_accounts_idempotent(
  1,1,4,5,6,17.30,'B4.9 source GL reconciliation acceptance',
  '48cc03d3-3622-434f-85d4-c242e4006248'::uuid);
 before_report:=public.powerhub_financial_gl_subledger_reconciliation(1,1,'2026-11');
 IF (before_report->'diagnostics'->>'unpostedTransferMovements')::bigint<>2
 OR before_report->>'status'<>'BLOCKED_RECONCILIATION'
 THEN RAISE EXCEPTION 'B49_MISSING_GL_NOT_BLOCKED'; END IF;

 posted:=public.powerhub_financial_gl_post_source(
  1,1,'account_movement',op.from_transaction_id,4);
 replay:=public.powerhub_financial_gl_post_source(
  1,1,'account_movement',op.from_transaction_id,4);
 after_report:=public.powerhub_financial_gl_subledger_reconciliation(1,1,'2026-11');
 SELECT c INTO cash FROM jsonb_array_elements(after_report->'checks') c WHERE c->>'code'='1010';
 SELECT c INTO wallet FROM jsonb_array_elements(after_report->'checks') c WHERE c->>'code'='1020';
 IF (posted->>'alreadyPosted')::boolean IS DISTINCT FROM false
 OR (replay->>'alreadyPosted')::boolean IS DISTINCT FROM true
 OR (replay->>'entryId')::bigint IS DISTINCT FROM (posted->>'entryId')::bigint
 OR (after_report->'diagnostics'->>'unpostedTransferMovements')::bigint<>0
 OR (after_report->'diagnostics'->>'glVerifiedTransferPairs')::bigint<>1
 OR cash->>'status'<>'MATCHED' OR wallet->>'status'<>'MATCHED'
 OR (cash->>'difference')::numeric<>0 OR (wallet->>'difference')::numeric<>0
 OR after_report->>'status'<>'MATCHED_NUMERICALLY_NOT_CERTIFIED'
 OR (SELECT count(*) FROM public.financial_gl_entries WHERE tenant_id=1)<>base_entries+1
 OR after_report->>'accountingCertification'<>'NOT_CERTIFIED'
 THEN RAISE EXCEPTION 'B49_POSTED_TRANSFER_STILL_BLOCKED_OR_DUPLICATED'; END IF;
END;$qa$;
SELECT 'B49_TRANSFER_GL_RECONCILIATION_PASS_ROLLBACK' result;
ROLLBACK;
