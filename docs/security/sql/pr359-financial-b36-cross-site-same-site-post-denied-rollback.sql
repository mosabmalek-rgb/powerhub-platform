-- B3.6: cross-site transfer operational source must NOT be posted through same-site GL planner.
-- All temporary wallet-site mapping, movements and operation are rolled back.
BEGIN;
SET LOCAL statement_timeout='90000ms';
DO $proof$
DECLARE result jsonb; before_gl bigint; v_denied boolean:=false;
BEGIN
 SELECT count(*) INTO before_gl FROM public.financial_gl_entries WHERE tenant_id=1;
 INSERT INTO public.company_account_sites(id,tenant_id,account_id,site_id)
 VALUES(900000000009123,1,6,9000000000099);
 INSERT INTO public.account_transactions
 (id,tenant_id,site_id,account_id,transaction_type,amount,description,reference_no,related_account_id,created_by_user_id,occurred_at)
 VALUES
 (900000000009123,1,1,5,'transfer_out',20,'B3 cross-site synthetic paired transfer','STG-B3.3-SOURCE-OUT',6,4,'2026-11-11T12:00:00+00'),
 (900000000009124,1,9000000000099,6,'transfer_in',20,'B3 cross-site synthetic paired transfer','STG-B3.3-SOURCE-IN',5,4,'2026-11-11T12:00:00+00');
 INSERT INTO public.company_account_movement_operations
 (tenant_id,operation_key,site_id,created_by_user_id,operation_type,payload_hash,primary_transaction_id,counterpart_transaction_id)
 VALUES(1,'2b41750f-c2da-4b45-b4a0-6a53d43698ef',1,4,'transfer',
 md5(jsonb_build_object('tenantId',1,'siteId',1,'userId',4,'fromAccountId',5,'toAccountId',6,'amount',20,'description','B3 cross-site synthetic paired transfer')::text),900000000009123,900000000009124);
 result:=public.powerhub_financial_gl_tenant_rollup(1,'2026-11');
 IF (result->>'companyTransferSourceOperationCount')::bigint<>1
 OR (result->>'crossSiteOperationalTransferCount')::bigint<>1
 OR (result->>'crossSiteOperationalTransferAmount')::numeric<>20
 OR (result->>'invalidOperationalTransferPairCount')::bigint<>0
 OR result->>'interSiteSourceEvidenceStatus'<>'CROSS_SITE_TRANSFER_REQUIRES_GL_ELIMINATION_PROOF'
 OR (result->'readiness'->>'canBeCertifiedConsolidation')::boolean IS DISTINCT FROM false
 OR (result->>'isConsolidatedFinancialStatements')::boolean IS DISTINCT FROM false
 OR result->>'accountingCertification'<>'NOT_CERTIFIED'
 OR (SELECT count(*) FROM public.financial_gl_entries WHERE tenant_id=1)<>before_gl
 THEN RAISE EXCEPTION 'B3_6_VALID_CROSS_SITE_SOURCE_MISCLASSIFIED'; END IF;
 BEGIN
  PERFORM public.powerhub_financial_gl_source_plan(1,1,'account_movement',900000000009123);
 EXCEPTION WHEN SQLSTATE '22023' THEN
  IF SQLERRM='GL_COMPANY_TRANSFER_PAIR_INVALID_OR_CROSS_SITE' THEN v_denied:=true;
  ELSE RAISE; END IF;
 END;
 IF v_denied IS DISTINCT FROM true THEN RAISE EXCEPTION 'B3_6_CROSS_SITE_GL_UNSAFELY_POSTABLE'; END IF;
 IF (SELECT count(*) FROM public.financial_gl_entries WHERE tenant_id=1)<>before_gl
 THEN RAISE EXCEPTION 'B3_6_GL_MUTATED'; END IF;
END;$proof$;
SELECT 'B3_6_CROSS_SITE_SAME_SITE_POST_DENIED_PASS_ROLLBACK' result;
ROLLBACK;
