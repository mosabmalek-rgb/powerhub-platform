-- D26 isolated PostgreSQL 17 integration of the EXACT migration.
-- Tests tenant-account openings once, site movement partitioning, transfer
-- imbalance, unlinked sources, unknown types, cross-tenant rejection, ACL.
\set ON_ERROR_STOP on
DO $roles$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN;END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN;END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN;END IF;
END $roles$;
CREATE TABLE public.sites(id bigint PRIMARY KEY,tenant_id bigint NOT NULL,status text NOT NULL);
CREATE TABLE public.company_accounts(id bigint PRIMARY KEY,tenant_id bigint NOT NULL,
 account_type text NOT NULL,opening_balance numeric NOT NULL);
CREATE TABLE public.account_transactions(
 id bigint PRIMARY KEY,tenant_id bigint NOT NULL,site_id bigint,account_id bigint,
 transaction_type text NOT NULL,amount numeric NOT NULL,occurred_at timestamptz NOT NULL,
 related_payment_id bigint,related_supplier_payment_id bigint,related_supplier_return_id bigint,
 related_expense_id bigint,related_account_id bigint
);
CREATE TABLE public.financial_gl_entries(
 id bigint PRIMARY KEY,tenant_id bigint NOT NULL,period text NOT NULL
);
GRANT SELECT ON ALL TABLES IN SCHEMA public TO service_role;
\ir ../migrations/20261115174500_powerhub_financial_d26_tenant_company_accounts_preliminary_reconciliation.sql

INSERT INTO public.sites VALUES(1,901,'active'),(2,901,'active'),(3,902,'active');
INSERT INTO public.company_accounts VALUES
(10,901,'cash',100),(11,901,'wallet',20),(20,902,'cash',900);
INSERT INTO public.financial_gl_entries VALUES(1,901,'2026-10');
INSERT INTO public.account_transactions
(id,tenant_id,site_id,account_id,transaction_type,amount,occurred_at,
 related_payment_id,related_account_id)
VALUES
(1,901,1,10,'collection',50,'2026-10-01T12:00:00Z',1,NULL),
(2,901,2,11,'withdrawal',10,'2026-10-02T12:00:00Z',NULL,NULL),
(3,901,1,10,'transfer_out',5,'2026-10-03T12:00:00Z',NULL,11),
(4,901,2,11,'transfer_in',5,'2026-10-03T12:00:00Z',NULL,10),
(5,902,3,20,'collection',40,'2026-10-01T12:00:00Z',NULL,NULL);

