-- B3.3 positive synthetic cross-site source: detection is not GL elimination.
-- All temporary wallet-site mapping, movements and operation are rolled back.
BEGIN;
SET LOCAL statement_timeout='90000ms';
DO $proof$
DECLARE result jsonb; before_gl bigint;
BEGIN
 SELECT count(*) INTO before_gl FROM public.financial_gl_entries WHERE tenant_id=1;
 INSERT INTO public.company_account_sites(id,tenant_id,account_id,site_id)
 VALUES(900000000009123,1,6,9000000000099);
 INSERT INTO public.account_transactions
 (id,tenant_id,site_id,account_id,transaction_type,amount,description,reference_no,related_account_id,created_by_user_id,occurred_at)
 VALUES
 (900000000009123,1,1,5,'transfer_out',20,'B3 cross-site synthetic outgoing','STG-B3.3-SOURCE-OUT',6,4,'2026-11-11T12:00:00+00'),
 (900000000009124,1,9000000000099,6,'transfer_in',20,'B3 cross-site synthetic incoming','STG-B3.3-SOURCE-IN',5,4,'2026-11-11T12:00:00+00');
 INSERT INTO public.company_account_movement_operations
 (tenant_id,operation_key,site_id,created_by_user_id,operation_type,payload_hash,primary_transaction_id,counterpart_transaction_id)
 VALUES(1,'2b41750f-c2da-4b45-b4a0-6a53d43698ef',1,4,'transfer',
 repeat('b',32),900000000009123,900000000009124);
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
 THEN RAISE EXCEPTION 'B3_3_POSITIVE_SOURCE_NOT_CLASSIFIED'; END IF;
END;$proof$;
SELECT 'B3_3_POSITIVE_CROSS_SITE_SOURCE_BLOCKED_PASS_ROLLBACK' result;
ROLLBACK;
