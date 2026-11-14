-- B3.3: source-backed transfer mismatch test, synthetic Staging only.
-- Existing unrelated receipts are deliberately mispaired as a "transfer".
-- The operation must be flagged and the entire change rolled back.
BEGIN;
SET LOCAL statement_timeout='120000ms';
DO $qa$
DECLARE before jsonb; after jsonb; baseline bigint;
BEGIN
 before:=public.powerhub_financial_gl_tenant_rollup(1,'2026-11');
 IF before->>'interSiteSourceEvidenceStatus'<>'NO_CROSS_SITE_SOURCE_OBSERVED_NOT_CERTIFIED'
    OR (before->>'companyTransferSourceOperationCount')::bigint<>0
    OR before->>'accountingCertification'<>'NOT_CERTIFIED'
 THEN RAISE EXCEPTION 'B3_3_BASELINE_CHANGED'; END IF;
 SELECT count(*) INTO baseline FROM public.financial_gl_entries WHERE tenant_id=1;
 INSERT INTO public.company_account_movement_operations
 (tenant_id,operation_key,site_id,created_by_user_id,operation_type,
  payload_hash,primary_transaction_id,counterpart_transaction_id)
 VALUES(1,'2b41750f-c2da-4b45-b4a0-6a53d43698ee',1,4,'transfer',
 repeat('a',32),2,3);
 after:=public.powerhub_financial_gl_tenant_rollup(1,'2026-11');
 IF (after->>'companyTransferSourceOperationCount')::bigint<>1
    OR (after->>'invalidOperationalTransferPairCount')::bigint<>1
    OR after->>'interSiteSourceEvidenceStatus'<>'INVALID_OPERATIONAL_PAIR_BLOCKS_ELIMINATION'
    OR (after->'readiness'->>'interSiteSourcePairIntegrity')::boolean IS DISTINCT FROM false
    OR after->>'accountingCertification'<>'NOT_CERTIFIED'
    OR (after->>'isConsolidatedFinancialStatements')::boolean IS DISTINCT FROM false
    OR (SELECT count(*) FROM public.financial_gl_entries WHERE tenant_id=1)<>baseline
 THEN RAISE EXCEPTION 'B3_3_BROKEN_TRANSFER_NOT_DETECTED';END IF;
END;$qa$;
SELECT 'B3_3_INVALID_TRANSFER_PAIR_PASS_ROLLBACK' result;
ROLLBACK;
