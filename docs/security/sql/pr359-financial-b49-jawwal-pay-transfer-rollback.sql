-- B4.9.3: valid noncash Jawwal Pay account is mapped to GL 1020,
-- verified from original tenant/site source with no second income or expense.
BEGIN;
SET LOCAL statement_timeout='90000ms';
DO $qa$
DECLARE op record; result jsonb; rec jsonb; wallet jsonb;
BEGIN
 INSERT INTO public.company_accounts
   (id,tenant_id,name,account_type,opening_balance)
 VALUES(900000000009138,1,'B49 TEST Jawwal Pay','jawwal_pay',0);
 INSERT INTO public.company_account_sites
   (id,tenant_id,account_id,site_id)
 VALUES(900000000009138,1,900000000009138,1);
 SELECT * INTO op FROM public.powerhub_transfer_company_accounts_idempotent(
  1,1,4,5,900000000009138,11.3,'B4.9 Jawwal source treatment',
  '09d6b75a-394f-4b7e-aa26-c258e3850f7d'::uuid);
 result:=public.powerhub_financial_gl_post_source(
  1,1,'account_movement',op.from_transaction_id,4);
 rec:=public.powerhub_financial_gl_subledger_reconciliation(1,1,'2026-11');
 SELECT row_item INTO wallet FROM jsonb_array_elements(rec->'checks') row_item
 WHERE row_item->>'code'='1020';
 IF result->>'status'<>'posted'
 OR (rec->'diagnostics'->>'unpostedTransferMovements')::bigint<>0
 OR (rec->'diagnostics'->>'glVerifiedTransferPairs')::bigint<>1
 OR rec->>'status'<>'MATCHED_NUMERICALLY_NOT_CERTIFIED'
 OR wallet->>'status'<>'MATCHED' OR (wallet->>'difference')::numeric<>0
 OR rec->>'accountingCertification'<>'NOT_CERTIFIED'
 THEN RAISE EXCEPTION 'B49_JAWWAL_TRANSFER_NOT_RECONCILED'; END IF;
END;$qa$;
SELECT 'B49_JAWWAL_PAY_TRANSFER_MATCHED_PASS_ROLLBACK' result;
ROLLBACK;
