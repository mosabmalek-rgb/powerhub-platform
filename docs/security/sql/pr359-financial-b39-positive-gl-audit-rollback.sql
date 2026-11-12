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
 p:=public.powerhub_financial_gl_post_inter_site_source(1,1,900000000009123,260);
 replay:=public.powerhub_financial_gl_post_inter_site_source(1,1,900000000009123,260);
 roll:=public.powerhub_financial_gl_tenant_rollup(1,'2026-11');
 IF (SELECT (j->>'matchedPairCount')::bigint FROM
      (SELECT public.powerhub_financial_gl_inter_site_posting_audit(1,'2026-11') j) q)<>1
 OR (SELECT (j->>'matchedDueFrom')::numeric FROM
      (SELECT public.powerhub_financial_gl_inter_site_posting_audit(1,'2026-11') j) q)<>20
 OR (SELECT j->>'status' FROM
      (SELECT public.powerhub_financial_gl_inter_site_posting_audit(1,'2026-11') j) q)
        <>'MATCHED_DUE_FROM_TO_PRELIMINARY_ONLY'
 THEN RAISE EXCEPTION 'B39_DUAL_SITE_GL_AUDIT_REJECTED'; END IF;
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
SELECT 'B39_INTER_SITE_POSTING_AUDIT_PASS_ROLLBACK' AS result;
ROLLBACK;