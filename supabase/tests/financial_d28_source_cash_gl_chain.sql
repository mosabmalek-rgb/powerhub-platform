-- Disposable PostgreSQL D28: exact migration, positive source trails, negative tampering, ACL.
\set ON_ERROR_STOP on
DO $roles$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN;END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN;END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN;END IF;
END $roles$;
CREATE TABLE public.sites(id bigint PRIMARY KEY,tenant_id bigint,status text);
CREATE TABLE public.company_accounts(id bigint PRIMARY KEY,tenant_id bigint,account_type text);
CREATE TABLE public.account_transactions(
 id bigint PRIMARY KEY,tenant_id bigint,site_id bigint,account_id bigint,
 transaction_type text,amount numeric,occurred_at timestamptz,
 related_payment_id bigint,related_expense_id bigint,related_supplier_payment_id bigint,
 related_supplier_return_id bigint,reference_no text);
CREATE TABLE public.payments(id bigint PRIMARY KEY,tenant_id bigint,site_id bigint,amount numeric,status text);
CREATE TABLE public.expenses(id bigint PRIMARY KEY,tenant_id bigint,site_id bigint,amount numeric,company_account_id bigint);
CREATE TABLE public.supplier_payments(id bigint PRIMARY KEY,tenant_id bigint,site_id bigint,
 amount numeric,status text,account_transaction_id bigint,company_account_id bigint);
CREATE TABLE public.supplier_ledger_entries(id bigint PRIMARY KEY,tenant_id bigint,site_id bigint,
 supplier_payment_id bigint,entry_type text,debit_amount numeric,credit_amount numeric);
CREATE TABLE public.financial_gl_entries(id bigint PRIMARY KEY,tenant_id bigint,site_id bigint,
 period text,source_type text,source_id text,source_revision integer,reverses_entry_id bigint);
CREATE TABLE public.financial_gl_lines(id bigint PRIMARY KEY,entry_id bigint,
 tenant_id bigint,site_id bigint,account_code text,side text,amount numeric);
\ir ../migrations/20261115230000_powerhub_financial_d28_cash_source_gl_chain.sql
INSERT INTO public.sites VALUES(1,901,'active'),(2,902,'active');
INSERT INTO public.company_accounts VALUES(5,901,'cash'),(6,901,'palpay'),(7,902,'cash');
INSERT INTO public.payments VALUES(2,901,1,100,'completed'),(3,902,2,44,'completed');
INSERT INTO public.expenses VALUES(1,901,1,85,5);
INSERT INTO public.supplier_payments VALUES(4,901,1,150,'posted',14,5);
INSERT INTO public.supplier_ledger_entries VALUES(18,901,1,4,'payment',150,0);
INSERT INTO public.account_transactions(id,tenant_id,site_id,account_id,transaction_type,amount,occurred_at,
 related_payment_id,related_expense_id,related_supplier_payment_id,reference_no)
 VALUES
 (2,901,1,5,'collection',100,'2026-10-12T12:00:00Z',2,null,null,'DOC-P2'),
 (13,901,1,5,'withdrawal',85,'2026-10-13T12:00:00Z',null,1,null,'DOC-E1'),
 (14,901,1,5,'withdrawal',150,'2026-10-14T12:00:00Z',null,null,4,'DOC-SP4'),
 (15,901,1,5,'deposit',3,'2026-10-15T12:00:00Z',null,null,null,'LEGACY-NO-DOC'),
 (16,901,1,5,'transfer_out',5,'2026-10-16T12:00:00Z',null,null,null,'TRANSFER-UNPROVEN'),
 (17,901,1,6,'transfer_in',5,'2026-10-16T12:00:00Z',null,null,null,'TRANSFER-UNPROVEN');
INSERT INTO public.financial_gl_entries VALUES
 (859,901,1,'2026-10','payment','2',1,null),
 (855,901,1,'2026-10','expense','1',1,null),
 (856,901,1,'2026-10','supplier_ledger','18',1,null);
INSERT INTO public.financial_gl_lines VALUES
 (1,859,901,1,'1010','debit',100),(2,859,901,1,'1200','credit',100),
 (3,855,901,1,'5100','debit',85),(4,855,901,1,'1010','credit',85),
 (5,856,901,1,'2300','debit',150),(6,856,901,1,'1010','credit',150);
