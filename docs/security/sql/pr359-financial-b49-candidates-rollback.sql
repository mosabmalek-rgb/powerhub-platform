-- B4.9.2: candidate list must show true source status only after
-- confirmed balanced GL posting. Prevent stale client-only success.
BEGIN;
SET LOCAL statement_timeout='90000ms';
DO $qa$
DECLARE o record; list jsonb; after_post jsonb; bad_cursor boolean:=false;
BEGIN
 SELECT * INTO o FROM public.powerhub_transfer_company_accounts_idempotent(
  1,1,4,5,6,12.3,'B49 UI candidate fixture',
  'cc05cf01-fabb-4be6-8f61-02f2f81aa0f1'::uuid);
 list:=public.powerhub_financial_gl_cash_transfer_candidates(1,1,'2026-11',null);
 IF jsonb_array_length(list->'items')<>1
    OR (list->'items'->0->>'sourceId')::bigint<>o.from_transaction_id
    OR list->'items'->0->>'status'<>'PENDING_GL'
    OR list->>'accountingCertification'<>'NOT_CERTIFIED'
 THEN RAISE EXCEPTION 'B49_CANDIDATE_LIST_PENDING_INVALID'; END IF;
 PERFORM public.powerhub_financial_gl_post_source(1,1,'account_movement',o.from_transaction_id,4);
 after_post:=public.powerhub_financial_gl_cash_transfer_candidates(1,1,'2026-11',null);
 IF after_post->'items'->0->>'status'<>'GL_ENTRY_PRESENT'
    OR (after_post->'items'->0->>'glEntryId')::bigint<=0
    OR (public.powerhub_financial_gl_subledger_reconciliation(1,1,'2026-11')
      ->'diagnostics'->>'unpostedTransferMovements')::bigint<>0
 THEN RAISE EXCEPTION 'B49_CANDIDATE_LIST_POSTED_INVALID'; END IF;
 BEGIN
  PERFORM public.powerhub_financial_gl_cash_transfer_candidates(
   1,9000000000099,'2026-11',-1);
 EXCEPTION WHEN SQLSTATE '22023' THEN bad_cursor:=true; END;
 IF NOT bad_cursor THEN RAISE EXCEPTION 'B49_BAD_CURSOR_ACCEPTED'; END IF;
END;$qa$;
SELECT 'B49_CANDIDATES_PENDING_POSTED_PASS_ROLLBACK' result;
ROLLBACK;
