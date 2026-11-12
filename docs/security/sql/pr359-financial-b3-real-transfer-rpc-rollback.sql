-- B3.4: use the actual company-account transfer RPC in synthetic Staging.
-- Confirms transfer_out/in pair and NOT_CERTIFIED; all changes are rolled back.
BEGIN;
SET LOCAL statement_timeout='90000ms';
DO $test$
DECLARE op record; s jsonb; old_count bigint;
BEGIN
 SELECT count(*) INTO old_count FROM public.financial_gl_entries WHERE tenant_id=1;
 SELECT * INTO op FROM public.powerhub_transfer_company_accounts_idempotent(
   1,1,4,5,6,20,'Synthetic B3.4 valid account transfer',
   'f7c40e71-a801-4a3e-a53e-68089d6d2194'::uuid);
 IF op.from_transaction_id IS NULL OR op.to_transaction_id IS NULL OR op.replayed
 THEN RAISE EXCEPTION 'B3_4_RPC_NO_PAIR'; END IF;
 s:=public.powerhub_financial_gl_tenant_rollup(1,'2026-11');
 IF (s->>'companyTransferSourceOperationCount')::bigint<>1
 OR (s->>'invalidOperationalTransferPairCount')::bigint<>0
 OR (s->>'crossSiteOperationalTransferCount')::bigint<>0
 OR (s->'readiness'->>'interSiteSourcePairIntegrity')::boolean IS DISTINCT FROM true
 OR s->>'accountingCertification'<>'NOT_CERTIFIED'
 OR (SELECT count(*) FROM public.financial_gl_entries WHERE tenant_id=1)<>old_count
 THEN RAISE EXCEPTION 'B3_4_VALID_TRANSFER_REJECTED'; END IF;
END;$test$;
SELECT 'B3_4_REAL_RPC_TRANSFER_TYPES_PASS_ROLLBACK' result;
ROLLBACK;
