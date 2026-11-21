-- D18: test D12 as INSTALLED on Staging; all financial writes ROLLBACK.
-- Do not run against production. Fixture is tenant 1 / site 1 / payment 5.
-- Actors 4 and 260 are synthetic test identities, not human accounting approval.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout='120000ms';
DO $test$
DECLARE
 request jsonb; posted jsonb; replay jsonb; subledger jsonb;cash_audit jsonb;
 correction_id bigint; reversal_entry bigint;
 before_gl bigint;before_lines bigint;before_tx bigint;before_sl bigint;
 reject boolean:=false;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20261115160000')
 OR position('v_correction_valid_count' IN pg_get_functiondef(
    'public.powerhub_financial_gl_subledger_reconciliation(bigint,bigint,text)'::regprocedure))=0
 OR EXISTS(SELECT 1 FROM public.financial_supplier_payment_corrections)
 OR (SELECT amount FROM public.supplier_payments
     WHERE id=5 AND tenant_id=1 AND site_id=1 AND status='posted')<>210
 OR (public.powerhub_financial_supplier_payment_correction_readiness(1,1,5)
    ->>'originalGLEntryId')::bigint<>857
 THEN RAISE EXCEPTION 'D18_INSTALLED_D12_FIXTURE_INVALID'; END IF;
 IF has_function_privilege('anon','public.powerhub_financial_gl_subledger_reconciliation(bigint,bigint,text)','EXECUTE')
 OR has_function_privilege('authenticated','public.powerhub_financial_gl_subledger_reconciliation(bigint,bigint,text)','EXECUTE')
 OR NOT has_function_privilege('service_role','public.powerhub_financial_gl_subledger_reconciliation(bigint,bigint,text)','EXECUTE')
 THEN RAISE EXCEPTION 'D18_INSTALLED_D12_ACL_EXPOSED'; END IF;
 SELECT count(*) INTO before_gl FROM public.financial_gl_entries WHERE tenant_id=1;
 SELECT count(*) INTO before_lines FROM public.financial_gl_lines WHERE tenant_id=1;
 SELECT count(*) INTO before_tx FROM public.account_transactions;
 SELECT count(*) INTO before_sl FROM public.supplier_ledger_entries WHERE tenant_id=1;
 IF before_gl<>25 OR before_lines<>51 OR before_tx<>361009
 THEN RAISE EXCEPTION 'D18_STAGING_GL_BASELINE_DRIFT'; END IF;
 subledger:=public.powerhub_financial_gl_subledger_reconciliation(1,1,'2026-11');
 IF subledger->>'status' IS DISTINCT FROM 'MATCHED_NUMERICALLY_NOT_CERTIFIED'
 OR (subledger->>'unresolvedCount')::bigint<>0
 OR (subledger->'diagnostics'->>'unknownCompanyTransactionTypes')::bigint<>0
 THEN RAISE EXCEPTION 'D18_BASELINE_RECONCILIATION_INVALID'; END IF;
 request:=public.powerhub_financial_supplier_payment_correction_request(
   1,1,5,4,'D18 installed D12 Staging rollback-only source-backed reversal',
   'd18-installed-d12-correction-rollback-20261115');
 correction_id:=(request->>'correctionId')::bigint;
 IF correction_id IS NULL OR request->>'status' IS DISTINCT FROM 'pending_review'
 THEN RAISE EXCEPTION 'D18_REQUEST_NOT_PENDING'; END IF;
 BEGIN
   PERFORM public.powerhub_financial_supplier_payment_correction_approve_post(1,1,correction_id,4);
 EXCEPTION WHEN SQLSTATE '22023' THEN reject:=true;END;
 IF NOT reject THEN RAISE EXCEPTION 'D18_SELF_APPROVAL_ALLOWED';END IF;
 reject:=false;
 BEGIN
   PERFORM public.powerhub_financial_supplier_payment_correction_approve_post(2,1,correction_id,260);
 EXCEPTION WHEN OTHERS THEN reject:=true;END;
 IF NOT reject THEN RAISE EXCEPTION 'D18_FOREIGN_TENANT_ALLOWED';END IF;
 posted:=public.powerhub_financial_supplier_payment_correction_approve_post(1,1,correction_id,260);
 reversal_entry:=(posted->>'entryId')::bigint;
 IF posted->>'status' IS DISTINCT FROM 'posted'
 OR posted->>'alreadyPosted' IS DISTINCT FROM 'false'
 OR posted->>'accountingCertification' IS DISTINCT FROM 'NOT_CERTIFIED'
 OR public.powerhub_financial_supplier_payment_correction_proof(1,1,5)
   IS DISTINCT FROM 'SOURCE_BACKED_REVERSAL_VALID'
 OR public.powerhub_financial_gl_reversal_source_proof(1,1,857,reversal_entry)
   IS DISTINCT FROM 'SOURCE_BACKED_REVERSAL_VALID'
 THEN RAISE EXCEPTION 'D18_CORRECTION_OR_SOURCE_GL_NOT_VALID'; END IF;
 replay:=public.powerhub_financial_supplier_payment_correction_approve_post(1,1,correction_id,260);
 IF replay->>'alreadyPosted' IS DISTINCT FROM 'true'
 OR (replay->>'entryId')::bigint IS DISTINCT FROM reversal_entry
 THEN RAISE EXCEPTION 'D18_APPROVAL_REPLAY_CREATED_DUPLICATE'; END IF;
 IF (SELECT count(*) FROM public.financial_gl_entries WHERE tenant_id=1)<>before_gl+1
 OR (SELECT count(*) FROM public.financial_gl_lines WHERE tenant_id=1)<>before_lines+2
 OR (SELECT count(*) FROM public.account_transactions)<>before_tx+1
 OR (SELECT count(*) FROM public.supplier_ledger_entries WHERE tenant_id=1)<>before_sl+1
 THEN RAISE EXCEPTION 'D18_NONATOMIC_SOURCE_CORRECTION'; END IF;
 subledger:=public.powerhub_financial_gl_subledger_reconciliation(1,1,'2026-11');
 cash_audit:=public.powerhub_financial_gl_company_movement_audit(1,1,'2026-11');
 IF subledger->>'status' IS DISTINCT FROM 'MATCHED_NUMERICALLY_NOT_CERTIFIED'
 OR subledger->>'isMathematicallyMatched' IS DISTINCT FROM 'true'
 OR subledger->>'accountingCertification' IS DISTINCT FROM 'NOT_CERTIFIED'
 OR (subledger->>'differenceCount')::bigint<>0
 OR (subledger->>'unresolvedCount')::bigint<>0
 OR (subledger->'diagnostics'->>'unknownCompanyTransactionTypes')::bigint<>0
 OR cash_audit->>'status' IS DISTINCT FROM 'LINKED_ACCOUNT_MOVEMENTS_MATCH_NOT_CERTIFIED'
 OR (cash_audit->>'mismatchCount')::bigint<>0
 OR (cash_audit->>'aggregateUnresolvedCount')::bigint<>0
 THEN RAISE EXCEPTION 'D18_INSTALLED_CASH_SUBLEDGER_NOT_MATCHED';END IF;
