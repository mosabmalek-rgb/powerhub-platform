-- Run after injecting source migration SQL in same BEGIN transaction; staged-only, never Production.

-- D28 staged temporary definition; all probes and changes rolled back.
DO $assert$
DECLARE a jsonb;b jsonb;denied boolean:=false;
BEGIN
 a:=public.powerhub_financial_cash_source_gl_chain(1,'2026-11');
 b:=public.powerhub_financial_cash_source_gl_chain(9000000000001,'2026-10');
 IF (a->>'verifiedSourceCashGlMovementCount')::bigint<>9 OR
  (a->>'unlinkedNonTransferCashMovementCount')::bigint<>250000 OR
  (b->>'internalTransferMovementCount')::bigint<>21110 OR
  (b->>'unlinkedNonTransferCashMovementCount')::bigint<>84434 OR
  a->>'accountingCertification' IS DISTINCT FROM 'NOT_CERTIFIED'
 THEN RAISE EXCEPTION 'D28_INSTALLED_FIXTURE_UNEXPECTED'; END IF;
 IF has_function_privilege('anon','public.powerhub_financial_cash_source_gl_chain(bigint,text)','EXECUTE')
 OR has_function_privilege('authenticated','public.powerhub_financial_cash_source_gl_chain(bigint,text)','EXECUTE')
 OR NOT has_function_privilege('service_role','public.powerhub_financial_cash_source_gl_chain(bigint,text)','EXECUTE')
 THEN RAISE EXCEPTION 'D28_EXECUTE_ACL_INVALID';END IF;
 BEGIN
  PERFORM public.powerhub_financial_cash_source_gl_chain(9000000000002,'2026-10');
 EXCEPTION WHEN SQLSTATE '22023' THEN denied:=true;END;
 IF NOT denied THEN RAISE EXCEPTION 'D28_UNKNOWN_TENANT_ALLOWED';END IF;
END $assert$;
SAVEPOINT test_amount;
UPDATE public.account_transactions SET amount=100.01
 WHERE id=2 AND tenant_id=1;
DO $assert$
DECLARE a jsonb;
BEGIN
 a:=public.powerhub_financial_cash_source_gl_chain(1,'2026-11');
 IF (a->>'verifiedSourceCashGlMovementCount')::bigint<>8
 OR (a->>'unverifiedSourceCashGlMovementCount')::bigint<>1
 OR NOT (a->'blockers' @> '["EXPLICIT_CASH_SOURCE_OR_GL_MISMATCH"]'::jsonb)
 THEN RAISE EXCEPTION 'D28_AMOUNT_TAMPER_NOT_BLOCKED';END IF;
END $assert$;
ROLLBACK TO SAVEPOINT test_amount;
SAVEPOINT test_duplicate;
UPDATE public.account_transactions SET related_payment_id=2
 WHERE id=3 AND tenant_id=1;
DO $assert$
DECLARE a jsonb;
BEGIN
 a:=public.powerhub_financial_cash_source_gl_chain(1,'2026-11');
 IF (a->>'verifiedSourceCashGlMovementCount')::bigint<>7
 OR (a->>'unverifiedSourceCashGlMovementCount')::bigint<>2
 OR NOT (a->'blockers' @> '["EXPLICIT_CASH_SOURCE_OR_GL_MISMATCH"]'::jsonb)
 THEN RAISE EXCEPTION 'D28_DUPLICATE_DOCUMENT_NOT_BLOCKED';END IF;
END $assert$;
ROLLBACK TO SAVEPOINT test_duplicate;
DO $assert$
DECLARE denied boolean:=false;
BEGIN
 BEGIN
  UPDATE public.financial_gl_lines SET amount=99.99
    WHERE entry_id=859 AND account_code='1010' AND side='debit';
 EXCEPTION WHEN SQLSTATE '22023' THEN
  IF SQLERRM='FINANCIAL_GL_IMMUTABLE' THEN denied:=true;END IF;
 END;
 IF NOT denied THEN RAISE EXCEPTION 'D28_GL_IMMUTABILITY_NOT_ENFORCED';END IF;
END $assert$;
DO $assert$
DECLARE a jsonb;
BEGIN
 a:=public.powerhub_financial_cash_source_gl_chain(1,'2026-11');
 IF (a->>'verifiedSourceCashGlMovementCount')::bigint<>9
 OR (select count(*) from public.financial_gl_entries)<>25
 OR (select count(*) from public.financial_gl_lines)<>51
 OR (select count(*) from public.account_transactions)<>361009
 THEN RAISE EXCEPTION 'D28_AFTER_ROLLBACK_BASELINE_CHANGED';END IF;
END $assert$;
SELECT 'D28_ROLLBACK_NEGATIVE_SOURCE_AMOUNT_DUPLICATE_IMMUTABLE_GL_PASS' AS result;