DO $test$
DECLARE v jsonb; denied boolean:=false;
BEGIN
 v:=public.powerhub_financial_company_accounts_tenant_reconciliation(901,'2026-10');
 IF v->>'status' IS DISTINCT FROM 'BLOCKED_OPERATIONAL_RECONCILIATION'
 OR (v->>'openingBalanceCountedOnceUnverified')::numeric<>120
 OR (v->>'operationalAsOfBalanceUnverified')::numeric<>160
 OR (v->>'totalMovementCount')::bigint<>4
 OR (v->>'signedMovementNet')::numeric<>40
 OR (v->>'transferAmountDifference')::numeric<>0
 OR (v->>'transferCountDifference')::bigint<>0
 OR (v->>'unlinkedSourceMovementCount')::bigint<>1
 OR jsonb_array_length(v->'accounts')<>2
 OR jsonb_array_length(v->'sites')<>2
 OR (v->'sites'->0->>'openingBalanceAllocated')::boolean IS DISTINCT FROM false
 OR NOT (v->'blockers' @> '["MOVEMENTS_WITHOUT_SOURCE_LINK"]'::jsonb)
 OR v->>'accountingCertification' IS DISTINCT FROM 'NOT_CERTIFIED'
 OR v->>'canBeCertifiedConsolidation' IS DISTINCT FROM 'false'
 OR v->>'glAndOperationalCashIndependentlyReconciled' IS DISTINCT FROM 'false'
 THEN RAISE EXCEPTION 'D26_ISOLATED_BROKEN_BASIC_ROLL_FORWARD: %',v;END IF;
 -- Clear unrelated withdrawal's missing source: still no document-certified
 -- cash/GL, but the only reported *operational* blockers should disappear.
 UPDATE public.account_transactions SET related_expense_id=55 WHERE id=2;
 v:=public.powerhub_financial_company_accounts_tenant_reconciliation(901,'2026-10');
 IF v->>'status' IS DISTINCT FROM 'PRELIMINARY_OPERATIONAL_RECONCILIATION'
 OR jsonb_array_length(v->'blockers')<>0
 OR v->>'accountingCertification' IS DISTINCT FROM 'NOT_CERTIFIED'
 OR v->>'sourceOpeningEvidenceApproved' IS DISTINCT FROM 'false'
 THEN RAISE EXCEPTION 'D26_ZERO_BLOCKERS_MUST_STILL_NOT_CERTIFY';END IF;
 UPDATE public.account_transactions SET amount=6 WHERE id=4;
 v:=public.powerhub_financial_company_accounts_tenant_reconciliation(901,'2026-10');
 IF v->>'status' IS DISTINCT FROM 'BLOCKED_OPERATIONAL_RECONCILIATION'
 OR (v->>'transferAmountDifference')::numeric<>1
 OR NOT (v->'blockers' @> '["TRANSFER_SIDES_UNBALANCED"]'::jsonb)
 THEN RAISE EXCEPTION 'D26_IMBALANCED_TRANSFER_NOT_BLOCKED';END IF;
 INSERT INTO public.account_transactions(id,tenant_id,site_id,account_id,transaction_type,amount,occurred_at)
 VALUES(6,901,1,10,'unknown',1,'2026-10-03T12:00:00Z');
 v:=public.powerhub_financial_company_accounts_tenant_reconciliation(901,'2026-10');
 IF NOT (v->'blockers' @> '["UNKNOWN_MOVEMENT_TYPE"]'::jsonb)
 THEN RAISE EXCEPTION 'D26_UNKNOWN_TYPE_NOT_BLOCKED';END IF;
 INSERT INTO public.account_transactions(id,tenant_id,site_id,account_id,transaction_type,amount,occurred_at)
 VALUES(7,901,3,20,'deposit',1,'2026-10-03T12:00:00Z');
 v:=public.powerhub_financial_company_accounts_tenant_reconciliation(901,'2026-10');
 IF NOT (v->'blockers' @> '["ACCOUNT_OUT_OF_TENANT_SCOPE","SITE_OUT_OF_TENANT_SCOPE"]'::jsonb)
 THEN RAISE EXCEPTION 'D26_FOREIGN_SCOPE_REFS_NOT_BLOCKED';END IF;
 BEGIN
  PERFORM public.powerhub_financial_company_accounts_tenant_reconciliation(901,'2026-13');
 EXCEPTION WHEN SQLSTATE '22023' THEN denied:=true;END;
 IF NOT denied THEN RAISE EXCEPTION 'D26_INVALID_PERIOD_ACCEPTED';END IF;
 denied:=false;
 BEGIN
  PERFORM public.powerhub_financial_company_accounts_tenant_reconciliation(903,'2026-10');
 EXCEPTION WHEN SQLSTATE '22023' THEN denied:=true;END;
 IF NOT denied THEN RAISE EXCEPTION 'D26_UNKNOWN_TENANT_ACCEPTED';END IF;
 IF has_function_privilege('anon',
 'public.powerhub_financial_company_accounts_tenant_reconciliation(bigint,text)','EXECUTE')
 OR has_function_privilege('authenticated',
 'public.powerhub_financial_company_accounts_tenant_reconciliation(bigint,text)','EXECUTE')
 OR NOT has_function_privilege('service_role',
 'public.powerhub_financial_company_accounts_tenant_reconciliation(bigint,text)','EXECUTE')
 THEN RAISE EXCEPTION 'D26_SERVER_RPC_PERMISSIONS_INVALID';END IF;
END $test$;
-- Verify the actual invoker role can read only its authorised server-side
-- report (not just that the admin execution had permissions).
SET ROLE service_role;
DO $service_actor$
DECLARE v jsonb;
BEGIN
 v:=public.powerhub_financial_company_accounts_tenant_reconciliation(902,'2026-10');
 IF (v->>'tenantId')::bigint<>902 OR (v->>'accountCount')::bigint<>1
 OR (v->>'openingBalanceCountedOnceUnverified')::numeric<>900
 OR (v->>'totalMovementCount')::bigint<>1
 OR (v->>'signedMovementNet')::numeric<>40
 OR v->>'accountingCertification' IS DISTINCT FROM 'NOT_CERTIFIED'
 THEN RAISE EXCEPTION 'D26_SERVICE_ROLE_INVOKER_SCOPE_OR_CALCULATION_FAIL';END IF;
END $service_actor$;
RESET ROLE;
SELECT 'D26_DISPOSABLE_TENANT_ACCOUNT_RECONCILIATION_PASS' AS result;
