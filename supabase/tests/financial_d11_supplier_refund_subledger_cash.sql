-- D11 disposable PostgreSQL 17: install the exact versioned migration after the
-- D10 operational-source fixture. The small fixture tests ACL, function source,
-- isolation and unchanged B5.17 source; full staged source+GL+cash acceptance
-- with real fixture-custody helpers is separately recorded by a rollback transaction.
\set ON_ERROR_STOP on
\ir financial_d10_supplier_return_cash_valuation.sql
ALTER TABLE public.company_accounts ADD COLUMN opening_balance numeric NOT NULL DEFAULT 0;
CREATE TABLE public.financial_gl_staging_technical_exclusions(
 tenant_id bigint,site_id bigint,cohort_key text,row_count bigint,sha256 text);
CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_fast_staging_fixture_proof(bigint,bigint)
 RETURNS jsonb LANGUAGE sql STABLE AS $f$
 SELECT '{"verified":false,"quarantinedCount":0}'::jsonb;
 $f$;
\ir ../migrations/20261115133000_powerhub_financial_d11_supplier_refund_subledger_cash_reconciliation.sql
DO $check$
DECLARE def text; blocked boolean:=false;
BEGIN
 IF has_function_privilege('anon','public.powerhub_financial_gl_subledger_reconciliation(bigint,bigint,text)','EXECUTE')
    OR has_function_privilege('authenticated','public.powerhub_financial_gl_subledger_reconciliation(bigint,bigint,text)','EXECUTE')
    OR NOT has_function_privilege('service_role','public.powerhub_financial_gl_subledger_reconciliation(bigint,bigint,text)','EXECUTE')
 THEN RAISE EXCEPTION 'D11_SUBLEDGER_ACL_REGRESSION'; END IF;
 SELECT pg_get_functiondef('public.powerhub_financial_gl_subledger_reconciliation(bigint,bigint,text)'::regprocedure)
 INTO def;
 IF position('powerhub_financial_gl_fast_staging_fixture_proof' IN def)=0
   OR position('STG-PERF-20261105' IN def)=0
   OR position('v_refund_valid_count' IN def)=0
   OR position('supplier-return-cash-refund-v1' IN def)=0
   OR position('count(*) FROM public.financial_gl_entries g2' IN def)=0
 THEN RAISE EXCEPTION 'D11_B517_SOURCE_OR_REFUND_GUARDS_REGRESSED'; END IF;
 BEGIN
  PERFORM public.powerhub_financial_gl_subledger_reconciliation(902,9101,'2026-10');
 EXCEPTION WHEN SQLSTATE '22023' THEN blocked:=true;END;
 IF NOT blocked THEN RAISE EXCEPTION 'D11_FOREIGN_TENANT_ALLOWED';END IF;
 -- Full aggregation requires the production invoice/stock schema. The thin
 -- D10 disposable setup deliberately cannot certify B5.17 cash reconciliation.
 RAISE NOTICE 'D11_DISPOSABLE_SOURCE_ACL_AND_SCOPE_PASS';
END;$check$;
SELECT 'D11_DISPOSABLE_SOURCE_ACL_AND_SCOPE_PASS' AS acceptance;
