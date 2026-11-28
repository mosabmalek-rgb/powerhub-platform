-- B4.7: actual account transfer RPC must affect site cash/wallet
-- subledgers, but remain BLOCKED until a matching GL treatment exists.
-- All synthetic financial transactions are rolled back.
BEGIN;
SET LOCAL statement_timeout='90000ms';
DO $test$
DECLARE op record; r jsonb; cash jsonb; wallet jsonb; base bigint;
BEGIN
 SELECT count(*) INTO base FROM public.financial_gl_entries WHERE tenant_id=1;
 SELECT * INTO op FROM public.powerhub_transfer_company_accounts_idempotent(
  1,1,4,5,6,17.33,'B4.7 typed source reconciliation',
  'ae4c03d2-3c8a-4eb0-b691-abbc0bc89d10'::uuid);
 r:=public.powerhub_financial_gl_subledger_reconciliation(1,1,'2026-11');
 SELECT x INTO cash FROM jsonb_array_elements(r->'checks') x WHERE x->>'code'='1010';
 SELECT x INTO wallet FROM jsonb_array_elements(r->'checks') x WHERE x->>'code'='1020';
 IF r->>'status'<>'BLOCKED_RECONCILIATION'
   OR (r->'diagnostics'->>'unknownCompanyTransactionTypes')::int<>0
   OR (r->'diagnostics'->>'unpostedTransferMovements')::int<>2
   OR cash->>'status'<>'BLOCKED_UNPOSTED_ACCOUNT_TRANSFER'
   OR wallet->>'status'<>'BLOCKED_UNPOSTED_ACCOUNT_TRANSFER'
   OR (cash->>'subledgerBalance')::numeric<>137.67
   OR (wallet->>'subledgerBalance')::numeric<>84.33
   OR r->>'accountingCertification'<>'NOT_CERTIFIED'
   OR (SELECT count(*) FROM public.financial_gl_entries WHERE tenant_id=1)<>base
 THEN RAISE EXCEPTION 'B4_7_TRANSFER_CLASSIFICATION_FAIL';END IF;
END;$test$;
SELECT 'B4_7_TRANSFER_RECOGNIZED_BUT_GL_BLOCKED_ROLLBACK_PASS' result;
ROLLBACK;
