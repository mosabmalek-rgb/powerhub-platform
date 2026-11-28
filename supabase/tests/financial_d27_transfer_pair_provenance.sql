-- D27 isolated PostgreSQL 17 checks: exact migration and positive/negative pairs.
\set ON_ERROR_STOP on
DO $roles$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $roles$;
CREATE TABLE public.sites(id bigint PRIMARY KEY,tenant_id bigint NOT NULL,status text NOT NULL);
CREATE TABLE public.company_accounts(id bigint PRIMARY KEY,tenant_id bigint NOT NULL);
CREATE TABLE public.account_transactions(
 id bigint PRIMARY KEY,tenant_id bigint NOT NULL,site_id bigint,account_id bigint,
 transaction_type text NOT NULL,amount numeric NOT NULL,occurred_at timestamptz NOT NULL,
 created_by_user_id bigint,related_account_id bigint
);
CREATE TABLE public.company_account_movement_operations(
 tenant_id bigint NOT NULL,operation_key uuid NOT NULL,site_id bigint NOT NULL,
 created_by_user_id bigint,operation_type text NOT NULL,
 primary_transaction_id bigint NOT NULL,counterpart_transaction_id bigint,
 PRIMARY KEY(tenant_id,operation_key)
);
GRANT USAGE ON SCHEMA public TO service_role;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO service_role;
\ir ../migrations/20261115193000_powerhub_financial_d27_transfer_operation_pair_provenance.sql
INSERT INTO public.sites VALUES(1,901,'active'),(2,901,'active'),(3,902,'active');
INSERT INTO public.company_accounts VALUES(10,901),(11,901),(20,902);
INSERT INTO public.account_transactions VALUES
(1,901,1,10,'transfer_out',7.25,'2026-10-01T00:00:00Z',12,11),
(2,901,1,11,'transfer_in',7.25,'2026-10-01T00:00:00Z',12,10),
(3,902,3,20,'transfer_out',50,'2026-10-01T00:00:00Z',99,20);
INSERT INTO public.company_account_movement_operations
VALUES(901,'00000000-0000-4000-8000-000000000001',1,12,'transfer',1,2);
DO $a$
DECLARE j jsonb;denied boolean:=false;
BEGIN
 j:=public.powerhub_financial_company_transfer_pair_provenance(901,'2026-10');
 IF j->>'status' IS DISTINCT FROM 'PRELIMINARY_SOURCE_BACKED_TRANSFER_PAIRS'
 OR (j->>'verifiedOperationPairCount')::bigint<>1
 OR (j->>'distinctVerifiedMovementCount')::bigint<>2
 OR (j->>'unverifiedTransferMovementCount')::bigint<>0
 OR j->>'pairCoverageComplete' IS DISTINCT FROM 'true'
 OR j->>'accountingCertification' IS DISTINCT FROM 'NOT_CERTIFIED'
 THEN RAISE EXCEPTION 'D27_VALID_PAIR_NOT_VERIFIED %',j;END IF;
 IF has_function_privilege('anon','public.powerhub_financial_company_transfer_pair_provenance(bigint,text)','EXECUTE')
 OR has_function_privilege('authenticated','public.powerhub_financial_company_transfer_pair_provenance(bigint,text)','EXECUTE')
 OR NOT has_function_privilege('service_role','public.powerhub_financial_company_transfer_pair_provenance(bigint,text)','EXECUTE')
 THEN RAISE EXCEPTION 'D27_UNSAFE_EXECUTE';END IF;
 BEGIN
 PERFORM public.powerhub_financial_company_transfer_pair_provenance(903,'2026-10');
 EXCEPTION WHEN SQLSTATE '22023' THEN denied:=true;END;
 IF NOT denied THEN RAISE EXCEPTION 'D27_UNKNOWN_TENANT_ALLOWED';END IF;
END $a$;
SET ROLE service_role;
DO $actor$
DECLARE j jsonb;
BEGIN
 j:=public.powerhub_financial_company_transfer_pair_provenance(901,'2026-10');
 IF (j->>'verifiedOperationPairCount')::bigint<>1 OR j->>'pairCoverageComplete' IS DISTINCT FROM 'true'
 THEN RAISE EXCEPTION 'D27_SERVICE_ROLE_CANNOT_AUDIT';END IF;
END $actor$;
RESET ROLE;

UPDATE public.account_transactions SET amount=7.26 WHERE id=2;
DO $b$
DECLARE j jsonb;
BEGIN
 j:=public.powerhub_financial_company_transfer_pair_provenance(901,'2026-10');
 IF j->>'status' IS DISTINCT FROM 'BLOCKED_TRANSFER_PROVENANCE'
 OR (j->>'invalidOperationPairCount')::bigint<>1
 OR NOT (j->'blockers' @> '["TRANSFER_SIDES_UNBALANCED","OPERATION_TRANSFER_PAIR_INVALID"]'::jsonb)
 THEN RAISE EXCEPTION 'D27_AMOUNT_MISMATCH_NOT_BLOCKED';END IF;
END $b$;
UPDATE public.account_transactions SET amount=7.25 WHERE id=2;
INSERT INTO public.company_account_movement_operations
VALUES(901,'00000000-0000-4000-8000-000000000002',1,12,'transfer',1,2);
DO $c$
DECLARE j jsonb;
BEGIN
 j:=public.powerhub_financial_company_transfer_pair_provenance(901,'2026-10');
 IF j->>'status' IS DISTINCT FROM 'BLOCKED_TRANSFER_PROVENANCE'
 OR NOT (j->'blockers' @> '["TRANSFER_MOVEMENT_REUSED_BY_MULTIPLE_OPERATIONS"]'::jsonb)
 THEN RAISE EXCEPTION 'D27_DUPLICATE_PAIR_NOT_BLOCKED %',j;END IF;
END $c$;
SELECT 'D27_DISPOSABLE_OPERATION_PAIR_PROVENANCE_PASS' AS result;