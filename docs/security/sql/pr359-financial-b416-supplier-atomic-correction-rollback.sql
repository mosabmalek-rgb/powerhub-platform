-- Staging-only synthetic B4.16 regression: all writes rolled back.
-- Requires prelaunch fixture (tenant 1 / site 1 / payment 5 / original GL 857).
-- SQL identities 4 and 260 are test actors, NOT human approvals.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout='100s';
DO $check$
DECLARE req jsonb;res jsonb;replay jsonb;c bigint;entry bigint;
  gl0 bigint;tx0 bigint;sl0 bigint;bad boolean:=false;orig jsonb;audit jsonb;
BEGIN
 IF (SELECT count(*) FROM public.financial_supplier_payment_corrections)<>0
   OR (SELECT count(*) FROM public.financial_gl_entries WHERE tenant_id=1)<>25
   OR (SELECT count(*) FROM public.financial_gl_lines WHERE tenant_id=1)<>51
   OR (SELECT amount FROM public.supplier_payments WHERE id=5 AND tenant_id=1
      AND site_id=1 AND status='posted')<>210
   OR (public.powerhub_financial_supplier_payment_correction_readiness(1,1,5)
      ->>'originalGLEntryId')::bigint<>857
 THEN RAISE EXCEPTION 'B416_STAGING_FIXTURE_DRIFT';END IF;
 IF has_function_privilege('authenticated',
  'public.powerhub_financial_supplier_payment_correction_request(bigint,bigint,bigint,bigint,text,text)','EXECUTE')
 OR has_function_privilege('anon',
  'public.powerhub_financial_supplier_payment_correction_approve_post(bigint,bigint,bigint,bigint)','EXECUTE')
 OR has_table_privilege('authenticated','public.financial_supplier_payment_corrections','SELECT')
 THEN RAISE EXCEPTION 'B416_PUBLIC_EXECUTE_OR_TABLE_EXPOSURE';END IF;
 SELECT count(*) INTO gl0 FROM public.financial_gl_entries WHERE tenant_id=1;
 SELECT count(*) INTO tx0 FROM public.account_transactions WHERE tenant_id=1;
 SELECT count(*) INTO sl0 FROM public.supplier_ledger_entries WHERE tenant_id=1;
 req:=public.powerhub_financial_supplier_payment_correction_request(
  1,1,5,4,'Synthetic correction rollback only; no real approval','b416-e2e-rollback-001');
 c:=(req->>'correctionId')::bigint;
 IF req->>'status'<>'pending_review' THEN RAISE EXCEPTION 'B416_REQUEST_NOT_PENDING';END IF;
 BEGIN
   PERFORM public.powerhub_financial_supplier_payment_correction_request(
    1,1,5,4,'A modified reason is not allowed','b416-e2e-rollback-001');
 EXCEPTION WHEN SQLSTATE '23505' THEN bad:=true;END;
 IF NOT bad THEN RAISE EXCEPTION 'B416_CHANGED_OPERATION_ACCEPTED';END IF;
 bad:=false;
 BEGIN
   PERFORM public.powerhub_financial_supplier_payment_correction_approve_post(1,1,c,4);
 EXCEPTION WHEN SQLSTATE '22023' THEN bad:=true;END;
 IF NOT bad THEN RAISE EXCEPTION 'B416_SELF_APPROVAL_ACCEPTED';END IF;
 bad:=false;
 BEGIN
   PERFORM public.powerhub_financial_supplier_payment_correction_approve_post(2,1,c,260);
 EXCEPTION WHEN OTHERS THEN bad:=true;END;
 IF NOT bad THEN RAISE EXCEPTION 'B416_FOREIGN_TENANT_ACCEPTED';END IF;
 res:=public.powerhub_financial_supplier_payment_correction_approve_post(1,1,c,260);
 entry:=(res->>'entryId')::bigint;
 IF res->>'status'<>'posted' OR (res->>'alreadyPosted')::boolean IS DISTINCT FROM false
  OR res->>'accountingCertification'<>'NOT_CERTIFIED'
  OR public.powerhub_financial_supplier_payment_correction_proof(1,1,5)<>'SOURCE_BACKED_REVERSAL_VALID'
  OR public.powerhub_financial_gl_reversal_source_proof(1,1,857,entry)<>'SOURCE_BACKED_REVERSAL_VALID'
 THEN RAISE EXCEPTION 'B416_SOURCE_BACKED_POST_PROOF_FAILED';END IF;
 orig:=public.powerhub_financial_gl_source_plan(1,1,'supplier_ledger',20);
 IF orig->>'sourceFingerprint' IS DISTINCT FROM
  (SELECT source_fingerprint FROM public.financial_gl_entries WHERE id=857)
 THEN RAISE EXCEPTION 'B416_ORIGINAL_GL_FINGERPRINT_DRIFT';END IF;
 audit:=public.powerhub_financial_gl_company_movement_audit(1,1,'2026-11');
 IF audit->>'accountingCertification'<>'NOT_CERTIFIED' THEN
  RAISE EXCEPTION 'B416_FALSE_CASH_CERTIFICATION';END IF;
 IF (SELECT count(*) FROM public.financial_gl_entries WHERE tenant_id=1)<>gl0+1
  OR (SELECT count(*) FROM public.account_transactions WHERE tenant_id=1)<>tx0+1
  OR (SELECT count(*) FROM public.supplier_ledger_entries WHERE tenant_id=1)<>sl0+1
 THEN RAISE EXCEPTION 'B416_ATOMIC_COUNTS_INCORRECT';END IF;
 replay:=public.powerhub_financial_supplier_payment_correction_approve_post(1,1,c,260);
 IF (replay->>'alreadyPosted')::boolean IS DISTINCT FROM true
  OR (replay->>'entryId')::bigint<>entry
 THEN RAISE EXCEPTION 'B416_REPLAY_POST_DUPLICATED';END IF;
 replay:=public.powerhub_financial_supplier_payment_correction_request(
  1,1,5,4,'Synthetic correction rollback only; no real approval','b416-e2e-rollback-001');
 IF (replay->>'alreadyPosted')::boolean IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'B416_REPLAY_REQUEST_DUPLICATED';END IF;
 IF (SELECT count(*) FROM public.financial_gl_entries WHERE tenant_id=1)<>gl0+1
  OR (SELECT count(*) FROM public.account_transactions WHERE tenant_id=1)<>tx0+1
 THEN RAISE EXCEPTION 'B416_REPLAY_ADDED_DUPLICATES';END IF;
END;$check$;
SELECT 'B416_ATOMIC_SOURCE_CORRECTION_NEGATIVE_REPLAY_PASS_ROLLBACK' AS result;
ROLLBACK;