GRANT USAGE ON SCHEMA public TO service_role;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO service_role;
DO $positive$
DECLARE j jsonb; denied boolean:=false;
BEGIN
 j:=public.powerhub_financial_cash_source_gl_chain(901,'2026-10');
 IF j->>'status' IS DISTINCT FROM 'BLOCKED_SOURCE_CASH_GL_RECONCILIATION'
 OR (j->>'totalCashMovementCount')::int<>6
 OR (j->>'explicitSourceLinkedMovementCount')::int<>3
 OR (j->>'verifiedSourceCashGlMovementCount')::int<>3
 OR (j->>'unverifiedSourceCashGlMovementCount')::int<>0
 OR (j->>'verifiedPaymentAmount')::numeric<>100
 OR (j->>'verifiedExpenseAmount')::numeric<>85
 OR (j->>'verifiedSupplierPaymentAmount')::numeric<>150
 OR (j->>'internalTransferMovementCount')::int<>2
 OR (j->>'unlinkedNonTransferCashMovementCount')::int<>1
 OR NOT j->'blockers' @> '["UNLINKED_NON_TRANSFER_CASH_MOVEMENTS","TRANSFERS_REQUIRE_SEPARATE_D27_AND_GL_PROOF"]'::jsonb
 OR j->>'accountingCertification' IS DISTINCT FROM 'NOT_CERTIFIED'
 THEN RAISE EXCEPTION 'D28_POSITIVE_SOURCE_CHAIN_FAILED %',j; END IF;
 IF has_function_privilege('anon','public.powerhub_financial_cash_source_gl_chain(bigint,text)','EXECUTE')
 OR has_function_privilege('authenticated','public.powerhub_financial_cash_source_gl_chain(bigint,text)','EXECUTE')
 OR NOT has_function_privilege('service_role','public.powerhub_financial_cash_source_gl_chain(bigint,text)','EXECUTE')
 THEN RAISE EXCEPTION 'D28_ACL_OPEN'; END IF;
 BEGIN
  PERFORM public.powerhub_financial_cash_source_gl_chain(999,'2026-10');
 EXCEPTION WHEN SQLSTATE '22023' THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'D28_UNKNOWN_TENANT_ACCEPTED';END IF;
END $positive$;
SET ROLE service_role;
DO $actor$
DECLARE j jsonb;
BEGIN
 j:=public.powerhub_financial_cash_source_gl_chain(901,'2026-10');
 IF (j->>'verifiedSourceCashGlMovementCount')::int<>3
 THEN RAISE EXCEPTION 'D28_SERVICE_ROLE_RUNTIME_NOT_WORKING';END IF;
END $actor$;
RESET ROLE;
-- Amount drift must invalidate an otherwise sound document.
UPDATE public.account_transactions SET amount=101 WHERE id=2;
DO $negative$
DECLARE j jsonb;
BEGIN
 j:=public.powerhub_financial_cash_source_gl_chain(901,'2026-10');
 IF (j->>'verifiedSourceCashGlMovementCount')::int<>2
 OR (j->>'unverifiedSourceCashGlMovementCount')::int<>1
 OR NOT j->'blockers' @> '["EXPLICIT_CASH_SOURCE_OR_GL_MISMATCH"]'::jsonb
 THEN RAISE EXCEPTION 'D28_AMOUNT_TAMPER_ACCEPTED';END IF;
END $negative$;
UPDATE public.account_transactions SET amount=100 WHERE id=2;
-- Duplicate document references invalidate both movements globally.
INSERT INTO public.account_transactions(id,tenant_id,site_id,account_id,transaction_type,amount,occurred_at,related_payment_id)
 VALUES(22,901,1,5,'collection',100,'2026-10-17T12:00:00Z',2);
DO $negative$
DECLARE j jsonb;
BEGIN
 j:=public.powerhub_financial_cash_source_gl_chain(901,'2026-10');
 IF (j->>'verifiedSourceCashGlMovementCount')::int<>2
 OR (j->>'unverifiedSourceCashGlMovementCount')::int<>2
 THEN RAISE EXCEPTION 'D28_REUSED_DOCUMENT_ACCEPTED';END IF;
END $negative$;
DELETE FROM public.account_transactions WHERE id=22;
-- A missing GL cash leg must not pass on mere source linkage.
DELETE FROM public.financial_gl_lines WHERE id=1;
DO $negative$
DECLARE j jsonb;
BEGIN
 j:=public.powerhub_financial_cash_source_gl_chain(901,'2026-10');
 IF (j->>'verifiedSourceCashGlMovementCount')::int<>2
 OR (j->>'unverifiedSourceCashGlMovementCount')::int<>1
 THEN RAISE EXCEPTION 'D28_MISSING_CASH_GL_LINE_ACCEPTED';END IF;
END $negative$;
INSERT INTO public.financial_gl_lines VALUES(1,859,901,1,'1010','debit',100);
-- An alien source cannot masquerade as a tenant-owned document.
INSERT INTO public.account_transactions(id,tenant_id,site_id,account_id,transaction_type,amount,occurred_at,related_payment_id)
 VALUES(23,901,1,5,'collection',44,'2026-10-18T12:00:00Z',3);
DO $negative$
DECLARE j jsonb;
BEGIN
 j:=public.powerhub_financial_cash_source_gl_chain(901,'2026-10');
 IF (j->>'verifiedSourceCashGlMovementCount')::int<>3
 OR (j->>'unverifiedSourceCashGlMovementCount')::int<>1
 THEN RAISE EXCEPTION 'D28_CROSS_TENANT_SOURCE_ACCEPTED'; END IF;
END $negative$;
SELECT 'D28_DISPOSABLE_SOURCE_DOCUMENT_GL_POSITIVE_NEGATIVE_ACL_PASS' AS result;