END $test$;
SELECT 'D18_D12_INSTALLED_STAGING_POSITIVE_ROLLBACK_PASS' AS result;
ROLLBACK;

BEGIN;
SET LOCAL statement_timeout='120000ms';
DO $negative$
DECLARE b bigint; account_id bigint; result jsonb;
BEGIN
 SELECT count(*) INTO b FROM public.account_transactions;
 SELECT id INTO account_id FROM public.company_accounts
 WHERE tenant_id=1 AND account_type='cash' ORDER BY id LIMIT 1;
 IF account_id IS NULL OR b<>361009
 OR NOT EXISTS(SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20261115160000')
 THEN RAISE EXCEPTION 'D18_NEGATIVE_BASELINE_NOT_READY';END IF;
 INSERT INTO public.account_transactions(
   tenant_id,account_id,site_id,transaction_type,amount,description,reference_no,created_by_user_id
 ) VALUES(1,account_id,1,'deposit',1.25,'D18 synthetic unrelated deposit rollback',
          'D18-UNLINKED-DEPOSIT-ROLLBACK',4);
 result:=public.powerhub_financial_gl_subledger_reconciliation(1,1,'2026-11');
 IF result->>'status' IS DISTINCT FROM 'BLOCKED_RECONCILIATION'
 OR (result->'diagnostics'->>'unknownCompanyTransactionTypes')::bigint<1
 OR (result->>'unresolvedCount')::bigint<1
 OR result->>'accountingCertification' IS DISTINCT FROM 'NOT_CERTIFIED'
 THEN RAISE EXCEPTION 'D18_UNKNOWN_DEPOSIT_FALSELY_RECONCILED';END IF;
 IF (SELECT count(*) FROM public.account_transactions)<>b+1
 THEN RAISE EXCEPTION 'D18_NEGATIVE_EXTRA_SIDE_EFFECTS';END IF;
END $negative$;
SELECT 'D18_D12_INSTALLED_UNKNOWN_DEPOSIT_FAIL_CLOSED_ROLLBACK_PASS' AS result;
ROLLBACK;

DO $postcheck$
BEGIN
 IF (SELECT count(*) FROM public.financial_gl_entries WHERE tenant_id=1)<>25
 OR (SELECT count(*) FROM public.financial_gl_lines WHERE tenant_id=1)<>51
 OR (SELECT count(*) FROM public.account_transactions)<>361009
 OR (SELECT count(*) FROM public.financial_supplier_payment_corrections)<>0
 OR EXISTS(SELECT 1 FROM public.account_transactions
   WHERE reference_no='D18-UNLINKED-DEPOSIT-ROLLBACK')
 THEN RAISE EXCEPTION 'D18_ROLLBACK_LEFT_FINANCIAL_SIDE_EFFECTS';END IF;
END $postcheck$;
SELECT 'D18_INSTALLED_STAGING_POSITIVE_NEGATIVE_AND_ROLLBACK_PASS' AS result;