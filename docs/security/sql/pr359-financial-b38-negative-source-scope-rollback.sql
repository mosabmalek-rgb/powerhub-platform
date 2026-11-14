-- B3.8 positive two-site source, independent checker and idempotent replay.
-- All synthetic records are rolled back; independent browser approval NOT proved.
BEGIN;
SET LOCAL statement_timeout='120000ms';
DO $qa$
DECLARE b bigint; l bigint; p jsonb; replay jsonb; roll jsonb; denied boolean:=false;
BEGIN
 SELECT count(*) INTO b FROM public.financial_gl_entries WHERE tenant_id=1;
 SELECT count(*) INTO l FROM public.financial_gl_lines WHERE tenant_id=1;
 IF b<>25 OR l<>51 THEN RAISE EXCEPTION 'B38_STAGING_BASELINE_CHANGED'; END IF;
 UPDATE public.company_account_sites SET site_id=9000000000099
  WHERE tenant_id=1 AND account_id=6 AND site_id=1;
 IF NOT FOUND THEN RAISE EXCEPTION 'B38_TEST_MAPPING_ABSENT'; END IF;
 INSERT INTO public.account_transactions
 (id,tenant_id,site_id,account_id,transaction_type,amount,description,reference_no,related_account_id,created_by_user_id,occurred_at)
 VALUES
 (900000000009123,1,1,5,'transfer_out',20,'B3.8 acceptance test','B38-OUT',6,4,'2026-11-11T12:00:00+00'),
 (900000000009124,1,9000000000099,6,'transfer_in',20,'B3.8 acceptance test','B38-IN',5,4,'2026-11-11T12:00:00+00');
 INSERT INTO public.company_account_movement_operations
 (tenant_id,operation_key,site_id,created_by_user_id,operation_type,payload_hash,primary_transaction_id,counterpart_transaction_id)
 VALUES (1,'2b41750f-c2da-4b45-b4a0-6a53d43698eb',1,4,'transfer',
 md5(jsonb_build_object('tenantId',1,'siteId',1,'userId',4,'fromAccountId',5,
 'toAccountId',6,'amount',20,'description','B3.8 acceptance test')::text),
 900000000009123,900000000009124);
 BEGIN
 PERFORM public.powerhub_financial_gl_post_inter_site_source(1,1,900000000009123,4);
 EXCEPTION WHEN insufficient_privilege THEN denied:=true;
 END;
 IF NOT denied THEN RAISE EXCEPTION 'B38_SELF_APPROVAL_ALLOWED';END IF;

 -- Forged hash must not be accepted.
 UPDATE public.company_account_movement_operations SET payload_hash=repeat('f',32)
 WHERE tenant_id=1 AND primary_transaction_id=900000000009123;
 denied:=false;
 BEGIN
  PERFORM public.powerhub_financial_gl_post_inter_site_source(1,1,900000000009123,260);
 EXCEPTION WHEN SQLSTATE '22023' THEN
   IF SQLERRM='GL_B38_SOURCE_PAIR_OR_FINGERPRINT_INVALID' THEN denied:=true; ELSE RAISE; END IF;
 END;
 IF NOT denied THEN RAISE EXCEPTION 'B38_FORGED_SOURCE_ACCEPTED'; END IF;
 UPDATE public.company_account_movement_operations
 SET payload_hash=md5(jsonb_build_object('tenantId',1,'siteId',1,'userId',4,
  'fromAccountId',5,'toAccountId',6,'amount',20,'description','B3.8 acceptance test')::text)
 WHERE tenant_id=1 AND primary_transaction_id=900000000009123;

 -- Wrong destination account mapping must not be accepted.
 UPDATE public.company_account_sites SET site_id=1 WHERE tenant_id=1 AND account_id=6;
 denied:=false;
 BEGIN
  PERFORM public.powerhub_financial_gl_post_inter_site_source(1,1,900000000009123,260);
 EXCEPTION WHEN SQLSTATE '22023' THEN
   IF SQLERRM='GL_B38_SITE_ACCOUNT_MAPPING_AMBIGUOUS' THEN denied:=true; ELSE RAISE; END IF;
 END;
 IF NOT denied THEN RAISE EXCEPTION 'B38_WRONG_SITE_ACCOUNT_ACCEPTED'; END IF;
 UPDATE public.company_account_sites SET site_id=9000000000099 WHERE tenant_id=1 AND account_id=6;

  p:=public.powerhub_financial_gl_post_inter_site_source(1,1,900000000009123,260);
 replay:=public.powerhub_financial_gl_post_inter_site_source(1,1,900000000009123,260);
 roll:=public.powerhub_financial_gl_tenant_rollup(1,'2026-11');
 IF p->>'alreadyPosted'<>'false' OR replay->>'alreadyPosted'<>'true'
 OR p->>'fromEntryId' IS DISTINCT FROM replay->>'fromEntryId'
 OR p->>'toEntryId' IS DISTINCT FROM replay->>'toEntryId'
 OR (SELECT count(*) FROM public.financial_gl_entries WHERE tenant_id=1)<>b+2
 OR (SELECT count(*) FROM public.financial_gl_lines WHERE tenant_id=1)<>l+4
 OR (SELECT count(*) FROM public.financial_gl_lines WHERE entry_id=(p->>'fromEntryId')::bigint AND account_code='1350' AND side='debit' AND amount=20)<>1
 OR (SELECT count(*) FROM public.financial_gl_lines WHERE entry_id=(p->>'toEntryId')::bigint AND account_code='2350' AND side='credit' AND amount=20)<>1
 OR (roll->>'crossSiteOperationalTransferCount')::bigint<>1
 OR roll->>'accountingCertification'<>'NOT_CERTIFIED'
 THEN RAISE EXCEPTION 'B38_DOUBLE_ENTRY_OR_REPLAY_FAIL';END IF;
END;$qa$;
SET CONSTRAINTS ALL IMMEDIATE;
SELECT 'B38_NEGATIVE_SOURCE_SCOPE_AND_REPLAY_PASS_ROLLBACK' AS result;
ROLLBACK;