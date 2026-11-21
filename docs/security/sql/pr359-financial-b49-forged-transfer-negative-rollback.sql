-- B4.9.1 negative acceptance: forged operation row must not post GL.
-- Synthetic Staging only. Changes are fully rolled back.
BEGIN;
SET LOCAL statement_timeout='90000ms';
DO $qa$
DECLARE src bigint; dst bigint; rejected boolean:=false; before_entries bigint;
BEGIN
 SELECT count(*) INTO before_entries FROM public.financial_gl_entries WHERE tenant_id=1;
 INSERT INTO public.account_transactions
   (tenant_id,site_id,account_id,transaction_type,amount,description,
    related_account_id,created_by_user_id)
 VALUES(1,1,5,'transfer_out',12.3,'Forged B49 synthetic source',6,4)
 RETURNING id INTO src;
 INSERT INTO public.account_transactions
   (tenant_id,site_id,account_id,transaction_type,amount,description,
    related_account_id,created_by_user_id)
 VALUES(1,1,6,'transfer_in',12.3,'Forged B49 synthetic source',5,4)
 RETURNING id INTO dst;
 INSERT INTO public.company_account_movement_operations
  (tenant_id,operation_key,site_id,created_by_user_id,operation_type,
   payload_hash,primary_transaction_id,counterpart_transaction_id)
 VALUES(1,'fe1e409c-104c-4768-8316-6e9f2de642fa'::uuid,1,4,'transfer',
  repeat('f',32),src,dst);
 BEGIN
  PERFORM public.powerhub_financial_gl_post_source(1,1,'account_movement',src,4);
 EXCEPTION WHEN SQLSTATE '22023' THEN
  IF SQLERRM='GL_COMPANY_TRANSFER_PAIR_INVALID_OR_CROSS_SITE'
  THEN rejected:=true; ELSE RAISE; END IF;
 END;
 IF NOT rejected OR (SELECT count(*) FROM public.financial_gl_entries WHERE tenant_id=1)<>before_entries
 THEN RAISE EXCEPTION 'B49_FORGED_TRANSFER_WAS_ACCEPTED'; END IF;
END;$qa$;
SELECT 'B49_FORGED_TRANSFER_BLOCKED_PASS_ROLLBACK' result;
ROLLBACK;
