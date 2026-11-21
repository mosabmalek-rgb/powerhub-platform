-- D32: installed Staging D27 behavioral acceptance. All writes are rolled back.
-- Uses synthetic tenant 1 and two real test accounts, no permanent journal.
BEGIN;
SET LOCAL statement_timeout='60000ms';
INSERT INTO public.account_transactions(id,tenant_id,site_id,account_id,transaction_type,amount,description,reference_no,related_account_id,created_by_user_id,occurred_at) VALUES
(8800000000320001,1,1,5,'transfer_out',125.35,'D32 rollback outgoing','D32-ROLLBACK-OUT',6,4,'2026-11-15T10:00:00+02:00'),
(8800000000320002,1,1,6,'transfer_in',125.35,'D32 rollback incoming','D32-ROLLBACK-IN',5,4,'2026-11-15T10:00:01+02:00');
INSERT INTO public.company_account_movement_operations(tenant_id,operation_key,site_id,created_by_user_id,operation_type,payload_hash,primary_transaction_id,counterpart_transaction_id)
VALUES (1,'d032d032-d032-4032-8032-d032d032d032',1,4,'transfer',md5('d32-integration-rollback'),8800000000320001,8800000000320002);
DO $check$
DECLARE j jsonb;
BEGIN
j:=public.powerhub_financial_company_transfer_pair_provenance(1,'2026-11');
IF j->>'status'<>'PRELIMINARY_SOURCE_BACKED_TRANSFER_PAIRS'
 OR (j->>'verifiedOperationPairCount')::int<>1 OR (j->>'transferMovementCount')::int<>2
 OR j->>'pairCoverageComplete'<>'true' OR j->>'accountingCertification'<>'NOT_CERTIFIED'
 THEN RAISE EXCEPTION 'D32_POSITIVE_FAIL: %',j; END IF;
UPDATE public.account_transactions SET amount=125.36 WHERE id=8800000000320002;
j:=public.powerhub_financial_company_transfer_pair_provenance(1,'2026-11');
IF j->>'status'<>'BLOCKED_TRANSFER_PROVENANCE' OR (j->>'invalidOperationPairCount')::int<>1
 OR NOT (j->'blockers' ? 'TRANSFER_SIDES_UNBALANCED') THEN RAISE EXCEPTION 'D32_TAMPER_FAIL: %',j;END IF;
UPDATE public.account_transactions SET amount=125.35 WHERE id=8800000000320002;
UPDATE public.account_transactions SET related_account_id=NULL WHERE id=8800000000320002;
j:=public.powerhub_financial_company_transfer_pair_provenance(1,'2026-11');
IF (j->>'invalidOperationPairCount')::int<>1 THEN RAISE EXCEPTION 'D32_MISSING_COUNTERPART_FAIL: %',j;END IF;
UPDATE public.account_transactions SET related_account_id=5 WHERE id=8800000000320002;
INSERT INTO public.company_account_movement_operations(tenant_id,operation_key,site_id,created_by_user_id,operation_type,payload_hash,primary_transaction_id,counterpart_transaction_id)
VALUES (1,'d032d032-d032-4032-8032-d032d032d033',1,4,'transfer',md5('d32-duplicate'),8800000000320001,8800000000320002);
j:=public.powerhub_financial_company_transfer_pair_provenance(1,'2026-11');
IF NOT(j->'blockers' ? 'TRANSFER_MOVEMENT_REUSED_BY_MULTIPLE_OPERATIONS')
 THEN RAISE EXCEPTION 'D32_DUPLICATE_PAIR_FAIL: %',j;END IF;
DELETE FROM public.company_account_movement_operations WHERE operation_key='d032d032-d032-4032-8032-d032d032d033';
INSERT INTO public.account_transactions(id,tenant_id,site_id,account_id,transaction_type,amount,description,reference_no,related_account_id,created_by_user_id,occurred_at)
VALUES (8800000000320003,1,1,5,'transfer_out',34.60,'D32 orphan rollback','D32-ORPHAN',6,4,'2026-11-15T10:00:02+02:00');
j:=public.powerhub_financial_company_transfer_pair_provenance(1,'2026-11');
IF NOT(j->'blockers' ? 'TRANSFER_MOVEMENT_WITHOUT_VERIFIED_OPERATION_PAIR')
 THEN RAISE EXCEPTION 'D32_ORPHAN_FAIL: %',j;END IF;
END $check$;
ROLLBACK;
SELECT 'D32_POSITIVE_AMOUNT_TAMPER_MISSING_COUNTERPART_REPLAY_ORPHAN_ROLLBACK_PASS' result;